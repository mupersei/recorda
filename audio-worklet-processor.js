/**
 * Audio Worklet Processor
 * 실시간 오디오 데이터를 메인 스레드로 전송
 *
 * ScriptProcessorNode 대체 (deprecated 해결)
 */
class AudioRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    this.isPaused = false;
    this.chunkCounter = 0;

    // 배치 처리 (4096 샘플마다 전송 = ScriptProcessorNode와 동일)
    this.batchSize = 4096;
    this.leftBuffer = [];
    this.rightBuffer = [];
    this.currentSize = 0;

    // 메인 스레드로부터 제어 메시지 수신
    this.port.onmessage = (event) => {
      const { command } = event.data;

      if (command === 'start') {
        this.isRecording = true;
        this.isPaused = false;
        this.leftBuffer = [];
        this.rightBuffer = [];
        this.currentSize = 0;
        console.log('[AudioWorklet] 녹음 시작');
      } else if (command === 'pause') {
        if (this.isRecording) {
          // 일시정지 경계까지 모은 데이터를 바로 보내고 수집 중단 → 경계 정밀도가 배치(4096)가 아닌 렌더 퀀텀(128) 단위
          // 메인 스레드는 'paused' 응답 전에 도착한 데이터까지 일시정지 이전 구간으로 기록
          this.flushBuffer();
          this.isRecording = false;
          this.isPaused = true;
          console.log('[AudioWorklet] 녹음 일시정지');
        }
        // 보낼 데이터가 없어도(중복 요청 등) 항상 응답해 메인 스레드가 타임아웃까지 기다리지 않게 함
        this.port.postMessage({ type: 'paused' });
      } else if (command === 'resume') {
        if (!this.isPaused) return; // 중지 후에는 재개하지 않음
        this.isPaused = false;
        this.isRecording = true;
        this.leftBuffer = [];
        this.rightBuffer = [];
        this.currentSize = 0;
        console.log('[AudioWorklet] 녹음 재개');
      } else if (command === 'stop') {
        this.isRecording = false;
        this.isPaused = false;
        // 남은 데이터 전송 후 완료 응답 (메인 스레드가 마지막 청크까지 받은 뒤 정리할 수 있도록)
        this.flushBuffer();
        this.port.postMessage({ type: 'stopped' });
        console.log('[AudioWorklet] 녹음 중지');
      }
    };
  }

  /**
   * 오디오 처리 (128 샘플마다 호출됨)
   * @param {Float32Array[][]} inputs - 입력 오디오 데이터
   * @param {Float32Array[][]} _outputs - 출력 오디오 데이터 (미사용)
   * @param {Object} _parameters - 파라미터 (미사용)
   * @returns {boolean} - true: 계속 실행, false: 종료
   */
  process(inputs, _outputs, _parameters) {
    // 녹음 중이 아니면(시작 전 / 일시정지 / 중지) 그냥 통과
    if (!this.isRecording) {
      return true;
    }

    const input = inputs[0]; // 첫 번째 입력

    if (!input || input.length === 0) {
      return true;
    }

    // 채널 데이터 추출 (Stereo: 0=Left, 1=Right)
    const leftChannel = input[0];
    const rightChannel = input.length > 1 ? input[1] : input[0];

    // 버퍼에 추가
    this.leftBuffer.push(new Float32Array(leftChannel));
    this.rightBuffer.push(new Float32Array(rightChannel));
    this.currentSize += leftChannel.length;

    // 배치 크기에 도달하면 전송
    if (this.currentSize >= this.batchSize) {
      this.flushBuffer();
    }

    return true; // 계속 실행
  }

  /**
   * 버퍼의 데이터를 메인 스레드로 전송
   */
  flushBuffer() {
    if (this.currentSize === 0) {
      return;
    }

    // 버퍼 병합
    const mergedLeft = new Float32Array(this.currentSize);
    const mergedRight = new Float32Array(this.currentSize);

    let offset = 0;
    for (let i = 0; i < this.leftBuffer.length; i++) {
      mergedLeft.set(this.leftBuffer[i], offset);
      mergedRight.set(this.rightBuffer[i], offset);
      offset += this.leftBuffer[i].length;
    }

    // 메인 스레드로 전송
    this.port.postMessage({
      type: 'audioData',
      leftChannel: mergedLeft,
      rightChannel: mergedRight,
      chunkCounter: this.chunkCounter++
    });

    // 버퍼 초기화
    this.leftBuffer = [];
    this.rightBuffer = [];
    this.currentSize = 0;
  }
}

// Worklet 프로세서 등록
registerProcessor('audio-recorder-processor', AudioRecorderProcessor);
