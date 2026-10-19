// Sample Index - 녹화 중 쌓이는 샘플 메타데이터(오프셋·크기·타임스탬프 등)를 샘플마다 객체로 만들지 않고
// 열(column)별 typed array에 보관합니다.
//
// 3시간 녹화는 영상 약 32만 + 오디오 약 41~45만 샘플입니다. 샘플마다 { ref:{offset,size}, timestamp, ... } 객체를 두면
// 객체 헤더와 숫자 박싱 때문에 샘플당 약 50~80바이트(3시간 약 55 MB)가 JS 힙에 쌓이고, 중지 시 머서가 이를 다시
// 여러 객체로 펼치면서 수백 MB가 한꺼번에 늘어납니다. 여기서는 샘플당 영상 23바이트 / 오디오 14바이트만 씁니다.
//
// - 영상(kind 'video'): offset(Float64) size(Uint32) timestamp µs(Float64) flags(Uint8, bit0 = 키프레임) nalCount(Uint16)
// - 오디오(kind 'audio'): offset(Float64) size(Uint32) samples(Uint16, 프레임당 PCM 샘플 수)
// 용량이 차면 두 배로 늘립니다(복사 1회). 읽기는 offsetAt(i) 같은 인덱스 접근만 제공합니다(반복자/콜백 없음).

const FLAG_KEYFRAME = 1;
const UINT32_MAX = 0xFFFFFFFF;
const UINT16_MAX = 0xFFFF;

const COLUMNS = {
  video: { offset: Float64Array, size: Uint32Array, timestamp: Float64Array, flags: Uint8Array, nalCount: Uint16Array },
  audio: { offset: Float64Array, size: Uint32Array, samples: Uint16Array }
};

export class SampleIndex {
  /**
   * @param {{kind?: 'video'|'audio', initialCapacity?: number}} [options]
   */
  constructor({ kind = 'video', initialCapacity = 1024 } = {}) {
    const columns = COLUMNS[kind];
    if (!columns) throw new Error(`지원하지 않는 SampleIndex kind입니다: ${kind}`);
    this._kind = kind;
    this._columns = columns;
    this._length = 0;
    this._capacity = Math.max(1, Math.floor(initialCapacity));
    this._totalBytes = 0;
    this._totalFrameSamples = 0;
    this._maxSize = 0;
    this.offsets = new Float64Array(this._capacity);
    this.sizes = new Uint32Array(this._capacity);
    if (kind === 'video') {
      this.timestamps = new Float64Array(this._capacity);
      this.flags = new Uint8Array(this._capacity);
      this.nalCounts = new Uint16Array(this._capacity);
    } else {
      this.frameSamples = new Uint16Array(this._capacity);
    }
  }

  get kind() { return this._kind; }
  get length() { return this._length; }
  get capacity() { return this._capacity; }
  /** 참조하는 데이터 바이트 합계 (저장소에 있는 실제 샘플 크기 합) */
  get totalBytes() { return this._totalBytes; }
  /** 오디오: 프레임 샘플 수 합계 (= 트랙 길이, 샘플 단위) */
  get totalFrameSamples() { return this._totalFrameSamples; }
  get maxSize() { return this._maxSize; }

  /** 열 배열에 할당된 바이트 수 (사용 중이 아닌 여유 용량 포함) */
  get bytesUsed() {
    let bytes = this.offsets.byteLength + this.sizes.byteLength;
    if (this._kind === 'video') bytes += this.timestamps.byteLength + this.flags.byteLength + this.nalCounts.byteLength;
    else bytes += this.frameSamples.byteLength;
    return bytes;
  }

  /**
   * 영상 샘플 추가
   * @param {number} offset - 저장소 오프셋
   * @param {number} size - 바이트 크기
   * @param {number} timestampUs - 마이크로초 타임스탬프
   * @param {boolean} keyframe
   * @param {number} nalCount - AVC 샘플의 NAL 개수 (AVI Annex B 크기 계산용)
   */
  push(offset, size, timestampUs, keyframe, nalCount) {
    if (this._kind !== 'video') throw new Error('push는 video SampleIndex에서만 사용할 수 있습니다 (audio는 pushFrame)');
    checkSize(size);
    if (!(nalCount >= 0 && nalCount <= UINT16_MAX)) throw new RangeError(`NAL 개수가 범위를 벗어났습니다: ${nalCount}`);
    if (this._length === this._capacity) this.grow();
    const i = this._length;
    this.offsets[i] = offset;
    this.sizes[i] = size;
    this.timestamps[i] = timestampUs;
    this.flags[i] = keyframe ? FLAG_KEYFRAME : 0;
    this.nalCounts[i] = nalCount;
    this.added(size);
  }

  /**
   * 오디오(MP3) 프레임 추가
   * @param {number} offset
   * @param {number} size
   * @param {number} samples - 프레임당 PCM 샘플 수 (MPEG-1 1152, MPEG-2 576)
   */
  pushFrame(offset, size, samples) {
    if (this._kind !== 'audio') throw new Error('pushFrame은 audio SampleIndex에서만 사용할 수 있습니다 (video는 push)');
    checkSize(size);
    if (!(samples >= 0 && samples <= UINT16_MAX)) throw new RangeError(`프레임 샘플 수가 범위를 벗어났습니다: ${samples}`);
    if (this._length === this._capacity) this.grow();
    const i = this._length;
    this.offsets[i] = offset;
    this.sizes[i] = size;
    this.frameSamples[i] = samples;
    this._totalFrameSamples += samples;
    this.added(size);
  }

  added(size) {
    this._length++;
    this._totalBytes += size;
    if (size > this._maxSize) this._maxSize = size;
  }

  grow() {
    const next = this._capacity * 2;
    this.offsets = growColumn(this.offsets, next, this._length);
    this.sizes = growColumn(this.sizes, next, this._length);
    if (this._kind === 'video') {
      this.timestamps = growColumn(this.timestamps, next, this._length);
      this.flags = growColumn(this.flags, next, this._length);
      this.nalCounts = growColumn(this.nalCounts, next, this._length);
    } else {
      this.frameSamples = growColumn(this.frameSamples, next, this._length);
    }
    this._capacity = next;
  }

  check(i) {
    if (!(i >= 0 && i < this._length)) throw new RangeError(`SampleIndex 범위를 벗어난 인덱스: ${i} (길이 ${this._length})`);
  }

  offsetAt(i) { this.check(i); return this.offsets[i]; }
  sizeAt(i) { this.check(i); return this.sizes[i]; }
  timestampAt(i) { this.check(i); return this._kind === 'video' ? this.timestamps[i] : 0; }
  keyframeAt(i) { this.check(i); return this._kind === 'video' ? (this.flags[i] & FLAG_KEYFRAME) !== 0 : true; }
  nalCountAt(i) { this.check(i); return this._kind === 'video' ? this.nalCounts[i] : 0; }
  samplesAt(i) { this.check(i); return this._kind === 'audio' ? this.frameSamples[i] : 0; }
}

function checkSize(size) {
  if (!(size >= 0 && size <= UINT32_MAX)) throw new RangeError(`샘플 크기가 범위를 벗어났습니다: ${size}`);
}

function growColumn(column, capacity, length) {
  const next = new column.constructor(capacity);
  next.set(column.subarray(0, length));
  return next;
}
