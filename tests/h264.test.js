import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  splitAnnexB, parseAvcC, buildAvcC, avcToAnnexB, annexBAccessUnitToAvc, parseAnnexBAccessUnits, parseSpsDimensions
} from '../muxers/h264.js';

const fixture = new Uint8Array(readFileSync(new URL('./fixtures/test_160x120_30fps_2s.h264', import.meta.url)));

test('splitAnnexB는 3/4바이트 시작 코드로 NAL 단위를 분리한다', () => {
  const data = new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 6]);
  const nals = splitAnnexB(data);
  assert.deepEqual(nals.map(n => Array.from(n)), [[0x67, 1, 2], [0x68, 3], [0x65, 4, 5, 6]]);
});

test('buildAvcC/parseAvcC는 SPS/PPS를 왕복 변환한다', () => {
  const sps = new Uint8Array([0x67, 0x42, 0xC0, 0x1E, 0xAA]);
  const pps = new Uint8Array([0x68, 0xCE, 0x38, 0x80]);
  const avcC = buildAvcC([sps], [pps]);
  assert.equal(avcC[0], 1);                    // configurationVersion
  assert.equal(avcC[1], 0x42);                 // profile
  assert.equal(avcC[2], 0xC0);                 // compat
  assert.equal(avcC[3], 0x1E);                 // level
  assert.equal(avcC[4] & 0x03, 3);             // lengthSizeMinusOne = 3 (4바이트 길이)
  const parsed = parseAvcC(avcC);
  assert.equal(parsed.nalLengthSize, 4);
  assert.deepEqual(parsed.sps.map(s => Array.from(s)), [Array.from(sps)]);
  assert.deepEqual(parsed.pps.map(p => Array.from(p)), [Array.from(pps)]);
});

test('avcToAnnexB는 길이 접두 NAL을 시작 코드로 바꾸고 키프레임에 SPS/PPS를 앞에 붙인다', () => {
  const sps = new Uint8Array([0x67, 0x42, 0xC0, 0x1E]);
  const pps = new Uint8Array([0x68, 0xCE]);
  const avcC = buildAvcC([sps], [pps]);
  const avc = new Uint8Array([0, 0, 0, 2, 0x65, 0xAA, 0, 0, 0, 1, 0x41]);
  const key = avcToAnnexB(avc, avcC, true);
  assert.deepEqual(Array.from(key), [
    0, 0, 0, 1, 0x67, 0x42, 0xC0, 0x1E,
    0, 0, 0, 1, 0x68, 0xCE,
    0, 0, 0, 1, 0x65, 0xAA,
    0, 0, 0, 1, 0x41
  ]);
  const delta = avcToAnnexB(avc, avcC, false);
  assert.deepEqual(Array.from(delta), [0, 0, 0, 1, 0x65, 0xAA, 0, 0, 0, 1, 0x41]);
});

test('parseAnnexBAccessUnits는 AUD 기준으로 액세스 유닛을 나누고 SPS/PPS/키프레임을 식별한다', () => {
  const { accessUnits, sps, pps } = parseAnnexBAccessUnits(fixture);
  assert.equal(accessUnits.length, 60, '2초 × 30fps = 60 프레임');
  assert.equal(sps.length, 1);
  assert.equal(pps.length, 1);
  assert.equal(accessUnits[0].keyframe, true);
  assert.equal(accessUnits[1].keyframe, false);
  assert.equal(accessUnits[30].keyframe, true, 'GOP=30이므로 31번째 프레임은 키프레임');
});

test('annexBAccessUnitToAvc는 파라미터 셋/AUD를 제거하고 4바이트 길이 접두를 붙인다', () => {
  const { accessUnits } = parseAnnexBAccessUnits(fixture);
  const avc = annexBAccessUnitToAvc(accessUnits[0].nals);
  const view = new DataView(avc.buffer, avc.byteOffset, avc.byteLength);
  let offset = 0;
  const types = [];
  while (offset < avc.length) {
    const len = view.getUint32(offset);
    types.push(avc[offset + 4] & 0x1F);
    offset += 4 + len;
  }
  assert.equal(offset, avc.length, '길이 접두가 정확히 끝까지 이어져야 함');
  assert.ok(!types.includes(9) && !types.includes(7) && !types.includes(8), `AUD/SPS/PPS 제거됨: ${types}`);
  assert.ok(types.includes(5), 'IDR 슬라이스 포함');
});

test('parseSpsDimensions는 SPS에서 영상 크기를 읽는다', () => {
  const { sps } = parseAnnexBAccessUnits(fixture);
  assert.deepEqual(parseSpsDimensions(sps[0]), { width: 160, height: 120 });
});
