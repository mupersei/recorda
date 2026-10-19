import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { SampleIndex } from '../storage/sample-index.js';

v8.setFlagsFromString('--expose-gc');
const gc = globalThis.gc || vm.runInNewContext('gc');

test('SampleIndex(video): push한 오프셋·크기·타임스탬프·키프레임·NAL 개수를 인덱스로 읽는다', () => {
  const index = new SampleIndex({ kind: 'video' });
  assert.equal(index.kind, 'video');
  assert.equal(index.length, 0);
  index.push(0, 100, 0, true, 3);
  index.push(100, 50, 33_333, false, 1);
  index.push(150, 7, 66_667.5, false, 2);
  assert.equal(index.length, 3);
  assert.deepEqual([0, 1, 2].map(i => index.offsetAt(i)), [0, 100, 150]);
  assert.deepEqual([0, 1, 2].map(i => index.sizeAt(i)), [100, 50, 7]);
  assert.deepEqual([0, 1, 2].map(i => index.timestampAt(i)), [0, 33_333, 66_667.5], '타임스탬프는 Float64(µs)');
  assert.deepEqual([0, 1, 2].map(i => index.keyframeAt(i)), [true, false, false]);
  assert.deepEqual([0, 1, 2].map(i => index.nalCountAt(i)), [3, 1, 2]);
  assert.equal(index.totalBytes, 157);
  assert.equal(index.maxSize, 100);
});

test('SampleIndex(audio): pushFrame한 오프셋·크기·프레임당 샘플 수를 읽고 합계를 유지한다', () => {
  const index = new SampleIndex({ kind: 'audio' });
  index.pushFrame(0, 417, 1152);
  index.pushFrame(417, 418, 1152);
  index.pushFrame(835, 208, 576);
  assert.equal(index.length, 3);
  assert.deepEqual([0, 1, 2].map(i => index.offsetAt(i)), [0, 417, 835]);
  assert.deepEqual([0, 1, 2].map(i => index.sizeAt(i)), [417, 418, 208]);
  assert.deepEqual([0, 1, 2].map(i => index.samplesAt(i)), [1152, 1152, 576]);
  assert.equal(index.totalBytes, 1043);
  assert.equal(index.totalFrameSamples, 2880);
  assert.equal(index.maxSize, 418);
  // 오디오 프레임은 항상 독립 디코딩 가능
  assert.equal(index.keyframeAt(1), true);
});

test('SampleIndex: 종류에 맞지 않는 push는 거부하고, 범위를 넘는 값은 조용히 잘리지 않고 오류가 난다', () => {
  const video = new SampleIndex({ kind: 'video' });
  const audio = new SampleIndex({ kind: 'audio' });
  assert.throws(() => video.pushFrame(0, 1, 1152), /video/);
  assert.throws(() => audio.push(0, 1, 0, true, 1), /audio/);
  assert.throws(() => new SampleIndex({ kind: 'text' }), /kind/);
  assert.throws(() => video.push(0, 2 ** 32, 0, true, 1), RangeError, '크기는 Uint32');
  assert.throws(() => video.push(0, 1, 0, true, 70_000), RangeError, 'NAL 개수는 Uint16');
  assert.throws(() => audio.pushFrame(0, 1, 70_000), RangeError, '프레임 샘플 수는 Uint16');
  assert.equal(video.length, 0, '실패한 push는 기록되지 않음');
});

test('SampleIndex: 4GB를 넘는 오프셋도 정확히 보관한다 (Float64)', () => {
  const index = new SampleIndex({ kind: 'video' });
  const big = 6 * 1024 * 1024 * 1024 + 12345;
  index.push(big, 10, 1, false, 1);
  assert.equal(index.offsetAt(0), big);
});

test('SampleIndex: 용량이 차면 두 배로 늘리고 기존 값을 유지한다', () => {
  const index = new SampleIndex({ kind: 'video', initialCapacity: 4 });
  assert.equal(index.capacity, 4);
  for (let i = 0; i < 9; i++) index.push(i * 10, 10, i * 1000, i % 4 === 0, 1);
  assert.equal(index.length, 9);
  assert.equal(index.capacity, 16, '4 → 8 → 16');
  for (let i = 0; i < 9; i++) {
    assert.equal(index.offsetAt(i), i * 10);
    assert.equal(index.timestampAt(i), i * 1000);
    assert.equal(index.keyframeAt(i), i % 4 === 0);
  }
  // bytesUsed는 할당된 열(column) 크기 합: video = offset 8 + size 4 + timestamp 8 + flags 1 + nalCount 2 = 23 B/샘플
  assert.equal(index.bytesUsed, 16 * 23);
  const audio = new SampleIndex({ kind: 'audio', initialCapacity: 8 });
  assert.equal(audio.bytesUsed, 8 * (8 + 4 + 2), 'audio = offset 8 + size 4 + samples 2 = 14 B/프레임');
});

test('SampleIndex: 범위를 벗어난 인덱스는 undefined가 아니라 오류', () => {
  const index = new SampleIndex({ kind: 'audio' });
  index.pushFrame(0, 1, 1152);
  assert.throws(() => index.sizeAt(1), RangeError);
  assert.throws(() => index.offsetAt(-1), RangeError);
});

test('SampleIndex: 3시간 분량(영상 32.4만 + 오디오 45만)을 넣어도 샘플마다 객체를 만들지 않아 메모리가 열 크기 수준이다', () => {
  gc(); gc();
  const before = process.memoryUsage();
  const video = new SampleIndex({ kind: 'video' });
  const audio = new SampleIndex({ kind: 'audio' });
  let vOff = 0, aOff = 0;
  for (let i = 0; i < 324_000; i++) { const size = i % 60 === 0 ? 40_000 : 10_000; video.push(vOff, size, Math.round(i * 1e6 / 30), i % 60 === 0, 1); vOff += size; }
  for (let i = 0; i < 450_000; i++) { audio.pushFrame(aOff, 418, 1152); aOff += 418; }
  gc(); gc();
  const after = process.memoryUsage();
  const heapMB = (after.heapUsed - before.heapUsed) / 1048576;
  const totalMB = (after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers) / 1048576;
  const columnsMB = (video.bytesUsed + audio.bytesUsed) / 1048576;
  assert.equal(video.length, 324_000);
  assert.equal(audio.length, 450_000);
  assert.ok(heapMB < 2, `JS 힙(객체) 증가 ${heapMB.toFixed(2)} MB - 샘플 객체가 없어야 함`);
  assert.ok(totalMB <= columnsMB + 2, `전체 증가 ${totalMB.toFixed(1)} MB ≈ 열 크기 ${columnsMB.toFixed(1)} MB`);
  assert.ok(columnsMB < 22, `열 크기 ${columnsMB.toFixed(1)} MB (이전 객체 방식은 약 55 MB)`);
  assert.equal(video.totalBytes, vOff);
  assert.equal(audio.totalFrameSamples, 450_000 * 1152);
});
