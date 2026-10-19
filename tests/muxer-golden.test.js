import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMp4, planMp4, writeMp4 } from '../muxers/mp4-muxer.js';
import { buildAvi, writeAvi } from '../muxers/avi-muxer.js';
import { MemoryChunkStore, MemoryFileSink, OpfsChunkStore, OpfsFileSink } from '../storage/chunk-store.js';
import { SampleIndex } from '../storage/sample-index.js';
import { loadFixtureVideo, makeMp3Audio } from './helpers/media.js';
import { FakeDirectoryHandle } from './helpers/fake-opfs.js';
import { goldenCases, sha256, concatAll, syntheticTracks } from './helpers/muxer-golden-cases.js';

// 리팩터링 전(샘플 객체 + 정렬 + 중첩 box 복사) 구현이 만든 출력의 SHA-256.
// 생성: node golden-gen.mjs <이전 구현 사본> (같은 케이스 정의 tests/helpers/muxer-golden-cases.js 사용)
const GOLDEN = [
  ["mp4: 픽스처 영상 + MP3 44.1kHz", 'b08b469bdb5cf2adc7fdcac1cb44f0a32451151f0112f1e104df25320a92c10d', 63636],
  ["mov: 픽스처 영상 + MP3 44.1kHz", '7bc241a5e75b80f8d1b77693c6778f9cc71538c77f22e19df6406d2ea1ad8e4a', 63684],
  ["mp4: 영상만", '3337f8576741b2f11cf16b778bb820c7be0ff3bee55b712170937d0bc7a721f7', 29931],
  ["mp4: 불규칙 타임스탬프 (오디오 없음)", 'e5bac7183e94fafd32b310ef093358424883014ddfa1ff012e0a6d058044f155', 5802],
  ["mp4: 짧은 영상 + 긴 오디오 (마지막 샘플 연장)", '198ff147faf53f55f5a2262b84e21b30abec2c7d57ce00965db0b3fd79f94d6f', 39491],
  ["mov: 짧은 영상 + 긴 오디오", 'b9d3c3d6c9b32738c1a1c6e34e0a0dffb25a218cce6236f0efd26bb9f7c3dbc1', 39539],
  ["mp4: MP3 48kHz", '9552ae8b819df9914f5de357fb47f23250a3df482fbf4ce158f461719b87bd59', 71552],
  ["mp4: MP3 22.05kHz (MPEG-2, 576 샘플/프레임)", 'a037c2f39716ea34ad37bbf303d737576f10a2aea0d608f4b1889ea9588e259f', 47553],
  ["mov: MP3 22.05kHz", '1a5e9292ac1d1282a96815cac3aeb9715dad0caf46af79d53653d1a0f12ba490', 47601],
  ["mp4: 전부 키프레임 + 같은 크기 (stss 생략, stsz 고정)", '198cc7938f2e0397a2c93360c94053215f9309e264ff8ddc1aedddc59324baa9', 78961],
  ["mp4: 오디오 비트레이트 미지정 (추정)", 'f5c9be1f22c919355e1d8643c20fbd3d90807509845e64d54925e041a84fb196', 63636],
  ["mp4: 저장소 참조 스트리밍 (합성 600프레임 + 900 MP3 프레임)", 'df77be25aa15a47c3919cdc7c88c833f26b2cd5b94bf0411ed066955277ef1a7', 997904],
  ["mov: 저장소 참조 스트리밍 (합성)", '150234938fd3c9851b045730a13dcd3d2240558314c7db1a4147c60404edbae0', 997952],
  ["mp4: 4GB 초과 계획 (co64, 64비트 mdat) head+moov", 'f59b50fb9a91bbd86fd56c8ae991e4fa616f82b7e737a83decf1931058ccba5d', 58131],
  ["avi: 픽스처 영상 + MP3 44.1kHz", '2c8852904f04072ef4a521dcfdcf97968ce94535319bbcaa8c8131732076a21e', 65172],
  ["avi: 영상만", '5f3024c80945e780764867f4e1df2016294f8069c5612ff63f8d0705934ea676', 30534],
  ["avi: 빈 슬롯 (sparse)", 'a3a44f778bc6abd6381863390944109c5e43fef8fff2116c14a1dec734311f82', 5202],
  ["avi: 같은 슬롯으로 몰린 프레임 (bunched) + 오디오", '418852f2d339b043d37c9d2dcf50bdae5d71894342164c6930f46e6b82b1cdeb', 42068],
  ["avi: 짧은 영상 + 긴 오디오 (빈 슬롯 덧붙임)", '95b1e36d71776ea776e9ee9ce50297c3f5076e8a970a5b7352b88a2d77f55966', 41418],
  ["avi: 29.97fps + MP3 48kHz", 'd5b08d2c6947602bfd0926fba669dc93ba8d1378df7611b88a5669850b93bbe0', 73536],
  ["avi: MP3 22.05kHz (576 샘플/프레임)", 'c2131b8c87ff991850685b25f77032d3cb018ae98e7239f1216f6475a46744b7', 49178],
  ["avi: 저장소 참조 스트리밍 (합성)", 'cb1bbc12e426ac93f4987554eb985d6da1e2ebc9bb72fba371c5259e823635df', 1020406],
];

const fixtures = { video: loadFixtureVideo(), audio: makeMp3Audio(2), audio48: makeMp3Audio(2, 48000, 160), audio22: makeMp3Audio(2, 22050, 64) };
const cases = goldenCases({ buildMp4, planMp4, writeMp4, buildAvi, writeAvi, MemoryChunkStore, MemoryFileSink }, fixtures);

test('골든 케이스 목록이 기준값 표와 일치한다', () => {
  assert.deepEqual(cases.map(c => c.name), GOLDEN.map(g => g[0]));
});

for (const [name, hash, bytes] of GOLDEN) {
  test(`골든: ${name} → 이전 구현과 바이트 단위로 같다`, async () => {
    const c = cases.find(x => x.name === name);
    const out = await c.run();
    assert.equal(out.length, bytes, '크기');
    assert.equal(sha256(out), hash, 'SHA-256');
  });
}

// ---- typed array(SampleIndex) 경로 = 배열 경로 ----
const CREATION_TIME = new Date(Date.UTC(2026, 0, 1));

/** 배열 형식 트랙을 저장소 + SampleIndex 형식으로 (VideoTrackEncoder / ContainerAudioEncoder의 저장소 경로와 같은 모양) */
async function toIndexed(video, audio, makeStore = () => new MemoryChunkStore()) {
  const vStore = makeStore('video.bin');
  const vIndex = new SampleIndex({ kind: 'video' });
  for (const s of video.samples) {
    const ref = vStore.append(s.data);
    vIndex.push(ref.offset, ref.size, s.timestamp, !!s.keyframe, countNals(s.data));
  }
  await vStore.finalize();
  let indexedAudio = null;
  if (audio) {
    const aStore = makeStore('audio.bin');
    const aIndex = new SampleIndex({ kind: 'audio' });
    for (const f of audio.frames) {
      const ref = aStore.append(f.data);
      aIndex.pushFrame(ref.offset, ref.size, f.samples);
    }
    await aStore.finalize();
    indexedAudio = { codec: 'mp3', sampleRate: audio.sampleRate, channels: audio.channels, bitrate: audio.bitrate, index: aIndex, store: aStore };
  }
  return { video: { width: video.width, height: video.height, avcC: video.avcC, index: vIndex, store: vStore }, audio: indexedAudio };
}

function countNals(data) {
  let off = 0, n = 0;
  while (off + 4 <= data.length) { const len = new DataView(data.buffer, data.byteOffset + off, 4).getUint32(0); off += 4; if (len <= 0 || off + len > data.length) break; off += len; n++; }
  return n;
}

const blobBytes = async (r) => new Uint8Array(await r.blob.arrayBuffer());

for (const container of ['mp4', 'mov']) {
  test(`${container.toUpperCase()}: SampleIndex 입력으로 스트리밍 작성한 파일이 배열 입력 buildMp4와 바이트 단위로 같다 (픽스처)`, async () => {
    const expected = concatAll(buildMp4({ container, video: fixtures.video, audio: fixtures.audio, creationTime: CREATION_TIME }));
    const indexed = await toIndexed(fixtures.video, fixtures.audio);
    const actual = await blobBytes(await writeMp4({ container, ...indexed, output: new MemoryFileSink('video/mp4'), creationTime: CREATION_TIME }));
    assert.equal(actual.length, expected.length);
    assert.equal(sha256(actual), sha256(expected));
  });
}

test('MP4: SampleIndex 입력 + timestampAt(정렬 오프셋 접근자)은 같은 타임스탬프를 가진 배열 입력과 같은 파일을 만든다', async () => {
  const shift = (i, ts) => (i === 0 ? 0 : ts + 150_000);
  const arrayVideo = { ...fixtures.video, samples: fixtures.video.samples.map((s, i) => ({ ...s, timestamp: shift(i, s.timestamp) })) };
  const expected = concatAll(buildMp4({ container: 'mp4', video: arrayVideo, audio: fixtures.audio, creationTime: CREATION_TIME }));
  const indexed = await toIndexed(fixtures.video, fixtures.audio);
  const raw = indexed.video.index;
  indexed.video.timestampAt = (i) => shift(i, raw.timestampAt(i));
  const actual = await blobBytes(await writeMp4({ container: 'mp4', ...indexed, output: new MemoryFileSink('video/mp4'), creationTime: CREATION_TIME }));
  assert.equal(sha256(actual), sha256(expected));
});

test('MP4: SampleIndex 입력 + OPFS(가짜) 저장소/싱크도 같은 파일을 만든다', async () => {
  const root = new FakeDirectoryHandle();
  const expected = concatAll(buildMp4({ container: 'mp4', video: fixtures.video, audio: fixtures.audio, creationTime: CREATION_TIME }));
  const indexed = await toIndexed(fixtures.video, fixtures.audio, (name) => new OpfsChunkStore(root, name, { bufferBytes: 4096 }));
  const actual = await blobBytes(await writeMp4({ container: 'mp4', ...indexed, output: new OpfsFileSink(root, 'out.mp4', 'video/mp4'), creationTime: CREATION_TIME }));
  assert.equal(sha256(actual), sha256(expected));
});

test('MP4: SampleIndex 입력의 오디오 없음/영상만도 배열 입력과 같다', async () => {
  const expected = concatAll(buildMp4({ container: 'mp4', video: fixtures.video, audio: null, creationTime: CREATION_TIME }));
  const indexed = await toIndexed(fixtures.video, null);
  const actual = await blobBytes(await writeMp4({ container: 'mp4', ...indexed, output: new MemoryFileSink('video/mp4'), creationTime: CREATION_TIME }));
  assert.equal(sha256(actual), sha256(expected));
});

test('AVI: SampleIndex 입력(nalCount 포함)으로 스트리밍 작성한 파일이 배열 입력 buildAvi와 바이트 단위로 같다 (픽스처)', async () => {
  const expected = concatAll(buildAvi({ video: fixtures.video, audio: fixtures.audio, frameRate: 30 }));
  const indexed = await toIndexed(fixtures.video, fixtures.audio);
  const actual = await blobBytes(await writeAvi({ ...indexed, frameRate: 30, output: new MemoryFileSink('video/x-msvideo') }));
  assert.equal(actual.length, expected.length);
  assert.equal(sha256(actual), sha256(expected));
});

test('MP4/AVI: 합성 트랙(지터·몰림·빈 슬롯)에서도 SampleIndex 경로 = 배열(data) 경로', async () => {
  const synth = syntheticTracks({ videoCount: 400, audioCount: 650, seed: 11 });
  const video = { width: 640, height: 360, avcC: fixtures.video.avcC, samples: synth.video };
  const audio = { codec: 'mp3', sampleRate: 48000, channels: 2, bitrate: 128000, frames: synth.audio };
  const mp4 = concatAll(buildMp4({ container: 'mp4', video, audio, creationTime: CREATION_TIME }));
  const avi = concatAll(buildAvi({ video, audio, frameRate: 30 }));
  const indexed = await toIndexed(video, audio);
  assert.equal(sha256(await blobBytes(await writeMp4({ container: 'mp4', ...indexed, output: new MemoryFileSink('video/mp4'), creationTime: CREATION_TIME }))), sha256(mp4));
  assert.equal(sha256(await blobBytes(await writeAvi({ ...indexed, frameRate: 30, output: new MemoryFileSink('video/x-msvideo') }))), sha256(avi));
});

test('planMp4/planAvi: SampleIndex 입력에 샘플이 없으면 배열 입력과 같은 오류를 던진다', async () => {
  const empty = { width: 160, height: 120, avcC: fixtures.video.avcC, index: new SampleIndex({ kind: 'video' }), store: new MemoryChunkStore() };
  assert.throws(() => planMp4({ container: 'mp4', video: empty, audio: null }), /샘플/);
  await assert.rejects(() => writeAvi({ video: empty, audio: null, frameRate: 30, output: new MemoryFileSink('video/x-msvideo') }), /샘플/);
  assert.throws(() => planMp4({ container: 'mp4', video: { ...empty, index: new SampleIndex({ kind: 'audio' }) } }), /video/);
});
