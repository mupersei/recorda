// Background 일시정지/재개 상태 머신 테스트 (IDLE → RECORDING ⇄ PAUSED → PROCESSING)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { MESSAGE_TYPES, RECORDING_MODES, RECORDING_STATES, SETTINGS, ERROR_MESSAGES } from '../constants.js';

const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));
let instance = 0;
async function freshBackground(options = {}, prepare = null) {
  const fake = installFakeChrome(options);
  if (prepare) await prepare(fake);
  await import(`../background.js?pause-instance=${++instance}`);
  await flush(20);
  return fake;
}

// Date.now 고정 시계 (Background의 startTime / pausedAt / 경과 시간 계산이 모두 Date.now 기준)
const realNow = Date.now;
let clock = 0;
function useClock(start) { clock = start; Date.now = () => clock; }
const advance = (ms) => { clock += ms; };
afterEach(() => { Date.now = realNow; });

const VIDEO_PLAN = { mode: RECORDING_MODES.VIDEO_AUDIO, captureVideo: true, outputs: [{ kind: 'video', format: 'mp4', audioCodec: 'mp3' }] };
const startAt = async (fake, data = { tabId: 1, mode: RECORDING_MODES.VIDEO_AUDIO }) => {
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data });
  assert.equal(res.success, true, res.error);
  return res;
};
const sent = (fake, action) => fake.calls.sendMessage.filter(m => m.action === action);
const alarmCalls = (fake, kind) => fake.calls.alarms.filter(a => a[0] === kind && a[1] === 'updateTime');

test('RECORDING에서 PAUSE_RECORDING → PAUSED: Offscreen에 PAUSE_CAPTURE, 세션에 pausedAt 저장, 배지 II, 시간 알람 중지, STATE_CHANGED(paused)', async () => {
  useClock(1_000_000);
  const fake = await freshBackground();
  await startAt(fake);
  advance(8_000);
  fake.calls.sendMessage.length = 0;
  fake.calls.alarms.length = 0;

  const res = await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_RECORDING });
  assert.equal(res.success, true, res.error);
  assert.equal(res.data.state, RECORDING_STATES.PAUSED, '응답에 최신 상태 포함');

  const pc = sent(fake, MESSAGE_TYPES.PAUSE_CAPTURE);
  assert.equal(pc.length, 1, 'PAUSE_CAPTURE 1회');
  assert.equal(pc[0].data.pausedAt, 1_008_000);
  assert.equal(pc[0].data.pausedTotalMs, 0);

  const saved = fake.chrome.__session.recordingState;
  assert.equal(saved.state, RECORDING_STATES.PAUSED);
  assert.equal(saved.pausedAt, 1_008_000);
  assert.equal(saved.pausedTotalMs, 0);
  assert.equal(saved.startTime, 1_000_000);

  assert.equal(fake.calls.badges.at(-1), SETTINGS.BADGE_TEXT_PAUSED);
  assert.equal(SETTINGS.BADGE_TEXT_PAUSED, 'II');
  assert.equal(alarmCalls(fake, 'clear').length, 1, '일시정지 중에는 시간 갱신 알람 중지');

  const sc = sent(fake, MESSAGE_TYPES.STATE_CHANGED).at(-1);
  assert.ok(sc, 'STATE_CHANGED 전송');
  assert.equal(sc.data.state, RECORDING_STATES.PAUSED);
  assert.equal(sc.data.paused, true);
  assert.equal(sc.data.isRecording, false);
  assert.equal(sc.data.elapsed, 8);
});

test('PAUSED 동안 경과 시간은 멈추고, RESUME 후에는 일시정지 시간을 뺀 값으로 이어진다 (GET_STATE / UPDATE_TIME / effectiveStartTime)', async () => {
  useClock(1_000_000);
  const fake = await freshBackground();
  await startAt(fake);
  advance(8_000);
  await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_RECORDING });
  advance(4_000);

  let state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.state, RECORDING_STATES.PAUSED);
  assert.equal(state.paused, true);
  assert.equal(state.elapsed, 8, '일시정지 중 경과 시간 고정');
  assert.equal(state.pausedTotalMs, 0);
  assert.equal(state.effectiveStartTime, 1_000_000);

  fake.calls.sendMessage.length = 0;
  fake.fireAlarm('updateTime');
  await flush();
  assert.equal(sent(fake, MESSAGE_TYPES.UPDATE_TIME).length, 0, '일시정지 중에는 UPDATE_TIME을 보내지 않음');

  fake.calls.alarms.length = 0;
  const res = await fake.dispatch({ action: MESSAGE_TYPES.RESUME_RECORDING });
  assert.equal(res.success, true, res.error);
  assert.equal(res.data.state, RECORDING_STATES.RECORDING);
  const rc = sent(fake, MESSAGE_TYPES.RESUME_CAPTURE);
  assert.equal(rc.length, 1, 'RESUME_CAPTURE 1회');
  assert.equal(rc[0].data.pausedTotalMs, 4_000);
  const saved = fake.chrome.__session.recordingState;
  assert.equal(saved.state, RECORDING_STATES.RECORDING);
  assert.equal(saved.pausedAt, null);
  assert.equal(saved.pausedTotalMs, 4_000);
  assert.equal(fake.calls.badges.at(-1), SETTINGS.BADGE_TEXT_RECORDING);
  assert.equal(alarmCalls(fake, 'create').length, 1, '재개 시 시간 갱신 알람 다시 등록');
  const sc = sent(fake, MESSAGE_TYPES.STATE_CHANGED).at(-1);
  assert.equal(sc.data.state, RECORDING_STATES.RECORDING);
  assert.equal(sc.data.paused, false);
  assert.equal(sc.data.isRecording, true);

  advance(3_000);
  state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.elapsed, 11, '8초 + 재개 후 3초 (일시정지 4초 제외)');
  assert.equal(state.pausedTotalMs, 4_000);
  assert.equal(state.effectiveStartTime, 1_004_000, 'startTime + pausedTotalMs (Popup 자체 타이머 기준)');
  assert.equal(state.startTime, 1_000_000, '원래 startTime은 유지');

  fake.calls.sendMessage.length = 0;
  fake.fireAlarm('updateTime');
  await flush();
  const ut = sent(fake, MESSAGE_TYPES.UPDATE_TIME);
  assert.equal(ut.length, 1);
  assert.equal(ut[0].data.elapsed, 11, 'UPDATE_TIME도 일시정지 시간 제외');
});

test('일시정지를 여러 번 하면 pausedTotalMs가 누적된다', async () => {
  useClock(5_000_000);
  const fake = await freshBackground();
  await startAt(fake);
  for (const [run, pause] of [[2_000, 1_000], [3_000, 2_500]]) {
    advance(run);
    assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_RECORDING })).success, true);
    advance(pause);
    assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.RESUME_RECORDING })).success, true);
  }
  advance(1_000);
  const state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.pausedTotalMs, 3_500);
  assert.equal(state.elapsed, 6);
  assert.equal(fake.chrome.__session.recordingState.pausedTotalMs, 3_500);
});

test('PAUSE는 RECORDING에서만, RESUME은 PAUSED에서만 허용되고, 거부되면 Offscreen에 아무것도 보내지 않는다', async () => {
  useClock(1_000_000);
  const fake = await freshBackground();
  const expectRejected = async (action, pattern) => {
    fake.calls.sendMessage.length = 0;
    const res = await fake.dispatch({ action });
    assert.equal(res.success, false, `${action}는 거부되어야 함`);
    assert.match(res.error, pattern);
    assert.equal(sent(fake, MESSAGE_TYPES.PAUSE_CAPTURE).length + sent(fake, MESSAGE_TYPES.RESUME_CAPTURE).length, 0);
  };
  // IDLE
  await expectRejected(MESSAGE_TYPES.PAUSE_RECORDING, new RegExp(ERROR_MESSAGES.NOT_RECORDING));
  await expectRejected(MESSAGE_TYPES.RESUME_RECORDING, new RegExp(ERROR_MESSAGES.NOT_PAUSED));
  // RECORDING: RESUME 거부
  await startAt(fake);
  await expectRejected(MESSAGE_TYPES.RESUME_RECORDING, new RegExp(ERROR_MESSAGES.NOT_PAUSED));
  assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data.state, RECORDING_STATES.RECORDING);
  // PAUSED: PAUSE 중복 거부 (pausedAt 유지)
  await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_RECORDING });
  advance(1_000);
  await expectRejected(MESSAGE_TYPES.PAUSE_RECORDING, new RegExp(ERROR_MESSAGES.NOT_RECORDING));
  assert.equal(fake.chrome.__session.recordingState.pausedAt, 1_000_000);
  // PROCESSING: 둘 다 거부
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  await expectRejected(MESSAGE_TYPES.PAUSE_RECORDING, new RegExp(ERROR_MESSAGES.NOT_RECORDING));
  await expectRejected(MESSAGE_TYPES.RESUME_RECORDING, new RegExp(ERROR_MESSAGES.NOT_PAUSED));
  assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data.state, RECORDING_STATES.PROCESSING);
});

test('PAUSED에서 START는 ALREADY_RECORDING으로 거부되고 PAUSED가 유지된다 (START는 IDLE에서만)', async () => {
  useClock(1_000_000);
  const fake = await freshBackground();
  await startAt(fake);
  await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_RECORDING });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  assert.equal(res.success, false);
  assert.equal(res.error, ERROR_MESSAGES.ALREADY_RECORDING);
  const state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.state, RECORDING_STATES.PAUSED);
  assert.equal(fake.calls.badges.at(-1), SETTINGS.BADGE_TEXT_PAUSED);
});

test('PAUSED에서 STOP → PROCESSING으로 전환해 STOP_CAPTURE를 보내고, 완료 후 IDLE로 돌아가며 일시정지 기록을 초기화한다', async () => {
  useClock(1_000_000);
  const fake = await freshBackground();
  await startAt(fake);
  advance(5_000);
  await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_RECORDING });
  advance(10_000);
  fake.calls.sendMessage.length = 0;

  const stop = await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  assert.equal(stop.success, true, stop.error);
  assert.equal(sent(fake, MESSAGE_TYPES.STOP_CAPTURE).length, 1);
  const sc = sent(fake, MESSAGE_TYPES.STATE_CHANGED).at(-1);
  assert.equal(sc.data.state, RECORDING_STATES.PROCESSING);
  assert.equal(sc.data.elapsed, 5, '처리 중 표시 시간도 일시정지 제외');
  const saved = fake.chrome.__session.recordingState;
  assert.equal(saved.state, RECORDING_STATES.PROCESSING);
  assert.equal(saved.pausedAt, null, '진행 중이던 일시정지는 누적 시간으로 정리');
  assert.equal(saved.pausedTotalMs, 10_000);

  await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_COMPLETE, data: { success: true, files: [] } });
  await flush();
  const done = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(done.state, RECORDING_STATES.IDLE);
  assert.equal(done.paused, false);
  assert.equal(done.pausedTotalMs, 0);
  assert.equal(fake.chrome.__session.recordingState.pausedTotalMs, 0);
  assert.equal(fake.calls.badges.at(-1), SETTINGS.BADGE_TEXT_IDLE);
});

test('일시정지 중 녹화 탭이 닫히면 STOP_CAPTURE를 보내 녹화를 마무리한다', async () => {
  useClock(1_000_000);
  const fake = await freshBackground();
  await startAt(fake, { tabId: 42, mode: RECORDING_MODES.VIDEO_AUDIO });
  await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_RECORDING });
  fake.calls.sendMessage.length = 0;
  fake.fireTabRemoved(42);
  await flush();
  assert.equal(sent(fake, MESSAGE_TYPES.STOP_CAPTURE).length, 1);
  assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data.state, RECORDING_STATES.PROCESSING);
});

test('SW 재시작: 세션에 PAUSED가 있고 Offscreen이 살아 있으면 PAUSED로 복원하고(배지 II, 시간 알람 없음) 이어서 RESUME할 수 있다', async () => {
  useClock(2_000_000);
  const saved = { state: RECORDING_STATES.PAUSED, tabId: 3, startTime: 1_970_000, pausedAt: 1_990_000, pausedTotalMs: 5_000, plan: VIDEO_PLAN, mode: VIDEO_PLAN.mode, format: 'mp3' };
  const fake = await freshBackground({ offscreenExists: true }, async (f) => { f.chrome.__session.recordingState = saved; });
  const state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.state, RECORDING_STATES.PAUSED);
  assert.equal(state.paused, true);
  assert.equal(state.elapsed, 15, '(pausedAt - startTime - pausedTotalMs) = 15초');
  assert.equal(state.pausedTotalMs, 5_000);
  assert.ok(fake.calls.badges.includes(SETTINGS.BADGE_TEXT_PAUSED), '복원 시 배지 II');
  assert.equal(alarmCalls(fake, 'create').length, 0, '일시정지 상태로 복원하면 시간 알람을 만들지 않음');

  const res = await fake.dispatch({ action: MESSAGE_TYPES.RESUME_RECORDING });
  assert.equal(res.success, true, res.error);
  assert.equal(sent(fake, MESSAGE_TYPES.RESUME_CAPTURE)[0].data.pausedTotalMs, 15_000, '5초 + 복원 전 일시정지 10초');
  assert.equal(fake.chrome.__session.recordingState.state, RECORDING_STATES.RECORDING);
});

test('SW 재시작: 세션에 PAUSED가 있어도 Offscreen 문서가 없으면 IDLE로 정리한다', async () => {
  useClock(2_000_000);
  const fake = await freshBackground({ offscreenExists: false }, async (f) => {
    f.chrome.__session.recordingState = { state: RECORDING_STATES.PAUSED, tabId: 3, startTime: 1_970_000, pausedAt: 1_990_000, pausedTotalMs: 0, plan: VIDEO_PLAN, mode: VIDEO_PLAN.mode, format: 'mp3' };
  });
  const state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.state, RECORDING_STATES.IDLE);
  assert.equal(fake.chrome.__session.recordingState.state, RECORDING_STATES.IDLE);
});

test('RECORDING_HEARTBEAT(paused)로 SW가 잃어버린 상태를 PAUSED로 복구한다 (pausedAt, pausedTotalMs 포함)', async () => {
  useClock(3_000_000);
  const fake = await freshBackground({ offscreenExists: true });
  const hb = await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_HEARTBEAT, data: { tabId: 3, startTime: 2_940_000, plan: VIDEO_PLAN, format: 'mp3', paused: true, pausedAt: 2_980_000, pausedTotalMs: 10_000 } });
  assert.equal(hb.success, true);
  assert.equal(hb.state, RECORDING_STATES.PAUSED);
  const state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.state, RECORDING_STATES.PAUSED);
  assert.equal(state.elapsed, 30, '(40초 - 일시정지 10초)에서 고정');
  const saved = fake.chrome.__session.recordingState;
  assert.equal(saved.state, RECORDING_STATES.PAUSED);
  assert.equal(saved.pausedAt, 2_980_000);
  assert.equal(saved.pausedTotalMs, 10_000);
  assert.ok(fake.calls.badges.includes(SETTINGS.BADGE_TEXT_PAUSED));
  assert.equal(alarmCalls(fake, 'create').length, 0);

  advance(5_000);
  assert.equal((await fake.dispatch({ action: MESSAGE_TYPES.RESUME_RECORDING })).success, true);
  assert.equal(sent(fake, MESSAGE_TYPES.RESUME_CAPTURE)[0].data.pausedTotalMs, 35_000);
});

test('RECORDING_HEARTBEAT(재개 상태)로 복구할 때도 누적 일시정지 시간을 경과 시간에서 뺀다', async () => {
  useClock(3_000_000);
  const fake = await freshBackground({ offscreenExists: true });
  await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_HEARTBEAT, data: { tabId: 3, startTime: 2_940_000, plan: VIDEO_PLAN, format: 'mp3', paused: false, pausedAt: null, pausedTotalMs: 10_000 } });
  const state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.state, RECORDING_STATES.RECORDING);
  assert.equal(state.elapsed, 50);
  assert.equal(state.effectiveStartTime, 2_950_000);
  assert.equal(fake.calls.badges.at(-1), SETTINGS.BADGE_TEXT_RECORDING);
});

test('PAUSE_CAPTURE 응답이 실패면 PAUSE는 실패를 반환하고 RECORDING으로 되돌린다', async () => {
  useClock(1_000_000);
  const fake = await freshBackground();
  await startAt(fake);
  fake.chrome.__respondTo[MESSAGE_TYPES.PAUSE_CAPTURE] = async () => ({ success: false, error: '일시정지 실패 테스트' });
  advance(2_000);
  const res = await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_RECORDING });
  assert.equal(res.success, false);
  assert.match(res.error, /일시정지 실패 테스트/);
  const state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.state, RECORDING_STATES.RECORDING);
  assert.equal(state.elapsed, 2);
  const saved = fake.chrome.__session.recordingState;
  assert.equal(saved.state, RECORDING_STATES.RECORDING);
  assert.equal(saved.pausedAt, null);
  assert.equal(fake.calls.badges.at(-1), SETTINGS.BADGE_TEXT_RECORDING);
  assert.equal(fake.calls.alarms.filter(a => a[1] === 'updateTime').at(-1)[0], 'create', '시간 알람 복구');
});

test('RESUME_CAPTURE 응답이 실패면 RESUME은 실패를 반환하고 PAUSED(원래 pausedAt)를 유지한다', async () => {
  useClock(1_000_000);
  const fake = await freshBackground();
  await startAt(fake);
  advance(2_000);
  await fake.dispatch({ action: MESSAGE_TYPES.PAUSE_RECORDING });
  fake.chrome.__respondTo[MESSAGE_TYPES.RESUME_CAPTURE] = async () => ({ success: false, error: '재개 실패 테스트' });
  advance(3_000);
  const res = await fake.dispatch({ action: MESSAGE_TYPES.RESUME_RECORDING });
  assert.equal(res.success, false);
  assert.match(res.error, /재개 실패 테스트/);
  const state = (await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE })).data;
  assert.equal(state.state, RECORDING_STATES.PAUSED);
  assert.equal(state.elapsed, 2);
  const saved = fake.chrome.__session.recordingState;
  assert.equal(saved.state, RECORDING_STATES.PAUSED);
  assert.equal(saved.pausedAt, 1_002_000);
  assert.equal(saved.pausedTotalMs, 0);
  assert.equal(fake.calls.badges.at(-1), SETTINGS.BADGE_TEXT_PAUSED);
});

test('START 성공 응답에 상태 페이로드(startTime, effectiveStartTime)가 포함되어 Popup 타이머가 Background 시각 기준으로 시작한다 (일시정지 시 표시 시간 튐 방지)', async () => {
  useClock(7_000_000);
  const fake = await freshBackground();
  const res = await startAt(fake);
  assert.ok(res.data, 'START 응답에 상태 포함');
  assert.equal(res.data.state, RECORDING_STATES.RECORDING);
  assert.equal(res.data.startTime, 7_000_000);
  assert.equal(res.data.effectiveStartTime, 7_000_000);
  assert.equal(res.data.paused, false);
});
