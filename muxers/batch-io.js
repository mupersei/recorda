// Batch I/O - 머싱 시 샘플 단위 I/O를 큰 묶음으로 바꿔 브라우저 IPC 횟수를 줄입니다.
//
// OPFS 쓰기/읽기는 호출마다 브라우저 프로세스 왕복(약 0.7 ms)과 Blob 참조 등록이 생깁니다.
// 1시간 녹화는 샘플이 약 25만 개라 샘플마다 쓰면 수 분이 걸리고 브라우저 메모리도 GB 단위로 늘어납니다.

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * 바이트 조각을 고정 크기 버퍼에 복사해 모았다가 버퍼가 차면 한 번에 씁니다.
 * 디스크 파일 조각(Blob slice)을 묶는 방식은 브라우저가 조각마다 참조를 만들어 메모리가 크게 늘기 때문에
 * Uint8Array만 받습니다. 메모리 사용량은 버퍼 크기로 고정됩니다.
 */
export class BatchWriter {
  constructor(sink, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.sink = sink;
    this.buffer = new Uint8Array(maxBytes);
    this.used = 0;
    this.bytesWritten = 0;
  }

  /** 지금까지 add한 총 바이트 (쓰기 완료분 + 버퍼에 남은 분) */
  get position() { return this.bytesWritten + this.used; }

  async add(part) {
    if (!(part instanceof Uint8Array)) {
      throw new Error('BatchWriter는 Uint8Array만 받습니다');
    }
    let offset = 0;
    while (offset < part.length) {
      const n = Math.min(part.length - offset, this.buffer.length - this.used);
      this.buffer.set(part.subarray(offset, offset + n), this.used);
      this.used += n;
      offset += n;
      if (this.used === this.buffer.length) await this.flush();
    }
  }

  async flush() {
    if (this.used === 0) return;
    const n = this.used;
    this.used = 0;
    this.bytesWritten += n;
    // 싱크가 쓰기를 마친 뒤(await) 버퍼를 재사용하므로 복사 없이 subarray 전달
    await this.sink.write(this.buffer.subarray(0, n));
  }
}

/**
 * finalize된 ChunkStore를 순차적으로 읽을 때 큰 창 단위로 미리 읽어 저장소 읽기 호출을 줄입니다.
 * 창 버퍼는 한 번만 할당하고 store.readInto로 같은 메모리에 다시 채웁니다 (OPFS는 BYOB 스트림 → 창마다 새 ArrayBuffer 없음).
 * 이전에는 창마다 file.slice().arrayBuffer()로 8 MB짜리 새 버퍼를 만들어, GC가 돌기 전까지 버려진 창이 렌더러 메모리에 쌓였습니다.
 * read()가 돌려준 뷰는 다음 read() 전까지만 유효합니다 (BatchWriter.add가 바로 복사하므로 머서에서는 안전).
 */
export class SequentialReader {
  constructor(store, { windowBytes = DEFAULT_WINDOW_BYTES } = {}) {
    this.store = store;
    this.windowBytes = windowBytes;
    this.windowStart = 0;
    this.window = null;
    this.buffer = null; // 재사용하는 창 버퍼 (BYOB 읽기 후에는 transfer된 같은 메모리)
  }

  async read(offset, size) {
    const w = this.window;
    if (w && offset >= this.windowStart && offset + size <= this.windowStart + w.length) {
      return w.subarray(offset - this.windowStart, offset - this.windowStart + size);
    }
    const length = Math.min(Math.max(size, this.windowBytes), Math.max(size, this.store.size - offset));
    this.window = null; // 이전 창 참조를 먼저 놓음
    if (typeof this.store.readInto === 'function') {
      const view = await this.store.readInto(offset, length, this.buffer);
      this.buffer = view.buffer;
      this.window = view;
    } else {
      this.window = await this.store.readRange(offset, length);
    }
    this.windowStart = offset;
    return this.window.subarray(0, size);
  }
}
