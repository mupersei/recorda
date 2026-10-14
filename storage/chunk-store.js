// Chunk Store / File Sink - 녹화 데이터를 메모리 대신 디스크(OPFS)에 두기 위한 저장소 추상화
//
// - ChunkStore: 녹화 중 인코딩된 청크를 append하고(오프셋 반환), finalize 후 임의 구간을 읽습니다.
// - FileSink:   최종 파일을 순서대로 써 내려가고 close 시 Blob(File)을 돌려줍니다.
// OPFS 구현은 데이터를 디스크에 두므로 녹화 길이와 무관하게 메모리가 일정하게 유지됩니다.
// OPFS를 쓸 수 없는 환경(테스트, 구형 브라우저)에서는 메모리 구현으로 폴백합니다.

export const OPFS_ROOT_DIR = 'recorda-recordings';
const DEFAULT_BUFFER_BYTES = 1024 * 1024; // OPFS 쓰기 IPC 횟수를 줄이기 위한 버퍼

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('Uint8Array 또는 ArrayBuffer가 필요합니다');
}

// ---------------------------------------------------------------------------
// ChunkStore
// ---------------------------------------------------------------------------

/** 메모리 저장소 - 모든 청크를 RAM에 보관 (테스트/폴백용) */
export class MemoryChunkStore {
  constructor() {
    this.chunks = [];
    this.size = 0;
    this.finalized = false;
  }

  get kind() { return 'memory'; }
  get retainedBytes() { return this.size; }

  append(data) {
    const bytes = toUint8(data);
    const ref = { offset: this.size, size: bytes.length };
    this.chunks.push(bytes);
    this.size += bytes.length;
    return ref;
  }

  async flush() {}

  async finalize() {
    if (this.finalized) return;
    // 한 번에 읽을 수 있도록 병합 (메모리 폴백이므로 어차피 전체가 RAM에 있음)
    const merged = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) { merged.set(c, o); o += c.length; }
    this.merged = merged;
    this.chunks = [];
    this.finalized = true;
  }

  async readRange(offset, size) {
    if (!this.finalized) throw new Error('finalize() 후에 읽을 수 있습니다');
    return this.merged.subarray(offset, offset + size);
  }

  async slice(offset, size) {
    if (!this.finalized) throw new Error('finalize() 후에 읽을 수 있습니다');
    return new Blob([this.merged.subarray(offset, offset + size)]);
  }

  async dispose() {
    this.chunks = [];
    this.merged = null;
    this.size = 0;
  }
}

/** OPFS 저장소 - 청크를 디스크 파일에 append. createWritable()은 close 전까지 내용이 보이지 않으므로 finalize 후 읽기 */
export class OpfsChunkStore {
  /**
   * @param {FileSystemDirectoryHandle} dir
   * @param {string} name
   * @param {{bufferBytes?: number}} [options]
   */
  constructor(dir, name, { bufferBytes = DEFAULT_BUFFER_BYTES } = {}) {
    this.dir = dir;
    this.name = name;
    this.bufferBytes = bufferBytes;
    this.size = 0;
    this.finalized = false;
    this.buffer = [];
    this.buffered = 0;
    this.writeQueue = Promise.resolve();
    this.writable = null;
    this.file = null;
    this.error = null;
  }

  get kind() { return 'opfs'; }
  get retainedBytes() { return this.buffered; }

  async open() {
    if (this.writable) return;
    const handle = await this.dir.getFileHandle(this.name, { create: true });
    this.handle = handle;
    this.writable = await handle.createWritable();
  }

  append(data) {
    if (this.finalized) throw new Error('finalize된 저장소에는 추가할 수 없습니다');
    const bytes = toUint8(data).slice(); // 호출자가 재사용하는 버퍼일 수 있으므로 복사
    const ref = { offset: this.size, size: bytes.length };
    this.size += bytes.length;
    this.buffer.push(bytes);
    this.buffered += bytes.length;
    if (this.buffered >= this.bufferBytes) this.flush();
    return ref;
  }

  /** 버퍼를 디스크에 기록 (순서 보장을 위해 큐로 직렬화) */
  flush() {
    if (this.buffer.length === 0) return this.writeQueue;
    const parts = this.buffer;
    this.buffer = [];
    this.buffered = 0;
    const merged = parts.length === 1 ? parts[0] : concat(parts);
    this.writeQueue = this.writeQueue.then(async () => {
      await this.open();
      await this.writable.write(merged);
    }).catch((error) => {
      console.error('[OpfsChunkStore] 쓰기 실패:', this.name, error);
      this.error = this.error || error;
    });
    return this.writeQueue;
  }

  async finalize() {
    if (this.finalized) return;
    await this.flush();
    await this.writeQueue;
    if (this.error) throw this.error;
    await this.open();
    await this.writable.close();
    this.writable = null;
    this.file = await this.handle.getFile();
    this.finalized = true;
  }

  async readRange(offset, size) {
    if (!this.finalized) throw new Error('finalize() 후에 읽을 수 있습니다');
    return new Uint8Array(await this.file.slice(offset, offset + size).arrayBuffer());
  }

  async slice(offset, size) {
    if (!this.finalized) throw new Error('finalize() 후에 읽을 수 있습니다');
    return this.file.slice(offset, offset + size);
  }

  async dispose() {
    try { if (this.writable) await this.writable.abort(); } catch { /* 무시 */ }
    this.writable = null;
    this.file = null;
    try { await this.dir.removeEntry(this.name); } catch { /* 이미 없음 */ }
  }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// FileSink
// ---------------------------------------------------------------------------

/** 메모리 싱크 - 파트를 모아 Blob 생성 (폴백용) */
export class MemoryFileSink {
  constructor(mimeType) {
    this.mimeType = mimeType;
    this.parts = [];
    this.bytesWritten = 0;
    this.patches = [];
  }

  async write(data) {
    const part = data instanceof Blob ? data : toUint8(data).slice();
    this.parts.push(part);
    this.bytesWritten += part instanceof Blob ? part.size : part.length;
  }

  /** 지정 위치 덮어쓰기 (WAV 헤더 패치 등) - close 시 적용 */
  async writeAt(position, data) {
    this.patches.push({ position, data: toUint8(data).slice() });
  }

  async close() {
    if (this.patches.length === 0) return new Blob(this.parts, { type: this.mimeType });
    const whole = new Uint8Array(await new Blob(this.parts).arrayBuffer());
    for (const p of this.patches) whole.set(p.data, p.position);
    return new Blob([whole], { type: this.mimeType });
  }

  async abort() { this.parts = []; }
}

/** OPFS 싱크 - 최종 파일을 디스크에 순차 기록, close 시 디스크 기반 File 반환 */
export class OpfsFileSink {
  constructor(dir, name, mimeType) {
    this.dir = dir;
    this.name = name;
    this.mimeType = mimeType;
    this.bytesWritten = 0;
    this.writable = null;
  }

  async open() {
    if (this.writable) return;
    this.handle = await this.dir.getFileHandle(this.name, { create: true });
    this.writable = await this.handle.createWritable();
  }

  async write(data) {
    await this.open();
    const part = data instanceof Blob ? data : toUint8(data);
    await this.writable.write(part);
    this.bytesWritten += part instanceof Blob ? part.size : part.length;
  }

  async writeAt(position, data) {
    await this.open();
    await this.writable.write({ type: 'write', position, data: toUint8(data) });
    // position 쓰기 뒤에는 커서가 그 끝으로 이동하므로 다시 파일 끝으로
    await this.writable.seek(this.bytesWritten);
  }

  async close() {
    await this.open();
    await this.writable.close();
    this.writable = null;
    const file = await this.handle.getFile();
    // File의 type은 OPFS가 정하지 않으므로 MIME을 입힌 Blob 뷰로 감쌈 (데이터 복사 없음)
    return file.type === this.mimeType ? file : new File([file], this.name, { type: this.mimeType });
  }

  async abort() {
    try { if (this.writable) await this.writable.abort(); } catch { /* 무시 */ }
    this.writable = null;
  }
}

// ---------------------------------------------------------------------------
// Recording storage factory
// ---------------------------------------------------------------------------

/**
 * 녹화 세션용 저장소 팩토리. OPFS(navigator.storage)가 있으면 OPFS, 아니면 메모리.
 * @param {StorageManager|null} storageManager - navigator.storage (없으면 메모리)
 * @param {string} sessionId
 */
export async function createRecordingStorage(storageManager, sessionId) {
  if (storageManager && typeof storageManager.getDirectory === 'function') {
    try {
      const root = await storageManager.getDirectory();
      const base = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
      const dir = await base.getDirectoryHandle(sessionId, { create: true });
      return {
        kind: 'opfs',
        sessionId,
        createChunkStore: async (name, options) => new OpfsChunkStore(dir, name, options),
        createFileSink: async (name, mimeType) => new OpfsFileSink(dir, name, mimeType),
        dispose: async () => { try { await base.removeEntry(sessionId, { recursive: true }); } catch { /* 무시 */ } }
      };
    } catch (error) {
      console.warn('[Storage] OPFS 사용 불가, 메모리 저장소로 폴백:', error && error.message);
    }
  }
  return {
    kind: 'memory',
    sessionId,
    createChunkStore: async () => new MemoryChunkStore(),
    createFileSink: async (name, mimeType) => new MemoryFileSink(mimeType),
    dispose: async () => {}
  };
}

/**
 * 이전 녹화의 임시 파일 정리 (현재 세션 제외). 삭제한 디렉토리 수 반환
 */
export async function cleanupStaleRecordings(storageManager, currentSessionId = null) {
  if (!storageManager || typeof storageManager.getDirectory !== 'function') return 0;
  let removed = 0;
  try {
    const root = await storageManager.getDirectory();
    const base = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
    const names = [];
    for await (const name of base.keys()) names.push(name);
    for (const name of names) {
      if (name === currentSessionId) continue;
      try { await base.removeEntry(name, { recursive: true }); removed++; } catch (error) { console.warn('[Storage] 임시 파일 삭제 실패:', name, error); }
    }
  } catch (error) {
    console.warn('[Storage] 임시 파일 정리 실패:', error && error.message);
  }
  return removed;
}
