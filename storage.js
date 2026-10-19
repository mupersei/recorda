// Storage Utilities - chrome.storage.sync 관리 유틸리티
import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';

// Race condition 방지를 위한 락 (Promise 체인)
let saveSettingLock = Promise.resolve();

/**
 * 사용자 설정을 로드합니다
 * @returns {Promise<Object>} 사용자 설정 객체
 */
export async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);

    // 설정이 없으면 기본값 반환
    if (!result[STORAGE_KEYS.SETTINGS]) {
      console.log('[Storage] 설정이 없습니다. 기본값 사용:', DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }

    // 기존 설정과 기본값 병합 (스키마 유연성 확보)
    const settings = {
      ...DEFAULT_SETTINGS,
      ...result[STORAGE_KEYS.SETTINGS]
    };

    console.log('[Storage] 설정 로드 완료:', settings);
    return settings;
  } catch (error) {
    console.error('[Storage] 설정 로드 실패:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 특정 설정 값을 저장합니다 (Read-Modify-Write 방식, Race Condition 방지)
 * @param {string} key - 설정 키 (fileFormat, bitrate, sampleRate)
 * @param {*} value - 설정 값
 * @returns {Promise<boolean>} 저장 성공 여부
 */
export async function saveSetting(key, value) {
  // 이전 저장 작업이 완료될 때까지 대기 (순차 처리로 race condition 방지)
  saveSettingLock = saveSettingLock.then(async () => {
    try {
      // 1. Read - 기존 설정 로드
      const currentSettings = await loadSettings();

      // 2. Modify - 특정 키 수정
      currentSettings[key] = value;

      // 3. Write - 전체 객체 저장
      await chrome.storage.sync.set({
        [STORAGE_KEYS.SETTINGS]: currentSettings
      });

      console.log('[Storage] 설정 저장 완료:', key, '=', value);
      return true;
    } catch (error) {
      console.error('[Storage] 설정 저장 실패:', error);
      return false;
    }
  });

  return saveSettingLock;
}

/**
 * 여러 설정 값을 한 번에 저장합니다 (saveSetting과 같은 락으로 직렬화되는 Read-Modify-Write)
 * @param {Object} patch - 바꿀 설정 키/값 (예: { saveLocationMode: 'folder', saveLocationName: 'Recordings' })
 * @returns {Promise<boolean>} 저장 성공 여부
 */
export async function saveSettings(patch) {
  saveSettingLock = saveSettingLock.then(async () => {
    try {
      const currentSettings = await loadSettings();
      const next = { ...currentSettings, ...patch };
      await chrome.storage.sync.set({
        [STORAGE_KEYS.SETTINGS]: next
      });

      console.log('[Storage] 설정 저장 완료:', patch);
      return true;
    } catch (error) {
      console.error('[Storage] 설정 저장 실패:', error);
      return false;
    }
  });

  return saveSettingLock;
}

/**
 * 모든 설정을 초기화합니다
 * @returns {Promise<boolean>} 초기화 성공 여부
 */
export async function resetSettings() {
  try {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS }
    });

    console.log('[Storage] 설정 초기화 완료:', DEFAULT_SETTINGS);
    return true;
  } catch (error) {
    console.error('[Storage] 설정 초기화 실패:', error);
    return false;
  }
}
