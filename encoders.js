// Audio Encoder 인터페이스 및 구현체
// SOLID 원칙: Open/Closed, Liskov Substitution, Dependency Inversion 적용

/**
 * 기본 AudioEncoder 클래스 (인터페이스 역할)
 * 모든 Encoder는 이 클래스를 상속받아 구현
 */
class AudioEncoder {
  /**
   * 오디오 버퍼를 특정 형식으로 인코딩
   * @param {AudioBuffer} audioBuffer - 인코딩할 오디오 버퍼
   * @returns {Promise<Blob>} 인코딩된 Blob
   */
  async encode(audioBuffer) {
    throw new Error('encode() 메서드를 구현해야 합니다');
  }

  /**
   * 지원하는 포맷 반환
   * @returns {string} 포맷 문자열 (예: 'wav', 'mp3')
   */
  getSupportedFormat() {
    throw new Error('getSupportedFormat() 메서드를 구현해야 합니다');
  }

  /**
   * MIME 타입 반환
   * @returns {string} MIME 타입 (예: 'audio/wav', 'audio/mpeg')
   */
  getMimeType() {
    throw new Error('getMimeType() 메서드를 구현해야 합니다');
  }
}

/**
 * WAV Encoder 구현
 * 비압축 PCM 데이터를 WAV 형식으로 인코딩
 */
class WavEncoder extends AudioEncoder {
  getSupportedFormat() {
    return 'wav';
  }

  getMimeType() {
    return 'audio/wav';
  }

  async encode(audioBuffer) {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * numberOfChannels * 2; // 16-bit

    // WAV 파일 버퍼 생성
    const buffer = new ArrayBuffer(44 + length);
    const view = new DataView(buffer);

    // WAV 헤더 작성
    this.writeString(view, 0, 'RIFF'); // ChunkID
    view.setUint32(4, 36 + length, true); // ChunkSize
    this.writeString(view, 8, 'WAVE'); // Format
    this.writeString(view, 12, 'fmt '); // Subchunk1ID
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, numberOfChannels, true); // NumChannels
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * numberOfChannels * 2, true); // ByteRate
    view.setUint16(32, numberOfChannels * 2, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    this.writeString(view, 36, 'data'); // Subchunk2ID
    view.setUint32(40, length, true); // Subchunk2Size

    // PCM 데이터 작성
    const offset = 44;
    const channels = [];

    for (let i = 0; i < numberOfChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }

    let index = 0;
    for (let i = 0; i < audioBuffer.length; i++) {
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, channels[channel][i]));
        view.setInt16(offset + index, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        index += 2;
      }
    }

    console.log('WAV 인코딩 완료:', buffer.byteLength, 'bytes');
    return new Blob([buffer], { type: this.getMimeType() });
  }

  writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

/**
 * MP3 Encoder 구현 (lamejs 사용)
 * PCM 데이터를 MP3 형식으로 인코딩
 */
class Mp3Encoder extends AudioEncoder {
  constructor(bitrate = 128) {
    super();
    this.bitrate = bitrate; // kbps
  }

  getSupportedFormat() {
    return 'mp3';
  }

  getMimeType() {
    return 'audio/mpeg';
  }

  async encode(audioBuffer) {
    // lamejs 라이브러리 확인
    if (typeof lamejs === 'undefined') {
      throw new Error('lamejs 라이브러리가 로드되지 않았습니다');
    }

    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const samples = audioBuffer.length;

    console.log('MP3 인코딩 시작:', {
      channels: numberOfChannels,
      sampleRate: sampleRate,
      samples: samples,
      bitrate: this.bitrate
    });

    // lamejs 인코더 초기화
    const mp3encoder = new lamejs.Mp3Encoder(numberOfChannels, sampleRate, this.bitrate);

    // Float32Array → Int16Array 변환
    const leftChannel = this.floatTo16BitPCM(audioBuffer.getChannelData(0));
    const rightChannel = numberOfChannels > 1
      ? this.floatTo16BitPCM(audioBuffer.getChannelData(1))
      : leftChannel;

    // MP3 프레임 생성
    const mp3Data = [];
    const sampleBlockSize = 1152; // lamejs 권장 크기

    for (let i = 0; i < samples; i += sampleBlockSize) {
      const leftChunk = leftChannel.subarray(i, i + sampleBlockSize);
      const rightChunk = rightChannel.subarray(i, i + sampleBlockSize);

      const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);

      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }
    }

    // 최종 프레임 flush
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }

    console.log('MP3 인코딩 완료:', mp3Data.length, '프레임');

    return new Blob(mp3Data, { type: this.getMimeType() });
  }

  /**
   * Float32Array를 Int16Array로 변환
   * -1.0~1.0 범위를 -32768~32767로 스케일링
   */
  floatTo16BitPCM(float32Array) {
    const int16Array = new Int16Array(float32Array.length);

    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    return int16Array;
  }
}

/**
 * Streaming MP3 Encoder 구현
 * 실시간 오디오 청크를 즉시 MP3로 인코딩하여 메모리 효율 극대화
 *
 * 사용 방법:
 * 1. start() - 인코더 초기화
 * 2. processChunk() - 오디오 청크 실시간 인코딩 (반복)
 * 3. finish() - 최종 MP3 Blob 반환
 */
class StreamingMp3Encoder extends AudioEncoder {
  constructor(channels, sampleRate, bitrate) {
    super();
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.bitrate = bitrate;
    this.mp3encoder = null;
    this.mp3Chunks = [];
    this.isStarted = false;
    this.totalChunksProcessed = 0;
  }

  getSupportedFormat() {
    return 'mp3';
  }

  getMimeType() {
    return 'audio/mpeg';
  }

  /**
   * 배치 인코딩은 지원하지 않음 (스트리밍 전용)
   */
  async encode(audioBuffer) {
    throw new Error('StreamingMp3Encoder는 배치 인코딩을 지원하지 않습니다. processChunk()를 사용하세요.');
  }

  /**
   * 스트리밍 인코더 시작
   */
  async start() {
    if (this.isStarted) {
      throw new Error('인코더가 이미 시작되었습니다');
    }

    if (typeof lamejs === 'undefined') {
      throw new Error('lamejs 라이브러리가 로드되지 않았습니다');
    }

    this.mp3encoder = new lamejs.Mp3Encoder(this.channels, this.sampleRate, this.bitrate);
    this.mp3Chunks = [];
    this.totalChunksProcessed = 0;
    this.isStarted = true;

    console.log('[StreamingMp3Encoder] 시작:', {
      channels: this.channels,
      sampleRate: this.sampleRate,
      bitrate: this.bitrate
    });
  }

  /**
   * 오디오 청크를 실시간으로 인코딩
   * @param {Float32Array} leftChannel - 왼쪽 채널 PCM 데이터
   * @param {Float32Array} rightChannel - 오른쪽 채널 PCM 데이터 (옵션)
   */
  processChunk(leftChannel, rightChannel) {
    if (!this.isStarted) {
      throw new Error('인코더가 시작되지 않았습니다. start()를 먼저 호출하세요.');
    }

    // Float32 → Int16 변환
    const leftInt16 = this.floatTo16BitPCM(leftChannel);
    const rightInt16 = rightChannel ? this.floatTo16BitPCM(rightChannel) : leftInt16;

    // MP3 인코딩 (즉시 처리)
    const mp3buf = this.mp3encoder.encodeBuffer(leftInt16, rightInt16);

    if (mp3buf.length > 0) {
      this.mp3Chunks.push(mp3buf);
    }

    this.totalChunksProcessed++;

    // 메모리 사용량 모니터링 (100청크마다)
    if (this.totalChunksProcessed % 100 === 0) {
      const estimatedMp3Size = this.mp3Chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      console.log('[StreamingMp3Encoder] 진행:', {
        chunks: this.totalChunksProcessed,
        mp3Size: `${(estimatedMp3Size / 1024 / 1024).toFixed(2)} MB`
      });
    }
  }

  /**
   * 인코딩 완료 및 최종 Blob 반환
   * @returns {Blob} 완성된 MP3 파일
   */
  finish() {
    if (!this.isStarted) {
      throw new Error('인코더가 시작되지 않았습니다');
    }

    // 남은 데이터 flush
    const mp3buf = this.mp3encoder.flush();
    if (mp3buf.length > 0) {
      this.mp3Chunks.push(mp3buf);
    }

    const finalSize = this.mp3Chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    console.log('[StreamingMp3Encoder] 완료:', {
      totalChunks: this.totalChunksProcessed,
      mp3Chunks: this.mp3Chunks.length,
      finalSize: `${(finalSize / 1024 / 1024).toFixed(2)} MB`
    });

    const blob = new Blob(this.mp3Chunks, { type: this.getMimeType() });

    // 메모리 정리
    this.isStarted = false;
    this.mp3encoder = null;
    this.mp3Chunks = [];
    this.totalChunksProcessed = 0;

    return blob;
  }

  /**
   * Float32Array를 Int16Array로 변환
   * -1.0~1.0 범위를 -32768~32767로 스케일링
   */
  floatTo16BitPCM(float32Array) {
    const int16Array = new Int16Array(float32Array.length);

    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    return int16Array;
  }
}

/**
 * Streaming WAV Encoder 구현
 * 실시간 오디오 청크를 IndexedDB에 저장하여 메모리 효율 극대화
 *
 * 사용 방법:
 * 1. start() - 인코더 및 IndexedDB 초기화
 * 2. processChunk() - 오디오 청크 실시간 Int16 변환 후 DB 저장 (반복)
 * 3. finish() - DB에서 모든 청크 읽어와 WAV 헤더 붙여서 Blob 반환
 */
class StreamingWavEncoder extends AudioEncoder {
  constructor(channels, sampleRate) {
    super();
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.dbName = `RecordaWavDB_${Date.now()}`; // 타임스탬프로 고유한 DB 이름 생성
    this.db = null;
    this.isStarted = false;
    this.totalSamples = 0; // WAV 헤더 생성 시 필요
    this.chunkCounter = 0; // DB 저장 시 키로 사용

    // 메모리 버퍼 (배치 저장용)
    this.memoryBuffer = [];
    this.bufferFlushSize = 10; // 10개 청크마다 DB에 저장
    this.isFlushing = false; // 플러시 진행 중 플래그
    this.flushQueue = Promise.resolve(); // 플러시 큐
  }

  getSupportedFormat() {
    return 'wav';
  }

  getMimeType() {
    return 'audio/wav';
  }

  /**
   * 배치 인코딩은 지원하지 않음 (스트리밍 전용)
   */
  async encode(audioBuffer) {
    throw new Error('StreamingWavEncoder는 배치 인코딩을 지원하지 않습니다. processChunk()를 사용하세요.');
  }

  /**
   * 스트리밍 인코더 시작 및 IndexedDB 초기화
   */
  async start() {
    if (this.isStarted) {
      throw new Error('인코더가 이미 시작되었습니다');
    }

    // IndexedDB 초기화
    this.db = await this.initDB();
    this.totalSamples = 0;
    this.chunkCounter = 0;
    this.memoryBuffer = []; // 메모리 버퍼 초기화
    this.isFlushing = false; // 플러시 플래그 초기화
    this.flushQueue = Promise.resolve(); // 플러시 큐 초기화
    this.isStarted = true;

    console.log('[StreamingWavEncoder] 시작:', {
      channels: this.channels,
      sampleRate: this.sampleRate
    });
  }

  /**
   * IndexedDB 초기화
   */
  initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        reject(new Error('IndexedDB 열기 실패'));
      };

      request.onsuccess = (event) => {
        console.log('[StreamingWavEncoder] IndexedDB 연결 성공:', this.dbName);
        resolve(event.target.result);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // 기존 Object Store가 있으면 삭제
        if (db.objectStoreNames.contains('audioChunks')) {
          db.deleteObjectStore('audioChunks');
        }

        // Object Store 생성
        db.createObjectStore('audioChunks', { keyPath: 'id' });
        console.log('[StreamingWavEncoder] Object Store 생성됨');
      };
    });
  }

  /**
   * 오디오 청크를 실시간으로 Int16 변환 후 메모리 버퍼에 저장
   * (동기 함수 - AudioWorklet에서 안전하게 호출 가능)
   * @param {Float32Array} leftChannel - 왼쪽 채널 PCM 데이터
   * @param {Float32Array} rightChannel - 오른쪽 채널 PCM 데이터 (옵션)
   */
  processChunk(leftChannel, rightChannel) {
    if (!this.isStarted) {
      console.error('[StreamingWavEncoder] 인코더가 시작되지 않았습니다');
      return;
    }

    try {
      // Float32 → Int16 변환
      const leftInt16 = this.floatTo16BitPCM(leftChannel);
      const rightInt16 = rightChannel ? this.floatTo16BitPCM(rightChannel) : leftInt16;

      // Stereo 인터리빙 (L, R, L, R, ...)
      const interleavedLength = leftInt16.length + rightInt16.length;
      const interleaved = new Int16Array(interleavedLength);

      for (let i = 0; i < leftInt16.length; i++) {
        interleaved[i * 2] = leftInt16[i];
        interleaved[i * 2 + 1] = rightInt16[i];
      }

      // ArrayBuffer 유효성 검증 (DataCloneError 방지)
      const buffer = interleaved.buffer;
      if (!buffer || buffer.byteLength === 0) {
        console.error('[StreamingWavEncoder] 유효하지 않은 ArrayBuffer 생성됨');
        return;
      }

      // ArrayBuffer가 detached 되었는지 확인
      try {
        // ArrayBuffer가 detached되면 byteLength에 접근할 수 없음
        const testLength = buffer.byteLength;
        if (testLength === 0) {
          console.error('[StreamingWavEncoder] ArrayBuffer가 비어있음');
          return;
        }
      } catch (error) {
        console.error('[StreamingWavEncoder] ArrayBuffer가 detached됨:', error);
        return;
      }

      // 메모리 버퍼에 추가 (IndexedDB에 즉시 저장하지 않음)
      this.memoryBuffer.push({
        id: this.chunkCounter,
        data: buffer
      });

      this.totalSamples += leftInt16.length;
      this.chunkCounter++;

      // 버퍼가 가득 찼으면 DB에 배치 저장 (비동기로 큐에 추가)
      if (this.memoryBuffer.length >= this.bufferFlushSize) {
        this.scheduleFlush();
      }

      // 메모리 사용량 모니터링 (100청크마다)
      if (this.chunkCounter % 100 === 0) {
        const estimatedSize = this.totalSamples * this.channels * 2; // 2 bytes per sample
        console.log('[StreamingWavEncoder] 진행:', {
          chunks: this.chunkCounter,
          estimatedSize: `${(estimatedSize / 1024 / 1024).toFixed(2)} MB`
        });
      }
    } catch (error) {
      console.error('[StreamingWavEncoder] processChunk 에러:', error);
    }
  }

  /**
   * 플러시를 큐에 예약 (동기 함수)
   */
  scheduleFlush() {
    // 이미 플러시 진행 중이면 무시 (다음 버퍼가 찰 때까지 대기)
    if (this.isFlushing) {
      return;
    }

    this.isFlushing = true;

    // 현재 버퍼를 복사하여 플러시할 데이터 확보
    const chunksToFlush = [...this.memoryBuffer];
    this.memoryBuffer = []; // 즉시 버퍼 비우기 (새 청크 받을 준비)

    // 플러시 큐에 추가
    this.flushQueue = this.flushQueue
      .then(() => this.flushToIndexedDB(chunksToFlush))
      .catch((error) => {
        console.error('[StreamingWavEncoder] 플러시 에러:', error);
      })
      .finally(() => {
        this.isFlushing = false;
      });
  }

  /**
   * IndexedDB에 청크 배열을 배치 저장
   * 트랜잭션 타임아웃 방지를 위해 대량 청크는 여러 배치로 분할
   */
  async flushToIndexedDB(chunks) {
    if (chunks.length === 0) {
      return;
    }

    const MAX_CHUNKS_PER_TRANSACTION = 50; // 트랜잭션당 최대 청크 수

    // 청크가 많으면 배치로 나누어 처리 (트랜잭션 타임아웃 방지)
    if (chunks.length > MAX_CHUNKS_PER_TRANSACTION) {
      console.log(`[StreamingWavEncoder] 대량 청크 감지 (${chunks.length}개), 배치 처리 시작`);

      for (let i = 0; i < chunks.length; i += MAX_CHUNKS_PER_TRANSACTION) {
        const batch = chunks.slice(i, i + MAX_CHUNKS_PER_TRANSACTION);
        console.log(`[StreamingWavEncoder] 배치 ${Math.floor(i / MAX_CHUNKS_PER_TRANSACTION) + 1} 저장 중: ${batch.length}개 청크`);
        await this.saveBatchToIndexedDB(batch);
      }

      console.log(`[StreamingWavEncoder] ✓ 모든 배치 저장 완료: 총 ${chunks.length}개 청크`);
      return;
    }

    // 청크가 적으면 단일 트랜잭션으로 처리
    await this.saveBatchToIndexedDB(chunks);
  }

  /**
   * 단일 트랜잭션으로 청크 배치 저장 (내부 헬퍼 메서드)
   */
  async saveBatchToIndexedDB(chunks) {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['audioChunks'], 'readwrite');
        const objectStore = transaction.objectStore('audioChunks');

        // 트랜잭션 완료/실패 핸들러
        transaction.oncomplete = () => {
          console.log(`[StreamingWavEncoder] DB 저장 완료: ${chunks.length}개 청크`);
          resolve();
        };

        transaction.onerror = (event) => {
          const error = event.target.error;
          console.error('[StreamingWavEncoder] 트랜잭션 에러:', {
            name: error?.name,
            message: error?.message,
            code: error?.code
          });
          reject(new Error(`IndexedDB 트랜잭션 실패: ${error?.name || 'Unknown'}`));
        };

        transaction.onabort = (event) => {
          const error = event.target.error;
          console.error('[StreamingWavEncoder] 트랜잭션 중단:', {
            name: error?.name,
            message: error?.message,
            code: error?.code
          });
          reject(new Error(`IndexedDB 트랜잭션 중단: ${error?.name || 'Unknown'}`));
        };

        // 모든 청크를 현재 트랜잭션에서 저장
        for (const chunk of chunks) {
          const request = objectStore.add(chunk);

          request.onerror = (event) => {
            const error = event.target.error;

            // 에러 상세 정보 로깅
            console.error('[StreamingWavEncoder] 청크 저장 에러:', {
              chunkId: chunk.id,
              errorName: error?.name,
              errorMessage: error?.message,
              errorCode: error?.code
            });

            // ConstraintError: 중복 ID 충돌
            if (error?.name === 'ConstraintError') {
              console.error(`[StreamingWavEncoder] 중복 ID 감지! ID ${chunk.id}가 이미 존재합니다`);
              transaction.abort(); // 트랜잭션 중단
            }
            // DataCloneError: 데이터 복제 실패
            else if (error?.name === 'DataCloneError') {
              console.error('[StreamingWavEncoder] 데이터 구조화 복제 실패! ArrayBuffer가 손상되었을 수 있습니다');
              transaction.abort(); // 트랜잭션 중단
            }
            // 기타 에러
            else {
              console.error('[StreamingWavEncoder] 알 수 없는 저장 에러 발생');
              transaction.abort(); // 트랜잭션 중단
            }
          };
        }
      } catch (error) {
        console.error('[StreamingWavEncoder] saveBatchToIndexedDB 에러:', error);
        reject(error);
      }
    });
  }

  /**
   * 메모리 버퍼의 모든 청크를 즉시 플러시 (finish에서 사용)
   */
  async flushMemoryBuffer() {
    if (this.memoryBuffer.length === 0) {
      return;
    }

    const chunksToFlush = [...this.memoryBuffer];
    this.memoryBuffer = [];

    await this.flushToIndexedDB(chunksToFlush);
  }

  /**
   * IndexedDB에 청크 저장 (단일 청크용 - 레거시)
   */
  saveChunkToDB(id, data) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['audioChunks'], 'readwrite');
      const objectStore = transaction.objectStore('audioChunks');

      // ArrayBuffer로 저장 (Blob 생성 시 복사 없이 직접 사용 가능)
      const request = objectStore.add({
        id: id,
        data: data.buffer
      });

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(new Error('IndexedDB 저장 실패'));
      };
    });
  }

  /**
   * 인코딩 완료 및 최종 WAV Blob 반환
   * @returns {Blob} 완성된 WAV 파일
   */
  async finish() {
    if (!this.isStarted) {
      throw new Error('인코더가 시작되지 않았습니다');
    }

    console.log('[StreamingWavEncoder] 완료 처리 시작');

    try {
      // 진행 중인 플러시 큐가 완료될 때까지 대기
      console.log('[StreamingWavEncoder] 플러시 큐 완료 대기 중...');
      try {
        await this.flushQueue;
        console.log('[StreamingWavEncoder] ✓ 플러시 큐 완료');
      } catch (error) {
        console.error('[StreamingWavEncoder] 플러시 큐 대기 중 에러:', error);
        throw new Error(`플러시 큐 처리 실패: ${error.message}`);
      }

      // 남은 메모리 버퍼 청크를 DB에 저장
      if (this.memoryBuffer.length > 0) {
        console.log('[StreamingWavEncoder] 남은 버퍼 플러시:', this.memoryBuffer.length, '개 청크');
        try {
          await this.flushMemoryBuffer();
          console.log('[StreamingWavEncoder] ✓ 메모리 버퍼 플러시 완료');
        } catch (error) {
          console.error('[StreamingWavEncoder] 메모리 버퍼 플러시 중 에러:', error);
          throw new Error(`메모리 버퍼 플러시 실패: ${error.message}`);
        }
      }

      // IndexedDB에서 모든 청크 읽기
      let allChunks;
      try {
        allChunks = await this.getAllChunksFromDB();
        console.log('[StreamingWavEncoder] ✓ DB에서 청크 읽기 완료:', allChunks.length, '개');
      } catch (error) {
        console.error('[StreamingWavEncoder] DB에서 청크 읽기 중 에러:', error);
        throw new Error(`IndexedDB 읽기 실패: ${error.message}`);
      }

      // 총 데이터 크기 계산 (ArrayBuffer 기준)
      const totalDataLength = allChunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
      console.log('[StreamingWavEncoder] 총 데이터 크기:', totalDataLength, 'bytes');

      // WAV 헤더 생성 (데이터 없이 헤더만)
      const headerBuffer = this.createWavHeader(totalDataLength);

      // Blob 배열 생성 (병합 없이 직접 연결!)
      const blobParts = [headerBuffer];
      for (const chunk of allChunks) {
        blobParts.push(chunk.data); // ArrayBuffer 직접 추가
      }

      // 최종 Blob 생성 (메모리 복사 없음!)
      const blob = new Blob(blobParts, { type: this.getMimeType() });

      console.log('[StreamingWavEncoder] ✓ Blob 생성 완료 (병합 없이)');

      console.log('[StreamingWavEncoder] 완료:', {
        totalChunks: this.chunkCounter,
        totalSamples: this.totalSamples,
        finalSize: `${(blob.size / 1024 / 1024).toFixed(2)} MB`
      });

      return blob;
    } finally {
      // 에러 발생 여부와 관계없이 리소스 정리는 반드시 실행
      try {
        await this.cleanup();
        console.log('[StreamingWavEncoder] ✓ 리소스 정리 완료');
      } catch (cleanupError) {
        console.error('[StreamingWavEncoder] 정리 중 에러 (무시됨):', cleanupError);
      }
    }
  }

  /**
   * IndexedDB에서 모든 청크 읽기
   */
  getAllChunksFromDB() {
    return new Promise((resolve, reject) => {
      const startTime = performance.now();

      const transaction = this.db.transaction(['audioChunks'], 'readonly');
      const objectStore = transaction.objectStore('audioChunks');

      // 트랜잭션 에러 핸들러 추가
      transaction.onerror = (event) => {
        const error = event.target.error;
        console.error('[StreamingWavEncoder] 읽기 트랜잭션 에러:', {
          name: error?.name,
          message: error?.message
        });
        reject(new Error(`IndexedDB 읽기 트랜잭션 실패: ${error?.name || 'Unknown'}`));
      };

      transaction.onabort = (event) => {
        const error = event.target.error;
        console.error('[StreamingWavEncoder] 읽기 트랜잭션 중단:', error);
        reject(new Error('IndexedDB 읽기 트랜잭션 중단'));
      };

      const request = objectStore.getAll();

      request.onsuccess = (event) => {
        const chunks = event.target.result;

        // 성능 모니터링
        const elapsed = performance.now() - startTime;
        console.log(`[StreamingWavEncoder] DB 읽기 완료: ${chunks.length}개 청크, ${elapsed.toFixed(2)}ms 소요`);

        // 대량 데이터 경고
        if (chunks.length > 1000) {
          console.warn(`[StreamingWavEncoder] 경고: 대량 청크 감지 (${chunks.length}개) - 메모리 사용량 주의`);
        }

        // ID 순서대로 정렬
        chunks.sort((a, b) => a.id - b.id);
        resolve(chunks);
      };

      request.onerror = (event) => {
        const error = event.target.error;
        console.error('[StreamingWavEncoder] getAll 에러:', error);
        reject(new Error(`IndexedDB getAll 실패: ${error?.name || 'Unknown'}`));
      };
    });
  }

  /**
   * WAV 헤더만 생성 (44 bytes)
   * @param {number} dataLength - PCM 데이터 크기 (bytes)
   */
  createWavHeader(dataLength) {
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);

    // WAV 헤더 작성
    this.writeString(view, 0, 'RIFF'); // ChunkID
    view.setUint32(4, 36 + dataLength, true); // ChunkSize
    this.writeString(view, 8, 'WAVE'); // Format
    this.writeString(view, 12, 'fmt '); // Subchunk1ID
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, this.channels, true); // NumChannels
    view.setUint32(24, this.sampleRate, true); // SampleRate
    view.setUint32(28, this.sampleRate * this.channels * 2, true); // ByteRate
    view.setUint16(32, this.channels * 2, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    this.writeString(view, 36, 'data'); // Subchunk2ID
    view.setUint32(40, dataLength, true); // Subchunk2Size

    return buffer;
  }

  /**
   * 문자열을 DataView에 작성
   */
  writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  /**
   * Float32Array를 Int16Array로 변환
   * -1.0~1.0 범위를 -32768~32767로 스케일링
   */
  floatTo16BitPCM(float32Array) {
    const int16Array = new Int16Array(float32Array.length);

    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    return int16Array;
  }

  /**
   * 리소스 정리 (IndexedDB 포함)
   */
  async cleanup() {
    // IndexedDB의 모든 데이터 삭제 및 DB 자체 삭제
    if (this.db) {
      const dbNameToDelete = this.dbName;

      // DB 연결 종료
      this.db.close();
      this.db = null;

      // DB 자체를 완전히 삭제 (ID 충돌 방지)
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbNameToDelete);

        request.onsuccess = () => {
          console.log('[StreamingWavEncoder] IndexedDB 삭제 완료:', dbNameToDelete);
          resolve();
        };

        request.onerror = () => {
          console.error('[StreamingWavEncoder] IndexedDB 삭제 실패:', request.error);
          reject(request.error);
        };

        request.onblocked = () => {
          console.warn('[StreamingWavEncoder] IndexedDB 삭제가 차단됨 (다른 연결이 열려있음)');
        };
      });

      console.log('[StreamingWavEncoder] IndexedDB 정리 완료');
    }

    this.isStarted = false;
    this.totalSamples = 0;
    this.chunkCounter = 0;
  }
}

// Export
export { AudioEncoder, WavEncoder, Mp3Encoder, StreamingMp3Encoder, StreamingWavEncoder };
