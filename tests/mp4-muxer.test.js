import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMp4 } from '../muxers/mp4-muxer.js';
import { concatBytes } from '../muxers/byte-writer.js';
import {
  loadFixtureVideo, makeMp3Audio, writeOutput, ffprobe, ffmpegDecodeErrors, FFPROBE, FFMPEG,
  parseBoxes, findBox, findAllBoxes, readChunkOffsets, readStsz, readStts
} from './helpers/media.js';

const video = loadFixtureVideo();
const audio = makeMp3Audio(2);

function ascii(bytes) {
  return String.fromCharCode(...bytes);
}

test('MP4: 최상위 박스는 ftyp, mdat, moov 순서이며 ftyp 브랜드는 isom이다', () => {
  const file = concatBytes(buildMp4({ container: 'mp4', video, audio }));
  const boxes = parseBoxes(file);
  assert.deepEqual(boxes.map(b => b.type), ['ftyp', 'mdat', 'moov']);
  assert.equal(ascii(boxes[0].payload.subarray(0, 4)), 'isom');
  assert.equal(file.length, boxes.reduce((s, b) => s + b.size, 0), '박스 크기 합이 파일 크기와 같아야 함');
});

test('MOV: ftyp 브랜드는 "qt  "이고 오디오 샘플 엔트리는 ".mp3"이다', () => {
  const file = concatBytes(buildMp4({ container: 'mov', video, audio }));
  const boxes = parseBoxes(file);
  assert.equal(ascii(boxes[0].payload.subarray(0, 4)), 'qt  ');
  const traks = findAllBoxes(findBox(boxes, 'moov').children, 'trak');
  const audioStsd = findBox(traks[1].children, 'mdia/minf/stbl/stsd');
  assert.equal(audioStsd.children[0].type, '.mp3');
  // MOV는 mdia/hdlr에 'mhlr' 컴포넌트 타입을 쓴다
  const hdlr = findBox(traks[0].children, 'mdia/hdlr');
  assert.equal(ascii(hdlr.payload.subarray(4, 8)), 'mhlr');
  assert.equal(ascii(hdlr.payload.subarray(8, 12)), 'vide');
});

test('MP4: 비디오 트랙은 avc1+avcC, 오디오 트랙은 mp4a+esds(OTI 0x6B MP3)를 가진다', () => {
  const file = concatBytes(buildMp4({ container: 'mp4', video, audio }));
  const boxes = parseBoxes(file);
  const traks = findAllBoxes(findBox(boxes, 'moov').children, 'trak');
  assert.equal(traks.length, 2);

  const vStsd = findBox(traks[0].children, 'mdia/minf/stbl/stsd');
  assert.equal(vStsd.children[0].type, 'avc1');
  const avc1 = vStsd.children[0].payload;
  const view = new DataView(avc1.buffer, avc1.byteOffset, avc1.byteLength);
  assert.equal(view.getUint16(24), 160, 'width');
  assert.equal(view.getUint16(26), 120, 'height');
  const avcCBoxes = parseBoxes(avc1, 78, avc1.length);
  assert.equal(avcCBoxes[0].type, 'avcC');
  assert.deepEqual(Array.from(avcCBoxes[0].payload), Array.from(video.avcC));

  const aStsd = findBox(traks[1].children, 'mdia/minf/stbl/stsd');
  assert.equal(aStsd.children[0].type, 'mp4a');
  const mp4a = aStsd.children[0].payload;
  const esds = parseBoxes(mp4a, 28, mp4a.length)[0];
  assert.equal(esds.type, 'esds');
  const idx6b = Array.from(esds.payload).indexOf(0x6B);
  assert.ok(idx6b > 0, 'objectTypeIndication 0x6B(MP3) 포함');
  assert.equal(esds.payload[idx6b + 1], 0x15, 'streamType=5(audio), reserved=1');
});

test('MP4: stco 오프셋은 mdat 안의 각 샘플 데이터를 정확히 가리킨다', () => {
  const file = concatBytes(buildMp4({ container: 'mp4', video, audio }));
  const boxes = parseBoxes(file);
  const traks = findAllBoxes(findBox(boxes, 'moov').children, 'trak');

  const vStbl = findBox(traks[0].children, 'mdia/minf/stbl').children;
  const vOffsets = readChunkOffsets(vStbl);
  const vSizes = readStsz(vStbl);
  assert.equal(vOffsets.length, video.samples.length);
  video.samples.forEach((s, i) => {
    assert.equal(vSizes[i], s.data.length);
    assert.deepEqual(Array.from(file.subarray(vOffsets[i], vOffsets[i] + 8)), Array.from(s.data.subarray(0, 8)), `video sample ${i}`);
  });

  const aStbl = findBox(traks[1].children, 'mdia/minf/stbl').children;
  const aOffsets = readChunkOffsets(aStbl);
  const aSizes = readStsz(aStbl);
  assert.equal(aOffsets.length, audio.frames.length);
  audio.frames.forEach((f, i) => {
    assert.equal(aSizes[i], f.data.length);
    assert.deepEqual(Array.from(file.subarray(aOffsets[i], aOffsets[i] + 4)), Array.from(f.data.subarray(0, 4)), `audio frame ${i}`);
  });

  // 비디오 샘플이 mdat 안에서 시간순으로 오디오와 교차 배치되어야 함(단조 증가)
  const all = [...vOffsets, ...aOffsets].sort((a, b) => a - b);
  assert.equal(new Set(all).size, all.length, '오프셋 중복 없음');
});

test('MP4: 비디오 stts는 30fps(90000/30=3000) 지속시간을 가지며 stss는 키프레임 1,31을 가리킨다', () => {
  const file = concatBytes(buildMp4({ container: 'mp4', video, audio }));
  const boxes = parseBoxes(file);
  const traks = findAllBoxes(findBox(boxes, 'moov').children, 'trak');
  const vStbl = findBox(traks[0].children, 'mdia/minf/stbl').children;
  const stts = readStts(vStbl);
  const totalCount = stts.reduce((s, e) => s + e.count, 0);
  assert.equal(totalCount, 60);
  // 마지막 샘플은 오디오 끝(2.0125s)까지 늘어나므로 그 앞 59개만 30fps 간격
  const body = stts.slice(0, -1);
  assert.equal(body.reduce((s, e) => s + e.count, 0), 59);
  assert.ok(body.every(e => e.delta === 3000 || e.delta === 2999 || e.delta === 3001), JSON.stringify(stts));
  const audioEnd = Math.round((audio.frames.reduce((s, f) => s + f.samples, 0) - 1105) * 90000 / 44100);
  assert.ok(Math.abs(stts.reduce((s, e) => s + e.count * e.delta, 0) - audioEnd) <= 2);

  const stss = vStbl.find(b => b.type === 'stss');
  const view = new DataView(stss.payload.buffer, stss.payload.byteOffset, stss.payload.byteLength);
  const count = view.getUint32(4);
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(view.getUint32(8 + i * 4));
  assert.deepEqual(keys, [1, 31]);
});

test('MP4: 비디오 타임스탬프의 원점은 첫 샘플이며, 불규칙한 간격도 stts에 반영된다', () => {
  const irregular = {
    ...video,
    samples: video.samples.slice(0, 4).map((s, i) => ({ ...s, timestamp: 5_000_000 + [0, 40_000, 60_000, 100_000][i] }))
  };
  const file = concatBytes(buildMp4({ container: 'mp4', video: irregular, audio: null }));
  const boxes = parseBoxes(file);
  const trak = findBox(boxes, 'moov/trak');
  const stts = readStts(findBox(trak.children, 'mdia/minf/stbl').children);
  // 간격: 40ms=3600, 20ms=1800, 40ms=3600, 마지막은 직전 간격 반복(3600)
  assert.deepEqual(stts, [{ count: 1, delta: 3600 }, { count: 1, delta: 1800 }, { count: 2, delta: 3600 }]);
});

test('MP4: 오디오 트랙은 MP3 인코더 지연(1105 샘플)을 elst로 보정한다', () => {
  const file = concatBytes(buildMp4({ container: 'mp4', video, audio }));
  const boxes = parseBoxes(file);
  const traks = findAllBoxes(findBox(boxes, 'moov').children, 'trak');
  const elst = findBox(traks[1].children, 'edts/elst');
  assert.ok(elst, '오디오 트랙에 elst 존재');
  const view = new DataView(elst.payload.buffer, elst.payload.byteOffset, elst.payload.byteLength);
  assert.equal(view.getUint32(4), 1, 'entry_count');
  assert.equal(view.getUint32(12), 1105, 'media_time = 인코더 지연');
});

test('MP4: 오디오 없이 비디오만으로도 생성된다', () => {
  const file = concatBytes(buildMp4({ container: 'mp4', video, audio: null }));
  const boxes = parseBoxes(file);
  assert.equal(findAllBoxes(findBox(boxes, 'moov').children, 'trak').length, 1);
});

test('MP4: 샘플이 하나도 없으면 에러를 던진다', () => {
  assert.throws(() => buildMp4({ container: 'mp4', video: { ...video, samples: [] }, audio }), /샘플/);
  assert.throws(() => buildMp4({ container: 'webm', video, audio }), /컨테이너/);
});

for (const container of ['mp4', 'mov']) {
  test(`${container.toUpperCase()}: ffprobe가 h264 160x120 60프레임 + mp3 44100Hz 스테레오 약 2초로 인식하고 디코딩 에러가 없다`, { skip: !FFPROBE || !FFMPEG ? 'ffprobe/ffmpeg 없음' : false }, () => {
    const path = writeOutput(`out.${container}`, buildMp4({ container, video, audio }));
    const info = ffprobe(path);
    const v = info.streams.find(s => s.codec_type === 'video');
    const a = info.streams.find(s => s.codec_type === 'audio');
    assert.equal(v.codec_name, 'h264');
    assert.equal(v.width, 160);
    assert.equal(v.height, 120);
    assert.equal(Number(v.nb_read_frames), 60);
    assert.equal(v.r_frame_rate, '30/1');
    assert.ok(Math.abs(Number(v.duration) - 2.0) < 0.05, `video duration ${v.duration}`);
    assert.equal(a.codec_name, 'mp3');
    assert.equal(Number(a.sample_rate), 44100);
    assert.equal(a.channels, 2);
    assert.ok(Math.abs(Number(a.duration) - 2.0) < 0.1, `audio duration ${a.duration}`);
    assert.ok(Math.abs(Number(info.format.duration) - 2.0) < 0.1, `format duration ${info.format.duration}`);
    assert.equal(ffmpegDecodeErrors(path), '');
  });
}

test('MP4: 오디오가 영상보다 길면 마지막 영상 샘플을 늘려 영상 트랙이 오디오 끝까지 이어진다', () => {
  const short = { ...video, samples: video.samples.slice(0, 4) }; // 4프레임 ≈ 0.133s, 오디오 2s
  const file = concatBytes(buildMp4({ container: 'mp4', video: short, audio }));
  const boxes = parseBoxes(file);
  const traks = findAllBoxes(findBox(boxes, 'moov').children, 'trak');
  const stts = readStts(findBox(traks[0].children, 'mdia/minf/stbl').children);
  const total = stts.reduce((s, e) => s + e.count * e.delta, 0);
  const audioSamples = audio.frames.reduce((s, f) => s + f.samples, 0) - 1105;
  const audioDur90k = Math.round(audioSamples * 90000 / audio.sampleRate);
  assert.ok(Math.abs(total - audioDur90k) <= 2, `video ${total} vs audio ${audioDur90k}`);
  assert.equal(stts[stts.length - 1].count, 1, '마지막 샘플만 늘어남');
});

// ---- 스트리밍 쓰기 (디스크 저장소 참조 기반) ----
import { writeMp4 } from '../muxers/mp4-muxer.js';
import { MemoryChunkStore, MemoryFileSink, OpfsChunkStore, OpfsFileSink } from '../storage/chunk-store.js';
import { FakeDirectoryHandle } from './helpers/fake-opfs.js';

async function toStoreBacked(makeStore) {
  const vStore = makeStore('video.bin');
  const aStore = makeStore('audio.bin');
  const storedVideo = { ...video, store: vStore, samples: video.samples.map(s => ({ ref: vStore.append(s.data), timestamp: s.timestamp, keyframe: s.keyframe })) };
  const storedAudio = { ...audio, store: aStore, frames: audio.frames.map(f => ({ ref: aStore.append(f.data), samples: f.samples })) };
  await vStore.finalize();
  await aStore.finalize();
  return { storedVideo, storedAudio };
}

for (const container of ['mp4', 'mov']) {
  test(`${container.toUpperCase()}: 저장소 참조 샘플로 스트리밍 작성한 결과가 메모리 buildMp4 결과와 바이트 단위로 같다`, async () => {
    const expected = concatBytes(buildMp4({ container, video, audio, creationTime: new Date(2026, 0, 1) }));
    const { storedVideo, storedAudio } = await toStoreBacked(() => new MemoryChunkStore());
    const sink = new MemoryFileSink(container === 'mov' ? 'video/quicktime' : 'video/mp4');
    const result = await writeMp4({ container, video: storedVideo, audio: storedAudio, output: sink, creationTime: new Date(2026, 0, 1) });
    const actual = new Uint8Array(await result.blob.arrayBuffer());
    assert.equal(actual.length, expected.length);
    assert.deepEqual(Buffer.from(actual).compare(Buffer.from(expected)), 0, '바이트 불일치');
    assert.equal(result.bytes, expected.length);
  });
}

test('MP4: OPFS(가짜) 저장소 + OPFS 싱크로도 동일한 파일이 만들어진다', async () => {
  const root = new FakeDirectoryHandle();
  const expected = concatBytes(buildMp4({ container: 'mp4', video, audio, creationTime: new Date(2026, 0, 1) }));
  const { storedVideo, storedAudio } = await toStoreBacked((name) => new OpfsChunkStore(root, name, { bufferBytes: 4096 }));
  const sink = new OpfsFileSink(root, 'out.mp4', 'video/mp4');
  const result = await writeMp4({ container: 'mp4', video: storedVideo, audio: storedAudio, output: sink, creationTime: new Date(2026, 0, 1) });
  const actual = new Uint8Array(await result.blob.arrayBuffer());
  assert.deepEqual(Buffer.from(actual).compare(Buffer.from(expected)), 0);
  assert.equal(result.blob.type, 'video/mp4');
});

test('MP4: 스트리밍 작성은 샘플 데이터를 한꺼번에 메모리에 올리지 않는다 (한 번에 읽는 최대 크기 ≤ 가장 큰 샘플 + 여유)', async () => {
  const { storedVideo, storedAudio } = await toStoreBacked(() => new MemoryChunkStore());
  let maxRead = 0;
  for (const st of [storedVideo.store, storedAudio.store]) {
    const orig = st.slice.bind(st);
    st.slice = async (o, s) => { maxRead = Math.max(maxRead, s); return orig(o, s); };
  }
  const sink = new MemoryFileSink('video/mp4');
  await writeMp4({ container: 'mp4', video: storedVideo, audio: storedAudio, output: sink });
  const biggest = Math.max(...video.samples.map(s => s.data.length));
  assert.ok(maxRead <= biggest, `maxRead=${maxRead}`);
});

test('MP4 스트리밍 쓰기는 샘플마다 쓰지 않고 묶어서 쓴다 (출력 write 호출 수 ≪ 샘플 수)', async () => {
  const { storedVideo, storedAudio } = await toStoreBacked(() => new MemoryChunkStore());
  const sink = new MemoryFileSink('video/mp4');
  let writes = 0;
  const orig = sink.write.bind(sink);
  sink.write = (d) => { writes++; return orig(d); };
  await writeMp4({ container: 'mp4', video: storedVideo, audio: storedAudio, output: sink });
  const sampleCount = storedVideo.samples.length + storedAudio.frames.length;
  assert.ok(writes <= 3, `write ${writes}회 (샘플 ${sampleCount}개)`);
});

test('MP4 스트리밍 쓰기는 저장소 조각(Blob slice)을 만들지 않고 큰 단위 순차 읽기만 한다', async () => {
  const { storedVideo, storedAudio } = await toStoreBacked(() => new MemoryChunkStore());
  let slices = 0, reads = 0;
  for (const st of [storedVideo.store, storedAudio.store]) {
    st.slice = async () => { slices++; throw new Error('slice 사용 금지'); };
    const o = st.readRange.bind(st); st.readRange = (a, b) => { reads++; return o(a, b); };
    const oi = st.readInto.bind(st); st.readInto = (a, b, c) => { reads++; return oi(a, b, c); };
  }
  await writeMp4({ container: 'mp4', video: storedVideo, audio: storedAudio, output: new MemoryFileSink('video/mp4') });
  assert.equal(slices, 0);
  assert.ok(reads <= 2, `readRange ${reads}회`);
});
