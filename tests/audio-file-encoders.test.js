import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { WavFileEncoder, Mp3FileEncoder } from '../audio-file-encoders.js';
import { MemoryFileSink, OpfsFileSink } from '../storage/chunk-store.js';
import { FakeDirectoryHandle } from './helpers/fake-opfs.js';
import { Mp3FrameSplitter } from '../muxers/mp3-frames.js';

vm.runInThisContext(readFileSync(new URL('../lib/lame.min.js', import.meta.url), 'utf8'));

function pcm(n, v) { return new Float32Array(n).fill(v); }

test('WavFileEncoder: 헤더 자리 → PCM 스트리밍 → 종료 시 헤더 패치, RIFF/data 크기가 정확하다', async () => {
  const sink = new MemoryFileSink('audio/wav');
  const enc = new WavFileEncoder({ sampleRate: 48000, channels: 2, sink, bufferBytes: 1000 });
  await enc.start();
  enc.processChunk(pcm(4096, 0.5), pcm(4096, -0.5));
  enc.processChunk(pcm(4096, 0.25), pcm(4096, -0.25));
  const blob = await enc.finish();
  assert.equal(blob.type, 'audio/wav');
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(u8.buffer);
  const dataBytes = 8192 * 2 * 2;
  assert.equal(String.fromCharCode(...u8.slice(0, 4)), 'RIFF');
  assert.equal(dv.getUint32(4, true), 36 + dataBytes);
  assert.equal(String.fromCharCode(...u8.slice(8, 12)), 'WAVE');
  assert.equal(dv.getUint16(22, true), 2, 'channels');
  assert.equal(dv.getUint32(24, true), 48000, 'sampleRate');
  assert.equal(dv.getUint32(28, true), 48000 * 4, 'byteRate');
  assert.equal(String.fromCharCode(...u8.slice(36, 40)), 'data');
  assert.equal(dv.getUint32(40, true), dataBytes);
  assert.equal(u8.length, 44 + dataBytes);
  // 첫 샘플: L=0.5 → 16383, R=-0.5 → -16384 (인터리브)
  assert.equal(dv.getInt16(44, true), Math.trunc(0.5 * 0x7FFF), '기존 인코더와 같은 변환 규칙(버림)');
  assert.equal(dv.getInt16(46, true), -0.5 * 0x8000);
  assert.equal(enc.totalSamples, 8192);
});

test('WavFileEncoder: OPFS 싱크로도 동일하게 동작하고 디스크 기반 File을 돌려준다', async () => {
  const root = new FakeDirectoryHandle();
  const sink = new OpfsFileSink(root, 'a.wav', 'audio/wav');
  const enc = new WavFileEncoder({ sampleRate: 44100, channels: 2, sink });
  await enc.start();
  enc.processChunk(pcm(1024, 0.1), pcm(1024, 0.1));
  const blob = await enc.finish();
  assert.equal(blob.size, 44 + 1024 * 4);
  const u8 = new Uint8Array(await blob.arrayBuffer());
  assert.equal(new DataView(u8.buffer).getUint32(40, true), 1024 * 4);
});

test('WavFileEncoder: 메모리 보유량은 쓰기 버퍼 크기 이하로 유지된다', async () => {
  const sink = new MemoryFileSink('audio/wav');
  const enc = new WavFileEncoder({ sampleRate: 48000, channels: 2, sink, bufferBytes: 64 * 1024 });
  await enc.start();
  for (let i = 0; i < 200; i++) enc.processChunk(pcm(4096, 0.1), pcm(4096, 0.1)); // 3.2MB PCM
  assert.ok(enc.retainedBytes <= 64 * 1024 + 4096 * 4, `retained=${enc.retainedBytes}`);
  await enc.finish();
});

test('Mp3FileEncoder: lamejs 출력을 싱크에 스트리밍하고 유효한 MP3 프레임 열을 만든다', async () => {
  const sink = new MemoryFileSink('audio/mpeg');
  const enc = new Mp3FileEncoder({ sampleRate: 44100, channels: 2, bitrateKbps: 128, sink, bufferBytes: 2000 });
  await enc.start();
  for (let i = 0; i < 12; i++) enc.processChunk(pcm(4096, 0.3), pcm(4096, -0.3));
  const blob = await enc.finish();
  assert.equal(blob.type, 'audio/mpeg');
  const u8 = new Uint8Array(await blob.arrayBuffer());
  assert.equal(u8[0], 0xFF);
  const splitter = new Mp3FrameSplitter();
  const frames = splitter.push(u8);
  splitter.flush();
  assert.ok(frames.length >= Math.floor(12 * 4096 / 1152) - 1, `frames=${frames.length}`);
  assert.equal(frames.reduce((s, f) => s + f.data.length, 0), u8.length, '전체가 완전한 프레임');
});

test('파일 인코더는 start 전 processChunk를 무시하고 finish 후에는 isStarted가 false다', async () => {
  const enc = new WavFileEncoder({ sampleRate: 44100, channels: 2, sink: new MemoryFileSink('audio/wav') });
  enc.processChunk(pcm(10, 0), pcm(10, 0));
  assert.equal(enc.totalSamples, 0);
  await enc.start();
  assert.equal(enc.isStarted, true);
  await enc.finish();
  assert.equal(enc.isStarted, false);
});
