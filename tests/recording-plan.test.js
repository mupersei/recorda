import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecordingPlan } from '../recording-plan.js';
import { RECORDING_MODES, AUDIO_FORMATS, VIDEO_FORMATS } from '../constants.js';

test('AUDIO_ONLY 모드는 영상 캡처 없이 오디오 파일 1개만 출력한다', () => {
  const plan = resolveRecordingPlan({
    mode: RECORDING_MODES.AUDIO_ONLY,
    audioFormat: AUDIO_FORMATS.WAV,
    videoFormat: VIDEO_FORMATS.MP4
  });
  assert.equal(plan.mode, RECORDING_MODES.AUDIO_ONLY);
  assert.equal(plan.captureVideo, false);
  assert.deepEqual(plan.outputs, [{ kind: 'audio', format: 'wav' }]);
});

test('VIDEO_AUDIO 모드는 영상+오디오가 담긴 영상 파일 1개만 출력한다', () => {
  const plan = resolveRecordingPlan({
    mode: RECORDING_MODES.VIDEO_AUDIO,
    audioFormat: AUDIO_FORMATS.MP3,
    videoFormat: VIDEO_FORMATS.MOV
  });
  assert.equal(plan.captureVideo, true);
  assert.deepEqual(plan.outputs, [{ kind: 'video', format: 'mov', audioCodec: 'mp3' }]);
});

test('VIDEO_AUDIO_SPLIT 모드는 영상 파일 1개와 오디오 파일 1개를 출력한다', () => {
  const plan = resolveRecordingPlan({
    mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT,
    audioFormat: AUDIO_FORMATS.WAV,
    videoFormat: VIDEO_FORMATS.AVI
  });
  assert.equal(plan.captureVideo, true);
  assert.deepEqual(plan.outputs, [
    { kind: 'video', format: 'avi', audioCodec: 'mp3' },
    { kind: 'audio', format: 'wav' }
  ]);
});

test('mode가 없으면 기존 동작(AUDIO_ONLY)으로 해석한다', () => {
  const plan = resolveRecordingPlan({ audioFormat: 'mp3' });
  assert.equal(plan.mode, RECORDING_MODES.AUDIO_ONLY);
  assert.deepEqual(plan.outputs, [{ kind: 'audio', format: 'mp3' }]);
});

test('audioFormat이 없으면 기본 포맷(mp3)을 사용한다', () => {
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY });
  assert.deepEqual(plan.outputs, [{ kind: 'audio', format: 'mp3' }]);
});

test('영상 모드에서 videoFormat이 없으면 기본 영상 포맷(mp4)을 사용한다', () => {
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO });
  assert.equal(plan.outputs[0].format, 'mp4');
});

test('지원하지 않는 모드/포맷은 에러를 던진다', () => {
  assert.throws(() => resolveRecordingPlan({ mode: 'HOLOGRAM' }), /모드/);
  assert.throws(() => resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'flac' }), /오디오 포맷/);
  assert.throws(() => resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: 'mkv' }), /영상 포맷/);
});

test('AUDIO_ONLY 모드에서는 잘못된 videoFormat을 무시한다 (영상을 쓰지 않으므로)', () => {
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioFormat: 'wav', videoFormat: 'mkv' });
  assert.equal(plan.captureVideo, false);
});
