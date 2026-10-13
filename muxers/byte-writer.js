// ByteWriter - 바이너리 컨테이너(MP4/MOV/AVI) 작성용 가변 길이 바이트 버퍼

export class ByteWriter {
  constructor(initialCapacity = 1024) {
    this.buffer = new Uint8Array(Math.max(16, initialCapacity));
    this.view = new DataView(this.buffer.buffer);
    this.length = 0;
  }

  ensure(extra) {
    const required = this.length + extra;
    if (required <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(value) {
    this.ensure(1);
    this.buffer[this.length++] = value & 0xFF;
    return this;
  }

  u16be(value) { this.ensure(2); this.view.setUint16(this.length, value, false); this.length += 2; return this; }
  u16le(value) { this.ensure(2); this.view.setUint16(this.length, value, true); this.length += 2; return this; }
  i16le(value) { this.ensure(2); this.view.setInt16(this.length, value, true); this.length += 2; return this; }
  u32be(value) { this.ensure(4); this.view.setUint32(this.length, value >>> 0, false); this.length += 4; return this; }
  u32le(value) { this.ensure(4); this.view.setUint32(this.length, value >>> 0, true); this.length += 4; return this; }
  i32le(value) { this.ensure(4); this.view.setInt32(this.length, value, true); this.length += 4; return this; }

  u64be(value) {
    this.ensure(8);
    this.view.setBigUint64(this.length, BigInt(value), false);
    this.length += 8;
    return this;
  }

  /** 16.16 고정소수점 (MP4 matrix/width/height 등) */
  fixed16_16(value) { return this.u32be(Math.round(value * 0x10000)); }

  /** 8.8 고정소수점 (MP4 volume) */
  fixed8_8(value) { return this.u16be(Math.round(value * 0x100)); }

  ascii(text) {
    this.ensure(text.length);
    for (let i = 0; i < text.length; i++) {
      this.buffer[this.length++] = text.charCodeAt(i) & 0xFF;
    }
    return this;
  }

  /** Uint8Array 그대로 기록 (이름 충돌 방지를 위해 bytes_ 사용) */
  bytes_(data) {
    this.ensure(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
    return this;
  }

  zeros(count) {
    this.ensure(count);
    this.buffer.fill(0, this.length, this.length + count);
    this.length += count;
    return this;
  }

  patchU32be(offset, value) { this.view.setUint32(offset, value >>> 0, false); return this; }
  patchU32le(offset, value) { this.view.setUint32(offset, value >>> 0, true); return this; }

  /** 지금까지 기록한 바이트의 복사본이 아닌 뷰 반환 */
  bytes() {
    return this.buffer.subarray(0, this.length);
  }
}

/**
 * 여러 Uint8Array를 하나로 합칩니다.
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
export function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * 4글자 코드를 리틀엔디언 u32 값으로 변환 (AVI용)
 * @param {string} code
 * @returns {number}
 */
export function fourcc(code) {
  if (typeof code !== 'string' || code.length !== 4) {
    throw new Error(`fourcc는 4글자여야 합니다: ${code}`);
  }
  return (code.charCodeAt(0) | (code.charCodeAt(1) << 8) | (code.charCodeAt(2) << 16) | (code.charCodeAt(3) << 24)) >>> 0;
}
