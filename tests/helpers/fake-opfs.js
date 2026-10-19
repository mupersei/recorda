// Origin Private File System(OPFS) 가짜 구현 - navigator.storage.getDirectory() 와 FileSystemDirectoryHandle 흉내
// createWritable()의 "close() 전까지 내용이 보이지 않는" 의미(스왑 파일)와 position 쓰기를 재현합니다.
// 사용자가 고른 폴더(File System Access API) 흉내용으로 권한 상태(queryPermission/requestPermission)와
// 오류 주입(dir.faults: createWritable / failWritesAfter / close)도 지원합니다.

function notAllowed(message = '권한이 없습니다') { return new DOMException(message, 'NotAllowedError'); }

class FakeWritable {
  constructor(file) { this.file = file; this.buffer = new Uint8Array(0); this.pos = 0; this.closed = false; this.aborted = false; this.writes = 0; }
  async write(data) {
    const faults = this.file.parent && this.file.parent.faults;
    if (faults && typeof faults.failWritesAfter === 'number') {
      // 디렉토리 전체에서 허용된 쓰기 횟수를 다 쓰면 권한 회수처럼 실패
      if (faults.failWritesAfter <= 0) throw notAllowed('쓰기 권한이 회수되었습니다');
      faults.failWritesAfter--;
    }
    this.writes++;
    let bytes, position = this.pos;
    if (data && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && !(data instanceof Blob) && 'type' in data) {
      if (data.type === 'seek') { this.pos = data.position; return; }
      if (data.type === 'truncate') { this.buffer = this.buffer.slice(0, data.size); return; }
      if (typeof data.position === 'number') position = data.position;
      data = data.data;
    }
    if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const end = position + bytes.length;
    if (end > this.buffer.length) { const next = new Uint8Array(end); next.set(this.buffer); this.buffer = next; }
    this.buffer.set(bytes, position);
    this.pos = end;
  }
  async seek(position) { this.pos = position; }
  async truncate(size) { this.buffer = this.buffer.slice(0, size); }
  async close() {
    const faults = this.file.parent && this.file.parent.faults;
    if (faults && faults.close) throw faults.close;
    this.closed = true; this.file.content = this.buffer;
  }
  async abort() { this.closed = true; this.aborted = true; }
}

class FakeFileHandle {
  constructor(name, parent = null) { this.name = name; this.kind = 'file'; this.parent = parent; this.content = new Uint8Array(0); this.writables = []; }
  async createWritable({ keepExistingData = false } = {}) {
    const faults = this.parent && this.parent.faults;
    if (faults && faults.createWritable) throw faults.createWritable;
    const w = new FakeWritable(this);
    if (keepExistingData) { w.buffer = this.content.slice(); }
    this.writables.push(w);
    return w;
  }
  async getFile() { return new File([this.content], this.name); }
}

export class FakeDirectoryHandle {
  constructor(name = 'root', { permission = 'granted' } = {}) {
    this.name = name; this.kind = 'directory'; this.entries = new Map();
    this.permission = permission;        // queryPermission 결과 ('granted' | 'prompt' | 'denied')
    this.requestPermissionResult = null; // requestPermission 결과 (null이면 permission 그대로)
    this.permissionRequests = [];
    this.faults = null;                  // { createWritable: Error, failWritesAfter: number, close: Error }
  }
  async queryPermission() { return this.permission; }
  async requestPermission(descriptor) {
    this.permissionRequests.push(descriptor);
    if (this.requestPermissionResult) this.permission = this.requestPermissionResult;
    return this.permission;
  }
  /** 테스트 검사용: 파일 이름 목록 */
  fileNames() { return [...this.entries.values()].filter(e => e.kind === 'file').map(e => e.name).sort(); }
  async getDirectoryHandle(name, { create = false } = {}) {
    let d = this.entries.get(name);
    if (!d) { if (!create) throw new DOMException('not found', 'NotFoundError'); d = new FakeDirectoryHandle(name); this.entries.set(name, d); }
    if (d.kind !== 'directory') throw new DOMException('mismatch', 'TypeMismatchError');
    return d;
  }
  async getFileHandle(name, { create = false } = {}) {
    let f = this.entries.get(name);
    if (!f) { if (!create) throw new DOMException('not found', 'NotFoundError'); f = new FakeFileHandle(name, this); this.entries.set(name, f); }
    if (f.kind !== 'file') throw new DOMException('mismatch', 'TypeMismatchError');
    return f;
  }
  async removeEntry(name, { recursive = false } = {}) {
    const e = this.entries.get(name);
    if (!e) throw new DOMException('not found', 'NotFoundError');
    if (e.kind === 'directory' && e.entries.size > 0 && !recursive) throw new DOMException('not empty', 'InvalidModificationError');
    this.entries.delete(name);
  }
  async *keys() { for (const k of this.entries.keys()) yield k; }
  async *entries_() { for (const e of this.entries) yield e; }
  async *[Symbol.asyncIterator]() { for (const e of this.entries) yield e; }
}

/** navigator.storage.getDirectory()를 가짜로 설치하고 루트 핸들을 반환 */
export function installFakeOpfs() {
  const root = new FakeDirectoryHandle();
  const storage = { getDirectory: async () => root, estimate: async () => ({ quota: 1e12, usage: 0 }) };
  const nav = globalThis.navigator && Object.getOwnPropertyDescriptor(globalThis, 'navigator')?.configurable !== false ? globalThis.navigator : null;
  const target = nav && typeof nav === 'object' ? nav : {};
  try {
    Object.defineProperty(target, 'storage', { configurable: true, value: storage });
    if (target !== globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: target });
  } catch {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { ...(globalThis.navigator || {}), storage } });
  }
  return root;
}
