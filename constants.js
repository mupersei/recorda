// Message Types - 메시지 타입 상수
export const MESSAGE_TYPES = {
  // Popup → Background
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  PAUSE_RECORDING: 'PAUSE_RECORDING',   // 일시정지 (RECORDING → PAUSED)
  RESUME_RECORDING: 'RESUME_RECORDING', // 재개 (PAUSED → RECORDING)
  GET_STATE: 'GET_STATE',

  // Background → Offscreen
  START_CAPTURE: 'START_CAPTURE',
  STOP_CAPTURE: 'STOP_CAPTURE',
  PAUSE_CAPTURE: 'PAUSE_CAPTURE',   // 캡처는 유지한 채 인코더 입력만 중단
  RESUME_CAPTURE: 'RESUME_CAPTURE', // 인코더 입력 재개

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
  BADGE_TEXT_PAUSED: 'II',
  BADGE_COLOR_PAUSED: '#F57C00',
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

// Save Locations - 녹화 파일 저장 위치
export const SAVE_LOCATIONS = {
  DOWNLOADS: 'downloads', // 기본: chrome.downloads로 다운로드 폴더에 저장 (OPFS → 다운로드 복사)
  FOLDER: 'folder'        // 설정 페이지에서 고른 폴더에 직접 기록 (File System Access API, 복사 단계 없음)
};

// Audio Sources - 녹음할 오디오 소스 (영상은 항상 녹화를 시작한 탭에서 캡처)
export const AUDIO_SOURCES = {
  TAB: 'tab',            // 탭 오디오 (기본, 기존 동작)
  MIC: 'mic',            // 시스템 마이크 (설정 페이지에서 고른 장치, 권한도 설정 페이지에서 허용)
  TAB_AND_MIC: 'tab+mic' // 탭 오디오 + 마이크를 섞어 녹음 (헤드폰 권장: 스피커 소리가 마이크로 다시 들어가면 에코)
};

// 마이크 캡처 설정 (offscreen getUserMedia 제약 + 믹서 게인)
export const MIC_SETTINGS = {
  // 음성 녹음용 처리: 에코 제거(스피커로 나오는 탭 소리 일부 제거), 잡음 억제, 자동 음량
  PROCESSING: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  SOURCE_GAIN: 1 // 소스별 GainNode 값 (탭·마이크 모두 1 = 원음 그대로 합산)
};

// Default Settings - 사용자 설정 기본값
export const DEFAULT_SETTINGS = {
  fileFormat: 'mp3',           // 오디오 저장 포맷 (mp3, wav)
  bitrate: 128,                // 오디오 비트레이트 (kbps)
  sampleRate: 44100,           // 샘플레이트 (Hz)
  recordingMode: 'AUDIO_ONLY', // 녹화 모드 (RECORDING_MODES 참조)
  videoFormat: 'mp4',          // 영상 저장 포맷 (mp4, mov, avi, fmp4)
  audioSource: 'tab',          // 오디오 소스 (AUDIO_SOURCES 값). 마이크 권한이 없으면 팝업은 'tab'으로 녹화 (저장 값은 그대로)
  micDeviceId: '',             // 설정 페이지에서 고른 마이크 장치 ID ('' = 시스템 기본 마이크)
  micDeviceLabel: '',          // 고른 마이크 이름 (장치가 연결되어 있지 않을 때 설정 페이지 안내용)
  // 저장 위치 미러: 팝업이 녹화 시작 때 폴더 권한 확인 여부를 정하는 데 사용 (폴더 핸들 자체는 IndexedDB에 보관 - save-location.js)
  saveLocationMode: 'downloads', // SAVE_LOCATIONS 값
  saveLocationName: ''           // 선택한 폴더 이름 (참고용, 표시는 설정 페이지에서만)
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
  NOT_PAUSED: '일시정지 상태가 아닙니다.',
  OFFSCREEN_CREATE_FAILED: 'Offscreen Document 생성에 실패했습니다.',
  ENCODING_FAILED: '오디오 인코딩에 실패했습니다.',
  NO_VIDEO: '탭 영상을 캡처할 수 없습니다. 탭이 화면에 표시되어 있는지 확인해주세요.',
  VIDEO_ENCODER_UNSUPPORTED: '이 브라우저는 H.264 영상 인코딩(WebCodecs)을 지원하지 않습니다. Chrome 94 이상이 필요합니다.',
  VIDEO_ENCODING_FAILED: '영상 인코딩에 실패했습니다.',
  // 녹화 중 영상 파일을 저장 위치(폴더/OPFS)에 쓰지 못함 (권한 회수, 드라이브 분리, 디스크 부족 등) → 녹화를 멈추고 알림
  VIDEO_WRITE_FAILED: '영상 파일을 저장 위치에 쓰지 못해 녹화를 중지했습니다. 저장 폴더의 연결·권한 상태와 남은 디스크 공간을 확인해주세요.',
  // 마이크 (offscreen 문서는 권한 창을 띄울 수 없으므로 권한은 설정 페이지에서 허용)
  MIC_PERMISSION_DENIED: '마이크 권한이 없어 녹음을 시작할 수 없습니다. 설정 페이지(⚙)의 "마이크 권한 요청"으로 허용한 뒤 다시 시도해주세요.',
  MIC_DEVICE_NOT_FOUND: '마이크를 찾을 수 없습니다. 마이크 연결을 확인하거나 설정 페이지(⚙)에서 다른 마이크를 선택해주세요.',
  MIC_UNAVAILABLE: '마이크를 사용할 수 없습니다. 다른 프로그램이 마이크를 사용 중인지 확인해주세요.',
  MIC_FALLBACK_DEFAULT: '설정에서 고른 마이크를 찾을 수 없어 시스템 기본 마이크로 녹음했습니다.',        // 완료 경고
  MIC_FALLBACK_DEFAULT_START: '설정에서 고른 마이크를 찾을 수 없어 시스템 기본 마이크로 녹음합니다.',    // 시작 안내 (같은 경고의 현재형)
  MIC_DISCONNECTED: '녹화 중 마이크 연결이 끊겨 그 이후의 마이크 소리는 녹음되지 않았습니다.',
  MIC_DISCONNECTED_STOPPED: '마이크 연결이 끊겨 그때까지 녹음한 내용으로 파일을 저장했습니다.',
  DOWNLOAD_FAILED: '파일 다운로드에 실패했습니다.',
  UNKNOWN: '알 수 없는 오류가 발생했습니다.'
};

// Recording States - 녹음 상태
export const RECORDING_STATES = {
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  PAUSED: 'PAUSED',         // 녹화 세션은 유지, 인코딩만 중단 (경과 시간도 멈춤)
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
  AVI: 'avi',
  FMP4: 'fmp4' // 조각(fragmented) MP4: 녹화 중 약 2초마다 moof+mdat 조각을 바로 기록 → 빠른 종료, 비정상 종료 시에도 기록된 조각 보존
};

// 파일 확장자 - 포맷 값과 확장자가 다른 경우만 (fMP4는 일반 MP4 플레이어에서 열리도록 .mp4)
export const FILE_EXTENSIONS = {
  fmp4: 'mp4'
};

// 표시 이름 - 완료 메시지 등에 쓰는 포맷 이름 (없으면 포맷 값을 대문자로)
export const FORMAT_LABELS = {
  fmp4: 'MP4'
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
  // 중지 시 대기 중 read가 다음 프레임을 받을 때까지 기다리는 상한(ms). Chrome은 대기 read가 있는 채로 리더를 cancel하거나 트랙을
  // 멈추면 그 read에 주려고 만든 VideoFrame을 close 없이 버리므로(누수 경고) 프레임이 오던 중이면 그 프레임을 받아 닫은 뒤 cancel
  STOP_DRAIN_TIMEOUT_MS: 200,
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
