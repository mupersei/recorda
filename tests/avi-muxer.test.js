import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAvi, assignFrameSlots } from '../muxers/avi-muxer.js';
import { concatBytes, fourcc } from '../muxers/byte-writer.js';
import {
  loadFixtureVideo, makeMp3Audio, writeOutput, ffprobe, ffmpegDecodeErrors, FFPROBE, FFMPEG, parseRiff
} from './helpers/media.js';

const video = loadFixtureVideo();
const audio = makeMp3Audio(2);
// 오디오(2.037s, LAME 패딩 포함)가 영상(2.0s)보다 조금 길어 영상 슬롯은 ceil(2.037*30)=62가 됨
const audioSeconds = audio.frames.reduce((s, f) => s + f.samples, 0) / audio.sampleRate;
const EXPECTED_SLOTS = Math.max(60, Math.ceil(audioSeconds * 30));

function le32(bytes, off) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(off, true);
}

test('assignFrameSlots: 고정 프레임레이트 타임라인에 프레임을 배치하고 빈 슬롯을 채운다', () => {
  const slots = assignFrameSlots([0, 33_333, 100_000, 133_333], 30);
  // 100ms는 슬롯 3 → 슬롯 2는 비어 있어야 함
  assert.deepEqual(slots, [0, 1, 3, 4]);
});

test('assignFrameSlots: 같은 슬롯으로 몰리는 프레임은 드롭하지 않고 다음 슬롯으로 밀어낸다', () => {
  const slots = assignFrameSlots([0, 5_000, 10_000, 100_000], 30);
  assert.deepEqual(slots, [0, 1, 2, 3]);
});

test('assignFrameSlots: 원점은 첫 프레임 타임스탬프이다', () => {
  assert.deepEqual(assignFrameSlots([7_000_000, 7_033_333], 30), [0, 1]);
});

test('AVI: RIFF/AVI 구조와 hdrl, movi, idx1 청크를 갖는다', () => {
  const file = concatBytes(buildAvi({ video, audio, frameRate: 30 }));
  const riff = parseRiff(file);
  assert.equal(riff.length, 1);
  assert.equal(riff[0].id, 'RIFF');
  assert.equal(riff[0].listType, 'AVI ');
  assert.equal(riff[0].size + 8, file.length, 'RIFF 크기 = 파일 크기 - 8');
  const top = riff[0].children;
  assert.deepEqual(top.map(c => c.listType || c.id), ['hdrl', 'movi', 'idx1']);
  const hdrl = top[0].children;
  assert.equal(hdrl[0].id, 'avih');
  assert.deepEqual(hdrl.slice(1).map(c => c.listType), ['strl', 'strl']);
});

test('AVI: avih/strh 헤더는 30fps, 160x120, H264/MP3 스트림 정보를 담는다', () => {
  const file = concatBytes(buildAvi({ video, audio, frameRate: 30 }));
  const top = parseRiff(file)[0].children;
  const avih = top[0].children[0].payload;
  assert.equal(le32(avih, 0), Math.round(1_000_000 / 30), 'dwMicroSecPerFrame');
  assert.equal(le32(avih, 12) & 0x10, 0x10, 'AVIF_HASINDEX');
  assert.equal(le32(avih, 16), EXPECTED_SLOTS, 'dwTotalFrames (오디오 길이까지 확장)');
  assert.equal(le32(avih, 24), 2, 'dwStreams');
  assert.equal(le32(avih, 32), 160);
  assert.equal(le32(avih, 36), 120);

  const [vStrl, aStrl] = top[0].children.slice(1);
  const vStrh = vStrl.children.find(c => c.id === 'strh').payload;
  assert.equal(le32(vStrh, 0), fourcc('vids'));
  assert.equal(le32(vStrh, 4), fourcc('H264'));
  assert.equal(le32(vStrh, 20), 1000, 'dwScale');
  assert.equal(le32(vStrh, 24), 30000, 'dwRate');
  assert.equal(le32(vStrh, 32), EXPECTED_SLOTS, 'dwLength');
  const vStrf = vStrl.children.find(c => c.id === 'strf').payload;
  assert.equal(le32(vStrf, 0), 40, 'biSize');
  assert.equal(le32(vStrf, 4), 160);
  assert.equal(le32(vStrf, 8), 120);
  assert.equal(le32(vStrf, 16), fourcc('H264'), 'biCompression');

  const aStrh = aStrl.children.find(c => c.id === 'strh').payload;
  assert.equal(le32(aStrh, 0), fourcc('auds'));
  assert.equal(le32(aStrh, 20), 1152, 'dwScale = MP3 프레임 샘플수');
  assert.equal(le32(aStrh, 24), 44100, 'dwRate');
  assert.equal(le32(aStrh, 32), audio.frames.length, 'dwLength = 프레임 수');
  assert.equal(le32(aStrh, 44), 0, 'dwSampleSize = 0 (프레임 단위)');
  const aStrf = aStrl.children.find(c => c.id === 'strf').payload;
  const dv = new DataView(aStrf.buffer, aStrf.byteOffset, aStrf.byteLength);
  assert.equal(dv.getUint16(0, true), 0x55, 'wFormatTag MP3');
  assert.equal(dv.getUint16(2, true), 2, 'channels');
  assert.equal(le32(aStrf, 4), 44100);
  assert.equal(le32(aStrf, 8), 128000 / 8, 'nAvgBytesPerSec');
  assert.equal(dv.getUint16(12, true), 1152, 'nBlockAlign = 프레임 샘플 수 (libavformat 타이밍 호환)');
  assert.equal(dv.getUint16(16, true), 12, 'cbSize (MPEGLAYER3WAVEFORMAT)');
});

test('AVI: movi 청크는 Annex B 영상(키프레임에 SPS/PPS 포함)과 MP3 프레임을 교차 배치하고 idx1이 모두를 가리킨다', () => {
  const file = concatBytes(buildAvi({ video, audio, frameRate: 30 }));
  const top = parseRiff(file)[0].children;
  const movi = top[1];
  const chunks = movi.children;
  const videoChunks = chunks.filter(c => c.id === '00dc');
  const audioChunks = chunks.filter(c => c.id === '01wb');
  assert.equal(videoChunks.length, EXPECTED_SLOTS);
  assert.ok(videoChunks.slice(60).every(c => c.size === 0), '확장된 슬롯은 빈 청크');
  assert.equal(audioChunks.length, audio.frames.length);
  assert.equal(chunks[0].id, '00dc', '첫 청크는 비디오');
  // 첫 비디오 청크: 시작 코드 + SPS(0x67)
  assert.deepEqual(Array.from(videoChunks[0].payload.subarray(0, 5)), [0, 0, 0, 1, 0x67]);
  // 두 번째(P-프레임) 청크는 SPS 없이 슬라이스로 시작
  assert.deepEqual(Array.from(videoChunks[1].payload.subarray(0, 4)), [0, 0, 0, 1]);
  assert.notEqual(videoChunks[1].payload[4], 0x67);

  const idx1 = top[2].payload;
  const entryCount = idx1.length / 16;
  assert.equal(entryCount, chunks.length);
  // 오프셋은 'movi' fourcc 위치 기준 (첫 청크 = 4)
  const moviDataStart = movi.offset + 8;
  for (let i = 0; i < entryCount; i++) {
    const id = String.fromCharCode(...idx1.subarray(i * 16, i * 16 + 4));
    const flags = le32(idx1, i * 16 + 4);
    const off = le32(idx1, i * 16 + 8);
    const len = le32(idx1, i * 16 + 12);
    assert.equal(id, chunks[i].id);
    assert.equal(moviDataStart + off, chunks[i].offset, `idx1 오프셋 ${i}`);
    assert.equal(len, chunks[i].size);
    if (id === '00dc') {
      const expectKey = i === 0 || (video.samples.find(s => s.data.length === 0) ? false : undefined);
      if (expectKey !== undefined) assert.equal((flags & 0x10) !== 0, expectKey, 'AVIIF_KEYFRAME');
    } else {
      assert.equal(flags & 0x10, 0x10, '오디오 청크는 항상 키프레임 플래그');
    }
  }
});

test('AVI: 프레임 간격이 비면 길이 0인 00dc 청크로 채워 타이밍을 유지한다', () => {
  const sparse = {
    ...video,
    samples: [0, 1, 3].map(i => ({ ...video.samples[i], timestamp: [0, 33_333, 100_000][[0, 1, 3].indexOf(i)] }))
  };
  const file = concatBytes(buildAvi({ video: sparse, audio: null, frameRate: 30 }));
  const top = parseRiff(file)[0].children;
  const videoChunks = top[1].children.filter(c => c.id === '00dc');
  assert.equal(videoChunks.length, 4, '슬롯 0,1,(빈)2,3');
  assert.equal(videoChunks[2].size, 0);
  assert.equal(le32(top[0].children[0].payload, 16), 4, 'dwTotalFrames는 슬롯 수');
});

test('AVI: 샘플이 없거나 컨테이너 오디오 코덱이 MP3가 아니면 에러를 던진다', () => {
  assert.throws(() => buildAvi({ video: { ...video, samples: [] }, audio, frameRate: 30 }), /샘플/);
  assert.throws(() => buildAvi({ video, audio: { ...audio, codec: 'aac' }, frameRate: 30 }), /코덱/);
});

test('AVI: ffprobe가 h264 160x120 30fps 60프레임 + mp3로 인식하고 디코딩 에러가 없다', { skip: !FFPROBE || !FFMPEG ? 'ffprobe/ffmpeg 없음' : false }, () => {
  const path = writeOutput('out.avi', buildAvi({ video, audio, frameRate: 30 }));
  const info = ffprobe(path);
  const v = info.streams.find(s => s.codec_type === 'video');
  const a = info.streams.find(s => s.codec_type === 'audio');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 160);
  assert.equal(v.height, 120);
  assert.equal(v.r_frame_rate, '30/1');
  assert.equal(Number(v.nb_read_frames), 60);
  assert.ok(Math.abs(Number(v.duration) - EXPECTED_SLOTS / 30) < 0.05, `video duration ${v.duration} (슬롯 ${EXPECTED_SLOTS})`);
  assert.equal(a.codec_name, 'mp3');
  assert.equal(Number(a.sample_rate), 44100);
  assert.equal(a.channels, 2);
  assert.ok(Math.abs(Number(a.duration) - 2.0) < 0.1, `audio duration ${a.duration}`);
  assert.equal(ffmpegDecodeErrors(path), '');
});

test('AVI: 오디오가 영상보다 길면 빈 영상 청크를 덧붙여 dwTotalFrames가 오디오 길이를 덮는다', () => {
  const short = { ...video, samples: video.samples.slice(0, 4) };
  const file = concatBytes(buildAvi({ video: short, audio, frameRate: 30 }));
  const top = parseRiff(file)[0].children;
  const totalFrames = le32(top[0].children[0].payload, 16);
  const audioSec = audio.frames.reduce((s, f) => s + f.samples, 0) / audio.sampleRate;
  assert.ok(totalFrames >= Math.floor(audioSec * 30) && totalFrames <= Math.ceil(audioSec * 30) + 1, `totalFrames=${totalFrames}`);
  const videoChunks = top[1].children.filter(c => c.id === '00dc');
  assert.equal(videoChunks.length, totalFrames);
  assert.ok(videoChunks.slice(4).every(c => c.size === 0));
});

// ---- 스트리밍 쓰기 (디스크 저장소 참조 기반) ----
import { writeAvi, countNalUnits } from '../muxers/avi-muxer.js';
import { MemoryChunkStore, MemoryFileSink } from '../storage/chunk-store.js';

test('countNalUnits는 길이 접두 AVC 샘플의 NAL 개수를 센다', () => {
  const sample = new Uint8Array([0, 0, 0, 2, 0x65, 1, 0, 0, 0, 3, 0x41, 2, 3]);
  assert.equal(countNalUnits(sample, 4), 2);
});

test('AVI: 저장소 참조 샘플(AVC 형식 + nalCount)로 스트리밍 작성한 결과가 메모리 buildAvi 결과와 바이트 단위로 같다', async () => {
  const expected = concatBytes(buildAvi({ video, audio, frameRate: 30 }));
  const vStore = new MemoryChunkStore();
  const aStore = new MemoryChunkStore();
  const storedVideo = { ...video, store: vStore, samples: video.samples.map(s => ({ ref: vStore.append(s.data), nalCount: countNalUnits(s.data, 4), timestamp: s.timestamp, keyframe: s.keyframe })) };
  const storedAudio = { ...audio, store: aStore, frames: audio.frames.map(f => ({ ref: aStore.append(f.data), samples: f.samples })) };
  await vStore.finalize();
  await aStore.finalize();
  const sink = new MemoryFileSink('video/x-msvideo');
  const result = await writeAvi({ video: storedVideo, audio: storedAudio, frameRate: 30, output: sink });
  const actual = new Uint8Array(await result.blob.arrayBuffer());
  assert.equal(actual.length, expected.length, `길이 ${actual.length} vs ${expected.length}`);
  assert.equal(Buffer.from(actual).compare(Buffer.from(expected)), 0, '바이트 불일치');
});

test('AVI: 스트리밍 작성 시 예상 크기가 2GB를 넘으면 쓰기 전에 에러를 던진다', async () => {
  const vStore = new MemoryChunkStore();
  const big = { ...video, store: vStore, samples: [{ ref: { offset: 0, size: 2.5 * 1024 * 1024 * 1024 }, nalCount: 1, timestamp: 0, keyframe: true }] };
  await vStore.finalize();
  await assert.rejects(() => writeAvi({ video: big, audio: null, frameRate: 30, output: new MemoryFileSink('video/x-msvideo') }), /2GB/);
});
