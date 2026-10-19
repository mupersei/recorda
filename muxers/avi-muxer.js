// AVI 머서 - H.264(Annex B, 'H264' fourcc) 영상 + MP3 오디오를 RIFF AVI 컨테이너로 작성
import { ByteWriter, fourcc } from './byte-writer.js';
import { avcToAnnexB, parseAvcC } from './h264.js';
import { BatchWriter, SequentialReader } from './batch-io.js';
import { videoSource, audioSource, readSampleData } from './sample-access.js';

const AVIF_HASINDEX = 0x00000010;
const AVIF_ISINTERLEAVED = 0x00000100;
const AVIIF_KEYFRAME = 0x00000010;
// RIFF AVI(OpenDML 미사용)는 32비트 크기 필드를 쓰므로 2GiB를 넘기지 않음 (레거시 파서 호환)
export const AVI_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1024;

/**
 * 가변 간격 프레임 타임스탬프를 고정 프레임레이트 슬롯 인덱스로 변환합니다.
 * 빈 슬롯은 호출자가 길이 0 청크로 채우고, 같은 슬롯으로 몰리는 프레임은 다음 슬롯으로 밀어 드롭을 피합니다.
 * @param {number[]} timestampsUs - 마이크로초 타임스탬프 (단조 증가 가정)
 * @param {number} frameRate
 * @returns {number[]} 각 프레임의 슬롯 인덱스
 */
export function assignFrameSlots(timestampsUs, frameRate) {
  if (timestampsUs.length === 0) return [];
  const origin = timestampsUs[0];
  const slotDuration = 1_000_000 / frameRate;
  const slots = [];
  let prev = -1;
  for (const ts of timestampsUs) {
    let slot = Math.round((ts - origin) / slotDuration);
    if (slot <= prev) slot = prev + 1;
    slots.push(slot);
    prev = slot;
  }
  return slots;
}

/**
 * 길이 접두(AVC) 샘플의 NAL 개수를 셉니다. 캡처 시점에 계산해 두면 데이터 없이도 Annex B 크기를 알 수 있습니다.
 */
export function countNalUnits(avcSample, nalLengthSize = 4) {
  let off = 0, count = 0;
  while (off + nalLengthSize <= avcSample.length) {
    let len = 0;
    for (let i = 0; i < nalLengthSize; i++) len = (len << 8) | avcSample[off + i];
    off += nalLengthSize;
    if (len <= 0 || off + len > avcSample.length) break;
    off += len;
    count++;
  }
  return count;
}

/** 파라미터 셋(SPS/PPS + 시작 코드) 바이트 수 */
function parameterSetBytes(avcC) {
  const { sps, pps } = parseAvcC(avcC);
  return [...sps, ...pps].reduce((s, n) => s + 4 + n.length, 0);
}

/** AVC 샘플을 Annex B로 바꿨을 때의 길이 (avcToAnnexB(...).length와 같음, 변환 버퍼를 만들지 않음) */
function annexBLength(avcSample, nalLengthSize, keyframe, psBytes) {
  let total = keyframe ? psBytes : 0;
  let off = 0;
  while (off + nalLengthSize <= avcSample.length) {
    let len = 0;
    for (let i = 0; i < nalLengthSize; i++) len = (len << 8) | avcSample[off + i];
    off += nalLengthSize;
    if (len <= 0 || off + len > avcSample.length) break;
    total += 4 + len;
    off += len;
  }
  return total;
}

/** 영상 샘플 i의 Annex B 변환 후 크기 (데이터가 있으면 실제 변환 길이, 없으면 저장소 크기 + nalCount 기반 계산) */
function videoChunkSize(vsrc, i, nalLengthSize, psBytes) {
  const keyframe = vsrc.keyframeAt(i);
  const data = vsrc.dataAt(i);
  if (data) return annexBLength(data, nalLengthSize, keyframe, psBytes);
  const nalCount = vsrc.nalCountAt(i);
  if (!vsrc.hasRefAt(i) || typeof nalCount !== 'number') {
    throw new Error('저장소 참조 샘플에는 ref와 nalCount가 필요합니다');
  }
  return vsrc.sizeAt(i) + (4 - nalLengthSize) * nalCount + (keyframe ? psBytes : 0);
}

// order 값: 슬롯의 영상 샘플 / 빈 슬롯(길이 0 청크) / 오디오 프레임
const CHUNK_VIDEO = 0;
const CHUNK_EMPTY = 1;
const CHUNK_AUDIO = 2;
const ID_VIDEO = [0x30, 0x30, 0x64, 0x63]; // '00dc'
const ID_AUDIO = [0x30, 0x31, 0x77, 0x62]; // '01wb'

/**
 * AVI 레이아웃 계산 (공통). 청크 데이터는 읽지 않고 크기만 사용합니다.
 * 샘플마다 객체를 만들지 않고, 청크 순서는 Uint8Array(order), 색인(idx1)은 정확한 크기의 버퍼 하나에 바로 씁니다.
 * @returns {{head:Uint8Array, order:Uint8Array, idx1:Uint8Array, video:Object, audio:Object|null, avcC:Uint8Array, totalBytes:number}}
 */
export function planAvi({ video, audio = null, frameRate = 30 }) {
  const vsrc = videoSource(video);
  if (!vsrc || vsrc.count === 0) {
    throw new Error('영상 샘플이 없습니다');
  }
  if (audio && audio.codec !== 'mp3') {
    throw new Error(`지원하지 않는 컨테이너 오디오 코덱입니다: ${audio.codec}`);
  }
  let asrc = audioSource(audio);
  if (!asrc || asrc.count === 0) {
    audio = null;
    asrc = null;
  }
  const nalLengthSize = parseAvcC(video.avcC).nalLengthSize;
  const psBytes = parameterSetBytes(video.avcC);
  const nV = vsrc.count;
  const nA = asrc ? asrc.count : 0;

  // ---- 비디오 청크 (슬롯 기준, 빈 슬롯은 길이 0): assignFrameSlots와 같은 계산을 배열 없이 ----
  const origin = vsrc.timestampAt(0);
  const slotDurationUs = 1_000_000 / frameRate;
  const slotOf = (i, prev) => {
    let slot = Math.round((vsrc.timestampAt(i) - origin) / slotDurationUs);
    if (slot <= prev) slot = prev + 1;
    return slot;
  };
  let lastSlot = -1;
  let totalBytes = 0, maxChunk = 0;
  for (let i = 0; i < nV; i++) {
    lastSlot = slotOf(i, lastSlot);
    const size = videoChunkSize(vsrc, i, nalLengthSize, psBytes);
    totalBytes += size;
    if (size > maxChunk) maxChunk = size;
  }
  let totalSlots = lastSlot + 1;
  // 오디오가 더 길면 빈 슬롯을 덧붙여 dwTotalFrames가 오디오 길이를 덮게 함
  let audioSamples = 0;
  for (let j = 0; j < nA; j++) {
    audioSamples += asrc.samplesAt(j);
    const size = asrc.sizeAt(j);
    totalBytes += size;
    if (size > maxChunk) maxChunk = size;
  }
  if (asrc) {
    const audioSlots = Math.ceil(audioSamples / audio.sampleRate * frameRate);
    if (audioSlots > totalSlots) totalSlots = audioSlots;
  }

  // ---- 헤더 ----
  const chunkCount = totalSlots + nA;
  const estimatedSize = totalBytes + chunkCount * 24 + 1024;
  if (estimatedSize > AVI_MAX_BYTES) {
    throw new Error(`AVI 파일 크기 한계(2GB)를 초과합니다: 약 ${(estimatedSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
  }
  const durationSec = totalSlots / frameRate;
  const hdrl = buildHdrl({ video, audio, asrc, frameRate, totalSlots, maxChunk, bytesPerSec: Math.ceil(totalBytes / Math.max(durationSec, 1e-6)), audioChunkCount: nA });

  // ---- 인터리빙: 슬롯 i 비디오 → 해당 슬롯 종료 시각 이전 오디오 (+ idx1 항목) ----
  const order = new Uint8Array(chunkCount);
  const idx1 = new Uint8Array(8 + chunkCount * 16);
  const view = new DataView(idx1.buffer);
  idx1.set([0x69, 0x64, 0x78, 0x31]); // 'idx1'
  view.setUint32(4, chunkCount * 16, true);
  let pos = 8;
  let offsetInMovi = 4; // 'movi' fourcc 기준
  const addEntry = (id, flags, size) => {
    idx1.set(id, pos);
    view.setUint32(pos + 4, flags, true);
    view.setUint32(pos + 8, offsetInMovi, true);
    view.setUint32(pos + 12, size, true);
    pos += 16;
    offsetInMovi += 8 + size + (size & 1);
  };
  let k = 0, vi = 0, ai = 0, samplePos = 0;
  let nextSlot = nV > 0 ? slotOf(0, -1) : Infinity;
  for (let i = 0; i < totalSlots; i++) {
    if (vi < nV && nextSlot === i) {
      order[k++] = CHUNK_VIDEO;
      addEntry(ID_VIDEO, vsrc.keyframeAt(vi) ? AVIIF_KEYFRAME : 0, videoChunkSize(vsrc, vi, nalLengthSize, psBytes));
      vi++;
      if (vi < nV) nextSlot = slotOf(vi, nextSlot);
    } else {
      order[k++] = CHUNK_EMPTY;
      addEntry(ID_VIDEO, 0, 0);
    }
    const slotEnd = (i + 1) * slotDurationUs;
    while (ai < nA && (samplePos * 1_000_000 / audio.sampleRate < slotEnd || i === totalSlots - 1)) {
      order[k++] = CHUNK_AUDIO;
      addEntry(ID_AUDIO, AVIIF_KEYFRAME, asrc.sizeAt(ai));
      samplePos += asrc.samplesAt(ai);
      ai++;
    }
  }
  const moviSize = offsetInMovi; // 4('movi') + Σ(8 + size + pad)

  // ---- movi + idx1 ----
  const moviHeader = new ByteWriter(12);
  moviHeader.ascii('LIST').u32le(moviSize).ascii('movi');

  const riffHeader = new ByteWriter(12);
  const riffSize = 4 + hdrl.length + (8 + moviSize) + idx1.length;
  riffHeader.ascii('RIFF').u32le(riffSize).ascii('AVI ');

  const head = concatParts([riffHeader.bytes(), hdrl, moviHeader.bytes()]);
  const { sps, pps } = parseAvcC(video.avcC);
  return {
    head, order, idx1, video: vsrc, audio: asrc, avcC: video.avcC, totalBytes: riffSize + 8,
    nalLengthSize, psBytes, parameterSets: [...sps, ...pps],
    videoChunkSize: (i) => videoChunkSize(vsrc, i, nalLengthSize, psBytes)
  };
}

function concatParts(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function chunkHeader(id, size) {
  const h = new Uint8Array(8);
  h.set(id);
  new DataView(h.buffer).setUint32(4, size, true);
  return h;
}

/**
 * AVI 파일을 메모리에서 생성합니다 (샘플 데이터가 메모리에 있을 때).
 * @param {Object} options
 * @param {{width:number, height:number, avcC:Uint8Array, samples:Array<{data:Uint8Array, timestamp:number, keyframe:boolean}>}} options.video
 *        - data는 AVC(길이 접두) 형식. 내부에서 Annex B로 변환됩니다.
 * @param {{codec:'mp3', sampleRate:number, channels:number, bitrate?:number, frames:Array<{data:Uint8Array, samples:number}>}|null} [options.audio]
 * @param {number} [options.frameRate=30]
 * @returns {Uint8Array[]} 파일 파트 목록
 */
export function buildAvi(options) {
  const plan = planAvi(options);
  const parts = [plan.head];
  const { order, video, audio } = plan;
  let vi = 0, ai = 0;
  for (let k = 0; k < order.length; k++) {
    if (order[k] === CHUNK_EMPTY) { parts.push(chunkHeader(ID_VIDEO, 0)); continue; }
    const isVideo = order[k] === CHUNK_VIDEO;
    const data = isVideo ? video.dataAt(vi) : audio.dataAt(ai);
    if (!data) throw new Error('buildAvi는 메모리 샘플(data)만 지원합니다. 저장소 참조는 writeAvi를 사용하세요.');
    const body = isVideo ? avcToAnnexB(data, plan.avcC, video.keyframeAt(vi)) : data;
    parts.push(chunkHeader(isVideo ? ID_VIDEO : ID_AUDIO, body.length), body);
    if (body.length & 1) parts.push(new Uint8Array(1));
    if (isVideo) vi++; else ai++;
  }
  parts.push(plan.idx1);
  return parts;
}

const START_CODE = new Uint8Array([0, 0, 0, 1]);
const PAD = new Uint8Array(1);

/**
 * AVC 샘플(길이 접두)을 Annex B로 바꿔 BatchWriter에 바로 씁니다: 시작 코드와 NAL 뷰만 넘기므로
 * 샘플마다 변환 버퍼를 만들지 않습니다 (버퍼 복사는 BatchWriter의 고정 버퍼로 한 번만).
 */
async function addAnnexB(writer, avc, plan, keyframe) {
  if (keyframe) {
    for (const nal of plan.parameterSets) { await writer.add(START_CODE); await writer.add(nal); }
  }
  const n = plan.nalLengthSize;
  let off = 0;
  while (off + n <= avc.length) {
    let len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | avc[off + i];
    off += n;
    if (len <= 0 || off + len > avc.length) break;
    await writer.add(START_CODE);
    await writer.add(avc.subarray(off, off + len));
    off += len;
  }
}

/**
 * AVI 파일을 출력 싱크에 스트리밍으로 씁니다. 영상 샘플은 저장소에서 순차로 읽어 Annex B로 바꾸며 바로 쓰므로
 * 메모리 사용량이 파일 크기와 무관합니다. 저장소 참조 영상 샘플에는 nalCount가 있어야 합니다(SampleIndex는 항상 보유).
 * @returns {Promise<{blob:Blob, bytes:number, timings:{planMs:number, writeMs:number, closeMs:number}}>}
 */
export async function writeAvi({ output, ...options }) {
  if (!output || typeof output.write !== 'function') {
    throw new Error('출력 싱크(output)가 필요합니다');
  }
  const now = () => (globalThis.performance ? performance.now() : Date.now());
  const t0 = now();
  const plan = planAvi(options);
  const t1 = now();
  const writer = new BatchWriter(output);
  const readers = new Map();
  const makeReader = (store) => new SequentialReader(store);
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  const addHeader = (id, size) => { header.set(id); headerView.setUint32(4, size, true); return writer.add(header); };
  const { order, video, audio } = plan;
  await writer.add(plan.head);
  let vi = 0, ai = 0;
  for (let k = 0; k < order.length; k++) {
    const kind = order[k];
    if (kind === CHUNK_EMPTY) {
      await addHeader(ID_VIDEO, 0);
    } else if (kind === CHUNK_VIDEO) {
      const size = plan.videoChunkSize(vi);
      await addHeader(ID_VIDEO, size);
      const start = writer.position;
      const avc = await readSampleData(video, vi, readers, makeReader);
      await addAnnexB(writer, avc, plan, video.keyframeAt(vi));
      if (writer.position - start !== size) {
        throw new Error(`AVI 영상 청크 크기 불일치 (샘플 ${vi}: 예상 ${size}, 실제 ${writer.position - start}) - nalCount를 확인하세요`);
      }
      if (size & 1) await writer.add(PAD);
      vi++;
    } else {
      const size = audio.sizeAt(ai);
      await addHeader(ID_AUDIO, size);
      await writer.add(await readSampleData(audio, ai, readers, makeReader));
      if (size & 1) await writer.add(PAD);
      ai++;
    }
  }
  await writer.add(plan.idx1);
  await writer.flush();
  const t2 = now();
  const blob = await output.close();
  return { blob, bytes: plan.totalBytes, timings: { planMs: Math.round(t1 - t0), writeMs: Math.round(t2 - t1), closeMs: Math.round(now() - t2) } };
}

function list(type, ...payloads) {
  const w = new ByteWriter(64);
  const size = 4 + payloads.reduce((s, p) => s + p.length, 0);
  w.ascii('LIST').u32le(size).ascii(type);
  for (const p of payloads) w.bytes_(p);
  return w.bytes().slice();
}

function chunk(id, body) {
  const w = new ByteWriter(8 + body.length + 1);
  w.ascii(id).u32le(body.length).bytes_(body);
  if (body.length & 1) w.u8(0);
  return w.bytes().slice();
}

function buildHdrl({ video, audio, asrc, frameRate, totalSlots, maxChunk, bytesPerSec, audioChunkCount }) {
  const avih = new ByteWriter(56);
  avih.u32le(Math.round(1_000_000 / frameRate)); // dwMicroSecPerFrame
  avih.u32le(bytesPerSec);                        // dwMaxBytesPerSec
  avih.u32le(0);                                  // dwPaddingGranularity
  avih.u32le(AVIF_HASINDEX | AVIF_ISINTERLEAVED); // dwFlags
  avih.u32le(totalSlots);                         // dwTotalFrames
  avih.u32le(0);                                  // dwInitialFrames
  avih.u32le(audio ? 2 : 1);                      // dwStreams
  avih.u32le(maxChunk);                           // dwSuggestedBufferSize
  avih.u32le(video.width);
  avih.u32le(video.height);
  avih.zeros(16);                                 // dwReserved[4]

  const parts = [chunk('avih', avih.bytes()), buildVideoStrl({ video, frameRate, totalSlots, maxChunk })];
  if (audio) parts.push(buildAudioStrl({ audio, asrc, audioChunkCount }));
  return list('hdrl', ...parts);
}

function buildVideoStrl({ video, frameRate, totalSlots, maxChunk }) {
  const strh = new ByteWriter(56);
  strh.u32le(fourcc('vids'));
  strh.u32le(fourcc('H264'));
  strh.u32le(0);              // dwFlags
  strh.u16le(0).u16le(0);     // wPriority, wLanguage
  strh.u32le(0);              // dwInitialFrames
  strh.u32le(1000);           // dwScale
  strh.u32le(Math.round(frameRate * 1000)); // dwRate (29.97 같은 비정수 fps 보존)
  strh.u32le(0);              // dwStart
  strh.u32le(totalSlots);     // dwLength
  strh.u32le(maxChunk);       // dwSuggestedBufferSize
  strh.u32le(0xFFFFFFFF);     // dwQuality (default)
  strh.u32le(0);              // dwSampleSize
  strh.i16le(0).i16le(0).i16le(video.width).i16le(video.height); // rcFrame

  const strf = new ByteWriter(40);
  strf.u32le(40);             // biSize
  strf.i32le(video.width);
  strf.i32le(video.height);
  strf.u16le(1);              // biPlanes
  strf.u16le(24);             // biBitCount
  strf.u32le(fourcc('H264')); // biCompression
  strf.u32le(video.width * video.height * 3); // biSizeImage
  strf.i32le(0).i32le(0);     // biXPelsPerMeter, biYPelsPerMeter
  strf.u32le(0).u32le(0);     // biClrUsed, biClrImportant

  return list('strl', chunk('strh', strh.bytes()), chunk('strf', strf.bytes()));
}

function buildAudioStrl({ audio, asrc, audioChunkCount }) {
  const bitrate = audio.bitrate || estimateBitrate(asrc, audio.sampleRate);
  let maxFrame = 0;
  for (let i = 0; i < asrc.count; i++) maxFrame = Math.max(maxFrame, asrc.sizeAt(i));
  const samplesPerFrame = asrc.samplesAt(0) || 1152; // MPEG-1: 1152, MPEG-2: 576

  const strh = new ByteWriter(56);
  strh.u32le(fourcc('auds'));
  strh.u32le(0);                        // fccHandler
  strh.u32le(0);                        // dwFlags
  strh.u16le(0).u16le(0);
  strh.u32le(0);                        // dwInitialFrames
  strh.u32le(samplesPerFrame);          // dwScale
  strh.u32le(audio.sampleRate);         // dwRate
  strh.u32le(0);                        // dwStart
  strh.u32le(audioChunkCount);          // dwLength (프레임 수)
  strh.u32le(maxFrame);                 // dwSuggestedBufferSize
  strh.u32le(0xFFFFFFFF);               // dwQuality
  strh.u32le(0);                        // dwSampleSize (가변 → 청크 = 샘플)
  strh.i16le(0).i16le(0).i16le(0).i16le(0);

  // MPEGLAYER3WAVEFORMAT (WAVEFORMATEX 18 + 12)
  const strf = new ByteWriter(30);
  strf.u16le(0x0055);                   // wFormatTag MP3
  strf.u16le(audio.channels);
  strf.u32le(audio.sampleRate);
  strf.u32le(Math.round(bitrate / 8));  // nAvgBytesPerSec
  // nBlockAlign: libavformat 계열(mpv, Kodi, LAV Filters 등)은 dwSampleSize=0일 때 이 값을 청크당 블록 수 계산에 사용하므로
  // 1이면 오디오 타이밍이 바이트 단위로 계산되어 깨짐 → ffmpeg와 동일하게 프레임 샘플 수를 기록
  strf.u16le(samplesPerFrame);          // nBlockAlign
  strf.u16le(0);                        // wBitsPerSample
  strf.u16le(12);                       // cbSize
  strf.u16le(1);                        // wID = MPEGLAYER3_ID_MPEG
  strf.u32le(2);                        // fdwFlags = MPEGLAYER3_FLAG_PADDING_OFF
  strf.u16le(samplesPerFrame);          // nBlockSize
  strf.u16le(1);                        // nFramesPerBlock
  strf.u16le(1393);                     // nCodecDelay

  return list('strl', chunk('strh', strh.bytes()), chunk('strf', strf.bytes()));
}

function estimateBitrate(asrc, sampleRate) {
  let bytes = 0, samples = 0;
  for (let i = 0; i < asrc.count; i++) { bytes += asrc.sizeAt(i); samples += asrc.samplesAt(i); }
  return samples > 0 ? Math.round(bytes * 8 * sampleRate / samples) : 128000;
}
