// Video Recorder - 탭 영상 트랙을 WebCodecs(VideoEncoder)로 H.264 인코딩하고
// 컨테이너 오디오(MP3)와 함께 MP4/MOV/fMP4/AVI 파일로 기록합니다.
// - MP4/MOV: 녹화 중 샘플을 최종 파일(mdat)에 바로 쓰고 중지 시 moov만 붙임 (DirectMp4Writer)
// - fMP4: 녹화 중 약 2초마다 moof+mdat 조각을 바로 씀 (FragmentedMp4Writer)
// - AVI: 녹화 중 청크 저장소(OPFS)에 쌓았다가 중지 시 머싱 (writeAvi, 2 GB 초과 예상 시 MP4로)
import { VIDEO_SETTINGS, VIDEO_FORMATS, ERROR_MESSAGES } from './constants.js';
import { writeMp4 } from './muxers/mp4-muxer.js';
import { writeAvi, countNalUnits, AVI_MAX_BYTES } from './muxers/avi-muxer.js';
import { DirectMp4Writer } from './muxers/direct-mp4-writer.js';
import { FragmentedMp4Writer } from './muxers/fmp4-writer.js';
import { parseAvcC } from './muxers/h264.js';
import { ContainerAudioEncoder } from './container-audio-encoder.js';
import { MemoryFileSink } from './storage/chunk-store.js';
import { SampleIndex } from './storage/sample-index.js';
import { trackSampleCount, trackDataBytes } from './muxers/sample-access.js';
import { fileExtension } from './utils.js';

const MIME_TYPES = {
  [VIDEO_FORMATS.MP4]: 'video/mp4',
  [VIDEO_FORMATS.MOV]: 'video/quicktime',
  [VIDEO_FORMATS.AVI]: 'video/x-msvideo',
  [VIDEO_FORMATS.FMP4]: 'video/mp4'
};

function describeError(error) {
  if (!error) return '알 수 없는 오류';
  if (error.name && error.name !== 'Error') return `${error.name}: ${error.message}`;
  return error.message || String(error);
}

/** 녹화 중 결과 파일 쓰기 실패 → 사용자에게 보여 줄 오류 (원인 포함, code로 구분) */
function videoWriteError(cause) {
  const error = new Error(`${ERROR_MESSAGES.VIDEO_WRITE_FAILED} (원인: ${describeError(cause)})`);
  error.code = 'VIDEO_WRITE_FAILED';
  error.cause = cause;
  return error;
}

/**
 * 해상도와 프레임레이트로 영상 비트레이트를 추정합니다.
 */
export function computeVideoBitrate(width, height, frameRate, settings = VIDEO_SETTINGS) {
  const estimate = Math.round(width * height * frameRate * settings.BITS_PER_PIXEL_PER_FRAME);
  return Math.min(settings.MAX_BITRATE, Math.max(settings.MIN_BITRATE, estimate));
}

function defaultDeps() {
  return {
    VideoEncoder: globalThis.VideoEncoder,
    MediaStreamTrackProcessor: globalThis.MediaStreamTrackProcessor,
    OffscreenCanvas: globalThis.OffscreenCanvas,
    VideoFrame: globalThis.VideoFrame,
    now: () => (globalThis.performance ? performance.now() : Date.now())
  };
}

/**
 * AVI 2GB 한계 판단용 예상 크기 (청크 헤더·색인 여유 포함). 배열 형식과 SampleIndex 형식 모두 지원
 */
export function estimateAviSize(video, audio) {
  const v = trackDataBytes(video) + 40 * trackSampleCount(video);
  return audio ? v + trackDataBytes(audio) + 24 * trackSampleCount(audio) : v;
}

/**
 * MediaStream 비디오 트랙 → H.264 샘플 목록
 */
export class VideoTrackEncoder {
  /**
   * @param {{track: MediaStreamTrack, chunkStore?: Object, sampleSink?: Object, deps?: Object, settings?: Object}} options
   *   chunkStore: 인코딩된 청크를 넘길 저장소(ChunkStore). 주어지면 메모리에는 샘플 객체 없이 SampleIndex(typed array)에
   *   오프셋·크기·타임스탬프·키프레임·NAL 개수만 남깁니다 (샘플당 23바이트, 3시간 약 32만 샘플 ≈ 7~12 MB). (AVI)
   *   sampleSink: 결과 파일 작성기(DirectMp4Writer / FragmentedMp4Writer). 첫 키프레임에서 setVideoConfig({width,height,avcC}),
   *   이후 청크마다 addVideoSample(data, {timestamp: 원본, keyframe, nalCount}). 인코더는 샘플 배열·인덱스를 두지 않습니다.
   *   세 경로 모두 원본(캡처) 타임스탬프를 보관하고, 출력 타임스탬프는 adjustTimestamp(raw, i)로 계산합니다.
   */
  constructor({ track, chunkStore = null, sampleSink = null, deps = {}, settings = VIDEO_SETTINGS }) {
    this.track = track;
    this.chunkStore = sampleSink ? null : chunkStore;
    this.sampleSink = sampleSink;
    this.deps = { ...defaultDeps(), ...deps };
    this.settings = settings;
    this.nalLengthSize = 4;
    this.retainedBytes = 0; // 메모리에 보유 중인 청크 바이트 (저장소 사용 시 0)

    this.encoder = null;
    this.reader = null;
    this.readLoop = null;
    this.codec = null;

    this.width = 0;
    this.height = 0;
    this.avcC = null;
    // 저장소 경로: SampleIndex (샘플마다 객체를 만들지 않음) / 작성기 경로: 개수만 / 메모리 경로: { data, timestamp, keyframe } 배열
    this.index = this.chunkStore ? new SampleIndex({ kind: 'video' }) : null;
    this.rawSamples = this.chunkStore || sampleSink ? null : [];
    this.sinkSamples = 0;
    this.sinkConfigured = false;
    this.firstChunkTimestamp = null; // 첫 출력 청크의 원본 타임스탬프 (출력 타임스탬프 원점)
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.normalizedFrames = 0;
    this.scaledFrames = 0;
    this.canvas = null;
    this.canvasContext = null;
    this.lastChunkTimestamp = null;

    this.audioStartTime = null;
    this.firstFrameTime = null;
    this.alignmentOffsetUs = 0;

    // 일시정지/재개
    this.paused = false;
    this.pausedFrames = 0;           // 일시정지 중 읽고 버린 프레임 (드롭과 별도 집계)
    this.pauseStartedAt = null;      // 진행 중인 일시정지의 시작 시각 (deps.now 기준, ms)
    this.pendingPauseWallUs = 0;     // 아직 타임스탬프에 반영하지 않은 일시정지 시간 (벽시계, µs)
    this.resumePending = false;      // 재개 후 첫 프레임에서 간격 보정 + 키프레임
    this.pauseOffsetUs = 0;          // 지금까지 출력 타임스탬프에서 뺀 일시정지 구간 합계
    this.pauseSegments = [];         // [{ fromTimestamp, offsetUs }] 원본 타임스탬프 기준 보정 구간
    this.lastEncodedTimestamp = null; // 마지막으로 인코더에 넘긴 프레임의 원본 타임스탬프

    this.stopRequested = false;
    this.ended = false;
    this.encoderError = null;
  }

  /** 지금까지 받은 인코딩 샘플 수 */
  get sampleCount() {
    if (this.sampleSink) return this.sinkSamples;
    return this.index ? this.index.length : this.rawSamples.length;
  }

  /** 오디오 파이프라인 시작 시각(ms, deps.now 기준) - A/V 정렬에 사용 */
  setAudioStartTime(time) {
    this.audioStartTime = time;
  }

  /**
   * 일시정지: 트랙은 계속 읽되(버퍼 적체 방지) 프레임을 인코딩하지 않고 바로 닫습니다.
   */
  pause() {
    if (this.paused || this.stopRequested) return;
    this.paused = true;
    this.pauseStartedAt = this.deps.now();
    console.log('[VideoTrackEncoder] 일시정지');
  }

  /**
   * 재개: 다음에 인코딩하는 프레임부터 일시정지 구간을 타임스탬프에서 빼고(끊김 없이 이어 붙임) 키프레임으로 시작합니다.
   */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    const wallMs = typeof this.pauseStartedAt === 'number' ? this.deps.now() - this.pauseStartedAt : 0;
    this.pendingPauseWallUs += Math.max(0, Math.round(wallMs * 1000));
    this.pauseStartedAt = null;
    this.resumePending = true;
    console.log('[VideoTrackEncoder] 재개 (일시정지', Math.round(wallMs), 'ms)');
  }

  async start() {
    const { VideoEncoder, MediaStreamTrackProcessor } = this.deps;
    if (!VideoEncoder || !MediaStreamTrackProcessor) {
      throw new Error(ERROR_MESSAGES.VIDEO_ENCODER_UNSUPPORTED);
    }

    this.codec = await this.probeCodec();

    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => this.handleChunk(chunk, metadata),
      error: (error) => {
        console.error('[VideoTrackEncoder] 인코더 에러:', error);
        this.encoderError = error;
      }
    });

    const processor = new MediaStreamTrackProcessor({ track: this.track });
    this.reader = processor.readable.getReader();
    this.readLoop = this.runReadLoop();
  }

  async probeCodec() {
    const { VideoEncoder } = this.deps;
    // 지원 여부 확인용 임시 해상도 (실제 설정은 첫 프레임에서)
    for (const codec of this.settings.H264_CODEC_CANDIDATES) {
      try {
        const result = await VideoEncoder.isConfigSupported({
          codec,
          width: 1280,
          height: 720,
          bitrate: 4_000_000,
          framerate: this.settings.FRAME_RATE,
          avc: { format: 'avc' }
        });
        if (result && result.supported) {
          console.log('[VideoTrackEncoder] 사용 코덱:', codec);
          return codec;
        }
      } catch (error) {
        console.warn('[VideoTrackEncoder] 코덱 조회 실패:', codec, error);
      }
    }
    throw new Error(ERROR_MESSAGES.VIDEO_ENCODER_UNSUPPORTED);
  }

  configureForFrame(frame) {
    const srcWidth = frame.displayWidth || frame.codedWidth;
    const srcHeight = frame.displayHeight || frame.codedHeight;
    this.width = Math.max(2, srcWidth & ~1);
    this.height = Math.max(2, srcHeight & ~1);
    const bitrate = computeVideoBitrate(this.width, this.height, this.settings.FRAME_RATE, this.settings);

    this.encoder.configure({
      codec: this.codec,
      width: this.width,
      height: this.height,
      bitrate,
      framerate: this.settings.FRAME_RATE,
      latencyMode: this.settings.LATENCY_MODE || 'realtime', // 실시간 캡처: 인코더 큐 적체와 B-프레임 재정렬을 피함
      hardwareAcceleration: 'no-preference',
      avc: { format: 'avc' }
    });

    console.log('[VideoTrackEncoder] 인코더 설정:', { codec: this.codec, width: this.width, height: this.height, bitrate });
  }

  async runReadLoop() {
    try {
      while (!this.stopRequested) {
        const { value: frame, done } = await this.reader.read();
        if (done) {
          this.ended = true;
          break;
        }
        if (!frame) continue;

        try {
          if (this.encoderError) {
            frame.close();
            continue;
          }

          if (this.paused) {
            // 일시정지 중: 인코딩하지 않음 (finally에서 close). 드롭이 아니므로 droppedFrames에 세지 않음
            this.pausedFrames++;
            continue;
          }

          if (this.frameCount === 0) {
            this.firstFrameTime = this.deps.now();
            if (typeof this.audioStartTime === 'number') {
              // 첫 프레임 전에 일시정지했다면 그동안 오디오도 버려졌으므로 그 시간은 정렬 오프셋에서 뺌
              this.alignmentOffsetUs = Math.max(0, Math.round((this.firstFrameTime - this.audioStartTime) * 1000) - this.pendingPauseWallUs);
            }
            // 첫 프레임은 원점(키프레임)이므로 이어 붙일 간격이 없음
            this.pendingPauseWallUs = 0;
            this.resumePending = false;
            this.configureForFrame(frame);
          }

          if (this.encoder.encodeQueueSize > this.settings.MAX_ENCODE_QUEUE) {
            this.droppedFrames++;
            frame.close();
            continue;
          }

          // 재개 후 첫 프레임: 일시정지 구간을 타임스탬프에서 빼고, 이 지점부터 단독 디코딩 가능하도록 키프레임
          let resumeKeyFrame = false;
          if (this.resumePending) {
            this.resumePending = false;
            this.applyPauseGap(frame.timestamp);
            resumeKeyFrame = true;
          }

          // 탭 크기가 바뀌면 프레임 크기도 바뀌므로 설정 크기의 캔버스에 레터박스로 맞춤 (avcC는 파일당 하나)
          const input = this.normalizeFrame(frame);
          const keyFrame = resumeKeyFrame || this.frameCount % this.settings.KEYFRAME_INTERVAL === 0;
          try {
            this.encoder.encode(input, { keyFrame });
          } finally {
            if (input !== frame) { try { input.close(); } catch { /* 무시 */ } }
          }
          this.lastEncodedTimestamp = frame.timestamp;
          this.frameCount++;
        } finally {
          try { frame.close(); } catch { /* 이미 닫힘 */ }
        }
      }
    } catch (error) {
      if (!this.stopRequested) {
        console.error('[VideoTrackEncoder] 프레임 읽기 실패:', error);
        this.encoderError = this.encoderError || error;
      }
    }
  }

  /**
   * 재개 후 첫 프레임에서 일시정지 구간을 계산해 이후 출력 타임스탬프에서 뺍니다.
   * - 간격은 프레임 타임스탬프로 계산합니다: 일시정지 전 마지막 프레임 → 재개 후 첫 프레임 사이에서 한 프레임 간격만 남겨
   *   바로 다음 프레임 자리에 이어 붙입니다 (출력에 빈 구간이 없고 타임스탬프는 엄격히 증가).
   * - 단, 정적인 화면처럼 프레임이 드물면 그 간격에 일시정지가 아닌 녹화 구간까지 섞여 있습니다. 오디오는 실제 일시정지
   *   시간만큼만 빠지므로 그대로 빼면 이후 영상이 오디오보다 앞서게 됩니다. 그래서 실제(벽시계) 일시정지 시간 + 1프레임을
   *   상한으로 둡니다 (연속으로 프레임이 오는 화면에서는 상한에 걸리지 않음).
   */
  applyPauseGap(timestamp) {
    const wallUs = this.pendingPauseWallUs;
    this.pendingPauseWallUs = 0;
    if (this.lastEncodedTimestamp === null) return;
    const frameUs = Math.round(1_000_000 / this.settings.FRAME_RATE);
    let gapUs = timestamp - this.lastEncodedTimestamp - frameUs;
    if (wallUs > 0) gapUs = Math.min(gapUs, wallUs + frameUs);
    gapUs = Math.max(0, gapUs);
    if (gapUs === 0) return;
    this.pauseOffsetUs += gapUs;
    this.pauseSegments.push({ fromTimestamp: timestamp, offsetUs: this.pauseOffsetUs });
    console.log('[VideoTrackEncoder] 일시정지 구간 제외:', Math.round(gapUs / 1000), 'ms (누적', Math.round(this.pauseOffsetUs / 1000), 'ms)');
  }

  /** 원본(캡처) 타임스탬프 → 일시정지 구간을 뺀 타임스탬프 (구간은 시작 타임스탬프 순으로 쌓이므로 이진 탐색) */
  outputTimestamp(timestamp) {
    const segments = this.pauseSegments;
    let lo = 0, hi = segments.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timestamp >= segments[mid].fromTimestamp) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found >= 0 ? timestamp - segments[found].offsetUs : timestamp;
  }

  /**
   * 원본(캡처) 타임스탬프 → 파일에 쓸 출력 타임스탬프(µs, 첫 샘플 = 0).
   * 일시정지 구간을 빼고, 두 번째 샘플부터 A/V 정렬 오프셋(오디오 시작 → 첫 프레임 도착)을 더합니다.
   * 필요한 값(정렬 오프셋: 첫 프레임을 읽을 때, 일시정지 구간: 재개 후 첫 프레임을 인코더에 넘기기 전)은 해당 샘플이
   * 인코더에서 나오기 전에 정해지므로, 샘플이 들어올 때(fMP4 조각) 계산해도 중지 시(MP4 moov) 계산해도 같은 값입니다.
   * @param {number} raw - 원본 타임스탬프 (µs)
   * @param {number} i - 샘플 순번
   */
  adjustTimestamp(raw, i) {
    if (i === 0) return 0;
    return (this.outputTimestamp(raw) - this.outputTimestamp(this.firstChunkTimestamp)) + this.alignmentOffsetUs;
  }

  /**
   * 프레임 크기가 인코더 설정과 다를 때의 처리:
   * - 가로세로 비율이 같으면(2% 이내) 원본을 그대로 넘깁니다. Chrome VideoEncoder는 설정 크기로 스케일링하며
   *   추가 메모리가 거의 없습니다 (헤드리스 Chrome 148 측정: 200프레임 +14MB).
   * - 비율이 실제로 바뀐 경우(창 크기 변경 등)에만 OffscreenCanvas에 레터박스로 그려 새 VideoFrame을 만듭니다.
   *   이 경로는 2D 캔버스의 이미지 캐시 때문에 수백 MB까지 메모리가 늘어난 뒤 정체하므로 꼭 필요할 때만 사용합니다.
   */
  normalizeFrame(frame) {
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (w === this.width && h === this.height) return frame;

    const aspectDiff = Math.abs((w / h) / (this.width / this.height) - 1);
    if (aspectDiff <= 0.02) {
      this.scaledFrames++;
      return frame;
    }

    const { OffscreenCanvas, VideoFrame } = this.deps;
    if (typeof OffscreenCanvas !== 'function' || typeof VideoFrame !== 'function') return frame;

    try {
      if (!this.canvas) {
        this.canvas = new OffscreenCanvas(this.width, this.height);
        this.canvasContext = this.canvas.getContext('2d');
      }
      const ctx = this.canvasContext;
      const scale = Math.min(this.width / w, this.height / h);
      const drawW = Math.round(w * scale);
      const drawH = Math.round(h * scale);
      const x = Math.round((this.width - drawW) / 2);
      const y = Math.round((this.height - drawH) / 2);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.drawImage(frame, x, y, drawW, drawH);
      this.normalizedFrames++;
      return new VideoFrame(this.canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
    } catch (error) {
      console.warn('[VideoTrackEncoder] 프레임 정규화 실패, 원본 사용:', error);
      return frame;
    }
  }

  handleChunk(chunk, metadata) {
    if (this.lastChunkTimestamp !== null && chunk.timestamp < this.lastChunkTimestamp && !this.encoderError) {
      // B-프레임 재정렬 등으로 표시 순서가 디코딩 순서와 달라지면 현재 머서(ctts 없음)로는 올바른 타이밍을 쓸 수 없음
      this.encoderError = new Error(`인코더가 역행하는 타임스탬프를 반환했습니다 (${chunk.timestamp} < ${this.lastChunkTimestamp})`);
      console.error('[VideoTrackEncoder]', this.encoderError.message);
    }
    this.lastChunkTimestamp = chunk.timestamp;

    if (metadata && metadata.decoderConfig && metadata.decoderConfig.description && !this.avcC) {
      const desc = metadata.decoderConfig.description;
      this.avcC = desc instanceof Uint8Array ? desc.slice() : new Uint8Array(desc.buffer ? desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength) : desc);
      try { this.nalLengthSize = parseAvcC(this.avcC).nalLengthSize; } catch { this.nalLengthSize = 4; }
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const keyframe = chunk.type === 'key';
    // 원본 타임스탬프로 보관하고 출력 타임스탬프(일시정지 구간 제외 + 정렬 오프셋)는 adjustTimestamp로 계산
    const timestamp = chunk.timestamp;
    if (this.firstChunkTimestamp === null) this.firstChunkTimestamp = timestamp;
    if (this.sampleSink) {
      // 결과 파일 작성기로 바로 (MP4/MOV: mdat에 도착 순서대로, fMP4: 조각에 모았다가 기록)
      if (!this.sinkConfigured && this.avcC) {
        this.sinkConfigured = true;
        this.sampleSink.setVideoConfig({ width: this.width, height: this.height, avcC: this.avcC });
      }
      this.sampleSink.addVideoSample(data, { timestamp, keyframe, nalCount: countNalUnits(data, this.nalLengthSize) });
      this.sinkSamples++;
    } else if (this.chunkStore) {
      // 데이터는 디스크 저장소로, 메모리에는 typed array 인덱스에 오프셋·크기와 Annex B 변환 크기 계산용 NAL 개수만
      const store = this.chunkStore;
      const offset = typeof store.appendBytes === 'function' ? store.appendBytes(data) : store.append(data).offset;
      this.index.push(offset, data.length, timestamp, keyframe, countNalUnits(data, this.nalLengthSize));
    } else {
      this.retainedBytes += data.length;
      this.rawSamples.push({ data, timestamp, keyframe });
    }
  }

  /**
   * 캡처를 중단하고 인코딩을 마무리합니다.
   * @returns {Promise<Object>} 머서 입력 트랙 (getTrack 참고)
   */
  async stop() {
    this.stopRequested = true;

    if (this.reader) {
      try { await this.reader.cancel(); } catch (error) { console.warn('[VideoTrackEncoder] reader.cancel 실패:', error); }
    }
    if (this.readLoop) {
      await this.readLoop;
    }

    if (this.encoder && this.encoder.state === 'configured') {
      try {
        await this.encoder.flush();
      } catch (error) {
        console.warn('[VideoTrackEncoder] flush 실패:', error);
        this.encoderError = this.encoderError || error;
      }
    }
    if (this.encoder && this.encoder.state !== 'closed') {
      try { this.encoder.close(); } catch { /* 무시 */ }
    }

    if (this.encoderError) {
      throw new Error(`${ERROR_MESSAGES.VIDEO_ENCODING_FAILED} (${this.encoderError.message || this.encoderError})`);
    }

    if (this.chunkStore) {
      await this.chunkStore.finalize();
    }

    const storage = this.sampleSink ? (this.sampleSink.kind || 'sink') : (this.chunkStore ? this.chunkStore.kind : 'memory');
    const indexBytes = this.index ? this.index.bytesUsed : (this.sampleSink && this.sampleSink.indexBytes) || 0;
    console.log('[VideoTrackEncoder] 완료:', { frames: this.frameCount, dropped: this.droppedFrames, paused: this.pausedFrames, pauseOffsetMs: Math.round(this.pauseOffsetUs / 1000), normalized: this.normalizedFrames, scaled: this.scaledFrames, samples: this.sampleCount, storage, indexMB: +(indexBytes / 1048576).toFixed(1) });
    return this.getTrack();
  }

  /**
   * 머서 입력 트랙.
   * - 저장소 경로: { width, height, avcC, index, timestampAt, store } - 샘플 객체를 만들지 않고, 출력 타임스탬프는
   *   timestampAt(i) = adjustTimestamp(원본, i) 접근자로 적용합니다 (첫 샘플은 원점 0, 이후 샘플은 정렬 오프셋만큼 뒤로).
   * - 작성기 경로: { width, height, avcC, sampleCount } (샘플은 이미 결과 파일 작성기에 있음)
   * - 메모리 경로: { width, height, avcC, samples, store: null }
   */
  getTrack() {
    const base = { width: this.width, height: this.height, avcC: this.avcC, store: this.chunkStore };
    if (this.sampleSink) return { ...base, sampleCount: this.sinkSamples };
    if (!this.index) return { ...base, samples: this.getSamples() };
    const index = this.index;
    return { ...base, index, timestampAt: (i) => this.adjustTimestamp(index.timestamps[i], i) };
  }

  /** (메모리 경로) 출력 타임스탬프를 적용한 샘플 목록. 저장소 경로는 샘플 객체를 만들지 않으므로 getTrack()을 사용 */
  getSamples() {
    if (!this.rawSamples) return null;
    return this.rawSamples.map((s, i) => ({
      data: s.data,
      ref: s.ref,
      nalCount: s.nalCount,
      keyframe: s.keyframe,
      timestamp: this.adjustTimestamp(s.timestamp, i)
    }));
  }
}

/**
 * 영상 트랙 인코딩 + 컨테이너 오디오 인코딩 + 결과 파일 기록을 묶은 세션
 */
export class VideoRecordingSession {
  /**
   * @param {{format:string, videoTrack:MediaStreamTrack, sampleRate:number, bitrateKbps:number, channels?:number, storage?:Object, outputSinkFactory?:Function, onError?:Function, writerOptions?:Object, deps?:Object, settings?:Object}} options
   *   storage: createRecordingStorage()가 만든 저장소. 결과 파일(폴더 저장이 아닐 때)과 AVI 청크 저장소를 디스크(OPFS)에 둡니다.
   *   outputSinkFactory: async (format, mimeType) => FileSink | null. 주어지면 결과 파일을 저장소 대신 이 싱크
   *     (예: 사용자가 고른 폴더의 DirectoryFileSink)에 기록합니다. null이면 저장소 싱크를 씁니다.
   *     - MP4/MOV/fMP4: 녹화 시작 때 열어 녹화 중 바로 기록 (열기 실패 → 저장소 싱크로 기록, outputError에 원인)
   *     - AVI: 중지 시 실제 포맷(2 GB 한계 시 mp4)으로 열어 머싱 (기록 실패 → 청크 저장소에서 저장소 싱크로 다시 머싱)
   *   onError: (error) => void. MP4/MOV/fMP4를 녹화 중 기록하다 실패하면(권한 회수, 드라이브 분리, 디스크 부족) 한 번 호출
   *     (error.code = 'VIDEO_WRITE_FAILED', 메시지 ERROR_MESSAGES.VIDEO_WRITE_FAILED). 호출자는 녹화를 멈춰야 합니다 - 청크 저장소가
   *     없어 다른 곳에 다시 만들 수 없고, 이후 샘플은 버려집니다.
   *   writerOptions: 작성기 옵션 (테스트용: { bufferBytes } DirectMp4Writer 버퍼, { fragmentDurationUs } fMP4 조각 길이)
   */
  constructor({ format, videoTrack, sampleRate, bitrateKbps, channels = 2, storage = null, outputSinkFactory = null, onError = null, writerOptions = {}, deps = {}, settings = VIDEO_SETTINGS }) {
    if (!MIME_TYPES[format]) {
      throw new Error(`지원하지 않는 영상 포맷입니다: ${format}`);
    }
    this.format = format;
    this.actualFormat = format; // AVI 크기 한계 초과 시 mp4로 바뀔 수 있음
    this.warning = null;
    this.settings = settings;
    this.storage = storage;
    this.outputSinkFactory = outputSinkFactory;
    this.onError = onError;
    this.writerOptions = writerOptions || {};
    // MP4/MOV/fMP4는 녹화 중 결과 파일에 바로 기록, AVI는 청크 저장소 → 중지 시 머싱
    this.writesDirectly = format !== VIDEO_FORMATS.AVI;
    this.writer = null;       // DirectMp4Writer | FragmentedMp4Writer
    this.writeError = null;   // 녹화 중 결과 파일 쓰기 실패 (사용자용 오류, code VIDEO_WRITE_FAILED)
    this.outputTarget = null; // 결과 파일 위치: 'custom'(outputSinkFactory 싱크) | 'opfs' | 'memory'
    this.outputError = null;  // outputSinkFactory 싱크 실패 원인 (저장소로 폴백한 경우)
    this.audioOptions = { sampleRate, channels, bitrateKbps };
    this.videoTrack = videoTrack;
    this.deps = deps;
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.paused = false;
    this.stats = { videoFrames: 0, droppedFrames: 0, pausedFrames: 0, audioFrames: 0, bytes: 0 };
  }

  async start() {
    if (this.writesDirectly) {
      await this.startWriter();
      this.videoEncoder = new VideoTrackEncoder({ track: this.videoTrack, sampleSink: this.writer, deps: this.deps, settings: this.settings });
      this.audioEncoder = new ContainerAudioEncoder({ ...this.audioOptions, frameSink: this.writer });
    } else {
      const videoStore = this.storage ? await this.storage.createChunkStore('video.bin') : null;
      const audioStore = this.storage ? await this.storage.createChunkStore('container-audio.bin') : null;
      this.videoEncoder = new VideoTrackEncoder({ track: this.videoTrack, chunkStore: videoStore, deps: this.deps, settings: this.settings });
      this.audioEncoder = new ContainerAudioEncoder({ ...this.audioOptions, chunkStore: audioStore });
    }
    if (typeof this.audioStartTime === 'number') this.videoEncoder.setAudioStartTime(this.audioStartTime);
    if (this.paused) this.videoEncoder.pause();
    this.audioEncoder.start();
    await this.videoEncoder.start();
  }

  /** 결과 파일 싱크를 열고 작성기 시작 (지정 출력이 실패하면 저장소 싱크로) */
  async startWriter() {
    const format = this.format;
    const mimeType = MIME_TYPES[format];
    let sink = null;
    if (this.outputSinkFactory) {
      try {
        sink = await this.outputSinkFactory(format, mimeType);
      } catch (error) {
        console.warn('[VideoRecordingSession] 지정 출력을 열지 못함 → 저장소에 기록:', error);
        this.outputError = error;
        sink = null;
      }
    }
    if (sink) {
      try {
        this.writer = this.createWriter(sink);
        await this.writer.start();
        this.outputTarget = 'custom';
        return;
      } catch (error) {
        console.warn('[VideoRecordingSession] 지정 출력에 쓰지 못함 → 저장소에 기록:', error);
        this.outputError = error;
        try { await sink.abort({ remove: true }); } catch { /* 무시 */ }
      }
    }
    const storageSink = this.storage
      ? await this.storage.createFileSink(`video.${fileExtension(format)}`, mimeType)
      : new MemoryFileSink(mimeType);
    this.writer = this.createWriter(storageSink);
    await this.writer.start();
    this.outputTarget = this.storage ? this.storage.kind : 'memory';
  }

  createWriter(sink) {
    const { sampleRate, channels, bitrateKbps } = this.audioOptions;
    const common = {
      sink,
      audio: { codec: VIDEO_SETTINGS.CONTAINER_AUDIO_CODEC, sampleRate, channels, bitrate: bitrateKbps * 1000 },
      // 원본 타임스탬프 → 출력 타임스탬프 (A/V 정렬 오프셋 + 일시정지 구간 제외): MP4는 중지 시, fMP4는 샘플이 들어올 때 적용
      videoTimestampAdjust: (raw, i) => this.videoEncoder.adjustTimestamp(raw, i),
      onError: (error) => this.handleWriteError(error)
    };
    if (this.format === VIDEO_FORMATS.FMP4) {
      return new FragmentedMp4Writer({ ...common, fragmentDurationUs: this.writerOptions.fragmentDurationUs });
    }
    return new DirectMp4Writer({ ...common, container: this.format, bufferBytes: this.writerOptions.bufferBytes });
  }

  /** 녹화 중 결과 파일 쓰기 실패: 조용히 계속하지 않고 호출자(offscreen)에게 알려 녹화를 멈추게 함 */
  handleWriteError(cause) {
    if (this.writeError) return;
    this.writeError = videoWriteError(cause);
    console.error('[VideoRecordingSession] 녹화 중 영상 파일 기록 실패 → 녹화 중지 필요:', describeError(cause));
    if (this.onError) {
      try { this.onError(this.writeError); } catch (error) { console.warn('[VideoRecordingSession] onError 처리 실패:', error); }
    }
  }

  setAudioStartTime(time) {
    this.audioStartTime = time;
    if (this.videoEncoder) this.videoEncoder.setAudioStartTime(time);
  }

  pushAudio(left, right) {
    this.audioEncoder.processChunk(left, right);
  }

  /**
   * 일시정지: 영상 프레임 인코딩을 멈춥니다. 컨테이너 오디오는 호출자(offscreen)가 pushAudio를 멈춰서 처리합니다
   * (일시정지 경계까지의 PCM은 워크릿에서 늦게 도착할 수 있어 여기서 끊지 않음).
   */
  pause() {
    this.paused = true;
    if (this.videoEncoder) this.videoEncoder.pause();
  }

  /** 재개: 영상 인코딩을 이어서 진행 (일시정지 구간은 타임스탬프에서 제외) */
  resume() {
    this.paused = false;
    if (this.videoEncoder) this.videoEncoder.resume();
  }

  /**
   * @returns {Promise<Blob>} 완성된 영상 파일
   */
  async stop() {
    if (!this.videoEncoder) throw new Error('세션이 시작되지 않았습니다');
    return this.writesDirectly ? this.stopDirect() : this.stopChunked();
  }

  // MP4/MOV/fMP4: 샘플은 이미 결과 파일에 있으므로 인코더 마감 후 moov(또는 마지막 조각)만 씀
  async stopDirect() {
    // 중지 단계별 시간 (진단용: 인코더 flush / 컨테이너 오디오 마감 / moov 계산 / 기록 / 출력 닫기)
    const now = () => (globalThis.performance ? performance.now() : Date.now());
    const t0 = now();
    let result;
    try {
      await this.videoEncoder.stop();
      const t1 = now();
      if (this.audioEncoder.isStarted) await this.audioEncoder.finish();
      this.timings = { encoderMs: Math.round(t1 - t0), containerAudioMs: Math.round(now() - t1) };
      if (this.writeError) throw this.writeError;
      if (!this.videoEncoder.sampleCount || !this.videoEncoder.avcC) {
        throw new Error(ERROR_MESSAGES.NO_VIDEO);
      }
      result = await this.writer.finish();
    } catch (error) {
      // 결과 파일을 완성할 수 없음: 쓰다 만 파일(사용자 폴더의 빈 대상 파일 포함)을 지움
      try { await this.writer.abort({ remove: true }); } catch { /* 무시 */ }
      if (this.writeError) throw this.writeError;
      if (this.writer.error) { this.handleWriteError(this.writer.error); throw this.writeError; }
      throw error;
    }
    this.actualFormat = this.format;
    const blob = result.blob;
    Object.assign(this.timings, result.timings);
    this.stats = {
      videoFrames: this.videoEncoder.sampleCount,
      droppedFrames: this.videoEncoder.droppedFrames,
      pausedFrames: this.videoEncoder.pausedFrames,
      audioFrames: this.audioEncoder.frameCount,
      bytes: blob.size,
      storage: 'direct',
      writer: this.writer.kind,
      output: this.outputTarget
    };
    if (this.writer.fragmentsWritten !== undefined) this.stats.fragments = this.writer.fragmentsWritten;
    console.log('[VideoRecordingSession] 기록 완료:', this.format, this.stats);
    return blob;
  }

  // AVI: 청크 저장소의 샘플을 읽어 결과 파일로 머싱
  async stopChunked() {
    // 중지 단계별 시간 (진단용: 인코더 flush+저장소 마감 / 컨테이너 오디오 마감 / 머싱 계획 / 기록 / 출력 닫기)
    const now = () => (globalThis.performance ? performance.now() : Date.now());
    const t0 = now();
    const video = await this.videoEncoder.stop();
    const t1 = now();
    const audio = this.audioEncoder.isStarted ? await this.audioEncoder.finish() : null;
    this.timings = { encoderMs: Math.round(t1 - t0), containerAudioMs: Math.round(now() - t1) };

    const videoCount = trackSampleCount(video);
    if (!videoCount || !video.avcC) {
      throw new Error(ERROR_MESSAGES.NO_VIDEO);
    }

    let format = this.format;
    if (format === VIDEO_FORMATS.AVI) {
      const estimated = estimateAviSize(video, audio);
      if (estimated > AVI_MAX_BYTES) {
        console.warn('[VideoRecordingSession] AVI 2GB 한계 초과 → MP4로 저장');
        this.warning = ERROR_MESSAGES.AVI_TOO_LARGE;
        format = VIDEO_FORMATS.MP4;
      }
    }
    this.actualFormat = format;

    // 결과 파일은 디스크 싱크에 한 샘플씩 스트리밍 → 메모리 사용량이 파일 크기와 무관
    const mimeType = MIME_TYPES[format];
    const mux = (output) => (format === VIDEO_FORMATS.AVI
      ? writeAvi({ video, audio, frameRate: this.settings.FRAME_RATE, output })
      : writeMp4({ container: format, video, audio, output }));

    let result = null;
    if (this.outputSinkFactory) {
      // 지정 출력(사용자 폴더)에 직접 기록: 저장소의 청크를 읽어 바로 최종 파일로 → OPFS 결과 파일·다운로드 복사 없음
      let output = null;
      try {
        output = await this.outputSinkFactory(format, mimeType);
        if (output) {
          result = await mux(output);
          this.outputTarget = 'custom';
        }
      } catch (error) {
        console.warn('[VideoRecordingSession] 지정 출력에 기록 실패 → 저장소로 다시 머싱:', error);
        this.outputError = error;
        result = null;
        if (output) { try { await output.abort({ remove: true }); } catch { /* 무시 */ } }
      }
    }
    if (!result) {
      // 청크 저장소는 그대로 남아 있으므로 실패 후에도 처음부터 다시 머싱할 수 있음
      const output = this.storage
        ? await this.storage.createFileSink(`video.${format}`, mimeType)
        : new MemoryFileSink(mimeType);
      result = await mux(output);
      this.outputTarget = this.storage ? this.storage.kind : 'memory';
    }

    const blob = result.blob;
    if (result.timings) Object.assign(this.timings, result.timings);
    this.stats = {
      videoFrames: videoCount,
      droppedFrames: this.videoEncoder.droppedFrames,
      pausedFrames: this.videoEncoder.pausedFrames,
      audioFrames: trackSampleCount(audio),
      bytes: blob.size,
      storage: this.storage ? this.storage.kind : 'memory',
      output: this.outputTarget
    };
    console.log('[VideoRecordingSession] 머싱 완료:', format, this.stats);
    return blob;
  }
}

export { MIME_TYPES as VIDEO_MIME_TYPES };
