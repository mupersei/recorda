// Fragmented MP4 Writer - 조각(fragmented) MP4: 녹화 중 약 2초마다 moof+mdat 조각을 저장 위치에 바로 기록합니다.
//
//   ftyp(iso5) | moov(빈 샘플 표 + mvex[mehd 자리 free, trex×2]) | moof mdat | moof mdat | ...
//
// - 중지 시 쓸 것은 마지막 조각 하나와 길이 패치(mehd, 수십 바이트)뿐이라 녹화 길이와 무관하게 바로 끝납니다.
// - 조각은 완성되는 즉시 write 한 번으로 기록하므로, 브라우저가 비정상 종료돼도 마지막으로 기록된 조각까지는 재생할 수 있습니다
//   (사용자 폴더에서는 Chrome이 쓰기 중인 내용을 <이름>.crswap 스왑 파일에 두므로, 남은 스왑 파일 이름을 .mp4로 바꾸면 재생됨).
// - 조각 활성화: 조각은 moof 자리의 상자 타입을 'free'로 써 두었다가, 조각 전체(moof + mdat) 쓰기가 끝난 뒤 4바이트를 'moof'로 바꿉니다.
//   ffmpeg 계열 파서는 moof의 tfhd~trun 중간에서 잘린 파일을 통째로 열지 못하는데(error reading header), 이렇게 하면 쓰다 만
//   조각은 항상 free 상자(건너뜀)로 남아 그 앞의 조각까지는 정상 재생됩니다. 'moof'로 보이는 조각은 mdat까지 모두 기록된 것입니다.
// - 조각 경계: 키프레임이 오면 그 앞까지를 닫고(조각이 키프레임으로 시작), 키프레임이 드물어도 영상 약 2초마다 닫습니다.
//   시간 기준은 2초 + 10% 여유(2.2초)입니다: 인코더는 60프레임(30fps에서 2초)마다 키프레임을 내는데, 실제 캡처가 30fps보다 조금
//   느리면(예: 29.9fps) 60프레임이 2초를 살짝 넘어 키프레임 한두 프레임 전에 시간 기준으로 잘리고 1~2프레임짜리 조각이 생기기 때문.
//   영상 프레임이 오래 오지 않으면(정적인 화면) 오디오가 4초 쌓일 때 오디오(와 길이가 정해진 영상 샘플)만으로 조각을 닫습니다.
// - 영상 샘플 길이는 다음 샘플 타임스탬프로 정해지므로 가장 최근 샘플 하나는 다음 샘플이 올 때까지 붙잡아 둡니다.
//   마지막 샘플은 직전 간격을 쓰고 오디오가 더 길면 오디오 끝까지 늘립니다 (planMp4와 같은 규칙).
// - 타임스탬프 보정(A/V 정렬 오프셋, 일시정지 구간 제외)은 videoTimestampAdjust(raw, i)로 샘플이 들어올 때 적용합니다
//   (보정에 필요한 값은 그 샘플이 인코더에 들어가기 전에 이미 정해짐 - VideoTrackEncoder 참고). dts 계산은 planMp4와 같습니다.
// - 메모리: 기록한 조각의 샘플 데이터와 목록은 버리고 개수·누적 길이만 남깁니다 (녹화 길이와 무관).
// - 출력 쓰기가 실패하면 onError를 한 번 부르고 이후 샘플은 받지 않습니다 (호출자가 녹화를 멈춤).
import { BoxWriter, box, payload, buildMp4Moov, VIDEO_TIMESCALE, MP3_ENCODER_DELAY_SAMPLES, MEHD_PLACEHOLDER_BYTES } from './mp4-muxer.js';

const DEFAULT_FRAGMENT_US = 2_000_000;
const FRAGMENT_TIME_SLACK = 1.1;          // 시간 기준 조각 닫기 여유 (키프레임 경계가 먼저 오도록)
const AUDIO_ONLY_FLUSH_FACTOR = 2;        // 영상 없이 오디오가 조각 길이의 2배(4초) 쌓이면 조각을 닫음
const UINT32_MAX = 0xFFFFFFFF;
const MOVIE_TIMESCALE = 1000;              // mvhd timescale (mp4-muxer.js와 같음)
// 샘플 플래그 (ISO/IEC 14496-12 8.8.3.1): sync = sample_depends_on 2 / non-sync = depends_on 1 + is_non_sync_sample
const SAMPLE_FLAGS_SYNC = 0x02000000;
const SAMPLE_FLAGS_NON_SYNC = 0x01010000;
const TFHD_FLAGS = 0x020000 | 0x000020;    // default-base-is-moof + default-sample-flags-present
const TRUN_VIDEO_FLAGS = 0x000001 | 0x000100 | 0x000200 | 0x000400; // data-offset + duration + size + flags
const TRUN_AUDIO_FLAGS = 0x000001 | 0x000100 | 0x000200;            // data-offset + duration + size (플래그는 tfhd 기본값)
const TYPE_MOOF = new Uint8Array([0x6D, 0x6F, 0x6F, 0x66]); // 'moof'
const TYPE_FREE = [0x66, 0x72, 0x65, 0x65];                  // 'free'

/** ftyp: major iso5, compat iso5 iso6 isom mp41 (조각 MP4) */
function buildFragmentedFtyp() {
  return box('ftyp', payload((w) => {
    w.ascii('iso5').u32be(0x200).ascii('iso5').ascii('iso6').ascii('isom').ascii('mp41');
  }));
}

/** 박스 트리에서 상자 위치 찾기 (초기화 moov 안의 mvex, 그 안의 mehd 자리) */
function findBoxOffset(bytes, start, end, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = start;
  while (o + 8 <= end) {
    const size = view.getUint32(o);
    const t = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (t === type) return o;
    if (size < 8) break;
    o += size;
  }
  return -1;
}

export class FragmentedMp4Writer {
  /**
   * @param {Object} options
   * @param {Object} options.sink - FileSink (write / writeAt / close / abort)
   * @param {{codec:'mp3', sampleRate:number, channels:number, bitrate?:number}|null} [options.audio] - 컨테이너 오디오 설정 (초기화 세그먼트에 필요)
   * @param {Date} [options.creationTime]
   * @param {number} [options.fragmentDurationUs] - 조각 길이 기준 (기본 2초, 키프레임이 없으면 이 값 + 10%에서 닫음)
   * @param {(raw:number, i:number) => number} [options.videoTimestampAdjust] - 원본 타임스탬프 → 출력 타임스탬프(µs)
   * @param {(error:Error) => void} [options.onError] - 녹화 중 출력 쓰기 실패 알림 (한 번)
   */
  constructor({ sink, audio = null, creationTime = new Date(), fragmentDurationUs = DEFAULT_FRAGMENT_US, videoTimestampAdjust = null, onError = null }) {
    if (!sink || typeof sink.write !== 'function') {
      throw new Error('출력 싱크(sink)가 필요합니다');
    }
    if (audio && audio.codec !== 'mp3') {
      throw new Error(`지원하지 않는 컨테이너 오디오 코덱입니다: ${audio.codec}`);
    }
    this.sink = sink;
    this.audioConfig = audio;
    this.creationTime = creationTime;
    this.fragmentTicks = Math.round(fragmentDurationUs * FRAGMENT_TIME_SLACK * VIDEO_TIMESCALE / 1_000_000);
    this.audioFlushSamples = audio ? Math.round(audio.sampleRate * fragmentDurationUs / 1_000_000) * AUDIO_ONLY_FLUSH_FACTOR : Infinity;
    this.videoTimestampAdjust = videoTimestampAdjust;
    this.onError = onError;
    this.editOffset = MP3_ENCODER_DELAY_SAMPLES;

    this.queue = Promise.resolve();
    this.error = null;
    this.started = false;
    this.closed = false;
    this.finishing = false;
    this.videoConfig = null;
    this.initWritten = false;
    this.position = 0;        // 기록(대기 포함)한 바이트 = 다음 조각의 파일 위치
    this.initOffset = 0;      // 초기화 moov의 파일 위치 (mehd 패치용)
    this.initMoov = null;     // 패치 위치 계산용 (finish까지 보관, 수 KB)

    // 영상: 길이가 정해진(다음 샘플이 온) 샘플은 pendingVideo, 가장 최근 샘플은 held
    this.pendingVideo = [];
    this.held = null;
    this.videoCount = 0;
    this.originUs = 0;
    this.prevDts = 0;
    this.lastDuration = 0;    // 가장 최근에 정해진 샘플 길이 (마지막 샘플 길이로 사용)
    // 오디오
    this.pendingAudio = [];
    this.pendingAudioSamples = 0;
    this.audioCount = 0;
    this.audioTotalSamples = 0;
    this.audioDecodeTime = 0; // 다음 조각 오디오의 tfdt (기록한 프레임 샘플 수 합)
    // 조각
    this.sequence = 0;
    this.fragmentsWritten = 0; // 쓰기 큐에 넣은 조각 수
    this.videoTicksWritten = 0;
  }

  get kind() { return 'fmp4'; }
  get videoSampleCount() { return this.videoCount; }
  get audioFrameCount() { return this.audioCount; }
  get pendingVideoCount() { return this.pendingVideo.length + (this.held ? 1 : 0); }
  get bytesQueued() { return this.position; }

  /** ftyp을 바로 씁니다 (초기화 moov는 영상 설정(avcC)이 정해지면) */
  async start() {
    if (this.started) return;
    this.started = true;
    this.enqueue(buildFragmentedFtyp());
    await this.queue;
    if (this.error) throw this.error;
  }

  /** 영상 설정 (첫 키프레임의 decoderConfig) → 초기화 moov 기록 */
  setVideoConfig({ width, height, avcC }) {
    if (this.videoConfig) return;
    this.videoConfig = { width, height, avcC };
    this.writeInitSegment();
  }

  writeInitSegment() {
    if (this.initWritten || !this.videoConfig || this.error) return;
    const { width, height, avcC } = this.videoConfig;
    const videoTrack = { kind: 'video', trackId: 1, timescale: VIDEO_TIMESCALE, width, height, avcC, duration: 0, editOffset: 0 };
    const a = this.audioConfig;
    const audioTrack = a ? {
      kind: 'audio', trackId: 2, timescale: a.sampleRate, sampleRate: a.sampleRate, channels: a.channels,
      bitrate: a.bitrate || 128000,
      samplesPerFrame: a.sampleRate >= 32000 ? 1152 : 576, // lamejs: MPEG-1(32/44.1/48 kHz) 1152, MPEG-2 576
      duration: 0, editOffset: this.editOffset
    } : null;
    const moov = buildMp4Moov({ isMov: false, creationTime: this.creationTime, videoTrack, audioTrack, fragmented: true });
    this.initMoov = moov;
    this.initOffset = this.position;
    this.initWritten = true;
    this.enqueue(moov);
  }

  /**
   * 영상 샘플 추가 (AVC, 길이 접두 NAL)
   * @param {Uint8Array} bytes - 호출자가 이후 변경하지 않는 버퍼 (조각을 쓸 때 복사)
   * @param {{timestamp:number, keyframe?:boolean}} info - timestamp: 원본(캡처) 타임스탬프 µs
   * @returns {boolean} 받았으면 true (쓰기 실패 후에는 false)
   */
  addVideoSample(bytes, { timestamp, keyframe = false } = {}) {
    if (this.error || this.closed || this.finishing) return false;
    const i = this.videoCount++;
    const out = this.videoTimestampAdjust ? this.videoTimestampAdjust(timestamp, i) : timestamp;
    if (i === 0) this.originUs = out;
    let dts = Math.round((out - this.originUs) * VIDEO_TIMESCALE / 1_000_000);
    if (i > 0 && dts <= this.prevDts) dts = this.prevDts + 1; // 단조 증가 보장 (planMp4와 같음)
    this.prevDts = dts;

    if (this.held) {
      // 직전 샘플의 길이가 이제 정해짐
      const held = this.held;
      held.duration = dts - held.dts;
      this.lastDuration = held.duration;
      this.pendingVideo.push(held);
      this.held = null;
      // 조각 닫기: 새 샘플이 키프레임이면(조각이 키프레임으로 시작하도록) 또는 조각 길이가 2초(+10%)에 이르면.
      // 파일 첫 샘플(dts 0)의 길이에는 A/V 정렬 오프셋(오디오 시작 → 첫 프레임 도착)이 들어 있어 영상 내용이 아니므로
      // 조각 길이는 두 번째 샘플부터 잼 (그대로 재면 첫 조각이 키프레임 #60 직전에 시간 기준으로 잘림)
      const pending = this.pendingVideo;
      const start = pending[0].dts === 0 && pending.length > 1 ? pending[1].dts : pending[0].dts;
      if (keyframe || dts - start >= this.fragmentTicks) this.flushFragment();
    }
    this.held = { data: bytes, dts, keyframe: !!keyframe, duration: 0 };
    return true;
  }

  /**
   * 컨테이너 오디오(MP3) 프레임 추가
   * @param {Uint8Array} bytes
   * @param {{samples:number}} info - 프레임당 PCM 샘플 수
   */
  addAudioFrame(bytes, { samples }) {
    if (this.error || this.closed || this.finishing) return false;
    this.pendingAudio.push({ data: bytes, samples });
    this.pendingAudioSamples += samples;
    this.audioTotalSamples += samples;
    this.audioCount++;
    // 정적인 화면처럼 영상 프레임이 오래 오지 않으면 오디오만으로도 조각을 닫아 메모리와 비정상 종료 시 손실을 제한
    if (this.pendingAudioSamples >= this.audioFlushSamples) this.flushFragment();
    return true;
  }

  /** 길이가 정해진 영상 샘플 + 쌓인 오디오로 조각 하나를 만들어 쓰기 큐에 넣고, 데이터는 버림 */
  flushFragment() {
    if (!this.initWritten) return; // 초기화 세그먼트(avcC) 전에는 쌓아 둠
    const video = this.pendingVideo;
    const audio = this.pendingAudio;
    if (video.length === 0 && audio.length === 0) return;
    this.pendingVideo = [];
    this.pendingAudio = [];
    this.pendingAudioSamples = 0;
    const fragment = this.buildFragment(video, audio);
    this.fragmentsWritten++;
    if (typeof this.sink.writeAt !== 'function') {
      this.enqueue(fragment); // 위치 쓰기를 못 하는 싱크: 활성화 없이 그대로
      return;
    }
    // 쓰다 만 조각이 파일을 망가뜨리지 않도록 'free'로 쓰고, 다 쓴 뒤 'moof'로 활성화
    const position = this.position;
    fragment.set(TYPE_FREE, 4);
    this.enqueue(fragment);
    this.enqueuePatch(position + 4, TYPE_MOOF);
  }

  /**
   * moof(mfhd + traf[tfhd, tfdt v1, trun]) + mdat(영상 샘플들 → 오디오 프레임들)을 버퍼 하나로
   */
  buildFragment(video, audio) {
    const seq = ++this.sequence;
    let videoBytes = 0, audioBytes = 0, audioSamples = 0;
    for (const s of video) videoBytes += s.data.length;
    for (const f of audio) { audioBytes += f.data.length; audioSamples += f.samples; }
    const payloadBytes = videoBytes + audioBytes;
    const mdatHeader = payloadBytes + 8 > UINT32_MAX ? 16 : 8;
    const trafBytes = (n, perSample) => 8 + 20 + 20 + 20 + n * perSample; // traf + tfhd + tfdt(v1) + trun 헤더 + 항목
    const moofBytes = 8 + 16 + (video.length ? trafBytes(video.length, 12) : 0) + (audio.length ? trafBytes(audio.length, 8) : 0);
    const w = new BoxWriter(moofBytes + mdatHeader + payloadBytes);

    w.begin('moof');
    w.beginFull('mfhd', 0, 0).u32be(seq).end();
    if (video.length) {
      w.begin('traf');
      w.beginFull('tfhd', 0, TFHD_FLAGS).u32be(1).u32be(SAMPLE_FLAGS_NON_SYNC).end();
      w.beginFull('tfdt', 1, 0).u64n(video[0].dts).end();
      w.beginFull('trun', 0, TRUN_VIDEO_FLAGS);
      w.u32be(video.length).u32be(moofBytes + mdatHeader); // data_offset: moof 시작 기준 → mdat의 첫 영상 샘플
      for (const s of video) w.u32be(s.duration).u32be(s.data.length).u32be(s.keyframe ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_NON_SYNC);
      w.end();
      w.end();
    }
    if (audio.length) {
      w.begin('traf');
      w.beginFull('tfhd', 0, TFHD_FLAGS).u32be(2).u32be(SAMPLE_FLAGS_SYNC).end();
      w.beginFull('tfdt', 1, 0).u64n(this.audioDecodeTime).end();
      w.beginFull('trun', 0, TRUN_AUDIO_FLAGS);
      w.u32be(audio.length).u32be(moofBytes + mdatHeader + videoBytes);
      for (const f of audio) w.u32be(f.samples).u32be(f.data.length);
      w.end();
      w.end();
    }
    w.end();
    if (w.length !== moofBytes) throw new Error(`moof 크기 계산 오류: ${w.length} / ${moofBytes}`);

    if (mdatHeader === 16) w.u32be(1).ascii('mdat').u64n(16 + payloadBytes);
    else w.u32be(8 + payloadBytes).ascii('mdat');
    for (const s of video) w.bytes_(s.data);
    for (const f of audio) w.bytes_(f.data);

    for (const s of video) this.videoTicksWritten += s.duration;
    this.audioDecodeTime += audioSamples;
    return w.bytes();
  }

  // 쓰기는 순서대로 직렬화. 조각마다 write 한 번 (조각이 완성되는 즉시 디스크로)
  enqueue(bytes) {
    this.position += bytes.length;
    this.queue = this.queue
      .then(() => (this.error ? undefined : this.sink.write(bytes)))
      .catch((error) => this.fail(error));
  }

  // 이미 기록한 위치 덮어쓰기 (조각 활성화). 앞선 쓰기가 끝난 뒤에 실행됨
  enqueuePatch(position, bytes) {
    this.queue = this.queue
      .then(() => (this.error ? undefined : this.sink.writeAt(position, bytes)))
      .catch((error) => this.fail(error));
  }

  fail(error) {
    if (this.error) return;
    this.error = error || new Error('출력 기록 실패');
    console.error('[FragmentedMp4Writer] 출력 기록 실패 - 이후 샘플은 기록하지 않습니다:', this.error);
    if (this.onError && !this.finishing) {
      try { this.onError(this.error); } catch (callbackError) { console.warn('[FragmentedMp4Writer] onError 처리 실패:', callbackError); }
    }
  }

  /**
   * 마무리: 마지막 샘플 길이(직전 간격, 오디오가 더 길면 오디오 끝까지) → 마지막 조각 → 전체 길이(mehd) 패치 → 싱크 닫기
   * @returns {Promise<{blob:Blob, bytes:number, timings:{planMs:number, writeMs:number, closeMs:number}}>}
   */
  async finish() {
    if (this.error) { await this.queue; throw this.error; }
    if (!this.videoConfig || (this.videoCount === 0)) throw new Error('영상 샘플이 없습니다');
    this.finishing = true;
    const now = () => (globalThis.performance ? performance.now() : Date.now());
    const t0 = now();
    if (this.held) {
      const held = this.held;
      let lastDuration = this.videoCount > 1 ? this.lastDuration : Math.round(VIDEO_TIMESCALE / 30);
      if (this.audioTotalSamples > 0 && this.audioConfig) {
        const audioEnd = Math.round((this.audioTotalSamples - this.editOffset) * VIDEO_TIMESCALE / this.audioConfig.sampleRate);
        const videoEnd = held.dts + lastDuration;
        if (audioEnd > videoEnd) lastDuration += audioEnd - videoEnd;
      }
      held.duration = lastDuration;
      this.pendingVideo.push(held);
      this.held = null;
    }
    this.flushFragment();
    const t1 = now();
    await this.queue;
    if (this.error) throw this.error;
    try {
      await this.patchDuration();
    } catch (error) {
      this.fail(error);
      throw error;
    }
    const t2 = now();
    const blob = await this.sink.close();
    this.closed = true;
    console.log('[FragmentedMp4Writer] 완료:', { fragments: this.fragmentsWritten, videoSamples: this.videoCount, audioFrames: this.audioCount, bytes: this.position, durationMs: this.movieDurationMs() });
    return { blob, bytes: this.position, timings: { planMs: Math.round(t1 - t0), writeMs: Math.round(t2 - t1), closeMs: Math.round(now() - t2) } };
  }

  /** 전체 길이 (movie timescale 1000): 가장 긴 트랙 (오디오는 인코더 지연 제외) */
  movieDurationMs() {
    const videoMs = Math.round(this.videoTicksWritten * MOVIE_TIMESCALE / VIDEO_TIMESCALE);
    const audioMs = this.audioConfig && this.audioTotalSamples > 0
      ? Math.round(Math.max(0, this.audioTotalSamples - this.editOffset) * MOVIE_TIMESCALE / this.audioConfig.sampleRate)
      : 0;
    return Math.max(videoMs, audioMs);
  }

  /**
   * 완료된 파일의 전체 길이 기록: mvex 안의 free(mehd 자리)를 mehd(fragment_duration, 조각 포함 전체 길이)로 덮어씁니다.
   * mehd를 읽는 플레이어는 조각을 다 읽지 않아도 길이를 압니다. mvhd 길이는 규격대로 moov 자체의 샘플(없음) 기준 0으로 둡니다.
   * 비정상 종료로 남은 파일은 free 그대로라(길이 정보 없음) 플레이어가 조각을 읽어 계산합니다 (ffmpeg는 열 때 모든 moof를 읽음).
   */
  async patchDuration() {
    if (!this.initMoov || typeof this.sink.writeAt !== 'function') return;
    const moov = this.initMoov;
    const durationMs = this.movieDurationMs();
    const mvex = findBoxOffset(moov, 8, moov.length, 'mvex');
    if (mvex >= 0) {
      const slot = findBoxOffset(moov, mvex + 8, mvex + new DataView(moov.buffer, moov.byteOffset).getUint32(mvex), 'free');
      if (slot >= 0) {
        const w = new BoxWriter(MEHD_PLACEHOLDER_BYTES);
        w.beginFull('mehd', 1, 0).u64n(durationMs).end();
        await this.sink.writeAt(this.initOffset + slot, w.bytes());
      }
    }
    this.initMoov = null;
  }

  /**
   * 기록 취소 (오류·영상 없음)
   * @param {{remove?: boolean}} [options]
   */
  async abort(options) {
    this.closed = true;
    this.pendingVideo = [];
    this.pendingAudio = [];
    this.held = null;
    try { await this.queue; } catch { /* 무시 */ }
    try { if (typeof this.sink.abort === 'function') await this.sink.abort(options); } catch { /* 무시 */ }
  }
}
