// Settings Page - 녹화 파일 저장 위치(폴더) 설정 (options_page)
// File System Access API(showDirectoryPicker)로 고른 폴더 핸들을 IndexedDB에 보관하고(save-location.js),
// 팝업이 폴더 모드인지 알 수 있도록 모드·이름 문자열은 chrome.storage.sync에 미러링합니다 (저장 위치는 이 페이지에서만 표시).
// 폴더 선택 창은 팝업에서 열면 팝업이 포커스를 잃고 닫히므로 이 페이지(탭)에서만 엽니다.
import {
  loadDirectoryHandle,
  saveDirectoryHandle,
  clearDirectoryHandle,
  queryFolderPermission,
  requestFolderPermission,
  verifyFolderWritable,
  folderDisplayName
} from './save-location.js';

const currentLocation = document.getElementById('currentLocation');
const permissionRow = document.getElementById('permissionRow');
const permissionStatus = document.getElementById('permissionStatus');
const requestPermissionButton = document.getElementById('requestPermissionButton');
const pickFolderButton = document.getElementById('pickFolderButton');
const resetFolderButton = document.getElementById('resetFolderButton');
const settingsMessage = document.getElementById('settingsMessage');

const PERMISSION_TEXT = {
  granted: '권한: 허용됨 - 녹화 파일을 이 폴더에 바로 저장합니다.',
  prompt: '권한: 확인 필요 - 녹화를 시작할 때 다시 묻습니다. 지금 허용하려면 "권한 다시 요청"을 누르세요.',
  denied: '권한: 거부됨 - "권한 다시 요청"을 누르거나 폴더를 다시 선택하세요. 그동안 녹화는 다운로드 폴더에 저장됩니다.'
};

let busy = false;

function showMessage(text, type = 'info') {
  settingsMessage.textContent = text;
  settingsMessage.dataset.type = type;
  settingsMessage.className = `message ${type}`;
}

function clearMessage() {
  settingsMessage.textContent = '';
  settingsMessage.dataset.type = '';
  settingsMessage.className = 'message hidden';
}

// 현재 저장 위치와 권한 상태를 화면에 반영
async function refresh() {
  let handle = null;
  try {
    handle = await loadDirectoryHandle();
  } catch (error) {
    console.error('[Settings] 저장 폴더 정보 읽기 실패:', error);
    showMessage(`저장 폴더 정보를 읽지 못했습니다: ${error.message}`, 'error');
  }

  pickFolderButton.disabled = busy;
  if (!handle) {
    currentLocation.textContent = '기본: 다운로드 폴더';
    currentLocation.classList.remove('folder');
    resetFolderButton.disabled = true;
    permissionRow.classList.add('hidden');
    requestPermissionButton.classList.add('hidden');
    delete permissionStatus.dataset.state;
    return { handle: null, permission: null };
  }

  currentLocation.textContent = folderDisplayName(handle);
  currentLocation.classList.add('folder');
  resetFolderButton.disabled = busy;
  const permission = await queryFolderPermission(handle);
  permissionRow.classList.remove('hidden');
  permissionStatus.textContent = PERMISSION_TEXT[permission] || `권한: ${permission}`;
  permissionStatus.dataset.state = permission;
  requestPermissionButton.classList.toggle('hidden', permission === 'granted');
  requestPermissionButton.disabled = busy;
  return { handle, permission };
}

// 버튼 동작 중복 실행 방지 (선택 창·권한 창이 떠 있는 동안 다시 누르지 않도록)
function guarded(action) {
  return async () => {
    if (busy) return;
    busy = true;
    [pickFolderButton, resetFolderButton, requestPermissionButton].forEach((button) => { button.disabled = true; });
    try {
      await action();
    } catch (error) {
      console.error('[Settings] 작업 실패:', error);
      showMessage(error.message || '알 수 없는 오류가 발생했습니다.', 'error');
    } finally {
      busy = false;
      await refresh();
    }
  };
}

// 폴더 선택 → 쓰기 확인(확인 파일 생성·삭제) → 저장
async function pickFolder() {
  clearMessage();
  if (typeof window.showDirectoryPicker !== 'function') {
    showMessage('이 브라우저는 폴더 선택(File System Access API)을 지원하지 않습니다. 녹화 파일은 다운로드 폴더에 저장됩니다.', 'error');
    return;
  }

  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'recorda-save-folder', mode: 'readwrite', startIn: 'downloads' });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      console.log('[Settings] 폴더 선택 취소');
      return;
    }
    throw new Error(`폴더를 선택하지 못했습니다: ${error.message}`);
  }

  const name = folderDisplayName(handle);
  try {
    // 선택 창에서 편집을 허용했어도 실제로 파일을 만들 수 있는지 확인 (읽기 전용 위치, 네트워크 드라이브 등)
    await verifyFolderWritable(handle);
  } catch (error) {
    console.warn('[Settings] 폴더 쓰기 확인 실패:', name, error);
    showMessage(`'${name}' ${error.message}. 다른 폴더를 선택해주세요.`, 'error');
    return;
  }

  await saveDirectoryHandle(handle);
  console.log('[Settings] 저장 폴더 설정:', name);
  showMessage(`'${name}' 폴더에 녹화 파일을 바로 저장합니다.`, 'success');
}

// 기본(다운로드 폴더)으로 되돌리기
async function resetFolder() {
  clearMessage();
  await clearDirectoryHandle();
  showMessage('녹화 파일을 기본 위치(다운로드 폴더)에 저장합니다.', 'info');
}

// 권한 다시 요청 (Chrome 재시작 후 등 prompt 상태일 때)
async function requestPermissionAgain() {
  clearMessage();
  const handle = await loadDirectoryHandle();
  if (!handle) return;
  const permission = await requestFolderPermission(handle);
  if (permission !== 'granted') {
    showMessage('권한이 허용되지 않았습니다. 그동안 녹화 파일은 다운로드 폴더에 저장됩니다.', 'error');
    return;
  }
  try {
    await verifyFolderWritable(handle);
  } catch (error) {
    showMessage(`권한은 허용됐지만 '${folderDisplayName(handle)}' ${error.message}.`, 'error');
    return;
  }
  showMessage('권한이 허용되었습니다. 녹화 파일을 이 폴더에 바로 저장합니다.', 'success');
}

pickFolderButton.addEventListener('click', guarded(pickFolder));
resetFolderButton.addEventListener('click', guarded(resetFolder));
requestPermissionButton.addEventListener('click', guarded(requestPermissionAgain));

// 다른 탭에서 사이트 권한을 바꾼 뒤 돌아오면 상태 다시 확인
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !busy) refresh();
});

refresh().finally(() => {
  document.body.dataset.ready = 'true';
});
