// Utility Functions - 공통 유틸리티 함수

/**
 * 초를 MM:SS 또는 HH:MM:SS 형식으로 변환
 * @param {number} seconds - 초 단위 시간
 * @returns {string} 포맷팅된 시간 문자열
 */
export function formatTime(seconds) {
  // 입력 검증
  if (typeof seconds !== 'number' || isNaN(seconds) || !isFinite(seconds)) {
    console.error('[Utils] formatTime: 유효하지 않은 초 값:', seconds);
    return '00:00';
  }

  // 음수를 0으로 처리
  if (seconds < 0) {
    seconds = 0;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

/**
 * 현재 날짜/시간을 YYYYMMDD_HHMMSS 형식으로 변환
 * @param {Date} date - Date 객체 (기본값: 현재 시간)
 * @returns {string} 포맷팅된 날짜 문자열
 */
export function formatDate(date = new Date()) {
  // 입력 검증
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    console.error('[Utils] formatDate: 유효하지 않은 Date 객체:', date);
    date = new Date(); // 기본값으로 현재 시간 사용
  }

  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');

  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * 녹음 파일명 생성
 * @param {string} format - 파일 형식 (mp3, wav 등)
 * @returns {string} 생성된 파일명
 */
export function generateFilename(format = 'mp3') {
  // 입력 검증
  if (typeof format !== 'string' || format.trim().length === 0) {
    console.error('[Utils] generateFilename: 유효하지 않은 포맷:', format);
    format = 'mp3'; // 기본값 사용
  }

  // 확장자에서 특수문자 제거 (안전한 파일명 생성)
  format = format.trim().replace(/[^a-zA-Z0-9]/g, '');

  const timestamp = formatDate();
  return `recorda_${timestamp}.${format}`;
}

/**
 * 확장자 문자열을 안전하게 정리 (영숫자만 허용)
 * @param {string} format
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeExtension(format, fallback) {
  if (typeof format !== 'string' || format.trim().length === 0) {
    return fallback;
  }
  const cleaned = format.trim().replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * 녹화 출력 목록에 대해 같은 타임스탬프를 공유하는 파일명을 생성
 * @param {Array<{kind: string, format: string}>} outputs - 출력 목록
 * @param {Date} [date] - 기준 시각 (기본값: 현재 시간)
 * @returns {Array<{kind: string, format: string, filename: string}>}
 */
export function generateRecordingFilenames(outputs, date = new Date()) {
  if (!Array.isArray(outputs)) {
    console.error('[Utils] generateRecordingFilenames: outputs가 배열이 아닙니다:', outputs);
    return [];
  }

  const timestamp = formatDate(date);

  return outputs.map((output) => {
    const fallback = output.kind === 'video' ? 'mp4' : 'mp3';
    const ext = sanitizeExtension(output.format, fallback);
    return { ...output, filename: `recorda_${timestamp}.${ext}` };
  });
}

/**
 * ArrayBuffer를 Blob으로 변환
 * @param {ArrayBuffer} buffer - ArrayBuffer 데이터
 * @param {string} mimeType - MIME 타입
 * @returns {Blob} Blob 객체
 */
export function arrayBufferToBlob(buffer, mimeType) {
  // 입력 검증
  if (!buffer || !(buffer instanceof ArrayBuffer)) {
    console.error('[Utils] arrayBufferToBlob: 유효하지 않은 ArrayBuffer:', buffer);
    throw new Error('유효한 ArrayBuffer가 필요합니다');
  }

  if (typeof mimeType !== 'string' || mimeType.trim().length === 0) {
    console.error('[Utils] arrayBufferToBlob: 유효하지 않은 MIME 타입:', mimeType);
    throw new Error('유효한 MIME 타입이 필요합니다');
  }

  return new Blob([buffer], { type: mimeType });
}

/**
 * Blob을 ArrayBuffer로 변환
 * @param {Blob} blob - Blob 객체
 * @returns {Promise<ArrayBuffer>} ArrayBuffer Promise
 */
export function blobToArrayBuffer(blob) {
  // 입력 검증
  if (!blob || !(blob instanceof Blob)) {
    console.error('[Utils] blobToArrayBuffer: 유효하지 않은 Blob:', blob);
    return Promise.reject(new Error('유효한 Blob 객체가 필요합니다'));
  }

  return blob.arrayBuffer();
}

/**
 * 경과 시간 계산 (밀리초)
 * @param {number} startTime - 시작 시간 (타임스탬프)
 * @returns {number} 경과 시간 (밀리초)
 */
export function getElapsedTime(startTime) {
  // 입력 검증
  if (typeof startTime !== 'number' || isNaN(startTime) || !isFinite(startTime)) {
    console.error('[Utils] getElapsedTime: 유효하지 않은 시작 시간:', startTime);
    return 0;
  }

  // 미래 시간 처리
  const elapsed = Date.now() - startTime;
  if (elapsed < 0) {
    console.warn('[Utils] getElapsedTime: 시작 시간이 미래입니다:', startTime);
    return 0;
  }

  return elapsed;
}

/**
 * 경과 시간을 초 단위로 계산
 * @param {number} startTime - 시작 시간 (타임스탬프)
 * @returns {number} 경과 시간 (초)
 */
export function getElapsedSeconds(startTime) {
  // 입력 검증은 getElapsedTime에서 수행됨
  return Math.floor(getElapsedTime(startTime) / 1000);
}
