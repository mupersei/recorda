// Background: 오디오 소스(탭 / 마이크 / 탭+마이크)를 START_RECORDING → START_CAPTURE로 전달
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { MESSAGE_TYPES, RECORDING_MODES, RECORDING_STATES, STORAGE_KEYS, DEFAULT_SETTINGS, ERROR_MESSAGES } from '../constants.js';

const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));
let instance = 0;
async function freshBackground(options = {}, prepare = null) {
  const fake = installFakeChrome(options);
  if (prepare) await prepare(fake);
  await import(`../background.js?audio-source=${++instance}`);
  await flush(20);
  return fake;
}
const startCaptureOf = (fake) => fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.START_CAPTURE).at(-1);

test('START_RECORDING의 audioSource / micDeviceId는 녹화 계획(START_CAPTURE.plan)으로 전달된다 (탭+마이크: 탭 스트림 ID도 발급)', async () => {
  const fake = await freshBackground();
  const res = await fake.dispatch({
    action: MESSAGE_TYPES.START_RECORDING,
    data: { tabId: 7, format: 'wav', mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, videoFormat: 'mp4', audioSource: 'tab+mic', micDeviceId: 'usb-1' }
  });
  assert.equal(res.success, true, res.error);
  const sc = startCaptureOf(fake);
  assert.equal(sc.data.streamId, 'stream-123');
  assert.equal(fake.calls.lastTargetTabId, 7);
  assert.equal(sc.data.plan.audioSource, 'tab+mic');
  assert.equal(sc.data.plan.captureTabAudio, true);
  assert.equal(sc.data.plan.captureMic, true);
  assert.equal(sc.data.plan.micDeviceId, 'usb-1');
  assert.equal(sc.data.plan.captureVideo, true);
  // 상태 영속화(SW 재시작 복구)에도 같은 계획
  assert.equal(fake.chrome.__session.recordingState.plan.audioSource, 'tab+mic');
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.plan.captureMic, true);
});

test('START_RECORDING에 audioSource가 없으면 저장된 설정(audioSource, micDeviceId)을 쓰고, 설정도 없으면 기본 탭 오디오', async () => {
  assert.equal(DEFAULT_SETTINGS.audioSource, 'tab');
  assert.equal(DEFAULT_SETTINGS.micDeviceId, '');
  const stored = await freshBackground({}, async (f) => {
    f.chrome.__storage[STORAGE_KEYS.SETTINGS] = { ...DEFAULT_SETTINGS, audioSource: 'tab+mic', micDeviceId: 'saved-mic' };
  });
  const r1 = await stored.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1, mode: RECORDING_MODES.AUDIO_ONLY, format: 'mp3' } });
  assert.equal(r1.success, true, r1.error);
  assert.equal(startCaptureOf(stored).data.plan.audioSource, 'tab+mic');
  assert.equal(startCaptureOf(stored).data.plan.micDeviceId, 'saved-mic');

  const plain = await freshBackground();
  const r2 = await plain.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1, mode: RECORDING_MODES.AUDIO_ONLY, format: 'mp3' } });
  assert.equal(r2.success, true, r2.error);
  const plan = startCaptureOf(plain).data.plan;
  assert.deepEqual([plan.audioSource, plan.captureTabAudio, plan.captureMic, plan.micDeviceId], ['tab', true, false, null], '기존 동작');
});

test('요청의 micDeviceId(빈 값 = 기본 마이크 포함)가 저장된 설정보다 우선한다', async () => {
  const fake = await freshBackground({}, async (f) => {
    f.chrome.__storage[STORAGE_KEYS.SETTINGS] = { ...DEFAULT_SETTINGS, micDeviceId: 'saved-mic' };
  });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1, mode: RECORDING_MODES.AUDIO_ONLY, audioSource: 'mic', micDeviceId: '' } });
  assert.equal(res.success, true, res.error);
  assert.equal(startCaptureOf(fake).data.plan.micDeviceId, null, '요청의 빈 값 = 시스템 기본 마이크');
});

test('오디오만 + 마이크는 탭에서 캡처할 것이 없으므로 tabCapture 스트림 ID를 발급하지 않는다 (chrome:// 탭처럼 캡처할 수 없는 탭에서도 시작 가능)', async () => {
  const fake = await freshBackground();
  fake.chrome.__streamIdError = 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.';
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 4, mode: RECORDING_MODES.AUDIO_ONLY, format: 'wav', audioSource: 'mic', micDeviceId: 'usb-1' } });
  assert.equal(res.success, true, res.error);
  assert.ok(!fake.calls.order.includes('getMediaStreamId'), 'getMediaStreamId 호출 없음');
  const sc = startCaptureOf(fake);
  assert.equal(sc.data.streamId, null);
  assert.equal(sc.data.plan.captureTabAudio, false);
  assert.equal(sc.data.plan.captureVideo, false);
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.RECORDING);
});

test('영상이 있으면 마이크 소스여도 영상 캡처용 스트림 ID를 발급한다 (영상은 항상 녹화를 시작한 탭에서)', async () => {
  for (const mode of [RECORDING_MODES.VIDEO_AUDIO, RECORDING_MODES.VIDEO_AUDIO_SPLIT]) {
    const fake = await freshBackground();
    const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 8, mode, format: 'wav', videoFormat: 'mp4', audioSource: 'mic' } });
    assert.equal(res.success, true, res.error);
    assert.ok(fake.calls.order.includes('getMediaStreamId'), mode);
    assert.equal(startCaptureOf(fake).data.streamId, 'stream-123');
    assert.equal(startCaptureOf(fake).data.plan.captureTabAudio, false);
  }
});

test('START_CAPTURE 응답의 경고(고른 마이크 대신 기본 마이크 등)를 START_RECORDING 응답 warnings로 팝업에 돌려준다', async () => {
  const fake = await freshBackground();
  fake.chrome.__respondTo[MESSAGE_TYPES.START_CAPTURE] = async () => ({ success: true, warnings: [ERROR_MESSAGES.MIC_FALLBACK_DEFAULT_START] });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 2, mode: RECORDING_MODES.AUDIO_ONLY, audioSource: 'tab+mic', micDeviceId: 'gone' } });
  assert.equal(res.success, true, res.error);
  assert.deepEqual(res.warnings, [ERROR_MESSAGES.MIC_FALLBACK_DEFAULT_START]);
  assert.equal(res.data.state, RECORDING_STATES.RECORDING);
  const quiet = await freshBackground();
  const r2 = await quiet.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 2, mode: RECORDING_MODES.AUDIO_ONLY } });
  assert.deepEqual(r2.warnings, [], '경고가 없으면 빈 배열');
});

test('Offscreen이 마이크 권한 없음으로 시작에 실패하면 START_RECORDING도 그 메시지로 실패하고 IDLE로 돌아간다', async () => {
  const fake = await freshBackground();
  fake.chrome.__respondTo[MESSAGE_TYPES.START_CAPTURE] = async () => ({ success: false, error: ERROR_MESSAGES.MIC_PERMISSION_DENIED });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 2, mode: RECORDING_MODES.AUDIO_ONLY, audioSource: 'mic' } });
  assert.equal(res.success, false);
  assert.equal(res.error, ERROR_MESSAGES.MIC_PERMISSION_DENIED);
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.IDLE);
});

test('잘못된 audioSource는 거부하고 IDLE을 유지한다', async () => {
  const fake = await freshBackground();
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 2, mode: RECORDING_MODES.AUDIO_ONLY, audioSource: 'speaker' } });
  assert.equal(res.success, false);
  assert.match(res.error, /오디오 소스/);
  assert.ok(!fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.START_CAPTURE));
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.IDLE);
});

test('녹화를 시작한 탭이 닫히면: 탭을 캡처하는 녹화는 마무리하고, 탭을 캡처하지 않는 녹화(오디오만 + 마이크)는 계속한다', async () => {
  const mic = await freshBackground();
  await mic.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 42, mode: RECORDING_MODES.AUDIO_ONLY, audioSource: 'mic' } });
  mic.calls.sendMessage.length = 0;
  mic.fireTabRemoved(42);
  await flush(50);
  assert.ok(!mic.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.STOP_CAPTURE), '마이크만 녹음은 탭과 무관');
  assert.equal((await mic.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data.state, RECORDING_STATES.RECORDING);

  const mix = await freshBackground();
  await mix.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 43, mode: RECORDING_MODES.AUDIO_ONLY, audioSource: 'tab+mic' } });
  mix.calls.sendMessage.length = 0;
  mix.fireTabRemoved(43);
  await flush(50);
  assert.ok(mix.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.STOP_CAPTURE), '탭 소리를 캡처하던 녹화는 마무리');

  const videoMic = await freshBackground();
  await videoMic.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 44, mode: RECORDING_MODES.VIDEO_AUDIO, audioSource: 'mic' } });
  videoMic.calls.sendMessage.length = 0;
  videoMic.fireTabRemoved(44);
  await flush(50);
  assert.ok(videoMic.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.STOP_CAPTURE), '영상을 캡처하던 녹화는 마무리');
});
