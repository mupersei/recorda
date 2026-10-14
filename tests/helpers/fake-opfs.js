// Origin Private File System(OPFS) 가짜 구현 - navigator.storage.getDirectory() 와 FileSystemDirectoryHandle 흉내
// createWritable()의 "close() 전까지 내용이 보이지 않는" 의미(스왑 파일)와 position 쓰기를 재현합니다.

class FakeWritable {
  constructor(file) { this.file = file; this.buffer = new Uint8Array(0); this.pos = 0; this.closed = false; this.writes = 0; }
  async write(data) {
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
  async close() { this.closed = true; this.file.content = this.buffer; }
  async abort() { this.closed = true; }
}

class FakeFileHandle {
  constructor(name) { this.name = name; this.kind = 'file'; this.content = new Uint8Array(0); this.writables = []; }
  async createWritable({ keepExistingData = false } = {}) {
    const w = new FakeWritable(this);
    if (keepExistingData) { w.buffer = this.content.slice(); }
    this.writables.push(w);
    return w;
  }
  async getFile() { return new File([this.content], this.name); }
}

export class FakeDirectoryHandle {
  constructor(name = 'root') { this.name = name; this.kind = 'directory'; this.entries = new Map(); }
  async getDirectoryHandle(name, { create = false } = {}) {
    let d = this.entries.get(name);
    if (!d) { if (!create) throw new DOMException('not found', 'NotFoundError'); d = new FakeDirectoryHandle(name); this.entries.set(name, d); }
    if (d.kind !== 'directory') throw new DOMException('mismatch', 'TypeMismatchError');
    return d;
  }
  async getFileHandle(name, { create = false } = {}) {
    let f = this.entries.get(name);
    if (!f) { if (!create) throw new DOMException('not found', 'NotFoundError'); f = new FakeFileHandle(name); this.entries.set(name, f); }
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
