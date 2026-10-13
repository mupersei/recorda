// 테스트 헬퍼 - 픽스처 로딩, lamejs MP3 생성, ffprobe/ffmpeg 검증, MP4 박스 파서
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { parseAnnexBAccessUnits, annexBAccessUnitToAvc, buildAvcC, parseSpsDimensions } from '../../muxers/h264.js';
import { Mp3FrameSplitter } from '../../muxers/mp3-frames.js';
import { concatBytes } from '../../muxers/byte-writer.js';

export const FIXTURE_FPS = 30;

/** 160x120 30fps 2초 H.264 픽스처를 AVC 샘플 목록으로 로드 */
export function loadFixtureVideo() {
  const raw = new Uint8Array(readFileSync(new URL('../fixtures/test_160x120_30fps_2s.h264', import.meta.url)));
  const { accessUnits, sps, pps } = parseAnnexBAccessUnits(raw);
  const { width, height } = parseSpsDimensions(sps[0]);
  const frameDurationUs = 1_000_000 / FIXTURE_FPS;
  const samples = accessUnits.map((au, i) => ({
    data: annexBAccessUnitToAvc(au.nals),
    timestamp: Math.round(i * frameDurationUs),
    keyframe: au.keyframe
  }));
  return { width, height, avcC: buildAvcC(sps, pps), samples };
}

let lameLoaded = false;
export function loadLame() {
  if (!lameLoaded) {
    vm.runInThisContext(readFileSync(new URL('../../lib/lame.min.js', import.meta.url), 'utf8'));
    lameLoaded = true;
  }
  return globalThis.lamejs;
}

/** 사인파 N초를 lamejs로 MP3 인코딩하여 프레임 목록으로 반환 */
export function makeMp3Audio(seconds = 2, sampleRate = 44100, bitrate = 128) {
  const lamejs = loadLame();
  const enc = new lamejs.Mp3Encoder(2, sampleRate, bitrate);
  const splitter = new Mp3FrameSplitter();
  const total = Math.round(seconds * sampleRate);
  const block = 4096;
  const frames = [];
  for (let start = 0; start < total; start += block) {
    const n = Math.min(block, total - start);
    const l = new Int16Array(n), r = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const t = (start + i) / sampleRate;
      l[i] = Math.round(Math.sin(2 * Math.PI * 440 * t) * 12000);
      r[i] = Math.round(Math.sin(2 * Math.PI * 660 * t) * 12000);
    }
    const out = enc.encodeBuffer(l, r);
    frames.push(...splitter.push(new Uint8Array(out.buffer, out.byteOffset, out.length)));
  }
  const tail = enc.flush();
  frames.push(...splitter.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length)));
  splitter.flush();
  return { codec: 'mp3', sampleRate, channels: 2, bitrate: bitrate * 1000, frames };
}

const SCRATCH = process.env.RECORDA_TEST_OUT || join(tmpdir(), 'recorda-muxer-tests');
export function writeOutput(name, parts) {
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
  const path = join(SCRATCH, name);
  writeFileSync(path, concatBytes(parts));
  return path;
}

function findBinary(envName, candidates) {
  if (process.env[envName] && existsSync(process.env[envName])) return process.env[envName];
  for (const c of candidates) {
    if (c.includes('/') && existsSync(c)) return c;
    try {
      const found = execFileSync('which', [c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (found) return found;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

// ffprobe/ffmpeg: 환경 변수(RECORDA_FFPROBE, RECORDA_FFMPEG) 또는 PATH에서 찾음. 없으면 해당 테스트는 건너뜀
export const FFPROBE = findBinary('RECORDA_FFPROBE', ['ffprobe']);
export const FFMPEG = findBinary('RECORDA_FFMPEG', ['ffmpeg']);

/** ffprobe JSON (스트림+포맷). ffprobe가 없으면 null */
export function ffprobe(path) {
  if (!FFPROBE) return null;
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', path], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** 전체 디코딩을 수행하고 에러 출력 문자열을 반환 (빈 문자열이면 정상). ffmpeg가 없으면 null */
export function ffmpegDecodeErrors(path) {
  if (!FFMPEG) return null;
  const result = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  const stderr = (result.stderr || '').trim();
  if (result.status !== 0 && !stderr) return `ffmpeg exit ${result.status}`;
  return stderr;
}

/** MP4 박스 트리 파서 (테스트용) */
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta']);
export function parseBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    const box = { type, size, offset, headerSize, payload: bytes.subarray(offset + headerSize, offset + size) };
    if (CONTAINER_BOXES.has(type)) {
      box.children = parseBoxes(bytes, offset + headerSize, offset + size);
    } else if (type === 'stsd') {
      box.children = parseBoxes(bytes, offset + headerSize + 8, offset + size);
    }
    boxes.push(box);
    offset += size;
  }
  return boxes;
}

export function findBox(boxes, path) {
  const [head, ...rest] = path.split('/');
  const match = boxes.find(b => b.type === head);
  if (!match) return null;
  return rest.length ? findBox(match.children || [], rest.join('/')) : match;
}

export function findAllBoxes(boxes, type) {
  return boxes.filter(b => b.type === type);
}

/** stco/co64 오프셋 배열 읽기 */
export function readChunkOffsets(stblChildren) {
  const stco = stblChildren.find(b => b.type === 'stco');
  const co64 = stblChildren.find(b => b.type === 'co64');
  const box = stco || co64;
  const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
  const count = view.getUint32(4);
  const offsets = [];
  for (let i = 0; i < count; i++) {
    offsets.push(stco ? view.getUint32(8 + i * 4) : Number(view.getBigUint64(8 + i * 8)));
  }
  return offsets;
}

export function readStsz(stblChildren) {
  const box = stblChildren.find(b => b.type === 'stsz');
  const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
  const sampleSize = view.getUint32(4);
  const count = view.getUint32(8);
  if (sampleSize !== 0) return new Array(count).fill(sampleSize);
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(view.getUint32(12 + i * 4));
  return sizes;
}

export function readStts(stblChildren) {
  const box = stblChildren.find(b => b.type === 'stts');
  const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
  const count = view.getUint32(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({ count: view.getUint32(8 + i * 8), delta: view.getUint32(12 + i * 8) });
  }
  return entries;
}

/** RIFF(AVI) 청크 트리 파서 (테스트용) */
export function parseRiff(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = start;
  while (offset + 8 <= end) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const chunk = { id, size, offset };
    if (id === 'RIFF' || id === 'LIST') {
      chunk.listType = String.fromCharCode(...bytes.subarray(offset + 8, offset + 12));
      chunk.children = parseRiff(bytes, offset + 12, offset + 8 + size);
    } else {
      chunk.payload = bytes.subarray(offset + 8, offset + 8 + size);
    }
    chunks.push(chunk);
    offset += 8 + size + (size & 1);
  }
  return chunks;
}
