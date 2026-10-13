// Container Audio Encoder - 영상 컨테이너(MP4/MOV/AVI)에 담을 MP3 프레임을 실시간으로 생성
// lamejs 전역 객체가 필요합니다 (offscreen.html에서 lib/lame.min.js 로드).
import { Mp3FrameSplitter } from './muxers/mp3-frames.js';

export class ContainerAudioEncoder {
  /**
   * @param {{sampleRate:number, channels:number, bitrateKbps:number}} options
   */
  constructor({ sampleRate, channels = 2, bitrateKbps = 128 }) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitrateKbps = bitrateKbps;
    this.encoder = null;
    this.splitter = null;
    this.frames = [];
    this.totalSamples = 0;
    this.isStarted = false;
  }

  start() {
    if (this.isStarted) return;
    if (typeof lamejs === 'undefined') {
      throw new Error('lamejs 라이브러리가 로드되지 않았습니다');
    }
    this.encoder = new lamejs.Mp3Encoder(this.channels, this.sampleRate, this.bitrateKbps);
    this.splitter = new Mp3FrameSplitter();
    this.frames = [];
    this.totalSamples = 0;
    this.isStarted = true;
  }

  /**
   * AudioWorklet에서 받은 Float32 PCM 청크를 인코딩
   * @param {Float32Array} left
   * @param {Float32Array} [right]
   */
  processChunk(left, right) {
    if (!this.isStarted || !left) return;
    const l = floatTo16BitPCM(left);
    const r = right ? floatTo16BitPCM(right) : l;
    const out = this.encoder.encodeBuffer(l, r);
    this.totalSamples += left.length;
    if (out.length > 0) {
      this.frames.push(...this.splitter.push(new Uint8Array(out.buffer, out.byteOffset, out.length)));
    }
  }

  /**
   * 인코딩을 끝내고 머서 입력용 오디오 트랙 설명을 반환
   * @returns {{codec:'mp3', sampleRate:number, channels:number, bitrate:number, frames:Array<{data:Uint8Array, samples:number}>}}
   */
  finish() {
    if (!this.isStarted) {
      throw new Error('ContainerAudioEncoder가 시작되지 않았습니다');
    }
    const tail = this.encoder.flush();
    if (tail.length > 0) {
      this.frames.push(...this.splitter.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length)));
    }
    this.splitter.flush();
    this.isStarted = false;
    this.encoder = null;

    return {
      codec: 'mp3',
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitrate: this.bitrateKbps * 1000,
      frames: this.frames
    };
  }
}

function floatTo16BitPCM(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16Array;
}
