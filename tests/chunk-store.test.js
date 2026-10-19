import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryChunkStore, OpfsChunkStore, MemoryFileSink, OpfsFileSink, DirectoryFileSink, FailoverFileSink, createRecordingStorage, cleanupStaleRecordings, OPFS_ROOT_DIR } from '../storage/chunk-store.js';
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

  test(`${name}: appendBytes는 참조 객체 없이 오프셋(숫자)만 돌려주고 append와 같은 위치에 쌓는다`, async () => {
    const store = make();
    assert.equal(store.appendBytes(bytes(1, 2, 3)), 0);
    assert.deepEqual(store.append(bytes(4, 5)), { offset: 3, size: 2 });
    assert.equal(store.appendBytes(bytes(6)), 5);
    assert.equal(store.size, 6);
    await store.finalize();
    assert.deepEqual(Array.from(await store.readRange(0, 6)), [1, 2, 3, 4, 5, 6]);
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

// ---- 사용자 폴더 직접 기록 (File System Access API 디렉토리 핸들) ----
const readAll = async (blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));

test('DirectoryFileSink는 OPFS뿐 아니라 임의의 디렉토리 핸들(사용자 폴더)에 기록한다 (OpfsFileSink는 호환용 별칭)', async () => {
  assert.equal(OpfsFileSink, DirectoryFileSink);
  const userDir = new FakeDirectoryHandle('Recordings');
  const sink = new DirectoryFileSink(userDir, 'recorda_1.wav', 'audio/wav');
  await sink.open(); // 권한 확인을 위해 미리 열 수 있음 (createWritable)
  await sink.write(bytes(1, 2, 3));
  await sink.writeAt(0, bytes(9));
  const file = await sink.close();
  assert.equal(file.type, 'audio/wav');
  assert.deepEqual(await readAll(file), [9, 2, 3]);
  assert.deepEqual(userDir.fileNames(), ['recorda_1.wav']);
});

test('DirectoryFileSink.open은 쓰기 권한이 없으면(createWritable 실패) 오류를 던지고, abort({ remove: true })는 만들어진 빈 파일을 지운다', async () => {
  const userDir = new FakeDirectoryHandle('Recordings');
  userDir.faults = { createWritable: new DOMException('denied', 'NotAllowedError') };
  const sink = new DirectoryFileSink(userDir, 'recorda_2.mp4', 'video/mp4');
  await assert.rejects(() => sink.open(), /denied/);
  assert.deepEqual(userDir.fileNames(), ['recorda_2.mp4'], 'getFileHandle(create)가 빈 파일을 만듦');
  await sink.abort({ remove: true });
  assert.deepEqual(userDir.fileNames(), [], '빈 파일 정리');

  // 기본 abort는 파일을 남김 (OPFS 임시 파일은 세션 정리로 지움)
  const ok = new FakeDirectoryHandle('ok');
  const s2 = new DirectoryFileSink(ok, 'x.bin', 'application/octet-stream');
  await s2.write(bytes(1));
  await s2.abort();
  assert.deepEqual(ok.fileNames(), ['x.bin']);
});

test('FailoverFileSink: 주 싱크(사용자 폴더)와 예비 싱크(OPFS)에 같은 내용을 쓰고, 성공하면 주 싱크 파일을 돌려주며 예비 파일은 버린다', async () => {
  const userDir = new FakeDirectoryHandle('Recordings');
  const opfs = new FakeDirectoryHandle('session');
  const primary = new DirectoryFileSink(userDir, 'recorda_3.wav', 'audio/wav');
  const backup = new DirectoryFileSink(opfs, 'audio.wav', 'audio/wav');
  const sink = new FailoverFileSink(primary, backup);
  await sink.write(new Uint8Array(4));
  await sink.write(bytes(5, 6));
  await sink.writeAt(0, bytes(7, 7, 7, 7));
  const file = await sink.close();
  assert.equal(sink.failedOver, false);
  assert.equal(sink.primaryError, null);
  assert.equal(sink.bytesWritten, 6);
  assert.deepEqual(await readAll(file), [7, 7, 7, 7, 5, 6]);
  assert.deepEqual(userDir.fileNames(), ['recorda_3.wav']);
  const backupFile = opfs.entries.get('audio.wav');
  assert.ok(backupFile.writables.every(w => w.aborted), '예비 싱크는 abort (스왑 파일 폐기)');
});

test('FailoverFileSink: 녹화 중 주 싱크가 실패하면(권한 회수 등) 예비 싱크에만 이어서 쓰고, close 시 데이터 손실 없는 예비 파일을 돌려준다', async () => {
  const userDir = new FakeDirectoryHandle('Recordings');
  const opfs = new FakeDirectoryHandle('session');
  const primary = new DirectoryFileSink(userDir, 'recorda_4.wav', 'audio/wav');
  const backup = new DirectoryFileSink(opfs, 'audio.wav', 'audio/wav');
  const sink = new FailoverFileSink(primary, backup);
  await sink.write(bytes(1, 1));
  userDir.faults = { failWritesAfter: 0 }; // 이후 사용자 폴더 쓰기는 모두 실패
  await sink.write(bytes(2, 2));
  await sink.write(bytes(3, 3));
  await sink.writeAt(0, bytes(9));
  const file = await sink.close();
  assert.equal(sink.failedOver, true);
  assert.match(String(sink.primaryError && sink.primaryError.message), /회수/);
  assert.deepEqual(await readAll(file), [9, 1, 2, 2, 3, 3], '처음부터 끝까지 온전한 내용');
  assert.deepEqual(userDir.fileNames(), [], '실패한 사용자 폴더 파일은 정리');
});

test('FailoverFileSink: 주 싱크 close가 실패해도 예비 파일로 대체하고, 두 싱크가 모두 실패하면 오류를 던진다', async () => {
  const userDir = new FakeDirectoryHandle('Recordings');
  const opfs = new FakeDirectoryHandle('session');
  const sink = new FailoverFileSink(new DirectoryFileSink(userDir, 'a.mp3', 'audio/mpeg'), new DirectoryFileSink(opfs, 'audio.mp3', 'audio/mpeg'));
  await sink.write(bytes(1, 2));
  userDir.faults = { close: new DOMException('blocked', 'AbortError') };
  const file = await sink.close();
  assert.equal(sink.failedOver, true);
  assert.deepEqual(await readAll(file), [1, 2]);

  const d1 = new FakeDirectoryHandle('d1');
  const d2 = new FakeDirectoryHandle('d2');
  const both = new FailoverFileSink(new DirectoryFileSink(d1, 'a.wav', 'audio/wav'), new DirectoryFileSink(d2, 'b.wav', 'audio/wav'));
  await both.write(bytes(1));
  d1.faults = { failWritesAfter: 0 };
  d2.faults = { failWritesAfter: 0 };
  await assert.rejects(() => both.write(bytes(2)), /회수/);
});

test('OpfsChunkStore.readInto는 BYOB 스트림으로 호출자 버퍼에 바로 읽고(같은 메모리 재사용), 결과는 readRange와 같다', async () => {
  const root = new FakeDirectoryHandle();
  const store = new OpfsChunkStore(root, 'v.bin', { bufferBytes: 64 });
  const data = new Uint8Array(5000).map((_, i) => (i * 7) & 255);
  for (let o = 0; o < data.length; o += 100) store.appendBytes(data.subarray(o, o + 100));
  await store.finalize();
  let buffer = null;
  const views = [];
  for (const [off, size] of [[0, 1000], [1000, 1000], [4000, 1000], [2500, 10]]) {
    const view = await store.readInto(off, size, buffer);
    assert.equal(view.length, size);
    assert.deepEqual(Array.from(view.subarray(0, 8)), Array.from(data.subarray(off, off + 8)));
    assert.deepEqual(Array.from(view), Array.from(await store.readRange(off, size)));
    views.push(view);
    buffer = view.buffer;
  }
  assert.equal(store.readMode, 'byob', 'Node/Chrome의 Blob.stream()은 바이트 스트림 → BYOB');
  assert.equal(buffer.byteLength, 1000, '처음 잡은 1000바이트 버퍼를 끝까지 재사용 (작은 요청에도 새로 만들지 않음)');
});

test('OpfsChunkStore.readInto는 BYOB를 못 쓰는 환경에서 arrayBuffer() 읽기 후 호출자 버퍼에 복사한다', async () => {
  const root = new FakeDirectoryHandle();
  const store = new OpfsChunkStore(root, 'w.bin');
  store.appendBytes(new Uint8Array([1, 2, 3, 4, 5, 6]));
  await store.finalize();
  const file = store.file;
  store.file = { slice: (a, b) => { const blob = file.slice(a, b); return { arrayBuffer: () => blob.arrayBuffer(), stream: () => ({ getReader: (opts) => { if (opts && opts.mode === 'byob') throw new TypeError('byte stream 아님'); return blob.stream().getReader(); } }) }; } };
  const buffer = new ArrayBuffer(8);
  const view = await store.readInto(2, 3, buffer);
  assert.deepEqual(Array.from(view), [3, 4, 5]);
  assert.equal(view.buffer, buffer, '호출자 버퍼에 복사');
  assert.equal(store.readMode, 'arrayBuffer');
});

test('OpfsChunkStore.append는 고정 버퍼 두 개만 번갈아 쓴다 (청크마다 복사본·flush마다 병합 버퍼를 만들지 않음)', async () => {
  const root = new FakeDirectoryHandle();
  const store = new OpfsChunkStore(root, 'x.bin', { bufferBytes: 32 });
  const buffers = new Set();
  const handle = await root.getFileHandle('x.bin', { create: true });
  const origCreate = handle.createWritable.bind(handle);
  handle.createWritable = async (o) => { const w = await origCreate(o); const ow = w.write.bind(w); w.write = async (d) => { buffers.add(d.buffer); return ow(d); }; return w; };
  // 실제 녹화처럼 append 사이에 시간이 흐름(인코더 출력 콜백) → 앞선 쓰기가 끝난 버퍼를 재사용
  for (let i = 0; i < 200; i++) {
    store.appendBytes(new Uint8Array([i & 255, 1, 2, 3, 4, 5, 6]));
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }
  await store.finalize();
  assert.ok(buffers.size <= 2, `쓰기에 쓰인 버퍼 ${buffers.size}개`);
  const all = await store.readRange(0, store.size);
  assert.equal(all.length, 1400);
  for (let i = 0; i < 200; i++) assert.equal(all[i * 7], i & 255);
});

test('DirectoryFileSink.write는 받은 뷰를 복사하지 않고 그대로 writable.write에 넘긴다 (BatchWriter 고정 버퍼의 subarray)', async () => {
  const dir = new FakeDirectoryHandle('d');
  const sink = new DirectoryFileSink(dir, 'o.bin', 'application/octet-stream');
  await sink.open();
  const received = [];
  const ow = sink.writable.write.bind(sink.writable);
  sink.writable.write = (d) => { received.push(d); return ow(d); };
  const big = new Uint8Array(64).fill(3);
  const part = big.subarray(8, 40);
  await sink.write(part);
  assert.equal(received[0], part, '같은 객체 (복사 없음)');
  assert.equal(sink.bytesWritten, 32);
});
