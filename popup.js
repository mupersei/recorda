import { MESSAGE_TYPES, RECORDING_STATES, SETTINGS, RECORDING_MODES, VIDEO_SETTINGS, SAVE_LOCATIONS, DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';
import { formatTime, formatLabel } from './utils.js';
import { loadSettings, saveSetting } from './storage.js';
import { loadDirectoryHandle, queryFolderPermission, requestFolderPermission, folderDisplayName } from './save-location.js';

// DOM 요소
const skeleton = document.getElementById('skeleton');
const mainContainer = document.getElementById('mainContainer');
const recordButton = document.getElementById('recordButton');
const pauseButton = document.getElementById('pauseButton');
const statusElement = document.getElementById('status');
const timeDisplay = document.getElementById('timeDisplay');
const messageElement = document.getElementById('message');
const formatSelect = document.getElementById('formatSelect');
const bitrateSelect = document.getElementById('bitrateSelect');
const sampleRateSelect = document.getElementById('sampleRateSelect');
const modeSelect = document.getElementById('modeSelect');
const videoFormatSelect = document.getElementById('videoFormatSelect');
const videoFormatGroup = document.getElementById('videoFormatGroup');
const audioFormatGroup = document.getElementById('audioFormatGroup');
const videoColumn = document.getElementById('videoColumn');
const videoColumnNote = document.getElementById('videoColumnNote');
const videoHint = document.getElementById('videoHint');
const audioFormatNote = document.getElementById('audioFormatNote');
const settingsButton = document.getElementById('settingsButton');

// 녹음/녹화 중 비활성화할 설정 요소 목록
const settingControls = () => [formatSelect, bitrateSelect, sampleRateSelect, modeSelect, videoFormatSelect].filter(Boolean);

// DOM 요소 유효성 검증
function validateDOMElements() {
  const requiredElements = {
    skeleton,
    mainContainer,
    recordButton,
    pauseButton,
    statusElement,
    timeDisplay,
    messageElement,
    formatSelect,
    bitrateSelect,
    sampleRateSelect,
    modeSelect,
    videoFormatSelect,
    videoFormatGroup,
    audioFormatGroup,
    videoColumn,
    videoColumnNote,
    videoHint,
    audioFormatNote,
    settingsButton
  };

  const missingElements = [];

  for (const [name, element] of Object.entries(requiredElements)) {
    if (!element) {
      missingElements.push(name);
      console.error(`[Popup] 필수 DOM 요소 누락: ${name}`);
    }
  }

  if (missingElements.length > 0) {
    const errorMessage = `필수 UI 요소를 찾을 수 없습니다: ${missingElements.join(', ')}`;
    console.error('[Popup]', errorMessage);

    // 에러 메시지 표시 시도 (body에 직접 추가)
    try {
      const errorDiv = document.createElement('div');
      errorDiv.style.cssText = 'padding: 20px; color: #d32f2f; text-align: center; font-size: 14px;';
      errorDiv.textContent = errorMessage;
      document.body.appendChild(errorDiv);
    } catch (e) {
      console.error('[Popup] 에러 메시지 표시 실패:', e);
    }

    return false;
  }

  return true;
}

// 현재 상태
let currentState = {
  state: RECORDING_STATES.IDLE,
  isRecording: false,
  elapsed: 0,
  startTime: null
};

// 저장 위치 (chrome.storage.sync 미러: 설정 페이지가 폴더를 고르면 'folder' + 폴더 이름)
// 팝업에는 표시하지 않고(저장 위치는 설정 페이지에서만 확인·변경), 녹화 시작 때 폴더 권한 확인 여부를 정하는 데만 사용
let currentSaveLocation = { mode: SAVE_LOCATIONS.DOWNLOADS, name: '' };

// 녹화 세션 진행 중 여부 (일시정지 포함): 중지 버튼과 일시정지/재개 버튼을 보여 주는 상태
function isSessionActive(state) {
  return state === RECORDING_STATES.RECORDING || state === RECORDING_STATES.PAUSED;
}

// 경과 시간 로컬 타이머 (Background 알람은 패키지 설치에서 30초 간격이라 보조 수단으로만 사용)
let elapsedTimer = null;
let messageHideTimer = null;

function startElapsedTimer(startTime) {
  stopElapsedTimer();
  if (typeof startTime !== 'number') return;
  currentState.startTime = startTime;
  const tickFn = () => updateTime(Math.max(0, Math.floor((Date.now() - startTime) / 1000)));
  tickFn();
  elapsedTimer = setInterval(tickFn, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

// [개선] 초기화 - 상태 확인 후 UI 표시
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Popup 로드됨');

  // DOM 요소 검증
  if (!validateDOMElements()) {
    console.error('[Popup] DOM 요소 검증 실패 - 초기화 중단');
    return;
  }

  try {
    // 사용자 설정 로드
    await loadUserSettings();

    // 현재 상태 요청 (UI 표시 전)
    await loadCurrentState();

    // 이벤트 리스너 등록 (null 체크 후)
    if (recordButton) {
      recordButton.addEventListener('click', handleButtonClick);
    }
    if (pauseButton) {
      pauseButton.addEventListener('click', handlePauseButtonClick);
    }
    if (formatSelect) {
      formatSelect.addEventListener('change', handleFormatChange);
    }
    if (bitrateSelect) {
      bitrateSelect.addEventListener('change', handleBitrateChange);
    }
    if (sampleRateSelect) {
      sampleRateSelect.addEventListener('change', handleSampleRateChange);
    }
    if (modeSelect) {
      modeSelect.addEventListener('change', handleModeChange);
    }
    if (videoFormatSelect) {
      videoFormatSelect.addEventListener('change', handleVideoFormatChange);
    }
    if (settingsButton) {
      settingsButton.addEventListener('click', openSettingsPage);
    }
  } catch (error) {
    console.error('초기화 실패:', error);
  } finally {
    // [개선] 상태 확인 완료 후 UI 표시
    showMainUI();
  }
});

// [개선] 메인 UI 표시 (페이드인)
function showMainUI() {
  if (skeleton) {
    skeleton.style.display = 'none';
  }

  if (mainContainer) {
    mainContainer.classList.remove('loading-hidden');
    mainContainer.classList.add('loaded');
  }
}

// 설정 페이지(options_page)에서 저장 폴더를 바꾸면 sync 미러가 바뀜 → 팝업을 다시 열지 않아도 다음 녹화 시작에 반영
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes[STORAGE_KEYS.SETTINGS]) return;
  applySaveLocationSetting({ ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEYS.SETTINGS].newValue || {}) });
});

// 설정 페이지 열기 (헤더 ⚙ 버튼)
async function openSettingsPage() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error('[Popup] 설정 페이지 열기 실패:', error);
    showMessage('설정 페이지를 열 수 없습니다', 'error');
  }
}

// 저장 위치 설정(sync 미러) 반영 - 화면 표시는 없음 (설정 페이지에서만 표시)
function applySaveLocationSetting(settings) {
  const folder = settings.saveLocationMode === SAVE_LOCATIONS.FOLDER;
  currentSaveLocation = { mode: folder ? SAVE_LOCATIONS.FOLDER : SAVE_LOCATIONS.DOWNLOADS, name: folder ? (settings.saveLocationName || '') : '' };
}

// 녹화 시작 시 저장 위치 결정 (녹화 시작 클릭 = 사용자 제스처 안에서 호출)
// 폴더 모드면 저장된 핸들의 쓰기 권한을 확인하고, granted가 아니면 requestPermission으로 요청합니다.
// 핸들이 없거나 권한을 얻지 못하면 이번 녹화만 기존 다운로드 경로로 저장하고 안내합니다.
async function resolveSaveLocationForStart() {
  if (currentSaveLocation.mode !== SAVE_LOCATIONS.FOLDER) {
    return { mode: SAVE_LOCATIONS.DOWNLOADS };
  }
  try {
    const handle = await loadDirectoryHandle();
    if (!handle) {
      return { mode: SAVE_LOCATIONS.DOWNLOADS, notice: '저장 폴더 정보를 찾을 수 없어 이번 녹화는 다운로드 폴더에 저장합니다. 설정(⚙)에서 폴더를 다시 선택해주세요.' };
    }
    const name = folderDisplayName(handle);
    let permission = await queryFolderPermission(handle);
    if (permission !== 'granted') {
      console.log('[Popup] 저장 폴더 권한 요청:', name, permission);
      permission = await requestFolderPermission(handle);
    }
    if (permission === 'granted') {
      return { mode: SAVE_LOCATIONS.FOLDER, name };
    }
    return { mode: SAVE_LOCATIONS.DOWNLOADS, notice: `'${name}' 폴더 쓰기 권한이 없어 이번 녹화는 다운로드 폴더에 저장합니다. 설정(⚙)에서 "권한 다시 요청"을 눌러주세요.` };
  } catch (error) {
    console.error('[Popup] 저장 폴더 확인 실패:', error);
    return { mode: SAVE_LOCATIONS.DOWNLOADS, notice: `저장 폴더를 확인하지 못해 이번 녹화는 다운로드 폴더에 저장합니다. (${error.message})` };
  }
}

// 메시지 리스너
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Popup 메시지 수신:', message);

  switch (message.action) {
    case MESSAGE_TYPES.STATE_CHANGED:
      updateUI(message.data);
      break;

    case MESSAGE_TYPES.UPDATE_TIME:
      // 일시정지 중에는 멈춘 시간을 유지 (늦게 도착한 갱신 무시)
      if (!elapsedTimer && currentState.state !== RECORDING_STATES.PAUSED) updateTime(message.data.elapsed);
      break;

    case MESSAGE_TYPES.ERROR:
      // 에러 후에는 Background 상태와 UI를 다시 맞춘 뒤 메시지 표시 ("처리 중" 고착 방지)
      loadCurrentState({ silent: true }).finally(() => showMessage(message.data.error, 'error', { sticky: true }));
      break;
  }
});

// 현재 상태 로드
async function loadCurrentState({ silent = false } = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.GET_STATE
    });

    // 응답 유효성 검증
    if (!response) {
      console.error('[Popup] 상태 로드: 응답이 없습니다');
      showMessage('상태 조회 실패: 응답 없음', 'error');
      return;
    }

    if (response.success) {
      // 응답 데이터 검증
      if (!response.data) {
        console.error('[Popup] 상태 로드: 응답 데이터가 없습니다');
        showMessage('상태 데이터 오류', 'error');
        return;
      }

      if (typeof response.data.isRecording !== 'boolean') {
        console.error('[Popup] 상태 로드: isRecording이 boolean이 아닙니다:', response.data.isRecording);
        showMessage('상태 데이터 형식 오류', 'error');
        return;
      }

      if (typeof response.data.elapsed !== 'number' || isNaN(response.data.elapsed)) {
        console.warn('[Popup] 상태 로드: elapsed 값이 유효하지 않습니다:', response.data.elapsed);
        response.data.elapsed = 0; // 기본값 사용
      }

      // 상태 업데이트
      currentState = {
        ...currentState,
        isRecording: response.data.isRecording,
        elapsed: response.data.elapsed
      };

      // UI 업데이트 (에러 처리 포함)
      try {
        updateUI(silent ? { ...response.data, files: [] } : response.data);
      } catch (uiError) {
        console.error('[Popup] UI 업데이트 실패:', uiError);
        showMessage('UI 업데이트 오류', 'error');
      }
    } else {
      // 실패 응답 처리
      const errorMessage = response.error || '알 수 없는 오류';
      console.error('[Popup] 상태 로드 실패:', errorMessage);
      showMessage(`상태 조회 실패: ${errorMessage}`, 'error');
    }
  } catch (error) {
    console.error('[Popup] 상태 로드 중 예외 발생:', error);
    showMessage('상태 조회 중 오류가 발생했습니다', 'error');

    // 기본 상태로 복구
    currentState = {
      isRecording: false,
      elapsed: 0
    };

    // UI를 안전한 기본 상태로 복구
    try {
      updateUI({ state: 'IDLE', isRecording: false, elapsed: 0 });
    } catch (uiError) {
      console.error('[Popup] 기본 UI 복구 실패:', uiError);
    }
  }
}

// 버튼 클릭 처리 (일시정지 중에도 중지 가능)
async function handleButtonClick() {
  if (isSessionActive(currentState.state)) {
    await stopRecording();
  } else {
    await startRecording();
  }
}

// 일시정지 / 재개 버튼 클릭 처리
async function handlePauseButtonClick() {
  const resuming = currentState.state === RECORDING_STATES.PAUSED;
  if (!resuming && currentState.state !== RECORDING_STATES.RECORDING) return;

  if (pauseButton) {
    pauseButton.disabled = true;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      action: resuming ? MESSAGE_TYPES.RESUME_RECORDING : MESSAGE_TYPES.PAUSE_RECORDING
    });
    if (!response || !response.success) {
      throw new Error((response && response.error) || (resuming ? '재개에 실패했습니다' : '일시정지에 실패했습니다'));
    }
    // Background가 계산한 상태(일시정지 시점의 경과 시간, effectiveStartTime)로 즉시 반영. STATE_CHANGED도 뒤따라 옴
    if (response.data) {
      updateUI(response.data);
    }
  } catch (error) {
    console.error(resuming ? '재개 실패:' : '일시정지 실패:', error);
    showMessage(error.message, 'error');
    await loadCurrentState({ silent: true });
  } finally {
    if (pauseButton && isSessionActive(currentState.state)) {
      pauseButton.disabled = false;
    }
  }
}

// 녹음 시작
async function startRecording() {
  try {
    if (recordButton) {
      recordButton.disabled = true;
    }

    // 저장 위치 (폴더 권한 요청은 사용자 제스처가 살아 있는 지금, 다른 비동기 작업보다 먼저)
    const saveLocation = await resolveSaveLocationForStart();

    // 현재 활성 탭 가져오기
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tabs || tabs.length === 0) {
      throw new Error('활성 탭을 찾을 수 없습니다.');
    }

    const tabId = tabs[0].id;

    // 선택된 모드/포맷 가져오기
    const selectedFormat = formatSelect ? formatSelect.value : SETTINGS.DEFAULT_FORMAT;
    const selectedMode = modeSelect ? modeSelect.value : RECORDING_MODES.AUDIO_ONLY;
    const selectedVideoFormat = videoFormatSelect ? videoFormatSelect.value : VIDEO_SETTINGS.DEFAULT_FORMAT;

    // Background에 녹음 시작 메시지 전송
    const response = await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.START_RECORDING,
      data: {
        tabId: tabId,
        format: selectedFormat,
        mode: selectedMode,
        videoFormat: selectedVideoFormat,
        saveLocation: saveLocation.mode
      }
    });

    if (!response.success) {
      throw new Error(response.error);
    }

    // [개선] 즉시 UI 업데이트 (Background가 보낸 상태가 있으면 그 startTime 기준으로 타이머 시작)
    updateUI(response.data && response.data.state === RECORDING_STATES.RECORDING
      ? response.data
      : {
        isRecording: true,
        state: RECORDING_STATES.RECORDING,
        elapsed: 0,
        startTime: Date.now(),
        mode: selectedMode
      });
    if (saveLocation.notice) {
      showMessage(saveLocation.notice, 'info', { sticky: true });
    }
  } catch (error) {
    console.error('녹음 시작 실패:', error);
    showMessage(error.message, 'error');
    if (recordButton) {
      recordButton.disabled = false;
    }
  }
}

// 녹음 중지
async function stopRecording() {
  try {
    // 즉시 처리 중 상태로 UI 업데이트
    updateUI({
      isRecording: false,
      state: RECORDING_STATES.PROCESSING,
      elapsed: currentState.elapsed
    });

    const response = await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.STOP_RECORDING
    });

    if (!response.success) {
      throw new Error(response.error);
    }
  } catch (error) {
    console.error('녹음 중지 실패:', error);
    showMessage(error.message, 'error', { sticky: true });
    // 실제 Background 상태로 재동기화 (이미 중지된 경우 "녹음 중"으로 되돌리지 않음)
    await loadCurrentState({ silent: true });
  }
}

// 일시정지/재개 버튼 표시 (녹화 중·일시정지 중에만 보임)
function updatePauseButton(state) {
  if (!pauseButton) return;
  const visible = isSessionActive(state);
  const isPaused = state === RECORDING_STATES.PAUSED;
  pauseButton.classList.toggle('hidden', !visible);
  pauseButton.classList.toggle('paused', isPaused);
  pauseButton.textContent = isPaused ? '재개' : '일시정지';
  pauseButton.disabled = !visible;
}

// UI 업데이트
function updateUI(state) {
  const recordingState = state.state || (state.isRecording ? RECORDING_STATES.RECORDING : RECORDING_STATES.IDLE);
  currentState.state = recordingState;
  currentState.isRecording = recordingState === RECORDING_STATES.RECORDING;
  currentState.elapsed = state.elapsed || 0;

  const isVideoMode = (state.mode || (modeSelect && modeSelect.value)) !== RECORDING_MODES.AUDIO_ONLY;
  const isPaused = recordingState === RECORDING_STATES.PAUSED;
  updatePauseButton(recordingState);
  if (timeDisplay) {
    timeDisplay.classList.toggle('paused', isPaused);
  }

  if (isSessionActive(recordingState)) {
    // 녹음/녹화 중 또는 일시정지 중
    if (isPaused) {
      // 일시정지: 자체 타이머를 멈추고 Background가 계산한 경과 시간(일시정지 시점 값)을 표시
      stopElapsedTimer();
    } else {
      // 녹화 중: 일시정지 누적 시간만큼 뒤로 민 시작 시각 기준으로 타이머 진행 (재개 시 멈춘 값에서 이어짐)
      const timerStart = typeof state.effectiveStartTime === 'number' ? state.effectiveStartTime : state.startTime;
      if (typeof timerStart === 'number') {
        startElapsedTimer(timerStart);
      }
    }
    if (recordButton) {
      recordButton.textContent = isVideoMode ? '녹화 중지' : '녹음 중지';
      recordButton.classList.add('recording');
      recordButton.classList.remove('processing');
      recordButton.disabled = false;
    }
    if (statusElement) {
      statusElement.textContent = isPaused ? '일시정지' : (isVideoMode ? '녹화 중...' : '녹음 중...');
      statusElement.classList.toggle('recording', !isPaused);
      statusElement.classList.toggle('paused', isPaused);
    }
    settingControls().forEach(el => { el.disabled = true; });
  } else if (recordingState === RECORDING_STATES.PROCESSING) {
    // 처리 중
    stopElapsedTimer();
    if (recordButton) {
      recordButton.textContent = '처리 중...';
      recordButton.disabled = true;
      recordButton.classList.remove('recording');
      recordButton.classList.add('processing');
    }
    if (statusElement) {
      statusElement.textContent = '파일 생성 중...';
      statusElement.classList.remove('recording');
      statusElement.classList.remove('paused');
    }
    settingControls().forEach(el => { el.disabled = true; });
  } else {
    // 대기 중
    stopElapsedTimer();
    if (recordButton) {
      recordButton.textContent = '녹화 시작';
      recordButton.classList.remove('recording');
      recordButton.classList.remove('processing');
      recordButton.disabled = false;
    }
    if (statusElement) {
      statusElement.textContent = '대기 중';
      statusElement.classList.remove('recording');
      statusElement.classList.remove('paused');
    }
    if (timeDisplay) {
      timeDisplay.textContent = '00:00';
    }
    settingControls().forEach(el => { el.disabled = false; });
    updateModeVisibility();

    // 완료 메시지: 저장 진행 중이면 안내, 모두 끝나면 결과 요약
    const completedFiles = Array.isArray(state.files) ? state.files : [];
    if (state.state === RECORDING_STATES.IDLE && completedFiles.length > 0) {
      if (state.saving) {
        showMessage(`파일 ${completedFiles.length}개 저장 중... (${completedFiles.map(fileLabel).join(', ')})`, 'info', { sticky: true });
      } else {
        const failed = completedFiles.filter(f => f.downloadState && f.downloadState !== 'complete');
        const saved = completedFiles.filter(f => !failed.includes(f));
        if (saved.length > 0) {
          showMessage(describeSavedFiles(saved), 'success', { hideAfter: 5000 });
        }
      }
      currentState.elapsed = 0;
    } else if (state.state === RECORDING_STATES.IDLE && currentState.elapsed > 0) {
      hideMessage();
      currentState.elapsed = 0;
    }
  }

  updateTime(currentState.elapsed);
}

// 파일 표시 이름 (fMP4는 .mp4 파일이므로 "MP4")
function fileLabel(file) {
  return file.label || formatLabel(file.format);
}

// 완료 메시지: 파일이 저장된 곳(선택한 폴더 / 다운로드 폴더)을 함께 알림
function describeSavedFiles(files) {
  const formats = (list) => list.map(fileLabel).join(', ');
  const inFolder = files.filter(f => f.savedTo === SAVE_LOCATIONS.FOLDER);
  const downloaded = files.filter(f => f.savedTo !== SAVE_LOCATIONS.FOLDER);
  const folderName = inFolder.length ? (inFolder[0].location || '선택한 폴더') : '';
  if (downloaded.length === 0) {
    return `녹화가 완료되어 ${files.length}개 파일이 '${folderName}'에 저장되었습니다. (${formats(files)})`;
  }
  if (inFolder.length === 0) {
    return `녹화가 완료되어 ${files.length}개 파일이 다운로드 폴더에 저장되었습니다. (${formats(files)})`;
  }
  return `녹화가 완료되었습니다. '${folderName}'에 ${inFolder.length}개 (${formats(inFolder)}), 다운로드 폴더에 ${downloaded.length}개 (${formats(downloaded)}) 저장되었습니다.`;
}

// 시간 표시 업데이트
function updateTime(elapsed) {
  currentState.elapsed = elapsed;
  if (timeDisplay) {
    timeDisplay.textContent = formatTime(elapsed);
  }
}

// 메시지 표시
// options.sticky: 자동 숨김 타이머를 취소하고 유지 (에러/경고가 성공 메시지 타이머에 지워지지 않도록)
// options.hideAfter: 지정 ms 후 자동 숨김
function showMessage(text, type = 'info', { sticky = false, hideAfter = 0 } = {}) {
  if (messageHideTimer) {
    clearTimeout(messageHideTimer);
    messageHideTimer = null;
  }
  if (messageElement) {
    messageElement.textContent = text;
    messageElement.className = `message ${type} show`;
  }
  if (!sticky && hideAfter > 0) {
    messageHideTimer = setTimeout(hideMessage, hideAfter);
  }
}

// 메시지 숨김
function hideMessage() {
  if (messageElement) {
    messageElement.className = 'message';
  }
}

// 사용자 설정 로드
async function loadUserSettings() {
  try {
    const settings = await loadSettings();
    console.log('[Popup] 사용자 설정 로드:', settings);

    // UI에 설정 적용 (null 체크)
    if (formatSelect) {
      formatSelect.value = settings.fileFormat;
    }
    if (bitrateSelect) {
      bitrateSelect.value = settings.bitrate;
    }
    if (sampleRateSelect) {
      sampleRateSelect.value = settings.sampleRate;
    }
    if (modeSelect) {
      modeSelect.value = settings.recordingMode || RECORDING_MODES.AUDIO_ONLY;
    }
    if (videoFormatSelect) {
      videoFormatSelect.value = settings.videoFormat || VIDEO_SETTINGS.DEFAULT_FORMAT;
    }
    applySaveLocationSetting(settings);
    updateModeVisibility();
  } catch (error) {
    console.error('[Popup] 설정 로드 실패:', error);
  }
}

// 모드별 설정 활성 규칙 (왼쪽 영상 열 / 오른쪽 오디오 열)
// - AUDIO_ONLY: 영상 열은 보이되 비활성(회색) + "영상 녹화 안 함"
// - VIDEO_AUDIO: 오디오 포맷만 비활성 + "영상 파일에 포함" (비트레이트·샘플레이트는 영상 파일 속 MP3에 적용되므로 활성)
// - VIDEO_AUDIO_SPLIT: 모두 활성
// 녹화·일시정지·처리 중에는 updateUI가 모든 설정을 비활성화하므로 선택 상자의 disabled는 대기 중에만 바꿈
function updateModeVisibility() {
  const mode = modeSelect ? modeSelect.value : RECORDING_MODES.AUDIO_ONLY;
  const videoEnabled = mode !== RECORDING_MODES.AUDIO_ONLY;
  const audioFileEnabled = mode !== RECORDING_MODES.VIDEO_AUDIO;
  const locked = isSessionActive(currentState.state) || currentState.state === RECORDING_STATES.PROCESSING;

  if (videoColumn) videoColumn.classList.toggle('disabled', !videoEnabled);
  if (videoColumnNote) videoColumnNote.classList.toggle('hidden', videoEnabled);
  if (videoHint) videoHint.classList.toggle('hidden', !videoEnabled);
  if (audioFormatGroup) audioFormatGroup.classList.toggle('disabled', !audioFileEnabled);
  if (audioFormatNote) audioFormatNote.classList.toggle('hidden', audioFileEnabled);
  if (!locked) {
    if (videoFormatSelect) videoFormatSelect.disabled = !videoEnabled;
    if (formatSelect) formatSelect.disabled = !audioFileEnabled;
  }
}

// 녹화 모드 변경 핸들러
async function handleModeChange() {
  if (!modeSelect) return;

  try {
    const mode = modeSelect.value;
    if (!Object.values(RECORDING_MODES).includes(mode)) {
      console.error('[Popup] 유효하지 않은 녹화 모드:', mode);
      showMessage('유효하지 않은 녹화 모드입니다', 'error');
      return;
    }

    updateModeVisibility();
    const success = await saveSetting('recordingMode', mode);
    if (!success) {
      showMessage('설정 저장에 실패했습니다', 'error');
    }
  } catch (error) {
    console.error('[Popup] 모드 변경 중 에러:', error);
    showMessage('설정 저장 중 오류가 발생했습니다', 'error');
  }
}

// 영상 포맷 변경 핸들러
async function handleVideoFormatChange() {
  if (!videoFormatSelect) return;

  try {
    const success = await saveSetting('videoFormat', videoFormatSelect.value);
    if (!success) {
      showMessage('설정 저장에 실패했습니다', 'error');
    }
  } catch (error) {
    console.error('[Popup] 영상 포맷 변경 중 에러:', error);
    showMessage('설정 저장 중 오류가 발생했습니다', 'error');
  }
}

// 포맷 변경 핸들러
async function handleFormatChange() {
  if (!formatSelect) return;

  try {
    const format = formatSelect.value;
    const success = await saveSetting('fileFormat', format);

    if (success) {
      console.log('[Popup] 포맷 저장 성공:', format);
    } else {
      console.error('[Popup] 포맷 저장 실패:', format);
      showMessage('설정 저장에 실패했습니다', 'error');
    }
  } catch (error) {
    console.error('[Popup] 포맷 변경 중 에러:', error);
    showMessage('설정 저장 중 오류가 발생했습니다', 'error');
  }
}

// 비트레이트 변경 핸들러
async function handleBitrateChange() {
  if (!bitrateSelect) return;

  try {
    const bitrate = parseInt(bitrateSelect.value);

    if (isNaN(bitrate) || bitrate <= 0) {
      console.error('[Popup] 유효하지 않은 비트레이트:', bitrateSelect.value);
      showMessage('유효하지 않은 비트레이트 값입니다', 'error');
      return;
    }

    const success = await saveSetting('bitrate', bitrate);

    if (success) {
      console.log('[Popup] 비트레이트 저장 성공:', bitrate);
    } else {
      console.error('[Popup] 비트레이트 저장 실패:', bitrate);
      showMessage('설정 저장에 실패했습니다', 'error');
    }
  } catch (error) {
    console.error('[Popup] 비트레이트 변경 중 에러:', error);
    showMessage('설정 저장 중 오류가 발생했습니다', 'error');
  }
}

// 샘플레이트 변경 핸들러
async function handleSampleRateChange() {
  if (!sampleRateSelect) return;

  try {
    const sampleRate = parseInt(sampleRateSelect.value);

    if (isNaN(sampleRate) || sampleRate <= 0) {
      console.error('[Popup] 유효하지 않은 샘플레이트:', sampleRateSelect.value);
      showMessage('유효하지 않은 샘플레이트 값입니다', 'error');
      return;
    }

    const success = await saveSetting('sampleRate', sampleRate);

    if (success) {
      console.log('[Popup] 샘플레이트 저장 성공:', sampleRate);
    } else {
      console.error('[Popup] 샘플레이트 저장 실패:', sampleRate);
      showMessage('설정 저장에 실패했습니다', 'error');
    }
  } catch (error) {
    console.error('[Popup] 샘플레이트 변경 중 에러:', error);
    showMessage('설정 저장 중 오류가 발생했습니다', 'error');
  }
}

console.log('Popup 스크립트가 로드되었습니다.');
