// Recording Plan - 녹화 모드/포맷/오디오 소스 설정을 실제 캡처·출력 계획으로 변환 (순수 함수)
import { RECORDING_MODES, AUDIO_FORMATS, VIDEO_FORMATS, SETTINGS, VIDEO_SETTINGS, AUDIO_SOURCES } from './constants.js';

const VALID_MODES = new Set(Object.values(RECORDING_MODES));
const VALID_AUDIO_FORMATS = new Set(Object.values(AUDIO_FORMATS));
const VALID_VIDEO_FORMATS = new Set(Object.values(VIDEO_FORMATS));
const VALID_AUDIO_SOURCES = new Set(Object.values(AUDIO_SOURCES));

/**
 * 녹화 요청을 계획으로 변환합니다.
 * 영상은 모드로만 정해지고 항상 녹화를 시작한 탭에서 캡처합니다. 오디오 소스는 녹음할 소리(탭 / 마이크 / 둘을 섞음)를 정하며
 * 출력 파일 목록과는 무관합니다 (영상 파일 속 오디오와 별도 오디오 파일 모두 같은 소스).
 * @param {Object} request
 * @param {string} [request.mode] - RECORDING_MODES 값 (기본: AUDIO_ONLY)
 * @param {string} [request.audioFormat] - 오디오 파일 포맷 (기본: mp3)
 * @param {string} [request.videoFormat] - 영상 파일 포맷 (기본: mp4)
 * @param {string} [request.audioSource] - AUDIO_SOURCES 값 (기본: tab)
 * @param {string} [request.micDeviceId] - 마이크 장치 ID (빈 값 = 시스템 기본 마이크)
 * @returns {{ mode: string, audioSource: string, captureVideo: boolean, captureTabAudio: boolean, captureMic: boolean,
 *   micDeviceId: string|null, outputs: Array<Object> }}
 */
export function resolveRecordingPlan(request = {}) {
  const mode = request.mode || RECORDING_MODES.AUDIO_ONLY;
  if (!VALID_MODES.has(mode)) {
    throw new Error(`지원하지 않는 녹화 모드입니다: ${mode}`);
  }

  const audioFormat = request.audioFormat || SETTINGS.DEFAULT_FORMAT;
  if (!VALID_AUDIO_FORMATS.has(audioFormat)) {
    throw new Error(`지원하지 않는 오디오 포맷입니다: ${audioFormat}`);
  }

  const audioSource = request.audioSource || AUDIO_SOURCES.TAB;
  if (!VALID_AUDIO_SOURCES.has(audioSource)) {
    throw new Error(`지원하지 않는 오디오 소스입니다: ${audioSource}`);
  }
  // 마이크만 녹음할 때는 탭 오디오를 캡처하지 않음 (탭은 캡처되지 않으므로 평소처럼 소리가 나옴)
  const captureTabAudio = audioSource !== AUDIO_SOURCES.MIC;
  const captureMic = audioSource !== AUDIO_SOURCES.TAB;
  const micDeviceId = captureMic && typeof request.micDeviceId === 'string' && request.micDeviceId ? request.micDeviceId : null;

  const captureVideo = mode !== RECORDING_MODES.AUDIO_ONLY;
  const outputs = [];

  if (captureVideo) {
    const videoFormat = request.videoFormat || VIDEO_SETTINGS.DEFAULT_FORMAT;
    if (!VALID_VIDEO_FORMATS.has(videoFormat)) {
      throw new Error(`지원하지 않는 영상 포맷입니다: ${videoFormat}`);
    }
    outputs.push({ kind: 'video', format: videoFormat, audioCodec: VIDEO_SETTINGS.CONTAINER_AUDIO_CODEC });
  }

  if (mode === RECORDING_MODES.AUDIO_ONLY || mode === RECORDING_MODES.VIDEO_AUDIO_SPLIT) {
    outputs.push({ kind: 'audio', format: audioFormat });
  }

  return { mode, audioSource, captureVideo, captureTabAudio, captureMic, micDeviceId, outputs };
}

/** 이 계획이 녹화를 시작한 탭에서 무언가(영상 또는 탭 오디오)를 캡처하는지 - 아니면 탭 캡처 스트림 ID가 필요 없음 */
export function planCapturesTab(plan) {
  if (!plan) return true;
  return !!plan.captureVideo || plan.captureTabAudio !== false;
}
