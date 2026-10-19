// Container Audio Encoder - 영상 컨테이너(MP4/MOV/AVI)에 담을 MP3 프레임을 실시간으로 생성
// lamejs 전역 객체가 필요합니다 (offscreen.html에서 lib/lame.min.js 로드).
import { Mp3FrameSplitter } from './muxers/mp3-frames.js';
import { SampleIndex } from './storage/sample-index.js';

export class ContainerAudioEncoder {
  /**
   * @param {{sampleRate:number, channels:number, bitrateKbps:number, chunkStore?:Object, frameSink?:Object}} options
   *   chunkStore: 프레임 데이터를 저장소로 보내고 오프셋·크기·샘플 수만 SampleIndex에 보관 (AVI)
   *   frameSink: 결과 파일 작성기(DirectMp4Writer / FragmentedMp4Writer)에 프레임을 바로 넘김 - addAudioFrame(data, { samples })
   */
  constructor({ sampleRate, channels = 2, bitrateKbps = 128, chunkStore = null, frameSink = null }) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitrateKbps = bitrateKbps;
    this.frameSink = frameSink;
    this.chunkStore = frameSink ? null : chunkStore;
    this.encoder = null;
    this.splitter = null;
    this.frames = [];   // 메모리 경로: { data, samples } 배열
    this.index = null;  // 저장소 경로: SampleIndex (프레임마다 객체를 만들지 않음, 프레임당 14바이트)
    this.sinkFrames = 0; // 작성기 경로: 넘긴 프레임 수
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
    this.index = this.chunkStore ? new SampleIndex({ kind: 'audio' }) : null;
    this.sinkFrames = 0;
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
      this.pushFrames(this.splitter.push(new Uint8Array(out.buffer, out.byteOffset, out.length)));
    }
  }

  /** 지금까지 만든 MP3 프레임 수 */
  get frameCount() {
    if (this.frameSink) return this.sinkFrames;
    return this.index ? this.index.length : this.frames.length;
  }

  pushFrames(frames) {
    const store = this.chunkStore;
    const sink = this.frameSink;
    for (const f of frames) {
      if (sink) {
        // 결과 파일 작성기로 바로 (분리기가 프레임마다 새 버퍼를 만들므로 복사 없이 넘김)
        sink.addAudioFrame(f.data, { samples: f.samples });
        this.sinkFrames++;
      } else if (store) {
        const offset = typeof store.appendBytes === 'function' ? store.appendBytes(f.data) : store.append(f.data).offset;
        this.index.pushFrame(offset, f.data.length, f.samples);
      } else {
        this.frames.push(f);
      }
    }
  }

  /**
   * 인코딩을 끝내고 머서 입력용 오디오 트랙 설명을 반환
   * @returns {{codec:'mp3', sampleRate:number, channels:number, bitrate:number, frames?:Array<{data:Uint8Array, samples:number}>, index?:SampleIndex, frameCount?:number, store:Object|null}}
   *   저장소 경로는 frames 대신 index(SampleIndex)를, 작성기 경로는 frameCount만 돌려줍니다 (프레임은 이미 작성기에 있음).
   */
  async finish() {
    if (!this.isStarted) {
      throw new Error('ContainerAudioEncoder가 시작되지 않았습니다');
    }
    const tail = this.encoder.flush();
    if (tail.length > 0) {
      this.pushFrames(this.splitter.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length)));
    }
    this.splitter.flush();
    this.isStarted = false;
    this.encoder = null;
    if (this.chunkStore) {
      await this.chunkStore.finalize();
    }

    const track = {
      codec: 'mp3',
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitrate: this.bitrateKbps * 1000,
      store: this.chunkStore
    };
    if (this.frameSink) track.frameCount = this.sinkFrames;
    else if (this.index) track.index = this.index;
    else track.frames = this.frames;
    return track;
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
