// Direct MP4 Writer - 녹화 중 인코딩된 샘플을 최종 MP4/MOV 파일(저장 위치)에 바로 기록하고, 중지 시 moov만 붙입니다.
//
// 이전 방식은 녹화 중 청크를 OPFS 청크 저장소에 쌓았다가 중지 시 최종 파일로 다시 복사했습니다(머싱). 3시간 720p 녹화(3.07 GB)에서
// 중지 후 101초 중 100.9초가 이 복사였습니다. 여기서는 처음부터 최종 파일에 mdat-first 레이아웃으로 씁니다:
//
//   ftyp | mdat(16바이트 헤더: size=1 + 64비트 largesize 자리) | 샘플 데이터(도착 순서) ... | moov
//
// - 샘플은 BatchWriter(8 MB 고정 버퍼)로 묶어 순서대로 싱크에 씁니다. 메모리에는 SampleIndex(영상 23 B / 오디오 14 B, 샘플마다
//   객체 없음)에 파일 안 실제 위치(헤더 길이 + 지금까지 쓴 바이트)·크기·원본 타임스탬프·키프레임만 남깁니다.
// - 중지 시: 버퍼 비우기 → mdat largesize 패치(sink.writeAt) → moov(mp4-muxer.js의 같은 구현: stts/stss/stsz/stco|co64/elst,
//   마지막 샘플 오디오 끝까지 연장) → 싱크 닫기. 쓸 데이터는 moov(수 MB)뿐이라 녹화 길이와 무관하게 짧습니다.
// - 타임스탬프 보정(A/V 정렬 오프셋, 일시정지 구간 제외)은 인덱스에 원본을 두고 중지 시 videoTimestampAdjust(raw, i) 접근자로 적용합니다.
// - 출력 쓰기가 실패하면(권한 회수, 드라이브 분리, 디스크 부족) onError를 한 번 부르고 이후 샘플은 받지 않습니다 (호출자가 녹화를 멈춤).
//   청크 저장소가 없으므로 다른 곳에 다시 만들 수 없습니다.
import { BatchWriter } from './batch-io.js';
import { SampleIndex } from '../storage/sample-index.js';
import { buildFtyp, prepareMp4Tracks, buildMp4Moov } from './mp4-muxer.js';

const MDAT_HEADER_BYTES = 16; // size(4) = 1 + 'mdat'(4) + largesize(8)

/** stco/co64 접근자: 인덱스에 기록된 실제 파일 위치를 그대로 씀 */
function indexChunkOffsets(index) {
  return {
    last: index.length > 0 ? index.offsets[index.length - 1] : 0,
    write(w, needs64) {
      const offsets = index.offsets;
      for (let i = 0; i < index.length; i++) {
        if (needs64) w.u64n(offsets[i]); else w.u32be(offsets[i]);
      }
    }
  };
}

function u64be(value) {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  const hi = Math.floor(value / 0x100000000);
  view.setUint32(0, hi);
  view.setUint32(4, value - hi * 0x100000000);
  return bytes;
}

export class DirectMp4Writer {
  /**
   * @param {Object} options
   * @param {Object} options.sink - FileSink (write / writeAt / close / abort): DirectoryFileSink(사용자 폴더·OPFS) 또는 MemoryFileSink
   * @param {'mp4'|'mov'} [options.container]
   * @param {{codec:'mp3', sampleRate:number, channels:number, bitrate?:number}|null} [options.audio] - 컨테이너 오디오 설정
   * @param {Date} [options.creationTime]
   * @param {number} [options.bufferBytes] - BatchWriter 고정 버퍼 크기 (기본 8 MB)
   * @param {(raw:number, i:number) => number} [options.videoTimestampAdjust] - 원본 타임스탬프 → 출력 타임스탬프(µs). finish에서도 지정 가능
   * @param {(error:Error) => void} [options.onError] - 녹화 중 출력 쓰기 실패 알림 (한 번)
   */
  constructor({ sink, container = 'mp4', audio = null, creationTime = new Date(), bufferBytes, videoTimestampAdjust = null, onError = null }) {
    if (!sink || typeof sink.write !== 'function') {
      throw new Error('출력 싱크(sink)가 필요합니다');
    }
    if (container !== 'mp4' && container !== 'mov') {
      throw new Error(`지원하지 않는 컨테이너입니다: ${container}`);
    }
    this.sink = sink;
    this.container = container;
    this.audioConfig = audio;
    this.creationTime = creationTime;
    this.videoTimestampAdjust = videoTimestampAdjust;
    this.onError = onError;
    this.writer = new BatchWriter(sink, bufferBytes ? { maxBytes: bufferBytes } : undefined);
    this.videoIndex = new SampleIndex({ kind: 'video' });
    this.audioIndex = new SampleIndex({ kind: 'audio' });
    this.ftyp = buildFtyp(container === 'mov');
    this.dataStart = this.ftyp.length + MDAT_HEADER_BYTES; // 첫 샘플의 파일 위치
    this.payloadBytes = 0;   // mdat에 넣기로 한(큐에 넣은) 샘플 바이트 합
    this.queue = Promise.resolve();
    this.error = null;
    this.videoConfig = null;
    this.started = false;
    this.closed = false;
    this.finishing = false;
  }

  get kind() { return 'direct-mp4'; }
  get videoSampleCount() { return this.videoIndex.length; }
  get audioFrameCount() { return this.audioIndex.length; }
  /** 파일에 기록했거나 기록 대기 중인 바이트 (헤더 + 샘플) */
  get bytesQueued() { return this.dataStart + this.payloadBytes; }
  /** 메모리 인덱스 크기 (진단용) */
  get indexBytes() { return this.videoIndex.bytesUsed + this.audioIndex.bytesUsed; }

  /** ftyp + mdat 헤더(largesize 자리)를 바로 씁니다 (출력 파일을 녹화 시작 때 만들어 쓰기 오류를 일찍 알 수 있게) */
  async start() {
    if (this.started) return;
    this.started = true;
    const head = new Uint8Array(this.dataStart);
    head.set(this.ftyp, 0);
    const view = new DataView(head.buffer);
    view.setUint32(this.ftyp.length, 1);                 // size = 1 → 64비트 largesize 사용
    head.set([0x6D, 0x64, 0x61, 0x74], this.ftyp.length + 4); // 'mdat'
    // largesize(8바이트)는 0으로 두고 finish에서 패치
    this.enqueue(head);
    this.queue = this.queue.then(() => (this.error ? undefined : this.writer.flush())).catch((error) => this.fail(error));
    await this.queue;
    if (this.error) throw this.error;
  }

  /** 영상 설정 (VideoTrackEncoder가 첫 키프레임의 decoderConfig를 받았을 때) */
  setVideoConfig({ width, height, avcC }) {
    if (!this.videoConfig) this.videoConfig = { width, height, avcC };
  }

  /**
   * 영상 샘플(AVC, 길이 접두 NAL)을 도착 순서대로 mdat에 추가
   * @param {Uint8Array} bytes - 호출자가 이후 변경하지 않는 버퍼 (BatchWriter가 순서대로 복사)
   * @param {{timestamp:number, keyframe?:boolean, nalCount?:number}} info - timestamp: 원본(캡처) 타임스탬프 µs
   * @returns {boolean} 받았으면 true (쓰기 실패 후에는 false)
   */
  addVideoSample(bytes, { timestamp, keyframe = false, nalCount = 0 } = {}) {
    if (this.error || this.closed || this.finishing) return false;
    const offset = this.dataStart + this.payloadBytes;
    this.videoIndex.push(offset, bytes.length, timestamp, keyframe, nalCount);
    this.payloadBytes += bytes.length;
    this.enqueue(bytes);
    return true;
  }

  /**
   * 컨테이너 오디오(MP3) 프레임 추가
   * @param {Uint8Array} bytes
   * @param {{samples:number}} info - 프레임당 PCM 샘플 수
   */
  addAudioFrame(bytes, { samples }) {
    if (this.error || this.closed || this.finishing) return false;
    const offset = this.dataStart + this.payloadBytes;
    this.audioIndex.pushFrame(offset, bytes.length, samples);
    this.payloadBytes += bytes.length;
    this.enqueue(bytes);
    return true;
  }

  // 쓰기는 도착 순서대로 직렬화 (BatchWriter.add는 버퍼가 찼을 때만 싱크 쓰기를 기다림)
  enqueue(bytes) {
    this.queue = this.queue
      .then(() => (this.error ? undefined : this.writer.add(bytes)))
      .catch((error) => this.fail(error));
  }

  fail(error) {
    if (this.error) return;
    this.error = error || new Error('출력 기록 실패');
    console.error('[DirectMp4Writer] 출력 기록 실패 - 이후 샘플은 기록하지 않습니다:', this.error);
    if (this.onError && !this.finishing) {
      try { this.onError(this.error); } catch (callbackError) { console.warn('[DirectMp4Writer] onError 처리 실패:', callbackError); }
    }
  }

  /**
   * 마무리: 버퍼 비우기 → mdat largesize 패치 → moov 쓰기 → 싱크 닫기
   * @param {{video?:{width:number,height:number,avcC:Uint8Array}, audio?:Object|null, videoTimestampAdjust?:Function}} [options]
   * @returns {Promise<{blob:Blob, bytes:number, timings:{planMs:number, writeMs:number, closeMs:number}}>}
   */
  async finish({ video = this.videoConfig, audio = this.audioConfig, videoTimestampAdjust = this.videoTimestampAdjust } = {}) {
    this.finishing = true;
    await this.queue;
    if (this.error) throw this.error;
    if (!video || !video.avcC) throw new Error('영상 설정(avcC)이 없습니다');
    const now = () => (globalThis.performance ? performance.now() : Date.now());
    const t0 = now();

    // moov: 인덱스(원본 타임스탬프 + 실제 위치)에서 planMp4와 같은 구현으로 작성
    const index = this.videoIndex;
    const timestampAt = typeof videoTimestampAdjust === 'function' ? (i) => videoTimestampAdjust(index.timestamps[i], i) : undefined;
    const { isMov, videoTrack, audioTrack } = prepareMp4Tracks({
      container: this.container,
      video: { width: video.width, height: video.height, avcC: video.avcC, index, timestampAt },
      audio: audio && this.audioIndex.length > 0 ? { ...audio, index: this.audioIndex } : null
    });
    videoTrack.chunkOffsets = indexChunkOffsets(this.videoIndex);
    if (audioTrack) audioTrack.chunkOffsets = indexChunkOffsets(this.audioIndex);
    const moov = buildMp4Moov({ isMov, creationTime: this.creationTime, videoTrack, audioTrack });
    const t1 = now();

    try {
      await this.writer.flush();
      await this.sink.writeAt(this.ftyp.length + 8, u64be(MDAT_HEADER_BYTES + this.payloadBytes));
      await this.writer.add(moov);
      await this.writer.flush();
    } catch (error) {
      this.fail(error);
      throw error;
    }
    const t2 = now();
    const blob = await this.sink.close();
    this.closed = true;
    const bytes = this.dataStart + this.payloadBytes + moov.length;
    console.log('[DirectMp4Writer] 완료:', { container: this.container, videoSamples: index.length, audioFrames: this.audioIndex.length, bytes, moovBytes: moov.length, indexMB: +(this.indexBytes / 1048576).toFixed(1) });
    return { blob, bytes, timings: { planMs: Math.round(t1 - t0), writeMs: Math.round(t2 - t1), closeMs: Math.round(now() - t2) } };
  }

  /**
   * 기록 취소 (오류·영상 없음): 이후 샘플은 받지 않고 싱크를 버립니다.
   * @param {{remove?: boolean}} [options] - remove: 사용자 폴더에 만들어진 빈 대상 파일도 지움
   */
  async abort(options) {
    this.closed = true;
    try { await this.queue; } catch { /* 무시 */ }
    try { if (typeof this.sink.abort === 'function') await this.sink.abort(options); } catch { /* 무시 */ }
  }
}
