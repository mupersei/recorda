// H.264 유틸 - Annex B ↔ AVC(길이 접두) 변환, avcC 생성/해석, SPS 크기 해석

const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;
const NAL_IDR = 5;
const NAL_SEI = 6;

/**
 * Annex B 바이트열을 NAL 단위 배열로 분리 (시작 코드 제외)
 * @param {Uint8Array} data
 * @returns {Uint8Array[]}
 */
export function splitAnnexB(data) {
  const nals = [];
  let i = 0;
  let start = -1;
  const n = data.length;
  while (i + 2 < n) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        // 4바이트 시작 코드(00 00 00 01)의 선행 0 제거
        if (end > start && data[end - 1] === 0) end--;
        if (end > start) nals.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n) nals.push(data.subarray(start, n));
  return nals;
}

/**
 * SPS/PPS로 avcC(AVCDecoderConfigurationRecord) 생성 (4바이트 NAL 길이)
 * @param {Uint8Array[]} spsList
 * @param {Uint8Array[]} ppsList
 * @returns {Uint8Array}
 */
export function buildAvcC(spsList, ppsList) {
  if (!spsList.length || !ppsList.length) {
    throw new Error('avcC 생성에는 SPS와 PPS가 필요합니다');
  }
  const sps0 = spsList[0];
  const parts = [];
  parts.push(new Uint8Array([
    1,            // configurationVersion
    sps0[1],      // AVCProfileIndication
    sps0[2],      // profile_compatibility
    sps0[3],      // AVCLevelIndication
    0xFC | 3,     // reserved(6) + lengthSizeMinusOne(2) = 4바이트
    0xE0 | (spsList.length & 0x1F)
  ]));
  for (const sps of spsList) {
    parts.push(new Uint8Array([(sps.length >> 8) & 0xFF, sps.length & 0xFF]), sps);
  }
  parts.push(new Uint8Array([ppsList.length & 0xFF]));
  for (const pps of ppsList) {
    parts.push(new Uint8Array([(pps.length >> 8) & 0xFF, pps.length & 0xFF]), pps);
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * avcC 해석
 * @param {Uint8Array} avcC
 * @returns {{nalLengthSize:number, sps:Uint8Array[], pps:Uint8Array[], profile:number, level:number}}
 */
export function parseAvcC(avcC) {
  if (!avcC || avcC.length < 7 || avcC[0] !== 1) {
    throw new Error('유효하지 않은 avcC 데이터입니다');
  }
  const nalLengthSize = (avcC[4] & 0x03) + 1;
  let off = 5;
  const spsCount = avcC[off++] & 0x1F;
  const sps = [];
  for (let i = 0; i < spsCount; i++) {
    const len = (avcC[off] << 8) | avcC[off + 1];
    off += 2;
    sps.push(avcC.subarray(off, off + len));
    off += len;
  }
  const ppsCount = avcC[off++];
  const pps = [];
  for (let i = 0; i < ppsCount; i++) {
    const len = (avcC[off] << 8) | avcC[off + 1];
    off += 2;
    pps.push(avcC.subarray(off, off + len));
    off += len;
  }
  return { nalLengthSize, sps, pps, profile: avcC[1], level: avcC[3] };
}

const START_CODE = new Uint8Array([0, 0, 0, 1]);

/**
 * AVC(길이 접두) 샘플을 Annex B로 변환. 키프레임이면 SPS/PPS를 앞에 붙입니다 (AVI용).
 * @param {Uint8Array} avcSample
 * @param {Uint8Array} avcC
 * @param {boolean} keyframe
 * @returns {Uint8Array}
 */
export function avcToAnnexB(avcSample, avcC, keyframe) {
  const { nalLengthSize, sps, pps } = parseAvcC(avcC);
  const parts = [];
  if (keyframe) {
    for (const s of sps) parts.push(START_CODE, s);
    for (const p of pps) parts.push(START_CODE, p);
  }
  let off = 0;
  while (off + nalLengthSize <= avcSample.length) {
    let len = 0;
    for (let i = 0; i < nalLengthSize; i++) len = (len << 8) | avcSample[off + i];
    off += nalLengthSize;
    if (len <= 0 || off + len > avcSample.length) break;
    parts.push(START_CODE, avcSample.subarray(off, off + len));
    off += len;
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Annex B 스트림을 액세스 유닛(프레임) 단위로 분리합니다 (AUD 기준, AUD 없으면 슬라이스 first_mb 기준).
 * 테스트 픽스처 및 외부 스트림 처리용.
 * @param {Uint8Array} data
 * @returns {{accessUnits: Array<{nals: Uint8Array[], keyframe: boolean}>, sps: Uint8Array[], pps: Uint8Array[]}}
 */
export function parseAnnexBAccessUnits(data) {
  const nals = splitAnnexB(data);
  const sps = [];
  const pps = [];
  const accessUnits = [];
  let current = null;

  const flush = () => {
    if (current && current.nals.some(n => isSlice(n[0] & 0x1F))) {
      accessUnits.push(current);
    }
    current = null;
  };

  for (const nal of nals) {
    const type = nal[0] & 0x1F;
    if (type === NAL_SPS && !sps.some(s => equalBytes(s, nal))) sps.push(nal);
    if (type === NAL_PPS && !pps.some(p => equalBytes(p, nal))) pps.push(nal);

    if (type === NAL_AUD) {
      flush();
      current = { nals: [], keyframe: false };
      continue;
    }
    if (!current) current = { nals: [], keyframe: false };

    // AUD가 없는 스트림: 새 프레임의 첫 슬라이스(first_mb_in_slice == 0)에서 분리
    if (isSlice(type) && current.nals.some(n => isSlice(n[0] & 0x1F)) && firstMbInSliceIsZero(nal)) {
      flush();
      current = { nals: [], keyframe: false };
    }

    current.nals.push(nal);
    if (type === NAL_IDR) current.keyframe = true;
  }
  flush();
  return { accessUnits, sps, pps };
}

/**
 * 액세스 유닛의 NAL 목록을 AVC(4바이트 길이 접두) 샘플로 변환. AUD/SPS/PPS는 제거(avcC에 들어가므로).
 * @param {Uint8Array[]} nals
 * @returns {Uint8Array}
 */
export function annexBAccessUnitToAvc(nals) {
  const kept = nals.filter(n => {
    const t = n[0] & 0x1F;
    return t !== NAL_AUD && t !== NAL_SPS && t !== NAL_PPS;
  });
  const total = kept.reduce((s, n) => s + 4 + n.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const n of kept) {
    view.setUint32(off, n.length);
    out.set(n, off + 4);
    off += 4 + n.length;
  }
  return out;
}

/**
 * SPS에서 영상 크기를 읽습니다.
 * @param {Uint8Array} sps - NAL 헤더 포함 SPS
 * @returns {{width:number, height:number}}
 */
export function parseSpsDimensions(sps) {
  const rbsp = removeEmulationPrevention(sps.subarray(1));
  const r = new BitReader(rbsp);
  const profileIdc = r.bits(8);
  r.bits(8); // constraint flags + reserved
  r.bits(8); // level_idc
  r.ue();    // seq_parameter_set_id

  let chromaFormatIdc = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.bits(1); // separate_colour_plane_flag
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bits(1); // qpprime_y_zero_transform_bypass_flag
    if (r.bits(1)) { // seq_scaling_matrix_present_flag
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) {
        if (r.bits(1)) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = r.ue();
  if (picOrderCntType === 0) {
    r.ue();
  } else if (picOrderCntType === 1) {
    r.bits(1);
    r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bits(1); // gaps_in_frame_num_value_allowed_flag
  const picWidthInMbsMinus1 = r.ue();
  const picHeightInMapUnitsMinus1 = r.ue();
  const frameMbsOnlyFlag = r.bits(1);
  if (!frameMbsOnlyFlag) r.bits(1); // mb_adaptive_frame_field_flag
  r.bits(1); // direct_8x8_inference_flag
  let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
  if (r.bits(1)) { // frame_cropping_flag
    cropLeft = r.ue(); cropRight = r.ue(); cropTop = r.ue(); cropBottom = r.ue();
  }

  const subWidthC = chromaFormatIdc === 3 ? 1 : 2;
  const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
  const cropUnitX = chromaFormatIdc === 0 ? 1 : subWidthC;
  const cropUnitY = (chromaFormatIdc === 0 ? 1 : subHeightC) * (2 - frameMbsOnlyFlag);

  const width = (picWidthInMbsMinus1 + 1) * 16 - cropUnitX * (cropLeft + cropRight);
  const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - cropUnitY * (cropTop + cropBottom);
  return { width, height };
}

// ---- 내부 유틸 ----

function isSlice(type) {
  return type >= 1 && type <= 5;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function firstMbInSliceIsZero(nal) {
  // slice_header: first_mb_in_slice ue(v) - 첫 비트가 1이면 값 0
  return nal.length > 1 && (nal[1] & 0x80) !== 0;
}

function removeEmulationPrevention(data) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue; // 00 00 03 → 03 제거
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

function skipScalingList(r, size) {
  let lastScale = 8, nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      const delta = r.se();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

class BitReader {
  constructor(data) {
    this.data = data;
    this.pos = 0;
  }
  bit() {
    const byte = this.data[this.pos >> 3];
    if (byte === undefined) throw new Error('SPS 비트 스트림 끝을 넘었습니다');
    const bit = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return bit;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v >>> 0;
  }
  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 32) throw new Error('잘못된 Exp-Golomb 코드');
    }
    return zeros === 0 ? 0 : ((1 << zeros) - 1 + this.bits(zeros));
  }
  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

export const NAL_TYPES = { SPS: NAL_SPS, PPS: NAL_PPS, AUD: NAL_AUD, IDR: NAL_IDR, SEI: NAL_SEI };
