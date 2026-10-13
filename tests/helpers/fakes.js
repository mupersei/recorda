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

/** read()가 프레임을 순서대로 돌려주고, 소진되면 cancel()될 때까지 대기하는 리더 */
export class FakeReader {
  constructor(frames, { endWhenExhausted = false } = {}) {
    this.frames = [...frames];
    this.endWhenExhausted = endWhenExhausted;
    this.cancelled = false;
    this.waiters = [];
  }
  read() {
    if (this.cancelled) return Promise.resolve({ done: true, value: undefined });
    if (this.frames.length > 0) return Promise.resolve({ done: false, value: this.frames.shift() });
    if (this.endWhenExhausted) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  cancel() {
    this.cancelled = true;
    for (const w of this.waiters) w({ done: true, value: undefined });
    this.waiters = [];
    return Promise.resolve();
  }
  /** 테스트 중 프레임을 추가로 밀어 넣기 */
  push(frame) {
    if (this.waiters.length) this.waiters.shift()({ done: false, value: frame });
    else this.frames.push(frame);
  }
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
 */
export function makeFakeVideoEncoder({ supported = ['avc1.42002A'], failOn = null } = {}) {
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
    configure(config) { this.config = config; this.state = 'configured'; }
    encode(frame, options = {}) {
      if (failOn && this.encoded.length === failOn) {
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
