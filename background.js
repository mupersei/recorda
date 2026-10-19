import { MESSAGE_TYPES, SETTINGS, ERROR_MESSAGES, RECORDING_STATES, RECORDING_MODES, SESSION_KEYS, SAVE_LOCATIONS } from './constants.js';
import { getActiveElapsedSeconds } from './utils.js';
import { loadSettings, resetSettings } from './storage.js';
import { resolveRecordingPlan } from './recording-plan.js';

// ---------------------------------------------------------------------------
// 상태 관리
// MV3 Service Worker는 유휴 30초 후 종료될 수 있으므로 메모리 상태를 chrome.storage.session에 함께 저장하고
// 시작 시 복원합니다. Offscreen은 녹화 중 주기적으로 RECORDING_HEARTBEAT를 보내 SW를 깨우고 상태를 복구시킵니다.
// 상태 전환: IDLE → RECORDING ⇄ PAUSED → PROCESSING → IDLE (START는 IDLE에서만, STOP은 RECORDING/PAUSED에서)
// ---------------------------------------------------------------------------
const IDLE_STATE = {
  state: RECORDING_STATES.IDLE,
  tabId: null,
  startTime: null,
  pausedAt: null,     // 진행 중인 일시정지의 시작 시각 (PAUSED일 때만)
  pausedTotalMs: 0,   // 끝난 일시정지들의 누적 시간 (경과 시간에서 제외)
  format: SETTINGS.DEFAULT_FORMAT,
  mode: RECORDING_MODES.AUDIO_ONLY,
  plan: null,
  files: [],
  saving: false
};
let recordingState = { ...IDLE_STATE };

const ALARM_UPDATE_TIME = 'updateTime';
const ALARM_DOWNLOAD_TIMEOUT = 'downloadTimeout';

// 녹화 세션이 진행 중인지 (일시정지 포함)
function isSessionActive(state = recordingState.state) {
  return state === RECORDING_STATES.RECORDING || state === RECORDING_STATES.PAUSED;
}

// SW 시작 시 세션 스토리지에서 상태 복원 (모든 핸들러는 이 Promise를 기다림)
const ready = rehydrateState();

async function rehydrateState() {
  try {
    const stored = await sessionGet(SESSION_KEYS.RECORDING_STATE);
    if (!stored || stored.state === RECORDING_STATES.IDLE) {
      return;
    }
    // 녹화 중이던 상태: Offscreen 문서가 살아 있어야 유효
    const offscreenAlive = await hasOffscreenDocument();
    if (offscreenAlive) {
      recordingState = { ...IDLE_STATE, ...stored, files: [] };
      console.log('[Background] 세션 상태 복원:', recordingState.state, recordingState.mode);
      updateBadge(recordingState.state);
      if (recordingState.state === RECORDING_STATES.RECORDING) {
        chrome.alarms.create(ALARM_UPDATE_TIME, { periodInMinutes: 1 / 60 });
      }
    } else {
      console.warn('[Background] 세션에 녹화 상태가 있지만 Offscreen 문서가 없어 IDLE로 정리합니다');
      await setRecordingState({ ...IDLE_STATE });
      updateBadge(RECORDING_STATES.IDLE);
    }
  } catch (error) {
    console.error('[Background] 상태 복원 실패:', error);
  }
}

async function setRecordingState(next) {
  recordingState = next;
  await sessionSet(SESSION_KEYS.RECORDING_STATE, {
    state: next.state,
    tabId: next.tabId,
    startTime: next.startTime,
    pausedAt: next.pausedAt ?? null,
    pausedTotalMs: next.pausedTotalMs || 0,
    format: next.format,
    mode: next.mode,
    plan: next.plan
  });
}

async function sessionGet(key) {
  try {
    if (!chrome.storage || !chrome.storage.session) return undefined;
    const result = await chrome.storage.session.get(key);
    return result ? result[key] : undefined;
  } catch (error) {
    console.warn('[Background] storage.session.get 실패:', key, error);
    return undefined;
  }
}

async function sessionSet(key, value) {
  try {
    if (!chrome.storage || !chrome.storage.session) return;
    await chrome.storage.session.set({ [key]: value });
  } catch (error) {
    console.warn('[Background] storage.session.set 실패:', key, error);
  }
}

// 확장 프로그램 설치 시
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Recorda 확장 프로그램이 설치되었습니다.');
  await initializeSettings();
  initializeBadge();
});

// 메시지 수신 리스너
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background 메시지 수신:', message && message.action);

  const route = async () => {
    await ready;
    switch (message.action) {
      case MESSAGE_TYPES.START_RECORDING:
        return handleStartRecording(message.data, sendResponse);
      case MESSAGE_TYPES.STOP_RECORDING:
        return handleStopRecording(sendResponse);
      case MESSAGE_TYPES.PAUSE_RECORDING:
        return handlePauseRecording(sendResponse);
      case MESSAGE_TYPES.RESUME_RECORDING:
        return handleResumeRecording(sendResponse);
      case MESSAGE_TYPES.GET_STATE:
        return handleGetState(sendResponse);
      case MESSAGE_TYPES.RECORDING_STARTED:
        return handleRecordingStarted(sendResponse);
      case MESSAGE_TYPES.RECORDING_HEARTBEAT:
        return handleHeartbeat(message.data, sendResponse);
      case MESSAGE_TYPES.DOWNLOAD_FILE:
        return handleDownloadFile(message.data, sendResponse);
      case MESSAGE_TYPES.RECORDING_COMPLETE:
        return handleRecordingComplete(message.data, sendResponse);
      case MESSAGE_TYPES.RECORDING_ERROR:
        return handleRecordingError(message.data, sendResponse);
      default:
        console.warn('알 수 없는 메시지 타입:', message.action);
        sendResponse({ success: false, error: ERROR_MESSAGES.UNKNOWN });
    }
  };

  route().catch((error) => {
    console.error('[Background] 메시지 처리 중 예외:', error);
    try { sendResponse({ success: false, error: error.message || ERROR_MESSAGES.UNKNOWN }); } catch { /* 이미 응답함 */ }
  });
  return true; // 비동기 응답
});

// 녹음/녹화 시작 처리
async function handleStartRecording(data, sendResponse) {
  console.log('녹음 시작 요청:', data);

  // 상태 검사는 try 바깥에서: 진행 중인 녹화를 실패 처리로 되돌리지 않도록
  if (recordingState.state !== RECORDING_STATES.IDLE) {
    sendResponse({ success: false, error: ERROR_MESSAGES.ALREADY_RECORDING });
    return;
  }

  let started = false;
  try {
    const { tabId, format, mode, videoFormat, saveLocation } = data || {};
    // 저장 위치: 팝업이 녹화 시작 클릭(사용자 제스처) 때 폴더 권한을 확인한 경우에만 'folder'. 그 외는 기존 다운로드 경로
    const saveToFolder = saveLocation === SAVE_LOCATIONS.FOLDER;

    if (tabId === null || tabId === undefined || typeof tabId !== 'number' || tabId < 0 || !Number.isInteger(tabId)) {
      throw new Error('유효하지 않은 탭 ID입니다.');
    }

    const settings = await loadSettings();
    console.log('[Background] 사용자 설정 로드:', settings);

    // 녹화 계획 결정 (요청 값 > 저장된 설정 > 기본값). 잘못된 모드/포맷은 여기서 에러.
    const plan = resolveRecordingPlan({
      mode: mode || settings.recordingMode,
      audioFormat: format || settings.fileFormat || SETTINGS.DEFAULT_FORMAT,
      videoFormat: videoFormat || settings.videoFormat
    });
    console.log('[Background] 녹화 계획:', plan, '| 저장 위치:', saveToFolder ? '사용자 폴더' : '다운로드 폴더');

    // Offscreen Document를 먼저 준비 (스트림 ID는 발급 후 짧은 시간 안에 사용해야 함)
    await createOffscreenDocument();

    console.log('[Background] MediaStream ID 요청, targetTabId:', tabId);
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (error) {
      throw new Error(translateStreamIdError(error));
    }

    if (!streamId || typeof streamId !== 'string' || streamId.trim().length === 0) {
      throw new Error(ERROR_MESSAGES.CAPTURE_FAILED);
    }

    const audioOutput = plan.outputs.find(o => o.kind === 'audio');
    const startTime = Date.now();
    await setRecordingState({
      ...IDLE_STATE,
      state: RECORDING_STATES.RECORDING,
      tabId,
      startTime,
      format: audioOutput ? audioOutput.format : (format || settings.fileFormat || SETTINGS.DEFAULT_FORMAT),
      mode: plan.mode,
      plan
    });
    started = true;
    updateBadge(RECORDING_STATES.RECORDING);

    // Offscreen에 캡처 시작 요청 (응답을 확인해 실패 시 즉시 롤백)
    const response = await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.START_CAPTURE,
      data: {
        streamId,
        format: recordingState.format,
        bitrate: settings.bitrate,
        sampleRate: settings.sampleRate,
        plan,
        tabId,
        startTime,
        heartbeatIntervalMs: SETTINGS.HEARTBEAT_INTERVAL,
        saveToFolder
      }
    });
    if (!response || response.success === false) {
      throw new Error((response && response.error) || ERROR_MESSAGES.CAPTURE_FAILED);
    }

    chrome.alarms.create(ALARM_UPDATE_TIME, { periodInMinutes: 1 / 60 });
    // 상태 페이로드 포함: Popup이 자체 타이머를 Background의 startTime 기준으로 시작하도록 (일시정지 시 표시 시간 튐 방지)
    sendResponse({ success: true, data: buildStatePayload() });
  } catch (error) {
    console.error('녹음 시작 실패:', error);
    if (started) {
      await setRecordingState({ ...IDLE_STATE });
      updateBadge(RECORDING_STATES.IDLE);
      chrome.alarms.clear(ALARM_UPDATE_TIME);
    }
    sendResponse({ success: false, error: error.message });
  }
}

// getMediaStreamId 에러를 사용자 메시지로 변환
function translateStreamIdError(error) {
  const msg = (error && error.message) || '';
  if (/not been invoked|activeTab|cannot be captured|chrome:\/\//i.test(msg)) {
    return ERROR_MESSAGES.NOT_INVOKED;
  }
  if (/permission|denied/i.test(msg)) {
    return ERROR_MESSAGES.PERMISSION_DENIED;
  }
  return msg || ERROR_MESSAGES.CAPTURE_FAILED;
}

// 녹음 중지 처리
async function handleStopRecording(sendResponse) {
  try {
    console.log('녹음 중지 요청');

    // 일시정지 중에도 중지 가능 (PAUSED → PROCESSING)
    if (!isSessionActive()) {
      throw new Error(ERROR_MESSAGES.NOT_RECORDING);
    }

    await beginProcessing();
    sendResponse({ success: true });
  } catch (error) {
    console.error('녹음 중지 실패:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// RECORDING/PAUSED → PROCESSING 전환 및 Offscreen에 중지 요청
async function beginProcessing() {
  const next = { ...recordingState, state: RECORDING_STATES.PROCESSING };
  if (recordingState.state === RECORDING_STATES.PAUSED && typeof recordingState.pausedAt === 'number') {
    // 진행 중이던 일시정지를 누적 시간으로 정리 (처리 중 표시 시간도 일시정지 제외)
    next.pausedTotalMs = (recordingState.pausedTotalMs || 0) + Math.max(0, Date.now() - recordingState.pausedAt);
    next.pausedAt = null;
  }
  await setRecordingState(next);
  chrome.alarms.clear(ALARM_UPDATE_TIME);
  notifyStateChange();
  await chrome.runtime.sendMessage({ action: MESSAGE_TYPES.STOP_CAPTURE });
}

// 일시정지 (RECORDING → PAUSED): 캡처 스트림과 하트비트는 유지하고 Offscreen은 인코더 입력만 멈춤
async function handlePauseRecording(sendResponse) {
  // 상태 검사는 try 바깥에서: 거부된 요청이 진행 중인 녹화를 되돌리지 않도록
  if (recordingState.state !== RECORDING_STATES.RECORDING) {
    sendResponse({ success: false, error: ERROR_MESSAGES.NOT_RECORDING });
    return;
  }

  const pausedAt = Date.now();
  try {
    console.log('[Background] 일시정지 요청');
    await setRecordingState({ ...recordingState, state: RECORDING_STATES.PAUSED, pausedAt });
    chrome.alarms.clear(ALARM_UPDATE_TIME);
    updateBadge(RECORDING_STATES.PAUSED);

    const response = await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.PAUSE_CAPTURE,
      data: { pausedAt, pausedTotalMs: recordingState.pausedTotalMs || 0 }
    });
    if (!response || response.success === false) {
      throw new Error((response && response.error) || ERROR_MESSAGES.UNKNOWN);
    }

    notifyStateChange();
    sendResponse({ success: true, data: buildStatePayload() });
  } catch (error) {
    console.error('[Background] 일시정지 실패:', error);
    // 그 사이 다른 전환(중지 등)이 없었을 때만 RECORDING으로 되돌림
    if (recordingState.state === RECORDING_STATES.PAUSED && recordingState.pausedAt === pausedAt) {
      await setRecordingState({ ...recordingState, state: RECORDING_STATES.RECORDING, pausedAt: null });
      updateBadge(RECORDING_STATES.RECORDING);
      chrome.alarms.create(ALARM_UPDATE_TIME, { periodInMinutes: 1 / 60 });
      notifyStateChange();
    }
    sendResponse({ success: false, error: error.message });
  }
}

// 재개 (PAUSED → RECORDING): 이번 일시정지 시간을 pausedTotalMs에 누적
async function handleResumeRecording(sendResponse) {
  if (recordingState.state !== RECORDING_STATES.PAUSED) {
    sendResponse({ success: false, error: ERROR_MESSAGES.NOT_PAUSED });
    return;
  }

  const pausedState = recordingState; // 실패 시 복구용
  const now = Date.now();
  const pausedAt = typeof pausedState.pausedAt === 'number' ? pausedState.pausedAt : now;
  const pausedTotalMs = (pausedState.pausedTotalMs || 0) + Math.max(0, now - pausedAt);
  try {
    console.log('[Background] 재개 요청 (이번 일시정지', now - pausedAt, 'ms, 누적', pausedTotalMs, 'ms)');
    await setRecordingState({ ...recordingState, state: RECORDING_STATES.RECORDING, pausedAt: null, pausedTotalMs });
    updateBadge(RECORDING_STATES.RECORDING);
    chrome.alarms.create(ALARM_UPDATE_TIME, { periodInMinutes: 1 / 60 });

    const response = await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.RESUME_CAPTURE,
      data: { pausedTotalMs }
    });
    if (!response || response.success === false) {
      throw new Error((response && response.error) || ERROR_MESSAGES.UNKNOWN);
    }

    notifyStateChange();
    sendResponse({ success: true, data: buildStatePayload() });
  } catch (error) {
    console.error('[Background] 재개 실패:', error);
    // 그 사이 다른 전환이 없었을 때만 원래 일시정지 상태로 되돌림
    if (recordingState.state === RECORDING_STATES.RECORDING && recordingState.pausedAt === null && recordingState.pausedTotalMs === pausedTotalMs) {
      await setRecordingState({ ...recordingState, state: RECORDING_STATES.PAUSED, pausedAt: pausedState.pausedAt, pausedTotalMs: pausedState.pausedTotalMs || 0 });
      chrome.alarms.clear(ALARM_UPDATE_TIME);
      updateBadge(RECORDING_STATES.PAUSED);
      notifyStateChange();
    }
    sendResponse({ success: false, error: error.message });
  }
}

// 현재 상태 조회
function handleGetState(sendResponse) {
  sendResponse({ success: true, data: buildStatePayload() });
}

function buildStatePayload() {
  const { startTime } = recordingState;
  const pausedTotalMs = recordingState.pausedTotalMs || 0;
  return {
    state: recordingState.state,
    isRecording: recordingState.state === RECORDING_STATES.RECORDING,
    paused: recordingState.state === RECORDING_STATES.PAUSED,
    startTime,
    // Popup 자체 타이머의 기준 시각: 일시정지 누적 시간만큼 뒤로 민 시작 시각 (일시정지 중에는 타이머를 멈추고 elapsed 표시)
    effectiveStartTime: typeof startTime === 'number' ? startTime + pausedTotalMs : null,
    pausedAt: recordingState.pausedAt ?? null,
    pausedTotalMs,
    elapsed: getActiveElapsedSeconds(recordingState), // 일시정지 시간 제외
    format: recordingState.format,
    mode: recordingState.mode,
    plan: recordingState.plan,
    files: recordingState.files || [],
    saving: !!recordingState.saving
  };
}

// Offscreen 하트비트: SW가 재시작되어 상태를 잃었으면 복구 (일시정지 상태 포함)
async function handleHeartbeat(data, sendResponse) {
  if (recordingState.state === RECORDING_STATES.IDLE && data && data.plan && typeof data.startTime === 'number') {
    console.warn('[Background] 하트비트로 녹화 상태 복구:', data);
    const audioOutput = (data.plan.outputs || []).find(o => o.kind === 'audio');
    const paused = data.paused === true;
    await setRecordingState({
      ...IDLE_STATE,
      state: paused ? RECORDING_STATES.PAUSED : RECORDING_STATES.RECORDING,
      tabId: typeof data.tabId === 'number' ? data.tabId : null,
      startTime: data.startTime,
      pausedAt: paused ? (typeof data.pausedAt === 'number' ? data.pausedAt : Date.now()) : null,
      pausedTotalMs: typeof data.pausedTotalMs === 'number' && data.pausedTotalMs > 0 ? data.pausedTotalMs : 0,
      format: data.format || (audioOutput ? audioOutput.format : SETTINGS.DEFAULT_FORMAT),
      mode: data.plan.mode,
      plan: data.plan
    });
    updateBadge(recordingState.state);
    if (!paused) {
      chrome.alarms.create(ALARM_UPDATE_TIME, { periodInMinutes: 1 / 60 });
    }
    notifyStateChange();
  }
  sendResponse({ success: true, state: recordingState.state });
}

// ---------------------------------------------------------------------------
// 다운로드: Offscreen이 만든 Blob URL을 chrome.downloads로 저장.
// 대기 목록은 storage.session에 두어 SW가 재시작돼도 완료 이벤트를 처리할 수 있게 합니다.
// 대기 목록의 읽기-수정-쓰기는 동시에 도착하는 완료 이벤트로 갱신이 유실되지 않도록 직렬화합니다.
// ---------------------------------------------------------------------------
let pendingLock = Promise.resolve();
function withPendingLock(fn) {
  const run = pendingLock.then(fn, fn);
  pendingLock = run.catch(() => {});
  return run;
}
async function handleDownloadFile(data, sendResponse) {
  try {
    const { url, filename, kind, format } = data || {};
    if (typeof url !== 'string' || !url.startsWith('blob:')) {
      throw new Error('유효하지 않은 다운로드 URL입니다.');
    }
    if (typeof filename !== 'string' || filename.trim().length === 0) {
      throw new Error('유효하지 않은 파일명입니다.');
    }
    if (!chrome.downloads || typeof chrome.downloads.download !== 'function') {
      throw new Error(ERROR_MESSAGES.DOWNLOAD_FAILED);
    }

    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });

    await withPendingLock(async () => {
      const pending = (await sessionGet(SESSION_KEYS.PENDING_DOWNLOADS)) || {};
      pending[downloadId] = { filename, kind, format };
      await sessionSet(SESSION_KEYS.PENDING_DOWNLOADS, pending);
    });

    // 작은 파일은 download()가 끝나기 전에 이미 완료되어 onChanged를 놓칠 수 있음 → 즉시 확인
    await reconcileDownload(downloadId);

    console.log('[Background] 다운로드 시작:', filename, 'id:', downloadId);
    sendResponse({ success: true, downloadId });
  } catch (error) {
    console.error('[Background] 다운로드 실패:', error);
    sendResponse({ success: false, error: error.message || ERROR_MESSAGES.DOWNLOAD_FAILED });
  }
}

// downloads.search로 현재 상태 조회 (onChanged 유실 대비). 끝났으면 [state, error] 반환
async function queryDownloadState(downloadId) {
  try {
    if (!chrome.downloads || typeof chrome.downloads.search !== 'function') return null;
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item && (item.state === 'complete' || item.state === 'interrupted')) {
      return { state: item.state, error: item.error };
    }
  } catch { /* search 미지원 환경 무시 */ }
  return null;
}

async function reconcileDownload(downloadId) {
  const done = await queryDownloadState(downloadId);
  if (done) await settleDownload(downloadId, done.state, done.error);
}

// 다운로드 하나가 끝났을 때: 대기 목록에서 제거하고 결과를 기록. 모두 끝났으면 마무리. (락 안에서 호출)
async function settleDownloadLocked(downloadId, state, errorCode) {
  const pending = (await sessionGet(SESSION_KEYS.PENDING_DOWNLOADS)) || {};
  const entry = pending[downloadId];
  if (!entry) return null;

  console.log('[Background] 다운로드', state, ':', entry.filename, errorCode || '');
  delete pending[downloadId];
  await sessionSet(SESSION_KEYS.PENDING_DOWNLOADS, pending);

  // 완료된 파일 목록에 다운로드 결과 반영
  const files = (recordingState.files || []).map(f => (
    f.filename === entry.filename ? { ...f, downloadState: state, downloadError: errorCode || null } : f
  ));
  if (!files.some(f => f.filename === entry.filename)) {
    files.push({ kind: entry.kind, format: entry.format, filename: entry.filename, downloadState: state, downloadError: errorCode || null });
  }
  recordingState.files = files;
  return Object.keys(pending).length;
}

async function settleDownload(downloadId, state, errorCode) {
  await withPendingLock(async () => {
    const remaining = await settleDownloadLocked(downloadId, state, errorCode);
    if (remaining === 0) await finishSaving();
  });
}

// 모든 다운로드 종료 → Offscreen 종료 + 최종 결과 알림
async function finishSaving() {
  chrome.alarms.clear(ALARM_DOWNLOAD_TIMEOUT);
  await closeOffscreenDocument();

  if (recordingState.state === RECORDING_STATES.IDLE && (recordingState.saving || (recordingState.files || []).length > 0)) {
    recordingState.saving = false;
    notifyStateChange();

    const failed = (recordingState.files || []).filter(f => f.downloadState && f.downloadState !== 'complete');
    if (failed.length > 0) {
      sendError(`파일 저장에 실패했습니다: ${failed.map(f => `${f.filename} (${f.downloadError || f.downloadState})`).join(', ')}`);
    }
    recordingState.files = [];
  }
}

if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || !delta.state) return;
    const state = delta.state.current;
    if (state !== 'complete' && state !== 'interrupted') return;
    ready.then(() => settleDownload(delta.id, state, delta.error && delta.error.current))
      .catch((error) => console.error('[Background] 다운로드 완료 처리 실패:', error));
  });
}

// 녹음 시작 완료 알림 (Offscreen → Background)
function handleRecordingStarted(sendResponse) {
  console.log('녹음이 시작되었습니다.');
  notifyStateChange();
  sendResponse({ success: true });
}

// 녹음 완료 처리 (Offscreen에서 파일 생성 및 다운로드 요청까지 끝낸 뒤 호출)
// 다운로드 완료 이벤트(settleDownload)와 같은 락 안에서 실행해, 대기 개수 읽기 → 상태 갱신 → 알림 사이에
// 완료 이벤트가 끼어들어 "저장 중" 상태로 덮어쓰는 경합을 막습니다.
async function handleRecordingComplete(data, sendResponse) {
  const { files, warning } = data || {};
  console.log('[Background] 녹화 완료:', files);
  sendResponse({ success: true });

  try {
    await withPendingLock(async () => {
      // 이미 끝났는데 이벤트를 놓친 다운로드가 있으면 먼저 정리 (락 안에서 직접)
      let pending = (await sessionGet(SESSION_KEYS.PENDING_DOWNLOADS)) || {};
      for (const id of Object.keys(pending)) {
        const done = await queryDownloadState(Number(id));
        if (done) await settleDownloadLocked(Number(id), done.state, done.error);
      }
      pending = (await sessionGet(SESSION_KEYS.PENDING_DOWNLOADS)) || {};
      const pendingCount = Object.keys(pending).length;

      // 먼저 끝난 다운로드 결과(settleDownloadLocked가 기록한 것)와 병합
      const settled = recordingState.files || [];
      const merged = (Array.isArray(files) ? files : []).map(f => {
        const s = settled.find(x => x.filename === f.filename);
        return s ? { ...f, ...s } : f;
      });
      for (const s of settled) {
        if (!merged.some(f => f.filename === s.filename)) merged.push(s);
      }

      await setRecordingState({ ...IDLE_STATE });
      recordingState.files = merged;
      recordingState.saving = pendingCount > 0;
      updateBadge(RECORDING_STATES.IDLE);
      chrome.alarms.clear(ALARM_UPDATE_TIME);

      notifyStateChange();

      if (warning) {
        console.warn('[Background] 녹화 완료 경고:', warning);
        sendError(warning);
      }

      if (pendingCount > 0) {
        // Blob URL이 살아 있어야 하므로 다운로드가 끝난 뒤 Offscreen 종료 (이벤트 기반 + 타임아웃 알람)
        chrome.alarms.create(ALARM_DOWNLOAD_TIMEOUT, { delayInMinutes: SETTINGS.DOWNLOAD_WAIT_TIMEOUT_MINUTES });
      } else {
        await finishSaving();
      }
    });
  } catch (error) {
    console.error('[Background] 녹음 완료 처리 실패:', error);
  }
}

// 녹음 에러 처리
async function handleRecordingError(data, sendResponse) {
  console.error('녹음 에러:', data);
  try {
    try { await closeOffscreenDocument(); } catch (error) { console.error('[Background] Offscreen 종료 실패 (에러 처리 중):', error); }

    await setRecordingState({ ...IDLE_STATE });
    await sessionSet(SESSION_KEYS.PENDING_DOWNLOADS, {});

    try { updateBadge(RECORDING_STATES.IDLE); } catch (error) { console.error('[Background] Badge 초기화 실패:', error); }
    try { chrome.alarms.clear(ALARM_UPDATE_TIME); chrome.alarms.clear(ALARM_DOWNLOAD_TIMEOUT); } catch (error) { console.error('[Background] 알람 중지 실패:', error); }

    // Popup UI 재동기화 후 에러 표시
    notifyStateChange();
    sendError((data && data.error) || ERROR_MESSAGES.UNKNOWN);

    sendResponse({ success: true });
  } catch (error) {
    console.error('[Background] 에러 처리 중 예외 발생:', error);
    sendResponse({ success: false, error: error.message });
  }
}

function sendError(message) {
  chrome.runtime.sendMessage({ action: MESSAGE_TYPES.ERROR, data: { error: message } }).catch(() => {
    // Popup이 닫혀있으면 무시
  });
}

// ---------------------------------------------------------------------------
// Offscreen Document
// ---------------------------------------------------------------------------
async function hasOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch (error) {
    console.error('Offscreen 상태 확인 실패:', error);
    return false;
  }
}

async function createOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    console.log('Offscreen Document가 이미 존재합니다 (재사용)');
    return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: '탭 오디오/영상 캡처, 인코딩 및 저장 파일(Blob) 생성'
    });
    console.log('Offscreen Document가 생성되었습니다.');
  } catch (error) {
    if (error.message && error.message.includes('single offscreen')) {
      console.log('Offscreen Document가 이미 존재합니다 (에러 복구)');
      return;
    }
    console.error('Offscreen Document 생성 실패:', error);
    throw new Error(ERROR_MESSAGES.OFFSCREEN_CREATE_FAILED);
  }
}

async function closeOffscreenDocument() {
  try {
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument();
      console.log('Offscreen Document가 종료되었습니다.');
    }
  } catch (error) {
    console.log('Offscreen Document 종료 건너뜀:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Badge / 설정 / 알림
// ---------------------------------------------------------------------------
// 배지: 녹화 중 'REC', 일시정지 'II', 그 외 비움
function updateBadge(state) {
  if (state === RECORDING_STATES.RECORDING) {
    chrome.action.setBadgeText({ text: SETTINGS.BADGE_TEXT_RECORDING });
    chrome.action.setBadgeBackgroundColor({ color: SETTINGS.BADGE_COLOR_RECORDING });
  } else if (state === RECORDING_STATES.PAUSED) {
    chrome.action.setBadgeText({ text: SETTINGS.BADGE_TEXT_PAUSED });
    chrome.action.setBadgeBackgroundColor({ color: SETTINGS.BADGE_COLOR_PAUSED });
  } else {
    chrome.action.setBadgeText({ text: SETTINGS.BADGE_TEXT_IDLE });
  }
}

function initializeBadge() {
  chrome.action.setBadgeText({ text: SETTINGS.BADGE_TEXT_IDLE });
}

async function initializeSettings() {
  try {
    const settings = await loadSettings();
    console.log('[Background] 사용자 설정 초기화 완료:', settings);
  } catch (error) {
    console.error('[Background] 설정 초기화 실패:', error);
    await resetSettings();
  }
}

function notifyStateChange() {
  chrome.runtime.sendMessage({ action: MESSAGE_TYPES.STATE_CHANGED, data: buildStatePayload() }).catch(() => {
    // Popup이 닫혀있으면 무시
  });
}

// 알람: 시간 표시 갱신(보조), 다운로드 대기 타임아웃
chrome.alarms.onAlarm.addListener((alarm) => {
  ready.then(async () => {
    if (alarm.name === ALARM_UPDATE_TIME && recordingState.state === RECORDING_STATES.RECORDING) {
      const { startTime } = recordingState;
      chrome.runtime.sendMessage({
        action: MESSAGE_TYPES.UPDATE_TIME,
        data: {
          elapsed: getActiveElapsedSeconds(recordingState),
          startTime,
          effectiveStartTime: typeof startTime === 'number' ? startTime + (recordingState.pausedTotalMs || 0) : null
        }
      }).catch(() => {});
    } else if (alarm.name === ALARM_DOWNLOAD_TIMEOUT) {
      console.warn('[Background] 다운로드 완료 대기 타임아웃 - Offscreen을 종료합니다');
      await withPendingLock(async () => {
        const pending = (await sessionGet(SESSION_KEYS.PENDING_DOWNLOADS)) || {};
        for (const entry of Object.values(pending)) {
          recordingState.files = (recordingState.files || []).map(f => (f.filename === entry.filename ? { ...f, downloadState: 'timeout' } : f));
        }
        await sessionSet(SESSION_KEYS.PENDING_DOWNLOADS, {});
        await finishSaving();
      });
    }
  }).catch((error) => console.error('[Background] 알람 처리 실패:', error));
});

// 녹화 중인 탭이 닫히면 녹화를 마무리 (일시정지 중이어도)
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    ready.then(async () => {
      if (isSessionActive() && recordingState.tabId === tabId) {
        console.warn('[Background] 녹화 중인 탭이 닫혔습니다. 녹화를 마무리합니다:', tabId);
        await beginProcessing();
      }
    }).catch((error) => console.error('[Background] 탭 종료 처리 실패:', error));
  });
}

// 스토리지 변경 감지 (동기화)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.settings) return;
  console.log('[Background] 사용자 설정 변경 감지:', changes.settings.newValue);
  if (recordingState.state !== RECORDING_STATES.IDLE) {
    console.log('[Background] 녹음 중이므로 설정 변경은 다음 녹음부터 적용됩니다');
  }
});

console.log('Background Service Worker가 로드되었습니다.');
