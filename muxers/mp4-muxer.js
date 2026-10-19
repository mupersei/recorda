// MP4 / MOV 머서 - H.264(avc1) 영상 + MP3 오디오를 ISO BMFF / QuickTime 컨테이너로 작성
// 입력은 샘플 배열(메모리 데이터 또는 저장소 참조) 또는 SampleIndex(저장소 참조, 샘플당 객체 없음)입니다 (muxers/sample-access.js).
//
// 장시간 녹화(3시간 ≈ 영상 32만 + 오디오 41만 샘플)에서도 중지 시 메모리가 늘지 않도록:
// - 샘플 테이블은 typed array와 접근자로만 계산합니다 (샘플마다 객체를 만들거나 정렬하지 않음).
// - mdat 배치 순서는 시간순으로 이미 정렬된 두 트랙의 2-포인터 병합으로 만들고 Uint8Array(0 = 영상, 1 = 오디오)로 보관합니다.
// - moov는 하나의 버퍼에 상자를 바로 써 내려갑니다 (stbl → minf → mdia → trak → moov 단계마다 다시 복사하지 않음).
//
// moov 작성(트랙 준비 prepareMp4Tracks + 상자 작성 buildMp4Moov)은 세 경로가 같은 구현을 씁니다:
// - planMp4 / buildMp4 / writeMp4: 중지 시 레이아웃을 계산해 파일 전체를 작성 (AVI와 같은 청크 저장소 경로, 메모리 경로)
// - DirectMp4Writer (direct-mp4-writer.js): 녹화 중 샘플을 도착 순서대로 mdat에 바로 쓰고 중지 시 moov만 작성
// - FragmentedMp4Writer (fmp4-writer.js): 빈 샘플 표 + mvex의 초기화 moov (fragmented: true)
// 트랙마다 chunkOffsets 접근자({ last, write(w, needs64) })가 stco/co64 값을 공급하므로 오프셋을 계산하는 방식(배치 순서
// 재계산 / 인덱스에 기록된 실제 위치)과 상관없이 stts/stss/stsz/elst와 마지막 샘플 연장 규칙이 같습니다.
import { ByteWriter } from './byte-writer.js';
import { BatchWriter, SequentialReader } from './batch-io.js';
import { videoSource, audioSource, readSampleData } from './sample-access.js';

export const VIDEO_TIMESCALE = 90000;
const MOVIE_TIMESCALE = 1000;
const MAC_EPOCH_OFFSET = 2082844800; // 1904-01-01 → 1970-01-01 (초)
export const MP3_ENCODER_DELAY_SAMPLES = 1105; // LAME: 인코더 576 + 디코더 529
const UINT32_MAX = 0xFFFFFFFF;
const ORDER_VIDEO = 0;
const ORDER_AUDIO = 1;

/**
 * 파일 레이아웃 계산 (공통). 샘플 데이터는 읽지 않고 크기만 사용하므로 디스크 저장소 참조만으로도 계산할 수 있습니다.
 * @returns {{head:Uint8Array, order:Uint8Array, video:Object, audio:Object|null, moov:Uint8Array, totalBytes:number}}
 *   order[k]: mdat의 k번째 샘플이 영상(0)인지 오디오(1)인지. 각 트랙 안에서는 샘플 순서 그대로입니다.
 */
export function planMp4({ container = 'mp4', video, audio = null, creationTime = new Date() }) {
  // ---- 트랙 샘플 테이블 준비 ----
  const { isMov, videoTrack, audioTrack } = prepareMp4Tracks({ container, video, audio });
  const vsrc = videoTrack.src;
  const asrc = audioTrack ? audioTrack.src : null;

  // ---- mdat 배치: 시간순 인터리빙 (각 샘플 = 1 청크) ----
  let mdatPayloadSize = 0;
  for (let i = 0; i < vsrc.count; i++) mdatPayloadSize += vsrc.sizeAt(i);
  if (asrc) for (let i = 0; i < asrc.count; i++) mdatPayloadSize += asrc.sizeAt(i);
  const ftyp = buildFtyp(isMov);
  const mdatHeader = buildMdatHeader(mdatPayloadSize);
  const dataStart = ftyp.length + mdatHeader.length;

  const order = interleave(videoTrack, audioTrack, dataStart);
  // stco/co64: 배치 순서(order)를 다시 따라가며 계산 (트랙별 오프셋 배열을 따로 두지 않음)
  videoTrack.chunkOffsets = interleavedChunkOffsets(order, ORDER_VIDEO, vsrc, asrc, dataStart, videoTrack.lastOffset);
  if (audioTrack) audioTrack.chunkOffsets = interleavedChunkOffsets(order, ORDER_AUDIO, asrc, vsrc, dataStart, audioTrack.lastOffset);

  const moov = buildMp4Moov({ isMov, creationTime, videoTrack, audioTrack });
  const head = new Uint8Array(ftyp.length + mdatHeader.length);
  head.set(ftyp, 0);
  head.set(mdatHeader, ftyp.length);

  return { head, order, video: vsrc, audio: asrc, moov, totalBytes: head.length + mdatPayloadSize + moov.length };
}

/**
 * 입력 검증 + 트랙 샘플 테이블 준비 (planMp4 / DirectMp4Writer 공통).
 * 영상 dts(90 kHz, 단조 증가), 마지막 샘플을 오디오 끝까지 늘리는 규칙, MP3 인코더 지연(elst) 보정을 여기서 정합니다.
 * @returns {{isMov:boolean, videoTrack:Object, audioTrack:Object|null}} 오디오 프레임이 없으면 audioTrack = null (영상만 기록)
 */
export function prepareMp4Tracks({ container = 'mp4', video, audio = null }) {
  if (container !== 'mp4' && container !== 'mov') {
    throw new Error(`지원하지 않는 컨테이너입니다: ${container}`);
  }
  const vsrc = videoSource(video);
  if (!vsrc || vsrc.count === 0) {
    throw new Error('영상 샘플이 없습니다');
  }
  if (audio && audio.codec !== 'mp3') {
    throw new Error(`지원하지 않는 컨테이너 오디오 코덱입니다: ${audio.codec}`);
  }
  let asrc = audioSource(audio);
  if (!asrc || asrc.count === 0) {
    audio = null; // 오디오 프레임이 없으면 영상만 기록
    asrc = null;
  }
  const audioTrack = asrc ? prepareAudioTrack(audio, asrc) : null;
  const videoTrack = prepareVideoTrack(video, vsrc, audioTrack);
  return { isMov: container === 'mov', videoTrack, audioTrack };
}

/** 배치 순서(order)를 따라가며 다른 트랙 샘플 크기를 더해 이 트랙 샘플의 절대 파일 오프셋을 계산하는 stco/co64 접근자 */
function interleavedChunkOffsets(order, mine, src, other, dataStart, last) {
  return {
    last,
    write(w, needs64) {
      let offset = dataStart, mi = 0, oi = 0;
      for (let k = 0; k < order.length; k++) {
        if (order[k] === mine) {
          if (needs64) w.u64n(offset); else w.u32be(offset);
          offset += src.sizeAt(mi++);
        } else {
          offset += other.sizeAt(oi++);
        }
      }
    }
  };
}

/**
 * 두 트랙(각각 시간순)을 2-포인터로 병합. 같은 시각이면 영상 먼저 (이전 구현의 안정 정렬과 같은 순서).
 * 트랙별 마지막 샘플 오프셋을 기록해 stco/co64 선택에 씁니다 (오프셋은 트랙 안에서 단조 증가).
 */
function interleave(videoTrack, audioTrack, dataStart) {
  const vsrc = videoTrack.src;
  const asrc = audioTrack ? audioTrack.src : null;
  const nV = vsrc.count;
  const nA = asrc ? asrc.count : 0;
  const dts = videoTrack.dts;
  const aScale = audioTrack ? audioTrack.timescale : 1;
  const order = new Uint8Array(nV + nA);
  let i = 0, j = 0, k = 0, aDts = 0, offset = dataStart;
  while (i < nV || j < nA) {
    if (j >= nA || (i < nV && dts[i] / VIDEO_TIMESCALE <= aDts / aScale)) {
      order[k++] = ORDER_VIDEO;
      videoTrack.lastOffset = offset;
      offset += vsrc.sizeAt(i);
      i++;
    } else {
      order[k++] = ORDER_AUDIO;
      audioTrack.lastOffset = offset;
      offset += asrc.sizeAt(j);
      aDts += asrc.samplesAt(j);
      j++;
    }
  }
  return order;
}

/**
 * MP4 또는 MOV 파일을 메모리에서 생성합니다 (샘플 데이터가 메모리에 있을 때).
 * @param {Object} options
 * @param {'mp4'|'mov'} options.container
 * @param {{width:number, height:number, avcC:Uint8Array, samples:Array<{data:Uint8Array, timestamp:number, keyframe:boolean}>}} options.video
 *        - timestamp는 마이크로초. 첫 샘플이 원점이 됩니다.
 * @param {{codec:'mp3', sampleRate:number, channels:number, bitrate?:number, frames:Array<{data:Uint8Array, samples:number}>, encoderDelaySamples?:number}|null} [options.audio]
 * @param {Date} [options.creationTime]
 * @returns {Uint8Array[]} 파일 파트 목록 (순서대로 이어 붙이면 완성 파일)
 */
export function buildMp4(options) {
  const plan = planMp4(options);
  const parts = [plan.head];
  const { order, video, audio } = plan;
  let vi = 0, ai = 0;
  for (let k = 0; k < order.length; k++) {
    const data = order[k] === ORDER_VIDEO ? video.dataAt(vi++) : audio.dataAt(ai++);
    if (!data) throw new Error('buildMp4는 메모리 샘플(data)만 지원합니다. 저장소 참조는 writeMp4를 사용하세요.');
    parts.push(data);
  }
  parts.push(plan.moov);
  return parts;
}

/**
 * MP4 또는 MOV 파일을 출력 싱크에 스트리밍으로 씁니다. 샘플 데이터가 디스크 저장소(ChunkStore)에 있어도
 * 저장소별 8 MB 창 하나로 순차 읽기 → 8 MB 고정 버퍼에 모아 쓰기만 하므로 메모리 사용량이 파일 크기와 무관합니다.
 * 샘플은 { data } / { ref:{offset,size} } 배열 또는 SampleIndex(저장소 참조)이며, 참조는 video.store / audio.store
 * (finalize된 ChunkStore)에서 읽습니다.
 * @returns {Promise<{blob:Blob, bytes:number, timings:{planMs:number, writeMs:number, closeMs:number}}>}
 */
export async function writeMp4({ output, ...options }) {
  if (!output || typeof output.write !== 'function') {
    throw new Error('출력 싱크(output)가 필요합니다');
  }
  const now = () => (globalThis.performance ? performance.now() : Date.now());
  const t0 = now();
  const plan = planMp4(options);
  const t1 = now();
  const writer = new BatchWriter(output);
  // 저장소별 순차 리더 (샘플은 저장소에 기록된 순서대로 소비되므로 8 MB 창 단위 읽기로 충분)
  const readers = new Map();
  const makeReader = (store) => new SequentialReader(store);
  const { order, video, audio } = plan;
  await writer.add(plan.head);
  let vi = 0, ai = 0;
  for (let k = 0; k < order.length; k++) {
    const bytes = order[k] === ORDER_VIDEO
      ? await readSampleData(video, vi++, readers, makeReader)
      : await readSampleData(audio, ai++, readers, makeReader);
    await writer.add(bytes);
  }
  await writer.add(plan.moov);
  await writer.flush();
  const t2 = now();
  const blob = await output.close();
  return { blob, bytes: plan.totalBytes, timings: { planMs: Math.round(t1 - t0), writeMs: Math.round(t2 - t1), closeMs: Math.round(now() - t2) } };
}

// ---- 트랙 준비 ----

function prepareVideoTrack(video, vsrc, audioTrack) {
  const n = vsrc.count;
  const origin = vsrc.timestampAt(0);
  const dts = new Float64Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let d = Math.round((vsrc.timestampAt(i) - origin) * VIDEO_TIMESCALE / 1_000_000);
    if (i > 0 && d <= prev) d = prev + 1; // 단조 증가 보장
    dts[i] = d;
    prev = d;
  }
  // 샘플 i의 길이 = dts[i+1] - dts[i]. 마지막 샘플은 직전 간격을 반복
  let lastDuration = n > 1 ? dts[n - 1] - dts[n - 2] : Math.round(VIDEO_TIMESCALE / 30);
  // 오디오가 더 길면 마지막 프레임을 늘려 영상 트랙이 오디오 끝까지 이어지게 함 (정적 화면은 프레임이 드묾)
  if (audioTrack) {
    const audioEnd = Math.round((audioTrack.duration - audioTrack.editOffset) * VIDEO_TIMESCALE / audioTrack.timescale);
    const videoEnd = dts[n - 1] + lastDuration;
    if (audioEnd > videoEnd) lastDuration += audioEnd - videoEnd;
  }
  return {
    kind: 'video',
    trackId: 1,
    timescale: VIDEO_TIMESCALE,
    width: video.width,
    height: video.height,
    avcC: video.avcC,
    src: vsrc,
    dts,
    lastDuration,
    duration: dts[n - 1] + lastDuration, // = 샘플 길이 합 (dts[0] = 0)
    editOffset: 0,
    lastOffset: 0
  };
}

function prepareAudioTrack(audio, asrc) {
  let total = 0;
  for (let i = 0; i < asrc.count; i++) total += asrc.samplesAt(i);
  const delay = audio.encoderDelaySamples ?? MP3_ENCODER_DELAY_SAMPLES;
  return {
    kind: 'audio',
    trackId: 2,
    timescale: audio.sampleRate,
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    bitrate: audio.bitrate || estimateBitrate(asrc, audio.sampleRate),
    samplesPerFrame: asrc.samplesAt(0) || 1152, // MPEG-1: 1152, MPEG-2/2.5: 576
    src: asrc,
    duration: total,
    editOffset: Math.min(delay, Math.max(0, total - 1)),
    lastOffset: 0
  };
}

function estimateBitrate(asrc, sampleRate) {
  let bytes = 0, samples = 0;
  for (let i = 0; i < asrc.count; i++) { bytes += asrc.sizeAt(i); samples += asrc.samplesAt(i); }
  return samples > 0 ? Math.round(bytes * 8 * sampleRate / samples) : 128000;
}

/** 샘플 i의 길이(트랙 timescale) - 영상은 dts 차이, 오디오는 프레임 샘플 수 */
function sampleDuration(track, i) {
  if (track.kind === 'audio') return track.src.samplesAt(i);
  const n = track.src.count;
  return i < n - 1 ? track.dts[i + 1] - track.dts[i] : track.lastDuration;
}

// ---- 박스 작성 유틸 ----

/** 상자를 한 버퍼에 바로 써 내려가는 작성기: begin(type) … end()가 크기 필드를 채웁니다 (중첩 상자 복사 없음) */
export class BoxWriter extends ByteWriter {
  constructor(capacity) {
    super(capacity);
    this.starts = [];
  }

  begin(type) {
    this.starts.push(this.length);
    this.u32be(0).ascii(type);
    return this;
  }

  beginFull(type, version, flags) {
    this.begin(type);
    this.u8(version).u8((flags >> 16) & 0xFF).u8((flags >> 8) & 0xFF).u8(flags & 0xFF);
    return this;
  }

  end() {
    const start = this.starts.pop();
    this.patchU32be(start, this.length - start);
    return this;
  }

  /** 2^53 미만 정수를 64비트 빅엔디언으로 (co64 항목마다 BigInt를 만들지 않음) */
  u64n(value) {
    const hi = Math.floor(value / 0x100000000);
    return this.u32be(hi).u32be(value - hi * 0x100000000);
  }
}

export function box(type, ...payloads) {
  const size = 8 + payloads.reduce((s, p) => s + p.length, 0);
  const w = new ByteWriter(size);
  w.u32be(size);
  w.ascii(type);
  for (const p of payloads) w.bytes_(p);
  return w.bytes();
}

function fullBox(type, version, flags, ...payloads) {
  const header = new Uint8Array([version, (flags >> 16) & 0xFF, (flags >> 8) & 0xFF, flags & 0xFF]);
  return box(type, header, ...payloads);
}

export function payload(fn, capacity = 128) {
  const w = new ByteWriter(capacity);
  fn(w);
  return w.bytes();
}

export function buildFtyp(isMov) {
  return box('ftyp', payload((w) => {
    if (isMov) {
      w.ascii('qt  ').u32be(0x200).ascii('qt  ');
    } else {
      w.ascii('isom').u32be(0x200).ascii('isom').ascii('iso2').ascii('avc1').ascii('mp41');
    }
  }));
}

function buildMdatHeader(payloadSize) {
  const w = new ByteWriter(16);
  if (payloadSize + 8 > UINT32_MAX) {
    w.u32be(1).ascii('mdat').u64be(BigInt(payloadSize) + 16n);
  } else {
    w.u32be(payloadSize + 8).ascii('mdat');
  }
  return w.bytes().slice();
}

function toMovieTime(duration, timescale) {
  return Math.round(duration * MOVIE_TIMESCALE / timescale);
}

/**
 * 표(stts/stss/stsz/stco)의 크기를 먼저 세어 moov 버퍼를 한 번에 잡습니다 (작성 중 재할당·복사 없음).
 */
function tableStats(track, fragmented) {
  if (fragmented) return { runs: 0, keys: 0, writeStss: false, allSame: false, needs64: false, bytes: 64 }; // 빈 표 4개
  const src = track.src;
  const n = src.count;
  let runs = 0, prevDelta = -1, keys = 0, allSame = true;
  const size0 = src.sizeAt(0);
  for (let i = 0; i < n; i++) {
    const delta = sampleDuration(track, i);
    if (delta !== prevDelta) { runs++; prevDelta = delta; }
    if (track.kind === 'video' && src.keyframeAt(i)) keys++;
    if (allSame && src.sizeAt(i) !== size0) allSame = false;
  }
  const writeStss = track.kind === 'video' && keys !== n; // 모두 키프레임이면 생략
  const needs64 = track.chunkOffsets.last > UINT32_MAX;
  const bytes = 16 + runs * 8 + (writeStss ? 16 + keys * 4 : 0) + 20 + (allSame ? 0 : n * 4) + 16 + n * (needs64 ? 8 : 4);
  return { runs, keys, writeStss, allSame, needs64, bytes };
}

/**
 * moov 상자 작성 (planMp4 / DirectMp4Writer / FragmentedMp4Writer 공통).
 * @param {{isMov?:boolean, creationTime?:Date, videoTrack:Object, audioTrack?:Object|null, fragmented?:boolean}} options
 *   - 일반: 트랙은 prepareMp4Tracks 결과 + chunkOffsets 접근자 { last: 마지막 샘플 오프셋, write(w, needs64) }
 *   - fragmented: 조각 MP4 초기화 세그먼트. 샘플 표는 비우고(항목 0개) 길이는 0, elst는 segment_duration 0(뒤따르는 모든 조각에 적용,
 *     ffmpeg 조각 출력과 같은 방식), mvex(mehd 자리 free + 트랙별 trex)를 붙입니다. 트랙은 { kind, trackId, timescale, ... } 설명만 필요.
 * @returns {Uint8Array}
 */
export function buildMp4Moov({ isMov = false, creationTime = new Date(), videoTrack, audioTrack = null, fragmented = false }) {
  const time = Math.floor(creationTime.getTime() / 1000) + MAC_EPOCH_OFFSET;
  const tracks = [videoTrack, audioTrack].filter(Boolean);
  const stats = tracks.map((t) => tableStats(t, fragmented));
  const capacity = 4096 + videoTrack.avcC.length + stats.reduce((s, x) => s + x.bytes, 0);
  const w = new BoxWriter(capacity);
  const movieDuration = fragmented ? 0 : Math.max(...tracks.map(t => toMovieTime(t.duration - t.editOffset, t.timescale)));
  w.begin('moov');
  w.bytes_(buildMvhd(time, movieDuration, tracks.length + 1));
  tracks.forEach((track, t) => writeTrak(w, { isMov, time, track, stats: stats[t], fragmented }));
  if (fragmented) writeMvex(w, tracks);
  w.end();
  return w.bytes();
}

/**
 * 조각 MP4의 mvex: mehd 자리(같은 크기의 free 상자, 완료 시 FragmentedMp4Writer가 전체 길이의 mehd로 덮어씀) + 트랙별 trex.
 * 비정상 종료로 남은 파일은 free 그대로라 길이 정보 없이(플레이어가 조각을 읽어 계산) 재생됩니다.
 */
export const MEHD_PLACEHOLDER_BYTES = 20; // mehd v1: 8(헤더) + 4(버전/플래그) + 8(fragment_duration)
function writeMvex(w, tracks) {
  w.begin('mvex');
  w.begin('free');
  w.zeros(MEHD_PLACEHOLDER_BYTES - 8);
  w.end();
  for (const track of tracks) {
    w.beginFull('trex', 0, 0);
    w.u32be(track.trackId);
    w.u32be(1); // default_sample_description_index
    w.u32be(0); // default_sample_duration (trun에 기록)
    w.u32be(0); // default_sample_size (trun에 기록)
    w.u32be(0); // default_sample_flags (tfhd/trun에 기록)
    w.end();
  }
  w.end();
}

function writeMatrix(w) {
  w.u32be(0x00010000).u32be(0).u32be(0);
  w.u32be(0).u32be(0x00010000).u32be(0);
  w.u32be(0).u32be(0).u32be(0x40000000);
}

function buildMvhd(time, duration, nextTrackId) {
  return fullBox('mvhd', 0, 0, payload((w) => {
    w.u32be(time).u32be(time).u32be(MOVIE_TIMESCALE).u32be(duration);
    w.u32be(0x00010000); // rate 1.0
    w.u16be(0x0100);     // volume 1.0
    w.zeros(10);
    writeMatrix(w);
    w.zeros(24);         // pre_defined
    w.u32be(nextTrackId);
  }));
}

function writeTrak(w, { isMov, time, track, stats, fragmented }) {
  const trackMovieDuration = fragmented ? 0 : toMovieTime(track.duration - track.editOffset, track.timescale);
  w.begin('trak');
  w.bytes_(buildTkhd(time, track, trackMovieDuration));
  if (track.editOffset > 0) {
    w.bytes_(box('edts', buildElst(track, trackMovieDuration)));
  }
  writeMdia(w, { isMov, time, track, stats, fragmented });
  w.end();
}

function buildTkhd(time, track, duration) {
  const isVideo = track.kind === 'video';
  return fullBox('tkhd', 0, 0x000003, payload((w) => {
    w.u32be(time).u32be(time).u32be(track.trackId).u32be(0).u32be(duration);
    w.zeros(8);
    w.u16be(0);                           // layer
    w.u16be(isVideo ? 0 : 1);             // alternate_group
    w.u16be(isVideo ? 0 : 0x0100);        // volume
    w.u16be(0);
    writeMatrix(w);
    w.fixed16_16(isVideo ? track.width : 0);
    w.fixed16_16(isVideo ? track.height : 0);
  }));
}

function buildElst(track, segmentDuration) {
  return fullBox('elst', 0, 0, payload((w) => {
    w.u32be(1);                   // entry_count
    w.u32be(segmentDuration);     // segment_duration (movie timescale)
    w.u32be(track.editOffset);    // media_time (media timescale)
    w.u16be(1).u16be(0);          // media_rate 1.0
  }));
}

function writeMdia(w, { isMov, time, track, stats, fragmented }) {
  const isVideo = track.kind === 'video';
  w.begin('mdia');
  w.bytes_(fullBox('mdhd', 0, 0, payload((p) => {
    p.u32be(time).u32be(time).u32be(track.timescale).u32be(fragmented ? 0 : track.duration);
    p.u16be(0x55C4); // language 'und'
    p.u16be(0);
  })));
  w.bytes_(buildHdlr(isMov, isMov ? 'mhlr' : null, isVideo ? 'vide' : 'soun', isVideo ? 'VideoHandler' : 'SoundHandler'));
  writeMinf(w, { isMov, track, stats, fragmented });
  w.end();
}

function buildHdlr(isMov, componentType, handlerType, name) {
  return fullBox('hdlr', 0, 0, payload((w) => {
    if (componentType) w.ascii(componentType); else w.u32be(0);
    w.ascii(handlerType);
    w.zeros(12);
    if (isMov) {
      w.u8(name.length).ascii(name); // Pascal 문자열
    } else {
      w.ascii(name).u8(0);           // C 문자열
    }
  }));
}

function writeMinf(w, { isMov, track, stats, fragmented }) {
  const isVideo = track.kind === 'video';
  w.begin('minf');
  if (isVideo) {
    w.bytes_(fullBox('vmhd', 0, 1, payload((p) => { p.u16be(0).u16be(0).u16be(0).u16be(0); })));
  } else {
    w.bytes_(fullBox('smhd', 0, 0, payload((p) => { p.u16be(0).u16be(0); })));
  }
  if (isMov) {
    w.bytes_(buildHdlr(true, 'dhlr', 'url ', 'DataHandler'));
  }
  const dref = fullBox('dref', 0, 0, payload((p) => { p.u32be(1); }), fullBox('url ', 0, 1));
  w.bytes_(box('dinf', dref));
  writeStbl(w, { isMov, track, stats, fragmented });
  w.end();
}

function writeStbl(w, { isMov, track, stats, fragmented }) {
  const isVideo = track.kind === 'video';

  w.begin('stbl');
  w.bytes_(fullBox('stsd', 0, 0, payload((p) => { p.u32be(1); }),
    isVideo ? buildAvc1(track) : buildAudioSampleEntry(isMov, track)));

  if (fragmented) {
    // 조각 MP4: 샘플은 모두 moof/trun에 있으므로 표는 항목 0개 (stss 없음)
    w.beginFull('stts', 0, 0).u32be(0).end();
    w.beginFull('stsc', 0, 0).u32be(0).end();
    w.beginFull('stsz', 0, 0).u32be(0).u32be(0).end();
    w.beginFull('stco', 0, 0).u32be(0).end();
    w.end();
    return;
  }

  const src = track.src;
  const n = src.count;

  // stts: 런렝스
  w.beginFull('stts', 0, 0);
  w.u32be(stats.runs);
  let count = 0, delta = -1;
  for (let i = 0; i < n; i++) {
    const d = sampleDuration(track, i);
    if (d === delta) { count++; continue; }
    if (count > 0) w.u32be(count).u32be(delta);
    count = 1;
    delta = d;
  }
  if (count > 0) w.u32be(count).u32be(delta);
  w.end();

  // stss: 키프레임 (모두 키프레임이면 생략)
  if (stats.writeStss) {
    w.beginFull('stss', 0, 0);
    w.u32be(stats.keys);
    for (let i = 0; i < n; i++) if (src.keyframeAt(i)) w.u32be(i + 1);
    w.end();
  }

  // stsc: 모든 청크가 샘플 1개
  w.bytes_(fullBox('stsc', 0, 0, payload((p) => { p.u32be(1).u32be(1).u32be(1).u32be(1); })));

  // stsz
  w.beginFull('stsz', 0, 0);
  if (stats.allSame) {
    w.u32be(src.sizeAt(0)).u32be(n);
  } else {
    w.u32be(0).u32be(n);
    for (let i = 0; i < n; i++) w.u32be(src.sizeAt(i));
  }
  w.end();

  // stco / co64: 트랙의 chunkOffsets 접근자가 샘플마다 절대 파일 오프셋을 기록 (2^32-1을 넘는 오프셋이 있으면 co64)
  w.beginFull(stats.needs64 ? 'co64' : 'stco', 0, 0);
  w.u32be(n);
  track.chunkOffsets.write(w, stats.needs64);
  w.end();

  w.end();
}

function buildAvc1(track) {
  const entry = payload((w) => {
    w.zeros(6).u16be(1);          // reserved, data_reference_index
    w.u16be(0).u16be(0);          // pre_defined, reserved
    w.zeros(12);                  // pre_defined[3]
    w.u16be(track.width).u16be(track.height);
    w.u32be(0x00480000).u32be(0x00480000); // 72 dpi
    w.u32be(0);
    w.u16be(1);                   // frame_count
    w.zeros(32);                  // compressorname
    w.u16be(0x0018);              // depth
    w.u16be(0xFFFF);              // pre_defined -1
  });
  const pasp = box('pasp', payload((w) => { w.u32be(1).u32be(1); }));
  return box('avc1', entry, box('avcC', track.avcC), pasp);
}

function buildAudioSampleEntry(isMov, track) {
  if (isMov) {
    // QuickTime 사운드 디스크립션 v1 ('.mp3') - ffmpeg movenc 와 동일한 레이아웃
    return box('.mp3', payload((w) => {
      w.zeros(6).u16be(1);          // reserved, data_reference_index
      w.u16be(1).u16be(0).u32be(0); // version 1, revision, vendor
      w.u16be(track.channels).u16be(16);
      w.u16be(0xFFFE);              // compression_id = -2 (가변)
      w.u16be(0);                   // packet_size
      w.fixed16_16(track.sampleRate);
      w.u32be(track.samplesPerFrame); // samplesPerPacket
      w.u32be(0);                   // bytesPerPacket
      w.u32be(0);                   // bytesPerFrame
      w.u32be(2);                   // bytesPerSample
    }));
  }

  const entry = payload((w) => {
    w.zeros(6).u16be(1);
    w.u16be(0).u16be(0).u32be(0); // version 0, revision, vendor
    w.u16be(track.channels).u16be(16);
    w.u16be(0).u16be(0);          // compression_id, packet_size
    w.fixed16_16(track.sampleRate);
  });
  return box('mp4a', entry, buildEsds(track));
}

function buildEsds(track) {
  const bitrate = track.bitrate;
  const decoderConfig = payload((w) => {
    w.u8(track.samplesPerFrame === 576 ? 0x69 : 0x6B); // objectTypeIndication: MPEG-2 Audio(0x69) / MPEG-1 Audio(0x6B)
    w.u8(0x15);                  // streamType 5 (audio) << 2 | reserved 1
    w.u8(0).u16be(0);            // bufferSizeDB (3 bytes)
    w.u32be(bitrate);            // maxBitrate
    w.u32be(bitrate);            // avgBitrate
  });
  const slConfig = new Uint8Array([0x02]);
  const esBody = payload((w) => {
    w.u16be(0).u8(0);             // ES_ID(MP4에서는 0), flags
    writeDescriptor(w, 0x04, decoderConfig);
    writeDescriptor(w, 0x06, slConfig);
  });
  return fullBox('esds', 0, 0, payload((w) => { writeDescriptor(w, 0x03, esBody); }));
}

function writeDescriptor(w, tag, body) {
  w.u8(tag);
  // 4바이트 확장 길이 (ffmpeg와 동일)
  w.u8(0x80 | ((body.length >> 21) & 0x7F));
  w.u8(0x80 | ((body.length >> 14) & 0x7F));
  w.u8(0x80 | ((body.length >> 7) & 0x7F));
  w.u8(body.length & 0x7F);
  w.bytes_(body);
}
