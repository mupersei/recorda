// DirectMp4Writer - 녹화 중 샘플을 도착 순서대로 최종 파일(mdat)에 바로 쓰고, 중지 시 moov만 붙이는 MP4/MOV 작성기
// 중지 시 청크 저장소 → 최종 파일 복사(3시간 3 GB 기준 약 100초)를 없애는 것이 목적입니다.
// 같은 샘플을 buildMp4(메모리 배열, 기존 구현)로 만든 파일과 표(stts/stss/stsz/elst)·길이가 같고,
// stco/co64는 direct 파일의 실제 샘플 위치를 가리키는지 확인합니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { DirectMp4Writer } from '../muxers/direct-mp4-writer.js';
import { buildMp4 } from '../muxers/mp4-muxer.js';
import { concatBytes } from '../muxers/byte-writer.js';
import { MemoryFileSink, DirectoryFileSink } from '../storage/chunk-store.js';
import { FakeDirectoryHandle } from './helpers/fake-opfs.js';
import { syntheticTracks } from './helpers/muxer-golden-cases.js';
import {
  loadFixtureVideo, makeMp3Audio, writeOutput, ffprobe, ffmpegDecodeErrors, FFPROBE, FFMPEG,
  parseBoxes, findBox, findAllBoxes, readChunkOffsets, readStsz, readStts, readStss, readElst, readDuration
} from './helpers/media.js';

v8.setFlagsFromString('--expose-gc');
const gc = globalThis.gc || vm.runInNewContext('gc');

const CREATION_TIME = new Date(Date.UTC(2026, 9, 18));
const fixtureVideo = loadFixtureVideo();
const fixtureAudio = makeMp3Audio(2);

// ---- VideoTrackEncoder와 같은 타임스탬프 보정 규칙: 원본(캡처) 타임스탬프에서 일시정지 구간을 빼고, 두 번째 샘플부터 A/V 정렬 오프셋 ----
const ALIGN_US = 150_000;
function makeAdjust(pauseSegments, firstRaw) {
  const shift = (raw) => {
    for (let k = pauseSegments.length - 1; k >= 0; k--) if (raw >= pauseSegments[k].fromTimestamp) return raw - pauseSegments[k].offsetUs;
    return raw;
  };
  return (raw, i) => (i === 0 ? 0 : (shift(raw) - shift(firstRaw)) + ALIGN_US);
}

/**
 * 합성 트랙(지터·몰림·빠짐 있는 30fps 근처, 키프레임 30프레임마다) + 2초 일시정지(원본 타임스탬프에 2초 구멍).
 * 원본 타임스탬프(raw)와 보정 함수, 보정이 끝난 배열 형식(buildMp4 입력)을 함께 돌려줍니다.
 */
function syntheticRecording({ videoCount = 400, audioCount = 650, seed = 5, pauseAt = Math.floor(videoCount * 0.45) } = {}) {
  const synth = syntheticTracks({ videoCount, audioCount, seed });
  const raw = synth.video.map((s, i) => ({ ...s, timestamp: 7_000_000 + s.timestamp + (i >= pauseAt ? 2_000_000 : 0) }));
  const pauseSegments = [{ fromTimestamp: raw[pauseAt].timestamp, offsetUs: 2_000_000 - 33_333 }];
  const adjust = makeAdjust(pauseSegments, raw[0].timestamp);
  const adjusted = raw.map((s, i) => ({ ...s, timestamp: adjust(s.timestamp, i) }));
  const audio = { codec: 'mp3', sampleRate: 48000, channels: 2, bitrate: 128000, frames: synth.audio };
  return { raw, adjust, video: { width: 640, height: 360, avcC: fixtureVideo.avcC, samples: adjusted }, audio };
}

/** 도착 순서: 실제 녹화처럼 영상·오디오가 시간 순으로 섞여 들어옴 (영상은 원본 시각, 오디오는 PCM 시각 기준) */
function arrivalOrder(rawVideo, audioFrames, sampleRate, startUs) {
  const order = [];
  let i = 0, j = 0, aTime = startUs;
  while (i < rawVideo.length || j < audioFrames.length) {
    if (j >= audioFrames.length || (i < rawVideo.length && rawVideo[i].timestamp <= aTime)) order.push(['v', i++]);
    else { order.push(['a', j]); aTime += audioFrames[j++].samples * 1e6 / sampleRate; }
  }
  return order;
}

async function writeDirect({ container = 'mp4', rawVideo, video, audio, adjust, sink = new MemoryFileSink('video/mp4'), bufferBytes } = {}) {
  const writer = new DirectMp4Writer({ sink, container, creationTime: CREATION_TIME, bufferBytes, audio: audio ? { codec: 'mp3', sampleRate: audio.sampleRate, channels: audio.channels, bitrate: audio.bitrate } : null });
  await writer.start();
  writer.setVideoConfig({ width: video.width, height: video.height, avcC: video.avcC });
  const order = audio ? arrivalOrder(rawVideo, audio.frames, audio.sampleRate, rawVideo[0].timestamp) : rawVideo.map((_, i) => ['v', i]);
  for (const [kind, k] of order) {
    if (kind === 'v') writer.addVideoSample(rawVideo[k].data, { timestamp: rawVideo[k].timestamp, keyframe: !!rawVideo[k].keyframe, nalCount: rawVideo[k].nalCount || 1 });
    else writer.addAudioFrame(audio.frames[k].data, { samples: audio.frames[k].samples });
  }
  const result = await writer.finish({ videoTimestampAdjust: adjust });
  return { writer, result, bytes: new Uint8Array(await result.blob.arrayBuffer()) };
}

/** moov 표 요약 (트랙별 stts/stss/stsz/elst/길이 + 오프셋) */
function tables(file) {
  const boxes = parseBoxes(file);
  const moov = findBox(boxes, 'moov');
  return {
    top: boxes.map(b => b.type),
    mvhd: readDuration(findBox(moov.children, 'mvhd')),
    tracks: findAllBoxes(moov.children, 'trak').map((trak) => {
      const stbl = findBox(trak.children, 'mdia/minf/stbl');
      return {
        tkhd: readDuration(findBox(trak.children, 'tkhd')),
        mdhd: readDuration(findBox(trak.children, 'mdia/mdhd')),
        elst: readElst(trak.children),
        stts: readStts(stbl.children),
        stss: readStss(stbl.children),
        stsz: readStsz(stbl.children),
        stsd: findBox(stbl.children, 'stsd').payload,
        offsetBox: stbl.children.find(b => b.type === 'stco' || b.type === 'co64').type,
        offsets: readChunkOffsets(stbl.children)
      };
    })
  };
}

function assertSameTables(direct, expected, label) {
  assert.deepEqual(direct.mvhd, expected.mvhd, `${label}: mvhd 길이`);
  assert.equal(direct.tracks.length, expected.tracks.length, `${label}: 트랙 수`);
  direct.tracks.forEach((t, k) => {
    const e = expected.tracks[k];
    for (const key of ['tkhd', 'mdhd', 'elst', 'stts', 'stss', 'stsz']) assert.deepEqual(t[key], e[key], `${label}: 트랙 ${k + 1} ${key}`);
    assert.deepEqual(Buffer.from(t.stsd), Buffer.from(e.stsd), `${label}: 트랙 ${k + 1} stsd(avc1/avcC, mp4a/esds 또는 .mp3)`);
  });
}

function assertOffsetsPointAtSamples(file, track, samples, label) {
  assert.equal(track.offsets.length, samples.length, `${label}: 오프셋 수`);
  track.offsets.forEach((off, i) => {
    const data = samples[i].data;
    const actual = file.subarray(off, off + data.length);
    assert.ok(Buffer.from(actual).equals(Buffer.from(data)), `${label}: 샘플 #${i} 오프셋 ${off}가 실제 샘플 바이트를 가리킴`);
  });
}

test('DirectMp4Writer: 파일은 ftyp → mdat(16바이트 헤더: size=1 + 64비트 largesize) → moov이고, largesize는 중지 시 실제 크기로 패치된다', async () => {
  const rec = syntheticRecording({ videoCount: 60, audioCount: 90 });
  const { bytes, result } = await writeDirect({ rawVideo: rec.raw, video: rec.video, audio: rec.audio, adjust: rec.adjust });
  const boxes = parseBoxes(bytes);
  assert.deepEqual(boxes.map(b => b.type), ['ftyp', 'mdat', 'moov']);
  const mdat = boxes[1];
  const view = new DataView(bytes.buffer, bytes.byteOffset + mdat.offset, 16);
  assert.equal(view.getUint32(0), 1, 'size = 1 (largesize 사용)');
  assert.equal(mdat.headerSize, 16);
  const payload = rec.raw.reduce((s, x) => s + x.data.length, 0) + rec.audio.frames.reduce((s, f) => s + f.data.length, 0);
  assert.equal(Number(view.getBigUint64(8)), 16 + payload, 'largesize = 16 + 샘플 바이트 합');
  assert.equal(bytes.length, boxes.reduce((s, b) => s + b.size, 0), '상자 크기 합 = 파일 크기');
  assert.equal(result.bytes, bytes.length);
  assert.equal(String.fromCharCode(...boxes[0].payload.subarray(0, 4)), 'isom', 'planMp4와 같은 ftyp (isom)');
  for (const k of ['planMs', 'writeMs', 'closeMs']) assert.equal(typeof result.timings[k], 'number', k);
});

for (const container of ['mp4', 'mov']) {
  test(`DirectMp4Writer(${container}): buildMp4(메모리 배열)와 같은 샘플이면 stts·stss·stsz·elst·stsd·길이가 같고, stco/co64는 direct 파일의 실제 샘플 바이트를 가리킨다 (원본 타임스탬프 + 정렬·일시정지 보정 접근자)`, async () => {
    const rec = syntheticRecording();
    const expectedFile = concatBytes(buildMp4({ container, video: rec.video, audio: rec.audio, creationTime: CREATION_TIME }));
    const { bytes, writer } = await writeDirect({ container, rawVideo: rec.raw, video: rec.video, audio: rec.audio, adjust: rec.adjust });
    const direct = tables(bytes);
    const expected = tables(expectedFile);
    assert.deepEqual(direct.top, ['ftyp', 'mdat', 'moov']);
    assert.deepEqual(Buffer.from(parseBoxes(bytes)[0].payload), Buffer.from(parseBoxes(expectedFile)[0].payload), 'ftyp 브랜드가 planMp4와 같음');
    assertSameTables(direct, expected, container);
    assert.ok(direct.tracks[0].stss && direct.tracks[0].stss.length > 1, '키프레임 표');
    assert.deepEqual(direct.tracks[1].elst.map(e => e.mediaTime), [1105], 'MP3 인코더 지연 1105 샘플 elst');
    assertOffsetsPointAtSamples(bytes, direct.tracks[0], rec.raw, '영상');
    assertOffsetsPointAtSamples(bytes, direct.tracks[1], rec.audio.frames, '오디오');
    assert.equal(writer.videoIndex.timestampAt(1), rec.raw[1].timestamp, '인덱스에는 원본 타임스탬프, 보정은 중지 시 접근자로');
  });
}

test('DirectMp4Writer: 오디오가 더 길면 마지막 영상 샘플을 오디오 끝까지 늘리는 규칙도 buildMp4와 같고, 오디오 프레임이 없으면 영상만 기록한다', async () => {
  const short = { ...fixtureVideo, samples: fixtureVideo.samples.slice(0, 4) };
  const expected = tables(concatBytes(buildMp4({ container: 'mp4', video: short, audio: fixtureAudio, creationTime: CREATION_TIME })));
  const { bytes } = await writeDirect({ rawVideo: short.samples, video: short, audio: fixtureAudio, adjust: null });
  const direct = tables(bytes);
  assertSameTables(direct, expected, '짧은 영상 + 긴 오디오');
  assert.equal(direct.tracks[0].stts.at(-1).count, 1, '마지막 샘플만 늘어남');

  const videoOnly = tables(concatBytes(buildMp4({ container: 'mp4', video: fixtureVideo, audio: null, creationTime: CREATION_TIME })));
  const writer = new DirectMp4Writer({ sink: new MemoryFileSink('video/mp4'), creationTime: CREATION_TIME, audio: { codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000 } });
  await writer.start();
  writer.setVideoConfig({ width: fixtureVideo.width, height: fixtureVideo.height, avcC: fixtureVideo.avcC });
  for (const s of fixtureVideo.samples) writer.addVideoSample(s.data, { timestamp: s.timestamp, keyframe: s.keyframe, nalCount: 1 });
  const only = tables(new Uint8Array(await (await writer.finish()).blob.arrayBuffer()));
  assert.equal(only.tracks.length, 1, '오디오 프레임이 없으면 오디오 트랙 없음');
  assertSameTables(only, videoOnly, '영상만');
});

test('DirectMp4Writer: 2^32-1을 넘는 오프셋이 있으면 co64를 쓰고 64비트 largesize에 4 GB 넘는 mdat 크기를 기록한다', async () => {
  // 데이터는 버리고 크기만 세는 싱크 (2 MB 샘플 2,200개 ≈ 4.4 GB)
  class CountingSink {
    constructor() { this.size = 0; this.writes = 0; this.last = null; this.patches = []; this.closed = false; }
    async write(data) { this.writes++; this.size += data.length; this.last = data; }
    async writeAt(position, data) { this.patches.push({ position, data: data.slice() }); }
    async close() { this.closed = true; return new Blob([]); }
    async abort() {}
  }
  const sink = new CountingSink();
  const writer = new DirectMp4Writer({ sink, creationTime: CREATION_TIME, audio: { codec: 'mp3', sampleRate: 48000, channels: 2, bitrate: 160000 } });
  await writer.start();
  writer.setVideoConfig({ width: 1920, height: 1080, avcC: fixtureVideo.avcC });
  const big = new Uint8Array(2 * 1024 * 1024);
  const frame = new Uint8Array(418); frame[0] = 0xFF; frame[1] = 0xFB;
  const N = 2200;
  for (let i = 0; i < N; i++) {
    writer.addVideoSample(big, { timestamp: Math.round(i * 1e6 / 30), keyframe: i % 60 === 0, nalCount: 1 });
    writer.addAudioFrame(frame, { samples: 1152 });
  }
  const result = await writer.finish();
  const payload = N * (big.length + frame.length);
  assert.ok(payload > 0xFFFFFFFF, '4 GB 초과');
  const moovBytes = new Uint8Array(sink.last);
  const moov = parseBoxes(moovBytes)[0];
  assert.equal(moov.type, 'moov', '마지막 쓰기는 moov');
  const traks = findAllBoxes(moov.children, 'trak');
  const vStbl = findBox(traks[0].children, 'mdia/minf/stbl').children;
  const aStbl = findBox(traks[1].children, 'mdia/minf/stbl').children;
  assert.ok(vStbl.some(b => b.type === 'co64') && aStbl.some(b => b.type === 'co64'), '두 트랙 모두 co64');
  const vOffsets = readChunkOffsets(vStbl);
  const head = writer.dataStart;
  assert.equal(vOffsets[0], head);
  assert.equal(vOffsets[N - 1], head + (N - 1) * (big.length + frame.length), '4 GB 넘는 실제 위치');
  assert.ok(vOffsets[N - 1] > 0xFFFFFFFF);
  const patch = sink.patches.find(p => p.position === writer.dataStart - 8);
  assert.ok(patch, 'mdat largesize 패치');
  assert.equal(Number(new DataView(patch.data.buffer, patch.data.byteOffset, 8).getBigUint64(0)), 16 + payload);
  assert.equal(sink.size, head + payload + moovBytes.length);
  assert.equal(result.bytes, sink.size);
  assert.ok(sink.closed);
});

test('DirectMp4Writer: 샘플마다 쓰지 않고 8 MB 고정 버퍼 하나로 묶어 쓴다 (write 호출 수 ≪ 샘플 수, 같은 ArrayBuffer 재사용)', async () => {
  const sink = new MemoryFileSink('video/mp4');
  const buffers = new Set();
  let writes = 0;
  const orig = sink.write.bind(sink);
  sink.write = (d) => { writes++; buffers.add(d.buffer); return orig(d); };
  const writer = new DirectMp4Writer({ sink, creationTime: CREATION_TIME });
  await writer.start();
  writer.setVideoConfig({ width: 640, height: 360, avcC: fixtureVideo.avcC });
  const data = new Uint8Array(40_000);
  for (let i = 0; i < 1000; i++) writer.addVideoSample(data, { timestamp: i * 33_333, keyframe: i % 60 === 0, nalCount: 1 }); // 40 MB
  await writer.finish();
  assert.ok(writes <= 7, `write ${writes}회 (샘플 1,000개, 40 MB)`);
  assert.equal(buffers.size, 1, '고정 버퍼 하나 (moov 포함 모든 쓰기)');
});

test('DirectMp4Writer: 녹화 중 출력 쓰기가 실패하면(권한 회수·드라이브 분리) onError를 한 번 부르고 이후 샘플은 버리며, finish는 그 오류로 거부된다', async () => {
  const dir = new FakeDirectoryHandle('USB');
  const sink = new DirectoryFileSink(dir, 'recorda_x.mp4', 'video/mp4');
  await sink.open();
  const errors = [];
  const writer = new DirectMp4Writer({ sink, creationTime: CREATION_TIME, bufferBytes: 64 * 1024, onError: (e) => errors.push(e) });
  await writer.start();
  writer.setVideoConfig({ width: 640, height: 360, avcC: fixtureVideo.avcC });
  const data = new Uint8Array(10_000);
  for (let i = 0; i < 10; i++) writer.addVideoSample(data, { timestamp: i * 33_333, keyframe: i === 0, nalCount: 1 });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(errors, [], '아직 정상');
  dir.faults = { failWritesAfter: 0 }; // 이후 쓰기는 권한 회수처럼 실패
  for (let i = 10; i < 30; i++) writer.addVideoSample(data, { timestamp: i * 33_333, keyframe: false, nalCount: 1 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(errors.length, 1, 'onError 한 번');
  assert.equal(errors[0].name, 'NotAllowedError');
  assert.ok(writer.error);
  assert.equal(writer.addVideoSample(data, { timestamp: 31 * 33_333, keyframe: false, nalCount: 1 }), false, '실패 후 샘플은 받지 않음');
  await assert.rejects(() => writer.finish(), (e) => e.name === 'NotAllowedError');
  assert.equal(errors.length, 1, 'finish에서 다시 부르지 않음');
});

test('DirectMp4Writer: ffprobe가 buildMp4 파일과 같은 패킷 수·길이로 읽고 전체 디코딩 오류가 없다 (픽스처 H.264 + MP3)', { skip: !FFPROBE || !FFMPEG ? 'ffprobe/ffmpeg 없음' : false }, async () => {
  for (const container of ['mp4', 'mov']) {
    const expectedPath = writeOutput(`direct-ref.${container}`, buildMp4({ container, video: fixtureVideo, audio: fixtureAudio, creationTime: CREATION_TIME }));
    const { bytes } = await writeDirect({ container, rawVideo: fixtureVideo.samples, video: fixtureVideo, audio: fixtureAudio, adjust: null });
    const path = writeOutput(`direct.${container}`, [bytes]);
    const info = ffprobe(path);
    const ref = ffprobe(expectedPath);
    const pick = (i) => i.streams.map(s => ({ codec: s.codec_name, frames: Number(s.nb_read_frames), duration: Number(s.duration).toFixed(3) }));
    assert.deepEqual(pick(info), pick(ref), `${container}: 스트림 정보`);
    assert.deepEqual(pick(info).map(s => [s.codec, s.frames]), [['h264', 60], ['mp3', fixtureAudio.frames.length]]);
    assert.equal(Number(info.format.duration).toFixed(2), Number(ref.format.duration).toFixed(2));
    assert.equal(ffmpegDecodeErrors(path), '', `${container}: 디코딩 오류 없음`);
  }
});

test('DirectMp4Writer: 영상 73만 + 오디오 41만 샘플(약 6.8시간 분량)을 기록해도 메모리에는 샘플 인덱스(영상 23 B / 오디오 14 B)만 남는다', async () => {
  class NullSink { constructor() { this.size = 0; } async write(d) { this.size += d.length; } async writeAt() {} async close() { return new Blob([]); } async abort() {} }
  const sink = new NullSink();
  gc(); gc();
  const before = process.memoryUsage();
  const writer = new DirectMp4Writer({ sink, creationTime: CREATION_TIME, audio: { codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000 } });
  await writer.start();
  writer.setVideoConfig({ width: 1280, height: 720, avcC: fixtureVideo.avcC });
  const v = new Uint8Array(300), a = new Uint8Array(418);
  const V = 734_400, A = 411_000;
  let j = 0;
  for (let i = 0; i < V; i++) {
    writer.addVideoSample(v, { timestamp: Math.round(i * 1e6 / 30), keyframe: i % 60 === 0, nalCount: 1 });
    if (j < A && i % 2 === 0) { writer.addAudioFrame(a, { samples: 1152 }); j++; }
    if (i % 5_000 === 0) await new Promise(r => setImmediate(r)); // 쓰기 큐가 따라잡도록
  }
  while (j < A) { writer.addAudioFrame(a, { samples: 1152 }); j++; }
  await new Promise(r => setImmediate(r));
  gc(); gc();
  const recording = process.memoryUsage(); // 녹화 중(중지 직전) 붙잡고 있는 메모리 (쓰레기 제외)
  const result = await writer.finish();
  const indexMB = (writer.videoIndex.bytesUsed + writer.audioIndex.bytesUsed) / 1048576;
  const heldMB = (recording.heapUsed + recording.arrayBuffers - before.heapUsed - before.arrayBuffers) / 1048576;
  const objectsMB = (recording.heapUsed - before.heapUsed) / 1048576;
  assert.equal(sink.size, result.bytes);
  // 샘플마다 객체를 남기면 114만 샘플 × 50 B 이상 ≈ 55 MB 이상. 12 MB 미만이면 샘플당 객체가 없는 것 (V8 힙 자체 변동 수 MB 허용)
  assert.ok(objectsMB < 12, `JS 힙(객체) 증가 ${objectsMB.toFixed(1)} MB - 샘플마다 객체를 남기지 않음`);
  assert.ok(heldMB < indexMB + 8 + 12, `녹화 중 메모리 증가 ${heldMB.toFixed(1)} MB ≤ 인덱스 ${indexMB.toFixed(1)} MB + 8 MB 고정 버퍼 + 여유(V8 힙 변동)`);
});
