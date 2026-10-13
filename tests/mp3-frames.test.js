import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseMp3FrameHeader, Mp3FrameSplitter } from '../muxers/mp3-frames.js';

// MPEG-1 Layer III, 128kbps, 44100Hz, 패딩 없음, 스테레오 → 프레임 길이 417
function makeFrame(bitrateIndex = 9, sampleRateIndex = 0, padding = 0, length = 417) {
  const f = new Uint8Array(length);
  f[0] = 0xFF;
  f[1] = 0xFB; // MPEG-1, Layer III, no CRC
  f[2] = (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding << 1);
  f[3] = 0x00; // stereo
  return f;
}

test('parseMp3FrameHeader는 MPEG-1 Layer III 헤더에서 길이/샘플수/샘플레이트를 계산한다', () => {
  const h = parseMp3FrameHeader(makeFrame(), 0);
  assert.deepEqual(h, { frameLength: 417, samplesPerFrame: 1152, sampleRate: 44100, bitrate: 128000, channels: 2 });
  // 패딩 비트가 있으면 1바이트 추가
  assert.equal(parseMp3FrameHeader(makeFrame(9, 0, 1, 418), 0).frameLength, 418);
  // 48kHz, 192kbps → 144*192000/48000 = 576
  assert.equal(parseMp3FrameHeader(makeFrame(11, 1, 0, 576), 0).frameLength, 576);
});

test('parseMp3FrameHeader는 싱크가 없거나 잘못된 헤더에 null을 반환한다', () => {
  assert.equal(parseMp3FrameHeader(new Uint8Array([0, 0, 0, 0]), 0), null);
  assert.equal(parseMp3FrameHeader(new Uint8Array([0xFF, 0xFB]), 0), null); // 길이 부족
  const badBitrate = makeFrame(15);
  assert.equal(parseMp3FrameHeader(badBitrate, 0), null);
});

test('Mp3FrameSplitter는 여러 입력 버퍼에 걸친 프레임을 올바르게 분리한다', () => {
  const a = makeFrame();
  const b = makeFrame(9, 0, 1, 418);
  const c = makeFrame();
  const all = new Uint8Array(a.length + b.length + c.length);
  all.set(a, 0); all.set(b, a.length); all.set(c, a.length + b.length);

  const splitter = new Mp3FrameSplitter();
  const frames = [
    ...splitter.push(all.subarray(0, 100)),      // a의 일부
    ...splitter.push(all.subarray(100, 700)),    // a의 나머지 + b의 일부
    ...splitter.push(all.subarray(700)),         // b 나머지 + c 전체
    ...splitter.flush()
  ];
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map(f => f.data.length), [417, 418, 417]);
  assert.deepEqual(frames.map(f => f.samples), [1152, 1152, 1152]);
  assert.deepEqual(Array.from(frames[1].data), Array.from(b));
});

test('Mp3FrameSplitter.flush는 불완전한 꼬리 데이터를 버리고 경고 카운트를 남긴다', () => {
  const splitter = new Mp3FrameSplitter();
  const frames = [...splitter.push(makeFrame().subarray(0, 200)), ...splitter.flush()];
  assert.equal(frames.length, 0);
  assert.equal(splitter.discardedBytes, 200);
});

test('Mp3FrameSplitter는 lamejs 실제 출력에서 프레임 수와 총 바이트를 보존한다', () => {
  vm.runInThisContext(readFileSync(new URL('../lib/lame.min.js', import.meta.url), 'utf8'));
  const enc = new globalThis.lamejs.Mp3Encoder(2, 44100, 128);
  const left = new Int16Array(4096), right = new Int16Array(4096);
  for (let i = 0; i < 4096; i++) { left[i] = Math.round(Math.sin(i / 10) * 10000); right[i] = -left[i]; }

  const splitter = new Mp3FrameSplitter();
  let totalIn = 0;
  const frames = [];
  for (let i = 0; i < 20; i++) {
    const out = enc.encodeBuffer(left, right);
    totalIn += out.length;
    frames.push(...splitter.push(new Uint8Array(out.buffer, out.byteOffset, out.length)));
  }
  const tail = enc.flush();
  totalIn += tail.length;
  frames.push(...splitter.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length)));
  frames.push(...splitter.flush());

  const totalOut = frames.reduce((s, f) => s + f.data.length, 0);
  assert.equal(totalOut, totalIn, '프레임 바이트 합계가 입력과 같아야 함');
  assert.ok(frames.length >= Math.floor(20 * 4096 / 1152), `프레임 수 ${frames.length}`);
  assert.ok(frames.every(f => f.samples === 1152));
  assert.ok(frames.every(f => f.data.length === 417 || f.data.length === 418));
});
