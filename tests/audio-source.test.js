// 오디오 소스(탭 / 마이크 / 탭+마이크) 선택과 마이크 권한 - 팝업 컨트롤러·설정 페이지 마이크 섹션·권한/장치 유틸
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakePermissions, makeFakeMediaDevices, namedError } from './helpers/fakes.js';
import { FakeElement, FakeSelect, FakeOption } from './helpers/fake-dom.js';
import { AUDIO_SOURCES } from '../constants.js';
import {
  usesMic,
  isValidAudioSource,
  queryMicPermission,
  watchMicPermission,
  requestMicPermission,
  listMicDevices,
  resolveAudioSourceSelection,
  buildMicDeviceOptions,
  AudioSourceControl,
  MicSettingsSection,
  MIC_HINT_TEXT
} from '../audio-source.js';

const DEVICES = [
  { deviceId: 'default', label: 'Default - Built-in Microphone', groupId: 'g1' },
  { deviceId: 'builtin', label: 'Built-in Microphone', groupId: 'g1' },
  { deviceId: 'usb-1', label: 'USB Microphone', groupId: 'g2' },
  { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers', groupId: 'g1' },
  { kind: 'videoinput', deviceId: 'cam', label: 'Camera', groupId: 'g3' }
];

/** navigator 흉내: permissions + mediaDevices */
function makeNav({ permission = 'prompt', devices = DEVICES, unsupported = false, noPermissionsApi = false, promptAnswer = 'granted', getUserMedia = null } = {}) {
  const permissions = makeFakePermissions(permission, { unsupported });
  const mediaDevices = makeFakeMediaDevices({ devices, permissions, promptAnswer, getUserMedia });
  return { permissions: noPermissionsApi ? undefined : permissions, mediaDevices, fakePermissions: permissions };
}

const flush = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 기본 유틸
// ---------------------------------------------------------------------------
test('usesMic / isValidAudioSource: 마이크를 쓰는 소스는 mic, tab+mic', () => {
  assert.equal(usesMic(AUDIO_SOURCES.TAB), false);
  assert.equal(usesMic(AUDIO_SOURCES.MIC), true);
  assert.equal(usesMic(AUDIO_SOURCES.TAB_AND_MIC), true);
  assert.equal(usesMic('nope'), false);
  for (const v of ['tab', 'mic', 'tab+mic']) assert.equal(isValidAudioSource(v), true, v);
  for (const v of ['', null, undefined, 'MIC', 'system']) assert.equal(isValidAudioSource(v), false, String(v));
});

test('queryMicPermission: Permissions API의 microphone 상태(granted / denied / prompt)를 돌려준다', async () => {
  for (const state of ['granted', 'denied', 'prompt']) {
    const nav = makeNav({ permission: state });
    const r = await queryMicPermission(nav);
    assert.equal(r.state, state);
    assert.equal(r.via, 'permissions');
    assert.ok(r.status, 'PermissionStatus (변경 구독용)');
    assert.deepEqual(nav.fakePermissions.calls, [{ name: 'microphone' }]);
  }
});

test('queryMicPermission: Permissions API가 없거나 microphone을 모르면 enumerateDevices의 장치 이름으로 판단한다 (이름이 보이면 granted, 아니면 prompt)', async () => {
  const granted = makeNav({ permission: 'granted', unsupported: true });
  assert.deepEqual((({ state, via }) => ({ state, via }))(await queryMicPermission(granted)), { state: 'granted', via: 'devices' });
  const unknown = makeNav({ permission: 'prompt', noPermissionsApi: true });
  assert.deepEqual((({ state, via }) => ({ state, via }))(await queryMicPermission(unknown)), { state: 'prompt', via: 'devices' });
  const nothing = await queryMicPermission({});
  assert.equal(nothing.state, 'prompt', 'API가 하나도 없으면 확인 불가 = prompt (마이크 항목 비활성)');
  const throwing = await queryMicPermission({ mediaDevices: { enumerateDevices: async () => { throw new Error('x'); } } });
  assert.equal(throwing.state, 'prompt');
});

test('watchMicPermission: PermissionStatus change 이벤트로 새 상태를 알리고, 해제 함수로 구독을 끊는다', async () => {
  const nav = makeNav({ permission: 'prompt' });
  const { status } = await queryMicPermission(nav);
  const seen = [];
  const stop = watchMicPermission(status, (s) => seen.push(s));
  nav.fakePermissions.setState('granted');
  nav.fakePermissions.setState('denied');
  stop();
  nav.fakePermissions.setState('granted');
  assert.deepEqual(seen, ['granted', 'denied']);
  assert.equal(typeof watchMicPermission(null, () => {}), 'function', 'status가 없어도 안전');
});

test('requestMicPermission: getUserMedia({audio: true})로 권한 창을 띄우고 받은 트랙은 바로 멈춘 뒤 granted를 돌려준다', async () => {
  const nav = makeNav({ permission: 'prompt', promptAnswer: 'granted' });
  const r = await requestMicPermission(nav);
  assert.equal(r.state, 'granted');
  assert.equal(r.error, null);
  assert.deepEqual(nav.mediaDevices.calls.getUserMedia, [{ audio: true }]);
  const tracks = nav.mediaDevices.streams.flatMap(s => s.getTracks());
  assert.ok(tracks.length > 0 && tracks.every(t => t.stopped), '권한 확인용 트랙은 즉시 중지 (마이크 표시등이 계속 켜지지 않게)');
});

test('requestMicPermission: 거부(NotAllowedError) → denied, 마이크 없음(NotFoundError) → 오류 이름을 함께 돌려준다', async () => {
  const denied = makeNav({ permission: 'prompt', promptAnswer: 'denied' });
  const r1 = await requestMicPermission(denied);
  assert.equal(r1.state, 'denied');
  assert.equal(r1.error.name, 'NotAllowedError');

  const blocked = makeNav({ permission: 'denied' });
  const r2 = await requestMicPermission(blocked);
  assert.equal(r2.state, 'denied', '이미 차단된 경우 권한 창 없이 거부');

  const noMic = makeNav({ permission: 'prompt', devices: [] });
  const r3 = await requestMicPermission(noMic);
  assert.equal(r3.error.name, 'NotFoundError');
  assert.equal(r3.state, 'prompt', '권한 상태는 그대로');

  const unsupported = await requestMicPermission({});
  assert.equal(unsupported.state, 'prompt');
  assert.equal(unsupported.error.name, 'NotSupportedError');
});

test('listMicDevices: 오디오 입력만, Chrome의 "default" 가상 장치는 빼고 그 이름은 기본 마이크 표시에 쓴다. 권한 전(이름·ID 없음)에는 빈 목록', async () => {
  const granted = makeNav({ permission: 'granted' });
  const r = await listMicDevices(granted);
  assert.deepEqual(r.devices, [{ deviceId: 'builtin', label: 'Built-in Microphone' }, { deviceId: 'usb-1', label: 'USB Microphone' }]);
  assert.equal(r.defaultLabel, 'Built-in Microphone', '"Default - " 접두사 제거');
  const prompt = makeNav({ permission: 'prompt' });
  assert.deepEqual(await listMicDevices(prompt), { devices: [], defaultLabel: '' });
  assert.deepEqual(await listMicDevices({}), { devices: [], defaultLabel: '' });
});

// ---------------------------------------------------------------------------
// 팝업: 권한에 따른 선택 상태 (순수 함수)
// ---------------------------------------------------------------------------
test('resolveAudioSourceSelection: 권한이 granted가 아니면 마이크 항목은 비활성 + 값은 탭 + 안내 표시, granted면 저장된 값 그대로', () => {
  const cases = [
    [{ stored: 'mic', permission: 'granted' }, { value: 'mic', micEnabled: true, hintVisible: false }],
    [{ stored: 'tab+mic', permission: 'granted' }, { value: 'tab+mic', micEnabled: true, hintVisible: false }],
    [{ stored: 'tab', permission: 'granted' }, { value: 'tab', micEnabled: true, hintVisible: false }],
    [{ stored: 'mic', permission: 'prompt' }, { value: 'tab', micEnabled: false, hintVisible: true }],
    [{ stored: 'tab+mic', permission: 'denied' }, { value: 'tab', micEnabled: false, hintVisible: true }],
    [{ stored: 'tab', permission: 'prompt' }, { value: 'tab', micEnabled: false, hintVisible: true }],
    [{ stored: 'bogus', permission: 'granted' }, { value: 'tab', micEnabled: true, hintVisible: false }],
    [{ stored: undefined, permission: undefined }, { value: 'tab', micEnabled: false, hintVisible: true }]
  ];
  for (const [input, expected] of cases) assert.deepEqual(resolveAudioSourceSelection(input), expected, JSON.stringify(input));
});

// 팝업 audioSourceSelect + 안내 버튼 (popup.html과 같은 항목)
function makePopupElements() {
  const select = new FakeSelect({
    id: 'audioSourceSelect',
    options: [new FakeOption('탭', 'tab'), new FakeOption('마이크', 'mic'), new FakeOption('탭+마이크', 'tab+mic')]
  });
  const hint = new FakeElement('button', { id: 'micPermissionHint', textContent: MIC_HINT_TEXT, className: 'link-hint hidden' });
  return { select, hint };
}
const optionStates = (select) => select.options.map(o => [o.value, o.disabled]);

async function makePopupControl({ stored = 'tab', permission = 'prompt', saveResult = true } = {}) {
  const nav = makeNav({ permission });
  const { select, hint } = makePopupElements();
  const saved = [];
  const opened = [];
  const control = new AudioSourceControl({
    select, hint, nav,
    save: async (key, value) => { saved.push([key, value]); return saveResult; },
    openSettings: async () => { opened.push(true); }
  });
  await control.init(stored);
  return { control, select, hint, nav, saved, opened };
}

test('팝업: 마이크 권한이 없으면 마이크·탭+마이크 option이 disabled이고, 저장된 값이 mic여도 탭으로 표시하며, "마이크 권한: 설정에서 허용" 안내를 보인다 (저장 값은 덮어쓰지 않음)', async () => {
  for (const permission of ['prompt', 'denied']) {
    const { control, select, hint, saved } = await makePopupControl({ stored: 'mic', permission });
    assert.deepEqual(optionStates(select), [['tab', false], ['mic', true], ['tab+mic', true]], permission);
    assert.equal(select.value, 'tab', `${permission}: 탭으로 되돌림`);
    assert.equal(control.value, 'tab', '녹화 시작에 쓰는 값도 탭');
    assert.equal(hint.isShown, true, '안내 표시');
    assert.equal(hint.textContent, MIC_HINT_TEXT);
    assert.equal(MIC_HINT_TEXT, '마이크 권한: 설정에서 허용');
    assert.equal(select.dataset.micPermission, permission);
    assert.deepEqual(saved, [], '권한 때문에 되돌린 값은 저장하지 않음 (권한을 허용하면 이전 선택 복원)');
    assert.equal(await select.choose('mic'), false, '비활성 항목은 고를 수 없음');
  }
});

test('팝업: 마이크 권한이 granted면 세 항목 모두 활성, 저장된 선택(mic / tab+mic)을 그대로 보이고 안내는 숨긴다', async () => {
  for (const stored of ['mic', 'tab+mic', 'tab']) {
    const { control, select, hint } = await makePopupControl({ stored, permission: 'granted' });
    assert.deepEqual(optionStates(select), [['tab', false], ['mic', false], ['tab+mic', false]]);
    assert.equal(select.value, stored);
    assert.equal(control.value, stored);
    assert.equal(hint.isShown, false);
  }
});

test('팝업: 고른 오디오 소스는 saveSetting(audioSource)으로 저장되고 control.value에 반영된다', async () => {
  const { control, select, saved } = await makePopupControl({ stored: 'tab', permission: 'granted' });
  assert.equal(await select.choose('tab+mic'), true);
  assert.deepEqual(saved, [['audioSource', 'tab+mic']]);
  assert.equal(control.value, 'tab+mic');
  await select.choose('mic');
  await select.choose('tab');
  assert.deepEqual(saved.map(s => s[1]), ['tab+mic', 'mic', 'tab']);
});

test('팝업: 권한이 없는데 코드로 마이크 값이 들어오면(change) 저장하지 않고 탭으로 되돌린다', async () => {
  const { control, select, saved } = await makePopupControl({ stored: 'tab', permission: 'prompt' });
  select.value = 'mic'; // 비활성 option도 코드로는 선택 가능
  await select.dispatchEvent({ type: 'change' });
  assert.deepEqual(saved, []);
  assert.equal(select.value, 'tab');
  assert.equal(control.value, 'tab');
});

test('팝업: 안내(마이크 권한: 설정에서 허용)를 누르면 설정 페이지를 연다', async () => {
  const { hint, opened } = await makePopupControl({ permission: 'prompt' });
  await hint.click();
  assert.equal(opened.length, 1);
});

test('팝업: 팝업이 열린 동안 권한이 바뀌면(PermissionStatus change) 바로 반영한다 - 허용되면 저장된 mic 복원, 회수되면 다시 탭', async () => {
  const { control, select, hint, nav } = await makePopupControl({ stored: 'mic', permission: 'prompt' });
  assert.equal(select.value, 'tab');
  nav.fakePermissions.setState('granted');
  assert.equal(select.value, 'mic', '허용되면 저장된 선택 복원');
  assert.equal(hint.isShown, false);
  assert.deepEqual(optionStates(select), [['tab', false], ['mic', false], ['tab+mic', false]]);
  nav.fakePermissions.setState('denied');
  assert.equal(select.value, 'tab');
  assert.equal(control.value, 'tab');
  assert.equal(hint.isShown, true);
  control.dispose();
  assert.equal(nav.fakePermissions.listenerCount(), 0, 'dispose로 구독 해제');
});

test('팝업: 다른 곳에서 저장 값이 바뀌면(storage.onChanged) setStoredSource로 반영하되 권한 규칙은 그대로 적용한다', async () => {
  const granted = await makePopupControl({ stored: 'tab', permission: 'granted' });
  granted.control.setStoredSource('tab+mic');
  assert.equal(granted.select.value, 'tab+mic');
  const prompt = await makePopupControl({ stored: 'tab', permission: 'prompt' });
  prompt.control.setStoredSource('mic');
  assert.equal(prompt.select.value, 'tab');
  prompt.control.setStoredSource('garbage');
  assert.equal(prompt.control.value, 'tab');
});

// ---------------------------------------------------------------------------
// 설정 페이지: 마이크 섹션 (권한 요청, 장치 목록, 저장, 사라진 장치)
// ---------------------------------------------------------------------------
function makeSettingsElements() {
  return {
    status: new FakeElement('span', { id: 'micPermissionStatus' }),
    requestButton: new FakeElement('button', { id: 'requestMicButton', className: 'primary' }),
    deviceRow: new FakeElement('div', { id: 'micDeviceRow', className: 'hidden' }),
    deviceSelect: new FakeSelect({ id: 'micDeviceSelect' }),
    message: new FakeElement('div', { id: 'micMessage', className: 'message hidden' })
  };
}

async function makeSection({ permission = 'prompt', devices = DEVICES, settings = {}, promptAnswer = 'granted', getUserMedia = null } = {}) {
  const nav = makeNav({ permission, devices, promptAnswer, getUserMedia });
  const elements = makeSettingsElements();
  const stored = { micDeviceId: '', micDeviceLabel: '', ...settings };
  const saves = [];
  const section = new MicSettingsSection({
    elements, nav,
    loadSettings: async () => ({ ...stored }),
    saveSettings: async (patch) => { saves.push(patch); Object.assign(stored, patch); return true; }
  });
  await section.init();
  return { section, elements, nav, stored, saves };
}
const optionList = (select) => select.options.map(o => [o.value, o.textContent, o.disabled]);

test('설정: 권한 확인 필요(prompt) → 상태 "확인 필요", "마이크 권한 요청" 버튼 표시, 장치 선택은 숨김 (권한 전에는 장치 목록을 만들지 않음)', async () => {
  const { elements } = await makeSection({ permission: 'prompt' });
  assert.equal(elements.status.dataset.state, 'prompt');
  assert.match(elements.status.textContent, /확인 필요/);
  assert.equal(elements.requestButton.isShown, true);
  assert.equal(elements.deviceRow.isShown, false);
  assert.equal(elements.deviceSelect.options.length, 0);
});

test('설정: "마이크 권한 요청" → getUserMedia({audio:true}) 후 트랙을 바로 멈추고, 허용되면 장치 목록(기본 마이크 + 오디오 입력 장치)을 채우고 버튼을 숨긴다', async () => {
  const { elements, nav } = await makeSection({ permission: 'prompt', promptAnswer: 'granted' });
  await elements.requestButton.click();
  assert.deepEqual(nav.mediaDevices.calls.getUserMedia, [{ audio: true }]);
  assert.ok(nav.mediaDevices.streams.flatMap(s => s.getTracks()).every(t => t.stopped), '권한 확인용 트랙 중지');
  assert.equal(elements.status.dataset.state, 'granted');
  assert.match(elements.status.textContent, /허용됨/);
  assert.equal(elements.requestButton.isShown, false);
  assert.equal(elements.deviceRow.isShown, true);
  assert.deepEqual(optionList(elements.deviceSelect), [
    ['', '시스템 기본 마이크 (Built-in Microphone)', false],
    ['builtin', 'Built-in Microphone', false],
    ['usb-1', 'USB Microphone', false]
  ]);
  assert.equal(elements.deviceSelect.value, '', '저장된 장치가 없으면 기본 마이크');
  assert.equal(elements.message.dataset.type, 'success');
});

test('설정: 장치를 고르면 micDeviceId와 이름(micDeviceLabel)을 저장하고, 기본 마이크를 고르면 빈 값으로 저장한다', async () => {
  const { elements, saves, stored } = await makeSection({ permission: 'granted' });
  assert.equal(await elements.deviceSelect.choose('usb-1'), true);
  assert.deepEqual(saves, [{ micDeviceId: 'usb-1', micDeviceLabel: 'USB Microphone' }]);
  assert.equal(stored.micDeviceId, 'usb-1');
  await elements.deviceSelect.choose('');
  assert.deepEqual(saves.at(-1), { micDeviceId: '', micDeviceLabel: '' });
});

test('설정: 저장된 장치가 있으면 그 장치를 선택해 보여 준다', async () => {
  const { elements } = await makeSection({ permission: 'granted', settings: { micDeviceId: 'usb-1', micDeviceLabel: 'USB Microphone' } });
  assert.equal(elements.deviceSelect.value, 'usb-1');
  assert.equal(elements.message.isShown, false);
});

test('설정: 저장된 장치가 사라지면(분리) 그 장치를 "(연결 안 됨)" 비활성 항목으로 선택해 두고 기본 마이크로 녹음한다고 안내하며, 저장 값은 그대로 두고, 다시 연결되면(devicechange) 정상 항목으로 돌아온다', async () => {
  const { elements, nav, saves } = await makeSection({ permission: 'granted', settings: { micDeviceId: 'usb-9', micDeviceLabel: 'Old USB Mic' } });
  assert.deepEqual(optionList(elements.deviceSelect).at(-1), ['usb-9', 'Old USB Mic (연결 안 됨)', true]);
  assert.equal(elements.deviceSelect.value, 'usb-9', '저장된 선택 유지 (사용자가 직접 다른 장치를 고를 때까지)');
  assert.equal(elements.message.isShown, true);
  assert.match(elements.message.textContent, /Old USB Mic/);
  assert.match(elements.message.textContent, /기본 마이크/);
  assert.deepEqual(saves, [], '자동으로 덮어쓰지 않음');

  // 기본 마이크를 직접 고를 수 있음 (사라진 항목이 선택돼 있으므로 change가 일어남)
  // 다시 연결
  nav.mediaDevices.setDevices([...DEVICES, { deviceId: 'usb-9', label: 'Old USB Mic', groupId: 'g9' }]);
  nav.mediaDevices.fireDeviceChange();
  await flush(5);
  assert.deepEqual(optionList(elements.deviceSelect).at(-1), ['usb-9', 'Old USB Mic', false]);
  assert.equal(elements.deviceSelect.value, 'usb-9');
  assert.equal(elements.message.isShown, false, '안내 사라짐');
});

test('설정: 사라진 장치가 선택된 상태에서 기본 마이크를 고르면 빈 값으로 저장한다', async () => {
  const { elements, saves } = await makeSection({ permission: 'granted', settings: { micDeviceId: 'gone', micDeviceLabel: '' } });
  assert.match(optionList(elements.deviceSelect).at(-1)[1], /선택했던 마이크 \(연결 안 됨\)/, '이름을 모르면 대체 이름');
  assert.equal(await elements.deviceSelect.choose(''), true);
  assert.deepEqual(saves, [{ micDeviceId: '', micDeviceLabel: '' }]);
  assert.equal(elements.message.isShown, false);
});

test('설정: 장치 목록이 바뀌면(devicechange) 다시 읽어 새 장치를 보여 준다', async () => {
  const { elements, nav } = await makeSection({ permission: 'granted' });
  const before = nav.mediaDevices.calls.enumerateDevices;
  nav.mediaDevices.setDevices([...DEVICES, { deviceId: 'bt-1', label: 'Bluetooth Headset' }]);
  nav.mediaDevices.fireDeviceChange();
  await flush(5);
  assert.ok(nav.mediaDevices.calls.enumerateDevices > before);
  assert.ok(optionList(elements.deviceSelect).some(([v, l]) => v === 'bt-1' && l === 'Bluetooth Headset'));
});

test('설정: 거부(denied) 상태 → 상태 "거부됨"과 사이트 설정 안내, 요청 버튼을 누르면 권한 창 없이 거부되어 안내 메시지', async () => {
  const { elements } = await makeSection({ permission: 'denied' });
  assert.equal(elements.status.dataset.state, 'denied');
  assert.match(elements.status.textContent, /거부됨/);
  assert.equal(elements.requestButton.isShown, true, '사이트 설정에서 바꾼 뒤 다시 시도할 수 있게 버튼 유지');
  assert.equal(elements.deviceRow.isShown, false);
  await elements.requestButton.click();
  assert.equal(elements.message.dataset.type, 'error');
  assert.match(elements.message.textContent, /허용/);
});

test('설정: 권한 창에서 거부하면 오류 안내, 마이크가 없으면(NotFoundError) "마이크를 찾을 수 없습니다"', async () => {
  const denied = await makeSection({ permission: 'prompt', promptAnswer: 'denied' });
  await denied.elements.requestButton.click();
  assert.equal(denied.elements.status.dataset.state, 'denied');
  assert.equal(denied.elements.message.dataset.type, 'error');

  const noMic = await makeSection({ permission: 'prompt', devices: [] });
  await noMic.elements.requestButton.click();
  assert.equal(noMic.elements.message.dataset.type, 'error');
  assert.match(noMic.elements.message.textContent, /마이크를 찾을 수 없습니다/);
});

test('설정: 다른 곳에서 권한이 바뀌면(PermissionStatus change) 상태와 장치 목록을 다시 그린다', async () => {
  const { elements, nav } = await makeSection({ permission: 'prompt' });
  nav.fakePermissions.setState('granted');
  await flush(5);
  assert.equal(elements.status.dataset.state, 'granted');
  assert.equal(elements.deviceRow.isShown, true);
  assert.ok(elements.deviceSelect.options.length >= 2);
});

test('설정: 요청 중에는 버튼을 비활성화해 중복 요청을 막는다', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { elements, nav } = await makeSection({
    permission: 'prompt',
    getUserMedia: async () => { await gate; throw namedError('NotAllowedError'); }
  });
  const first = elements.requestButton.click();
  await flush(1);
  assert.equal(elements.requestButton.disabled, true);
  await elements.requestButton.click(); // 비활성이라 무시
  release();
  await first;
  assert.equal(nav.mediaDevices.calls.getUserMedia.length, 1);
  assert.equal(elements.requestButton.disabled, false);
});

test('buildMicDeviceOptions: 기본 마이크 + 장치, 저장된 장치가 없으면 "(연결 안 됨)" 비활성 항목을 덧붙여 선택', () => {
  const devices = [{ deviceId: 'a', label: 'Mic A' }, { deviceId: 'b', label: '' }];
  assert.deepEqual(buildMicDeviceOptions({ devices, defaultLabel: '', storedId: 'a', storedLabel: 'Mic A' }), {
    options: [{ value: '', label: '시스템 기본 마이크', disabled: false }, { value: 'a', label: 'Mic A', disabled: false }, { value: 'b', label: '마이크 2', disabled: false }],
    value: 'a',
    missing: false
  });
  const missing = buildMicDeviceOptions({ devices, defaultLabel: 'Mic A', storedId: 'z', storedLabel: 'Mic Z' });
  assert.equal(missing.value, 'z');
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.options.at(-1), { value: 'z', label: 'Mic Z (연결 안 됨)', disabled: true });
  assert.equal(missing.options[0].label, '시스템 기본 마이크 (Mic A)');
  assert.deepEqual(buildMicDeviceOptions({ devices: [], defaultLabel: '', storedId: '', storedLabel: '' }), {
    options: [{ value: '', label: '시스템 기본 마이크', disabled: false }], value: '', missing: false
  });
});
