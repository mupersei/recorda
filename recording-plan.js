// Recording Plan - 녹화 모드/포맷 설정을 실제 캡처·출력 계획으로 변환 (순수 함수)
import { RECORDING_MODES, AUDIO_FORMATS, VIDEO_FORMATS, SETTINGS, VIDEO_SETTINGS } from './constants.js';

const VALID_MODES = new Set(Object.values(RECORDING_MODES));
const VALID_AUDIO_FORMATS = new Set(Object.values(AUDIO_FORMATS));
const VALID_VIDEO_FORMATS = new Set(Object.values(VIDEO_FORMATS));

/**
 * 녹화 요청을 계획으로 변환합니다.
 * @param {Object} request
 * @param {string} [request.mode] - RECORDING_MODES 값 (기본: AUDIO_ONLY)
 * @param {string} [request.audioFormat] - 오디오 파일 포맷 (기본: mp3)
 * @param {string} [request.videoFormat] - 영상 파일 포맷 (기본: mp4)
 * @returns {{ mode: string, captureVideo: boolean, outputs: Array<Object> }}
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

  return { mode, captureVideo, outputs };
}
