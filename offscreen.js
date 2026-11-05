import { MESSAGE_TYPES, ERROR_MESSAGES, SETTINGS, VIDEO_SETTINGS, VIDEO_FORMATS, SAVE_LOCATIONS, MIC_SETTINGS } from './constants.js';
import { WavFileEncoder, Mp3FileEncoder } from './audio-file-encoders.js';
import { generateRecordingFilenames, recordingBaseName, fileExtension, formatLabel } from './utils.js';
import { resolveRecordingPlan, planCapturesTab } from './recording-plan.js';
import { VideoRecordingSession } from './video-recorder.js';
import { createRecordingStorage, cleanupStaleRecordings, DirectoryFileSink, FailoverFileSink } from './storage/chunk-store.js';
import { loadDirectoryHandle, queryFolderPermission, findAvailableBaseName, folderDisplayName } from './save-location.js';

const AUDIO_MIME_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav' };
// 캡처 경고의 시작 안내 문구 (완료 경고는 과거형, 녹화 시작 직후 팝업 안내는 현재형)
const START_NOTICES = { [ERROR_MESSAGES.MIC_FALLBACK_DEFAULT]: ERROR_MESSAGES.MIC_FALLBACK_DEFAULT_START };

// 전역 변수
let audioContext = null;
let audioSource = null;         // 탭 오디오 MediaStreamSource (destination 루프백 + 탭 GainNode)
let stream = null;              // 탭 캡처 스트림 (탭 오디오 및/또는 영상). 오디오만 + 마이크면 null
// 마이크 (오디오 소스 mic / tab+mic): 소스마다 MediaStreamSource → GainNode(1) → 공용 AudioWorklet에서 섞임
let micStream = null;
let micSource = null;
let tabGain = null;
let micGain = null;
let captureWarnings = [];      // 캡처 관련 경고 (고른 마이크 없음 → 기본 마이크 등). RECORDING_STARTED / COMPLETE에 포함
let recordingPlan = null;
let recordingBitrate = SETTINGS.DEFAULT_BITRATE / 1000; // kbps
let recordingSampleRate = 44100;

// 스트리밍 인코딩 관련 변수
let streamingEncoder = null;   // 오디오 단독 파일 인코더 (MP3/WAV)
let videoSession = null;       // 영상(+컨테이너 오디오) 세션
let audioWorkletNode = null;
let heartbeatTimer = null;     // Background SW 유휴 종료 방지 + 상태 복구용 하트비트
let heartbeatPayload = null;
let recordingStorage = null;   // 녹화 데이터 저장소 (OPFS 디스크, 폴백: 메모리)
let stopping = false;          // 중복 중지 방지 (STOP_CAPTURE와 트랙 종료가 동시에 올 수 있음)
let isCapturing = false;

// 저장 위치: 사용자가 설정 페이지에서 고른 폴더에 직접 기록하거나(복사 없음), 기본처럼 OPFS에 만든 뒤 다운로드
let saveFolder = null;         // 이번 녹화의 저장 폴더 { dir, name } (null이면 OPFS → chrome.downloads)
let saveWarnings = [];         // 폴더에 저장하지 못하고 다운로드로 바꾼 이유 (RECORDING_COMPLETE warning)
let recordingFileBase = null;  // 출력 파일 공통 이름 (녹화 시작 시각 기준, 폴더에 같은 이름이 있으면 " (n)")
let audioOutput = null;        // 오디오 파일 싱크 { sink, inFolder } (폴더 저장 시 폴더 파일 + OPFS 예비본)

// 일시정지: 캡처 스트림·루프백·하트비트는 유지하고 인코더 입력(PCM, 영상 프레임)만 멈춤
let paused = false;
// 워크릿에 보낸 pause 중 'paused' 응답을 아직 못 받은 수. 응답 전에 도착한 PCM은 일시정지 직전 구간이므로 기록
let workletPauseAcksPending = 0;
let workletPauseTimer = null;
const WORKLET_PAUSE_ACK_TIMEOUT_MS = 300;

console.log('Offscreen Document 로드됨');

// 메시지 리스너
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Offscreen이 처리해야 할 메시지만 로그
  if ([MESSAGE_TYPES.START_CAPTURE, MESSAGE_TYPES.STOP_CAPTURE, MESSAGE_TYPES.PAUSE_CAPTURE, MESSAGE_TYPES.RESUME_CAPTURE].includes(message.action)) {
    console.log('Offscreen 메시지 수신:', message);
  }

  switch (message.action) {
    case MESSAGE_TYPES.START_CAPTURE:
      handleStartCapture(message.data, sendResponse);
      return true;

    case MESSAGE_TYPES.STOP_CAPTURE:
      handleStopCapture(sendResponse);
      return true;

    case MESSAGE_TYPES.PAUSE_CAPTURE:
      handlePauseCapture(message.data, sendResponse);
      return true;

    case MESSAGE_TYPES.RESUME_CAPTURE:
      handleResumeCapture(message.data, sendResponse);
      return true;

    default:
      // Offscreen이 처리할 필요 없는 메시지는 조용히 무시
      return false;
  }
});

// 캡처 시작 (오디오 / 영상+오디오)
async function handleStartCapture(data, sendResponse) {
  try {
    console.log('[Offscreen] ===== 캡처 시작 =====');
    console.log('[Offscreen] 받은 데이터:', data);

    if (isCapturing) {
      throw new Error(ERROR_MESSAGES.ALREADY_RECORDING);
    }

    const { streamId, format, bitrate, sampleRate, plan, tabId, startTime, heartbeatIntervalMs, saveToFolder } = data;

    // 녹화 계획 (Background에서 전달, 없으면 기존 오디오 전용 동작)
    recordingPlan = plan || resolveRecordingPlan({ audioFormat: format });
    recordingBitrate = bitrate || (SETTINGS.DEFAULT_BITRATE / 1000);
    recordingSampleRate = sampleRate || 44100;
    heartbeatPayload = {
      tabId: tabId ?? null,
      startTime: startTime ?? Date.now(),
      plan: recordingPlan,
      format: recordingPlan.outputs.find(o => o.kind === 'audio')?.format || format,
      // 일시정지 상태도 함께 보내 SW가 상태를 잃었을 때 PAUSED로 복구할 수 있게 함
      paused: false,
      pausedAt: null,
      pausedTotalMs: 0
    };
    stopping = false;
    resetPauseState();

    // 녹화 데이터 저장소: 인코딩 결과를 메모리 대신 디스크(OPFS)에 두어 장시간 녹화에서도 메모리가 늘지 않게 함
    const storageManager = (typeof navigator !== 'undefined' && navigator.storage) ? navigator.storage : null;
    const sessionId = `rec-${Date.now()}`;
    recordingStorage = await createRecordingStorage(storageManager, sessionId);
    console.log('[Offscreen] 녹화 저장소:', recordingStorage.kind);
    // 이전 녹화의 임시 파일 정리 (다운로드가 끝난 뒤 남아 있던 것)
    cleanupStaleRecordings(storageManager, sessionId).then((n) => { if (n) console.log('[Offscreen] 이전 녹화 임시 파일 정리:', n, '개'); });

    saveWarnings = [];
    captureWarnings = [];
    audioOutput = null;
    saveFolder = null;

    console.log('[Offscreen] 녹화 계획:', recordingPlan);

    // 오디오 소스: 탭 오디오(tab, tab+mic) / 마이크(mic, tab+mic). 이전 형식 계획(필드 없음)은 탭 오디오만
    const captureTabAudio = recordingPlan.captureTabAudio !== false;
    const captureMic = recordingPlan.captureMic === true;

    // 탭 캡처: 영상 또는 탭 오디오가 필요할 때만 (오디오만 + 마이크는 탭에서 캡처할 것이 없어 Background가 스트림 ID를 발급하지 않음)
    if (planCapturesTab(recordingPlan)) {
      if (!streamId) {
        throw new Error(ERROR_MESSAGES.CAPTURE_FAILED);
      }
      // Manifest V3 방식: streamId를 사용하여 MediaStream 획득. 마이크만 녹음하면 탭 오디오는 요청하지 않음
      // (캡처하지 않은 탭은 평소처럼 소리가 나므로 루프백도 필요 없음)
      const constraints = {
        audio: captureTabAudio
          ? {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId
            }
          }
          : false,
        video: recordingPlan.captureVideo
          ? {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId,
              maxWidth: VIDEO_SETTINGS.MAX_WIDTH,
              maxHeight: VIDEO_SETTINGS.MAX_HEIGHT,
              maxFrameRate: VIDEO_SETTINGS.FRAME_RATE
            }
          }
          : false
      };

      console.log('[Offscreen] Constraints:', JSON.stringify(constraints, null, 2));

      stream = await navigator.mediaDevices.getUserMedia(constraints);

      if (!stream) {
        throw new Error(ERROR_MESSAGES.CAPTURE_FAILED);
      }

      const audioTracks = stream.getAudioTracks();
      console.log('[Offscreen] 오디오 트랙 개수:', audioTracks.length);
      if (captureTabAudio && audioTracks.length === 0) {
        throw new Error(ERROR_MESSAGES.NO_AUDIO);
      }
    }

    // 마이크: 탭 스트림 ID를 쓴 다음에 엶 (스트림 ID는 발급 직후 써야 함). 권한은 설정 페이지에서 미리 허용 (offscreen은 권한 창을 띄울 수 없음)
    if (captureMic) {
      micStream = await openMicStream(recordingPlan.micDeviceId);
    }

    let videoTrack = null;
    if (recordingPlan.captureVideo) {
      const videoTracks = stream.getVideoTracks();
      console.log('[Offscreen] 비디오 트랙 개수:', videoTracks.length);
      if (videoTracks.length === 0) {
        throw new Error(ERROR_MESSAGES.NO_VIDEO);
      }
      videoTrack = videoTracks[0];
      const trackSettings = videoTrack.getSettings ? videoTrack.getSettings() : {};
      console.log('[Offscreen] 비디오 트랙 설정:', trackSettings);
    }

    // 저장 위치 (스트림 ID는 발급 직후 써야 하므로 getUserMedia 뒤에 준비). 파일명은 녹화 시작 시각 기준:
    // 폴더 저장은 오디오 파일을 시작 시점에 만들기 때문에 다운로드 저장도 같은 규칙을 씀
    recordingFileBase = recordingBaseName(new Date(heartbeatPayload.startTime));
    saveFolder = saveToFolder ? await openSaveFolder(recordingPlan, recordingFileBase) : null;
    if (saveFolder) recordingFileBase = saveFolder.baseName;
    console.log('[Offscreen] 저장 위치:', saveFolder ? `폴더 "${saveFolder.name}" (직접 기록)` : '다운로드 폴더', recordingFileBase);

    // 오디오 그래프: 탭 소리는 destination 루프백(사용자가 계속 들을 수 있도록), 마이크는 녹음에만
    setupAudioSources({ tabStream: captureTabAudio ? stream : null, mic: micStream });

    // 스트리밍 녹음/녹화 시작
    await startStreamingRecording(videoTrack);
    isCapturing = true;

    // 탭이 닫히거나 캡처가 끊기면 스스로 마무리
    if (stream) {
      for (const track of stream.getTracks()) {
        track.onended = () => {
          console.warn('[Offscreen] 캡처 트랙 종료 감지:', track.kind);
          if (track.kind === 'video' || !recordingPlan.captureVideo) {
            stopCaptureInternal().catch((error) => console.error('[Offscreen] 트랙 종료 후 중지 실패:', error));
          }
        };
      }
    }
    // 마이크 연결이 끊기면(USB 분리 등): 마이크가 유일한 소스면 마무리, 아니면 계속 녹화하고 경고
    if (micStream) {
      for (const track of micStream.getAudioTracks()) {
        track.onended = () => handleMicTrackEnded(track);
      }
    }

    // 하트비트 시작 (SW가 재시작되어도 녹화 상태를 복구할 수 있도록 식별 정보를 함께 보냄)
    startHeartbeat(heartbeatIntervalMs || SETTINGS.HEARTBEAT_INTERVAL);

    // Background에 시작 알림 (고른 마이크 대신 기본 마이크로 녹음하는 경우 등의 경고 포함, 시작 시점이라 현재형 문구)
    const startWarnings = captureWarnings.map(w => START_NOTICES[w] || w);
    await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.RECORDING_STARTED,
      data: { warnings: startWarnings }
    });

    sendResponse({ success: true, warnings: startWarnings });

    // 시작 도중(캡처 상태가 되기 전)에 영상 파일 쓰기가 이미 실패했다면 지금 멈춤
    if (videoSession && videoSession.writeError) handleVideoWriteError(videoSession.writeError);
  } catch (error) {
    console.error('캡처 시작 실패:', error);

    // 폴더에 미리 만들어 둔 오디오 파일(빈 파일 + 스왑 파일) 정리
    if (audioOutput) {
      const { sink } = audioOutput;
      audioOutput = null;
      sink.abort({ remove: true }).catch(() => {});
    }

    // 부분적으로 생성된 리소스 정리 (이미 프레임을 읽던 영상 세션은 리더를 끝내고 쓰다 만 결과 파일을 지운 뒤 트랙을 멈춤)
    try { await cleanup(); } catch (cleanupError) { console.warn('[Offscreen] 시작 실패 후 정리 중 오류:', cleanupError); }

    const errorMessage = translateCaptureError(error);
    console.error('에러 메시지:', errorMessage);

    chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.RECORDING_ERROR,
      data: { error: errorMessage }
    });

    sendResponse({ success: false, error: errorMessage });
  }
}

// 캡처 에러를 사용자 메시지로 변환
function translateCaptureError(error) {
  if (!error || !error.message) return ERROR_MESSAGES.UNKNOWN;

  const known = Object.values(ERROR_MESSAGES);
  if (known.some(msg => error.message.includes(msg))) {
    return error.message;
  }

  const errorMsg = error.message.toLowerCase();
  if (errorMsg.includes('permission') || errorMsg.includes('denied')) return ERROR_MESSAGES.PERMISSION_DENIED;
  if (errorMsg.includes('loading') || errorMsg.includes('not ready')) return ERROR_MESSAGES.TAB_LOADING;
  if (errorMsg.includes('video')) return ERROR_MESSAGES.NO_VIDEO;
  if (errorMsg.includes('audio') || errorMsg.includes('track')) return ERROR_MESSAGES.NO_AUDIO;
  if (errorMsg.includes('tab') || errorMsg.includes('closed')) return ERROR_MESSAGES.TAB_CLOSED;
  return error.message;
}

// 하트비트
function startHeartbeat(intervalMs) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    chrome.runtime.sendMessage({ action: MESSAGE_TYPES.RECORDING_HEARTBEAT, data: heartbeatPayload }).catch(() => {
      // Background가 깨어나는 중이면 실패할 수 있음 - 다음 주기에 재시도
    });
  }, intervalMs);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// 일시정지 상태 초기화
function resetPauseState() {
  paused = false;
  workletPauseAcksPending = 0;
  if (workletPauseTimer) {
    clearTimeout(workletPauseTimer);
    workletPauseTimer = null;
  }
}

// 캡처 일시정지: 스트림·루프백(소리)·하트비트는 유지하고 오디오/영상 인코더 입력만 멈춤
function handlePauseCapture(data, sendResponse) {
  if (!isCapturing || stopping) {
    sendResponse({ success: false, error: ERROR_MESSAGES.NOT_RECORDING });
    return;
  }
  const { pausedAt, pausedTotalMs } = data || {};

  if (!paused) {
    paused = true;
    if (audioWorkletNode) {
      // 워크릿이 일시정지 경계까지 모은 PCM을 먼저 보내고 'paused'로 응답하게 함 (경계 정밀도: 렌더 퀀텀 128샘플)
      workletPauseAcksPending++;
      if (workletPauseTimer) clearTimeout(workletPauseTimer);
      workletPauseTimer = setTimeout(() => {
        workletPauseTimer = null;
        if (workletPauseAcksPending > 0) {
          console.warn('[Offscreen] 워크릿 paused 응답 대기 타임아웃 - 이후 PCM은 버립니다');
          workletPauseAcksPending = 0;
        }
      }, WORKLET_PAUSE_ACK_TIMEOUT_MS);
      audioWorkletNode.port.postMessage({ command: 'pause' });
    }
    if (videoSession) videoSession.pause();
    console.log('[Offscreen] 캡처 일시정지');
  }

  heartbeatPayload = {
    ...heartbeatPayload,
    paused: true,
    pausedAt: typeof pausedAt === 'number' ? pausedAt : Date.now(),
    pausedTotalMs: typeof pausedTotalMs === 'number' ? pausedTotalMs : (heartbeatPayload.pausedTotalMs || 0)
  };
  sendResponse({ success: true });
}

// 캡처 재개: 오디오/영상 인코더 입력 재개 (영상은 일시정지 구간을 타임스탬프에서 빼고 키프레임부터)
function handleResumeCapture(data, sendResponse) {
  if (!isCapturing || stopping) {
    sendResponse({ success: false, error: ERROR_MESSAGES.NOT_RECORDING });
    return;
  }
  const { pausedTotalMs } = data || {};

  if (paused) {
    paused = false;
    if (audioWorkletNode) audioWorkletNode.port.postMessage({ command: 'resume' });
    if (videoSession) videoSession.resume();
    console.log('[Offscreen] 캡처 재개');
  }

  heartbeatPayload = {
    ...heartbeatPayload,
    paused: false,
    pausedAt: null,
    pausedTotalMs: typeof pausedTotalMs === 'number' ? pausedTotalMs : (heartbeatPayload.pausedTotalMs || 0)
  };
  sendResponse({ success: true });
}

// 캡처 중지
async function handleStopCapture(sendResponse) {
  console.log('[Offscreen] 캡처 중지');

  // 즉시 응답 전송 (Offscreen이 닫히기 전에!)
  sendResponse({ success: true });
  await stopCaptureInternal();
}

async function stopCaptureInternal() {
  if (stopping) {
    console.log('[Offscreen] 이미 중지 처리 중');
    return;
  }
  stopping = true;
  stopHeartbeat();

  try {
    await handleStreamingRecordingStop();
  } catch (error) {
    console.error('[Offscreen] 캡처 중지 실패:', error);
    chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.RECORDING_ERROR,
      data: { error: error.message || ERROR_MESSAGES.UNKNOWN }
    }).catch(() => {
      console.warn('[Offscreen] 에러 메시지 전송 실패 (Background 닫힘)');
    });
  }
}

// 녹음용 AudioContext (사용자 설정 샘플레이트). 마이크가 다른 샘플레이트(보통 48 kHz)여도 MediaStreamSource가 이 값으로 리샘플링하므로
// WAV/MP3 인코더와 영상 컨테이너 오디오는 항상 audioContext.sampleRate로 설정됨
function ensureAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext({ sampleRate: recordingSampleRate });
    console.log('AudioContext 생성됨:', audioContext.sampleRate, 'Hz');
  }
  return audioContext;
}

// 오디오 소스 그래프:
//   탭 오디오 → (1) destination  : 탭 캡처는 탭 소리를 가로채므로 다시 스피커로 내보내 사용자가 계속 들을 수 있게 함 (루프백)
//            → (2) GainNode(1) → AudioWorklet
//   마이크     → GainNode(1) → AudioWorklet   : destination에는 절대 연결하지 않음 (스피커로 나가면 에코·하울링)
// 여러 연결이 워크릿의 같은 입력으로 들어오면 Web Audio가 합산(모노 마이크는 스테레오로 업믹스)하므로 워크릿 이후(인코더, 일시정지)는 기존과 같음.
// 워크릿은 출력에 아무것도 쓰지 않아(무음) destination에 연결해도 소리가 나지 않음 - 렌더링을 계속 끌어오기 위한 연결
function setupAudioSources({ tabStream, mic }) {
  ensureAudioContext();
  if (tabStream) {
    audioSource = audioContext.createMediaStreamSource(tabStream);
    try {
      audioSource.connect(audioContext.destination);
      console.log('AudioContext 루프백 설정 완료 - 사용자가 소리를 들을 수 있습니다');
    } catch (error) {
      console.error('루프백 설정 실패:', error);
      console.warn('녹음은 계속 진행되지만 소리가 들리지 않을 수 있습니다');
    }
    tabGain = createSourceGain(audioSource);
  }
  if (mic) {
    micSource = audioContext.createMediaStreamSource(mic);
    micGain = createSourceGain(micSource);
    console.log('[Offscreen] 마이크 입력 연결 (녹음에만 사용, 스피커로는 내보내지 않음)');
  }
}

function createSourceGain(source) {
  const gain = audioContext.createGain();
  gain.gain.value = MIC_SETTINGS.SOURCE_GAIN;
  source.connect(gain);
  return gain;
}

// 마이크 열기: 고른 장치(deviceId exact) → 없으면(분리됨, 다른 PC에서 동기화된 ID) 시스템 기본 마이크로 다시 시도하고 경고.
// 권한 거부(NotAllowedError)는 다른 장치로 재시도해도 같으므로 바로 실패 (offscreen 문서는 권한 창을 띄울 수 없음)
async function openMicStream(deviceId) {
  const request = (id) => {
    const audio = id ? { deviceId: { exact: id }, ...MIC_SETTINGS.PROCESSING } : { ...MIC_SETTINGS.PROCESSING };
    console.log('[Offscreen] 마이크 요청:', JSON.stringify(audio));
    return navigator.mediaDevices.getUserMedia({ audio });
  };
  let mic;
  try {
    mic = await request(deviceId);
  } catch (error) {
    if (!deviceId || !isMicDeviceMissing(error)) throw toMicError(error);
    console.warn('[Offscreen] 고른 마이크를 찾을 수 없어 시스템 기본 마이크로 다시 시도:', describeError(error));
    try {
      mic = await request(null);
    } catch (retryError) {
      throw toMicError(retryError);
    }
    captureWarnings.push(ERROR_MESSAGES.MIC_FALLBACK_DEFAULT);
  }
  const tracks = mic ? mic.getAudioTracks() : [];
  if (tracks.length === 0) {
    stopTracks(mic);
    throw new Error(ERROR_MESSAGES.MIC_UNAVAILABLE);
  }
  const settings = tracks[0].getSettings ? tracks[0].getSettings() : {};
  console.log('[Offscreen] 마이크 트랙:', tracks[0].label, settings);
  return mic;
}

function isMicDeviceMissing(error) {
  return !!error && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError');
}

// getUserMedia 오류 → 사용자 메시지 (탭 캡처 오류와 섞이지 않도록 마이크 전용 메시지로 바꿈)
function toMicError(error) {
  const name = error && error.name;
  console.error('[Offscreen] 마이크 열기 실패:', describeError(error));
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return new Error(ERROR_MESSAGES.MIC_PERMISSION_DENIED);
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return new Error(ERROR_MESSAGES.MIC_DEVICE_NOT_FOUND);
  return new Error(`${ERROR_MESSAGES.MIC_UNAVAILABLE} (${describeError(error)})`);
}

function stopTracks(mediaStream, label = '트랙') {
  if (!mediaStream) return;
  try {
    for (const track of mediaStream.getTracks()) {
      track.onended = null;
      try { track.stop(); console.log(`[Cleanup] ${label} 중지:`, track.kind); } catch (e) { console.warn(`[Cleanup] ${label} 중지 실패:`, e); }
    }
  } catch (error) {
    console.warn('[Cleanup] getTracks() 호출 실패:', error);
  }
}

// 녹화 중 마이크 트랙이 끝남 (장치 분리 등 - track.stop()으로는 불리지 않음)
function handleMicTrackEnded(track) {
  if (!isCapturing || stopping) return;
  if (!stream) {
    // 오디오만 + 마이크: 녹음할 소스가 없어졌으므로 그때까지의 녹음으로 마무리 (탭이 닫힌 경우와 같음)
    console.warn('[Offscreen] 마이크 연결 끊김 → 녹음 마무리:', track && track.label);
    if (!captureWarnings.includes(ERROR_MESSAGES.MIC_DISCONNECTED_STOPPED)) captureWarnings.push(ERROR_MESSAGES.MIC_DISCONNECTED_STOPPED);
    stopCaptureInternal().catch((error) => console.error('[Offscreen] 마이크 끊김 후 중지 실패:', error));
    return;
  }
  // 탭 오디오·영상은 계속 녹화 (마이크 쪽은 이후 무음)
  console.warn('[Offscreen] 마이크 연결 끊김 → 탭 녹화는 계속:', track && track.label);
  if (!captureWarnings.includes(ERROR_MESSAGES.MIC_DISCONNECTED)) captureWarnings.push(ERROR_MESSAGES.MIC_DISCONNECTED);
}

function describeError(error) {
  if (!error) return '알 수 없는 오류';
  if (error.name && error.name !== 'Error') return `${error.name}: ${error.message}`;
  return error.message || String(error);
}

// ---------------------------------------------------------------------------
// 저장 폴더 (File System Access API) - 핸들은 설정 페이지가 IndexedDB에 저장 (save-location.js)
// ---------------------------------------------------------------------------

// 저장 폴더 준비: 핸들 로드 → 권한 확인 → 겹치지 않는 파일명. 권한 요청은 하지 않음 (offscreen에는 사용자 제스처가 없어
// 팝업이 녹화 시작 클릭 때 요청함). 쓸 수 없으면 null을 돌려주고 이번 녹화는 기존 다운로드 경로로 저장
async function openSaveFolder(plan, baseName) {
  let handle;
  try {
    handle = await loadDirectoryHandle();
  } catch (error) {
    disableSaveFolder(`저장 폴더 정보를 읽지 못해 (${describeError(error)})`);
    return null;
  }
  if (!handle) {
    disableSaveFolder('설정된 저장 폴더가 없어');
    return null;
  }
  const name = folderDisplayName(handle);
  const permission = await queryFolderPermission(handle);
  if (permission !== 'granted') {
    disableSaveFolder(`'${name}' 폴더에 쓰기 권한이 없어(${permission})`, '설정 페이지(⚙)에서 "권한 다시 요청"을 눌러주세요.');
    return null;
  }
  try {
    return { dir: handle, name, baseName: await findAvailableBaseName(handle, baseName, plannedExtensions(plan)) };
  } catch (error) {
    disableSaveFolder(`'${name}' 폴더를 읽을 수 없어 (${describeError(error)})`);
    return null;
  }
}

// 이번 녹화가 만들 수 있는 확장자 (fMP4는 .mp4, AVI는 2GB 초과 시 MP4로 저장되므로 mp4도 확인)
function plannedExtensions(plan) {
  const extensions = [];
  for (const output of plan.outputs) {
    extensions.push(fileExtension(output.format));
    if (output.kind === 'video' && output.format === VIDEO_FORMATS.AVI) extensions.push(VIDEO_FORMATS.MP4);
  }
  return extensions;
}

// 이번 녹화의 남은 출력은 폴더 대신 다운로드로 저장 (경고는 첫 원인 하나만 사용자에게 보여 줌)
// subject: 다운로드로 저장한 대상 (영상이 이미 폴더에 기록된 경우 '오디오 파일은')
function disableSaveFolder(reason, hint = '', subject = '이번 녹화는') {
  const message = `${reason} ${subject} 다운로드 폴더에 저장했습니다.${hint ? ` ${hint}` : ''}`;
  console.warn('[Offscreen] 폴더 저장 불가:', message);
  if (saveWarnings.length === 0) saveWarnings.push(message);
  saveFolder = null;
}

// 사용자 폴더의 출력 파일 싱크를 미리 열어 둠 (createWritable 권한 오류를 녹화 시작/머싱 전에 확인)
async function openFolderSink(filename, mimeType) {
  const sink = new DirectoryFileSink(saveFolder.dir, filename, mimeType);
  try {
    await sink.open();
    return sink;
  } catch (error) {
    await sink.abort({ remove: true }); // getFileHandle(create)로 생긴 빈 파일 정리
    throw error;
  }
}

// 오디오 파일 싱크: 폴더 저장이면 폴더 파일(주) + OPFS 예비본. 녹화 중 폴더 쓰기가 실패해도 예비본으로 파일을 지킴
async function createAudioOutputSink(format, mimeType) {
  const storageSink = () => recordingStorage.createFileSink(`audio.${format}`, mimeType);
  if (!saveFolder) return { sink: await storageSink(), inFolder: false };

  let folderSink;
  try {
    folderSink = await openFolderSink(`${recordingFileBase}.${format}`, mimeType);
  } catch (error) {
    disableSaveFolder(`'${saveFolder.name}' 폴더에 파일을 만들 수 없어 (${describeError(error)})`);
    return { sink: await storageSink(), inFolder: false };
  }
  // 예비본은 디스크(OPFS)일 때만: 메모리 폴백이면 녹화 길이만큼 RAM을 쓰므로 생략
  if (recordingStorage.kind !== 'opfs') return { sink: folderSink, inFolder: true };
  return { sink: new FailoverFileSink(folderSink, await storageSink()), inFolder: true };
}

// 영상 결과 파일 싱크. 폴더 저장이 아니면 null → OPFS 저장소에 기록
// VideoRecordingSession이 MP4/MOV/fMP4는 녹화 시작 때(녹화 중 바로 기록), AVI는 중지 시 실제 포맷으로 호출 (fMP4 → .mp4)
async function createVideoOutputSink(format, mimeType) {
  if (!saveFolder) return null;
  return openFolderSink(`${recordingFileBase}.${fileExtension(format)}`, mimeType);
}

// 녹화 중 영상 파일 쓰기 실패 (권한 회수·드라이브 분리·디스크 부족): 조용히 계속하지 않고 녹화를 멈춰 알림.
// 영상은 청크 저장소 없이 결과 파일에 바로 쓰므로 다른 곳에 다시 만들 수 없음 (오디오 파일은 기존처럼 예비본으로 지킴)
function handleVideoWriteError(error) {
  console.error('[Offscreen] 녹화 중 영상 파일 기록 실패 → 녹화 중지:', error && error.message);
  if (!isCapturing || stopping) return; // 시작 중이면 시작 직후 확인, 이미 중지 중이면 그 결과로 알림
  stopCaptureInternal().catch((stopError) => console.error('[Offscreen] 쓰기 실패 후 중지 실패:', stopError));
}

// 오디오 단독 파일용 인코더 생성 (결과를 디스크 싱크에 바로 기록)
async function createAudioFileEncoder(format, channels, sampleRate) {
  const mimeType = AUDIO_MIME_TYPES[format];
  if (!mimeType) {
    throw new Error(`지원하지 않는 포맷: ${format}`);
  }
  audioOutput = await createAudioOutputSink(format, mimeType);
  const { sink } = audioOutput;
  if (format === 'mp3') {
    return new Mp3FileEncoder({ sampleRate, channels, bitrateKbps: recordingBitrate, sink });
  }
  return new WavFileEncoder({ sampleRate, channels, sink });
}

// 스트리밍 녹음/녹화 시작 (오디오 소스 그래프는 setupAudioSources가 미리 만들어 둠)
async function startStreamingRecording(videoTrack) {
  try {
    // AudioContext 상태 검증 및 생성
    ensureAudioContext();

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
      console.log('[StreamingRecording] AudioContext 재개 완료');
    }

    const channels = 2; // Stereo
    const sampleRate = audioContext.sampleRate;

    // 1) 오디오 단독 파일 인코더 (AUDIO_ONLY, VIDEO_AUDIO_SPLIT)
    const audioOutput = recordingPlan.outputs.find(o => o.kind === 'audio');
    if (audioOutput) {
      streamingEncoder = await createAudioFileEncoder(audioOutput.format, channels, sampleRate);
      await streamingEncoder.start();
      console.log('[StreamingRecording] 오디오 파일 인코더 시작:', audioOutput.format, { channels, sampleRate, bitrate: recordingBitrate });
    }

    // 2) 영상 세션 (VIDEO_AUDIO, VIDEO_AUDIO_SPLIT)
    const videoOutput = recordingPlan.outputs.find(o => o.kind === 'video');
    if (videoOutput) {
      if (!videoTrack) {
        throw new Error(ERROR_MESSAGES.NO_VIDEO);
      }
      videoSession = new VideoRecordingSession({
        format: videoOutput.format,
        videoTrack,
        sampleRate,
        channels,
        bitrateKbps: recordingBitrate,
        storage: recordingStorage,
        // 폴더 저장: 결과 파일을 OPFS가 아니라 사용자 폴더에 기록 (MP4/MOV/fMP4는 녹화 중 바로, AVI는 중지 시 머싱)
        outputSinkFactory: createVideoOutputSink,
        // 녹화 중 영상 파일 쓰기 실패 → 녹화 중지 + 오류 안내
        onError: handleVideoWriteError
      });
      console.log('[StreamingRecording] 영상 세션 준비:', videoOutput.format);
    }

    // AudioWorklet 모듈 로드
    await audioContext.audioWorklet.addModule('audio-worklet-processor.js');

    audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: channels
    });

    // Worklet으로부터 오디오 데이터 수신 → 모든 인코더에 전달
    audioWorkletNode.port.onmessage = (event) => {
      const { type, leftChannel, rightChannel } = event.data;
      if (type === 'paused') {
        // 워크릿이 일시정지 경계까지의 PCM을 모두 보냄 → 이후 도착하는 PCM은 버림
        workletPauseAcksPending = Math.max(0, workletPauseAcksPending - 1);
        if (workletPauseAcksPending === 0 && workletPauseTimer) {
          clearTimeout(workletPauseTimer);
          workletPauseTimer = null;
        }
        return;
      }
      if (type !== 'audioData') return;
      // 일시정지 중에는 어느 인코더에도 넘기지 않음 (워크릿 응답 전 도착분은 일시정지 직전 데이터라 기록)
      if (paused && workletPauseAcksPending === 0) return;

      if (streamingEncoder && streamingEncoder.isStarted) {
        streamingEncoder.processChunk(leftChannel, rightChannel);
      }
      if (videoSession) {
        videoSession.pushAudio(leftChannel, rightChannel);
      }
    };

    // 소스별 GainNode(탭, 마이크) → AudioWorklet(합산) → destination (워크릿 출력은 무음)
    const inputs = [tabGain, micGain].filter(Boolean);
    if (inputs.length === 0) {
      throw new Error(ERROR_MESSAGES.NO_AUDIO);
    }
    for (const input of inputs) input.connect(audioWorkletNode);
    audioWorkletNode.connect(audioContext.destination);

    // 오디오 녹음 시작 (영상 세션은 이 시각을 기준으로 A/V 정렬)
    const audioStartTime = performance.now();
    audioWorkletNode.port.postMessage({ command: 'start' });

    if (videoSession) {
      videoSession.setAudioStartTime(audioStartTime);
      await videoSession.start();
      console.log('[StreamingRecording] 영상 인코딩 시작');
    }

    console.log('[StreamingRecording] 파이프라인 연결 완료 - 실시간 인코딩 시작');
  } catch (error) {
    console.error('[StreamingRecording] 스트리밍 녹음 시작 실패:', error);
    throw error;
  }
}

// 스트리밍 녹음/녹화 완료 처리
async function handleStreamingRecordingStop() {
  try {
    console.log('[StreamingRecording] 녹음 중지 처리 시작');
    // 중지 후 단계별 소요 시간 (진단용, RECORDING_COMPLETE로 보고)
    const now = () => (globalThis.performance ? performance.now() : Date.now());
    const tStart = now();
    const timings = { workletMs: 0, videoMs: 0, audioMs: 0, downloadRequestMs: 0, totalMs: 0 };

    if (audioWorkletNode) {
      await stopWorkletAndFlush(audioWorkletNode);
      audioWorkletNode = null;
      console.log('[StreamingRecording] AudioWorklet 연결 해제');
    }
    timings.workletMs = Math.round(now() - tStart);
    isCapturing = false;

    if (!streamingEncoder && !videoSession) {
      throw new Error('인코더가 초기화되지 않았습니다');
    }

    const outputs = (recordingPlan ? recordingPlan.outputs : [{ kind: 'audio', format: 'mp3' }]).map(o => ({ ...o }));
    const blobs = new Map(); // kind → Blob
    const savedTo = new Map(); // kind → 'folder' | 'downloads'
    const warnings = [];
    const folderName = saveFolder ? saveFolder.name : null;

    // 녹화 중 오디오 파일의 폴더 쓰기가 이미 실패했다면(예비본으로 전환) AVI 영상도 다운로드로 저장해 두 파일을 한곳에 둠
    // (MP4/MOV/fMP4 영상은 녹화 중 이미 폴더에 기록됨 → 오디오만 다운로드)
    const audioSink = audioOutput && audioOutput.sink;
    if (saveFolder && audioSink instanceof FailoverFileSink && audioSink.primaryError) {
      const videoInFolder = !!(videoSession && videoSession.writesDirectly && videoSession.outputTarget === 'custom');
      disableSaveFolder(`'${folderName}' 폴더에 오디오 파일을 기록하던 중 오류가 발생해 (${describeError(audioSink.primaryError)})`, '', videoInFolder ? '오디오 파일은' : '이번 녹화는');
    }

    // 영상 세션 먼저 종료 (인코더 flush에 시간이 걸릴 수 있음)
    // 영상이 실패해도 오디오 파일이 있으면 그것만이라도 저장하기 위해 에러를 보류합니다.
    let videoError = null;
    if (videoSession) {
      console.log('[StreamingRecording] 영상 인코딩 완료 중...');
      try {
        const tVideo = now();
        const videoBlob = await videoSession.stop().finally(() => {
          timings.videoMs = Math.round(now() - tVideo);
          // 영상 단계 세부 (인코더 마감 / 컨테이너 오디오 마감 / 머싱 계획 / 기록 / 출력 닫기)
          if (videoSession.timings) timings.video = { ...videoSession.timings };
        });
        if (!(videoBlob instanceof Blob) || videoBlob.size === 0) {
          throw new Error(ERROR_MESSAGES.VIDEO_ENCODING_FAILED);
        }
        blobs.set('video', videoBlob);
        // AVI 크기 한계 등으로 실제 컨테이너가 바뀐 경우 파일명 확장자도 맞춤
        const videoOutput = outputs.find(o => o.kind === 'video');
        if (videoOutput && videoSession.actualFormat && videoSession.actualFormat !== videoOutput.format) {
          videoOutput.format = videoSession.actualFormat;
        }
        if (videoSession.warning) warnings.push(videoSession.warning);
        if (videoSession.outputTarget === 'custom') {
          savedTo.set('video', SAVE_LOCATIONS.FOLDER);
        } else {
          savedTo.set('video', SAVE_LOCATIONS.DOWNLOADS);
          if (videoSession.outputError) disableSaveFolder(`'${folderName}' 폴더에 영상 파일을 기록하지 못해 (${describeError(videoSession.outputError)})`);
        }
      } catch (error) {
        console.error('[StreamingRecording] 영상 처리 실패:', error);
        videoError = error;
      }
    }

    if (streamingEncoder) {
      console.log('[StreamingRecording] 오디오 인코딩 완료 중...');
      const tAudio = now();
      const audioBlob = await streamingEncoder.finish();
      timings.audioMs = Math.round(now() - tAudio);
      if (!(audioBlob instanceof Blob)) {
        throw new Error(`인코더가 잘못된 타입을 반환했습니다: ${typeof audioBlob}`);
      }
      if (audioBlob.size === 0) {
        throw new Error('생성된 오디오 파일 크기가 0 bytes입니다');
      }
      const audioPlan = outputs.find(o => o.kind === 'audio');
      await validateEncodedBlob(audioBlob, audioPlan.format);
      blobs.set('audio', audioBlob);
      const sink = audioOutput && audioOutput.sink;
      if (sink instanceof FailoverFileSink && sink.failedOver) {
        // 녹화 중 폴더 쓰기 실패 → OPFS 예비본(처음부터 온전한 파일)을 다운로드
        savedTo.set('audio', SAVE_LOCATIONS.DOWNLOADS);
        disableSaveFolder(`'${folderName}' 폴더에 오디오 파일을 기록하던 중 오류가 발생해 (${describeError(sink.primaryError)})`);
      } else {
        savedTo.set('audio', audioOutput && audioOutput.inFolder ? SAVE_LOCATIONS.FOLDER : SAVE_LOCATIONS.DOWNLOADS);
      }
    }

    // 저장: 폴더에 직접 기록한 파일은 이미 끝났고, 나머지는 다운로드 (파일명은 실제 출력 포맷 기준)
    const named = generateRecordingFilenames(outputs, undefined, { baseName: recordingFileBase });
    const files = [];
    const tDownload = now();
    for (const output of named) {
      const blob = blobs.get(output.kind);
      if (!blob) continue;
      const target = savedTo.get(output.kind) || SAVE_LOCATIONS.DOWNLOADS;
      if (target === SAVE_LOCATIONS.FOLDER) {
        console.log('[StreamingRecording] 폴더에 저장됨:', folderName, output.filename, `${(blob.size / 1024 / 1024).toFixed(2)} MB`);
      } else {
        console.log('[StreamingRecording] 다운로드:', output.filename, `${(blob.size / 1024 / 1024).toFixed(2)} MB`);
        await downloadBlob(blob, output.filename, output);
      }
      files.push({
        kind: output.kind,
        format: output.format,
        label: formatLabel(output.format), // 표시 이름 (fmp4 → MP4)
        filename: output.filename,
        size: blob.size,
        savedTo: target,
        location: target === SAVE_LOCATIONS.FOLDER ? folderName : null
      });
    }

    timings.downloadRequestMs = Math.round(now() - tDownload);
    timings.totalMs = Math.round(now() - tStart);
    // 저장된 파일(File)은 디스크 기반이라 메모리를 거의 쓰지 않지만, 더 쓸 일이 없으므로 참조를 바로 놓음
    blobs.clear();

    // 모두 폴더에 저장했으면 OPFS 임시 데이터(청크 저장소, 오디오 예비본)는 쓸 일이 없으므로 바로 정리
    // (다운로드한 파일은 Blob URL이 OPFS 파일을 가리키므로 남겨 두고 다음 녹화 시작 때 정리)
    const allInFolder = files.length > 0 && files.every(f => f.savedTo === SAVE_LOCATIONS.FOLDER);
    if (allInFolder && recordingStorage) {
      const tCleanup = now();
      try { await recordingStorage.dispose(); } catch (error) { console.warn('[StreamingRecording] OPFS 임시 데이터 정리 실패:', error); }
      timings.cleanupMs = Math.round(now() - tCleanup);
    }
    console.log('[StreamingRecording] 중지 후 단계별 시간(ms):', timings);
    await cleanup();

    if (files.length === 0) {
      throw videoError || new Error(ERROR_MESSAGES.ENCODING_FAILED);
    }

    if (videoError) {
      // 녹화 중 쓰기 실패는 그 자체로 설명이 되는 메시지(VIDEO_WRITE_FAILED + 원인)
      warnings.push(videoError.code === 'VIDEO_WRITE_FAILED'
        ? `${videoError.message} 오디오 파일만 저장되었습니다.`
        : `영상 파일 저장에 실패했습니다 (${videoError.message}). 오디오 파일만 저장되었습니다.`);
    }
    // 캡처 경고(마이크 대체·끊김) → 저장 위치 경고 → 영상 경고 순
    const allWarnings = [...captureWarnings, ...saveWarnings, ...warnings];
    const warning = allWarnings.length ? allWarnings.join(' ') : undefined;
    const inFolder = files.filter(f => f.savedTo === SAVE_LOCATIONS.FOLDER).length;

    await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.RECORDING_COMPLETE,
      data: {
        success: true,
        files,
        warning,
        warnings: allWarnings,
        timings,
        storage: recordingStorage ? recordingStorage.kind : 'memory',
        // 저장 위치 요약: 모두 폴더 / 모두 다운로드 / 섞임 (파일별 위치는 files[].savedTo, files[].location)
        savedTo: inFolder === files.length ? SAVE_LOCATIONS.FOLDER : (inFolder === 0 ? SAVE_LOCATIONS.DOWNLOADS : 'mixed'),
        folderName: inFolder > 0 ? folderName : null,
        // 하위 호환 필드
        format: files[0]?.format,
        size: files.reduce((s, f) => s + f.size, 0)
      }
    });

    console.log('[StreamingRecording] ✓ 녹음 완료 처리 성공:', files);
  } catch (error) {
    console.error('[StreamingRecording] 녹음 완료 처리 실패:', error);
    try { await cleanup(); } catch { /* 무시 */ }

    chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.RECORDING_ERROR,
      data: { error: error.message || ERROR_MESSAGES.ENCODING_FAILED }
    });
  }
}

// 워크릿에 stop을 보내고 마지막 청크 + 'stopped' 응답을 받은 뒤 연결 해제 (마지막 ~90ms 오디오 유실 방지)
function stopWorkletAndFlush(node, timeoutMs = 500) {
  return new Promise((resolve) => {
    const previous = node.port.onmessage;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { node.disconnect(); } catch { /* 무시 */ }
      node.port.onmessage = null;
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn('[StreamingRecording] 워크릿 stopped 응답 대기 타임아웃');
      finish();
    }, timeoutMs);
    node.port.onmessage = (event) => {
      if (event.data && event.data.type === 'stopped') {
        finish();
        return;
      }
      if (previous) previous(event);
    };
    node.port.postMessage({ command: 'stop' });
  });
}

// Blob 다운로드: Background의 chrome.downloads 사용, 실패 시 앵커 클릭 폴백
async function downloadBlob(blob, filename, output = {}) {
  const blobUrl = URL.createObjectURL(blob);

  try {
    const response = await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.DOWNLOAD_FILE,
      data: { url: blobUrl, filename, kind: output.kind, format: output.format }
    });
    if (response && response.success) {
      console.log('[Offscreen] chrome.downloads로 다운로드 시작:', filename, 'id:', response.downloadId);
      // Blob URL은 Background가 다운로드 완료를 확인한 뒤 Offscreen을 닫을 때 함께 해제됨
      return;
    }
    console.warn('[Offscreen] chrome.downloads 실패, 앵커 폴백:', response && response.error);
  } catch (error) {
    console.warn('[Offscreen] 다운로드 메시지 실패, 앵커 폴백:', error);
  }

  await downloadViaAnchor(blobUrl, filename);
}

function downloadViaAnchor(blobUrl, filename) {
  return new Promise((resolve, reject) => {
    try {
      const downloadLink = document.createElement('a');
      downloadLink.href = blobUrl;
      downloadLink.download = filename;
      downloadLink.style.display = 'none';
      document.body.appendChild(downloadLink);
      downloadLink.click();
      console.log('[Offscreen] 앵커 다운로드 트리거됨:', filename);

      setTimeout(() => {
        document.body.removeChild(downloadLink);
        resolve();
      }, 1000);
    } catch (error) {
      reject(error);
    }
  });
}

// 리소스 정리 (메모리 누수 방지)
// 모듈 상태는 처음에 바로 비우고(정리하는 동안 시작한 다음 녹화와 섞이지 않게) 리소스는 지역 변수로 넘겨 아래 순서로 해제합니다.
// 영상 세션이 남아 있으면(시작 실패, 중지 전 오류 - 참조만 버리면 리더·인코더·결과 파일이 그대로 남음) 먼저 dispose합니다:
// 대기 중 read를 처리해 리더를 끝내고 인코더를 닫고 쓰다 만 결과 파일을 지움. 캡처 트랙은 그다음에 멈춥니다 - 대기 read가 있는 채로
// 트랙을 멈추면 Chrome이 그 read에 주려고 만든 VideoFrame을 close 없이 버려 "garbage collected without being closed" 경고가 남.
// (정상 중지는 handleStreamingRecordingStop이 세션을 먼저 stop하므로 dispose는 할 일이 없음)
async function cleanup() {
  console.log('[Cleanup] 리소스 정리 시작');
  stopHeartbeat();
  isCapturing = false;
  resetPauseState();

  const session = videoSession;
  const mediaStream = stream;
  const source = audioSource;
  const context = audioContext;
  const mic = micStream;
  const audioNodes = [micSource, tabGain, micGain];
  videoSession = null;
  stream = null;
  audioSource = null;
  audioContext = null;
  micStream = null;
  micSource = null;
  tabGain = null;
  micGain = null;
  streamingEncoder = null;
  // 저장 위치 상태 (싱크는 이미 닫혔거나 시작 실패 경로에서 정리됨)
  saveFolder = null;
  audioOutput = null;

  if (audioWorkletNode) {
    try {
      audioWorkletNode.port.postMessage({ command: 'stop' });
      audioWorkletNode.disconnect();
      audioWorkletNode.port.onmessage = null;
    } catch (error) {
      console.warn('[Cleanup] AudioWorklet 정리 실패:', error);
    }
    audioWorkletNode = null;
  }

  // 영상 세션 정리 → 그 뒤에 캡처 트랙 중지 (위 설명)
  if (session) {
    try { await session.dispose(); } catch (error) { console.warn('[Cleanup] 영상 세션 정리 실패:', error); }
  }

  if (source) {
    try { source.disconnect(); } catch (error) { console.warn('[Cleanup] AudioSource 연결 해제 실패:', error); }
  }
  for (const node of audioNodes) {
    if (!node) continue;
    try { node.disconnect(); } catch (error) { console.warn('[Cleanup] 오디오 노드 연결 해제 실패:', error); }
  }

  if (mediaStream) {
    try {
      for (const track of mediaStream.getTracks()) {
        try { track.stop(); console.log('[Cleanup] 트랙 중지:', track.kind); } catch (e) { console.warn('[Cleanup] 트랙 중지 실패:', e); }
      }
    } catch (error) {
      console.warn('[Cleanup] getTracks() 호출 실패:', error);
    }
  }
  // 마이크 트랙 중지 (마이크 사용 표시 끄기). onended를 먼저 떼어 정리 중 끊김 처리가 돌지 않게 함
  stopTracks(mic, '마이크 트랙');

  if (context && context.state !== 'closed') {
    context.close().catch((error) => console.warn('[Cleanup] AudioContext 종료 실패:', error));
  }

  console.log('[Cleanup] ✓ 리소스 정리 완료');
}

// 인코딩된 오디오 Blob 유효성 검증 (파일 시그니처)
async function validateEncodedBlob(blob, format) {
  const headerBuffer = await blob.slice(0, 16).arrayBuffer();
  const headerView = new Uint8Array(headerBuffer);

  if (format === 'wav') {
    const riff = String.fromCharCode(...headerView.slice(0, 4));
    const wave = String.fromCharCode(...headerView.slice(8, 12));
    if (riff !== 'RIFF') throw new Error(`WAV 파일 시그니처가 잘못되었습니다: ${riff} (예상: RIFF)`);
    if (wave !== 'WAVE') throw new Error(`WAV 포맷 시그니처가 잘못되었습니다: ${wave} (예상: WAVE)`);
  } else if (format === 'mp3') {
    const hasID3 = headerView[0] === 0x49 && headerView[1] === 0x44 && headerView[2] === 0x33;
    const hasFrameSync = headerView[0] === 0xFF && (headerView[1] & 0xE0) === 0xE0;
    if (!hasID3 && !hasFrameSync) throw new Error('MP3 파일 시그니처가 잘못되었습니다');
  }

  console.log(`[Offscreen] ✓ ${format.toUpperCase()} 파일 형식 검증 완료`);
  return true;
}
