import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { VideoTrackEncoder, computeVideoBitrate, VideoRecordingSession, estimateAviSize } from '../video-recorder.js';
import { SampleIndex } from '../storage/sample-index.js';
import v8 from 'node:v8';
import { ContainerAudioEncoder } from '../container-audio-encoder.js';
import { VIDEO_SETTINGS, ERROR_MESSAGES } from '../constants.js';
import { FakeVideoFrame, FakeReader, makeFakeTrackProcessor, makeFakeVideoEncoder, FAKE_AVCC } from './helpers/fakes.js';

vm.runInThisContext(readFileSync(new URL('../lib/lame.min.js', import.meta.url), 'utf8'));
v8.setFlagsFromString('--expose-gc');
const gc = globalThis.gc || vm.runInNewContext('gc');

const FRAME_US = 33_333;
function frames(count, { width = 160, height = 120, start = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => new FakeVideoFrame({ timestamp: start + i * FRAME_US, width, height }));
}

function makeEncoder({ frameList, supported, now, audioStartTime = 0, failOn } = {}) {
  const reader = new FakeReader(frameList);
  const { FakeVideoEncoder, instances } = makeFakeVideoEncoder({ supported, failOn });
  const encoder = new VideoTrackEncoder({
    track: { kind: 'video' },
    deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: now || (() => 0) }
  });
  encoder.setAudioStartTime(audioStartTime);
  return { encoder, reader, FakeVideoEncoder, instances };
}

const tick = () => new Promise(r => setTimeout(r, 5));

test('computeVideoBitrate는 해상도·fps 기반 추정치를 최소/최대 범위로 제한한다', () => {
  assert.equal(computeVideoBitrate(1920, 1080, 30), Math.round(1920 * 1080 * 30 * VIDEO_SETTINGS.BITS_PER_PIXEL_PER_FRAME));
  assert.equal(computeVideoBitrate(160, 120, 30), VIDEO_SETTINGS.MIN_BITRATE);
  assert.equal(computeVideoBitrate(3840, 2160, 60), VIDEO_SETTINGS.MAX_BITRATE);
});

test('VideoTrackEncoder는 후보 코덱을 순서대로 조회해 첫 지원 코덱으로 설정한다', async () => {
  const { encoder, reader, FakeVideoEncoder, instances } = makeEncoder({ frameList: frames(1), supported: ['avc1.4D002A'] });
  await encoder.start();
  await tick();
  assert.deepEqual(FakeVideoEncoder.probes.slice(0, 3), VIDEO_SETTINGS.H264_CODEC_CANDIDATES.slice(0, 3));
  assert.equal(instances[0].config.codec, 'avc1.4D002A');
  assert.equal(instances[0].config.avc.format, 'avc');
  await reader.cancel();
  await encoder.stop();
});

test('VideoTrackEncoder는 지원되는 H.264 코덱이 없으면 명확한 에러를 던진다', async () => {
  const { encoder } = makeEncoder({ frameList: frames(1), supported: [] });
  await assert.rejects(() => encoder.start(), new RegExp(ERROR_MESSAGES.VIDEO_ENCODER_UNSUPPORTED.slice(0, 10)));
});

test('VideoTrackEncoder는 첫 프레임 크기(짝수로 보정)로 인코더를 설정하고 모든 프레임을 close한다', async () => {
  const list = frames(3, { width: 1283, height: 721 });
  const { encoder, instances } = makeEncoder({ frameList: list });
  await encoder.start();
  await tick();
  const result = await encoder.stop();
  assert.equal(instances[0].config.width, 1282);
  assert.equal(instances[0].config.height, 720);
  assert.equal(instances[0].config.bitrate, computeVideoBitrate(1282, 720, VIDEO_SETTINGS.FRAME_RATE));
  assert.ok(list.every(f => f.closed), '모든 프레임이 close되어야 함');
  assert.equal(result.width, 1282);
  assert.equal(result.height, 720);
  assert.equal(result.samples.length, 3);
  assert.deepEqual(Array.from(result.avcC), Array.from(FAKE_AVCC));
  assert.ok(instances[0].flushed && instances[0].closed, 'stop 시 flush/close');
});

test('VideoTrackEncoder는 KEYFRAME_INTERVAL마다 키프레임을 요청하고 샘플에 keyframe 플래그를 남긴다', async () => {
  const count = VIDEO_SETTINGS.KEYFRAME_INTERVAL * 2 + 1;
  const { encoder } = makeEncoder({ frameList: frames(count) });
  await encoder.start();
  await tick();
  const { samples } = await encoder.stop();
  assert.equal(samples.length, count);
  const keyIndexes = samples.map((s, i) => (s.keyframe ? i : -1)).filter(i => i >= 0);
  assert.deepEqual(keyIndexes, [0, VIDEO_SETTINGS.KEYFRAME_INTERVAL, VIDEO_SETTINGS.KEYFRAME_INTERVAL * 2]);
  assert.ok(samples.every(s => s.data instanceof Uint8Array && s.data.length === 6));
});

test('VideoTrackEncoder는 인코더 큐가 밀리면 프레임을 드롭(close)하고 카운트한다', async () => {
  const list = frames(4);
  const { encoder, instances } = makeEncoder({ frameList: list });
  await encoder.start();
  await tick();
  // 2개 처리 후 큐 포화 상태를 흉내 내기 위해 리더에 프레임을 늦게 공급
  const result0 = instances[0];
  result0.encodeQueueSize = VIDEO_SETTINGS.MAX_ENCODE_QUEUE + 1;
  encoder.reader.push(new FakeVideoFrame({ timestamp: 999_999 }));
  await tick();
  result0.encodeQueueSize = 0;
  const { samples } = await encoder.stop();
  assert.equal(samples.length, 4, '큐 포화 중 들어온 1프레임은 드롭');
  assert.equal(encoder.droppedFrames, 1);
  assert.ok(list.every(f => f.closed));
});

test('VideoTrackEncoder는 오디오 시작 시각과 첫 프레임 도착 시각 차이를 두 번째 샘플부터 타임스탬프에 더한다', async () => {
  let clock = 1000;
  const { encoder } = makeEncoder({ frameList: frames(3), now: () => clock, audioStartTime: 850 });
  // 첫 프레임이 읽힐 때 now()=1000 → 오프셋 150ms
  await encoder.start();
  await tick();
  const { samples } = await encoder.stop();
  assert.deepEqual(samples.map(s => s.timestamp), [0, FRAME_US + 150_000, 2 * FRAME_US + 150_000]);
  assert.equal(encoder.alignmentOffsetUs, 150_000);
});

test('VideoTrackEncoder는 트랙이 끝나면(탭 닫힘) 스스로 읽기를 종료하고 stop()이 정상 반환된다', async () => {
  const reader = new FakeReader(frames(2), { endWhenExhausted: true });
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  const encoder = new VideoTrackEncoder({
    track: {}, deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 }
  });
  await encoder.start();
  await tick();
  assert.equal(encoder.ended, true);
  const { samples } = await encoder.stop();
  assert.equal(samples.length, 2);
});

test('VideoTrackEncoder는 인코더 에러를 stop()에서 전달한다', async () => {
  const { encoder } = makeEncoder({ frameList: frames(3), failOn: 1 });
  await encoder.start();
  await tick();
  await assert.rejects(() => encoder.stop(), /가짜 인코더 오류/);
});

test('ContainerAudioEncoder는 Float32 PCM을 MP3 프레임(1152 샘플)으로 인코딩한다', async () => {
  const enc = new ContainerAudioEncoder({ sampleRate: 44100, channels: 2, bitrateKbps: 128 });
  enc.start();
  const l = new Float32Array(4096).map((_, i) => Math.sin(i / 7) * 0.5);
  const r = new Float32Array(4096).map((_, i) => Math.cos(i / 7) * 0.5);
  for (let i = 0; i < 12; i++) enc.processChunk(l, r);
  const audio = await enc.finish();
  assert.equal(audio.codec, 'mp3');
  assert.equal(audio.sampleRate, 44100);
  assert.equal(audio.channels, 2);
  assert.equal(audio.bitrate, 128000);
  const expectedFrames = Math.floor(12 * 4096 / 1152);
  assert.ok(audio.frames.length >= expectedFrames && audio.frames.length <= expectedFrames + 2, `frames=${audio.frames.length}`);
  assert.ok(audio.frames.every(f => f.samples === 1152));
  assert.equal(enc.totalSamples, 12 * 4096);
});

test('ContainerAudioEncoder는 start 전/finish 후 processChunk를 무시한다', () => {
  const enc = new ContainerAudioEncoder({ sampleRate: 44100, channels: 2, bitrateKbps: 128 });
  enc.processChunk(new Float32Array(10), new Float32Array(10));
  assert.equal(enc.totalSamples, 0);
});

for (const format of ['mp4', 'mov', 'avi']) {
  test(`VideoRecordingSession(${format})은 영상+오디오를 머싱해 올바른 시그니처의 Blob을 반환한다`, async () => {
    const reader = new FakeReader(frames(10));
    const { FakeVideoEncoder } = makeFakeVideoEncoder();
    const session = new VideoRecordingSession({
      format,
      videoTrack: {},
      sampleRate: 44100,
      bitrateKbps: 128,
      deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 }
    });
    await session.start();
    session.setAudioStartTime(0);
    const l = new Float32Array(4096).fill(0.1), r = new Float32Array(4096).fill(-0.1);
    for (let i = 0; i < 6; i++) session.pushAudio(l, r);
    await tick();
    const blob = await session.stop();
    assert.ok(blob instanceof Blob);
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const ascii = (a, b) => String.fromCharCode(...head.subarray(a, b));
    if (format === 'avi') {
      assert.equal(ascii(0, 4), 'RIFF');
      assert.equal(ascii(8, 12), 'AVI ');
      assert.equal(blob.type, 'video/x-msvideo');
    } else {
      assert.equal(ascii(4, 8), 'ftyp');
      assert.equal(ascii(8, 12), format === 'mov' ? 'qt  ' : 'isom');
      assert.equal(blob.type, format === 'mov' ? 'video/quicktime' : 'video/mp4');
    }
    assert.equal(session.stats.videoFrames, 10);
    assert.ok(session.stats.audioFrames > 0);
  });
}

test('VideoRecordingSession은 영상 프레임이 하나도 없으면 NO_VIDEO 에러를 던진다', async () => {
  const reader = new FakeReader([]);
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  const session = new VideoRecordingSession({
    format: 'mp4', videoTrack: {}, sampleRate: 44100, bitrateKbps: 128,
    deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 }
  });
  await session.start();
  await assert.rejects(() => session.stop(), new RegExp(ERROR_MESSAGES.NO_VIDEO.slice(0, 8)));
});

test('VideoRecordingSession은 지원하지 않는 포맷을 거부한다', () => {
  assert.throws(() => new VideoRecordingSession({ format: 'mkv', videoTrack: {}, sampleRate: 44100, bitrateKbps: 128, deps: {} }), /영상 포맷/);
});

test('VideoTrackEncoder는 latencyMode realtime으로 설정한다 (실시간 캡처, B-프레임 재정렬 회피)', async () => {
  const { encoder, instances } = makeEncoder({ frameList: frames(2) });
  await encoder.start();
  await tick();
  await encoder.stop();
  assert.equal(instances[0].config.latencyMode, 'realtime');
});

test('VideoTrackEncoder는 타임스탬프가 역행하는 청크를 받으면 stop()에서 에러를 낸다', async () => {
  const list = [new FakeVideoFrame({ timestamp: 0 }), new FakeVideoFrame({ timestamp: 66_666 }), new FakeVideoFrame({ timestamp: 33_333 })];
  const { encoder } = makeEncoder({ frameList: list });
  await encoder.start();
  await tick();
  await assert.rejects(() => encoder.stop(), /타임스탬프/);
});

test('VideoTrackEncoder는 설정 크기와 다른 프레임을 캔버스에 레터박스로 그려 정규화한 뒤 인코딩한다', async () => {
  const list = [new FakeVideoFrame({ timestamp: 0, width: 1280, height: 720 }), new FakeVideoFrame({ timestamp: 33_333, width: 640, height: 480 })];
  const drawn = [];
  const createdFrames = [];
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { fillRect: () => {}, drawImage: (img, x, y, w, h) => drawn.push({ src: [img.displayWidth, img.displayHeight], x, y, w, h }), fillStyle: '' }; }
  }
  class FakeVideoFrameCtor {
    constructor(canvas, init) { this.timestamp = init.timestamp; this.displayWidth = canvas.width; this.displayHeight = canvas.height; this.codedWidth = canvas.width; this.codedHeight = canvas.height; this.closed = false; createdFrames.push(this); }
    close() { this.closed = true; }
  }
  const reader = new FakeReader(list);
  const { FakeVideoEncoder, instances } = makeFakeVideoEncoder();
  const encoder = new VideoTrackEncoder({
    track: {},
    deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0, OffscreenCanvas: FakeCanvas, VideoFrame: FakeVideoFrameCtor }
  });
  await encoder.start();
  await tick();
  const { samples } = await encoder.stop();
  assert.equal(samples.length, 2);
  assert.equal(drawn.length, 1, '크기가 다른 두 번째 프레임만 정규화');
  // 640x480(4:3) → 1280x720 레터박스: 높이 720, 폭 960, 좌우 160 여백
  assert.deepEqual(drawn[0], { src: [640, 480], x: 160, y: 0, w: 960, h: 720 });
  assert.equal(createdFrames.length, 1);
  assert.equal(createdFrames[0].timestamp, 33_333, '원본 타임스탬프 유지');
  assert.ok(createdFrames[0].closed && list.every(f => f.closed));
  assert.equal(instances[0].encoded[1].timestamp, 33_333);
  assert.equal(encoder.normalizedFrames, 1);
});

test('VideoTrackEncoder는 가로세로 비율이 같은 크기 변화는 정규화하지 않고 인코더 스케일링에 맡긴다 (메모리 절약)', async () => {
  const list = [new FakeVideoFrame({ timestamp: 0, width: 1280, height: 720 }), new FakeVideoFrame({ timestamp: 33_333, width: 960, height: 540 })];
  let drawCalls = 0;
  class FakeCanvas { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { fillRect() {}, drawImage() { drawCalls++; }, fillStyle: '' }; } }
  class FakeVideoFrameCtor { constructor(canvas, init) { this.timestamp = init.timestamp; this.displayWidth = canvas.width; this.displayHeight = canvas.height; } close() {} }
  const reader = new FakeReader(list);
  const { FakeVideoEncoder, instances } = makeFakeVideoEncoder();
  const encoder = new VideoTrackEncoder({ track: {}, deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0, OffscreenCanvas: FakeCanvas, VideoFrame: FakeVideoFrameCtor } });
  await encoder.start();
  await tick();
  const { samples } = await encoder.stop();
  assert.equal(samples.length, 2);
  assert.equal(drawCalls, 0, '같은 비율이면 캔버스를 쓰지 않음');
  assert.equal(encoder.normalizedFrames, 0);
  assert.equal(encoder.scaledFrames, 1, '인코더 스케일링에 맡긴 프레임 수');
  assert.equal(instances[0].encoded[1].timestamp, 33_333);
});

// ---- 디스크 저장소(ChunkStore) 연동 ----
import { MemoryChunkStore, createRecordingStorage } from '../storage/chunk-store.js';

class CountingStore {
  constructor() { this.size = 0; this.appends = 0; this.finalized = false; this.retainedBytes = 0; }
  get kind() { return 'counting'; }
  append(data) { const ref = { offset: this.size, size: data.length }; this.size += data.length; this.appends++; return ref; }
  async flush() {}
  async finalize() { this.finalized = true; }
  async readRange() { throw new Error('not needed'); }
  async slice() { throw new Error('not needed'); }
  async dispose() {}
}

test('VideoTrackEncoder는 chunkStore가 주어지면 청크 데이터를 저장소에 넘기고 메타데이터는 샘플 객체 없이 SampleIndex(typed array)에 보관한다', async () => {
  const store = new CountingStore();
  const reader = new FakeReader(frames(5));
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  const encoder = new VideoTrackEncoder({ track: {}, chunkStore: store, deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 } });
  await encoder.start();
  await tick();
  const result = await encoder.stop();
  assert.equal(result.samples, undefined, '저장소 경로는 샘플 객체 배열을 만들지 않음');
  assert.ok(result.index instanceof SampleIndex);
  assert.equal(result.index.kind, 'video');
  assert.equal(result.index.length, 5);
  const idx = [0, 1, 2, 3, 4];
  assert.deepEqual(idx.map(i => result.index.offsetAt(i)), [0, 6, 12, 18, 24]);
  assert.ok(idx.every(i => result.index.sizeAt(i) === 6));
  assert.ok(idx.every(i => result.index.nalCountAt(i) === 1), '가짜 청크는 NAL 1개');
  assert.deepEqual(idx.map(i => result.timestampAt(i)), idx.map(i => i * FRAME_US), '출력 타임스탬프 접근자');
  assert.equal(result.index.keyframeAt(0), true);
  assert.equal(store.appends, 5);
  assert.equal(store.finalized, true, 'stop 시 저장소 finalize');
  assert.equal(result.store, store);
  assert.equal(encoder.retainedBytes, 0, '인코더가 청크 데이터를 보유하지 않음');
  assert.equal(encoder.sampleCount, 5);
});

test('VideoTrackEncoder(chunkStore)도 A/V 정렬 오프셋을 두 번째 샘플부터 적용한다 (인덱스는 원본 타임스탬프 그대로, 접근자로 보정)', async () => {
  let clock = 1000;
  const store = new CountingStore();
  const reader = new FakeReader(frames(3, { start: 5_000_000 }));
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  const encoder = new VideoTrackEncoder({ track: {}, chunkStore: store, deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => clock } });
  encoder.setAudioStartTime(850);
  await encoder.start();
  await tick();
  const result = await encoder.stop();
  assert.deepEqual([0, 1, 2].map(i => result.timestampAt(i)), [0, FRAME_US + 150_000, 2 * FRAME_US + 150_000]);
  assert.equal(result.index.timestampAt(1), 5_000_000 + FRAME_US, '인덱스에는 원본(일시정지 보정만 한) 타임스탬프');
});

test('VideoTrackEncoder는 저장소 없이 쓰면 기존처럼 data를 보관한다 (호환)', async () => {
  const { encoder } = makeEncoder({ frameList: frames(2) });
  await encoder.start();
  await tick();
  const { samples } = await encoder.stop();
  assert.ok(samples.every(s => s.data instanceof Uint8Array && !s.ref));
  assert.equal(encoder.retainedBytes, 12);
});

test('ContainerAudioEncoder는 chunkStore가 주어지면 MP3 프레임을 저장소에 넘기고 프레임 메타데이터는 SampleIndex에만 둔다', async () => {
  const store = new MemoryChunkStore();
  const enc = new ContainerAudioEncoder({ sampleRate: 44100, channels: 2, bitrateKbps: 128, chunkStore: store });
  enc.start();
  const l = new Float32Array(4096).fill(0.1), r = new Float32Array(4096).fill(-0.1);
  for (let i = 0; i < 6; i++) enc.processChunk(l, r);
  const audio = await enc.finish();
  assert.equal(audio.frames, undefined, '저장소 경로는 프레임 객체 배열을 만들지 않음');
  assert.ok(audio.index instanceof SampleIndex);
  assert.equal(audio.index.kind, 'audio');
  assert.ok(audio.index.length > 10);
  for (let i = 0; i < audio.index.length; i++) assert.equal(audio.index.samplesAt(i), 1152);
  assert.equal(audio.store, store);
  assert.equal(store.finalized, true);
  assert.equal(audio.index.totalBytes, store.size, '모든 프레임 바이트가 저장소에 연속으로');
  const first = await store.readRange(audio.index.offsetAt(0), 2);
  assert.equal(first[0], 0xFF, 'MP3 프레임 싱크');
});

test('estimateAviSize는 배열 형식과 SampleIndex 형식에서 같은 값을 준다 (AVI 2GB 한계 판단)', () => {
  const vIndex = new SampleIndex({ kind: 'video' });
  const aIndex = new SampleIndex({ kind: 'audio' });
  const samples = [], frames = [];
  for (let i = 0; i < 50; i++) { vIndex.push(i * 100, 100 + i, i * FRAME_US, i % 10 === 0, 1); samples.push({ ref: { offset: i * 100, size: 100 + i }, timestamp: i * FRAME_US, keyframe: i % 10 === 0, nalCount: 1 }); }
  for (let i = 0; i < 70; i++) { aIndex.pushFrame(i * 418, 418, 1152); frames.push({ ref: { offset: i * 418, size: 418 }, samples: 1152 }); }
  const expected = samples.reduce((s, x) => s + x.ref.size + 40, 0) + frames.reduce((s, f) => s + f.ref.size + 24, 0);
  assert.equal(estimateAviSize({ samples }, { frames }), expected);
  assert.equal(estimateAviSize({ index: vIndex }, { index: aIndex }), expected);
  assert.equal(estimateAviSize({ index: vIndex }, null), samples.reduce((s, x) => s + x.ref.size + 40, 0));
});

for (const format of ['mp4', 'mov', 'avi']) {
  test(`VideoRecordingSession(${format})은 storage가 주어지면 저장소 참조로 스트리밍 머싱해 올바른 파일을 만든다`, async () => {
    const storage = await createRecordingStorage(null, 'sess');
    const reader = new FakeReader(frames(10));
    const { FakeVideoEncoder } = makeFakeVideoEncoder();
    const session = new VideoRecordingSession({ format, videoTrack: {}, sampleRate: 44100, bitrateKbps: 128, storage, deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 } });
    await session.start();
    const l = new Float32Array(4096).fill(0.1), r = new Float32Array(4096).fill(-0.1);
    for (let i = 0; i < 6; i++) session.pushAudio(l, r);
    await tick();
    const blob = await session.stop();
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const ascii = (a, b) => String.fromCharCode(...head.subarray(a, b));
    if (format === 'avi') assert.equal(ascii(8, 12), 'AVI ');
    else assert.equal(ascii(4, 8), 'ftyp');
    assert.equal(session.stats.bytes, blob.size);
    assert.equal(session.videoEncoder.retainedBytes, 0, '영상 청크를 메모리에 보유하지 않음');
    assert.equal(session.stats.videoFrames, 10, 'SampleIndex 경로 샘플 수');
    assert.ok(session.stats.audioFrames > 10, `오디오 프레임 ${session.stats.audioFrames}`);
    if (format === 'avi') {
      assert.ok(session.videoEncoder.index instanceof SampleIndex && session.audioEncoder.index instanceof SampleIndex, 'AVI: 청크 저장소 + SampleIndex 경로');
    } else {
      assert.ok(session.writer.videoIndex instanceof SampleIndex && session.writer.audioIndex instanceof SampleIndex, `${format}: 직접 기록 + 결과 파일 위치를 담은 SampleIndex`);
      assert.equal(session.videoEncoder.index, null, '인코더는 인덱스를 따로 두지 않음');
    }
  });
}

test('VideoTrackEncoder(chunkStore)는 장시간(약 55분 분량) 청크를 밀어 넣어도 메모리 보유량이 typed array 메타데이터(샘플당 23바이트) 수준에 머문다', async () => {
  // 가짜 인코더가 1080p 수준(25KB) 청크를 100,000개(약 55분×30fps, 2.5GB 상당) 내도록 하되, 저장소는 바이트를 세기만 함
  const store = new CountingStore();
  const frameCount = 100_000;
  const bigChunk = new Uint8Array(25_000);
  class BigEncoder {
    static async isConfigSupported(c) { return { supported: true, config: c }; }
    constructor({ output }) { this.output = output; this.encodeQueueSize = 0; this.state = 'unconfigured'; this.n = 0; }
    configure() { this.state = 'configured'; }
    encode(frame, opts) { const key = !!opts.keyFrame; const meta = this.n === 0 ? { decoderConfig: { description: FAKE_AVCC } } : {}; this.n++; this.output({ type: key ? 'key' : 'delta', timestamp: frame.timestamp, byteLength: bigChunk.length, copyTo: (d) => d.set(bigChunk) }, meta); }
    async flush() {} close() { this.state = 'closed'; }
  }
  // 리더: 프레임을 즉시 생성(메모리에 쌓지 않음)
  let produced = 0;
  const reader = { read: async () => (produced < frameCount ? { done: false, value: new FakeVideoFrame({ timestamp: produced++ * 33_333 }) } : { done: true }), cancel: async () => {} };
  const encoder = new VideoTrackEncoder({ track: {}, chunkStore: store, deps: { VideoEncoder: BigEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 } });
  gc(); gc();
  const before = process.memoryUsage();
  await encoder.start();
  // 읽기 루프가 끝날 때까지 대기
  while (!encoder.ended) await new Promise(r => setTimeout(r, 20));
  const result = await encoder.stop();
  gc(); gc();
  const after = process.memoryUsage();
  assert.equal(result.index.length, frameCount);
  assert.equal(store.size, frameCount * 25_000, '약 2.5GB가 저장소로 전달됨');
  assert.equal(encoder.retainedBytes, 0);
  const heapMB = (after.heapUsed - before.heapUsed) / 1048576;
  const totalMB = (after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers) / 1048576;
  const indexMB = result.index.bytesUsed / 1048576;
  assert.ok(heapMB < 3, `JS 힙(객체) 증가 ${heapMB.toFixed(1)} MB - 샘플 객체를 만들지 않아야 함 (이전 방식 약 8 MB)`);
  assert.ok(totalMB < indexMB + 4, `전체 증가 ${totalMB.toFixed(1)} MB ≈ 인덱스 ${indexMB.toFixed(1)} MB`);
});

// ---- 일시정지 / 재개 ----
import { parseBoxes, findBox, readStts, parseRiff, readFragments } from './helpers/media.js';

test('VideoTrackEncoder는 일시정지 중 읽은 프레임을 인코딩하지 않고 닫으며(pausedFrames, 드롭 아님), 재개 후 타임스탬프를 끊김 없이 이어 붙이고 첫 프레임을 키프레임으로 만든다', async () => {
  const before = [0, 33_333, 66_666].map(t => new FakeVideoFrame({ timestamp: t }));
  const during = Array.from({ length: 13 }, (_, k) => new FakeVideoFrame({ timestamp: Math.round(100_000 + k * 100_000 / 3) })); // 100000 … 500000
  const after = [533_333, 566_666].map(t => new FakeVideoFrame({ timestamp: t }));
  const { encoder, reader, instances } = makeEncoder({ frameList: before });
  await encoder.start();
  await tick();
  encoder.pause();
  assert.equal(encoder.paused, true);
  during.forEach(f => reader.push(f));
  await tick();
  encoder.resume();
  assert.equal(encoder.paused, false);
  after.forEach(f => reader.push(f));
  await tick();
  const { samples } = await encoder.stop();

  assert.equal(during.at(-1).timestamp, 500_000);
  assert.equal(samples.length, 5, '일시정지 중 프레임은 출력에 없음');
  const expected = [0, 33_333, 66_666, 100_000, 133_333];
  samples.forEach((s, i) => assert.ok(Math.abs(s.timestamp - expected[i]) <= 2, `#${i}: ${s.timestamp} ≈ ${expected[i]} (${samples.map(x => x.timestamp)})`));
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i].timestamp > samples[i - 1].timestamp, '타임스탬프는 엄격히 증가');
  assert.equal(samples[3].keyframe, true, '재개 후 첫 프레임은 키프레임');
  assert.equal(instances[0].encoded[3].key, true, '인코더에 keyFrame 요청');
  assert.equal(samples[4].keyframe, false);
  assert.equal(instances[0].encoded.length, 5, '일시정지 중 프레임은 인코더에 넘기지 않음');
  assert.equal(encoder.pausedFrames, 13);
  assert.equal(encoder.droppedFrames, 0, '일시정지로 버린 프레임은 드롭으로 세지 않음');
  assert.ok([...before, ...during, ...after].every(f => f.closed), '모든 프레임 close');
});

test('VideoTrackEncoder는 정적인 화면이라 프레임 간격으로 잰 일시정지가 실제(벽시계) 일시정지보다 훨씬 길면 실제 일시정지 + 1프레임만 빼서 A/V 싱크를 지킨다', async () => {
  let clock = 0;
  const { encoder, reader } = makeEncoder({ frameList: [new FakeVideoFrame({ timestamp: 0 }), new FakeVideoFrame({ timestamp: FRAME_US })], now: () => clock });
  await encoder.start();
  await tick();
  clock = 2_000; // 마지막 프레임 이후 약 2초간 화면 변화 없음
  encoder.pause();
  clock = 5_000; // 3초 일시정지 (오디오도 3초만 빠짐)
  encoder.resume();
  reader.push(new FakeVideoFrame({ timestamp: 9_000_000 })); // 재개 4초 뒤에야 화면이 바뀜
  reader.push(new FakeVideoFrame({ timestamp: 9_000_000 + FRAME_US }));
  await tick();
  const { samples } = await encoder.stop();
  assert.equal(samples.length, 4);
  // 9초에 캡처된 프레임은 녹화 시간 축(일시정지 3초 제외)에서 약 6초 위치여야 함.
  // 프레임 간격만으로 이어 붙이면 약 0.07초로 당겨져 오디오와 6초 가까이 어긋남
  assert.ok(Math.abs(samples[2].timestamp - 6_000_000) <= FRAME_US + 1, `재개 후 첫 프레임 ${samples[2].timestamp}`);
  assert.equal(samples[3].timestamp - samples[2].timestamp, FRAME_US);
  assert.equal(samples[2].keyframe, true);
});

test('VideoTrackEncoder는 첫 프레임이 오기 전에 일시정지했다면 그 시간을 A/V 정렬 오프셋에서 뺀다 (그동안 오디오도 버려짐)', async () => {
  let clock = 1_000;
  const reader = new FakeReader([]);
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  const encoder = new VideoTrackEncoder({ track: {}, deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => clock } });
  encoder.setAudioStartTime(900); // 오디오는 첫 일시정지 100ms 전에 시작
  await encoder.start();
  encoder.pause();               // clock 1000
  clock = 3_000;                 // 2초 일시정지
  encoder.resume();
  clock = 3_050;                 // 재개 50ms 뒤 첫 프레임 도착 → 녹화 시간 축으로는 150ms
  reader.push(new FakeVideoFrame({ timestamp: 5_000_000 }));
  reader.push(new FakeVideoFrame({ timestamp: 5_000_000 + FRAME_US }));
  await tick();
  const { samples } = await encoder.stop();
  assert.equal(encoder.alignmentOffsetUs, 150_000);
  assert.deepEqual(samples.map(s => s.timestamp), [0, FRAME_US + 150_000]);
});

test('VideoTrackEncoder는 여러 번 일시정지해도 누적 보정으로 타임스탬프를 끊김 없이 이어 붙인다', async () => {
  let clock = 0;
  const { encoder, reader } = makeEncoder({ frameList: [new FakeVideoFrame({ timestamp: 0 }), new FakeVideoFrame({ timestamp: 33_333 })], now: () => clock });
  await encoder.start();
  await tick();
  const pauseCycle = async (pauseAtMs, resumeAtMs, discarded, resumed) => {
    clock = pauseAtMs;
    encoder.pause();
    discarded.forEach(t => reader.push(new FakeVideoFrame({ timestamp: t })));
    await tick();
    clock = resumeAtMs;
    encoder.resume();
    resumed.forEach(t => reader.push(new FakeVideoFrame({ timestamp: t })));
    await tick();
  };
  await pauseCycle(50, 990, [66_666, 500_000, 966_666], [1_000_000, 1_033_333]);
  await pauseCycle(1_050, 2_990, [1_066_666, 2_966_666], [3_000_000, 3_033_333]);
  const { samples } = await encoder.stop();
  const expected = [0, 33_333, 66_666, 100_000, 133_333, 166_666];
  assert.equal(samples.length, expected.length);
  samples.forEach((s, i) => assert.ok(Math.abs(s.timestamp - expected[i]) <= 3, `#${i}: ${s.timestamp} ≈ ${expected[i]}`));
  assert.deepEqual(samples.map((s, i) => (s.keyframe ? i : -1)).filter(i => i >= 0), [0, 2, 4], '재개 직후 프레임마다 키프레임');
  assert.equal(encoder.pausedFrames, 5);
});

test('VideoTrackEncoder는 일시정지 상태에서 stop()해도 일시정지 전 프레임으로 정상 마무리한다', async () => {
  const { encoder, reader } = makeEncoder({ frameList: frames(3) });
  await encoder.start();
  await tick();
  encoder.pause();
  reader.push(new FakeVideoFrame({ timestamp: 200_000 }));
  await tick();
  const result = await encoder.stop();
  assert.deepEqual(result.samples.map(s => s.timestamp), [0, FRAME_US, 2 * FRAME_US]);
  assert.equal(encoder.pausedFrames, 1);
});

test('VideoTrackEncoder의 pause()/resume()은 중복 호출해도 안전하고, 일시정지 없이 resume()만 부르면 아무 영향이 없다', async () => {
  const { encoder, reader } = makeEncoder({ frameList: frames(2) });
  await encoder.start();
  await tick();
  encoder.resume(); // 일시정지 상태가 아님 → 무시
  reader.push(new FakeVideoFrame({ timestamp: 2 * FRAME_US }));
  await tick();
  encoder.pause();
  encoder.pause();
  assert.equal(encoder.paused, true);
  encoder.resume();
  encoder.resume();
  assert.equal(encoder.paused, false);
  reader.push(new FakeVideoFrame({ timestamp: 3 * FRAME_US }));
  await tick();
  const { samples } = await encoder.stop();
  assert.deepEqual(samples.map(s => s.timestamp), [0, FRAME_US, 2 * FRAME_US, 3 * FRAME_US]);
  assert.deepEqual(samples.map(s => s.keyframe), [true, false, false, true], '불필요한 키프레임은 없고 재개 직후만 키프레임');
});

for (const format of ['mp4', 'mov', 'avi', 'fmp4']) {
  test(`VideoRecordingSession(${format}).pause()/resume()은 영상 인코더를 일시정지/재개하고, 결과 파일에 일시정지 구간이 남지 않는다`, async () => {
    const reader = new FakeReader(frames(3));
    const { FakeVideoEncoder } = makeFakeVideoEncoder();
    const session = new VideoRecordingSession({
      format, videoTrack: {}, sampleRate: 44100, bitrateKbps: 128,
      deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 }
    });
    await session.start();
    const l = new Float32Array(4096).fill(0.1), r = new Float32Array(4096).fill(-0.1);
    for (let i = 0; i < 4; i++) session.pushAudio(l, r);
    await tick();
    session.pause();
    assert.equal(session.paused, true);
    for (let i = 3; i < 60; i++) reader.push(new FakeVideoFrame({ timestamp: i * FRAME_US })); // 약 2초 분량 버림
    await tick();
    session.resume();
    assert.equal(session.paused, false);
    for (let i = 60; i < 62; i++) reader.push(new FakeVideoFrame({ timestamp: i * FRAME_US }));
    await tick();
    for (let i = 0; i < 2; i++) session.pushAudio(l, r); // 오디오 6 × 4096 샘플 ≈ 0.56초
    const blob = await session.stop();
    assert.equal(session.stats.videoFrames, 5);
    assert.equal(session.stats.pausedFrames, 57);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    if (format === 'avi') {
      // AVI는 30fps 고정 슬롯: 일시정지 구간이 남으면 약 2초(60슬롯)가 빈 슬롯으로 채워짐. 이어 붙였다면 오디오 길이(약 17슬롯) 수준
      const hdrl = parseRiff(bytes)[0].children.find(c => c.listType === 'hdrl');
      const avih = hdrl.children.find(c => c.id === 'avih');
      const totalFrames = new DataView(avih.payload.buffer, avih.payload.byteOffset).getUint32(16, true);
      assert.ok(totalFrames <= Math.ceil(6 * 4096 / 44100 * 30) + 2, `AVI 총 슬롯 ${totalFrames}`);
    } else if (format === 'fmp4') {
      // 조각 MP4: 재개 후 첫 프레임(키프레임)에서 새 조각. 조각을 이어 붙인 샘플 길이에 일시정지 구간이 없고 tfdt가 끊기지 않음
      const frags = readFragments(bytes);
      const samples = frags.flatMap(f => (f.tracks[1] ? f.tracks[1].samples : []));
      assert.equal(samples.length, 5);
      assert.ok(samples.slice(0, -1).every(x => Math.abs(x.duration - 3000) <= 1), `trun 간격: ${samples.map(x => x.duration)}`);
      let base = 0;
      for (const f of frags) {
        if (!f.tracks[1]) continue;
        assert.equal(f.tracks[1].baseTime, base, `조각 #${f.sequence} tfdt 연속`);
        base += f.tracks[1].samples.reduce((n, x) => n + x.duration, 0);
      }
      assert.equal(frags[1].tracks[1].samples[0].flags, 0x02000000, '재개 지점 조각은 키프레임으로 시작');
    } else {
      const moov = findBox(parseBoxes(bytes), 'moov');
      const videoTrak = moov.children.filter(b => b.type === 'trak')[0];
      const deltas = readStts(findBox(videoTrak.children, 'mdia/minf/stbl').children).flatMap(e => Array(e.count).fill(e.delta));
      assert.equal(deltas.length, 5);
      // 마지막 프레임은 오디오 끝까지 늘어나므로 제외하고, 나머지 간격은 모두 약 1프레임(90kHz 기준 3000)
      assert.ok(deltas.slice(0, -1).every(d => Math.abs(d - 3000) <= 1), `stts 간격: ${deltas}`);
    }
  });
}

// ---- 결과 파일 직접 기록 (사용자가 고른 폴더) ----
import { FakeDirectoryHandle } from './helpers/fake-opfs.js';
import { DirectoryFileSink } from '../storage/chunk-store.js';

async function recordSession({ format = 'mp4', storage = null, outputSinkFactory } = {}) {
  const reader = new FakeReader(frames(10));
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  const session = new VideoRecordingSession({
    format, videoTrack: {}, sampleRate: 44100, bitrateKbps: 128, storage, outputSinkFactory,
    deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 }
  });
  await session.start();
  const l = new Float32Array(4096).fill(0.1), r = new Float32Array(4096).fill(-0.1);
  for (let i = 0; i < 6; i++) session.pushAudio(l, r);
  await tick();
  return session;
}
const fileBytes = async (dir, name) => new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
const sessionFiles = async (root, sessionId) => {
  const base = await root.getDirectoryHandle('recorda-recordings');
  const dir = await base.getDirectoryHandle(sessionId);
  return dir.fileNames();
};

for (const format of ['mp4', 'avi']) {
  test(`VideoRecordingSession(${format})은 outputSinkFactory가 주어지면 결과 파일을 저장소(OPFS) 대신 그 싱크(사용자 폴더)에 직접 기록한다 (OPFS 출력 사본 없음)`, async () => {
    const opfsRoot = new FakeDirectoryHandle();
    const storage = await createRecordingStorage({ getDirectory: async () => opfsRoot }, 'direct-1');
    const userDir = new FakeDirectoryHandle('Recordings');
    const calls = [];
    const session = await recordSession({
      format,
      storage,
      outputSinkFactory: async (fmt, mimeType) => { calls.push([fmt, mimeType]); return new DirectoryFileSink(userDir, `recorda_x.${fmt}`, mimeType); }
    });
    const blob = await session.stop();
    assert.deepEqual(calls, [[format, format === 'avi' ? 'video/x-msvideo' : 'video/mp4']], '실제 출력 포맷과 MIME으로 한 번 요청');
    assert.equal(session.outputTarget, 'custom');
    assert.equal(session.outputError, null);
    assert.deepEqual(userDir.fileNames(), [`recorda_x.${format}`]);
    const written = await fileBytes(userDir, `recorda_x.${format}`);
    assert.equal(written.length, blob.size);
    const ascii = (a, b) => String.fromCharCode(...written.subarray(a, b));
    if (format === 'avi') assert.equal(ascii(8, 12), 'AVI '); else assert.equal(ascii(4, 8), 'ftyp');
    const opfsNames = await sessionFiles(opfsRoot, 'direct-1');
    if (format === 'avi') assert.ok(opfsNames.includes('video.bin'), `AVI: 청크 저장소는 OPFS에: ${opfsNames}`);
    else assert.ok(!opfsNames.includes('video.bin') && !opfsNames.includes('container-audio.bin'), `MP4: 영상 데이터는 OPFS를 거치지 않음 (청크 저장소 없음): ${opfsNames}`);
    assert.ok(!opfsNames.includes(`video.${format}`), `OPFS 세션에는 결과 파일을 만들지 않음: ${opfsNames}`);
  });
}

test('VideoRecordingSession은 outputSinkFactory가 실패하면(권한 없음 등) 저장소 싱크로 머싱하고 outputError에 원인을 남긴다', async () => {
  const opfsRoot = new FakeDirectoryHandle();
  const storage = await createRecordingStorage({ getDirectory: async () => opfsRoot }, 'direct-2');
  const session = await recordSession({ storage, outputSinkFactory: async () => { throw new DOMException('denied', 'NotAllowedError'); } });
  const blob = await session.stop();
  assert.equal(session.outputTarget, 'opfs');
  assert.match(String(session.outputError && session.outputError.message), /denied/);
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  assert.equal(String.fromCharCode(...head.subarray(4, 8)), 'ftyp');
  assert.ok((await sessionFiles(opfsRoot, 'direct-2')).includes('video.mp4'), '폴백: OPFS 결과 파일 (다운로드용)');
});

test('VideoRecordingSession(avi)은 사용자 폴더에 머싱하던 중 쓰기가 실패하면 그 파일을 지우고 저장소 싱크로 다시 머싱해 온전한 파일을 만든다 (청크 저장소가 남아 있음)', async () => {
  const userDir = new FakeDirectoryHandle('Recordings');
  userDir.faults = { failWritesAfter: 0 };
  const session = await recordSession({ format: 'avi', outputSinkFactory: async (fmt, mimeType) => new DirectoryFileSink(userDir, `recorda_y.${fmt}`, mimeType) });
  const blob = await session.stop();
  assert.equal(session.outputTarget, 'memory');
  assert.ok(session.outputError);
  assert.deepEqual(userDir.fileNames(), [], '실패한 사용자 폴더 파일 정리');
  assert.equal(session.stats.bytes, blob.size);
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  assert.equal(String.fromCharCode(...head.subarray(8, 12)), 'AVI ');
});

test('VideoRecordingSession은 outputSinkFactory가 null을 돌려주면(이번 녹화는 폴더 저장 안 함) 오류 없이 저장소 싱크를 쓴다', async () => {
  const session = await recordSession({ outputSinkFactory: async () => null });
  const blob = await session.stop();
  assert.ok(blob.size > 0);
  assert.equal(session.outputTarget, 'memory');
  assert.equal(session.outputError, null);
});

// ---- 녹화 중 최종 파일 직접 기록 (MP4/MOV: DirectMp4Writer, fMP4: FragmentedMp4Writer) ----
// 중지 시 청크 저장소 → 최종 파일 복사를 없앰. AVI만 기존 청크 저장소 + 중지 시 머싱 경로를 유지
import { MemoryFileSink } from '../storage/chunk-store.js';

/** 영상 샘플 싱크(작성기) 흉내: 호출 기록 */
class RecordingSampleSink {
  constructor() { this.calls = []; }
  setVideoConfig(config) { this.calls.push(['config', config]); }
  addVideoSample(bytes, info) { this.calls.push(['video', bytes.length, { ...info }]); return true; }
  addAudioFrame(bytes, info) { this.calls.push(['audio', bytes.length, { ...info }]); return true; }
}

test('VideoTrackEncoder는 sampleSink가 주어지면 첫 키프레임에서 영상 설정(크기·avcC)을 한 번 넘기고, 샘플은 원본 타임스탬프로 도착 순서대로 넘긴다 (인코더는 샘플 배열·인덱스를 두지 않음)', async () => {
  const sink = new RecordingSampleSink();
  const reader = new FakeReader(frames(3, { start: 5_000_000 }));
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  let clock = 1000;
  const encoder = new VideoTrackEncoder({ track: {}, sampleSink: sink, deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => clock } });
  encoder.setAudioStartTime(850);
  await encoder.start();
  await tick();
  const track = await encoder.stop();
  assert.deepEqual(sink.calls[0], ['config', { width: 160, height: 120, avcC: FAKE_AVCC }], '첫 샘플보다 먼저 영상 설정');
  assert.equal(sink.calls.filter(c => c[0] === 'config').length, 1);
  const videoCalls = sink.calls.filter(c => c[0] === 'video');
  assert.deepEqual(videoCalls.map(c => c[2].timestamp), [5_000_000, 5_000_000 + FRAME_US, 5_000_000 + 2 * FRAME_US], '원본(캡처) 타임스탬프');
  assert.deepEqual(videoCalls.map(c => c[2].keyframe), [true, false, false]);
  assert.ok(videoCalls.every(c => c[1] === 6 && c[2].nalCount === 1));
  assert.equal(encoder.index, null);
  assert.equal(encoder.rawSamples, null);
  assert.equal(encoder.sampleCount, 3);
  assert.equal(encoder.retainedBytes, 0);
  assert.deepEqual(videoCalls.map((c, i) => encoder.adjustTimestamp(c[2].timestamp, i)), [0, FRAME_US + 150_000, 2 * FRAME_US + 150_000], '보정 접근자: 두 번째 샘플부터 정렬 오프셋');
  assert.equal(track.sampleCount, 3);
});

test('VideoTrackEncoder.adjustTimestamp는 메모리 경로(getSamples)와 같은 보정(일시정지 구간 제외 + 정렬 오프셋)을 원본 타임스탬프에 적용한다', async () => {
  const run = async (sampleSink) => {
    let clock = 0;
    const reader = new FakeReader([new FakeVideoFrame({ timestamp: 0 }), new FakeVideoFrame({ timestamp: 33_333 })]);
    const { FakeVideoEncoder } = makeFakeVideoEncoder();
    const encoder = new VideoTrackEncoder({ track: {}, sampleSink, deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => clock } });
    encoder.setAudioStartTime(-40);
    await encoder.start();
    await tick();
    for (const [pauseAt, resumeAt, dropped, resumed] of [[50, 990, [66_666, 500_000], [1_000_000, 1_033_333]], [1_050, 2_990, [1_066_666], [3_000_000, 3_033_333]]]) {
      clock = pauseAt; encoder.pause();
      dropped.forEach(t => reader.push(new FakeVideoFrame({ timestamp: t })));
      await tick();
      clock = resumeAt; encoder.resume();
      resumed.forEach(t => reader.push(new FakeVideoFrame({ timestamp: t })));
      await tick();
    }
    return { encoder, track: await encoder.stop() };
  };
  const memory = await run(null);
  const sink = new RecordingSampleSink();
  const direct = await run(sink);
  const raw = sink.calls.filter(c => c[0] === 'video').map(c => c[2].timestamp);
  assert.deepEqual(raw, [0, 33_333, 1_000_000, 1_033_333, 3_000_000, 3_033_333], '싱크에는 원본 타임스탬프');
  assert.deepEqual(raw.map((t, i) => direct.encoder.adjustTimestamp(t, i)), memory.track.samples.map(x => x.timestamp), '보정 결과가 메모리 경로와 같음');
});

test('ContainerAudioEncoder는 frameSink가 주어지면 MP3 프레임을 바로 넘기고(프레임당 샘플 수 포함) 저장소·인덱스·프레임 배열을 만들지 않는다', async () => {
  const sink = new RecordingSampleSink();
  const enc = new ContainerAudioEncoder({ sampleRate: 44100, channels: 2, bitrateKbps: 128, frameSink: sink });
  enc.start();
  const l = new Float32Array(4096).fill(0.1), r = new Float32Array(4096).fill(-0.1);
  for (let i = 0; i < 6; i++) enc.processChunk(l, r);
  const audio = await enc.finish();
  const frames = sink.calls.filter(c => c[0] === 'audio');
  assert.ok(frames.length > 10);
  assert.ok(frames.every(c => c[2].samples === 1152 && c[1] > 100));
  assert.equal(enc.frameCount, frames.length);
  assert.equal(enc.index, null);
  assert.deepEqual(enc.frames, []);
  assert.deepEqual({ codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels, bitrate: audio.bitrate, frameCount: audio.frameCount }, { codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000, frameCount: frames.length });
});

async function startDirectSession({ format, storage = null, outputSinkFactory = null, onError = null, settings = VIDEO_SETTINGS, writerOptions, frameList = frames(10) }) {
  const reader = new FakeReader(frameList);
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  const session = new VideoRecordingSession({
    format, videoTrack: {}, sampleRate: 44100, bitrateKbps: 128, storage, outputSinkFactory, onError, settings, writerOptions,
    deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 }
  });
  await session.start();
  const l = new Float32Array(4096).fill(0.1), r = new Float32Array(4096).fill(-0.1);
  for (let i = 0; i < 6; i++) session.pushAudio(l, r);
  await tick();
  return { session, reader, l, r };
}

for (const [format, brand, mime] of [['mp4', 'isom', 'video/mp4'], ['mov', 'qt  ', 'video/quicktime'], ['fmp4', 'iso5', 'video/mp4']]) {
  test(`VideoRecordingSession(${format})은 녹화 중 결과 파일(OPFS ${format === 'fmp4' ? 'video.mp4' : `video.${format}`})에 바로 기록하고 청크 저장소를 만들지 않으며, 중지 시 ${format === 'fmp4' ? '마지막 조각' : 'moov'}만 쓴다`, async () => {
    const opfsRoot = new FakeDirectoryHandle();
    const storage = await createRecordingStorage({ getDirectory: async () => opfsRoot }, `live-${format}`);
    const ext = format === 'fmp4' ? 'mp4' : format;
    const { session } = await startDirectSession({ format, storage });
    assert.deepEqual(await sessionFiles(opfsRoot, `live-${format}`), [`video.${ext}`], '녹화 시작 때 결과 파일만 만듦 (video.bin / container-audio.bin 없음)');
    const blob = await session.stop();
    assert.deepEqual(await sessionFiles(opfsRoot, `live-${format}`), [`video.${ext}`]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.subarray(4, 12)), `ftyp${brand}`);
    assert.equal(blob.type, mime);
    assert.equal(session.outputTarget, 'opfs');
    assert.equal(session.stats.videoFrames, 10);
    assert.ok(session.stats.audioFrames > 10);
    assert.equal(session.stats.bytes, blob.size);
    assert.equal(session.stats.writer, format === 'fmp4' ? 'fmp4' : 'direct-mp4');
    for (const k of ['encoderMs', 'containerAudioMs', 'planMs', 'writeMs', 'closeMs']) assert.equal(typeof session.timings[k], 'number', `timings.${k}`);
    const top = parseBoxes(bytes).map(b => b.type);
    if (format === 'fmp4') assert.deepEqual(top.slice(0, 3), ['ftyp', 'moov', 'moof']);
    else assert.deepEqual(top, ['ftyp', 'mdat', 'moov']);
  });
}

test('VideoRecordingSession(fmp4)은 녹화 중에도 키프레임마다 조각을 기록한다 (중지 전 파일에 moof+mdat가 쌓임)', async () => {
  const sink = new MemoryFileSink('video/mp4');
  const { session } = await startDirectSession({ format: 'fmp4', outputSinkFactory: async () => sink, settings: { ...VIDEO_SETTINGS, KEYFRAME_INTERVAL: 4 } });
  await tick();
  assert.ok(session.writer.fragmentsWritten >= 2, `중지 전 조각 ${session.writer.fragmentsWritten}개`);
  assert.ok(sink.bytesWritten > 0, '조각을 쓰기 시작함');
  const blob = await session.stop();
  const frags = readFragments(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(frags.reduce((n, f) => n + (f.tracks[1] ? f.tracks[1].samples.length : 0), 0), 10);
  assert.ok(frags.slice(0, -1).every(f => f.tracks[1].samples[0].flags === 0x02000000), '조각은 키프레임으로 시작');
});

test('VideoRecordingSession(mp4/fmp4)은 outputSinkFactory 싱크(사용자 폴더)를 녹화 시작 때 실제 포맷·MIME으로 열어 바로 기록한다 (fmp4 → .mp4, video/mp4)', async () => {
  for (const format of ['mp4', 'fmp4']) {
    const userDir = new FakeDirectoryHandle('Recordings');
    const calls = [];
    const { session } = await startDirectSession({
      format,
      outputSinkFactory: async (fmt, mimeType) => { calls.push([fmt, mimeType]); return new DirectoryFileSink(userDir, `recorda_z.${fmt === 'fmp4' ? 'mp4' : fmt}`, mimeType); }
    });
    assert.deepEqual(calls, [[format, 'video/mp4']], `${format}: 시작 때 한 번 요청`);
    assert.equal(session.outputTarget, 'custom');
    const blob = await session.stop();
    assert.deepEqual(userDir.fileNames(), ['recorda_z.mp4']);
    assert.equal((await fileBytes(userDir, 'recorda_z.mp4')).length, blob.size);
  }
});

test('VideoRecordingSession(avi)은 기존처럼 청크 저장소에 쌓았다가 중지 시에 outputSinkFactory 싱크로 머싱한다', async () => {
  const calls = [];
  const userDir = new FakeDirectoryHandle('Recordings');
  const { session } = await startDirectSession({ format: 'avi', outputSinkFactory: async (fmt, mimeType) => { calls.push([fmt, mimeType]); return new DirectoryFileSink(userDir, `recorda_a.${fmt}`, mimeType); } });
  assert.deepEqual(calls, [], 'AVI는 시작 때 출력 파일을 열지 않음');
  assert.equal(session.writer, null);
  await session.stop();
  assert.deepEqual(calls, [['avi', 'video/x-msvideo']]);
  assert.deepEqual(userDir.fileNames(), ['recorda_a.avi']);
});

for (const format of ['mp4', 'fmp4']) {
  test(`VideoRecordingSession(${format})은 녹화 중 결과 파일 쓰기가 실패하면(권한 회수·드라이브 분리) onError로 VIDEO_WRITE_FAILED를 한 번 알리고, stop()은 같은 오류로 거부되며 폴더의 실패한 파일을 지운다`, async () => {
    const userDir = new FakeDirectoryHandle('USB');
    const errors = [];
    const { session, reader } = await startDirectSession({
      format,
      outputSinkFactory: async (fmt, mimeType) => { const sink = new DirectoryFileSink(userDir, 'recorda_w.mp4', mimeType); await sink.open(); return sink; },
      onError: (e) => errors.push(e),
      settings: { ...VIDEO_SETTINGS, KEYFRAME_INTERVAL: 4 },
      writerOptions: { bufferBytes: 64 } // 작은 버퍼: 녹화 중에 실제 쓰기가 일어나게 (기본 8 MB)
    });
    assert.deepEqual(errors, [], '아직 정상');
    userDir.faults = { failWritesAfter: 0 };
    for (let i = 10; i < 20; i++) reader.push(new FakeVideoFrame({ timestamp: i * FRAME_US }));
    await tick(); await tick();
    assert.equal(errors.length, 1, 'onError 한 번');
    assert.ok(errors[0].message.includes(ERROR_MESSAGES.VIDEO_WRITE_FAILED), errors[0].message);
    assert.match(errors[0].message, /NotAllowedError/, '원인 포함');
    await assert.rejects(() => session.stop(), (e) => e.message.includes(ERROR_MESSAGES.VIDEO_WRITE_FAILED));
    assert.deepEqual(userDir.fileNames(), [], '실패한 파일(빈 대상 파일) 정리');
  });
}

test('VideoRecordingSession(mp4)은 영상 프레임이 없으면 NO_VIDEO로 실패하고 미리 만든 결과 파일을 지운다', async () => {
  const userDir = new FakeDirectoryHandle('Recordings');
  const { session } = await startDirectSession({ format: 'mp4', frameList: [], outputSinkFactory: async (fmt, mimeType) => { const sink = new DirectoryFileSink(userDir, 'recorda_e.mp4', mimeType); await sink.open(); return sink; } });
  assert.deepEqual(userDir.fileNames(), ['recorda_e.mp4'], '시작 때 만든 대상 파일');
  await assert.rejects(() => session.stop(), new RegExp(ERROR_MESSAGES.NO_VIDEO.slice(0, 8)));
  assert.deepEqual(userDir.fileNames(), []);
});
