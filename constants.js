// Message Types - 메시지 타입 상수
export const MESSAGE_TYPES = {
  // Popup → Background
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  GET_STATE: 'GET_STATE',

  // Background → Offscreen
  START_CAPTURE: 'START_CAPTURE',
  STOP_CAPTURE: 'STOP_CAPTURE',

  // Offscreen → Background
  DOWNLOAD_FILE: 'DOWNLOAD_FILE',
  RECORDING_HEARTBEAT: 'RECORDING_HEARTBEAT',
  RECORDING_STARTED: 'RECORDING_STARTED',
  RECORDING_COMPLETE: 'RECORDING_COMPLETE',
  RECORDING_CHUNK: 'RECORDING_CHUNK',
  RECORDING_ERROR: 'RECORDING_ERROR',
  RECORDING_TIME_UPDATE: 'RECORDING_TIME_UPDATE',

  // Background → Popup
  STATE_CHANGED: 'STATE_CHANGED',
  UPDATE_TIME: 'UPDATE_TIME',
  ERROR: 'ERROR'
};

// Settings - 설정 상수
export const SETTINGS = {
  DEFAULT_FORMAT: 'mp3',
  DEFAULT_BITRATE: 128000,
  BADGE_TEXT_RECORDING: 'REC',
  BADGE_COLOR_RECORDING: '#FF0000',
  BADGE_TEXT_IDLE: '',
  UPDATE_INTERVAL: 1000, // ms
  DOWNLOAD_WAIT_TIMEOUT_MINUTES: 10, // 다운로드 완료 대기 최대 시간 (chrome.alarms, 분)
  HEARTBEAT_INTERVAL: 20 * 1000 // Offscreen → Background 하트비트 주기 (ms). SW 유휴 종료(30초) 방지 + 상태 복구
};

// Session Storage Keys - SW 재시작에도 유지되는 런타임 상태 (chrome.storage.session)
export const SESSION_KEYS = {
  RECORDING_STATE: 'recordingState',
  PENDING_DOWNLOADS: 'pendingDownloads'
};

// Default Settings - 사용자 설정 기본값
export const DEFAULT_SETTINGS = {
  fileFormat: 'mp3',           // 오디오 저장 포맷 (mp3, wav)
  bitrate: 128,                // 오디오 비트레이트 (kbps)
  sampleRate: 44100,           // 샘플레이트 (Hz)
  recordingMode: 'AUDIO_ONLY', // 녹화 모드 (RECORDING_MODES 참조)
  videoFormat: 'mp4'           // 영상 저장 포맷 (mp4, mov, avi)
};

// Storage Keys - 스토리지 키 상수
export const STORAGE_KEYS = {
  SETTINGS: 'settings'
};

// Error Messages - 에러 메시지
export const ERROR_MESSAGES = {
  NO_AUDIO: '오디오가 재생되지 않고 있습니다. 미디어를 재생한 후 시도해주세요.',
  TAB_LOADING: '페이지가 아직 로딩 중입니다. 로딩 완료 후 시도해주세요.',
  TAB_CLOSED: '녹음 중인 탭이 닫혔습니다.',
  PERMISSION_DENIED: '권한이 거부되었습니다. 확장 프로그램 권한을 확인해주세요.',
  CAPTURE_FAILED: '탭 오디오를 캡처할 수 없습니다. 페이지를 새로고침해주세요.',
  NOT_INVOKED: '이 탭에서는 녹화를 시작할 수 없습니다. 일반 웹페이지 탭에서 확장 아이콘을 클릭해 다시 시도해주세요. (chrome:// 페이지와 웹스토어는 캡처할 수 없습니다)',
  AVI_TOO_LARGE: 'AVI 파일은 2GB를 넘을 수 없어 MP4로 저장했습니다.',
  ALREADY_RECORDING: '이미 녹음이 진행 중입니다.',
  NOT_RECORDING: '녹음이 진행 중이 아닙니다.',
  OFFSCREEN_CREATE_FAILED: 'Offscreen Document 생성에 실패했습니다.',
  ENCODING_FAILED: '오디오 인코딩에 실패했습니다.',
  NO_VIDEO: '탭 영상을 캡처할 수 없습니다. 탭이 화면에 표시되어 있는지 확인해주세요.',
  VIDEO_ENCODER_UNSUPPORTED: '이 브라우저는 H.264 영상 인코딩(WebCodecs)을 지원하지 않습니다. Chrome 94 이상이 필요합니다.',
  VIDEO_ENCODING_FAILED: '영상 인코딩에 실패했습니다.',
  DOWNLOAD_FAILED: '파일 다운로드에 실패했습니다.',
  UNKNOWN: '알 수 없는 오류가 발생했습니다.'
};

// Recording States - 녹음 상태
export const RECORDING_STATES = {
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  PROCESSING: 'PROCESSING'
};

// Audio Formats - 오디오 포맷
export const AUDIO_FORMATS = {
  MP3: 'mp3',
  WAV: 'wav'
};

// Video Formats - 영상 컨테이너 포맷
export const VIDEO_FORMATS = {
  MP4: 'mp4',
  MOV: 'mov',
  AVI: 'avi'
};

// Recording Modes - 녹화 모드
export const RECORDING_MODES = {
  AUDIO_ONLY: 'AUDIO_ONLY',             // 탭 오디오만 녹음
  VIDEO_AUDIO: 'VIDEO_AUDIO',           // 탭 영상 + 오디오를 한 파일로
  VIDEO_AUDIO_SPLIT: 'VIDEO_AUDIO_SPLIT' // 영상+오디오 파일 1개 + 오디오 파일 1개
};

// Video Settings - 영상 인코딩 설정
export const VIDEO_SETTINGS = {
  DEFAULT_FORMAT: 'mp4',
  MAX_WIDTH: 1920,
  MAX_HEIGHT: 1080,
  FRAME_RATE: 30,
  KEYFRAME_INTERVAL: 60,          // 프레임 단위 (30fps 기준 2초)
  BITS_PER_PIXEL_PER_FRAME: 0.1,  // 비트레이트 추정치 (1080p30 ≈ 6Mbps)
  MIN_BITRATE: 1_000_000,
  MAX_BITRATE: 12_000_000,
  MAX_ENCODE_QUEUE: 5,            // 인코더 큐가 이 값을 넘으면 프레임 드롭
  LATENCY_MODE: 'realtime',       // WebCodecs latencyMode ('realtime' | 'quality')
  // 영상 컨테이너에 담기는 오디오 코덱 (MP3는 MP4/MOV/AVI 모두에서 재생 가능)
  CONTAINER_AUDIO_CODEC: 'mp3',
  // 우선순위 순서로 지원 여부를 확인할 H.264 코덱 문자열
  H264_CODEC_CANDIDATES: ['avc1.42002A', 'avc1.42E02A', 'avc1.4D002A', 'avc1.64002A', 'avc1.42001F']
};

// Data Transfer - 데이터 전송 설정
export const DATA_TRANSFER = {
  CHUNK_SIZE: 1024 * 1024 // 1MB 청크 크기
};
