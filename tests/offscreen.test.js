import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { FakeVideoFrame, FakeReader, makeFakeTrackProcessor, makeFakeVideoEncoder } from './helpers/fakes.js';
import { MESSAGE_TYPES, RECORDING_MODES } from '../constants.js';
import { resolveRecordingPlan } from '../recording-plan.js';

vm.runInThisContext(readFileSync(new URL('../lib/lame.min.js', import.meta.url), 'utf8'));

const fake = installFakeChrome();
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---- Web Audio / MediaStream 가짜 ----
let lastConstraints = null;
let workletPorts = [];
let frameReader = null;

class FakePort {
  // 실제 워크릿처럼 stop 명령에 마지막 데이터 + stopped 응답을 보냄
  constructor() { this.onmessage = null; this.posted = []; this.ackOnStop = true; this.deliveredWhileAttached = null; }
  postMessage(m) {
    this.posted.push(m);
    if (m && m.command === 'stop' && this.ackOnStop) {
      // 실제 워크릿처럼 비동기로 마지막 데이터와 stopped 응답을 보냄
      setTimeout(() => {
        if (this.deliveredWhileAttached === null) this.deliveredWhileAttached = typeof this.onmessage === 'function';
        if (this.onmessage) {
          this.onmessage({ data: { type: 'audioData', leftChannel: new Float32Array(1024), rightChannel: new Float32Array(1024) } });
          this.onmessage({ data: { type: 'stopped' } });
        }
      }, 20);
    }
  }
}
class FakeAudioWorkletNode {
  constructor() { this.port = new FakePort(); workletPorts.push(this.port); }
  connect() {} disconnect() {}
}
class FakeAudioContext {
  constructor(opts = {}) { (globalThis.__audioContextOpts = globalThis.__audioContextOpts || []).push(opts); this.sampleRate = opts.sampleRate || 44100; this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
function makeStream({ withVideo }) {
  const tracks = [{ kind: 'audio', label: 'tab', enabled: true, readyState: 'live', onended: null, stop() {} }];
  if (withVideo) tracks.push({ kind: 'video', label: 'tab', enabled: true, readyState: 'live', onended: null, stop() {}, getSettings: () => ({ width: 160, height: 120 }) });
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter(t => t.kind === 'video')
  };
  globalThis.__lastStream = stream;
  return stream;
}

before(async () => {
  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          lastConstraints = constraints;
          return makeStream({ withVideo: !!constraints.video });
        }
      }
    }
  });
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
  await import('../offscreen.js');
});

function installVideoFakes(frameCount = 8) {
  frameReader = new FakeReader(Array.from({ length: frameCount }, (_, i) => new FakeVideoFrame({ timestamp: i * 33_333 })));
  const { FakeVideoEncoder } = makeFakeVideoEncoder();
  globalThis.VideoEncoder = FakeVideoEncoder;
  globalThis.MediaStreamTrackProcessor = makeFakeTrackProcessor(frameReader);
}

function feedAudio(chunks = 6) {
  const left = new Float32Array(4096).fill(0.2);
  const right = new Float32Array(4096).fill(-0.2);
  for (const port of workletPorts) {
    if (!port.onmessage) continue;
    for (let i = 0; i < chunks; i++) port.onmessage({ data: { type: 'audioData', leftChannel: left, rightChannel: right } });
  }
}

test('START_CAPTURE(VIDEO_AUDIO_SPLIT, mp4+mp3) → 영상 제약 포함 getUserMedia, STOP 시 mp4와 mp3 두 파일을 다운로드 요청하고 RECORDING_COMPLETE를 보낸다', async () => {
  installVideoFakes(8);
  workletPorts = [];
  fake.calls.sendMessage.length = 0;
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'mp3', videoFormat: 'mp4' });

  const res = await fake.dispatch({
    action: MESSAGE_TYPES.START_CAPTURE,
    data: { streamId: 'sid', format: 'mp3', bitrate: 128, sampleRate: 44100, plan }
  });
  assert.equal(res.success, true, res.error);
  assert.equal(lastConstraints.audio.mandatory.chromeMediaSourceId, 'sid');
  assert.equal(lastConstraints.video.mandatory.chromeMediaSource, 'tab');
  assert.equal(lastConstraints.video.mandatory.maxFrameRate, 30);
  assert.ok(fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_STARTED));
  assert.deepEqual(workletPorts[0].posted[0], { command: 'start' });

  feedAudio(6);
  await flush();

  fake.calls.sendMessage.length = 0;
  const stopRes = await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  assert.equal(stopRes.success, true);
  await flush(200);

  const downloads = fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.DOWNLOAD_FILE);
  assert.equal(downloads.length, 2, JSON.stringify(fake.calls.sendMessage.map(m => m.action)));
  assert.match(downloads[0].data.filename, /^recorda_\d{8}_\d{6}\.mp4$/);
  assert.match(downloads[1].data.filename, /^recorda_\d{8}_\d{6}\.mp3$/);
  assert.equal(downloads[0].data.filename.replace(/\.mp4$/, ''), downloads[1].data.filename.replace(/\.mp3$/, ''), '같은 타임스탬프');
  assert.ok(downloads.every(d => d.data.url.startsWith('blob:')));

  const complete = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE);
  assert.ok(complete, 'RECORDING_COMPLETE 전송');
  assert.equal(complete.data.files.length, 2);
  assert.deepEqual(complete.data.files.map(f => f.kind), ['video', 'audio']);
  assert.ok(complete.data.files.every(f => f.size > 0));
  assert.ok(!fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_ERROR));
});

test('START_CAPTURE(AUDIO_ONLY) → 영상 제약 없이 캡처하고 오디오 파일 1개만 저장한다 (기존 동작 유지)', async () => {
  workletPorts = [];
  fake.calls.sendMessage.length = 0;
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'sid2', format: 'mp3', bitrate: 128, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);
  assert.equal(lastConstraints.video, false);

  feedAudio(6);
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(200);

  const downloads = fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.DOWNLOAD_FILE);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].data.filename, /\.mp3$/);
  const complete = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE);
  assert.equal(complete.data.files.length, 1);
  assert.equal(complete.data.format, 'mp3', '하위 호환 필드');
});

test('START_CAPTURE(VIDEO_AUDIO, avi) → 영상 파일 1개만 저장한다', async () => {
  installVideoFakes(5);
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, audioFormat: 'wav', videoFormat: 'avi' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'sid3', format: 'wav', bitrate: 192, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);

  feedAudio(4);
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(200);

  const downloads = fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.DOWNLOAD_FILE);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].data.filename, /\.avi$/);
});

test('영상 모드에서 비디오 트랙이 없으면 NO_VIDEO 에러를 보고한다', async () => {
  installVideoFakes(1);
  const original = globalThis.navigator.mediaDevices.getUserMedia;
  globalThis.navigator.mediaDevices.getUserMedia = async () => makeStream({ withVideo: false });
  try {
    fake.calls.sendMessage.length = 0;
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'mp4' });
    const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'sid4', bitrate: 128, sampleRate: 44100, plan } });
    assert.equal(res.success, false);
    assert.match(res.error, /탭 영상/);
    const err = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.RECORDING_ERROR);
    assert.ok(err);
  } finally {
    globalThis.navigator.mediaDevices.getUserMedia = original;
  }
});

test('chrome.downloads가 실패하면 앵커 다운로드로 폴백하고 녹화는 성공으로 끝난다', async () => {
  installVideoFakes(4);
  workletPorts = [];
  fake.chrome.__respondTo[MESSAGE_TYPES.DOWNLOAD_FILE] = async () => ({ success: false, error: 'no downloads' });
  const anchors = [];
  globalThis.document = {
    createElement: () => { const a = { style: {}, click() { anchors.push(this.download); } }; return a; },
    body: { appendChild() {}, removeChild() {} }
  };
  try {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'mov' });
    const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'sid5', bitrate: 128, sampleRate: 44100, plan } });
    assert.equal(res.success, true, res.error);
    feedAudio(3);
    fake.calls.sendMessage.length = 0;
    await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
    await flush(1300);
    assert.equal(anchors.length, 1);
    assert.match(anchors[0], /\.mov$/);
    assert.ok(fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE));
  } finally {
    delete fake.chrome.__respondTo[MESSAGE_TYPES.DOWNLOAD_FILE];
    delete globalThis.document;
  }
});

test('분리 저장 모드에서 영상 프레임이 0개라 머싱이 실패해도 오디오 파일은 저장되고 warning이 함께 전달된다', async () => {
  installVideoFakes(0);
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'mp3', videoFormat: 'mp4' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'sid6', bitrate: 128, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);

  feedAudio(4);
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(200);

  const downloads = fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.DOWNLOAD_FILE);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].data.filename, /\.mp3$/);
  const complete = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE);
  assert.ok(complete, 'RECORDING_COMPLETE 전송');
  assert.equal(complete.data.files.length, 1);
  assert.match(complete.data.warning, /탭 영상/);
  assert.ok(!fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_ERROR), '오디오가 저장됐으므로 ERROR가 아닌 warning');
});

test('영상 단독 모드에서 머싱이 실패하면 RECORDING_ERROR를 보낸다', async () => {
  installVideoFakes(0);
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'mp4' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'sid7', bitrate: 128, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);

  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(200);

  assert.ok(fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_ERROR));
  assert.ok(!fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE));
});

test('AudioContext는 사용자 설정 샘플레이트로 생성된다 (루프백 컨텍스트 포함)', async () => {
  globalThis.__audioContextOpts = [];
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'sr', format: 'mp3', bitrate: 128, sampleRate: 48000, plan } });
  assert.equal(res.success, true, res.error);
  assert.ok(globalThis.__audioContextOpts.length >= 1);
  assert.ok(globalThis.__audioContextOpts.every(o => o && o.sampleRate === 48000), JSON.stringify(globalThis.__audioContextOpts));
  feedAudio(2);
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(200);
});

test('녹화 중 캡처 트랙이 끝나면(탭 닫힘) 스스로 중지하고 파일을 저장한다', async () => {
  installVideoFakes(4);
  workletPorts = [];
  globalThis.__lastStream = null;
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'mp4' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'te', bitrate: 128, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);
  feedAudio(3);
  fake.calls.sendMessage.length = 0;
  const videoTrack = globalThis.__lastStream.getVideoTracks()[0];
  assert.equal(typeof videoTrack.onended, 'function', 'onended 핸들러 등록');
  videoTrack.onended();
  await flush(300);
  assert.ok(fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE), 'RECORDING_COMPLETE 전송');
  assert.equal(fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.DOWNLOAD_FILE).length, 1);
});

test('중지 시 워크릿의 마지막 플러시(stopped 응답)를 기다린 뒤 onmessage를 해제한다', async () => {
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'fl', format: 'mp3', bitrate: 128, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);
  feedAudio(3);
  const port = workletPorts[0];
  port.ackOnStop = true;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);
  assert.equal(port.deliveredWhileAttached, true, 'stop 이후 보낸 마지막 오디오/stopped 메시지가 onmessage가 붙어 있는 동안 전달되어야 함');
});

test('녹화 중 주기적으로 RECORDING_HEARTBEAT(tabId, startTime, plan)를 보낸다', async () => {
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'hb', format: 'mp3', bitrate: 128, sampleRate: 44100, plan, tabId: 77, startTime: 123456, heartbeatIntervalMs: 50 } });
  assert.equal(res.success, true, res.error);
  await flush(180);
  const beats = fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.RECORDING_HEARTBEAT);
  assert.ok(beats.length >= 2, `heartbeats=${beats.length}`);
  assert.equal(beats[0].data.tabId, 77);
  assert.equal(beats[0].data.startTime, 123456);
  assert.equal(beats[0].data.plan.mode, RECORDING_MODES.AUDIO_ONLY);
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);
  const count = fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.RECORDING_HEARTBEAT).length;
  await flush(150);
  assert.equal(fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.RECORDING_HEARTBEAT).length, count, '중지 후에는 하트비트 중단');
});
