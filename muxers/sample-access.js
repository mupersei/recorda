// 머서 입력 트랙 접근자 - 두 가지 입력 형식을 같은 인덱스 기반 API로 읽습니다. 샘플마다 객체를 만들지 않습니다.
//
// 1) 배열 형식 (메모리 녹화, 테스트, 기존 호출자)
//    video: { width, height, avcC, samples: [{ data | ref:{offset,size}, timestamp, keyframe, nalCount? }], store? }
//    audio: { codec, sampleRate, channels, bitrate?, frames: [{ data | ref, samples }], store? }
// 2) 인덱스 형식 (디스크 저장소 녹화: VideoTrackEncoder / ContainerAudioEncoder)
//    video: { width, height, avcC, index: SampleIndex('video'), store, timestampAt?(i) }
//      timestampAt: 출력 타임스탬프(µs) 접근자. 없으면 index의 타임스탬프 그대로 (A/V 정렬 오프셋을 복사 없이 적용)
//    audio: { codec, sampleRate, channels, bitrate?, index: SampleIndex('audio'), store }

class ArrayVideoSource {
  constructor(samples, store) { this.samples = samples; this.store = store || null; this.count = samples.length; }
  sizeAt(i) {
    const s = this.samples[i];
    if (s.data) return s.data.length;
    if (s.ref) return s.ref.size;
    throw new Error('샘플에 data 또는 ref가 필요합니다');
  }
  timestampAt(i) { return this.samples[i].timestamp; }
  keyframeAt(i) { return !!this.samples[i].keyframe; }
  nalCountAt(i) { return this.samples[i].nalCount; }
  dataAt(i) { return this.samples[i].data || null; }
  hasRefAt(i) { return !!this.samples[i].ref; }
  offsetAt(i) { return this.samples[i].ref.offset; }
}

class IndexedVideoSource {
  constructor(index, store, timestampAt) {
    this.index = index;
    this.store = store || null;
    this.count = index.length;
    if (typeof timestampAt === 'function') this.timestampAt = timestampAt;
  }
  sizeAt(i) { return this.index.sizes[i]; }
  timestampAt(i) { return this.index.timestamps[i]; }
  keyframeAt(i) { return (this.index.flags[i] & 1) !== 0; }
  nalCountAt(i) { return this.index.nalCounts[i]; }
  dataAt() { return null; }
  hasRefAt() { return true; }
  offsetAt(i) { return this.index.offsets[i]; }
}

class ArrayAudioSource {
  constructor(frames, store) { this.frames = frames; this.store = store || null; this.count = frames.length; }
  sizeAt(i) {
    const f = this.frames[i];
    if (f.data) return f.data.length;
    if (f.ref) return f.ref.size;
    throw new Error('샘플에 data 또는 ref가 필요합니다');
  }
  samplesAt(i) { return this.frames[i].samples; }
  dataAt(i) { return this.frames[i].data || null; }
  offsetAt(i) { return this.frames[i].ref.offset; }
}

class IndexedAudioSource {
  constructor(index, store) { this.index = index; this.store = store || null; this.count = index.length; }
  sizeAt(i) { return this.index.sizes[i]; }
  samplesAt(i) { return this.index.frameSamples[i]; }
  dataAt() { return null; }
  offsetAt(i) { return this.index.offsets[i]; }
}

/**
 * 영상 트랙 접근자. 샘플 배열도 인덱스도 없으면 null
 */
export function videoSource(video) {
  if (!video) return null;
  if (video.index) {
    if (video.index.kind !== 'video') throw new Error('영상 트랙에는 video SampleIndex가 필요합니다');
    return new IndexedVideoSource(video.index, video.store, video.timestampAt);
  }
  return Array.isArray(video.samples) ? new ArrayVideoSource(video.samples, video.store) : null;
}

/**
 * 오디오 트랙 접근자. 프레임 배열도 인덱스도 없으면 null
 */
export function audioSource(audio) {
  if (!audio) return null;
  if (audio.index) {
    if (audio.index.kind !== 'audio') throw new Error('오디오 트랙에는 audio SampleIndex가 필요합니다');
    return new IndexedAudioSource(audio.index, audio.store);
  }
  return Array.isArray(audio.frames) ? new ArrayAudioSource(audio.frames, audio.store) : null;
}

/** 트랙의 샘플(프레임) 수 - 배열/인덱스 형식 공통 */
export function trackSampleCount(track) {
  if (!track) return 0;
  if (track.index) return track.index.length;
  if (Array.isArray(track.samples)) return track.samples.length;
  if (Array.isArray(track.frames)) return track.frames.length;
  return 0;
}

/** 트랙이 참조하는 데이터 바이트 합계 - 배열/인덱스 형식 공통 */
export function trackDataBytes(track) {
  if (!track) return 0;
  if (track.index) return track.index.totalBytes;
  const src = track.samples ? videoSource(track) : audioSource(track);
  if (!src) return 0;
  let total = 0;
  for (let i = 0; i < src.count; i++) total += src.sizeAt(i);
  return total;
}

/**
 * 샘플 데이터 읽기: 메모리 데이터(data)면 그대로, 저장소 참조면 저장소별 순차 리더(readers: store → reader)로 읽습니다.
 * 돌려준 뷰는 다음 읽기 전까지만 유효합니다 (리더의 창 버퍼를 재사용).
 */
export async function readSampleData(src, i, readers, makeReader) {
  const data = src.dataAt(i);
  if (data) return data;
  const store = src.store;
  if (!store) throw new Error('저장소 참조 샘플에는 store가 필요합니다');
  let reader = readers.get(store);
  if (!reader) { reader = makeReader(store); readers.set(store, reader); }
  return reader.read(src.offsetAt(i), src.sizeAt(i));
}
