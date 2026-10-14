// MP4 / MOV 머서 - H.264(avc1) 영상 + MP3 오디오를 ISO BMFF / QuickTime 컨테이너로 작성
// 입력은 모두 메모리에 있는 샘플이며, 출력은 Blob 파트로 바로 쓸 수 있는 Uint8Array 배열입니다.
import { ByteWriter } from './byte-writer.js';

const VIDEO_TIMESCALE = 90000;
const MOVIE_TIMESCALE = 1000;
const MAC_EPOCH_OFFSET = 2082844800; // 1904-01-01 → 1970-01-01 (초)
const MP3_ENCODER_DELAY_SAMPLES = 1105; // LAME: 인코더 576 + 디코더 529
const UINT32_MAX = 0xFFFFFFFF;

/**
 * 샘플/프레임의 바이트 크기. 데이터가 메모리에 있으면 data.length, 디스크 저장소 참조면 ref.size
 */
function sampleSize(s) {
  if (s.data) return s.data.length;
  if (s.ref) return s.ref.size;
  throw new Error('샘플에 data 또는 ref가 필요합니다');
}

/**
 * 파일 레이아웃 계산 (공통). 샘플 데이터는 읽지 않고 크기만 사용하므로 디스크 저장소 참조만으로도 계산할 수 있습니다.
 * @returns {{head:Uint8Array, entries:Array<{track:Object, index:number, size:number, source:Object}>, moov:Uint8Array, totalBytes:number}}
 */
export function planMp4({ container = 'mp4', video, audio = null, creationTime = new Date() }) {
  if (container !== 'mp4' && container !== 'mov') {
    throw new Error(`지원하지 않는 컨테이너입니다: ${container}`);
  }
  if (!video || !Array.isArray(video.samples) || video.samples.length === 0) {
    throw new Error('영상 샘플이 없습니다');
  }
  if (audio && audio.codec !== 'mp3') {
    throw new Error(`지원하지 않는 컨테이너 오디오 코덱입니다: ${audio.codec}`);
  }
  if (audio && (!Array.isArray(audio.frames) || audio.frames.length === 0)) {
    audio = null; // 오디오 프레임이 없으면 영상만 기록
  }

  const isMov = container === 'mov';
  const time = Math.floor(creationTime.getTime() / 1000) + MAC_EPOCH_OFFSET;

  // ---- 트랙 샘플 테이블 준비 ----
  const audioTrack = audio ? prepareAudioTrack(audio) : null;
  const videoTrack = prepareVideoTrack(video, audioTrack);

  // ---- mdat 배치: 시간순 인터리빙 (각 샘플 = 1 청크) ----
  const entries = [];
  videoTrack.samples.forEach((s, i) => entries.push({ track: videoTrack, index: i, time: s.dts / VIDEO_TIMESCALE, size: s.size, source: s.source }));
  if (audioTrack) {
    audioTrack.samples.forEach((s, i) => entries.push({ track: audioTrack, index: i, time: s.dts / audioTrack.timescale, size: s.size, source: s.source }));
  }
  entries.sort((a, b) => (a.time - b.time) || (a.track === videoTrack ? -1 : 1));

  const mdatPayloadSize = entries.reduce((sum, e) => sum + e.size, 0);
  const ftyp = buildFtyp(isMov);
  const mdatHeader = buildMdatHeader(mdatPayloadSize);

  let offset = ftyp.length + mdatHeader.length;
  for (const entry of entries) {
    entry.track.samples[entry.index].offset = offset;
    offset += entry.size;
  }

  const moov = buildMoov({ isMov, time, videoTrack, audioTrack });
  const head = new Uint8Array(ftyp.length + mdatHeader.length);
  head.set(ftyp, 0);
  head.set(mdatHeader, ftyp.length);

  return { head, entries, moov, totalBytes: head.length + mdatPayloadSize + moov.length };
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
  for (const e of plan.entries) {
    if (!e.source.data) throw new Error('buildMp4는 메모리 샘플(data)만 지원합니다. 저장소 참조는 writeMp4를 사용하세요.');
    parts.push(e.source.data);
  }
  parts.push(plan.moov);
  return parts;
}

/**
 * MP4 또는 MOV 파일을 출력 싱크에 스트리밍으로 씁니다. 샘플 데이터가 디스크 저장소(ChunkStore)에 있어도
 * 한 번에 한 샘플만 읽으므로 메모리 사용량이 파일 크기와 무관합니다.
 * video.samples[i] / audio.frames[i]는 { data } 또는 { ref:{offset,size} } 중 하나를 가지며, 참조인 경우
 * video.store / audio.store (finalize된 ChunkStore)에서 읽습니다.
 * @returns {Promise<{blob:Blob, bytes:number}>}
 */
export async function writeMp4({ output, ...options }) {
  if (!output || typeof output.write !== 'function') {
    throw new Error('출력 싱크(output)가 필요합니다');
  }
  const plan = planMp4(options);
  await output.write(plan.head);
  for (const e of plan.entries) {
    await output.write(await readSource(e.source));
  }
  await output.write(plan.moov);
  const blob = await output.close();
  return { blob, bytes: plan.totalBytes };
}

/** 샘플 소스를 쓰기 가능한 데이터로 (메모리 데이터 또는 저장소 Blob 조각) */
async function readSource(source) {
  if (source.data) return source.data;
  if (!source.store) throw new Error('저장소 참조 샘플에는 store가 필요합니다');
  return source.store.slice(source.ref.offset, source.ref.size);
}

// ---- 트랙 준비 ----

function prepareVideoTrack(video, audioTrack) {
  const origin = video.samples[0].timestamp;
  const dtsList = [];
  let prev = 0;
  for (let i = 0; i < video.samples.length; i++) {
    let dts = Math.round((video.samples[i].timestamp - origin) * VIDEO_TIMESCALE / 1_000_000);
    if (i > 0 && dts <= prev) dts = prev + 1; // 단조 증가 보장
    dtsList.push(dts);
    prev = dts;
  }
  const durations = [];
  for (let i = 0; i < dtsList.length; i++) {
    if (i < dtsList.length - 1) {
      durations.push(dtsList[i + 1] - dtsList[i]);
    } else {
      durations.push(i > 0 ? durations[i - 1] : Math.round(VIDEO_TIMESCALE / 30));
    }
  }
  // 오디오가 더 길면 마지막 프레임을 늘려 영상 트랙이 오디오 끝까지 이어지게 함 (정적 화면은 프레임이 드묾)
  if (audioTrack) {
    const audioEnd = Math.round((audioTrack.duration - audioTrack.editOffset) * VIDEO_TIMESCALE / audioTrack.timescale);
    const last = dtsList.length - 1;
    const videoEnd = dtsList[last] + durations[last];
    if (audioEnd > videoEnd) durations[last] += audioEnd - videoEnd;
  }
  const samples = video.samples.map((s, i) => ({
    size: sampleSize(s),
    source: { data: s.data, ref: s.ref, store: video.store },
    dts: dtsList[i],
    duration: durations[i],
    keyframe: !!s.keyframe,
    offset: 0
  }));
  return {
    kind: 'video',
    trackId: 1,
    timescale: VIDEO_TIMESCALE,
    width: video.width,
    height: video.height,
    avcC: video.avcC,
    samples,
    duration: samples.reduce((s, x) => s + x.duration, 0),
    editOffset: 0
  };
}

function prepareAudioTrack(audio) {
  let dts = 0;
  const samples = audio.frames.map((f) => {
    const sample = { size: sampleSize(f), source: { data: f.data, ref: f.ref, store: audio.store }, dts, duration: f.samples, keyframe: true, offset: 0 };
    dts += f.samples;
    return sample;
  });
  const delay = audio.encoderDelaySamples ?? MP3_ENCODER_DELAY_SAMPLES;
  return {
    kind: 'audio',
    trackId: 2,
    timescale: audio.sampleRate,
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    bitrate: audio.bitrate || estimateBitrate(audio),
    samplesPerFrame: audio.frames[0].samples || 1152, // MPEG-1: 1152, MPEG-2/2.5: 576
    samples,
    duration: dts,
    editOffset: Math.min(delay, Math.max(0, dts - 1))
  };
}

function estimateBitrate(audio) {
  const bytes = audio.frames.reduce((s, f) => s + sampleSize(f), 0);
  const samples = audio.frames.reduce((s, f) => s + f.samples, 0);
  return samples > 0 ? Math.round(bytes * 8 * audio.sampleRate / samples) : 128000;
}

// ---- 박스 작성 유틸 ----

function box(type, ...payloads) {
  const w = new ByteWriter(64);
  w.u32be(0);
  w.ascii(type);
  for (const p of payloads) w.bytes_(p);
  w.patchU32be(0, w.length);
  return w.bytes().slice();
}

function fullBox(type, version, flags, ...payloads) {
  const header = new ByteWriter(4);
  header.u8(version);
  header.u8((flags >> 16) & 0xFF);
  header.u8((flags >> 8) & 0xFF);
  header.u8(flags & 0xFF);
  return box(type, header.bytes(), ...payloads);
}

function payload(fn, capacity = 128) {
  const w = new ByteWriter(capacity);
  fn(w);
  return w.bytes().slice();
}

function buildFtyp(isMov) {
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

function buildMoov({ isMov, time, videoTrack, audioTrack }) {
  const tracks = [videoTrack, audioTrack].filter(Boolean);
  const movieDuration = Math.max(...tracks.map(t => toMovieTime(t.duration - t.editOffset, t.timescale)));
  const parts = [buildMvhd(time, movieDuration, tracks.length + 1)];
  for (const track of tracks) {
    parts.push(buildTrak({ isMov, time, track, movieDuration }));
  }
  return box('moov', ...parts);
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

function buildTrak({ isMov, time, track, movieDuration }) {
  const trackMovieDuration = toMovieTime(track.duration - track.editOffset, track.timescale);
  const parts = [buildTkhd(time, track, trackMovieDuration)];
  if (track.editOffset > 0) {
    parts.push(box('edts', buildElst(track, trackMovieDuration)));
  }
  parts.push(buildMdia({ isMov, time, track }));
  return box('trak', ...parts);
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

function buildMdia({ isMov, time, track }) {
  const isVideo = track.kind === 'video';
  const mdhd = fullBox('mdhd', 0, 0, payload((w) => {
    w.u32be(time).u32be(time).u32be(track.timescale).u32be(track.duration);
    w.u16be(0x55C4); // language 'und'
    w.u16be(0);
  }));
  const hdlr = buildHdlr(isMov, isMov ? 'mhlr' : null, isVideo ? 'vide' : 'soun', isVideo ? 'VideoHandler' : 'SoundHandler');
  const minf = buildMinf({ isMov, track });
  return box('mdia', mdhd, hdlr, minf);
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

function buildMinf({ isMov, track }) {
  const isVideo = track.kind === 'video';
  const parts = [];
  if (isVideo) {
    parts.push(fullBox('vmhd', 0, 1, payload((w) => { w.u16be(0).u16be(0).u16be(0).u16be(0); })));
  } else {
    parts.push(fullBox('smhd', 0, 0, payload((w) => { w.u16be(0).u16be(0); })));
  }
  if (isMov) {
    parts.push(buildHdlr(true, 'dhlr', 'url ', 'DataHandler'));
  }
  const dref = fullBox('dref', 0, 0, payload((w) => { w.u32be(1); }), fullBox('url ', 0, 1));
  parts.push(box('dinf', dref));
  parts.push(buildStbl({ isMov, track }));
  return box('minf', ...parts);
}

function buildStbl({ isMov, track }) {
  const isVideo = track.kind === 'video';
  const samples = track.samples;

  const stsd = fullBox('stsd', 0, 0, payload((w) => { w.u32be(1); }),
    isVideo ? buildAvc1(track) : buildAudioSampleEntry(isMov, track));

  // stts: 런렝스
  const runs = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last.delta === s.duration) last.count++;
    else runs.push({ count: 1, delta: s.duration });
  }
  const stts = fullBox('stts', 0, 0, payload((w) => {
    w.u32be(runs.length);
    for (const r of runs) w.u32be(r.count).u32be(r.delta);
  }, 8 + runs.length * 8));

  const parts = [stsd, stts];

  // stss: 키프레임 (모두 키프레임이면 생략)
  if (isVideo && !samples.every(s => s.keyframe)) {
    const keys = [];
    samples.forEach((s, i) => { if (s.keyframe) keys.push(i + 1); });
    parts.push(fullBox('stss', 0, 0, payload((w) => {
      w.u32be(keys.length);
      for (const k of keys) w.u32be(k);
    }, 8 + keys.length * 4)));
  }

  // stsc: 모든 청크가 샘플 1개
  parts.push(fullBox('stsc', 0, 0, payload((w) => { w.u32be(1).u32be(1).u32be(1).u32be(1); })));

  // stsz
  const allSame = samples.every(s => s.size === samples[0].size);
  parts.push(fullBox('stsz', 0, 0, payload((w) => {
    if (allSame) {
      w.u32be(samples[0].size).u32be(samples.length);
    } else {
      w.u32be(0).u32be(samples.length);
      for (const s of samples) w.u32be(s.size);
    }
  }, 8 + samples.length * 4)));

  // stco / co64
  const needs64 = samples.some(s => s.offset > UINT32_MAX);
  if (needs64) {
    parts.push(fullBox('co64', 0, 0, payload((w) => {
      w.u32be(samples.length);
      for (const s of samples) w.u64be(BigInt(s.offset));
    }, 8 + samples.length * 8)));
  } else {
    parts.push(fullBox('stco', 0, 0, payload((w) => {
      w.u32be(samples.length);
      for (const s of samples) w.u32be(s.offset);
    }, 8 + samples.length * 4)));
  }

  return box('stbl', ...parts);
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
