import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { MESSAGE_TYPES, RECORDING_MODES, RECORDING_STATES, SETTINGS } from '../constants.js';

const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));
let instance = 0;
// 매 테스트마다 새로운 chrome 전역 + 새로운 background 모듈 인스턴스(SW 재시작 흉내)
async function freshBackground(options = {}, prepare = null) {
  const fake = installFakeChrome(options);
  if (prepare) await prepare(fake);
  await import(`../background.js?instance=${++instance}`);
  await flush(20);
  return fake;
}

test('START 성공 시 상태를 chrome.storage.session에 저장하고, SW 재시작 후 복원한다', async () => {
  const fake = await freshBackground();
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 5, mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'mov' } });
  assert.equal(res.success, true, res.error);
  const saved = fake.chrome.__session.recordingState;
  assert.equal(saved.state, RECORDING_STATES.RECORDING);
  assert.equal(saved.tabId, 5);
  assert.equal(saved.plan.outputs[0].format, 'mov');

  // SW 재시작: 세션 스토리지에 상태가 있고 offscreen 문서가 살아 있으면 RECORDING으로 복원
  const fake2 = await freshBackground({ offscreenExists: true }, async (f) => { f.chrome.__session.recordingState = saved; });
  const state = await fake2.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.RECORDING);
  assert.equal(state.data.startTime, saved.startTime);
  assert.equal(state.data.plan.outputs[0].format, 'mov');
  assert.ok(fake2.calls.badges.includes(SETTINGS.BADGE_TEXT_RECORDING), '복원 시 배지도 REC');
  // 복원된 SW에서 STOP 가능
  const stop = await fake2.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  assert.equal(stop.success, true, stop.error);
});

test('SW 재시작 시 세션에 RECORDING이 있어도 offscreen 문서가 없으면 IDLE로 정리한다', async () => {
  const fake = await freshBackground({ offscreenExists: false }, async (f) => {
    f.chrome.__session.recordingState = { state: RECORDING_STATES.RECORDING, tabId: 1, startTime: Date.now() - 5000, plan: { mode: 'AUDIO_ONLY', captureVideo: false, outputs: [{ kind: 'audio', format: 'mp3' }] }, mode: 'AUDIO_ONLY', format: 'mp3', files: [] };
  });
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.IDLE);
  assert.equal(fake.chrome.__session.recordingState.state, RECORDING_STATES.IDLE);
});

test('Offscreen의 RECORDING_HEARTBEAT는 SW가 상태를 잃었을 때 녹화 상태를 복구한다', async () => {
  const fake = await freshBackground({ offscreenExists: true });
  const plan = { mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, captureVideo: true, outputs: [{ kind: 'video', format: 'mp4', audioCodec: 'mp3' }, { kind: 'audio', format: 'wav' }] };
  const res = await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_HEARTBEAT, data: { tabId: 3, startTime: Date.now() - 65_000, plan, format: 'wav' } });
  assert.equal(res.success, true);
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.RECORDING);
  assert.equal(state.data.mode, RECORDING_MODES.VIDEO_AUDIO_SPLIT);
  assert.ok(state.data.elapsed >= 65);
});

test('START_CAPTURE 응답이 실패면 START는 실패를 반환하고 상태는 IDLE로 유지된다', async () => {
  const fake = await freshBackground();
  fake.chrome.__respondTo[MESSAGE_TYPES.START_CAPTURE] = async () => ({ success: false, error: '캡처 실패 테스트' });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 2 } });
  assert.equal(res.success, false);
  assert.match(res.error, /캡처 실패 테스트/);
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.IDLE);
  assert.ok(!fake.calls.alarms.some(a => a[0] === 'create' && a[1] === 'updateTime'), '실패 시 알람을 만들지 않음');
});

test('녹음 중 두 번째 START는 ALREADY_RECORDING을 반환하고 기존 녹음 상태를 건드리지 않는다', async () => {
  const fake = await freshBackground();
  const first = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  assert.equal(first.success, true, first.error);
  const second = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  assert.equal(second.success, false);
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.RECORDING, '두 번째 START 실패가 첫 녹음을 IDLE로 되돌리면 안 됨');
  assert.equal(fake.calls.badges.at(-1), SETTINGS.BADGE_TEXT_RECORDING);
});

test('PROCESSING 중에도 START를 거부한다', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  assert.equal(res.success, false);
});

test('Offscreen 문서를 먼저 만들고 그 다음 getMediaStreamId를 호출한다 (스트림 ID 만료 방지)', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  assert.deepEqual(fake.calls.order.slice(0, 2), ['createDocument', 'getMediaStreamId']);
});

test('getMediaStreamId의 "not been invoked" 에러는 사용자 친화적 메시지로 바뀐다', async () => {
  const fake = await freshBackground();
  fake.chrome.__streamIdError = 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.';
  const res = await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  assert.equal(res.success, false);
  assert.ok(!/activeTab/.test(res.error), res.error);
  assert.match(res.error, /탭/);
});

test('RECORDING_ERROR 처리 후 Popup에 STATE_CHANGED(IDLE)를 보내 UI를 재동기화한다', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_ERROR, data: { error: '테스트 에러' } });
  await flush();
  const sc = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.STATE_CHANGED);
  assert.ok(sc, 'STATE_CHANGED 전송');
  assert.equal(sc.data.state, RECORDING_STATES.IDLE);
  assert.ok(fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.ERROR));
  assert.equal(fake.chrome.__session.recordingState.state, RECORDING_STATES.IDLE);
});

test('STATE_CHANGED에는 startTime이 포함된다 (Popup이 자체 타이머로 시간을 표시)', async () => {
  const fake = await freshBackground();
  fake.calls.sendMessage.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_STARTED });
  const sc = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.STATE_CHANGED);
  assert.equal(typeof sc.data.startTime, 'number');
});

test('다운로드 완료는 이벤트 기반으로 처리된다: 모두 complete되면 Offscreen을 닫고 파일별 결과가 담긴 최종 STATE_CHANGED를 보낸다', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1, mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT } });
  const d1 = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/a', filename: 'r.mp4' } });
  const d2 = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/b', filename: 'r.mp3' } });
  assert.ok(fake.chrome.__session.pendingDownloads, '대기 다운로드가 세션 스토리지에 기록됨');
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  fake.calls.sendMessage.length = 0;
  fake.calls.offscreen.length = 0;
  const files = [{ kind: 'video', format: 'mp4', filename: 'r.mp4', size: 10 }, { kind: 'audio', format: 'mp3', filename: 'r.mp3', size: 5 }];
  await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_COMPLETE, data: { success: true, files } });
  await flush();

  const first = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.STATE_CHANGED);
  assert.equal(first.data.state, RECORDING_STATES.IDLE);
  assert.equal(first.data.saving, true, '다운로드가 끝나기 전에는 saving=true');
  assert.ok(!fake.calls.offscreen.some(c => c[0] === 'close'));

  fake.fireDownloadChanged({ id: d1.downloadId, state: { current: 'complete' } });
  await flush();
  assert.ok(!fake.calls.offscreen.some(c => c[0] === 'close'), '하나만 끝났을 때는 아직 열어둠');
  fake.calls.sendMessage.length = 0;
  fake.fireDownloadChanged({ id: d2.downloadId, state: { current: 'interrupted' }, error: { current: 'FILE_FAILED' } });
  await flush();
  assert.ok(fake.calls.offscreen.some(c => c[0] === 'close'), '모두 끝나면 Offscreen 종료');
  const final = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.STATE_CHANGED);
  assert.ok(final, '최종 STATE_CHANGED');
  assert.equal(final.data.saving, false);
  assert.deepEqual(final.data.files.map(f => [f.filename, f.downloadState]), [['r.mp4', 'complete'], ['r.mp3', 'interrupted']]);
  assert.ok(fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.ERROR && /r\.mp3/.test(m.data.error)), '실패한 파일은 ERROR로 알림');
  assert.deepEqual(fake.chrome.__session.pendingDownloads, {}, '세션의 대기 목록이 비워짐');
});

test('SW가 재시작된 뒤 도착한 다운로드 완료 이벤트도 세션 스토리지로 처리해 Offscreen을 닫는다', async () => {
  const fake = await freshBackground({ offscreenExists: true }, async (f) => {
    f.chrome.__session.pendingDownloads = { 7: { filename: 'late.mp4', kind: 'video', format: 'mp4' } };
    f.chrome.__session.recordingState = { state: RECORDING_STATES.IDLE, tabId: null, startTime: null, plan: null, mode: 'AUDIO_ONLY', format: 'mp3', files: [] };
  });
  fake.fireDownloadChanged({ id: 7, state: { current: 'complete' } });
  await flush(50);
  assert.ok(fake.calls.offscreen.some(c => c[0] === 'close'));
});

test('다운로드 대기 타임아웃 알람이 울리면 남은 다운로드를 포기하고 Offscreen을 닫는다', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/a', filename: 'r.mp3' } });
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_COMPLETE, data: { success: true, files: [{ kind: 'audio', format: 'mp3', filename: 'r.mp3', size: 1 }] } });
  await flush();
  assert.ok(fake.calls.alarms.some(a => a[0] === 'create' && a[1] === 'downloadTimeout'), '타임아웃 알람 등록');
  fake.calls.offscreen.length = 0;
  fake.fireAlarm('downloadTimeout');
  await flush(50);
  assert.ok(fake.calls.offscreen.some(c => c[0] === 'close'));
});

test('녹화 중인 탭이 닫히면 STOP_CAPTURE를 보내 녹화를 마무리한다', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 42 } });
  fake.calls.sendMessage.length = 0;
  fake.fireTabRemoved(42);
  await flush();
  assert.ok(fake.calls.sendMessage.some(m => m.action === MESSAGE_TYPES.STOP_CAPTURE));
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.state, RECORDING_STATES.PROCESSING);
});

test('Offscreen 생성 reasons에 BLOBS가 포함된다', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  const create = fake.calls.offscreen.find(c => c[0] === 'create');
  assert.ok(create[1].reasons.includes('USER_MEDIA') && create[1].reasons.includes('BLOBS'));
});

test('두 다운로드의 완료 이벤트가 동시에 도착해도 대기 목록 갱신이 유실되지 않고 최종 알림이 간다 (read-modify-write 경합)', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1, mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT } });
  const d1 = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/a', filename: 'r.mp4' } });
  const d2 = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/b', filename: 'r.mp3' } });
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_COMPLETE, data: { success: true, files: [{ kind: 'video', format: 'mp4', filename: 'r.mp4', size: 1 }, { kind: 'audio', format: 'mp3', filename: 'r.mp3', size: 1 }] } });
  await flush();
  fake.calls.sendMessage.length = 0;
  fake.calls.offscreen.length = 0;
  // 같은 틱에 두 이벤트 발생
  fake.fireDownloadChanged({ id: d1.downloadId, state: { current: 'complete' } });
  fake.fireDownloadChanged({ id: d2.downloadId, state: { current: 'complete' } });
  await flush(80);
  assert.deepEqual(fake.chrome.__session.pendingDownloads, {}, '대기 목록이 비워져야 함');
  assert.ok(fake.calls.offscreen.some(c => c[0] === 'close'), 'Offscreen 종료');
  const final = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.STATE_CHANGED && m.data.saving === false);
  assert.ok(final, '최종 STATE_CHANGED(saving=false)');
  assert.deepEqual(final.data.files.map(f => f.downloadState), ['complete', 'complete']);
});

test('RECORDING_COMPLETE 시점에 이미 끝난 다운로드(이벤트 유실)는 downloads.search로 보정한다', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  const d1 = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/a', filename: 'r.mp3' } });
  // 이벤트 리스너를 거치지 않고 상태만 complete로 바꿈 (onChanged 유실 상황)
  const items = await fake.chrome.downloads.search({ id: d1.downloadId });
  items[0].state = 'complete';
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  fake.calls.sendMessage.length = 0;
  fake.calls.offscreen.length = 0;
  await fake.dispatch({ action: MESSAGE_TYPES.RECORDING_COMPLETE, data: { success: true, files: [{ kind: 'audio', format: 'mp3', filename: 'r.mp3', size: 1 }] } });
  await flush(80);
  assert.ok(fake.calls.offscreen.some(c => c[0] === 'close'));
  const final = fake.calls.sendMessage.find(m => m.action === MESSAGE_TYPES.STATE_CHANGED && m.data.saving === false);
  assert.ok(final, '보정 후 최종 STATE_CHANGED');
  assert.equal(final.data.files[0].downloadState, 'complete');
});


test('RECORDING_COMPLETE 처리 도중(세션 쓰기 대기 중) 다운로드 완료 이벤트가 끼어들어도 최종 상태는 saving=false로 끝난다 (완료 처리 직렬화)', async () => {
  const fake = await freshBackground();
  await fake.dispatch({ action: MESSAGE_TYPES.START_RECORDING, data: { tabId: 1 } });
  const d1 = await fake.dispatch({ action: MESSAGE_TYPES.DOWNLOAD_FILE, data: { url: 'blob:chrome-extension://x/a', filename: 'r.mp3', kind: 'audio', format: 'mp3' } });
  await fake.dispatch({ action: MESSAGE_TYPES.STOP_RECORDING });
  fake.calls.sendMessage.length = 0;

  // 세션 쓰기를 느리게 해서 handleRecordingComplete가 await 중일 때 onChanged(complete)가 처리되도록 함
  fake.chrome.__sessionSetDelayMs = 20;
  const p = fake.dispatch({ action: MESSAGE_TYPES.RECORDING_COMPLETE, data: { success: true, files: [{ kind: 'audio', format: 'mp3', filename: 'r.mp3', size: 1 }] } });
  await flush(5);
  fake.fireDownloadChanged({ id: d1.downloadId, state: { current: 'complete' } });
  await p;
  await flush(150);

  const stateChanges = fake.calls.sendMessage.filter(m => m.action === MESSAGE_TYPES.STATE_CHANGED && m.data.state === RECORDING_STATES.IDLE);
  assert.ok(stateChanges.length >= 1);
  const last = stateChanges[stateChanges.length - 1];
  assert.equal(last.data.saving, false, `마지막 STATE_CHANGED가 saving=false여야 함: ${JSON.stringify(last.data)}`);
  assert.equal(last.data.files[0].downloadState, 'complete');
  const state = await fake.dispatch({ action: MESSAGE_TYPES.GET_STATE });
  assert.equal(state.data.saving, false);
  assert.deepEqual(fake.chrome.__session.pendingDownloads || {}, {});
  assert.ok(fake.calls.offscreen.some(c => c[0] === 'close'));
});
