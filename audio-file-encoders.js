// Audio File Encoders - 오디오 단독 파일(WAV/MP3)을 메모리에 모으지 않고 출력 싱크(디스크)에 바로 기록
// 기존 encoders.js의 StreamingWavEncoder(IndexedDB → 종료 시 전체 메모리 로드)와 StreamingMp3Encoder(메모리 보관)를 대체합니다.
// 공통 API: start() / processChunk(left, right) / finish() → Blob, isStarted

const DEFAULT_BUFFER_BYTES = 256 * 1024; // 싱크 쓰기 IPC 횟수를 줄이기 위한 버퍼
const WAV_HEADER_BYTES = 44;
const WAV_MAX_DATA_BYTES = 0xFFFFFFFF - 36; // RIFF 32비트 크기 한계

function floatTo16(float32, out, outOffset, stride) {
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[outOffset + i * stride] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
}

/** 싱크 앞단의 쓰기 버퍼 (append 순서 보장, 크기 초과 시 자동 flush) */
class BufferedWriter {
  constructor(sink, bufferBytes) {
    this.sink = sink;
    this.bufferBytes = bufferBytes;
    this.parts = [];
    this.buffered = 0;
    this.queue = Promise.resolve();
    this.error = null;
    this.bytesWritten = 0;
  }

  get retainedBytes() { return this.buffered; }

  push(bytes) {
    this.parts.push(bytes);
    this.buffered += bytes.length;
    if (this.buffered >= this.bufferBytes) this.flush();
  }

  flush() {
    if (this.parts.length === 0) return this.queue;
    const parts = this.parts;
    this.parts = [];
    this.buffered = 0;
    let merged;
    if (parts.length === 1) merged = parts[0];
    else {
      merged = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) { merged.set(p, o); o += p.length; }
    }
    this.bytesWritten += merged.length;
    this.queue = this.queue.then(() => this.sink.write(merged)).catch((error) => {
      console.error('[AudioFileEncoder] 쓰기 실패:', error);
      this.error = this.error || error;
    });
    return this.queue;
  }

  async drain() {
    await this.flush();
    await this.queue;
    if (this.error) throw this.error;
  }
}

/**
 * WAV(16-bit PCM) 파일 인코더: 헤더 자리를 먼저 쓰고 PCM을 이어 쓴 뒤 종료 시 헤더를 패치합니다.
 */
export class WavFileEncoder {
  constructor({ sampleRate, channels = 2, sink, bufferBytes = DEFAULT_BUFFER_BYTES }) {
    if (!sink) throw new Error('출력 싱크(sink)가 필요합니다');
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.sink = sink;
    this.bufferBytes = bufferBytes;
    this.writer = null;
    this.totalSamples = 0;
    this.dataBytes = 0;
    this.isStarted = false;
  }

  get retainedBytes() { return this.writer ? this.writer.retainedBytes : 0; }

  async start() {
    if (this.isStarted) return;
    this.writer = new BufferedWriter(this.sink, this.bufferBytes);
    this.totalSamples = 0;
    this.dataBytes = 0;
    await this.sink.write(new Uint8Array(WAV_HEADER_BYTES)); // 헤더 자리 (finish에서 패치)
    this.isStarted = true;
  }

  processChunk(left, right) {
    if (!this.isStarted || !left) return;
    const frames = left.length;
    const r = right || left;
    const pcm = new Int16Array(frames * this.channels);
    if (this.channels === 1) {
      floatTo16(left, pcm, 0, 1);
    } else {
      floatTo16(left, pcm, 0, 2);
      floatTo16(r, pcm, 1, 2);
    }
    const bytes = new Uint8Array(pcm.buffer);
    if (this.dataBytes + bytes.length > WAV_MAX_DATA_BYTES) {
      console.warn('[WavFileEncoder] WAV 4GB 한계 도달 - 이후 데이터는 기록하지 않습니다');
      return;
    }
    this.totalSamples += frames;
    this.dataBytes += bytes.length;
    this.writer.push(bytes);
  }

  buildHeader() {
    const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
    const view = new DataView(buffer);
    const put = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    put(0, 'RIFF');
    view.setUint32(4, 36 + this.dataBytes, true);
    put(8, 'WAVE');
    put(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, this.channels, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * this.channels * 2, true);
    view.setUint16(32, this.channels * 2, true);
    view.setUint16(34, 16, true);
    put(36, 'data');
    view.setUint32(40, this.dataBytes, true);
    return new Uint8Array(buffer);
  }

  async finish() {
    if (!this.isStarted) throw new Error('인코더가 시작되지 않았습니다');
    await this.writer.drain();
    await this.sink.writeAt(0, this.buildHeader());
    this.isStarted = false;
    const blob = await this.sink.close();
    console.log('[WavFileEncoder] 완료:', { samples: this.totalSamples, bytes: WAV_HEADER_BYTES + this.dataBytes });
    return blob;
  }
}

/**
 * MP3 파일 인코더 (lamejs): 인코더 출력을 싱크에 바로 기록합니다. lamejs 전역 객체가 필요합니다.
 */
export class Mp3FileEncoder {
  constructor({ sampleRate, channels = 2, bitrateKbps = 128, sink, bufferBytes = DEFAULT_BUFFER_BYTES }) {
    if (!sink) throw new Error('출력 싱크(sink)가 필요합니다');
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitrateKbps = bitrateKbps;
    this.sink = sink;
    this.bufferBytes = bufferBytes;
    this.writer = null;
    this.encoder = null;
    this.totalSamples = 0;
    this.isStarted = false;
  }

  get retainedBytes() { return this.writer ? this.writer.retainedBytes : 0; }

  async start() {
    if (this.isStarted) return;
    if (typeof lamejs === 'undefined') throw new Error('lamejs 라이브러리가 로드되지 않았습니다');
    this.encoder = new lamejs.Mp3Encoder(this.channels, this.sampleRate, this.bitrateKbps);
    this.writer = new BufferedWriter(this.sink, this.bufferBytes);
    this.totalSamples = 0;
    this.isStarted = true;
  }

  processChunk(left, right) {
    if (!this.isStarted || !left) return;
    const l = new Int16Array(left.length);
    floatTo16(left, l, 0, 1);
    let r = l;
    if (right && this.channels > 1) {
      r = new Int16Array(right.length);
      floatTo16(right, r, 0, 1);
    }
    const out = this.encoder.encodeBuffer(l, r);
    this.totalSamples += left.length;
    if (out.length > 0) this.writer.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
  }

  async finish() {
    if (!this.isStarted) throw new Error('인코더가 시작되지 않았습니다');
    const tail = this.encoder.flush();
    if (tail.length > 0) this.writer.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length).slice());
    await this.writer.drain();
    this.isStarted = false;
    this.encoder = null;
    const blob = await this.sink.close();
    console.log('[Mp3FileEncoder] 완료:', { samples: this.totalSamples, bytes: blob.size });
    return blob;
  }
}
