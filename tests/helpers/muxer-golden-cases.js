// 머서 골든 케이스 - 리팩터링 전 구현이 만든 바이트의 SHA-256을 기준값으로 삼아, 내부 구조(샘플 테이블, 인터리빙)를
// 바꿔도 출력 파일이 한 바이트도 달라지지 않는지 확인합니다 (tests/muxer-golden.test.js).
// 머서 함수는 인자로 받으므로 같은 케이스를 이전 구현(백업 사본)에도 그대로 돌려 기준값을 만들 수 있습니다.
import { createHash } from 'node:crypto';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function concatAll(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const CREATION_TIME = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/** 결정적 의사 난수 (LCG) */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

/**
 * 저장소 참조용 합성 트랙: 길이 접두(4바이트) NAL 1~3개짜리 AVC 샘플 + MP3 프레임 모양의 바이트.
 * 타임스탬프는 30fps 근처에서 흔들리고(지터, 가끔 몰림/빠짐), 키프레임은 30프레임마다.
 */
export function syntheticTracks({ videoCount = 600, audioCount = 900, seed = 7 } = {}) {
  const rand = lcg(seed);
  const video = [];
  let ts = 0;
  for (let i = 0; i < videoCount; i++) {
    const keyframe = i % 30 === 0;
    const nals = 1 + Math.floor(rand() * 3);
    const sizes = Array.from({ length: nals }, () => 20 + Math.floor(rand() * (keyframe ? 3000 : 900)));
    const data = new Uint8Array(sizes.reduce((s, n) => s + 4 + n, 0));
    const view = new DataView(data.buffer);
    let o = 0;
    for (const n of sizes) {
      view.setUint32(o, n);
      data[o + 4] = keyframe ? 0x65 : 0x41;
      for (let k = 1; k < n; k++) data[o + 4 + k] = (i * 31 + k * 7) & 0xFF;
      o += 4 + n;
    }
    video.push({ data, timestamp: Math.round(ts), keyframe, nalCount: nals });
    const r = rand();
    ts += r < 0.05 ? 4_000 : r < 0.1 ? 70_000 : 33_333 + Math.round((rand() - 0.5) * 6_000);
  }
  const audio = [];
  for (let i = 0; i < audioCount; i++) {
    const size = 417 + (i % 3 === 0 ? 1 : 0);
    const data = new Uint8Array(size);
    data[0] = 0xFF; data[1] = 0xFB; data[2] = 0x90; data[3] = 0x64;
    for (let k = 4; k < size; k++) data[k] = (i + k) & 0xFF;
    audio.push({ data, samples: 1152 });
  }
  return { video, audio };
}

/**
 * @param {Object} m - { buildMp4, planMp4, writeMp4, buildAvi, writeAvi, MemoryChunkStore, MemoryFileSink }
 * @param {Object} f - { video, audio, audio48, audio22 } (픽스처: loadFixtureVideo / makeMp3Audio)
 * @returns {Array<{name:string, run:() => Promise<Uint8Array>}>}
 */
export function goldenCases(m, f) {
  const { video, audio, audio48, audio22 } = f;
  const short = { ...video, samples: video.samples.slice(0, 4) };
  const irregular = { ...video, samples: video.samples.slice(0, 4).map((s, i) => ({ ...s, timestamp: 5_000_000 + [0, 40_000, 60_000, 100_000][i] })) };
  // 모든 샘플이 키프레임이고 크기가 같음 → stss 생략, stsz 고정 크기 분기
  const uniform = { ...video, samples: video.samples.slice(0, 10).map((s, i) => ({ data: video.samples[0].data, timestamp: i * 33_333, keyframe: true })) };
  const sparse = { ...video, samples: [0, 1, 3].map((i, k) => ({ ...video.samples[i], timestamp: [0, 33_333, 100_000][k] })) };
  const bunched = { ...video, samples: video.samples.slice(0, 6).map((s, i) => ({ ...s, timestamp: [0, 5_000, 10_000, 100_000, 101_000, 400_000][i] })) };
  const synth = syntheticTracks();

  const mp4 = (options) => async () => concatAll(m.buildMp4({ creationTime: CREATION_TIME, ...options }));
  const avi = (options) => async () => concatAll(m.buildAvi(options));

  // 저장소 참조(ref) 기반 스트리밍 쓰기 (MemoryChunkStore → MemoryFileSink)
  async function storeBacked() {
    const vStore = new m.MemoryChunkStore();
    const aStore = new m.MemoryChunkStore();
    const samples = synth.video.map(s => ({ ref: vStore.append(s.data), nalCount: s.nalCount, timestamp: s.timestamp, keyframe: s.keyframe }));
    const frames = synth.audio.map(a => ({ ref: aStore.append(a.data), samples: a.samples }));
    await vStore.finalize();
    await aStore.finalize();
    return {
      video: { width: 1280, height: 720, avcC: video.avcC, samples, store: vStore },
      audio: { codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000, frames, store: aStore }
    };
  }
  const writeToBytes = async (blobPromise) => new Uint8Array(await (await blobPromise).blob.arrayBuffer());

  // 4GB를 넘는 mdat (co64 + 64비트 mdat 헤더): 데이터 없이 크기만으로 계획 → head + moov만 비교
  function hugePlanBytes() {
    const samples = [];
    let off = 0;
    for (let i = 0; i < 2400; i++) {
      const size = (i % 60 === 0 ? 4 : 1) * 1_900_000 + (i % 7);
      samples.push({ ref: { offset: off, size }, timestamp: Math.round(i * 1e6 / 30), keyframe: i % 60 === 0 });
      off += size;
    }
    const frames = [];
    for (let i = 0; i < 3500; i++) frames.push({ ref: { offset: i * 418, size: 418 }, samples: 1152 });
    const plan = m.planMp4({ container: 'mp4', video: { width: 1920, height: 1080, avcC: video.avcC, samples, store: {} }, audio: { codec: 'mp3', sampleRate: 48000, channels: 2, bitrate: 160000, frames, store: {} }, creationTime: CREATION_TIME });
    return concatAll([plan.head, plan.moov]);
  }

  return [
    { name: 'mp4: 픽스처 영상 + MP3 44.1kHz', run: mp4({ container: 'mp4', video, audio }) },
    { name: 'mov: 픽스처 영상 + MP3 44.1kHz', run: mp4({ container: 'mov', video, audio }) },
    { name: 'mp4: 영상만', run: mp4({ container: 'mp4', video, audio: null }) },
    { name: 'mp4: 불규칙 타임스탬프 (오디오 없음)', run: mp4({ container: 'mp4', video: irregular, audio: null }) },
    { name: 'mp4: 짧은 영상 + 긴 오디오 (마지막 샘플 연장)', run: mp4({ container: 'mp4', video: short, audio }) },
    { name: 'mov: 짧은 영상 + 긴 오디오', run: mp4({ container: 'mov', video: short, audio }) },
    { name: 'mp4: MP3 48kHz', run: mp4({ container: 'mp4', video, audio: audio48 }) },
    { name: 'mp4: MP3 22.05kHz (MPEG-2, 576 샘플/프레임)', run: mp4({ container: 'mp4', video, audio: audio22 }) },
    { name: 'mov: MP3 22.05kHz', run: mp4({ container: 'mov', video, audio: audio22 }) },
    { name: 'mp4: 전부 키프레임 + 같은 크기 (stss 생략, stsz 고정)', run: mp4({ container: 'mp4', video: uniform, audio }) },
    { name: 'mp4: 오디오 비트레이트 미지정 (추정)', run: mp4({ container: 'mp4', video, audio: { ...audio, bitrate: undefined } }) },
    { name: 'mp4: 저장소 참조 스트리밍 (합성 600프레임 + 900 MP3 프레임)', run: async () => { const t = await storeBacked(); return writeToBytes(m.writeMp4({ container: 'mp4', ...t, output: new m.MemoryFileSink('video/mp4'), creationTime: CREATION_TIME })); } },
    { name: 'mov: 저장소 참조 스트리밍 (합성)', run: async () => { const t = await storeBacked(); return writeToBytes(m.writeMp4({ container: 'mov', ...t, output: new m.MemoryFileSink('video/quicktime'), creationTime: CREATION_TIME })); } },
    { name: 'mp4: 4GB 초과 계획 (co64, 64비트 mdat) head+moov', run: async () => hugePlanBytes() },
    { name: 'avi: 픽스처 영상 + MP3 44.1kHz', run: avi({ video, audio, frameRate: 30 }) },
    { name: 'avi: 영상만', run: avi({ video, audio: null, frameRate: 30 }) },
    { name: 'avi: 빈 슬롯 (sparse)', run: avi({ video: sparse, audio: null, frameRate: 30 }) },
    { name: 'avi: 같은 슬롯으로 몰린 프레임 (bunched) + 오디오', run: avi({ video: bunched, audio, frameRate: 30 }) },
    { name: 'avi: 짧은 영상 + 긴 오디오 (빈 슬롯 덧붙임)', run: avi({ video: short, audio, frameRate: 30 }) },
    { name: 'avi: 29.97fps + MP3 48kHz', run: avi({ video, audio: audio48, frameRate: 29.97 }) },
    { name: 'avi: MP3 22.05kHz (576 샘플/프레임)', run: avi({ video, audio: audio22, frameRate: 30 }) },
    { name: 'avi: 저장소 참조 스트리밍 (합성)', run: async () => { const t = await storeBacked(); return writeToBytes(m.writeAvi({ ...t, frameRate: 30, output: new m.MemoryFileSink('video/x-msvideo') })); } }
  ];
}
