// AudioWorklet 프로세서 단위 테스트 - audio-worklet-processor.js를 가짜 AudioWorkletGlobalScope(vm)에서 실행
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../audio-worklet-processor.js', import.meta.url), 'utf8');

function createProcessor() {
  const registered = {};
  class AudioWorkletProcessor {
    constructor() {
      this.port = { posted: [], onmessage: null, postMessage(m) { this.posted.push(m); } };
    }
  }
  const context = vm.createContext({
    AudioWorkletProcessor,
    registerProcessor: (name, cls) => { registered[name] = cls; },
    console: { log() {}, warn() {}, error() {} }
  });
  vm.runInContext(SOURCE, context);
  const Processor = registered['audio-recorder-processor'];
  assert.ok(Processor, 'audio-recorder-processor 등록');
  const processor = new Processor();
  const send = (command) => processor.port.onmessage({ data: { command } });
  // 128 샘플(렌더 퀀텀) 스테레오 입력
  const quantum = (value) => [[new Float32Array(128).fill(value), new Float32Array(128).fill(-value)]];
  const run = (count, value) => { for (let i = 0; i < count; i++) processor.process(quantum(value), [], {}); };
  const audioMessages = () => processor.port.posted.filter(m => m.type === 'audioData');
  return { processor, send, run, audioMessages, posted: processor.port.posted };
}

test('워크릿은 4096 샘플마다 audioData를 보내고, stop 시 남은 데이터와 stopped 응답을 보낸다 (기존 동작)', () => {
  const { send, run, audioMessages, posted } = createProcessor();
  send('start');
  run(40, 0.25); // 5120 샘플 → 4096 1개 전송 + 1024 대기
  assert.equal(audioMessages().length, 1);
  assert.equal(audioMessages()[0].leftChannel.length, 4096);
  send('stop');
  assert.equal(audioMessages().length, 2);
  assert.equal(audioMessages()[1].leftChannel.length, 1024);
  assert.equal(posted.at(-1).type, 'stopped');
});

test('pause 명령: 지금까지 모은 PCM을 즉시 보낸 뒤 paused로 응답하고, 일시정지 중 입력은 모으지 않는다', () => {
  const { send, run, audioMessages, posted } = createProcessor();
  send('start');
  run(10, 0.25); // 1280 샘플 (배치 미만)
  send('pause');
  assert.equal(audioMessages().length, 1, '일시정지 직전까지의 PCM이 경계에서 바로 전달됨');
  assert.equal(audioMessages()[0].leftChannel.length, 1280);
  assert.equal(posted.at(-1).type, 'paused', 'pause 처리 완료 응답');
  run(100, 0.75); // 일시정지 중 입력 (12800 샘플)
  assert.equal(audioMessages().length, 1, '일시정지 중에는 아무것도 보내지 않음');
  send('stop');
  assert.equal(audioMessages().length, 1, '일시정지 중 stop은 보낼 데이터가 없음');
  assert.equal(posted.at(-1).type, 'stopped');
});

test('resume 명령: 일시정지 중 입력이 섞이지 않은 새 배치부터 다시 보낸다', () => {
  const { send, run, audioMessages } = createProcessor();
  send('start');
  run(10, 0.25);
  send('pause');
  run(50, 0.75);
  send('resume');
  run(32, 0.125); // 정확히 4096 샘플
  const msgs = audioMessages();
  assert.equal(msgs.length, 2);
  const resumed = msgs[1];
  assert.equal(resumed.leftChannel.length, 4096);
  assert.ok(resumed.leftChannel.every(v => v === 0.125), '일시정지 중 샘플(0.75)이 섞이면 안 됨');
  assert.ok(resumed.rightChannel.every(v => v === -0.125));
});

test('resume은 일시정지 상태에서만 동작한다 (중지 후 resume은 녹음을 다시 시작하지 않음)', () => {
  const { send, run, audioMessages } = createProcessor();
  send('resume'); // 시작 전
  run(40, 0.25);
  assert.equal(audioMessages().length, 0);
  send('start');
  run(10, 0.25);
  send('stop');
  const afterStop = audioMessages().length;
  send('resume');
  run(40, 0.25);
  assert.equal(audioMessages().length, afterStop, '중지 후에는 resume으로 다시 모으지 않음');
});

test('보낼 데이터가 없어도(중복 pause, 중지 후 pause) paused 응답은 항상 보낸다', () => {
  const { send, run, audioMessages, posted } = createProcessor();
  send('start');
  run(10, 0.25);
  send('pause');
  send('pause');
  assert.deepEqual(posted.map(m => m.type), ['audioData', 'paused', 'paused'], '두 번째 pause는 데이터 없이 응답만');
  send('stop');
  send('pause');
  assert.equal(posted.at(-1).type, 'paused');
  assert.equal(audioMessages().length, 1);
});
