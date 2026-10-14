import { MESSAGE_TYPES, ERROR_MESSAGES, SETTINGS, VIDEO_SETTINGS } from './constants.js';
import { WavFileEncoder, Mp3FileEncoder } from './audio-file-encoders.js';
import { generateRecordingFilenames } from './utils.js';
import { resolveRecordingPlan } from './recording-plan.js';
import { VideoRecordingSession } from './video-recorder.js';
import { createRecordingStorage, cleanupStaleRecordings } from './storage/chunk-store.js';

// 전역 변수
let audioContext = null;
let audioSource = null;
let stream = null;
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

console.log('Offscreen Document 로드됨');

// 메시지 리스너
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Offscreen이 처리해야 할 메시지만 로그
  if (message.action === MESSAGE_TYPES.START_CAPTURE || message.action === MESSAGE_TYPES.STOP_CAPTURE) {
    console.log('Offscreen 메시지 수신:', message);
  }

  switch (message.action) {
    case MESSAGE_TYPES.START_CAPTURE:
      handleStartCapture(message.data, sendResponse);
      return true;

    case MESSAGE_TYPES.STOP_CAPTURE:
      handleStopCapture(sendResponse);
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

    const { streamId, format, bitrate, sampleRate, plan, tabId, startTime, heartbeatIntervalMs } = data;

    // 녹화 계획 (Background에서 전달, 없으면 기존 오디오 전용 동작)
    recordingPlan = plan || resolveRecordingPlan({ audioFormat: format });
    recordingBitrate = bitrate || (SETTINGS.DEFAULT_BITRATE / 1000);
    recordingSampleRate = sampleRate || 44100;
    heartbeatPayload = { tabId: tabId ?? null, startTime: startTime ?? Date.now(), plan: recordingPlan, format: recordingPlan.outputs.find(o => o.kind === 'audio')?.format || format };
    stopping = false;

    // 녹화 데이터 저장소: 인코딩 결과를 메모리 대신 디스크(OPFS)에 두어 장시간 녹화에서도 메모리가 늘지 않게 함
    const storageManager = (typeof navigator !== 'undefined' && navigator.storage) ? navigator.storage : null;
    const sessionId = `rec-${Date.now()}`;
    recordingStorage = await createRecordingStorage(storageManager, sessionId);
    console.log('[Offscreen] 녹화 저장소:', recordingStorage.kind);
    // 이전 녹화의 임시 파일 정리 (다운로드가 끝난 뒤 남아 있던 것)
    cleanupStaleRecordings(storageManager, sessionId).then((n) => { if (n) console.log('[Offscreen] 이전 녹화 임시 파일 정리:', n, '개'); });

    console.log('[Offscreen] 녹화 계획:', recordingPlan);

    // Manifest V3 방식: streamId를 사용하여 MediaStream 획득
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
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
    if (audioTracks.length === 0) {
      throw new Error(ERROR_MESSAGES.NO_AUDIO);
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

    // AudioContext 루프백 설정 (사용자가 소리를 계속 들을 수 있도록)
    setupLoopback(stream);

    // 스트리밍 녹음/녹화 시작
    await startStreamingRecording(stream, videoTrack);
    isCapturing = true;

    // 탭이 닫히거나 캡처가 끊기면 스스로 마무리
    for (const track of stream.getTracks()) {
      track.onended = () => {
        console.warn('[Offscreen] 캡처 트랙 종료 감지:', track.kind);
        if (track.kind === 'video' || !recordingPlan.captureVideo) {
          stopCaptureInternal().catch((error) => console.error('[Offscreen] 트랙 종료 후 중지 실패:', error));
        }
      };
    }

    // 하트비트 시작 (SW가 재시작되어도 녹화 상태를 복구할 수 있도록 식별 정보를 함께 보냄)
    startHeartbeat(heartbeatIntervalMs || SETTINGS.HEARTBEAT_INTERVAL);

    // Background에 시작 알림
    await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.RECORDING_STARTED
    });

    sendResponse({ success: true });
  } catch (error) {
    console.error('캡처 시작 실패:', error);

    // 부분적으로 생성된 리소스 정리
    try { cleanup(); } catch (cleanupError) { console.warn('[Offscreen] 시작 실패 후 정리 중 오류:', cleanupError); }

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

// AudioContext 루프백 설정 (사용자가 소리를 듣도록)
function setupLoopback(mediaStream) {
  try {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext({ sampleRate: recordingSampleRate });
      console.log('AudioContext 생성됨:', audioContext.sampleRate, 'Hz');
    }

    audioSource = audioContext.createMediaStreamSource(mediaStream);
    audioSource.connect(audioContext.destination);

    console.log('AudioContext 루프백 설정 완료 - 사용자가 소리를 들을 수 있습니다');
  } catch (error) {
    console.error('루프백 설정 실패:', error);
    console.warn('녹음은 계속 진행되지만 소리가 들리지 않을 수 있습니다');
  }
}

// 오디오 단독 파일용 인코더 생성 (결과를 디스크 싱크에 바로 기록)
async function createAudioFileEncoder(format, channels, sampleRate) {
  if (format === 'mp3') {
    const sink = await recordingStorage.createFileSink('audio.mp3', 'audio/mpeg');
    return new Mp3FileEncoder({ sampleRate, channels, bitrateKbps: recordingBitrate, sink });
  }
  if (format === 'wav') {
    const sink = await recordingStorage.createFileSink('audio.wav', 'audio/wav');
    return new WavFileEncoder({ sampleRate, channels, sink });
  }
  throw new Error(`지원하지 않는 포맷: ${format}`);
}

// 스트리밍 녹음/녹화 시작
async function startStreamingRecording(mediaStream, videoTrack) {
  try {
    // AudioContext 상태 검증 및 생성
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext({ sampleRate: recordingSampleRate });
      console.log('[StreamingRecording] AudioContext 생성 완료:', audioContext.sampleRate, 'Hz');
    }

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
        storage: recordingStorage
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
      if (type !== 'audioData') return;

      if (streamingEncoder && streamingEncoder.isStarted) {
        streamingEncoder.processChunk(leftChannel, rightChannel);
      }
      if (videoSession) {
        videoSession.pushAudio(leftChannel, rightChannel);
      }
    };

    if (!audioSource) {
      audioSource = audioContext.createMediaStreamSource(mediaStream);
    }

    // MediaStream → AudioWorklet → destination
    audioSource.connect(audioWorkletNode);
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

    if (audioWorkletNode) {
      await stopWorkletAndFlush(audioWorkletNode);
      audioWorkletNode = null;
      console.log('[StreamingRecording] AudioWorklet 연결 해제');
    }
    isCapturing = false;

    if (!streamingEncoder && !videoSession) {
      throw new Error('인코더가 초기화되지 않았습니다');
    }

    const outputs = (recordingPlan ? recordingPlan.outputs : [{ kind: 'audio', format: 'mp3' }]).map(o => ({ ...o }));
    const blobs = new Map(); // kind → Blob
    const warnings = [];

    // 영상 세션 먼저 종료 (인코더 flush에 시간이 걸릴 수 있음)
    // 영상이 실패해도 오디오 파일이 있으면 그것만이라도 저장하기 위해 에러를 보류합니다.
    let videoError = null;
    if (videoSession) {
      console.log('[StreamingRecording] 영상 인코딩 완료 중...');
      try {
        const videoBlob = await videoSession.stop();
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
      } catch (error) {
        console.error('[StreamingRecording] 영상 처리 실패:', error);
        videoError = error;
      }
    }

    if (streamingEncoder) {
      console.log('[StreamingRecording] 오디오 인코딩 완료 중...');
      const audioBlob = await streamingEncoder.finish();
      if (!(audioBlob instanceof Blob)) {
        throw new Error(`인코더가 잘못된 타입을 반환했습니다: ${typeof audioBlob}`);
      }
      if (audioBlob.size === 0) {
        throw new Error('생성된 오디오 파일 크기가 0 bytes입니다');
      }
      const audioOutput = outputs.find(o => o.kind === 'audio');
      await validateEncodedBlob(audioBlob, audioOutput.format);
      blobs.set('audio', audioBlob);
    }

    // 다운로드 (파일명은 실제 출력 포맷 기준으로 생성)
    const named = generateRecordingFilenames(outputs);
    const files = [];
    for (const output of named) {
      const blob = blobs.get(output.kind);
      if (!blob) continue;
      console.log('[StreamingRecording] 다운로드:', output.filename, `${(blob.size / 1024 / 1024).toFixed(2)} MB`);
      await downloadBlob(blob, output.filename, output);
      files.push({ kind: output.kind, format: output.format, filename: output.filename, size: blob.size });
    }

    cleanup();

    if (files.length === 0) {
      throw videoError || new Error(ERROR_MESSAGES.ENCODING_FAILED);
    }

    if (videoError) {
      warnings.push(`영상 파일 저장에 실패했습니다 (${videoError.message}). 오디오 파일만 저장되었습니다.`);
    }
    const warning = warnings.length ? warnings.join(' ') : undefined;

    await chrome.runtime.sendMessage({
      action: MESSAGE_TYPES.RECORDING_COMPLETE,
      data: {
        success: true,
        files,
        warning,
        storage: recordingStorage ? recordingStorage.kind : 'memory',
        // 하위 호환 필드
        format: files[0]?.format,
        size: files.reduce((s, f) => s + f.size, 0)
      }
    });

    console.log('[StreamingRecording] ✓ 녹음 완료 처리 성공:', files);
  } catch (error) {
    console.error('[StreamingRecording] 녹음 완료 처리 실패:', error);
    try { cleanup(); } catch { /* 무시 */ }

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
function cleanup() {
  console.log('[Cleanup] 리소스 정리 시작');
  stopHeartbeat();
  isCapturing = false;

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

  streamingEncoder = null;
  videoSession = null;

  if (audioSource) {
    try { audioSource.disconnect(); } catch (error) { console.warn('[Cleanup] AudioSource 연결 해제 실패:', error); }
    audioSource = null;
  }

  if (stream) {
    try {
      for (const track of stream.getTracks()) {
        try { track.stop(); console.log('[Cleanup] 트랙 중지:', track.kind); } catch (e) { console.warn('[Cleanup] 트랙 중지 실패:', e); }
      }
    } catch (error) {
      console.warn('[Cleanup] getTracks() 호출 실패:', error);
    }
    stream = null;
  }

  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch((error) => console.warn('[Cleanup] AudioContext 종료 실패:', error));
    audioContext = null;
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
