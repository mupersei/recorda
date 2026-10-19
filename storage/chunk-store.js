// Chunk Store / File Sink - 녹화 데이터를 메모리 대신 디스크(OPFS)에 두기 위한 저장소 추상화
//
// - ChunkStore: 녹화 중 인코딩된 청크를 append하고(오프셋 반환), finalize 후 임의 구간을 읽습니다.
// - FileSink:   최종 파일을 순서대로 써 내려가고 close 시 Blob(File)을 돌려줍니다.
//   DirectoryFileSink는 OPFS 디렉토리뿐 아니라 사용자가 고른 폴더(File System Access API 핸들)에도 그대로 씁니다.
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
    const size = toUint8(data).length;
    return { offset: this.appendBytes(data), size };
  }

  /** append와 같지만 참조 객체 없이 오프셋만 반환 (샘플마다 객체를 만들지 않는 SampleIndex 경로용) */
  appendBytes(data) {
    const bytes = toUint8(data);
    const offset = this.size;
    this.chunks.push(bytes);
    this.size += bytes.length;
    return offset;
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

  /** readRange와 같은 구간을 호출자 버퍼에 복사 (OpfsChunkStore.readInto와 같은 계약) */
  async readInto(offset, size, buffer) {
    if (!this.finalized) throw new Error('finalize() 후에 읽을 수 있습니다');
    if (!buffer || buffer.byteLength < size) buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer, 0, size);
    view.set(this.merged.subarray(offset, offset + size));
    return view;
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

/**
 * OPFS 저장소 - 청크를 디스크 파일에 append. createWritable()은 close 전까지 내용이 보이지 않으므로 finalize 후 읽기.
 * append는 고정 크기 버퍼 두 개(쓰는 중 / 모으는 중)에 바로 복사해 모았다가 버퍼가 차면 씁니다. 청크마다 복사본을 만들거나
 * flush마다 병합 버퍼를 새로 만들지 않으므로 장시간 녹화에서도 메모리 할당이 늘지 않습니다.
 */
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
    this.current = null;   // 모으는 중인 버퍼 (첫 append 때 할당)
    this.spare = null;     // 쓰기가 끝나 재사용할 수 있는 버퍼
    this.used = 0;
    this.writeQueue = Promise.resolve();
    this.writable = null;
    this.file = null;
    this.error = null;
    this.readMode = undefined; // 'byob' | 'arrayBuffer' (readInto 첫 호출 때 결정)
  }

  get kind() { return 'opfs'; }
  get retainedBytes() { return this.used; }

  async open() {
    if (this.writable) return;
    const handle = await this.dir.getFileHandle(this.name, { create: true });
    this.handle = handle;
    this.writable = await handle.createWritable();
  }

  append(data) {
    const size = toUint8(data).length;
    return { offset: this.appendBytes(data), size };
  }

  /** append와 같지만 참조 객체 없이 오프셋만 반환 (SampleIndex 경로용) */
  appendBytes(data) {
    if (this.finalized) throw new Error('finalize된 저장소에는 추가할 수 없습니다');
    const bytes = toUint8(data);
    const offset = this.size;
    this.size += bytes.length;
    if (bytes.length >= this.bufferBytes) {
      // 버퍼보다 큰 청크: 모아 둔 것을 먼저 쓰고(순서 유지) 이 청크는 따로 씀 (호출자가 재사용할 수 있으므로 복사)
      this.flush();
      this.enqueueWrite(bytes.slice(), null);
      return offset;
    }
    if (this.current && this.used + bytes.length > this.current.length) this.flush();
    if (!this.current) this.current = this.takeBuffer();
    this.current.set(bytes, this.used);
    this.used += bytes.length;
    if (this.used >= this.bufferBytes) this.flush();
    return offset;
  }

  takeBuffer() {
    const buffer = this.spare || new Uint8Array(this.bufferBytes);
    this.spare = null;
    return buffer;
  }

  /** 모은 버퍼를 디스크에 기록 (순서 보장을 위해 큐로 직렬화). 쓰기가 끝난 버퍼는 다음 모으기에 재사용 */
  flush() {
    if (!this.current || this.used === 0) return this.writeQueue;
    const buffer = this.current;
    const length = this.used;
    this.current = null;
    this.used = 0;
    return this.enqueueWrite(buffer.subarray(0, length), buffer);
  }

  enqueueWrite(bytes, reusable) {
    this.writeQueue = this.writeQueue.then(async () => {
      await this.open();
      await this.writable.write(bytes);
    }).catch((error) => {
      console.error('[OpfsChunkStore] 쓰기 실패:', this.name, error);
      this.error = this.error || error;
    }).then(() => {
      // 쓰기가 끝났으므로(실패 포함) 이 버퍼는 다시 써도 됨
      if (reusable && !this.spare && reusable !== this.current) this.spare = reusable;
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
    this.current = null;
    this.spare = null;
    this.file = await this.handle.getFile();
    this.finalized = true;
  }

  async readRange(offset, size) {
    if (!this.finalized) throw new Error('finalize() 후에 읽을 수 있습니다');
    return new Uint8Array(await this.file.slice(offset, offset + size).arrayBuffer());
  }

  /**
   * [offset, offset+size) 구간을 호출자의 버퍼(ArrayBuffer)에 읽어 넣습니다 (머싱의 순차 읽기 창 재사용용).
   * 바이트 스트림 BYOB 리더를 쓸 수 있으면 같은 메모리에 바로 채웁니다(창마다 새 ArrayBuffer를 만들지 않음).
   * BYOB 읽기는 버퍼를 transfer하므로 돌려준 뷰의 .buffer를 다음 호출에 넘겨야 합니다 (넘긴 버퍼는 detach될 수 있음).
   * @returns {Promise<Uint8Array>} 길이 size인 뷰
   */
  async readInto(offset, size, buffer) {
    if (!this.finalized) throw new Error('finalize() 후에 읽을 수 있습니다');
    if (!buffer || buffer.byteLength < size) buffer = new ArrayBuffer(size);
    if (this.readMode !== 'arrayBuffer') {
      const blob = this.file.slice(offset, offset + size);
      let reader = null;
      try {
        reader = typeof blob.stream === 'function' ? blob.stream().getReader({ mode: 'byob' }) : null;
      } catch {
        reader = null; // 바이트 스트림 미지원 (구형 브라우저)
      }
      if (reader) {
        this.readMode = 'byob';
        try {
          let filled = 0;
          while (filled < size) {
            const { value, done } = await reader.read(new Uint8Array(buffer, filled, size - filled));
            if (done || !value) break;
            buffer = value.buffer;
            filled += value.byteLength;
          }
          if (filled !== size) throw new Error(`저장소 읽기 길이 부족: ${filled} / ${size}`);
          return new Uint8Array(buffer, 0, size);
        } finally {
          try { reader.releaseLock(); } catch { /* 무시 */ }
        }
      }
      this.readMode = 'arrayBuffer';
    }
    // 폴백: 새 ArrayBuffer로 읽어 호출자 버퍼에 복사 (임시 버퍼는 바로 버림)
    const view = new Uint8Array(buffer, 0, size);
    view.set(new Uint8Array(await this.file.slice(offset, offset + size).arrayBuffer()));
    return view;
  }

  async slice(offset, size) {
    if (!this.finalized) throw new Error('finalize() 후에 읽을 수 있습니다');
    return this.file.slice(offset, offset + size);
  }

  async dispose() {
    try { if (this.writable) await this.writable.abort(); } catch { /* 무시 */ }
    this.writable = null;
    this.file = null;
    this.current = null;
    this.spare = null;
    try { await this.dir.removeEntry(this.name); } catch { /* 이미 없음 */ }
  }
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

/**
 * 디렉토리 싱크 - 최종 파일을 디스크에 순차 기록, close 시 디스크 기반 File 반환.
 * FileSystemDirectoryHandle이면 어디든 동작합니다: OPFS 세션 디렉토리(종료 후 다운로드) 또는
 * 사용자가 설정 페이지에서 고른 폴더(직접 저장, 다운로드 복사 없음).
 * createWritable()은 close 전까지 같은 폴더의 스왑 파일(.crswap)에 쓰고 close 시 원자적으로 교체합니다.
 */
export class DirectoryFileSink {
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

  /**
   * 쓰기 취소 (스왑 파일 폐기).
   * @param {{remove?: boolean}} [options] - remove: getFileHandle(create)로 만들어진 대상 파일도 지움 (사용자 폴더에 빈 파일을 남기지 않도록)
   */
  async abort({ remove = false } = {}) {
    try { if (this.writable) await this.writable.abort(); } catch { /* 무시 */ }
    this.writable = null;
    if (remove) {
      try { await this.dir.removeEntry(this.name); } catch { /* 이미 없음 또는 권한 없음 */ }
    }
  }
}

/** 호환용 별칭 (OPFS 세션 디렉토리에 쓰던 기존 이름) */
export const OpfsFileSink = DirectoryFileSink;

/**
 * 이중 기록 싱크 - 주 싱크(사용자가 고른 폴더)에 쓰면서 같은 내용을 예비 싱크(OPFS)에도 씁니다.
 * 녹화 중 주 싱크가 실패하면(권한 회수, 드라이브 분리, 디스크 부족 등) 이후로는 예비 싱크에만 쓰고,
 * close 시 처음부터 온전한 예비 파일을 돌려줍니다 (failedOver = true → 호출자가 다운로드로 저장).
 * 주 싱크가 끝까지 성공하면 예비 파일은 폐기합니다. 녹화 중 오디오 파일처럼 다시 만들 수 없는 출력에 사용합니다.
 */
export class FailoverFileSink {
  constructor(primary, backup) {
    this.primary = primary;
    this.backup = backup;
    this.name = primary.name;
    this.mimeType = primary.mimeType;
    this.bytesWritten = 0;
    this.primaryError = null;
    this.backupError = null;
    this.failedOver = false;
  }

  markPrimaryFailed(error) {
    if (this.primaryError) return;
    this.primaryError = error || new Error('주 싱크 기록 실패');
    console.warn('[FailoverFileSink] 주 싱크 기록 실패 → 예비 싱크로 계속 기록:', this.primary.name, error && error.message);
  }

  markBackupFailed(error) {
    if (this.backupError) return;
    this.backupError = error || new Error('예비 싱크 기록 실패');
    console.warn('[FailoverFileSink] 예비 싱크 기록 실패 (주 싱크만 사용):', error && error.message);
  }

  /** 살아 있는 싱크 모두에 같은 작업 (둘 다 실패하면 오류) */
  async runOnBoth(op) {
    const tasks = [];
    if (!this.primaryError) tasks.push(Promise.resolve().then(() => op(this.primary)).catch((error) => this.markPrimaryFailed(error)));
    if (!this.backupError) tasks.push(Promise.resolve().then(() => op(this.backup)).catch((error) => this.markBackupFailed(error)));
    await Promise.all(tasks);
    if (this.primaryError && this.backupError) throw this.primaryError;
  }

  async write(data) {
    const size = data instanceof Blob ? data.size : toUint8(data).length;
    await this.runOnBoth((sink) => sink.write(data));
    this.bytesWritten += size;
  }

  async writeAt(position, data) {
    await this.runOnBoth((sink) => sink.writeAt(position, data));
  }

  async close() {
    if (!this.primaryError) {
      try {
        const file = await this.primary.close();
        try { await this.backup.abort(); } catch { /* 무시 */ }
        return file;
      } catch (error) {
        this.markPrimaryFailed(error);
      }
    }
    this.failedOver = true;
    try { await this.primary.abort({ remove: true }); } catch { /* 무시 */ }
    if (this.backupError) throw this.primaryError;
    return this.backup.close();
  }

  async abort(options) {
    try { await this.primary.abort(options); } catch { /* 무시 */ }
    try { await this.backup.abort(); } catch { /* 무시 */ }
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
        createFileSink: async (name, mimeType) => new DirectoryFileSink(dir, name, mimeType),
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
