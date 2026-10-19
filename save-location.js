// Save Location - 녹화 파일 저장 위치(사용자가 고른 폴더) 관리
//
// - 폴더 핸들(FileSystemDirectoryHandle)은 chrome.storage에 넣을 수 없어(구조화 복제만 가능) 확장 출처의 IndexedDB에 보관합니다.
//   같은 출처(chrome-extension://<id>)인 설정 페이지·팝업·offscreen 문서가 모두 같은 핸들을 읽습니다.
// - 팝업이 IndexedDB 없이 폴더 모드인지 알 수 있도록(녹화 시작 때 권한 확인 여부) { saveLocationMode, saveLocationName } 문자열만
//   chrome.storage.sync 설정에 미러링합니다 (storage.js). 저장 위치 표시는 설정 페이지에서만 합니다.
// - Node 테스트는 setIndexedDBFactory()로 가짜 IndexedDB를 주입합니다.
import { SAVE_LOCATIONS } from './constants.js';
import { saveSettings } from './storage.js';

export const SAVE_LOCATION_DB = { NAME: 'recorda-save-location', VERSION: 1, STORE: 'handles', KEY: 'saveDirectory' };
const READWRITE = { mode: 'readwrite' };
const DEFAULT_FOLDER_NAME = '선택한 폴더';

let indexedDBFactory = null; // null이면 globalThis.indexedDB

/** IndexedDB 팩토리 주입 (테스트용). null이면 브라우저 기본 indexedDB */
export function setIndexedDBFactory(factory) {
  indexedDBFactory = factory || null;
}

function getFactory() {
  const factory = indexedDBFactory || globalThis.indexedDB;
  if (!factory || typeof factory.open !== 'function') {
    throw new Error('IndexedDB를 사용할 수 없어 저장 폴더 정보를 읽거나 쓸 수 없습니다');
  }
  return factory;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = getFactory().open(SAVE_LOCATION_DB.NAME, SAVE_LOCATION_DB.VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SAVE_LOCATION_DB.STORE)) db.createObjectStore(SAVE_LOCATION_DB.STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 열기 실패'));
    request.onblocked = () => reject(new Error('IndexedDB가 다른 연결에 의해 차단되었습니다'));
  });
}

/** 트랜잭션 하나에서 요청 하나를 실행하고, 트랜잭션이 커밋된 뒤 결과를 돌려줍니다. 연결은 매번 닫습니다. */
async function runRequest(mode, makeRequest) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SAVE_LOCATION_DB.STORE, mode);
      let result;
      const request = makeRequest(tx.objectStore(SAVE_LOCATION_DB.STORE));
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error('IndexedDB 요청 실패'));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || request.error || new Error('IndexedDB 트랜잭션 실패'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 트랜잭션 중단'));
    });
  } finally {
    try { db.close(); } catch { /* 무시 */ }
  }
}

function describeError(error) {
  if (!error) return '알 수 없는 오류';
  if (error.name && error.name !== 'Error') return `${error.name}: ${error.message}`;
  return error.message || String(error);
}

/** 표시용 폴더 이름 (OPFS 루트처럼 이름이 비어 있으면 대체 이름) */
export function folderDisplayName(handle) {
  if (!handle) return '';
  return typeof handle.name === 'string' && handle.name ? handle.name : DEFAULT_FOLDER_NAME;
}

/**
 * 저장 폴더를 설정합니다: 핸들은 IndexedDB에, 모드/이름 문자열은 chrome.storage.sync에 미러링
 * @param {FileSystemDirectoryHandle} handle
 */
export async function saveDirectoryHandle(handle) {
  if (!handle || handle.kind !== 'directory') {
    throw new Error('저장할 폴더 핸들(FileSystemDirectoryHandle)이 필요합니다');
  }
  const name = folderDisplayName(handle);
  await runRequest('readwrite', (store) => store.put({ handle, name, savedAt: Date.now() }, SAVE_LOCATION_DB.KEY));
  await saveSettings({ saveLocationMode: SAVE_LOCATIONS.FOLDER, saveLocationName: name });
  console.log('[SaveLocation] 저장 폴더 설정:', name);
}

/**
 * 저장된 폴더 핸들을 읽습니다 (없으면 null). IndexedDB 오류는 그대로 던져 호출자가 폴백을 결정합니다.
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function loadDirectoryHandle() {
  const entry = await runRequest('readonly', (store) => store.get(SAVE_LOCATION_DB.KEY));
  return entry && entry.handle ? entry.handle : null;
}

/** 저장 폴더 설정을 지우고 기본(다운로드 폴더)으로 되돌립니다 */
export async function clearDirectoryHandle() {
  await runRequest('readwrite', (store) => store.delete(SAVE_LOCATION_DB.KEY));
  await saveSettings({ saveLocationMode: SAVE_LOCATIONS.DOWNLOADS, saveLocationName: '' });
  console.log('[SaveLocation] 저장 위치를 기본(다운로드 폴더)으로 되돌림');
}

/**
 * 현재 저장 위치 요약
 * @returns {Promise<{mode: 'downloads'|'folder', name: string}>}
 */
export async function getSaveLocationInfo() {
  try {
    const handle = await loadDirectoryHandle();
    if (handle) return { mode: SAVE_LOCATIONS.FOLDER, name: folderDisplayName(handle) };
  } catch (error) {
    console.warn('[SaveLocation] 저장 폴더 정보 조회 실패 - 기본(다운로드)으로 간주:', error && error.message);
  }
  return { mode: SAVE_LOCATIONS.DOWNLOADS, name: '' };
}

/**
 * 폴더의 readwrite 권한 상태 ('granted' | 'prompt' | 'denied').
 * queryPermission이 없는 구현은 granted로 보고 실제 쓰기(createWritable)에서 판단합니다. 조회 자체가 실패하면 denied.
 */
export async function queryFolderPermission(handle) {
  if (!handle) return 'denied';
  if (typeof handle.queryPermission !== 'function') return 'granted';
  try {
    return await handle.queryPermission(READWRITE);
  } catch (error) {
    console.warn('[SaveLocation] 권한 조회 실패:', describeError(error));
    return 'denied';
  }
}

/**
 * readwrite 권한을 요청합니다 (사용자 제스처 안에서 호출해야 Chrome이 묻습니다).
 * 요청 자체가 실패하면(제스처 없음, 프롬프트를 띄울 수 없는 문맥 등) 현재 상태를 돌려줍니다.
 */
export async function requestFolderPermission(handle) {
  if (!handle) return 'denied';
  if (typeof handle.requestPermission !== 'function') return queryFolderPermission(handle);
  try {
    return await handle.requestPermission(READWRITE);
  } catch (error) {
    console.warn('[SaveLocation] 권한 요청 실패:', describeError(error));
    return queryFolderPermission(handle);
  }
}

/**
 * 작은 확인 파일을 만들고 지워서 폴더에 실제로 쓸 수 있는지 확인합니다. 실패하면 이유가 담긴 오류를 던집니다.
 * @param {FileSystemDirectoryHandle} dir
 */
export async function verifyFolderWritable(dir) {
  if (!dir || typeof dir.getFileHandle !== 'function') {
    throw new Error('폴더 핸들이 필요합니다');
  }
  const probeName = `.recorda-write-test-${Date.now()}.tmp`;
  let failure = null;
  let created = false;
  try {
    const fileHandle = await dir.getFileHandle(probeName, { create: true });
    created = true;
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(new Uint8Array([0x72, 0x65, 0x63])); // 'rec'
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch { /* 무시 */ }
      throw error;
    }
  } catch (error) {
    failure = error;
  }
  if (created) {
    try {
      await dir.removeEntry(probeName);
    } catch (error) {
      failure = failure || error;
    }
  }
  if (failure) {
    throw new Error(`폴더에 파일을 쓸 수 없습니다 (${describeError(failure)})`);
  }
}

async function entryExists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (error) {
    if (error && error.name === 'NotFoundError') return false;
    if (error && error.name === 'TypeMismatchError') return true; // 같은 이름의 폴더
    throw error;
  }
}

/**
 * 폴더에 같은 이름의 파일이 있으면 덮어쓰지 않도록 " (1)", " (2)"...를 붙인 기본 이름을 고릅니다.
 * 모든 출력 확장자(예: mp4 + wav)가 비어 있는 이름을 고르므로 분리 저장 파일들이 같은 이름을 공유합니다.
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} baseName - 예: recorda_20261016_120000
 * @param {string[]} extensions - 이번 녹화가 만들 수 있는 확장자
 */
export async function findAvailableBaseName(dir, baseName, extensions, maxAttempts = 100) {
  const exts = [...new Set(extensions)];
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = i === 0 ? baseName : `${baseName} (${i})`;
    let taken = false;
    for (const ext of exts) {
      if (await entryExists(dir, `${candidate}.${ext}`)) { taken = true; break; }
    }
    if (!taken) return candidate;
  }
  return `${baseName}_${Date.now()}`;
}
