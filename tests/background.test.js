import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { MESSAGE_TYPES, RECORDING_MODES, RECORDING_STATES } from '../constants.js';

const fake = installFakeChrome();
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));

before(async () => {
  await import('../background.js');
});

async function stopAndComplete(files) {
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_COMPLETE, data: { success: true, files } });
  await flush();
}

test('START_RECORDING은 모드/포맷을 녹화 계획으로 바꿔 Offscreen에 전달한다 (VIDEO_AUDIO_SPLIT + wav + avi)', async () => {
  fake.calls.sendMessage.length = 0;
  const res = await fake.dispatch({
    action: MESSAGE_TYPES.START_RECORDING,
    data: { tabId: 7, format: 'wav', mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, videoFormat: 'avi' }
  });
  assert.equal(res.success, true, res.error);
  assert.equal(fake.calls.lastTargetTabId, 7);

  const startCapture = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.START_CAPTURE);
  assert.ok(startCapture, 'START_CAPTURE 전송');
  assert.equal(startCapture.data.streamId, 'stream-123');
  assert.equal(startCapture.data.plan.captureVideo, true);
  assert.deepEqual(startCapture.data.plan.outputs, [
    { kind: 'video', format: 'avi', audioCodec: 'mp3' },
    { kind: 'audio', format: 'wav' }
  ]);

  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.RECORDING);
  assert.equal(state.data.mode, RECORDING_MODES.VIDEO_AUDIO_SPLIT);
  assert.equal(state.data.plan.outputs.length, 2);

  await stopAndComplete([]);
});

test('START_RECORDING은 모드가 없으면 기존처럼 오디오 전용 계획을 만든다', async () => {
  fake.calls.sendMessage.length = 0;
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 3, format: 'mp3' } });
  assert.equal(res.success, true, res.error);
  const startCapture = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.START_CAPTURE);
  assert.equal(startCapture.data.plan.captureVideo, false);
  assert.deepEqual(startCapture.data.plan.outputs, [{ kind: 'audio', format: 'mp3' }]);
  await stopAndComplete([]);
});

test('START_RECORDING은 잘못된 모드/영상 포맷을 거부하고 IDLE 상태를 유지한다', async () => {
  const bad1 = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1, mode: 'NOPE' } });
  assert.equal(bad1.success, false);
  assert.match(bad1.error, /모드/);
  const bad2 = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1, mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'mkv' } });
  assert.equal(bad2.success, false);
  assert.match(bad2.error, /영상 포맷/);
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.IDLE);
});

test('DOWNLOAD_FILE은 chrome.downloads.download를 호출하고 downloadId를 돌려준다', async () => {
  fake.calls.downloads.length = 0;
  const res = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/abc', filename: 'recorda_1.mp4' } });
  assert.equal(res.success, true);
  assert.equal(typeof res.downloadId, 'number');
  assert.equal(fake.calls.downloads[0].filename, 'recorda_1.mp4');
  assert.equal(fake.calls.downloads[0].saveAs, false);
  // 완료 처리해서 pending 비우기
  fake.fireDownloadChanged({ id: res.downloadId, state: { current: 'complete' } });
});

test('DOWNLOAD_FILE은 blob: 이외 URL이나 빈 파일명을 거부한다', async () => {
  const r1 = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'https://evil.example/x', filename: 'a.mp4' } });
  assert.equal(r1.success, false);
  const r2 = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/abc', filename: '' } });
  assert.equal(r2.success, false);
});

test('RECORDING_COMPLETE는 진행 중인 다운로드가 끝난 뒤에만 Offscreen을 닫고, Popup에 파일 목록을 알린다', async () => {
  const start = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 9, mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'mp4' } });
  assert.equal(start.success, true, start.error);

  const dl = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/vid', filename: 'recorda_2.mp4' } });
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });

  fake.calls.offscreen.length = 0;
  fake.calls.sendMessage.length = 0;
  const files = [{ kind: 'video', format: 'mp4', filename: 'recorda_2.mp4', size: 10 }];
  const completeRes = await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_COMPLETE, data: { success: true, files } });
  assert.equal(completeRes.success, true);
  await flush();

  const stateChanged = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.STATE_CHANGED);
  assert.ok(stateChanged, 'STATE_CHANGED 전송');
  assert.equal(stateChanged.data.state, RECORDING_STATES.IDLE);
  assert.deepEqual(stateChanged.data.files, files);

  assert.ok(!fake.calls.offscreen.some(c => c[0] === 'close'), '다운로드 완료 전에는 Offscreen을 닫지 않음');

  fake.fireDownloadChanged({ id: dl.downloadId, state: { current: 'complete' } });
  await flush();
  assert.ok(fake.calls.offscreen.some(c => c[0] === 'close'), '다운로드 완료 후 Offscreen 종료');

  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.IDLE);
  assert.deepEqual(state.data.plan, null);
});

test('RECORDING_COMPLETE에 warning이 있으면 상태를 IDLE로 되돌리면서 Popup에 ERROR 메시지로 경고를 전달한다', async () => {
  const start = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 11, mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT } });
  assert.equal(start.success, true, start.error);
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });

  fake.calls.sendMessage.length = 0;
  await fake.dispatch({
    action: MESSAGE_TYPES.RECORDING_COMPLETE,
    data: { success: true, files: [{ kind: 'audio', format: 'mp3', filename: 'a.mp3', size: 5 }], warning: '영상 저장 실패' }
  });
  await flush();

  const err = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.ERROR);
  assert.ok(err, 'ERROR 메시지 전송');
  assert.match(err.data.error, /영상 저장 실패/);
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.IDLE);
});
