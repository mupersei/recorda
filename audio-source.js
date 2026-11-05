// Audio Source - 오디오 소스(탭 / 마이크 / 탭+마이크) 선택과 마이크 권한 (팝업·설정 페이지 공용)
//
// - Offscreen 문서는 권한 창을 띄울 수 없으므로 마이크 권한은 설정 페이지(탭)에서 getUserMedia로 한 번 허용받습니다.
//   같은 확장 출처(chrome-extension://<id>)라 설정 페이지에서 허용한 권한이 팝업·Offscreen 문서에도 적용됩니다.
// - 팝업은 열릴 때 권한 상태(Permissions API, 없으면 enumerateDevices의 장치 이름 노출 여부)를 확인해 허용되지 않았으면 마이크·탭+마이크
//   항목을 비활성화하고 탭으로 녹화합니다. 저장된 선택은 덮어쓰지 않아 나중에 권한을 허용하면 그 선택이 돌아옵니다.
// - 권한 상태는 저장하지 않습니다(프로필마다 다르고 sync로 다른 PC에 퍼지면 안 됨). 매번 브라우저에 묻습니다.
// - 브라우저 API(navigator)와 DOM 요소는 주입받으므로 Node 테스트에서 가짜로 검증합니다 (tests/audio-source.test.js).
import { AUDIO_SOURCES } from './constants.js';

const VALID_SOURCES = new Set(Object.values(AUDIO_SOURCES));
const PERMISSION_STATES = new Set(['granted', 'denied', 'prompt']);

/** 팝업의 한 줄 안내 (마이크 권한이 없을 때 오디오 소스 아래에 표시, 누르면 설정 페이지) */
export const MIC_HINT_TEXT = '마이크 권한: 설정에서 허용';

const DEFAULT_MIC_LABEL = '시스템 기본 마이크';
const MISSING_MIC_LABEL = '선택했던 마이크';

export function isValidAudioSource(source) {
  return typeof source === 'string' && VALID_SOURCES.has(source);
}

/** 이 소스가 마이크를 쓰는지 (mic, tab+mic) */
export function usesMic(source) {
  return source === AUDIO_SOURCES.MIC || source === AUDIO_SOURCES.TAB_AND_MIC;
}

function stopStream(stream) {
  try {
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* 무시 */ }
    }
  } catch { /* 무시 */ }
}

function errorInfo(error) {
  return { name: (error && error.name) || 'Error', message: (error && error.message) || String(error) };
}

/**
 * 마이크 권한 상태를 확인합니다.
 * Permissions API(navigator.permissions.query({name:'microphone'}))를 먼저 쓰고, 없거나 microphone을 모르면
 * enumerateDevices로 판단합니다 (권한이 있어야 장치 이름이 보임). 확인할 수 없으면 'prompt'(= 허용되지 않음으로 취급).
 * @returns {Promise<{ state: 'granted'|'denied'|'prompt', via: 'permissions'|'devices'|'none', status: Object|null }>}
 */
export async function queryMicPermission(nav = globalThis.navigator) {
  const permissions = nav && nav.permissions;
  if (permissions && typeof permissions.query === 'function') {
    try {
      const status = await permissions.query({ name: 'microphone' });
      if (status && PERMISSION_STATES.has(status.state)) return { state: status.state, via: 'permissions', status };
    } catch { /* microphone 이름을 지원하지 않는 환경 → 장치 이름으로 판단 */ }
  }
  const mediaDevices = nav && nav.mediaDevices;
  if (mediaDevices && typeof mediaDevices.enumerateDevices === 'function') {
    try {
      const devices = await mediaDevices.enumerateDevices();
      const labeled = devices.some(d => d && d.kind === 'audioinput' && d.label);
      return { state: labeled ? 'granted' : 'prompt', via: 'devices', status: null };
    } catch { /* 아래 */ }
  }
  return { state: 'prompt', via: 'none', status: null };
}

/**
 * 권한 상태 변경 구독 (PermissionStatus change 이벤트). 해제 함수를 돌려줍니다.
 * 다른 탭의 사이트 설정에서 권한을 바꾸거나 이 페이지에서 허용하면 바로 반영하기 위해 씁니다.
 */
export function watchMicPermission(status, onChange) {
  if (!status || typeof onChange !== 'function') return () => {};
  const handler = () => { if (PERMISSION_STATES.has(status.state)) onChange(status.state); };
  if (typeof status.addEventListener === 'function') {
    status.addEventListener('change', handler);
    return () => { try { status.removeEventListener('change', handler); } catch { /* 무시 */ } };
  }
  const previous = status.onchange;
  status.onchange = handler;
  return () => { if (status.onchange === handler) status.onchange = previous || null; };
}

/**
 * 마이크 권한을 요청합니다 (설정 페이지의 버튼 클릭 = 사용자 제스처 안에서 호출). getUserMedia({audio:true})로 권한 창을 띄우고,
 * 받은 트랙은 바로 멈춥니다(마이크 사용 표시가 남지 않게). 이미 차단(denied)된 경우 Chrome은 창 없이 NotAllowedError를 냅니다.
 * @returns {Promise<{ state: 'granted'|'denied'|'prompt', error: { name: string, message: string }|null }>}
 */
export async function requestMicPermission(nav = globalThis.navigator) {
  const mediaDevices = nav && nav.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    return { state: (await queryMicPermission(nav)).state, error: { name: 'NotSupportedError', message: '이 브라우저는 마이크 입력(getUserMedia)을 지원하지 않습니다' } };
  }
  let error = null;
  try {
    stopStream(await mediaDevices.getUserMedia({ audio: true }));
  } catch (e) {
    error = errorInfo(e);
  }
  const { state } = await queryMicPermission(nav);
  // getUserMedia 성공 = 허용 (Permissions API 상태 갱신이 늦거나 장치 이름으로만 판단하는 환경 대비)
  return { state: error ? state : 'granted', error };
}

// Chrome의 "default" 가상 장치 이름("Default - 내장 마이크", 한국어 "기본값 - ...")에서 접두사를 뗌
function stripDefaultPrefix(label) {
  return String(label || '').replace(/^[^-]*?\s-\s/, '').trim();
}

/**
 * 오디오 입력 장치 목록. Chrome의 "default" 가상 장치는 목록에서 빼고(우리 "시스템 기본 마이크" 항목과 같은 뜻) 그 이름만 돌려줍니다.
 * 권한 전에는 장치 ID·이름이 비어 있으므로 빈 목록입니다.
 * @returns {Promise<{ devices: Array<{deviceId: string, label: string}>, defaultLabel: string }>}
 */
export async function listMicDevices(nav = globalThis.navigator) {
  const empty = { devices: [], defaultLabel: '' };
  const mediaDevices = nav && nav.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') return empty;
  let all;
  try {
    all = await mediaDevices.enumerateDevices();
  } catch {
    return empty;
  }
  const inputs = all.filter(d => d && d.kind === 'audioinput' && d.deviceId);
  const fallback = inputs.find(d => d.deviceId === 'default');
  return {
    devices: inputs.filter(d => d.deviceId !== 'default').map(d => ({ deviceId: d.deviceId, label: d.label || '' })),
    defaultLabel: fallback ? stripDefaultPrefix(fallback.label) : ''
  };
}

/**
 * 팝업 오디오 소스 선택 상태 (순수 함수).
 * 마이크 권한이 granted가 아니면 마이크 항목은 비활성이고 값은 탭(저장된 값이 mic이어도), 한 줄 안내를 보입니다.
 */
export function resolveAudioSourceSelection({ stored, permission } = {}) {
  const micEnabled = permission === 'granted';
  const source = isValidAudioSource(stored) ? stored : AUDIO_SOURCES.TAB;
  const value = micEnabled || !usesMic(source) ? source : AUDIO_SOURCES.TAB;
  return { value, micEnabled, hintVisible: !micEnabled };
}

/**
 * 설정 페이지 마이크 장치 선택 항목 (순수 함수): 시스템 기본 마이크('') + 장치들.
 * 저장된 장치가 지금 없으면(분리) 그 장치를 "(연결 안 됨)" 비활성 항목으로 덧붙여 선택해 둡니다 - 저장 값은 사용자가 바꿀 때까지 유지하고,
 * 그동안 녹화는 시스템 기본 마이크로 진행합니다(offscreen의 exact 실패 → 기본 장치 재시도).
 */
export function buildMicDeviceOptions({ devices = [], defaultLabel = '', storedId = '', storedLabel = '' } = {}) {
  const options = [{ value: '', label: defaultLabel ? `${DEFAULT_MIC_LABEL} (${defaultLabel})` : DEFAULT_MIC_LABEL, disabled: false }];
  devices.forEach((device, i) => options.push({ value: device.deviceId, label: device.label || `마이크 ${i + 1}`, disabled: false }));
  const id = typeof storedId === 'string' ? storedId : '';
  const missing = !!id && !devices.some(d => d.deviceId === id);
  if (missing) options.push({ value: id, label: `${storedLabel || MISSING_MIC_LABEL} (연결 안 됨)`, disabled: true });
  return { options, value: id, missing };
}

// ---------------------------------------------------------------------------
// 팝업: 오디오 소스 선택 상자 + 마이크 권한 안내
// ---------------------------------------------------------------------------
export class AudioSourceControl {
  /**
   * @param {Object} options
   * @param {HTMLSelectElement} options.select - 탭 / 마이크 / 탭+마이크 option을 가진 선택 상자
   * @param {HTMLElement} [options.hint] - 권한이 없을 때 보이는 한 줄 안내 (누르면 openSettings)
   * @param {Navigator} [options.nav]
   * @param {(key: string, value: string) => Promise<boolean>} [options.save] - 사용자가 고른 값 저장 (saveSetting)
   * @param {() => Promise<void>} [options.openSettings]
   */
  constructor({ select, hint = null, nav = globalThis.navigator, save = null, openSettings = null } = {}) {
    this.select = select;
    this.hint = hint;
    this.nav = nav;
    this.save = save;
    this.openSettings = openSettings;
    this.stored = AUDIO_SOURCES.TAB;
    this.permission = 'prompt';
    this.unwatch = () => {};
    this.onSelectChange = () => this.handleChange();
    this.onHintClick = () => this.handleHintClick();
  }

  /** 저장된 선택으로 시작: 권한 확인 → 항목 활성/비활성, 값, 안내 반영. 권한 상태를 돌려줌 */
  async init(storedSource) {
    this.stored = isValidAudioSource(storedSource) ? storedSource : AUDIO_SOURCES.TAB;
    this.select.addEventListener('change', this.onSelectChange);
    if (this.hint) this.hint.addEventListener('click', this.onHintClick);
    const { state, status } = await queryMicPermission(this.nav);
    this.permission = state;
    this.unwatch = watchMicPermission(status, (next) => {
      this.permission = next;
      this.render();
    });
    this.render();
    return state;
  }

  get selection() {
    return resolveAudioSourceSelection({ stored: this.stored, permission: this.permission });
  }

  /** 녹화 시작에 쓸 값 (권한이 없으면 항상 탭) */
  get value() {
    return this.selection.value;
  }

  get micAllowed() {
    return this.permission === 'granted';
  }

  render() {
    const { value, micEnabled, hintVisible } = this.selection;
    for (const option of this.select.options) {
      if (usesMic(option.value)) option.disabled = !micEnabled;
    }
    this.select.value = value;
    this.select.dataset.micPermission = this.permission;
    if (this.hint) this.hint.classList.toggle('hidden', !hintVisible);
  }

  /** 다른 곳(설정 동기화 등)에서 저장 값이 바뀜 */
  setStoredSource(source) {
    this.stored = isValidAudioSource(source) ? source : AUDIO_SOURCES.TAB;
    this.render();
  }

  async handleChange() {
    const next = this.select.value;
    if (!isValidAudioSource(next) || (usesMic(next) && !this.micAllowed)) {
      // 권한 없이 마이크 값이 들어온 경우(코드로 선택 등): 저장하지 않고 되돌림
      this.render();
      return false;
    }
    this.stored = next;
    this.render();
    return this.save ? this.save('audioSource', next) : true;
  }

  async handleHintClick() {
    if (this.openSettings) await this.openSettings();
  }

  dispose() {
    this.unwatch();
    this.unwatch = () => {};
    this.select.removeEventListener('change', this.onSelectChange);
    if (this.hint) this.hint.removeEventListener('click', this.onHintClick);
  }
}

// ---------------------------------------------------------------------------
// 설정 페이지: 마이크 권한 요청 + 장치 선택
// ---------------------------------------------------------------------------
const MIC_PERMISSION_TEXT = {
  granted: '권한: 허용됨 - 팝업의 오디오 소스에서 마이크 · 탭+마이크를 고를 수 있습니다.',
  prompt: '권한: 확인 필요 - "마이크 권한 요청"을 눌러 허용하세요. 허용하기 전에는 팝업에서 마이크 항목을 고를 수 없습니다.',
  denied: '권한: 거부됨 - 주소창 왼쪽의 사이트 정보(또는 chrome://settings/content/microphone)에서 이 확장 프로그램의 마이크를 "허용"으로 바꾼 뒤 이 페이지로 돌아오세요.'
};
const MIC_DENIED_GUIDE = '마이크가 차단되어 있어 권한 창이 뜨지 않습니다. 주소창 왼쪽의 사이트 정보(또는 chrome://settings/content/microphone)에서 이 확장 프로그램의 마이크를 "허용"으로 바꾼 뒤 다시 눌러주세요.';

export class MicSettingsSection {
  /**
   * @param {Object} options
   * @param {{ status: HTMLElement, requestButton: HTMLButtonElement, deviceRow: HTMLElement, deviceSelect: HTMLSelectElement, message: HTMLElement }} options.elements
   * @param {Navigator} [options.nav]
   * @param {() => Promise<Object>} options.loadSettings - { micDeviceId, micDeviceLabel }
   * @param {(patch: Object) => Promise<boolean>} options.saveSettings
   */
  constructor({ elements, nav = globalThis.navigator, loadSettings, saveSettings }) {
    this.elements = elements;
    this.nav = nav;
    this.loadSettings = loadSettings;
    this.saveSettings = saveSettings;
    this.permission = 'prompt';
    this.busy = false;
    this.refreshSeq = 0;
    this.deviceLabels = new Map();
    this.unwatch = () => {};
    this.onRequestClick = () => this.requestPermission();
    this.onSelectChange = () => this.handleDeviceChange();
    this.onDeviceChange = () => { this.refresh().catch((error) => console.warn('[MicSettings] 장치 목록 갱신 실패:', error)); };
  }

  async init() {
    const { requestButton, deviceSelect } = this.elements;
    requestButton.addEventListener('click', this.onRequestClick);
    deviceSelect.addEventListener('change', this.onSelectChange);
    const mediaDevices = this.nav && this.nav.mediaDevices;
    if (mediaDevices && typeof mediaDevices.addEventListener === 'function') mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    const { status } = await queryMicPermission(this.nav);
    this.unwatch = watchMicPermission(status, this.onDeviceChange);
    await this.refresh();
  }

  showMessage(text, type = 'info', kind = 'action') {
    const { message } = this.elements;
    message.textContent = text;
    message.dataset.type = type;
    message.dataset.kind = kind;
    message.className = `message ${type}`;
  }

  clearMessage(kind = null) {
    const { message } = this.elements;
    if (kind && message.dataset.kind !== kind) return;
    message.textContent = '';
    message.dataset.type = '';
    message.dataset.kind = '';
    message.className = 'message hidden';
  }

  /** 권한 상태·요청 버튼·장치 목록을 다시 그림 (겹쳐 불리면 마지막 결과만 반영) */
  async refresh() {
    const seq = ++this.refreshSeq;
    const { state } = await queryMicPermission(this.nav);
    const list = state === 'granted' ? await listMicDevices(this.nav) : { devices: [], defaultLabel: '' };
    let settings = {};
    try {
      settings = (await this.loadSettings()) || {};
    } catch (error) {
      console.warn('[MicSettings] 설정 읽기 실패:', error);
    }
    if (seq !== this.refreshSeq) return state;

    this.permission = state;
    const { status, requestButton, deviceRow, deviceSelect } = this.elements;
    status.textContent = MIC_PERMISSION_TEXT[state] || `권한: ${state}`;
    status.dataset.state = state;
    requestButton.classList.toggle('hidden', state === 'granted');
    requestButton.disabled = this.busy;
    deviceRow.classList.toggle('hidden', state !== 'granted');

    if (state !== 'granted') {
      deviceSelect.replaceChildren();
      this.clearMessage('missing');
      return state;
    }

    this.deviceLabels = new Map(list.devices.map(d => [d.deviceId, d.label]));
    const storedId = typeof settings.micDeviceId === 'string' ? settings.micDeviceId : '';
    const storedLabel = typeof settings.micDeviceLabel === 'string' ? settings.micDeviceLabel : '';
    const built = buildMicDeviceOptions({ devices: list.devices, defaultLabel: list.defaultLabel, storedId, storedLabel });
    const doc = deviceSelect.ownerDocument || globalThis.document;
    deviceSelect.replaceChildren(...built.options.map(({ value, label, disabled }) => {
      const option = doc.createElement('option');
      option.value = value;
      option.textContent = label;
      option.disabled = disabled;
      return option;
    }));
    deviceSelect.value = built.value;
    if (built.missing) {
      const name = storedLabel ? `'${storedLabel}'` : '';
      this.showMessage(`선택했던 마이크${name ? ` ${name}` : ''}가 연결되어 있지 않습니다. 다시 연결하면 그 마이크로 녹음하고, 그때까지는 시스템 기본 마이크로 녹음합니다.`, 'info', 'missing');
    } else {
      this.clearMessage('missing');
    }
    return state;
  }

  async requestPermission() {
    if (this.busy) return;
    const { requestButton } = this.elements;
    this.busy = true;
    requestButton.disabled = true;
    try {
      this.clearMessage();
      const { state, error } = await requestMicPermission(this.nav);
      await this.refresh();
      if (!error) {
        if (this.elements.message.dataset.kind !== 'missing') {
          this.showMessage('마이크 권한이 허용되었습니다. 팝업의 오디오 소스에서 마이크 또는 탭+마이크를 고를 수 있습니다.', 'success');
        }
      } else if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
        this.showMessage('마이크를 찾을 수 없습니다. 마이크가 연결되어 있는지 확인한 뒤 다시 시도해주세요.', 'error');
      } else if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
        this.showMessage(state === 'denied' ? MIC_DENIED_GUIDE : '마이크 권한이 허용되지 않았습니다. 다시 "마이크 권한 요청"을 눌러 허용해주세요.', 'error');
      } else if (error.name === 'NotReadableError') {
        this.showMessage('마이크를 열 수 없습니다. 다른 프로그램이 마이크를 사용 중인지 확인해주세요.', 'error');
      } else {
        this.showMessage(`마이크 권한을 확인하지 못했습니다 (${error.name}: ${error.message})`, 'error');
      }
    } finally {
      this.busy = false;
      requestButton.disabled = false;
    }
  }

  async handleDeviceChange() {
    const id = this.elements.deviceSelect.value || '';
    const label = id ? (this.deviceLabels.get(id) || '') : '';
    let ok = false;
    try {
      ok = await this.saveSettings({ micDeviceId: id, micDeviceLabel: label });
    } catch (error) {
      console.error('[MicSettings] 마이크 설정 저장 실패:', error);
    }
    if (!ok) this.showMessage('마이크 설정을 저장하지 못했습니다.', 'error');
    await this.refresh();
    return ok;
  }

  dispose() {
    this.unwatch();
    const { requestButton, deviceSelect } = this.elements;
    requestButton.removeEventListener('click', this.onRequestClick);
    deviceSelect.removeEventListener('change', this.onSelectChange);
    const mediaDevices = this.nav && this.nav.mediaDevices;
    if (mediaDevices && typeof mediaDevices.removeEventListener === 'function') mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
  }
}
