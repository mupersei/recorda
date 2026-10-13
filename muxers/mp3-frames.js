// MP3 프레임 분리 - lamejs 출력 바이트열을 컨테이너용 개별 프레임(샘플)으로 나눕니다.

// MPEG-1 Layer III 비트레이트 테이블 (kbps), index 0=free, 15=bad
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
// MPEG-2/2.5 Layer III
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000]   // MPEG-2.5
};

/**
 * MP3 프레임 헤더를 해석합니다.
 * @param {Uint8Array} data
 * @param {number} offset
 * @returns {{frameLength:number, samplesPerFrame:number, sampleRate:number, bitrate:number, channels:number}|null}
 */
export function parseMp3FrameHeader(data, offset) {
  if (offset + 4 > data.length) return null;
  const b0 = data[offset], b1 = data[offset + 1], b2 = data[offset + 2], b3 = data[offset + 3];

  // 프레임 싱크 11비트
  if (b0 !== 0xFF || (b1 & 0xE0) !== 0xE0) return null;

  const versionBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
  const layerBits = (b1 >> 1) & 0x03;   // 1 = Layer III
  if (versionBits === 1 || layerBits !== 1) return null;

  const bitrateIndex = (b2 >> 4) & 0x0F;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const isMpeg1 = versionBits === 3;
  const bitrate = (isMpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[versionBits][sampleRateIndex];
  const samplesPerFrame = isMpeg1 ? 1152 : 576;
  const frameLength = Math.floor((samplesPerFrame / 8) * bitrate / sampleRate) + padding;
  const channelMode = (b3 >> 6) & 0x03; // 3 = mono
  const channels = channelMode === 3 ? 1 : 2;

  return { frameLength, samplesPerFrame, sampleRate, bitrate, channels };
}

/**
 * 스트리밍 입력에서 완전한 MP3 프레임만 잘라내는 분리기
 */
export class Mp3FrameSplitter {
  constructor() {
    this.pending = new Uint8Array(0);
    this.discardedBytes = 0;
  }

  /**
   * @param {Uint8Array} chunk
   * @returns {Array<{data: Uint8Array, samples: number, sampleRate: number}>}
   */
  push(chunk) {
    if (!chunk || chunk.length === 0) return [];

    let buffer;
    if (this.pending.length === 0) {
      buffer = chunk;
    } else {
      buffer = new Uint8Array(this.pending.length + chunk.length);
      buffer.set(this.pending, 0);
      buffer.set(chunk, this.pending.length);
    }

    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
      const header = parseMp3FrameHeader(buffer, offset);
      if (!header) {
        if (offset + 4 > buffer.length) break; // 헤더가 아직 다 안 들어옴
        // 싱크 손실: 1바이트씩 전진하며 재동기화
        this.discardedBytes++;
        offset++;
        continue;
      }
      if (offset + header.frameLength > buffer.length) break; // 프레임이 아직 완성되지 않음
      frames.push({
        data: buffer.slice(offset, offset + header.frameLength),
        samples: header.samplesPerFrame,
        sampleRate: header.sampleRate
      });
      offset += header.frameLength;
    }

    this.pending = buffer.slice(offset);
    return frames;
  }

  /**
   * 입력 종료 - 남은 불완전 데이터는 폐기합니다.
   * @returns {Array} 항상 빈 배열 (API 대칭성을 위해 유지)
   */
  flush() {
    this.discardedBytes += this.pending.length;
    this.pending = new Uint8Array(0);
    return [];
  }
}
