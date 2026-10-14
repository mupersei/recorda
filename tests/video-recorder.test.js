import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { VideoTrackEncoder, computeVideoBitrate, VideoRecordingSession } from '../video-recorder.js';
import { ContainerAudioEncoder } from '../container-audio-encoder.js';
import { VIDEO_SETTINGS, ERROR_MESSAGES } from '../constants.js';
import { FakeVideoFrame, FakeReader, makeFakeTrackProcessor, makeFakeVideoEncoder, FAKE_AVCC } from './helpers/fakes.js';

vm.runInThisContext(readFileSync(new URL('../lib/lame.min.js', import.meta.url), 'utf8'));

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

test('VideoTrackEncoder는 chunkStore가 주어지면 청크 데이터를 저장소에 넘기고 참조(ref)와 nalCount만 보관한다', async () => {
  const store = new CountingStore();
  const reader = new FakeReader(frames(5));
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  const encoder = new VideoTrackEncoder({ track: {}, chunkStore: store, deps: { VideoEncoder: FakeVideoEncoder, MediaStreamTrackProcessor: makeFakeTrackProcessor(reader), now: () => 0 } });
  await encoder.start();
  await tick();
  const result = await encoder.stop();
  assert.equal(result.samples.length, 5);
  assert.ok(result.samples.every(s => !s.data && s.ref && typeof s.ref.offset === 'number' && s.ref.size === 6), JSON.stringify(result.samples[0]));
  assert.ok(result.samples.every(s => s.nalCount === 1), '가짜 청크는 NAL 1개');
  assert.deepEqual(result.samples.map(s => s.ref.offset), [0, 6, 12, 18, 24]);
  assert.equal(store.appends, 5);
  assert.equal(store.finalized, true, 'stop 시 저장소 finalize');
  assert.equal(result.store, store);
  assert.equal(encoder.retainedBytes, 0, '인코더가 청크 데이터를 보유하지 않음');
});

test('VideoTrackEncoder는 저장소 없이 쓰면 기존처럼 data를 보관한다 (호환)', async () => {
  const { encoder } = makeEncoder({ frameList: frames(2) });
  await encoder.start();
  await tick();
  const { samples } = await encoder.stop();
  assert.ok(samples.every(s => s.data instanceof Uint8Array && !s.ref));
  assert.equal(encoder.retainedBytes, 12);
});

test('ContainerAudioEncoder는 chunkStore가 주어지면 MP3 프레임을 저장소에 넘기고 참조만 보관한다', async () => {
  const store = new MemoryChunkStore();
  const enc = new ContainerAudioEncoder({ sampleRate: 44100, channels: 2, bitrateKbps: 128, chunkStore: store });
  enc.start();
  const l = new Float32Array(4096).fill(0.1), r = new Float32Array(4096).fill(-0.1);
  for (let i = 0; i < 6; i++) enc.processChunk(l, r);
  const audio = await enc.finish();
  assert.ok(audio.frames.length > 10);
  assert.ok(audio.frames.every(f => !f.data && f.ref && f.samples === 1152));
  assert.equal(audio.store, store);
  assert.equal(store.finalized, true);
  const first = await store.readRange(audio.frames[0].ref.offset, 2);
  assert.equal(first[0], 0xFF, 'MP3 프레임 싱크');
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
  });
}

test('VideoTrackEncoder(chunkStore)는 장시간(약 55분 분량) 청크를 밀어 넣어도 메모리 보유량이 메타데이터 수준에 머문다', async () => {
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
  const before = process.memoryUsage().heapUsed;
  await encoder.start();
  // 읽기 루프가 끝날 때까지 대기
  while (!encoder.ended) await new Promise(r => setTimeout(r, 20));
  const result = await encoder.stop();
  const after = process.memoryUsage().heapUsed;
  assert.equal(result.samples.length, frameCount);
  assert.equal(store.size, frameCount * 25_000, '약 2.5GB가 저장소로 전달됨');
  assert.equal(encoder.retainedBytes, 0);
  const growthMB = (after - before) / 1048576;
  assert.ok(growthMB < 80, `메타데이터만 보유해야 함: 힙 증가 ${growthMB.toFixed(0)} MB`);
});
