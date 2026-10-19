import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { FakeVideoFrame, FakeReader, makeFakeTrackProcessor, makeFakeVideoEncoder } from './helpers/fakes.js';
import { MESSAGE_TYPES, RECORDING_MODES, ERROR_MESSAGES } from '../constants.js';
import { resolveRecordingPlan } from '../recording-plan.js';

vm.runInThisContext(readFileSync(new URL('../lib/lame.min.js', import.meta.url), 'utf8'));

const fake = installFakeChrome();
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---- Web Audio / MediaStream 가짜 ----
let lastConstraints = null;
let workletPorts = [];
let frameReader = null;

class FakePort {
  // 실제 워크릿처럼 stop 명령에 마지막 데이터 + stopped 응답을, pause 명령에 경계까지의 데이터 + paused 응답을 보냄
  constructor() { this.onmessage = null; this.posted = []; this.ackOnStop = true; this.ackOnPause = true; this.deliveredWhileAttached = null; }
  postMessage(m) {
    this.posted.push(m);
    if (m && m.command === 'pause' && this.ackOnPause) {
      setTimeout(() => {
        if (!this.onmessage) return;
        this.onmessage({ data: { type: 'audioData', leftChannel: new Float32Array(512).fill(0.5), rightChannel: new Float32Array(512).fill(-0.5) } });
        this.onmessage({ data: { type: 'paused' } });
      }, 5);
    }
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

let videoEncoderInstances = [];
function installVideoFakes(frameCount = 8, stepUs = 33_333) {
  frameReader = new FakeReader(Array.from({ length: frameCount }, (_, i) => new FakeVideoFrame({ timestamp: i * stepUs })));
  const { FakeVideoEncoder, instances } = makeFakeVideoEncoder();
  videoEncoderInstances = instances;
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

// ---- OPFS 디스크 저장소 사용 ----
import { installFakeOpfs } from './helpers/fake-opfs.js';
import { OPFS_ROOT_DIR } from '../storage/chunk-store.js';

test('OPFS가 있으면 녹화 데이터를 디스크(세션 디렉토리)에 기록하고 결과 파일도 OPFS에 만들며, 다음 녹화 시작 시 이전 세션을 정리한다', async () => {
  const root = installFakeOpfs();
  installVideoFakes(6);
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'mp4' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'opfs1', format: 'wav', bitrate: 128, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);
  feedAudio(4);
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);

  const complete = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE);
  assert.ok(complete, 'RECORDING_COMPLETE');
  assert.equal(complete.data.files.length, 2);
  assert.ok(complete.data.files.every(f => f.size > 0));
  assert.equal(complete.data.storage, 'opfs', '디스크 저장소 사용을 보고');

  const base = await root.getDirectoryHandle(OPFS_ROOT_DIR);
  const sessions = [];
  for await (const k of base.keys()) sessions.push(k);
  assert.equal(sessions.length, 1, '세션 디렉토리 1개');
  const dir = await base.getDirectoryHandle(sessions[0]);
  const names = [];
  for await (const k of dir.keys()) names.push(k);
  assert.ok(names.some(n => n.endsWith('.mp4')) && names.some(n => n.endsWith('.wav')), `OPFS 파일: ${names}`);

  // 다음 녹화 시작 → 이전 세션 정리
  installVideoFakes(2);
  workletPorts = [];
  await flush(5); // 세션 ID(타임스탬프) 충돌 방지
  const plan2 = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const res2 = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'opfs2', format: 'mp3', bitrate: 128, sampleRate: 44100, plan: plan2 } });
  assert.equal(res2.success, true, res2.error);
  await flush(50);
  const after = [];
  for await (const k of base.keys()) after.push(k);
  assert.equal(after.length, 1, '이전 세션 삭제, 현재 세션만');
  assert.notEqual(after[0], sessions[0]);
  feedAudio(2);
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);
  delete globalThis.navigator.storage;
});

test('RECORDING_COMPLETE는 중지 후 단계별 소요 시간(timings)을 함께 보고한다', async () => {
  installVideoFakes(4);
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'mp4' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'tm', format: 'wav', bitrate: 128, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);
  feedAudio(3);
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);
  const complete = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE);
  assert.ok(complete, 'RECORDING_COMPLETE');
  const t = complete.data.timings;
  assert.ok(t, 'timings 존재');
  for (const k of ['workletMs', 'videoMs', 'audioMs', 'downloadRequestMs', 'totalMs']) {
    assert.equal(typeof t[k], 'number', `${k}: ${JSON.stringify(t)}`);
    assert.ok(t[k] >= 0, k);
  }
  assert.ok(t.totalMs >= t.videoMs + t.audioMs, '합계는 각 단계 이상');
  // 영상 단계 세부: 인코더 마감 / 컨테이너 오디오 마감 / 머싱 계획 / 기록 / 출력 닫기
  for (const k of ['encoderMs', 'containerAudioMs', 'planMs', 'writeMs', 'closeMs']) {
    assert.equal(typeof (t.video && t.video[k]), 'number', `video.${k}: ${JSON.stringify(t.video)}`);
  }
});

// ---- 일시정지 / 재개 ----
import { WavFileEncoder, Mp3FileEncoder } from '../audio-file-encoders.js';
import { ContainerAudioEncoder } from '../container-audio-encoder.js';

/** 인코더 processChunk 호출 기록 (offscreen.js가 쓰는 것과 같은 모듈 인스턴스의 프로토타입을 감쌈) */
function spyPcm() {
  const calls = [];
  const restores = [[WavFileEncoder, 'wav'], [Mp3FileEncoder, 'mp3'], [ContainerAudioEncoder, 'container']].map(([cls, name]) => {
    const original = cls.prototype.processChunk;
    cls.prototype.processChunk = function (left, right) {
      calls.push({ encoder: name, samples: left.length, value: left[0] });
      return original.call(this, left, right);
    };
    return () => { cls.prototype.processChunk = original; };
  });
  const values = (encoder) => calls.filter(c => c.encoder === encoder).map(c => c.value);
  return { calls, values, restore: () => restores.forEach(r => r()) };
}

function feedAudioValue(chunks, value, samples = 4096) {
  const left = new Float32Array(samples).fill(value);
  const right = new Float32Array(samples).fill(-value);
  for (const port of workletPorts) {
    if (!port.onmessage) continue;
    for (let i = 0; i < chunks; i++) port.onmessage({ data: { type: 'audioData', leftChannel: left, rightChannel: right } });
  }
}

test('캡처 중이 아니면 PAUSE_CAPTURE / RESUME_CAPTURE는 실패를 응답한다', async () => {
  const pause = await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_CAPTURE, data: { pausedAt: 1, pausedTotalMs: 0 } });
  assert.equal(pause && pause.success, false);
  const resume = await fake.dispatch({ action: MESSAGE_TYPES.RESUME_CAPTURE, data: { pausedTotalMs: 0 } });
  assert.equal(resume && resume.success, false);
});

test('PAUSE_CAPTURE 중에는 오디오 파일 인코더와 영상 세션 어디에도 PCM을 넘기지 않고 영상 프레임도 인코딩하지 않으며, RESUME_CAPTURE 후 다시 인코딩한다', async () => {
  installVideoFakes(3); // 0, 33333, 66666
  workletPorts = [];
  const spy = spyPcm();
  try {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'mp4' });
    const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'pz', format: 'wav', bitrate: 128, sampleRate: 44100, plan } });
    assert.equal(res.success, true, res.error);
    const port = workletPorts[0];
    feedAudioValue(2, 0.25);
    await flush();

    const pauseRes = await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_CAPTURE, data: { pausedAt: 1234, pausedTotalMs: 0 } });
    assert.equal(pauseRes.success, true, pauseRes && pauseRes.error);
    assert.deepEqual(port.posted.at(-1), { command: 'pause' }, '워크릿에 일시정지 요청 (경계까지의 PCM을 먼저 받기 위해)');
    await flush(); // 워크릿이 경계까지의 PCM(0.5 × 512샘플)을 보내고 paused로 응답
    feedAudioValue(3, 0.75); // 일시정지 중 도착한 PCM → 어느 인코더에도 가면 안 됨
    for (let i = 3; i < 16; i++) frameReader.push(new FakeVideoFrame({ timestamp: i * 33_333 }));
    await flush();
    assert.ok(!spy.calls.some(c => c.value === 0.75), '일시정지 중 PCM이 인코더에 전달됨');

    const resumeRes = await fake.dispatch({ action: MESSAGE_TYPES.RESUME_CAPTURE, data: { pausedTotalMs: 4000 } });
    assert.equal(resumeRes.success, true, resumeRes && resumeRes.error);
    assert.deepEqual(port.posted.at(-1), { command: 'resume' });
    feedAudioValue(2, 0.125);
    frameReader.push(new FakeVideoFrame({ timestamp: 16 * 33_333 }));
    frameReader.push(new FakeVideoFrame({ timestamp: 17 * 33_333 }));
    await flush();

    fake.calls.sendMessage.length = 0;
    await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
    await flush(300);

    for (const enc of ['wav', 'container']) {
      assert.deepEqual(spy.values(enc), [0.25, 0.25, 0.5, 0.125, 0.125, 0], `${enc}: 일시정지 전 + 경계 꼬리 + 재개 후 + 중지 꼬리만 전달`);
    }
    const encoded = videoEncoderInstances[0].encoded;
    assert.deepEqual(encoded.map(e => e.timestamp), [0, 33_333, 66_666, 16 * 33_333, 17 * 33_333], '일시정지 중 프레임은 인코딩하지 않음');
    assert.equal(encoded[3].key, true, '재개 후 첫 프레임은 키프레임');

    const complete = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE);
    assert.ok(complete, 'RECORDING_COMPLETE');
    assert.deepEqual(complete.data.files.map(f => f.kind), ['video', 'audio']);
    const wav = complete.data.files.find(f => f.kind === 'audio');
    assert.equal(wav.size, 44 + (2 * 4096 + 512 + 2 * 4096 + 1024) * 4, 'WAV에는 일시정지 구간 PCM이 없음');
    assert.ok(!fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_ERROR));
  } finally {
    spy.restore();
  }
});

test('워크릿이 paused 응답을 보내지 않아도 잠시 뒤에는 일시정지로 간주해 PCM을 버린다 (응답 전 도착분은 일시정지 직전 데이터로 기록)', async () => {
  workletPorts = [];
  const spy = spyPcm();
  try {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'wav' });
    const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'pt', format: 'wav', bitrate: 128, sampleRate: 44100, plan } });
    assert.equal(res.success, true, res.error);
    workletPorts[0].ackOnPause = false;
    feedAudioValue(1, 0.25);
    await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_CAPTURE, data: { pausedAt: 1, pausedTotalMs: 0 } });
    feedAudioValue(1, 0.5);   // 워크릿 응답 전 = 일시정지 직전까지 모인 데이터
    await flush(450);         // 응답 대기 타임아웃 경과
    feedAudioValue(1, 0.75);  // 일시정지 중 → 버림
    fake.calls.sendMessage.length = 0;
    await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
    await flush(300);
    assert.deepEqual(spy.values('wav'), [0.25, 0.5], '타임아웃 뒤의 PCM과 일시정지 중 중지 꼬리는 기록하지 않음');
    assert.ok(fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE));
  } finally {
    spy.restore();
  }
});

test('일시정지 중 STOP_CAPTURE는 정상적으로 파일을 마무리한다 (분리 저장 mp4 + mp3)', async () => {
  installVideoFakes(4);
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'mp3', videoFormat: 'mp4' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'ps', format: 'mp3', bitrate: 128, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);
  feedAudio(4);
  await flush();
  await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_CAPTURE, data: { pausedAt: 1, pausedTotalMs: 0 } });
  await flush();
  frameReader.push(new FakeVideoFrame({ timestamp: 10 * 33_333 }));
  fake.calls.sendMessage.length = 0;
  const stop = await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  assert.equal(stop.success, true);
  await flush(300);
  const complete = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.RECORDING_COMPLETE);
  assert.ok(complete, 'RECORDING_COMPLETE 전송');
  assert.deepEqual(complete.data.files.map(f => f.format), ['mp4', 'mp3']);
  assert.ok(complete.data.files.every(f => f.size > 0));
  assert.ok(!fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.RECORDING_ERROR));
  assert.equal(videoEncoderInstances[0].encoded.length, 4, '일시정지 후 들어온 프레임은 인코딩하지 않음');
});

test('RECORDING_HEARTBEAT는 일시정지 상태(paused, pausedAt, pausedTotalMs)를 함께 보내 SW가 PAUSED로 복구할 수 있게 한다', async () => {
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'phb', format: 'mp3', bitrate: 128, sampleRate: 44100, plan, tabId: 9, startTime: 1000, heartbeatIntervalMs: 40 } });
  assert.equal(res.success, true, res.error);
  const lastBeat = () => fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.RECORDING_HEARTBEAT).at(-1);
  fake.calls.sendMessage.length = 0;
  await flush(100);
  assert.deepEqual(
    (({ paused, pausedAt, pausedTotalMs }) => ({ paused, pausedAt, pausedTotalMs }))(lastBeat().data),
    { paused: false, pausedAt: null, pausedTotalMs: 0 }
  );

  await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_CAPTURE, data: { pausedAt: 5000, pausedTotalMs: 1500 } });
  fake.calls.sendMessage.length = 0;
  await flush(100);
  let beat = lastBeat();
  assert.ok(beat, '일시정지 중에도 하트비트 유지');
  assert.equal(beat.data.paused, true);
  assert.equal(beat.data.pausedAt, 5000);
  assert.equal(beat.data.pausedTotalMs, 1500);
  assert.equal(beat.data.startTime, 1000);
  assert.equal(beat.data.tabId, 9);
  assert.equal(beat.data.plan.mode, RECORDING_MODES.AUDIO_ONLY);

  await fake.dispatch({ action: MESSAGE_TYPES.RESUME_CAPTURE, data: { pausedTotalMs: 4000 } });
  fake.calls.sendMessage.length = 0;
  await flush(100);
  beat = lastBeat();
  assert.equal(beat.data.paused, false);
  assert.equal(beat.data.pausedAt, null);
  assert.equal(beat.data.pausedTotalMs, 4000);

  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);
});

test('PAUSE_CAPTURE / RESUME_CAPTURE를 중복으로 받아도 워크릿에 명령을 한 번만 보내고 성공으로 응답한다', async () => {
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'pd', format: 'mp3', bitrate: 128, sampleRate: 44100, plan } });
  assert.equal(res.success, true, res.error);
  const port = workletPorts[0];
  const commands = () => port.posted.map(m => m.command).filter(c => c === 'pause' || c === 'resume');
  assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.RESUME_CAPTURE, data: { pausedTotalMs: 0 } })).success, true, '일시정지가 아니어도 재개 요청은 성공(이미 재개 상태)');
  assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_CAPTURE, data: { pausedAt: 1, pausedTotalMs: 0 } })).success, true);
  assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_CAPTURE, data: { pausedAt: 1, pausedTotalMs: 0 } })).success, true);
  await flush();
  assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.RESUME_CAPTURE, data: { pausedTotalMs: 10 } })).success, true);
  assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.RESUME_CAPTURE, data: { pausedTotalMs: 10 } })).success, true);
  assert.deepEqual(commands(), ['pause', 'resume']);
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);
});

// ---- 사용자 폴더 직접 저장 (START_CAPTURE saveToFolder) ----
import { FakeDirectoryHandle } from './helpers/fake-opfs.js';
import { createFakeIndexedDB } from './helpers/fake-idb.js';
import { setIndexedDBFactory, saveDirectoryHandle } from '../save-location.js';

/** 가짜 IndexedDB를 주입하고 (dir이 있으면) 저장 폴더로 등록 - offscreen.js는 같은 save-location 모듈로 핸들을 읽음 */
async function useSaveFolder(dir) {
  setIndexedDBFactory(createFakeIndexedDB());
  if (dir) await saveDirectoryHandle(dir);
}
const sentOf = (action) => fake.calls.sendMessage.filter(m => m.action === action);
const fileBytesOf = async (dir, name) => new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
const asciiOf = (u8, a, b) => String.fromCharCode(...u8.subarray(a, b));
const LOCAL_START = new Date(2026, 9, 16, 12, 0, 0).getTime(); // 파일명 recorda_20261016_120000
const BASE = 'recorda_20261016_120000';

/** getFileHandle(create)로 만들어지는 파일 기록 (OPFS 결과 사본이 생기는지 확인용) */
function spyCreatedFiles() {
  const created = [];
  const original = FakeDirectoryHandle.prototype.getFileHandle;
  FakeDirectoryHandle.prototype.getFileHandle = async function (name, options) {
    if (options && options.create && !this.entries.has(name)) created.push(`${this.name}/${name}`);
    return original.call(this, name, options);
  };
  return { created, restore: () => { FakeDirectoryHandle.prototype.getFileHandle = original; } };
}

async function recordToFolder({ plan, audioFormat, chunks = 4, startTime = LOCAL_START, between = null }) {
  workletPorts = [];
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'folder', format: audioFormat, bitrate: 128, sampleRate: 44100, plan, startTime, saveToFolder: true } });
  assert.equal(res.success, true, res && res.error);
  feedAudio(chunks);
  await flush();
  if (between) await between();
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);
  return sentOf(MESSAGE_TYPES.RECORDING_COMPLETE)[0];
}

test('saveToFolder: 영상(mp4)과 오디오(wav)를 사용자 폴더에 직접 기록하고, DOWNLOAD_FILE 없이 RECORDING_COMPLETE(savedTo folder, 폴더명)를 보낸다 (OPFS 결과 사본 없음)', async () => {
  const opfsRoot = installFakeOpfs();
  const userDir = new FakeDirectoryHandle('Recordings');
  await useSaveFolder(userDir);
  installVideoFakes(6);
  const spy = spyCreatedFiles();
  try {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'mp4' });
    const complete = await recordToFolder({ plan, audioFormat: 'wav' });

    assert.equal(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).length, 0, '다운로드(복사) 요청 없음');
    assert.ok(complete, 'RECORDING_COMPLETE 전송');
    assert.ok(!sentOf(MESSAGE_TYPES.RECORDING_ERROR).length);
    assert.equal(complete.data.savedTo, 'folder');
    assert.equal(complete.data.folderName, 'Recordings');
    assert.equal(complete.data.warning, undefined);
    assert.deepEqual(complete.data.files.map(f => [f.kind, f.filename, f.savedTo, f.location]), [
      ['video', `${BASE}.mp4`, 'folder', 'Recordings'],
      ['audio', `${BASE}.wav`, 'folder', 'Recordings']
    ]);
    assert.deepEqual(userDir.fileNames(), [`${BASE}.mp4`, `${BASE}.wav`], '두 파일이 같은 이름(녹화 시작 시각)으로 폴더에');

    const mp4 = await fileBytesOf(userDir, `${BASE}.mp4`);
    assert.equal(asciiOf(mp4, 4, 8), 'ftyp');
    assert.equal(mp4.length, complete.data.files[0].size);
    const wav = await fileBytesOf(userDir, `${BASE}.wav`);
    assert.equal(asciiOf(wav, 0, 4), 'RIFF');
    assert.equal(asciiOf(wav, 8, 12), 'WAVE');
    assert.equal(wav.length, 44 + (4 * 4096 + 1024) * 4, 'WAV 헤더 패치 + 모든 PCM');
    assert.equal(new DataView(wav.buffer).getUint32(40, true), (4 * 4096 + 1024) * 4, 'data 크기 패치됨');

    assert.ok(!spy.created.some(n => /\/video\.(mp4|mov|avi)$/.test(n)), `OPFS에 영상 결과 파일을 만들지 않음: ${spy.created}`);
    const base = await opfsRoot.getDirectoryHandle(OPFS_ROOT_DIR);
    const sessions = [];
    for await (const k of base.keys()) sessions.push(k);
    assert.deepEqual(sessions, [], '모두 폴더에 저장되면 OPFS 임시 데이터(청크·오디오 예비본)는 바로 정리');
    assert.equal(typeof complete.data.timings.totalMs, 'number');
  } finally {
    spy.restore();
    delete globalThis.navigator.storage;
  }
});

test('saveToFolder: OPFS 임시 데이터(청크 저장소·오디오 예비본)는 폴더의 영상·오디오 파일 기록(close)이 모두 끝난 뒤에 지우고 cleanupMs를 보고한다', async () => {
  const opfsRoot = installFakeOpfs();
  const userDir = new FakeDirectoryHandle('Recordings');
  await useSaveFolder(userDir);
  installVideoFakes(6);
  const events = [];
  const probe = await (await new FakeDirectoryHandle('probe').getFileHandle('p', { create: true })).createWritable();
  const WritableProto = Object.getPrototypeOf(probe);
  const originalClose = WritableProto.close;
  WritableProto.close = async function () { const r = await originalClose.call(this); events.push(`close:${this.file.parent.name}/${this.file.name}`); return r; };
  const originalRemove = FakeDirectoryHandle.prototype.removeEntry;
  FakeDirectoryHandle.prototype.removeEntry = async function (name, options) { events.push(`remove:${this.name}/${name}`); return originalRemove.call(this, name, options); };
  try {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'mp4' });
    const complete = await recordToFolder({ plan, audioFormat: 'wav' });
    assert.equal(complete.data.savedTo, 'folder');
    const removeSession = events.findIndex(e => e.startsWith(`remove:${OPFS_ROOT_DIR}/rec-`));
    const closeMp4 = events.indexOf(`close:Recordings/${BASE}.mp4`);
    const closeWav = events.indexOf(`close:Recordings/${BASE}.wav`);
    assert.ok(closeMp4 >= 0 && closeWav >= 0, events.join(', '));
    assert.ok(removeSession > closeMp4 && removeSession > closeWav, `세션 삭제는 폴더 파일을 닫은 뒤: ${events.join(', ')}`);
    assert.equal(typeof complete.data.timings.cleanupMs, 'number');
  } finally {
    WritableProto.close = originalClose;
    FakeDirectoryHandle.prototype.removeEntry = originalRemove;
    delete globalThis.navigator.storage;
  }
});

test('saveToFolder: 오디오만(mp3) 녹음도 폴더에 직접 저장한다', async () => {
  const userDir = new FakeDirectoryHandle('Podcasts');
  await useSaveFolder(userDir);
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const complete = await recordToFolder({ plan, audioFormat: 'mp3', chunks: 8 });
  assert.equal(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).length, 0);
  assert.equal(complete.data.savedTo, 'folder');
  assert.deepEqual(userDir.fileNames(), [`${BASE}.mp3`]);
  const mp3 = await fileBytesOf(userDir, `${BASE}.mp3`);
  assert.ok(mp3.length > 0 && mp3[0] === 0xFF && (mp3[1] & 0xE0) === 0xE0, 'MP3 프레임 싱크');
  assert.equal(mp3.length, complete.data.files[0].size);
});

test('saveToFolder: 폴더 권한이 granted가 아니면 이번 녹화는 기존처럼 다운로드로 저장하고 warning을 붙인다 (offscreen은 권한을 요청하지 않음)', async () => {
  const userDir = new FakeDirectoryHandle('Recordings', { permission: 'prompt' });
  await useSaveFolder(userDir);
  installVideoFakes(4);
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'mp3', videoFormat: 'mp4' });
  const complete = await recordToFolder({ plan, audioFormat: 'mp3' });

  const downloads = sentOf(MESSAGE_TYPES.DOWNLOAD_FILE);
  assert.deepEqual(downloads.map(d => d.data.filename), [`${BASE}.mp4`, `${BASE}.mp3`], '기존 다운로드 경로');
  assert.equal(complete.data.savedTo, 'downloads');
  assert.ok(complete.data.files.every(f => f.savedTo === 'downloads' && f.location === null));
  assert.match(complete.data.warning, /권한/);
  assert.match(complete.data.warning, /다운로드/);
  assert.deepEqual(userDir.fileNames(), [], '폴더에는 아무것도 쓰지 않음');
  assert.equal(userDir.permissionRequests.length, 0, '사용자 제스처가 없는 offscreen에서는 requestPermission을 부르지 않음');
});

test('saveToFolder: createWritable이 거부되면(권한 오류) 빈 파일을 지우고 이번 녹화 전체를 다운로드로 저장하며 warning을 붙인다', async () => {
  const userDir = new FakeDirectoryHandle('Recordings');
  userDir.faults = { createWritable: new DOMException('The request is not allowed by the user agent', 'NotAllowedError') };
  await useSaveFolder(userDir);
  installVideoFakes(4);
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'mp4' });
  const complete = await recordToFolder({ plan, audioFormat: 'wav' });

  assert.equal(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).length, 2);
  assert.equal(complete.data.savedTo, 'downloads');
  assert.match(complete.data.warning, /NotAllowedError|허용/);
  assert.deepEqual(userDir.fileNames(), [], 'getFileHandle(create)로 생긴 빈 파일 정리');
  assert.ok(!sentOf(MESSAGE_TYPES.RECORDING_ERROR).length);
});

test('saveToFolder(AVI): 영상 단일 파일 모드에서 중지 시 폴더 기록이 거부되면 영상만 저장소로 머싱해 다운로드한다 (AVI는 중지 시 머싱)', async () => {
  const userDir = new FakeDirectoryHandle('Recordings');
  await useSaveFolder(userDir);
  installVideoFakes(4);
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'avi' });
  const complete = await recordToFolder({
    plan,
    audioFormat: 'mp3',
    between: async () => { userDir.faults = { createWritable: new DOMException('denied', 'NotAllowedError') }; }
  });
  const downloads = sentOf(MESSAGE_TYPES.DOWNLOAD_FILE);
  assert.deepEqual(downloads.map(d => d.data.filename), [`${BASE}.avi`]);
  assert.equal(complete.data.files[0].savedTo, 'downloads');
  assert.match(complete.data.warning, /다운로드/);
  assert.deepEqual(userDir.fileNames(), []);
});

test('saveToFolder(MOV): 녹화 시작 때 폴더에 영상 파일을 열지 못하면(createWritable 거부) 영상은 OPFS에 바로 기록해 다운로드하고 warning을 붙인다', async () => {
  installFakeOpfs();
  const userDir = new FakeDirectoryHandle('Recordings');
  userDir.faults = { createWritable: new DOMException('denied', 'NotAllowedError') };
  await useSaveFolder(userDir);
  installVideoFakes(4);
  try {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'mov' });
    const complete = await recordToFolder({ plan, audioFormat: 'mp3' });
    assert.deepEqual(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).map(d => d.data.filename), [`${BASE}.mov`]);
    assert.equal(complete.data.files[0].savedTo, 'downloads');
    assert.match(complete.data.warning, /영상 파일/);
    assert.match(complete.data.warning, /다운로드/);
    assert.deepEqual(userDir.fileNames(), [], '빈 대상 파일 정리');
  } finally {
    delete globalThis.navigator.storage;
  }
});

for (const [format, ext] of [['mp4', 'mp4'], ['mov', 'mov'], ['fmp4', 'mp4']]) {
  test(`saveToFolder(${format}): 녹화 시작 때 폴더에 영상 파일(.${ext})을 만들어 녹화 중 바로 기록하고, OPFS에는 영상 데이터(청크 저장소)를 두지 않으며 중지 시 moov/마지막 조각만 쓴다`, async () => {
    const opfsRoot = installFakeOpfs();
    const userDir = new FakeDirectoryHandle('Recordings');
    await useSaveFolder(userDir);
    installVideoFakes(6);
    const spy = spyCreatedFiles();
    try {
      const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: format });
      let duringRecording = null;
      const complete = await recordToFolder({
        plan,
        audioFormat: 'wav',
        between: async () => {
          const base = await opfsRoot.getDirectoryHandle(OPFS_ROOT_DIR);
          const sessions = [];
          for await (const k of base.keys()) sessions.push(k);
          const dir = await base.getDirectoryHandle(sessions[0]);
          duringRecording = { folder: userDir.fileNames(), opfs: dir.fileNames() };
        }
      });
      assert.deepEqual(duringRecording.folder, [`${BASE}.${ext}`, `${BASE}.wav`], '녹화 중에 이미 폴더에 두 파일');
      assert.deepEqual(duringRecording.opfs, ['audio.wav'], `OPFS에는 오디오 예비본만 (video.bin·container-audio.bin 없음): ${duringRecording.opfs}`);
      assert.ok(!spy.created.some(n => /video\.bin|container-audio\.bin|\/video\.(mp4|mov)$/.test(n)), `OPFS에 영상 파일을 만들지 않음: ${spy.created}`);
      assert.equal(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).length, 0);
      assert.equal(complete.data.savedTo, 'folder');
      assert.equal(complete.data.warning, undefined);
      assert.deepEqual(complete.data.files.map(f => [f.kind, f.format, f.filename, f.label, f.savedTo]), [
        ['video', format, `${BASE}.${ext}`, format === 'mov' ? 'MOV' : 'MP4', 'folder'],
        ['audio', 'wav', `${BASE}.wav`, 'WAV', 'folder']
      ]);
      const video = await fileBytesOf(userDir, `${BASE}.${ext}`);
      assert.equal(video.length, complete.data.files[0].size);
      assert.equal(asciiOf(video, 4, 12), `ftyp${format === 'mov' ? 'qt  ' : format === 'fmp4' ? 'iso5' : 'isom'}`);
      const t = complete.data.timings;
      for (const k of ['encoderMs', 'containerAudioMs', 'planMs', 'writeMs', 'closeMs']) assert.equal(typeof (t.video && t.video[k]), 'number', `timings.video.${k}`);
    } finally {
      spy.restore();
      delete globalThis.navigator.storage;
    }
  });
}

test('fMP4(다운로드 저장): 파일명은 .mp4, RECORDING_COMPLETE에는 format fmp4와 표시 이름 MP4', async () => {
  installVideoFakes(4);
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'fmp4' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'fm', format: 'mp3', bitrate: 128, sampleRate: 44100, plan, startTime: LOCAL_START } });
  assert.equal(res.success, true, res.error);
  feedAudio(3);
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);
  assert.deepEqual(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).map(d => [d.data.filename, d.data.format]), [[`${BASE}.mp4`, 'fmp4']]);
  const complete = sentOf(MESSAGE_TYPES.RECORDING_COMPLETE)[0];
  assert.deepEqual(complete.data.files.map(f => [f.format, f.label, f.filename]), [['fmp4', 'MP4', `${BASE}.mp4`]]);
});

test('녹화 중 영상 파일 쓰기가 실패하면(fMP4, 영상 단일 파일) STOP_CAPTURE 없이 스스로 녹화를 멈추고 RECORDING_ERROR(VIDEO_WRITE_FAILED)를 보내며 폴더의 실패한 파일을 지운다', async () => {
  const userDir = new FakeDirectoryHandle('USB');
  await useSaveFolder(userDir);
  installVideoFakes(1);
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'fmp4' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'wf', format: 'mp3', bitrate: 128, sampleRate: 44100, plan, startTime: LOCAL_START, saveToFolder: true } });
  assert.equal(res.success, true, res.error);
  feedAudio(2);
  await flush();
  assert.deepEqual(userDir.fileNames(), [`${BASE}.mp4`]);
  fake.calls.sendMessage.length = 0;
  userDir.faults = { failWritesAfter: 0 }; // 드라이브 분리·권한 회수
  for (const t of [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000]) frameReader.push(new FakeVideoFrame({ timestamp: t })); // 2.2초 넘김 → 조각 기록 시도
  await flush(400);
  const errors = sentOf(MESSAGE_TYPES.RECORDING_ERROR);
  assert.equal(errors.length, 1, `스스로 중지하고 오류 보고: ${fake.calls.sendMessage.map(m => m.action)}`);
  assert.ok(errors[0].data.error.includes(ERROR_MESSAGES.VIDEO_WRITE_FAILED), errors[0].data.error);
  assert.equal(sentOf(MESSAGE_TYPES.RECORDING_COMPLETE).length, 0);
  assert.deepEqual(userDir.fileNames(), [], '완성할 수 없는 파일은 지움');
  // 이미 멈췄으므로 이후 STOP_CAPTURE는 아무 일도 하지 않음
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(100);
  assert.equal(sentOf(MESSAGE_TYPES.RECORDING_ERROR).length + sentOf(MESSAGE_TYPES.RECORDING_COMPLETE).length, 0);
});

test('녹화 중 영상 파일 쓰기가 실패하면(fMP4 분리 저장, 폴더) 스스로 멈추고 오디오 파일은 OPFS 예비본으로 저장한 뒤 VIDEO_WRITE_FAILED 경고를 붙인다', async () => {
  installFakeOpfs();
  const userDir = new FakeDirectoryHandle('USB');
  await useSaveFolder(userDir);
  installVideoFakes(1);
  workletPorts = [];
  try {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'fmp4' });
    const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'wf2', format: 'wav', bitrate: 128, sampleRate: 44100, plan, startTime: LOCAL_START, saveToFolder: true } });
    assert.equal(res.success, true, res.error);
    feedAudio(4);
    await flush();
    fake.calls.sendMessage.length = 0;
    userDir.faults = { failWritesAfter: 0 };
    for (const t of [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000]) frameReader.push(new FakeVideoFrame({ timestamp: t }));
    await flush(500);
    const complete = sentOf(MESSAGE_TYPES.RECORDING_COMPLETE)[0];
    assert.ok(complete, `스스로 중지 후 오디오 파일 저장: ${fake.calls.sendMessage.map(m => m.action)}`);
    assert.deepEqual(complete.data.files.map(f => [f.kind, f.filename, f.savedTo]), [['audio', `${BASE}.wav`, 'downloads']]);
    assert.ok(complete.data.warning.includes(ERROR_MESSAGES.VIDEO_WRITE_FAILED), complete.data.warning);
    assert.match(complete.data.warning, /오디오 파일만 저장/);
    assert.deepEqual(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).map(d => d.data.filename), [`${BASE}.wav`]);
    assert.ok(!sentOf(MESSAGE_TYPES.RECORDING_ERROR).length);
    assert.deepEqual(userDir.fileNames(), [], '실패한 폴더 파일 정리');
  } finally {
    delete globalThis.navigator.storage;
  }
});

test('saveToFolder: 저장 폴더 핸들이 없으면(설정이 지워짐) 다운로드로 저장하고 warning을 붙인다', async () => {
  await useSaveFolder(null);
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const complete = await recordToFolder({ plan, audioFormat: 'mp3' });
  assert.equal(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).length, 1);
  assert.equal(complete.data.savedTo, 'downloads');
  assert.match(complete.data.warning, /폴더/);
});

test('saveToFolder(AVI): 녹화 중 폴더 쓰기가 실패해도(권한 회수·드라이브 분리) 오디오는 OPFS 예비본으로, 영상은 청크 저장소에서 다시 머싱해 다운로드하므로 데이터가 손실되지 않는다', async () => {
  installFakeOpfs();
  const userDir = new FakeDirectoryHandle('USB');
  await useSaveFolder(userDir);
  installVideoFakes(6);
  try {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'avi' });
    const complete = await recordToFolder({
      plan,
      audioFormat: 'wav',
      chunks: 20, // 256KB 쓰기 버퍼를 넘겨 녹화 중에 폴더로 한 번 기록됨
      // 이후 폴더 쓰기는 모두 실패: 15청크(240KB)를 더 넣어 녹화 도중에 실패하는 쓰기가 생기게 함
      between: async () => { userDir.faults = { failWritesAfter: 0 }; feedAudio(15); await flush(); }
    });
    assert.ok(complete, 'RECORDING_COMPLETE');
    assert.ok(!sentOf(MESSAGE_TYPES.RECORDING_ERROR).length, '오류가 아니라 경고');
    const downloads = sentOf(MESSAGE_TYPES.DOWNLOAD_FILE);
    assert.deepEqual(downloads.map(d => d.data.filename), [`${BASE}.avi`, `${BASE}.wav`]);
    assert.ok(complete.data.files.every(f => f.savedTo === 'downloads'));
    const wav = complete.data.files.find(f => f.kind === 'audio');
    assert.equal(wav.size, 44 + (35 * 4096 + 1024) * 4, '예비본에는 처음부터 끝까지 모든 PCM');
    assert.match(complete.data.warning, /오디오 파일을 기록하던 중/, '첫 원인(오디오 쓰기 실패)을 알림');
    assert.match(complete.data.warning, /다운로드/);
    assert.deepEqual(userDir.fileNames(), [], '실패한 폴더 파일 정리');
  } finally {
    delete globalThis.navigator.storage;
  }
});

test('saveToFolder(MP4): 녹화 중 폴더 쓰기가 실패하면 오디오는 OPFS 예비본으로 다운로드하고, 녹화 중 바로 쓰던 영상 파일은 완성할 수 없어 지운 뒤 VIDEO_WRITE_FAILED로 알린다', async () => {
  installFakeOpfs();
  const userDir = new FakeDirectoryHandle('USB');
  await useSaveFolder(userDir);
  installVideoFakes(6);
  try {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'mp4' });
    const complete = await recordToFolder({
      plan,
      audioFormat: 'wav',
      chunks: 20,
      between: async () => { userDir.faults = { failWritesAfter: 0 }; feedAudio(15); await flush(); }
    });
    assert.ok(complete, 'RECORDING_COMPLETE (오디오 파일)');
    assert.ok(!sentOf(MESSAGE_TYPES.RECORDING_ERROR).length);
    assert.deepEqual(complete.data.files.map(f => [f.kind, f.savedTo]), [['audio', 'downloads']]);
    assert.equal(complete.data.files[0].size, 44 + (35 * 4096 + 1024) * 4, '예비본에는 처음부터 끝까지 모든 PCM');
    assert.ok(complete.data.warning.includes(ERROR_MESSAGES.VIDEO_WRITE_FAILED), complete.data.warning);
    assert.match(complete.data.warning, /오디오 파일을 기록하던 중/);
    assert.deepEqual(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).map(d => d.data.filename), [`${BASE}.wav`]);
    assert.deepEqual(userDir.fileNames(), [], '실패한 폴더 파일 정리');
  } finally {
    delete globalThis.navigator.storage;
  }
});

test('saveToFolder: 폴더에 같은 이름의 파일이 있으면 덮어쓰지 않고 " (1)"을 붙여 두 파일이 같은 새 이름을 공유한다', async () => {
  const userDir = new FakeDirectoryHandle('Recordings');
  const existing = await userDir.getFileHandle(`${BASE}.wav`, { create: true });
  existing.content = new Uint8Array([1, 2, 3]);
  await useSaveFolder(userDir);
  installVideoFakes(4);
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'mp4' });
  const complete = await recordToFolder({ plan, audioFormat: 'wav' });
  assert.deepEqual(complete.data.files.map(f => f.filename), [`${BASE} (1).mp4`, `${BASE} (1).wav`]);
  assert.deepEqual(userDir.fileNames(), [`${BASE} (1).mp4`, `${BASE} (1).wav`, `${BASE}.wav`]);
  assert.deepEqual(Array.from(existing.content), [1, 2, 3], '기존 파일은 그대로');
});

test('saveToFolder가 없으면(기본) 파일명도 녹화 시작 시각 기준이고 savedTo는 downloads다', async () => {
  workletPorts = [];
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'mp3' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_CAPTURE, data: { streamId: 'dl', format: 'mp3', bitrate: 128, sampleRate: 44100, plan, startTime: LOCAL_START } });
  assert.equal(res.success, true, res.error);
  feedAudio(2);
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_CAPTURE });
  await flush(300);
  assert.deepEqual(sentOf(MESSAGE_TYPES.DOWNLOAD_FILE).map(d => d.data.filename), [`${BASE}.mp3`]);
  const complete = sentOf(MESSAGE_TYPES.RECORDING_COMPLETE)[0];
  assert.equal(complete.data.savedTo, 'downloads');
  assert.deepEqual(complete.data.files.map(f => [f.savedTo, f.location]), [['downloads', null]]);
  assert.equal(complete.data.warning, undefined);
});
