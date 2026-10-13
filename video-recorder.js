// Video Recorder - 탭 영상 트랙을 WebCodecs(VideoEncoder)로 H.264 인코딩하고
// 컨테이너 오디오(MP3)와 함께 MP4/MOV/AVI로 머싱합니다.
import { VIDEO_SETTINGS, VIDEO_FORMATS, ERROR_MESSAGES } from './constants.js';
import { buildMp4 } from './muxers/mp4-muxer.js';
import { buildAvi, AVI_MAX_BYTES } from './muxers/avi-muxer.js';
import { ContainerAudioEncoder } from './container-audio-encoder.js';

const MIME_TYPES = {
  [VIDEO_FORMATS.MP4]: 'video/mp4',
  [VIDEO_FORMATS.MOV]: 'video/quicktime',
  [VIDEO_FORMATS.AVI]: 'video/x-msvideo'
};

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
 * MediaStream 비디오 트랙 → H.264 샘플 목록
 */
export class VideoTrackEncoder {
  /**
   * @param {{track: MediaStreamTrack, deps?: Object, settings?: Object}} options
   */
  constructor({ track, deps = {}, settings = VIDEO_SETTINGS }) {
    this.track = track;
    this.deps = { ...defaultDeps(), ...deps };
    this.settings = settings;

    this.encoder = null;
    this.reader = null;
    this.readLoop = null;
    this.codec = null;

    this.width = 0;
    this.height = 0;
    this.avcC = null;
    this.rawSamples = [];
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

    this.stopRequested = false;
    this.ended = false;
    this.encoderError = null;
  }

  /** 오디오 파이프라인 시작 시각(ms, deps.now 기준) - A/V 정렬에 사용 */
  setAudioStartTime(time) {
    this.audioStartTime = time;
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

          if (this.frameCount === 0) {
            this.firstFrameTime = this.deps.now();
            if (typeof this.audioStartTime === 'number') {
              this.alignmentOffsetUs = Math.max(0, Math.round((this.firstFrameTime - this.audioStartTime) * 1000));
            }
            this.configureForFrame(frame);
          }

          if (this.encoder.encodeQueueSize > this.settings.MAX_ENCODE_QUEUE) {
            this.droppedFrames++;
            frame.close();
            continue;
          }

          // 탭 크기가 바뀌면 프레임 크기도 바뀌므로 설정 크기의 캔버스에 레터박스로 맞춤 (avcC는 파일당 하나)
          const input = this.normalizeFrame(frame);
          const keyFrame = this.frameCount % this.settings.KEYFRAME_INTERVAL === 0;
          try {
            this.encoder.encode(input, { keyFrame });
          } finally {
            if (input !== frame) { try { input.close(); } catch { /* 무시 */ } }
          }
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
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.rawSamples.push({ data, timestamp: chunk.timestamp, keyframe: chunk.type === 'key' });
  }

  /**
   * 캡처를 중단하고 인코딩을 마무리합니다.
   * @returns {Promise<{width:number, height:number, avcC:Uint8Array|null, samples:Array}>}
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

    console.log('[VideoTrackEncoder] 완료:', { frames: this.frameCount, dropped: this.droppedFrames, normalized: this.normalizedFrames, scaled: this.scaledFrames, samples: this.rawSamples.length });
    return { width: this.width, height: this.height, avcC: this.avcC, samples: this.getSamples() };
  }

  /** 정렬 오프셋을 적용한 샘플 목록 (첫 샘플은 원점 유지, 이후 샘플은 오프셋만큼 뒤로) */
  getSamples() {
    if (this.rawSamples.length === 0) return [];
    const origin = this.rawSamples[0].timestamp;
    return this.rawSamples.map((s, i) => ({
      data: s.data,
      keyframe: s.keyframe,
      timestamp: i === 0 ? 0 : (s.timestamp - origin) + this.alignmentOffsetUs
    }));
  }
}

/**
 * 영상 트랙 인코딩 + 컨테이너 오디오 인코딩 + 머싱을 묶은 세션
 */
export class VideoRecordingSession {
  /**
   * @param {{format:string, videoTrack:MediaStreamTrack, sampleRate:number, bitrateKbps:number, channels?:number, deps?:Object, settings?:Object}} options
   */
  constructor({ format, videoTrack, sampleRate, bitrateKbps, channels = 2, deps = {}, settings = VIDEO_SETTINGS }) {
    if (!MIME_TYPES[format]) {
      throw new Error(`지원하지 않는 영상 포맷입니다: ${format}`);
    }
    this.format = format;
    this.actualFormat = format; // AVI 크기 한계 초과 시 mp4로 바뀔 수 있음
    this.warning = null;
    this.settings = settings;
    this.videoEncoder = new VideoTrackEncoder({ track: videoTrack, deps, settings });
    this.audioEncoder = new ContainerAudioEncoder({ sampleRate, channels, bitrateKbps });
    this.stats = { videoFrames: 0, droppedFrames: 0, audioFrames: 0, bytes: 0 };
  }

  async start() {
    this.audioEncoder.start();
    await this.videoEncoder.start();
  }

  setAudioStartTime(time) {
    this.videoEncoder.setAudioStartTime(time);
  }

  pushAudio(left, right) {
    this.audioEncoder.processChunk(left, right);
  }

  /**
   * @returns {Promise<Blob>} 완성된 영상 파일
   */
  async stop() {
    const video = await this.videoEncoder.stop();
    const audio = this.audioEncoder.isStarted ? this.audioEncoder.finish() : null;

    if (!video.samples.length || !video.avcC) {
      throw new Error(ERROR_MESSAGES.NO_VIDEO);
    }

    let format = this.format;
    if (format === VIDEO_FORMATS.AVI) {
      const estimated = video.samples.reduce((s, x) => s + x.data.length + 40, 0) + (audio ? audio.frames.reduce((s, f) => s + f.data.length + 24, 0) : 0);
      if (estimated > AVI_MAX_BYTES) {
        console.warn('[VideoRecordingSession] AVI 2GB 한계 초과 → MP4로 저장');
        this.warning = ERROR_MESSAGES.AVI_TOO_LARGE;
        format = VIDEO_FORMATS.MP4;
      }
    }
    this.actualFormat = format;

    const parts = format === VIDEO_FORMATS.AVI
      ? buildAvi({ video, audio, frameRate: this.settings.FRAME_RATE })
      : buildMp4({ container: format, video, audio });

    const blob = new Blob(parts, { type: MIME_TYPES[format] });
    this.stats = {
      videoFrames: video.samples.length,
      droppedFrames: this.videoEncoder.droppedFrames,
      audioFrames: audio ? audio.frames.length : 0,
      bytes: blob.size
    };
    console.log('[VideoRecordingSession] 머싱 완료:', format, this.stats);
    return blob;
  }
}

export { MIME_TYPES as VIDEO_MIME_TYPES };
