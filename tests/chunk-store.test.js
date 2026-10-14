import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryChunkStore, OpfsChunkStore, MemoryFileSink, OpfsFileSink, createRecordingStorage, cleanupStaleRecordings, OPFS_ROOT_DIR } from '../storage/chunk-store.js';
import { FakeDirectoryHandle } from './helpers/fake-opfs.js';

const bytes = (...xs) => new Uint8Array(xs);
const concat = (arrs) => { const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

for (const [name, make] of [
  ['MemoryChunkStore', () => new MemoryChunkStore()],
  ['OpfsChunkStore', () => new OpfsChunkStore(new FakeDirectoryHandle(), 'video.bin', { bufferBytes: 8 })]
]) {
  test(`${name}: append는 연속 오프셋을 돌려주고 finalize 후 readRange로 임의 구간을 읽는다`, async () => {
    const store = make();
    const r1 = store.append(bytes(1, 2, 3));
    const r2 = store.append(bytes(4, 5));
    const r3 = store.append(bytes(6, 7, 8, 9, 10, 11));
    assert.deepEqual([r1, r2, r3], [{ offset: 0, size: 3 }, { offset: 3, size: 2 }, { offset: 5, size: 6 }]);
    assert.equal(store.size, 11);
    await store.finalize();
    assert.deepEqual(Array.from(await store.readRange(3, 2)), [4, 5]);
    assert.deepEqual(Array.from(await store.readRange(0, 11)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(Array.from(await store.readRange(9, 2)), [10, 11]);
  });

  test(`${name}: slice는 복사 없이 Blob 조각을 돌려준다 (출력 싱크에 그대로 쓸 수 있음)`, async () => {
    const store = make();
    store.append(bytes(1, 2, 3, 4));
    await store.finalize();
    const blob = await store.slice(1, 2);
    assert.ok(blob instanceof Blob);
    assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [2, 3]);
  });

  test(`${name}: 메모리 보유량(retainedBytes)은 finalize 전 버퍼 크기 이하로 유지된다`, async () => {
    const store = make();
    for (let i = 0; i < 100; i++) store.append(new Uint8Array(1000));
    if (name === 'OpfsChunkStore') {
      assert.ok(store.retainedBytes <= 8 + 1000, `OPFS 저장소는 버퍼만 보유: ${store.retainedBytes}`);
    } else {
      assert.equal(store.retainedBytes, 100_000, '메모리 저장소는 전부 보유');
    }
    await store.finalize();
    assert.equal(store.size, 100_000);
  });
}

test('OpfsChunkStore: 작은 append들은 버퍼에 모아 한 번에 쓰고, finalize가 잔여 버퍼를 비운 뒤 파일을 닫는다', async () => {
  const root = new FakeDirectoryHandle();
  const store = new OpfsChunkStore(root, 'a.bin', { bufferBytes: 10 });
  for (let i = 0; i < 7; i++) store.append(bytes(i, i, i)); // 21바이트
  await store.flush();
  const handle = await root.getFileHandle('a.bin');
  assert.ok(handle.writables[0].writes <= 3, `쓰기 횟수 ${handle.writables[0].writes} (버퍼링되어야 함)`);
  await store.finalize();
  assert.equal(handle.writables[0].closed, true);
  const file = await handle.getFile();
  assert.equal(file.size, 21);
  assert.deepEqual(Array.from(await store.readRange(18, 3)), [6, 6, 6]);
});

test('OpfsChunkStore: finalize 전에는 readRange가 거부되고, dispose는 파일을 삭제한다', async () => {
  const root = new FakeDirectoryHandle();
  const store = new OpfsChunkStore(root, 'b.bin');
  store.append(bytes(1));
  await assert.rejects(() => store.readRange(0, 1), /finalize/);
  await store.finalize();
  await store.dispose();
  await assert.rejects(() => root.getFileHandle('b.bin'), /not found/);
});

test('MemoryFileSink: write한 바이트/Blob을 순서대로 이어붙인 Blob을 돌려준다', async () => {
  const sink = new MemoryFileSink('video/mp4');
  await sink.write(bytes(1, 2));
  await sink.write(new Blob([bytes(3)]));
  await sink.write(bytes(4));
  const blob = await sink.close();
  assert.equal(blob.type, 'video/mp4');
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [1, 2, 3, 4]);
  assert.equal(sink.bytesWritten, 4);
});

test('OpfsFileSink: OPFS 파일에 스트리밍으로 쓰고 close 시 디스크 기반 File을 돌려준다 (position 지정 쓰기 지원)', async () => {
  const root = new FakeDirectoryHandle();
  const sink = new OpfsFileSink(root, 'out.wav', 'audio/wav');
  await sink.write(new Uint8Array(44)); // 헤더 자리
  await sink.write(bytes(9, 9, 9, 9));
  await sink.writeAt(0, bytes(82, 73, 70, 70)); // 'RIFF' 패치
  const file = await sink.close();
  assert.ok(file instanceof Blob);
  assert.equal(file.type, 'audio/wav');
  assert.equal(file.size, 48);
  const u8 = new Uint8Array(await file.arrayBuffer());
  assert.deepEqual(Array.from(u8.slice(0, 4)), [82, 73, 70, 70]);
  assert.deepEqual(Array.from(u8.slice(44)), [9, 9, 9, 9]);
});

test('createRecordingStorage: OPFS가 있으면 세션 디렉토리 아래에 OPFS 저장소를, 없으면 메모리 저장소를 만든다', async () => {
  const root = new FakeDirectoryHandle();
  const opfs = await createRecordingStorage({ getDirectory: async () => root }, 'sess-1');
  assert.equal(opfs.kind, 'opfs');
  const store = await opfs.createChunkStore('video.bin');
  assert.ok(store instanceof OpfsChunkStore);
  const sink = await opfs.createFileSink('out.mp4', 'video/mp4');
  assert.ok(sink instanceof OpfsFileSink);
  const sessions = await root.getDirectoryHandle(OPFS_ROOT_DIR);
  await sessions.getDirectoryHandle('sess-1'); // 존재

  const mem = await createRecordingStorage(null, 'sess-2');
  assert.equal(mem.kind, 'memory');
  assert.ok((await mem.createChunkStore('x')) instanceof MemoryChunkStore);
  assert.ok((await mem.createFileSink('x', 'audio/mpeg')) instanceof MemoryFileSink);
});

test('createRecordingStorage: OPFS 초기화가 실패하면 메모리 저장소로 폴백한다', async () => {
  const broken = { getDirectory: async () => { throw new Error('quota'); } };
  const s = await createRecordingStorage(broken, 'sess-3');
  assert.equal(s.kind, 'memory');
});

test('cleanupStaleRecordings: 이전 세션 디렉토리를 모두 삭제하되 현재 세션은 남긴다', async () => {
  const root = new FakeDirectoryHandle();
  const base = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
  await base.getDirectoryHandle('old-1', { create: true });
  await base.getDirectoryHandle('old-2', { create: true });
  await base.getDirectoryHandle('current', { create: true });
  const removed = await cleanupStaleRecordings({ getDirectory: async () => root }, 'current');
  assert.equal(removed, 2);
  const left = [];
  for await (const k of base.keys()) left.push(k);
  assert.deepEqual(left, ['current']);
});
