// AVI 머서 - H.264(Annex B, 'H264' fourcc) 영상 + MP3 오디오를 RIFF AVI 컨테이너로 작성
import { ByteWriter, fourcc } from './byte-writer.js';
import { avcToAnnexB, parseAvcC } from './h264.js';

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

/** 샘플의 Annex B 변환 후 크기 (데이터가 있으면 실제 변환 길이, 없으면 ref.size + nalCount 기반 계산) */
function annexBSize(sample, avcC, nalLengthSize, psBytes) {
  if (sample.data) return avcToAnnexB(sample.data, avcC, !!sample.keyframe).length;
  if (!sample.ref || typeof sample.nalCount !== 'number') {
    throw new Error('저장소 참조 샘플에는 ref와 nalCount가 필요합니다');
  }
  return sample.ref.size + (4 - nalLengthSize) * sample.nalCount + (sample.keyframe ? psBytes : 0);
}

/**
 * AVI 레이아웃 계산 (공통). 청크 데이터는 읽지 않고 크기만 사용합니다.
 */
export function planAvi({ video, audio = null, frameRate = 30 }) {
  if (!video || !Array.isArray(video.samples) || video.samples.length === 0) {
    throw new Error('영상 샘플이 없습니다');
  }
  if (audio && audio.codec !== 'mp3') {
    throw new Error(`지원하지 않는 컨테이너 오디오 코덱입니다: ${audio.codec}`);
  }
  if (audio && (!Array.isArray(audio.frames) || audio.frames.length === 0)) {
    audio = null;
  }
  const nalLengthSize = parseAvcC(video.avcC).nalLengthSize;
  const psBytes = parameterSetBytes(video.avcC);

  // ---- 비디오 청크 (슬롯 기준, 빈 슬롯은 길이 0) ----
  const slots = assignFrameSlots(video.samples.map(s => s.timestamp), frameRate);
  const slotDurationUs = 1_000_000 / frameRate;
  let totalSlots = slots[slots.length - 1] + 1;
  // 오디오가 더 길면 빈 슬롯을 덧붙여 dwTotalFrames가 오디오 길이를 덮게 함
  if (audio) {
    const audioSamples = audio.frames.reduce((s, f) => s + f.samples, 0);
    const audioSlots = Math.ceil(audioSamples / audio.sampleRate * frameRate);
    if (audioSlots > totalSlots) totalSlots = audioSlots;
  }
  const videoChunks = new Array(totalSlots);
  video.samples.forEach((s, i) => {
    videoChunks[slots[i]] = {
      id: '00dc',
      size: annexBSize(s, video.avcC, nalLengthSize, psBytes),
      keyframe: !!s.keyframe,
      source: { data: s.data, ref: s.ref, store: video.store, convert: true, keyframe: !!s.keyframe }
    };
  });
  for (let i = 0; i < totalSlots; i++) {
    if (!videoChunks[i]) videoChunks[i] = { id: '00dc', size: 0, keyframe: false, source: null };
  }

  // ---- 오디오 청크 (MP3 프레임 1개 = 청크 1개) ----
  const audioChunks = [];
  if (audio) {
    let samplePos = 0;
    for (const f of audio.frames) {
      const size = f.data ? f.data.length : f.ref.size;
      audioChunks.push({ id: '01wb', size, keyframe: true, timeUs: samplePos * 1_000_000 / audio.sampleRate, source: { data: f.data, ref: f.ref, store: audio.store, convert: false } });
      samplePos += f.samples;
    }
  }

  // ---- 인터리빙: 슬롯 i 비디오 → 해당 슬롯 종료 시각 이전 오디오 ----
  const ordered = [];
  let audioIndex = 0;
  for (let i = 0; i < totalSlots; i++) {
    ordered.push(videoChunks[i]);
    const slotEnd = (i + 1) * slotDurationUs;
    while (audioIndex < audioChunks.length && (audioChunks[audioIndex].timeUs < slotEnd || i === totalSlots - 1)) {
      ordered.push(audioChunks[audioIndex++]);
    }
  }

  // ---- 헤더 ----
  const maxChunk = ordered.reduce((m, c) => Math.max(m, c.size), 0);
  const totalBytes = ordered.reduce((s, c) => s + c.size, 0);
  const estimatedSize = totalBytes + ordered.length * 24 + 1024;
  if (estimatedSize > AVI_MAX_BYTES) {
    throw new Error(`AVI 파일 크기 한계(2GB)를 초과합니다: 약 ${(estimatedSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
  }
  const durationSec = totalSlots / frameRate;
  const hdrl = buildHdrl({ video, audio, frameRate, totalSlots, maxChunk, bytesPerSec: Math.ceil(totalBytes / Math.max(durationSec, 1e-6)), audioChunkCount: audioChunks.length });

  // ---- movi + idx1 ----
  const moviHeader = new ByteWriter(12);
  const moviSize = 4 + ordered.reduce((s, c) => s + 8 + c.size + (c.size & 1), 0);
  moviHeader.ascii('LIST').u32le(moviSize).ascii('movi');

  const idx1 = new ByteWriter(8 + ordered.length * 16);
  idx1.ascii('idx1').u32le(ordered.length * 16);
  let offsetInMovi = 4; // 'movi' fourcc 기준
  for (const chunk of ordered) {
    const header = new ByteWriter(8);
    header.ascii(chunk.id).u32le(chunk.size);
    chunk.header = header.bytes().slice();
    chunk.pad = chunk.size & 1;
    idx1.ascii(chunk.id).u32le(chunk.keyframe ? AVIIF_KEYFRAME : 0).u32le(offsetInMovi).u32le(chunk.size);
    offsetInMovi += 8 + chunk.size + chunk.pad;
  }

  const riffHeader = new ByteWriter(12);
  const riffSize = 4 + hdrl.length + (8 + moviSize) + idx1.length;
  riffHeader.ascii('RIFF').u32le(riffSize).ascii('AVI ');

  const head = concatParts([riffHeader.bytes().slice(), hdrl, moviHeader.bytes().slice()]);
  return { head, chunks: ordered, idx1: idx1.bytes().slice(), avcC: video.avcC, totalBytes: riffSize + 8 };
}

function concatParts(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 청크 소스를 AVI에 쓸 바이트로 (영상은 Annex B 변환) */
async function readChunk(source, avcC) {
  let bytes = source.data;
  if (!bytes) {
    if (!source.store) throw new Error('저장소 참조 샘플에는 store가 필요합니다');
    if (!source.convert) return source.store.slice(source.ref.offset, source.ref.size); // 오디오: 복사 없이 Blob 조각
    bytes = await source.store.readRange(source.ref.offset, source.ref.size);
  }
  return source.convert ? avcToAnnexB(bytes, avcC, source.keyframe) : bytes;
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
  for (const chunk of plan.chunks) {
    parts.push(chunk.header);
    if (chunk.source) {
      if (!chunk.source.data) throw new Error('buildAvi는 메모리 샘플(data)만 지원합니다. 저장소 참조는 writeAvi를 사용하세요.');
      parts.push(chunk.source.convert ? avcToAnnexB(chunk.source.data, plan.avcC, chunk.source.keyframe) : chunk.source.data);
    }
    if (chunk.pad) parts.push(new Uint8Array(1));
  }
  parts.push(plan.idx1);
  return parts;
}

/**
 * AVI 파일을 출력 싱크에 스트리밍으로 씁니다. 영상 샘플은 한 번에 하나씩 읽어 Annex B로 변환하므로
 * 메모리 사용량이 파일 크기와 무관합니다. 저장소 참조 영상 샘플에는 nalCount가 있어야 합니다.
 * @returns {Promise<{blob:Blob, bytes:number}>}
 */
export async function writeAvi({ output, ...options }) {
  if (!output || typeof output.write !== 'function') {
    throw new Error('출력 싱크(output)가 필요합니다');
  }
  const plan = planAvi(options);
  const pad = new Uint8Array(1);
  await output.write(plan.head);
  for (const chunk of plan.chunks) {
    await output.write(chunk.header);
    if (chunk.source) await output.write(await readChunk(chunk.source, plan.avcC));
    if (chunk.pad) await output.write(pad);
  }
  await output.write(plan.idx1);
  const blob = await output.close();
  return { blob, bytes: plan.totalBytes };
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

function buildHdrl({ video, audio, frameRate, totalSlots, maxChunk, bytesPerSec, audioChunkCount }) {
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
  if (audio) parts.push(buildAudioStrl({ audio, audioChunkCount }));
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

function buildAudioStrl({ audio, audioChunkCount }) {
  const bitrate = audio.bitrate || estimateBitrate(audio);
  const maxFrame = audio.frames.reduce((m, f) => Math.max(m, f.data ? f.data.length : f.ref.size), 0);
  const samplesPerFrame = audio.frames[0].samples || 1152; // MPEG-1: 1152, MPEG-2: 576

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

function estimateBitrate(audio) {
  const bytes = audio.frames.reduce((s, f) => s + (f.data ? f.data.length : f.ref.size), 0);
  const samples = audio.frames.reduce((s, f) => s + f.samples, 0);
  return samples > 0 ? Math.round(bytes * 8 * audio.sampleRate / samples) : 128000;
}
