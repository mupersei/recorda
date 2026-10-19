// FragmentedMp4Writer - 조각(fragmented) MP4: 녹화 중 약 2초마다 moof+mdat 조각을 바로 기록
// - 초기화 세그먼트: ftyp(iso5) + moov(빈 샘플 표 + mvex/trex, 오디오 elst 1105)
// - 조각: 키프레임이 오면(또는 2초가 지나면) 그때까지의 영상 샘플 + 오디오 프레임으로 moof(mfhd/tfhd/tfdt/trun) + mdat
// - 기록한 조각은 메모리에서 버림 (샘플 수와 무관한 메모리), 비정상 종료 시 마지막 완전한 조각까지 재생 가능
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FragmentedMp4Writer } from '../muxers/fmp4-writer.js';
import { buildMp4 } from '../muxers/mp4-muxer.js';
import { concatBytes } from '../muxers/byte-writer.js';
import { MemoryFileSink, DirectoryFileSink } from '../storage/chunk-store.js';
import { FakeDirectoryHandle } from './helpers/fake-opfs.js';
import {
  loadFixtureVideo, makeMp3Audio, writeOutput, ffprobe, ffmpegDecodeErrors, FFPROBE, FFMPEG,
  parseBoxes, findBox, findAllBoxes, readStts, readElst, readDuration, readFragments
} from './helpers/media.js';

v8.setFlagsFromString('--expose-gc');
const gc = globalThis.gc || vm.runInNewContext('gc');

const CREATION_TIME = new Date(Date.UTC(2026, 9, 18));
const SYNC = 0x02000000;
const NON_SYNC = 0x01010000;
const fixture = loadFixtureVideo(); // 160x120 30fps 2초, 키프레임 0·30

/** 픽스처(2초)를 이어 붙인 긴 영상: 키프레임 30프레임(1초)마다, 원본 타임스탬프는 startUs부터 */
function repeatedVideo(times, startUs = 3_000_000) {
  const samples = [];
  for (let r = 0; r < times; r++) {
    for (const s of fixture.samples) samples.push({ ...s, timestamp: startUs + Math.round(samples.length * 1e6 / 30) });
  }
  return { width: fixture.width, height: fixture.height, avcC: fixture.avcC, samples };
}

const AUDIO_CONFIG = (audio) => ({ codec: 'mp3', sampleRate: audio.sampleRate, channels: audio.channels, bitrate: audio.bitrate });

/** 도착 순서(영상 원본 시각 / 오디오 PCM 시각 순)로 섞어 writer에 넣음 */
function feed(writer, video, audio, { from = 0, to = Infinity } = {}) {
  const t0 = video.samples[0].timestamp;
  let i = 0, j = 0, aTime = t0;
  let n = 0;
  while (i < video.samples.length || (audio && j < audio.frames.length)) {
    const takeVideo = !audio || j >= audio.frames.length || (i < video.samples.length && video.samples[i].timestamp <= aTime);
    if (n >= from && n < to) {
      if (takeVideo) writer.addVideoSample(video.samples[i].data, { timestamp: video.samples[i].timestamp, keyframe: !!video.samples[i].keyframe, nalCount: 1 });
      else writer.addAudioFrame(audio.frames[j].data, { samples: audio.frames[j].samples });
    }
    if (takeVideo) i++; else { aTime += audio.frames[j].samples * 1e6 / audio.sampleRate; j++; }
    n++;
  }
}

async function writeFmp4({ video, audio, adjust = null, sink = new MemoryFileSink('video/mp4'), fragmentDurationUs } = {}) {
  const writer = new FragmentedMp4Writer({ sink, creationTime: CREATION_TIME, audio: audio ? AUDIO_CONFIG(audio) : null, videoTimestampAdjust: adjust, fragmentDurationUs });
  await writer.start();
  writer.setVideoConfig({ width: video.width, height: video.height, avcC: video.avcC });
  feed(writer, video, audio);
  const result = await writer.finish();
  return { writer, result, bytes: new Uint8Array(await result.blob.arrayBuffer()) };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const expandStts = (stts) => stts.flatMap(e => Array(e.count).fill(e.delta));

test('fMP4: ftyp(iso5) + 초기화 moov(빈 샘플 표, mvex/trex, 오디오 elst 1105) 뒤에 moof+mdat 조각이 이어지고 mfhd 순번은 1부터 연속이다', async () => {
  const video = repeatedVideo(3);
  const audio = makeMp3Audio(6);
  const { bytes } = await writeFmp4({ video, audio });
  const top = parseBoxes(bytes);
  assert.equal(bytes.length, sum(top.map(b => b.size)), '상자 크기 합 = 파일 크기');
  assert.deepEqual(top.slice(0, 2).map(b => b.type), ['ftyp', 'moov']);
  assert.ok(top.slice(2).every((b, k) => b.type === (k % 2 === 0 ? 'moof' : 'mdat')), `moof/mdat 반복: ${top.map(b => b.type).join(',')}`);
  const ftyp = top[0].payload;
  const brands = [0, 8, 12, 16, 20].map(o => String.fromCharCode(...ftyp.subarray(o, o + 4)));
  assert.deepEqual(brands, ['iso5', 'iso5', 'iso6', 'isom', 'mp41'], 'major iso5, compat iso5 iso6 isom mp41');

  const moov = top[1];
  const mvex = findBox(moov.children, 'mvex');
  assert.ok(mvex, 'mvex');
  const trex = findAllBoxes(mvex.children, 'trex');
  assert.deepEqual(trex.map(b => new DataView(b.payload.buffer, b.payload.byteOffset).getUint32(4)), [1, 2], '트랙별 trex');
  const traks = findAllBoxes(moov.children, 'trak');
  for (const trak of traks) {
    const stbl = findBox(trak.children, 'mdia/minf/stbl');
    for (const type of ['stts', 'stsc', 'stco']) {
      const b = stbl.children.find(x => x.type === type);
      assert.equal(new DataView(b.payload.buffer, b.payload.byteOffset).getUint32(4), 0, `${type} 항목 0개`);
    }
    const stsz = stbl.children.find(x => x.type === 'stsz');
    assert.equal(new DataView(stsz.payload.buffer, stsz.payload.byteOffset).getUint32(8), 0, 'stsz 샘플 0개');
    assert.ok(!stbl.children.some(x => x.type === 'stss'));
  }
  assert.deepEqual(readElst(traks[0].children), [], '영상은 elst 없음');
  assert.deepEqual(readElst(traks[1].children).map(e => [e.segmentDuration, e.mediaTime]), [[0, 1105]], '오디오: MP3 인코더 지연 1105, 길이 0(모든 조각에 적용)');

  const frags = readFragments(bytes);
  assert.ok(frags.length >= 6, `조각 ${frags.length}개`);
  assert.deepEqual(frags.map(f => f.sequence), frags.map((_, k) => k + 1), 'mfhd 순번 1, 2, 3, ...');
  for (const f of frags) {
    const v = f.tracks[1];
    assert.ok(v, '모든 조각에 영상');
    assert.equal(v.tfhdFlags & 0x020000, 0x020000, 'tfhd default-base-is-moof');
    assert.equal(v.tfhdFlags & 0x000020, 0x000020, 'tfhd default-sample-flags');
    assert.equal(v.trunFlags, 0x000701, '영상 trun: data-offset + duration + size + flags');
    if (f.tracks[2]) assert.equal(f.tracks[2].trunFlags & 0x000301, 0x000301, '오디오 trun: data-offset + duration + size');
  }
});

test('fMP4: 조각은 키프레임에서 시작하고(키프레임마다 조각을 닫음), 키프레임이 드물면 약 2초(2초 + 10% 여유)마다 닫는다', async () => {
  const keyEach1s = await writeFmp4({ video: repeatedVideo(4), audio: null });
  const f1 = readFragments(keyEach1s.bytes);
  assert.equal(f1.length, 8, '키프레임 1초마다 → 8초에 조각 8개');
  assert.ok(f1.every(f => f.tracks[1].samples[0].flags === SYNC), '모든 조각이 키프레임으로 시작');
  assert.ok(f1.every(f => f.tracks[1].samples.slice(1).every(s => s.flags === NON_SYNC)), '나머지는 non-sync');
  assert.ok(f1.every(f => f.tracks[1].samples.length === 30));

  // 키프레임 3초(90프레임)마다: 시간 기준(2.2초 = 66프레임)으로 닫고, 다음 키프레임에서 다시 닫음
  const sparse = repeatedVideo(5);
  sparse.samples.forEach((s, i) => { s.keyframe = i % 90 === 0; });
  const f2 = readFragments((await writeFmp4({ video: sparse, audio: null })).bytes);
  const durations = f2.map(f => sum(f.tracks[1].samples.map(s => s.duration)));
  // 시간 기준은 조각의 두 번째 샘플부터 재므로(첫 샘플 = 파일 첫 샘플인 경우) 첫 조각만 한 프레임 길 수 있음
  assert.ok(durations.slice(0, -1).every(d => d <= 2.2 * 90000 + 3000 + 1), `조각 길이(90kHz) ${durations}`);
  const starts = [];
  let n = 0;
  for (const f of f2) { starts.push(n); n += f.tracks[1].samples.length; }
  for (let i = 0; i < sparse.samples.length; i += 90) assert.ok(starts.includes(i), `키프레임 #${i}에서 새 조각 시작 (${starts})`);
  assert.deepEqual(f2.slice(0, 4).map(f => f.tracks[1].samples.length), [67, 23, 66, 24]);

  // 첫 샘플 길이에 들어간 A/V 정렬 오프셋(오디오 시작 → 첫 프레임 도착, 여기서는 300 ms)은 영상 내용이 아니므로 조각 길이에 세지 않음
  // (세면 첫 조각이 키프레임 #60 전에 시간 기준으로 잘려 키프레임 없이 시작하는 짧은 조각이 생김 - E2E pause-fmp4에서 발견)
  const aligned = repeatedVideo(3);
  aligned.samples.forEach((s, i) => { s.keyframe = i % 60 === 0; });
  const alignAdjust = (t, i) => (i === 0 ? 0 : t - aligned.samples[0].timestamp + 300_000);
  const f4 = readFragments((await writeFmp4({ video: aligned, audio: null, adjust: alignAdjust })).bytes);
  assert.deepEqual(f4.map(f => f.tracks[1].samples.length), [60, 60, 60], '첫 조각도 키프레임 #60에서 닫힘');
  assert.equal(f4[0].tracks[1].samples[0].duration, 3000 + 27000, '정렬 오프셋은 첫 샘플 길이에 그대로 (planMp4와 같음)');

  // 실제 캡처가 30fps보다 조금 느려(29.9fps) 키프레임 60프레임이 2초를 살짝 넘어도 조각은 키프레임에서만 시작 (1~2프레임 조각 없음)
  const slow = repeatedVideo(4);
  slow.samples.forEach((s, i) => { s.timestamp = 3_000_000 + Math.round(i * 1e6 / 29.9); s.keyframe = i % 60 === 0; });
  const f3 = readFragments((await writeFmp4({ video: slow, audio: null })).bytes);
  assert.deepEqual(f3.map(f => f.tracks[1].samples.length), [60, 60, 60, 60]);
  assert.ok(f3.every(f => f.tracks[1].samples[0].flags === SYNC));
});

test('fMP4: 샘플 길이·타임스탬프는 buildMp4(stts)와 같고(정렬·일시정지 보정, 마지막 샘플 오디오 끝까지 연장), tfdt는 조각마다 끊김 없이 이어진다', async () => {
  const video = repeatedVideo(3);
  // 원본 타임스탬프 4초 구멍(일시정지) + 두 번째 샘플부터 정렬 오프셋 120ms
  const raw = video.samples.map((s, i) => ({ ...s, timestamp: s.timestamp + (i >= 95 ? 4_000_000 : 0) }));
  const from = raw[95].timestamp;
  const shift = (t) => (t >= from ? t - (4_000_000 - 33_333) : t);
  const adjust = (t, i) => (i === 0 ? 0 : shift(t) - shift(raw[0].timestamp) + 120_000);
  const audio = makeMp3Audio(7);
  const expectedFile = concatBytes(buildMp4({ container: 'mp4', video: { ...video, samples: raw.map((s, i) => ({ ...s, timestamp: adjust(s.timestamp, i) })) }, audio, creationTime: CREATION_TIME }));
  const traks = findAllBoxes(findBox(parseBoxes(expectedFile), 'moov').children, 'trak');
  const expectedVideo = expandStts(readStts(findBox(traks[0].children, 'mdia/minf/stbl').children));
  const expectedAudio = expandStts(readStts(findBox(traks[1].children, 'mdia/minf/stbl').children));

  const { bytes } = await writeFmp4({ video: { ...video, samples: raw }, audio, adjust });
  const frags = readFragments(bytes);
  const vDur = frags.flatMap(f => (f.tracks[1] ? f.tracks[1].samples.map(s => s.duration) : []));
  const aDur = frags.flatMap(f => (f.tracks[2] ? f.tracks[2].samples.map(s => s.duration) : []));
  assert.deepEqual(vDur, expectedVideo, '영상 샘플 길이 = buildMp4 stts (마지막 샘플 연장 포함)');
  assert.deepEqual(aDur, expectedAudio, '오디오 프레임 길이 = buildMp4 stts');
  for (const id of [1, 2]) {
    let expectedBase = 0;
    for (const f of frags) {
      const t = f.tracks[id];
      if (!t) continue;
      assert.equal(t.baseTime, expectedBase, `트랙 ${id} 조각 #${f.sequence} tfdt = 앞 조각 끝 (끊김 없음)`);
      expectedBase += sum(t.samples.map(s => s.duration));
    }
  }
});

test('fMP4: trun data_offset(moof 기준)과 샘플 크기를 따라가면 mdat 안의 실제 영상·오디오 바이트가 순서대로 나온다', async () => {
  const video = repeatedVideo(2);
  const audio = makeMp3Audio(4);
  const { bytes } = await writeFmp4({ video, audio });
  const frags = readFragments(bytes);
  const gotVideo = [], gotAudio = [];
  for (const f of frags) {
    for (const [id, out] of [[1, gotVideo], [2, gotAudio]]) {
      const t = f.tracks[id];
      if (!t) continue;
      let pos = f.offset + t.dataOffset;
      assert.ok(pos >= f.mdat.offset + f.mdat.headerSize && pos <= f.mdat.offset + f.mdat.size, 'data_offset는 바로 뒤 mdat 안');
      for (const s of t.samples) { out.push(bytes.subarray(pos, pos + s.size)); pos += s.size; }
      if (id === 2 || !f.tracks[2]) assert.equal(pos, f.mdat.offset + f.mdat.size, 'mdat을 정확히 채움');
    }
  }
  assert.equal(gotVideo.length, video.samples.length);
  gotVideo.forEach((b, i) => assert.ok(Buffer.from(b).equals(Buffer.from(video.samples[i].data)), `영상 #${i}`));
  assert.equal(gotAudio.length, audio.frames.length);
  gotAudio.forEach((b, i) => assert.ok(Buffer.from(b).equals(Buffer.from(audio.frames[i].data)), `오디오 #${i}`));
});

/** 싱크 작업 기록(쓰기 순서) - 임의 시점의 디스크 내용을 다시 만들어 비정상 종료를 흉내 냄 */
class JournalSink {
  constructor() { this.ops = []; }
  async write(d) { this.ops.push({ op: 'write', bytes: d.slice() }); }
  async writeAt(position, d) { this.ops.push({ op: 'writeAt', position, bytes: d.slice() }); }
  async close() { return new Blob([replay(this.ops, this.ops.length)]); }
  async abort() {}
}
/** ops[0..count) 적용 + (선택) ops[count]가 write이면 앞 partial 바이트만 기록된 상태 */
function replay(ops, count, partial = 0) {
  let size = 0;
  const parts = [];
  const patches = [];
  const apply = (o, bytes) => {
    if (o.op === 'write') { parts.push(bytes); size += bytes.length; } else patches.push(o);
  };
  for (let k = 0; k < count; k++) apply(ops[k], ops[k].bytes);
  if (partial > 0 && ops[count] && ops[count].op === 'write') apply(ops[count], ops[count].bytes.subarray(0, partial));
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  for (const p of patches) if (p.position + p.bytes.length <= out.length) out.set(p.bytes, p.position);
  return out;
}

test('fMP4: 조각은 완성되는 즉시 한 번에 쓰고(조각당 write 1회), 다 쓴 뒤에야 moof로 활성화하며(free → moof 4바이트 패치), 기록한 조각은 메모리에서 버린다', async () => {
  const sink = new JournalSink();
  const writer = new FragmentedMp4Writer({ sink, creationTime: CREATION_TIME, audio: null });
  await writer.start();
  writer.setVideoConfig({ width: fixture.width, height: fixture.height, avcC: fixture.avcC });
  const video = repeatedVideo(3);
  for (let i = 0; i < 95; i++) writer.addVideoSample(video.samples[i].data, { timestamp: video.samples[i].timestamp, keyframe: video.samples[i].keyframe });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(writer.fragmentsWritten, 3, '키프레임 #30·#60·#90 도착 시 조각 3개 기록');
  const writes = sink.ops.filter(o => o.op === 'write');
  assert.equal(writes.length, 2 + 3, 'ftyp, moov, 조각 3개 (조각마다 write 1회)');
  assert.deepEqual(sink.ops.slice(2).map(o => o.op), ['write', 'writeAt', 'write', 'writeAt', 'write', 'writeAt'], '조각 쓰기 → 활성화 패치 순서');
  let position = writes[0].bytes.length + writes[1].bytes.length;
  for (let k = 0; k < 3; k++) {
    const frag = sink.ops[2 + k * 2], patch = sink.ops[3 + k * 2];
    assert.equal(String.fromCharCode(...frag.bytes.subarray(4, 8)), 'free', `조각 ${k + 1}: 처음에는 free 상자로 기록`);
    assert.equal(patch.position, position + 4, '패치 위치 = 그 조각의 상자 타입');
    assert.equal(String.fromCharCode(...patch.bytes), 'moof');
    position += frag.bytes.length;
  }
  assert.ok(writer.pendingVideoCount <= 5, `기록 대기 영상 샘플 ${writer.pendingVideoCount}개 (마지막 조각 이후분만)`);
  for (let i = 95; i < video.samples.length; i++) writer.addVideoSample(video.samples[i].data, { timestamp: video.samples[i].timestamp, keyframe: video.samples[i].keyframe });
  await writer.finish();
  assert.equal(writer.fragmentsWritten, 6);
});

test('fMP4: 영상 73만 + 오디오 41만 샘플을 기록해도 조각을 쓴 뒤 버리므로 JS 힙 증가가 30 MB 미만이다', async () => {
  class NullSink { constructor() { this.size = 0; this.writes = 0; } async write(d) { this.size += d.length; this.writes++; } async writeAt() {} async close() { return new Blob([]); } async abort() {} }
  const sink = new NullSink();
  gc(); gc();
  const before = process.memoryUsage();
  const writer = new FragmentedMp4Writer({ sink, creationTime: CREATION_TIME, audio: { codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000 } });
  await writer.start();
  writer.setVideoConfig({ width: 1280, height: 720, avcC: fixture.avcC });
  const v = new Uint8Array(300), a = new Uint8Array(418);
  const V = 734_400, A = 411_000;
  let j = 0, peak = 0;
  for (let i = 0; i < V; i++) {
    writer.addVideoSample(v, { timestamp: Math.round(i * 1e6 / 30), keyframe: i % 60 === 0 });
    if (j < A && (i % 16 !== 0)) { writer.addAudioFrame(a, { samples: 1152 }); j++; }
    if (i % 20_000 === 0) {
      await new Promise(r => setImmediate(r));
      gc();
      const m = process.memoryUsage();
      peak = Math.max(peak, (m.heapUsed + m.arrayBuffers - before.heapUsed - before.arrayBuffers) / 1048576);
    }
  }
  const result = await writer.finish();
  gc(); gc();
  const after = process.memoryUsage();
  const growthMB = (after.heapUsed - before.heapUsed) / 1048576;
  assert.equal(result.bytes, sink.size);
  assert.equal(writer.videoSampleCount, V);
  assert.equal(writer.audioFrameCount, j);
  assert.ok(sink.writes > V / 60 - 10, `조각 ${sink.writes}개 기록`);
  assert.ok(peak < 30, `기록 중 메모리 증가 최대 ${peak.toFixed(1)} MB < 30 MB`);
  assert.ok(growthMB < 30, `JS 힙 증가 ${growthMB.toFixed(1)} MB < 30 MB (조각마다 버림)`);
});

test('fMP4: 녹화 중 출력 쓰기가 실패하면 onError를 한 번 부르고 이후 샘플은 받지 않으며 finish는 그 오류로 거부된다', async () => {
  const dir = new FakeDirectoryHandle('USB');
  const sink = new DirectoryFileSink(dir, 'recorda_x.mp4', 'video/mp4');
  await sink.open();
  const errors = [];
  const writer = new FragmentedMp4Writer({ sink, creationTime: CREATION_TIME, audio: null, onError: (e) => errors.push(e) });
  await writer.start();
  writer.setVideoConfig({ width: fixture.width, height: fixture.height, avcC: fixture.avcC });
  const video = repeatedVideo(2);
  for (let i = 0; i < 40; i++) writer.addVideoSample(video.samples[i].data, { timestamp: video.samples[i].timestamp, keyframe: video.samples[i].keyframe });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(errors, []);
  dir.faults = { failWritesAfter: 0 };
  for (let i = 40; i < 70; i++) writer.addVideoSample(video.samples[i].data, { timestamp: video.samples[i].timestamp, keyframe: video.samples[i].keyframe });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'NotAllowedError');
  assert.equal(writer.addVideoSample(video.samples[70].data, { timestamp: video.samples[70].timestamp, keyframe: false }), false);
  await assert.rejects(() => writer.finish(), (e) => e.name === 'NotAllowedError');
});

// ---- ffprobe / ffmpeg ----
const FF = !FFPROBE || !FFMPEG ? 'ffprobe/ffmpeg 없음' : false;

/** 잘린 파일도 읽을 수 있게 종료 코드와 무관하게 ffprobe JSON을 읽음 */
function probeLoose(path) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', path], { encoding: 'utf8' });
  try { return { info: JSON.parse(r.stdout || '{}'), stderr: r.stderr, status: r.status }; } catch { return { info: { streams: [] }, stderr: r.stderr, status: r.status }; }
}

test('fMP4: ffprobe가 h264 + mp3를 buildMp4 파일과 같은 패킷 수·재생 구간으로 읽고 전체 디코딩 오류가 없다', { skip: FF }, async () => {
  const video = repeatedVideo(5);
  const audio = makeMp3Audio(10);
  const { bytes } = await writeFmp4({ video, audio });
  const path = writeOutput('fmp4-full.mp4', [bytes]);
  const refPath = writeOutput('fmp4-ref.mp4', buildMp4({ container: 'mp4', video, audio, creationTime: CREATION_TIME }));
  const info = ffprobe(path);
  const ref = ffprobe(refPath);
  // 재생 끝 시각(start_time + duration)으로 비교: ffmpeg는 조각 파일의 elst(1105 샘플)를 앞부분 잘라내기 대신 타임스탬프를 당겨 적용해
  // 오디오 start_time이 -0.025초로 보임 (인코더 지연 무음 구간). 영상 기준 A/V 위치는 일반 MP4와 같음
  const pick = (x) => x.streams.map(s => ({ codec: s.codec_name, frames: Number(s.nb_read_frames), end: (Number(s.start_time) + Number(s.duration)).toFixed(3) }));
  assert.deepEqual(pick(info), pick(ref));
  assert.deepEqual(pick(info).map(s => [s.codec, s.frames]), [['h264', 300], ['mp3', audio.frames.length]]);
  const a = info.streams.find(s => s.codec_type === 'audio');
  assert.ok(Math.abs(Number(a.start_time) + 1105 / 44100) < 0.001, `오디오 start_time ${a.start_time} = -1105/44100`);
  assert.equal(Number(info.streams.find(s => s.codec_type === 'video').start_time), 0);
  assert.equal(ffmpegDecodeErrors(path), '');
});

test('fMP4: 완료된 파일은 mehd(전체 길이)를 가져 조각을 다 읽지 않아도 길이를 알 수 있다 (ffprobe 기본 탐색, ffmpeg -sseof)', { skip: FF }, async () => {
  const video = repeatedVideo(5);
  const audio = makeMp3Audio(10);
  const { bytes } = await writeFmp4({ video, audio });
  const mvex = findBox(parseBoxes(bytes)[1].children, 'mvex');
  const mehd = mvex.children.find(b => b.type === 'mehd');
  assert.ok(mehd, 'mehd (free 자리를 완료 시 덮어씀)');
  const durMs = Number(new DataView(mehd.payload.buffer, mehd.payload.byteOffset).getBigUint64(4));
  assert.ok(Math.abs(durMs - 10_000) <= 40, `mehd fragment_duration ${durMs} ms ≈ 10초`);
  const path = writeOutput('fmp4-mehd.mp4', [bytes]);
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_format', '-of', 'json', path], { encoding: 'utf8' });
  assert.ok(Math.abs(Number(JSON.parse(r.stdout).format.duration) - 10) < 0.1, `프레임을 세지 않은 ffprobe 길이 ${r.stdout}`);
  const tail = spawnSync(FFMPEG, ['-v', 'error', '-sseof', '-3', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(tail.status, 0, tail.stderr);
  assert.equal((tail.stderr || '').trim(), '', '마지막 3초 디코딩 (길이를 알아야 -sseof 사용 가능)');
});

test('fMP4: ffmpeg -c copy -f mp4 재머싱이 경고 없이 성공한다', { skip: FF }, async () => {
  const video = repeatedVideo(3);
  const audio = makeMp3Audio(6);
  const { bytes } = await writeFmp4({ video, audio });
  const path = writeOutput('fmp4-remux-src.mp4', [bytes]);
  const out = path.replace(/\.mp4$/, '-remuxed.mp4');
  const r = spawnSync(FFMPEG, ['-v', 'warning', '-y', '-i', path, '-c', 'copy', '-f', 'mp4', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // 알려진 무해한 경고만 허용: (없음) - 새 경고가 생기면 원인을 확인할 수 있도록 그대로 보여 줌
  const lines = (r.stderr || '').trim().split('\n').filter(Boolean);
  assert.deepEqual(lines, [], lines.join('\n'));
  const info = ffprobe(out);
  assert.deepEqual(info.streams.map(s => [s.codec_name, Number(s.nb_read_frames)]), [['h264', 180], ['mp3', audio.frames.length]]);
  assert.equal(ffmpegDecodeErrors(out), '');
});

/** 잘린 파일을 ffprobe로 읽어 디코딩된 영상 프레임 수가 기대값 이상인지 확인 */
function assertDecodesAtLeast(bytes, name, expectedFrames, dir) {
  const path = join(dir, `fmp4-crash-${name.replace(/[^a-z0-9]+/gi, '_')}.mp4`);
  writeFileSync(path, bytes);
  const { info, stderr } = probeLoose(path);
  const v = (info.streams || []).find(st => st.codec_type === 'video');
  const frames = v ? Number(v.nb_read_frames) : 0;
  assert.ok(v && v.codec_name === 'h264', `${name}: 파일을 열고 h264 스트림을 인식 | ${String(stderr).slice(0, 200)}`);
  assert.ok(frames >= expectedFrames, `${name} (${bytes.length} B): 디코딩 프레임 ${frames} ≥ 완전한 조각의 샘플 ${expectedFrames} | ${String(stderr).slice(0, 200)}`);
  return frames;
}

test('fMP4 비정상 종료 안전성: 쓰기 도중 아무 지점(조각 안·조각 사이·moof 안·활성화 직전)에서 멈춘 파일도 그 앞의 완전한 조각은 모두 디코딩된다', { skip: FF }, async () => {
  const video = repeatedVideo(5);
  const audio = makeMp3Audio(10);
  const sink = new JournalSink();
  const writer = new FragmentedMp4Writer({ sink, creationTime: CREATION_TIME, audio: AUDIO_CONFIG(audio) });
  await writer.start();
  writer.setVideoConfig({ width: video.width, height: video.height, avcC: video.avcC });
  feed(writer, video, audio);
  await writer.finish();
  const ops = sink.ops;
  const full = replay(ops, ops.length);
  const frags = readFragments(full);
  assert.equal(frags.length, 10);
  // 조각 k(0부터)의 쓰기 = ops[2 + 2k], 활성화 패치 = ops[3 + 2k]
  const fragOp = (k) => 2 + 2 * k;
  const videoIn = (k) => frags.slice(0, k).reduce((n, f) => n + (f.tracks[1] ? f.tracks[1].samples.length : 0), 0); // 앞 k개 조각의 영상 샘플
  const dir = writeOutput('fmp4-crash-full.mp4', [full]).replace(/[^/]+$/, '');
  const states = [
    { name: '4번째 조각을 쓰다 moof(tfhd~trun) 안에서 멈춤', bytes: replay(ops, fragOp(3), 60), complete: 3 },
    { name: '4번째 조각을 쓰다 trun 항목 중간에서 멈춤', bytes: replay(ops, fragOp(3), 400), complete: 3 },
    { name: '6번째 조각을 쓰다 mdat 중간에서 멈춤', bytes: replay(ops, fragOp(5), Math.floor(frags[5].size + frags[5].mdat.size / 2)), complete: 5 },
    { name: '7번째 조각을 다 썼지만 활성화(moof) 전에 멈춤', bytes: replay(ops, fragOp(6) + 1), complete: 6 },
    { name: '7번째 조각 활성화 직후 (조각 사이)', bytes: replay(ops, fragOp(7)), complete: 7 },
    { name: '마지막 조각을 쓰다 마지막 바이트 전에 멈춤', bytes: replay(ops, fragOp(9), ops[fragOp(9)].bytes.length - 1), complete: 9 }
  ];
  for (const st of states) {
    const visible = readFragments(st.bytes.subarray(0, frags[st.complete - 1].mdat.offset + frags[st.complete - 1].mdat.size)).length;
    assert.equal(visible, st.complete, `${st.name}: moof로 보이는 조각 = 완전히 기록된 조각`);
    assertDecodesAtLeast(st.bytes, st.name, videoIn(st.complete), dir);
  }
  // 완료된 파일을 mdat 안·조각 사이에서 자른 경우도 (활성화된 조각은 mdat까지 온전)
  const end = (f) => f.mdat.offset + f.mdat.size;
  for (const [name, at] of [['완료 파일 3번째 조각 mdat 중간에서 자름', frags[2].mdat.offset + Math.floor(frags[2].mdat.size / 2)], ['완료 파일 5번째 조각 직전에서 자름', frags[4].offset], ['완료 파일 8번째 mdat 헤더 직후에서 자름', frags[7].mdat.offset + 11]]) {
    const complete = frags.filter(f => end(f) <= at).length;
    assertDecodesAtLeast(full.subarray(0, at), name, videoIn(complete), dir);
  }
});
