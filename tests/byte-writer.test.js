import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteWriter, concatBytes, fourcc } from '../muxers/byte-writer.js';

test('ByteWriter는 빅엔디언/리틀엔디언 정수와 문자열을 기록한다', () => {
  const w = new ByteWriter();
  w.u8(0x01);
  w.u16be(0x0203);
  w.u16le(0x0203);
  w.u32be(0x04050607);
  w.u32le(0x04050607);
  w.ascii('abcd');
  assert.deepEqual(Array.from(w.bytes()), [
    0x01,
    0x02, 0x03,
    0x03, 0x02,
    0x04, 0x05, 0x06, 0x07,
    0x07, 0x06, 0x05, 0x04,
    0x61, 0x62, 0x63, 0x64
  ]);
  assert.equal(w.length, 17);
});

test('ByteWriter는 64비트 정수와 바이트 배열을 기록하며 자동으로 버퍼를 확장한다', () => {
  const w = new ByteWriter(2);
  w.u64be(0x0000000100000002n);
  w.bytes_(new Uint8Array([9, 9, 9]));
  assert.deepEqual(Array.from(w.bytes()), [0, 0, 0, 1, 0, 0, 0, 2, 9, 9, 9]);
});

test('ByteWriter.patchU32be는 기록된 위치의 값을 덮어쓴다', () => {
  const w = new ByteWriter();
  w.u32be(0);
  w.ascii('xyz');
  w.patchU32be(0, 0xAABBCCDD);
  assert.deepEqual(Array.from(w.bytes().slice(0, 4)), [0xAA, 0xBB, 0xCC, 0xDD]);
});

test('ByteWriter.i16le와 fixed16/fixed8 고정소수점을 지원한다', () => {
  const w = new ByteWriter();
  w.i16le(-2);
  w.fixed16_16(1.5);
  w.fixed8_8(1.0);
  assert.deepEqual(Array.from(w.bytes()), [0xFE, 0xFF, 0x00, 0x01, 0x80, 0x00, 0x01, 0x00]);
});

test('concatBytes는 여러 Uint8Array를 하나로 합친다', () => {
  const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
  assert.deepEqual(Array.from(out), [1, 2, 3]);
});

test('fourcc는 4글자 문자열의 리틀엔디언 u32 값을 반환한다', () => {
  // 'RIFF' = 52 49 46 46 → LE u32 = 0x46464952
  assert.equal(fourcc('RIFF'), 0x46464952);
  assert.throws(() => fourcc('abc'), /4/);
});
