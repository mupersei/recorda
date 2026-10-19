// 장시간 녹화 규모의 머싱 계획 메모리/시간 검사 (npm test는 --expose-gc로 실행; 없으면 v8 플래그로 gc를 얻음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { planMp4 } from '../muxers/mp4-muxer.js';
import { planAvi } from '../muxers/avi-muxer.js';
import { SampleIndex } from '../storage/sample-index.js';
import { parseBoxes, findBox, findAllBoxes, readStsz, readChunkOffsets } from './helpers/media.js';

v8.setFlagsFromString('--expose-gc');
const gc = globalThis.gc || vm.runInNewContext('gc');

const VIDEO_SAMPLES = 734_400;
const AUDIO_FRAMES = 411_000;
const AVCC = new Uint8Array([1, 0x42, 0x00, 0x2A, 0xFF, 0xE1, 0, 4, 0x67, 0x42, 0x00, 0x2A, 1, 0, 2, 0x68, 0xCE]);
const fakeStore = (size) => ({ kind: 'fake', size, readRange: async () => { throw new Error('계획 단계에서는 읽지 않음'); } });

/** 저장소 참조만 있는 합성 트랙 (SampleIndex 형식, 데이터 없음) */
function syntheticIndexedTracks({ pSize, kSize, aSize }) {
  const vIndex = new SampleIndex({ kind: 'video' });
  let off = 0;
  for (let i = 0; i < VIDEO_SAMPLES; i++) {
    const key = i % 60 === 0;
    const size = key ? kSize : pSize;
    vIndex.push(off, size, Math.round(i * 1e6 / 30), key, 1);
    off += size;
  }
  const aIndex = new SampleIndex({ kind: 'audio' });
  let aOff = 0;
  for (let i = 0; i < AUDIO_FRAMES; i++) { aIndex.pushFrame(aOff, aSize, 1152); aOff += aSize; }
  return {
    video: { width: 1280, height: 720, avcC: AVCC, index: vIndex, store: fakeStore(off) },
    audio: { codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000, index: aIndex, store: fakeStore(aOff) }
  };
}

function measure(fn) {
  gc(); gc();
  const before = process.memoryUsage();
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  const justAfter = process.memoryUsage(); // GC 전: 계획 중 만들어진 임시 객체·배열까지 포함
  gc(); gc();
  const after = process.memoryUsage();     // GC 후: 계획 결과가 붙잡고 있는 메모리
  const mb = (a, b) => (a.heapUsed + a.arrayBuffers - b.heapUsed - b.arrayBuffers) / 1048576;
  return { result, ms, duringMB: mb(justAfter, before), retainedMB: mb(after, before), rssMB: (justAfter.rss - before.rss) / 1048576 };
}

test(`planMp4: 영상 ${VIDEO_SAMPLES.toLocaleString()} + 오디오 ${AUDIO_FRAMES.toLocaleString()} 샘플(저장소 참조만)을 60 MB 미만·10초 미만으로 계획한다`, () => {
  const { video, audio } = syntheticIndexedTracks({ pSize: 10_400, kSize: 41_600, aSize: 418 });
  const m = measure(() => planMp4({ container: 'mp4', video, audio, creationTime: new Date(Date.UTC(2026, 0, 1)) }));
  const plan = m.result;
  console.log(`[scale] planMp4 ${m.ms.toFixed(0)} ms, 계획 중 증가 ${m.duringMB.toFixed(1)} MB, 유지 ${m.retainedMB.toFixed(1)} MB, RSS +${m.rssMB.toFixed(0)} MB, moov ${(plan.moov.length / 1048576).toFixed(1)} MB`);
  // (a) moov 생성 + 샘플 수·오프셋 정합
  const moov = parseBoxes(plan.moov);
  assert.equal(moov[0].type, 'moov');
  const traks = findAllBoxes(moov[0].children, 'trak');
  assert.equal(traks.length, 2);
  const vStbl = findBox(traks[0].children, 'mdia/minf/stbl').children;
  const aStbl = findBox(traks[1].children, 'mdia/minf/stbl').children;
  assert.equal(readStsz(vStbl).length, VIDEO_SAMPLES);
  assert.equal(readStsz(aStbl).length, AUDIO_FRAMES);
  assert.ok(vStbl.some(b => b.type === 'co64'), '7 GB 이상 → co64');
  const vOffsets = readChunkOffsets(vStbl);
  const aOffsets = readChunkOffsets(aStbl);
  const mdatEnd = plan.totalBytes - plan.moov.length;
  const lastV = vOffsets[vOffsets.length - 1] + video.index.sizeAt(VIDEO_SAMPLES - 1);
  const lastA = aOffsets[aOffsets.length - 1] + audio.index.sizeAt(AUDIO_FRAMES - 1);
  assert.equal(Math.max(lastV, lastA), mdatEnd, '마지막 샘플 끝 = mdat 끝');
  assert.equal(plan.head.length + video.index.totalBytes + audio.index.totalBytes + plan.moov.length, plan.totalBytes);
  // (b) 메모리 (이전 구현: 유지 약 304 MB, RSS +459 MB)
  assert.ok(m.duringMB < 60, `계획 중 힙+ArrayBuffer 증가 ${m.duringMB.toFixed(1)} MB < 60 MB`);
  assert.ok(m.retainedMB < 60, `계획 후 유지 ${m.retainedMB.toFixed(1)} MB < 60 MB`);
  // (c) 시간 (이전 구현: 약 2.6초)
  assert.ok(m.ms < 10_000, `${m.ms.toFixed(0)} ms < 10 s`);
});

test(`planAvi: 영상 ${VIDEO_SAMPLES.toLocaleString()} + 오디오 ${AUDIO_FRAMES.toLocaleString()} 청크(2GB 이내 작은 크기)를 60 MB 미만·10초 미만으로 계획한다`, () => {
  const { video, audio } = syntheticIndexedTracks({ pSize: 1_500, kSize: 6_000, aSize: 400 });
  const m = measure(() => planAvi({ video, audio, frameRate: 30 }));
  const plan = m.result;
  const idx1 = plan.idx1;
  console.log(`[scale] planAvi ${m.ms.toFixed(0)} ms, 계획 중 증가 ${m.duringMB.toFixed(1)} MB, 유지 ${m.retainedMB.toFixed(1)} MB, RSS +${m.rssMB.toFixed(0)} MB, idx1 ${(idx1.length / 1048576).toFixed(1)} MB`);
  // (a) 헤더 + idx1 생성: 슬롯 734,400개(영상이 오디오보다 길다) + 오디오 411,000개
  assert.equal(String.fromCharCode(...plan.head.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...idx1.subarray(0, 4)), 'idx1');
  assert.equal(new DataView(idx1.buffer, idx1.byteOffset).getUint32(4, true), (VIDEO_SAMPLES + AUDIO_FRAMES) * 16);
  assert.ok(plan.totalBytes < 2 * 1024 * 1024 * 1024);
  // (b) 메모리 (이전 구현: 유지 약 454 MB, RSS +567 MB)
  assert.ok(m.duringMB < 60, `계획 중 힙+ArrayBuffer 증가 ${m.duringMB.toFixed(1)} MB < 60 MB`);
  assert.ok(m.retainedMB < 60, `계획 후 유지 ${m.retainedMB.toFixed(1)} MB < 60 MB`);
  // (c) 시간 (이전 구현: 약 1.8초)
  assert.ok(m.ms < 10_000, `${m.ms.toFixed(0)} ms < 10 s`);
});
