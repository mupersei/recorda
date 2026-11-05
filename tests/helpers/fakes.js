// WebCodecs / MediaStream 가짜 구현 (Node 테스트용)

export class FakeVideoFrame {
  constructor({ timestamp, width = 160, height = 120 }) {
    this.timestamp = timestamp;
    this.codedWidth = width;
    this.codedHeight = height;
    this.displayWidth = width;
    this.displayHeight = height;
    this.closed = false;
  }
  close() { this.closed = true; }
}

/**
 * read()가 프레임을 순서대로 돌려주고, 소진되면 cancel()될 때까지 대기하는 리더 (MediaStreamTrackProcessor 리더 흉내).
 * 프레임 수명 검사용 기록:
 * - handed: 리더(소스)에 넘겨진 모든 프레임 (생성자 + push + 아래 in-flight 프레임)
 * - delivered: read()로 실제 전달한 프레임 → 전달된 프레임은 받은 쪽(인코더)이 반드시 close해야 함
 * - discarded: cancel 때까지 전달되지 않고 남은 프레임. Chrome에서는 JS VideoFrame이 되기 전의 미디어 프레임이라 브라우저가 스스로
 *   해제하므로(경고 없음) 여기서도 리더가 닫음 (discardedBySource 표시)
 * - pendingReadsAtCancel: 처음 cancel될 때 대기 중이던 read 수
 * - inFlightOnCancel(옵션): 실측한 Chrome 148 동작 흉내. 대기 중 read가 있는 채로 cancel하면 그 read에 주려고 이미 만든 VideoFrame이
 *   전달되지 못하고 close 없이 버려짐 → droppedInFlight에 남김 (실제 Chrome에서는 "garbage collected without being closed" 경고)
 */
export class FakeReader {
  constructor(frames, { endWhenExhausted = false, inFlightOnCancel = false } = {}) {
    this.frames = [...frames];
    this.handed = [...frames];
    this.delivered = [];
    this.discarded = [];
    this.droppedInFlight = [];
    this.endWhenExhausted = endWhenExhausted;
    this.inFlightOnCancel = inFlightOnCancel;
    this.cancelled = false;
    this.cancelCalls = 0;
    this.pendingReadsAtCancel = null;
    this.readCalls = 0;
    this.waiters = [];
  }
  /** 지금 대기 중인 read 수 */
  get pendingReads() { return this.waiters.length; }
  read() {
    this.readCalls++;
    if (this.cancelled) return Promise.resolve({ done: true, value: undefined });
    if (this.frames.length > 0) return Promise.resolve({ done: false, value: this.deliver(this.frames.shift()) });
    if (this.endWhenExhausted) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  deliver(frame) {
    this.delivered.push(frame);
    return frame;
  }
  cancel() {
    this.cancelCalls++;
    if (!this.cancelled) {
      this.pendingReadsAtCancel = this.waiters.length;
      if (this.inFlightOnCancel && this.waiters.length > 0) {
        // 대기 중 read용으로 만들어 전달하던 프레임: 스트림이 닫혀 아무도 받지 못하고 close되지 않은 채 버려짐
        const frame = new FakeVideoFrame({ timestamp: -1 });
        frame.inFlight = true;
        this.handed.push(frame);
        this.droppedInFlight.push(frame);
      }
      for (const frame of this.frames) {
        frame.discardedBySource = true;
        frame.close();
        this.discarded.push(frame);
      }
      this.frames = [];
    }
    this.cancelled = true;
    for (const w of this.waiters) w({ done: true, value: undefined });
    this.waiters = [];
    return Promise.resolve();
  }
  /** 테스트 중 프레임을 추가로 밀어 넣기 (소스가 새 프레임을 냄). cancel 뒤에는 소스가 닫혀 버려짐 */
  push(frame) {
    this.handed.push(frame);
    if (this.cancelled) {
      frame.discardedBySource = true;
      frame.close();
      this.discarded.push(frame);
      return;
    }
    if (this.waiters.length) this.waiters.shift()({ done: false, value: this.deliver(frame) });
    else this.frames.push(frame);
  }
  /** 리더에 넘겨진 프레임 중 아무도 닫지 않은 것 (in-flight로 버려진 프레임 포함) → 비어 있어야 함 */
  unclosed() { return this.handed.filter(f => !f.closed); }
}

export function makeFakeTrackProcessor(reader) {
  return class FakeTrackProcessor {
    constructor({ track }) {
      this.track = track;
      this.readable = { getReader: () => reader };
    }
  };
}

export const FAKE_AVCC = new Uint8Array([1, 0x42, 0x00, 0x2A, 0xFF, 0xE1, 0, 4, 0x67, 0x42, 0x00, 0x2A, 1, 0, 2, 0x68, 0xCE]);

/**
 * 가짜 VideoEncoder. encode()는 즉시 output 콜백을 호출합니다.
 * options.supported: 지원하는 codec 문자열 목록
 * options.failOn: n번째 encode에서 error 콜백 호출 (인코더 비동기 오류 흉내, 이후 상태 closed)
 * options.throwOnEncodeAt: n번째(0부터) encode 호출이 동기 예외를 던짐 (닫힌/오류 상태 코덱의 InvalidStateError 흉내)
 * options.throwOnConfigure: configure()가 동기 예외를 던짐 (지원하지 않는 설정)
 */
export function makeFakeVideoEncoder({ supported = ['avc1.42002A'], failOn = null, throwOnEncodeAt = null, throwOnConfigure = false } = {}) {
  const instances = [];
  class FakeVideoEncoder {
    static probes = [];
    static async isConfigSupported(config) {
      FakeVideoEncoder.probes.push(config.codec);
      return { supported: supported.includes(config.codec), config };
    }
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.config = null;
      this.encodeQueueSize = 0;
      this.encoded = [];
      this.flushed = false;
      this.closed = false;
      this.state = 'unconfigured';
      this.sentConfig = false;
      instances.push(this);
    }
    configure(config) {
      if (throwOnConfigure) throw new DOMException('가짜 configure 실패', 'NotSupportedError');
      this.config = config; this.state = 'configured';
    }
    encode(frame, options = {}) {
      this.encodeCalls = (this.encodeCalls || 0) + 1;
      if (this.state === 'closed') throw new DOMException("Cannot call 'encode' on a closed codec.", 'InvalidStateError');
      if (throwOnEncodeAt !== null && this.encodeCalls - 1 === throwOnEncodeAt) {
        throw new DOMException('가짜 encode 동기 예외', 'InvalidStateError');
      }
      if (failOn && this.encoded.length === failOn) {
        this.state = 'closed';
        this.error(new Error('가짜 인코더 오류'));
        return;
      }
      const key = !!options.keyFrame || this.encoded.length === 0;
      const payload = new Uint8Array([0, 0, 0, 2, key ? 0x65 : 0x41, this.encoded.length & 0xFF]);
      this.encoded.push({ timestamp: frame.timestamp, key });
      const chunk = {
        type: key ? 'key' : 'delta',
        timestamp: frame.timestamp,
        byteLength: payload.length,
        copyTo: (dest) => dest.set(payload)
      };
      const metadata = {};
      if (key && !this.sentConfig) {
        metadata.decoderConfig = { codec: this.config.codec, description: FAKE_AVCC };
        this.sentConfig = true;
      }
      this.output(chunk, metadata);
    }
    async flush() { this.flushed = true; }
    close() { this.closed = true; this.state = 'closed'; }
  }
  return { FakeVideoEncoder, instances };
}

// ---- 마이크 / 권한 (navigator.mediaDevices, navigator.permissions) 가짜 ----

/** MediaStreamTrack 흉내: stop() 기록, ended 흉내(end()) */
export class FakeMediaStreamTrack {
  constructor(kind, label = '', settings = {}) {
    this.kind = kind;
    this.label = label;
    this.enabled = true;
    this.readyState = 'live';
    this.onended = null;
    this.stopped = false;
    this.settings = settings;
  }
  stop() { this.stopped = true; this.readyState = 'ended'; }
  getSettings() { return { ...this.settings }; }
  /** 장치 분리 등으로 트랙이 끝남 (stop()과 달리 onended가 불림) */
  end() { this.readyState = 'ended'; if (typeof this.onended === 'function') this.onended(); }
}

/** MediaStream 흉내 */
export function makeFakeStream(tracks) {
  return {
    id: `stream-${Math.random().toString(36).slice(2, 8)}`,
    tracks,
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter(t => t.kind === 'video')
  };
}

/** 마이크 스트림 (오디오 트랙 1개, 기본 48 kHz 모노 - 탭 캡처·AudioContext 샘플레이트와 다를 수 있음) */
export function makeFakeMicStream({ label = 'Fake Mic', deviceId = 'mic-1', sampleRate = 48000, channelCount = 1 } = {}) {
  return makeFakeStream([new FakeMediaStreamTrack('audio', label, { deviceId, sampleRate, channelCount })]);
}

/** DOMException 대신 이름만 맞춘 오류 (OverconstrainedError는 DOMException이 아님) */
export function namedError(name, message = name, extra = {}) {
  return Object.assign(new Error(message), { name }, extra);
}

/**
 * navigator.permissions 흉내. query({name:'microphone'})는 같은 PermissionStatus 객체를 돌려주고 setState()로 바꾸면 change 이벤트
 * options.unsupported: query가 TypeError를 던짐 (microphone 이름 미지원 환경)
 */
export function makeFakePermissions(initial = 'prompt', { unsupported = false } = {}) {
  const listeners = new Set();
  const status = {
    name: 'microphone',
    state: initial,
    onchange: null,
    addEventListener: (type, fn) => { if (type === 'change') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'change') listeners.delete(fn); }
  };
  const calls = [];
  return {
    calls,
    status,
    listenerCount: () => listeners.size + (typeof status.onchange === 'function' ? 1 : 0),
    query: async (descriptor) => {
      calls.push(descriptor);
      if (unsupported) throw new TypeError(`The provided value '${descriptor && descriptor.name}' is not a valid enum value of type PermissionName.`);
      return status;
    },
    setState(state) {
      status.state = state;
      const event = { type: 'change', target: status };
      for (const fn of [...listeners]) fn(event);
      if (typeof status.onchange === 'function') status.onchange(event);
    }
  };
}

/**
 * navigator.mediaDevices 흉내 (마이크 권한 흐름 포함).
 * - enumerateDevices: 권한(permissions.status.state)이 granted가 아니면 Chrome처럼 장치 이름·ID를 숨긴 항목 1개만 돌려줌
 * - getUserMedia: 권한 granted → 스트림, prompt → promptAnswer('granted' | 'denied')로 응답(권한 상태도 바뀜), denied → NotAllowedError,
 *   마이크가 하나도 없으면 NotFoundError. options.getUserMedia로 동작을 통째로 바꿀 수 있음
 */
export function makeFakeMediaDevices({ devices = [], permissions = null, promptAnswer = 'granted', getUserMedia = null } = {}) {
  let list = devices.map(d => ({ kind: 'audioinput', groupId: '', ...d }));
  const listeners = new Set();
  const calls = { getUserMedia: [], enumerateDevices: 0 };
  const streams = [];
  const state = () => (permissions ? permissions.status.state : 'granted');
  const md = {
    calls,
    streams,
    promptAnswer,
    ondevicechange: null,
    addEventListener: (type, fn) => { if (type === 'devicechange') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'devicechange') listeners.delete(fn); },
    listenerCount: () => listeners.size,
    async enumerateDevices() {
      calls.enumerateDevices++;
      if (state() === 'granted') return list.map(d => ({ ...d }));
      // 권한 전: 종류별로 이름·ID 없는 항목 하나만
      return list.some(d => d.kind === 'audioinput') ? [{ kind: 'audioinput', deviceId: '', label: '', groupId: '' }] : [];
    },
    async getUserMedia(constraints) {
      calls.getUserMedia.push(constraints);
      if (getUserMedia) return getUserMedia(constraints);
      const inputs = list.filter(d => d.kind === 'audioinput');
      if (inputs.length === 0) throw namedError('NotFoundError', 'Requested device not found');
      if (state() === 'denied') throw namedError('NotAllowedError', 'Permission denied');
      if (state() === 'prompt') {
        if (permissions) permissions.setState(md.promptAnswer);
        if (md.promptAnswer !== 'granted') throw namedError('NotAllowedError', 'Permission denied');
      }
      const wanted = constraints && constraints.audio && constraints.audio.deviceId && constraints.audio.deviceId.exact;
      const device = wanted ? inputs.find(d => d.deviceId === wanted) : (inputs.find(d => d.deviceId === 'default') || inputs[0]);
      if (!device) throw namedError('OverconstrainedError', 'Constraints could not be satisfied', { constraint: 'deviceId' });
      const stream = makeFakeMicStream({ label: device.label, deviceId: device.deviceId });
      streams.push(stream);
      return stream;
    },
    setDevices(next) { list = next.map(d => ({ kind: 'audioinput', groupId: '', ...d })); },
    fireDeviceChange() {
      const event = { type: 'devicechange' };
      for (const fn of [...listeners]) fn(event);
      if (typeof md.ondevicechange === 'function') md.ondevicechange(event);
    }
  };
  return md;
}
