import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatchWriter, SequentialReader } from '../muxers/batch-io.js';
import { MemoryChunkStore } from '../storage/chunk-store.js';

class CountingSink {
  constructor() { this.writes = []; }
  async write(d) { this.writes.push(d instanceof Blob ? d : new Blob([d])); }
}

test('BatchWriter는 작은 조각들을 모아 maxBytes마다 하나의 Blob으로 쓴다', async () => {
  const sink = new CountingSink();
  const w = new BatchWriter(sink, { maxBytes: 100, maxParts: 1000 });
  for (let i = 0; i < 25; i++) await w.add(new Uint8Array(10).fill(i)); // 250바이트
  await w.flush();
  assert.equal(sink.writes.length, 3, `writes=${sink.writes.length}`); // 100 + 100 + 50
  const all = new Uint8Array(await new Blob(sink.writes).arrayBuffer());
  assert.equal(all.length, 250);
  assert.equal(all[0], 0);
  assert.equal(all[249], 24);
});

test('BatchWriter는 고정 크기 버퍼에 복사해 쓰므로 조각이 버퍼보다 커도 순서대로 나눠 쓴다', async () => {
  const sink = new CountingSink();
  const w = new BatchWriter(sink, { maxBytes: 4 });
  await w.add(new Uint8Array([1]));
  await w.add(new Uint8Array([2, 3, 4, 5, 6, 7]));
  await w.add(new Uint8Array([8]));
  await w.flush();
  assert.deepEqual(Array.from(new Uint8Array(await new Blob(sink.writes).arrayBuffer())), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(sink.writes.every(b => b.size <= 4), '각 쓰기는 버퍼 크기 이하');
  assert.equal(w.bytesWritten, 8);
});

test('BatchWriter는 Blob 조각을 받지 않는다 (브라우저 Blob 참조 누적 방지)', async () => {
  const w = new BatchWriter(new CountingSink());
  await assert.rejects(() => w.add(new Blob([new Uint8Array([1])])), /Uint8Array/);
});

test('BatchWriter는 빈 조각을 무시하고 버퍼가 비어 있으면 flush가 쓰지 않는다', async () => {
  const sink = new CountingSink();
  const w = new BatchWriter(sink);
  await w.add(new Uint8Array(0));
  await w.flush();
  assert.equal(sink.writes.length, 0);
});

test('SequentialReader는 순차 읽기를 큰 창(window) 단위로 묶어 저장소 읽기 횟수를 줄인다', async () => {
  const store = new MemoryChunkStore();
  for (let i = 0; i < 100; i++) store.append(new Uint8Array(10).fill(i));
  await store.finalize();
  let reads = 0;
  const orig = store.readRange.bind(store);
  store.readRange = (o, s) => { reads++; return orig(o, s); };
  const origInto = store.readInto.bind(store);
  store.readInto = (o, s, b) => { reads++; return origInto(o, s, b); };
  const reader = new SequentialReader(store, { windowBytes: 300 });
  for (let i = 0; i < 100; i++) {
    const b = await reader.read(i * 10, 10);
    assert.equal(b.length, 10);
    assert.equal(b[0], i);
  }
  assert.ok(reads <= 4, `reads=${reads}`); // 1000바이트 / 300 → 4회
});

test('SequentialReader는 창보다 큰 요청과 뒤로 가는 요청도 올바르게 처리한다', async () => {
  const store = new MemoryChunkStore();
  store.append(new Uint8Array(1000).map((_, i) => i % 256));
  await store.finalize();
  const reader = new SequentialReader(store, { windowBytes: 100 });
  const big = await reader.read(50, 500);
  assert.equal(big.length, 500);
  assert.equal(big[0], 50);
  const back = await reader.read(10, 5);
  assert.deepEqual(Array.from(back), [10, 11, 12, 13, 14]);
});

test('BatchWriter는 고정 버퍼 하나만 쓴다: 모든 flush가 같은 ArrayBuffer의 뷰를 넘기고(복사 없음) 싱크 쓰기가 끝난 뒤 재사용한다', async () => {
  const seen = [];
  let pending = 0, maxPending = 0;
  const sink = { async write(d) { pending++; maxPending = Math.max(maxPending, pending); seen.push({ buffer: d.buffer, first: d[0], length: d.length }); await new Promise(r => setTimeout(r, 1)); pending--; } };
  const w = new BatchWriter(sink, { maxBytes: 16 });
  for (let i = 0; i < 10; i++) await w.add(new Uint8Array(5).fill(i));
  await w.flush();
  assert.equal(seen.length, 4, '50바이트 / 16');
  assert.ok(seen.every(x => x.buffer === seen[0].buffer), 'flush마다 새 버퍼를 만들지 않음');
  assert.equal(maxPending, 1, '이전 쓰기가 끝나야 다음 flush (버퍼 재사용 안전, 쓰기 속도에 맞춰 진행)');
  assert.deepEqual(seen.map(x => x.first), [0, 3, 6, 9]);
});

/** BYOB 읽기처럼 넘겨받은 ArrayBuffer를 transfer(detach)하고 같은 메모리를 새 ArrayBuffer 객체로 돌려주는 저장소 */
class TransferringStore {
  constructor(bytes) { this.bytes = bytes; this.size = bytes.length; this.calls = []; this.readRangeCalls = 0; }
  async readRange() { this.readRangeCalls++; throw new Error('readInto가 있으면 readRange를 쓰지 않아야 함'); }
  async readInto(offset, size, buffer) {
    this.calls.push({ offset, size, buffer, byteLength: buffer ? buffer.byteLength : 0 });
    if (!buffer || buffer.byteLength < size) buffer = new ArrayBuffer(size);
    const moved = buffer.transfer(); // 넘겨받은 버퍼는 detach됨
    const view = new Uint8Array(moved, 0, size);
    view.set(this.bytes.subarray(offset, offset + size));
    return view;
  }
}

test('SequentialReader는 창 버퍼를 한 번만 잡고 readInto로 같은 메모리에 다시 채운다 (창마다 새 ArrayBuffer 없음, transfer된 버퍼 이어받기)', async () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 251);
  const store = new TransferringStore(bytes);
  const reader = new SequentialReader(store, { windowBytes: 100 });
  for (let off = 0; off < 1000; off += 10) {
    const v = await reader.read(off, 10);
    assert.equal(v[0], off % 251);
  }
  assert.equal(store.readRangeCalls, 0);
  assert.equal(store.calls.length, 10, '1000바이트 / 창 100');
  assert.equal(store.calls[0].buffer, null, '첫 읽기에서만 버퍼 할당');
  assert.ok(store.calls.slice(1).every(c => c.buffer && c.byteLength === 100), '이후에는 이전 읽기의 (transfer된) 버퍼를 넘김');
});

test('SequentialReader는 창보다 큰 샘플이 오면 그 크기로 버퍼를 다시 잡고, readInto가 없는 저장소는 readRange로 읽는다', async () => {
  const bytes = new Uint8Array(500).map((_, i) => i % 256);
  const store = new TransferringStore(bytes);
  const reader = new SequentialReader(store, { windowBytes: 50 });
  assert.equal((await reader.read(0, 10))[9], 9);
  const big = await reader.read(10, 200);
  assert.equal(big.length, 200);
  assert.equal(big[0], 10);
  assert.equal(store.calls[1].byteLength, 50, '이전 창 버퍼(50)를 넘겼고 저장소가 더 큰 버퍼를 만듦');
  assert.equal((await reader.read(210, 5))[0], 210);
  assert.equal(store.calls[2].byteLength, 200, '커진 버퍼를 계속 재사용');

  const legacy = new MemoryChunkStore();
  legacy.append(bytes);
  await legacy.finalize();
  legacy.readInto = undefined;
  let ranges = 0;
  const orig = legacy.readRange.bind(legacy);
  legacy.readRange = (o, s) => { ranges++; return orig(o, s); };
  const r2 = new SequentialReader(legacy, { windowBytes: 100 });
  assert.equal((await r2.read(120, 3))[0], 120);
  assert.equal(ranges, 1);
});
