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

test('영상 포맷으로 fMP4(조각 MP4, fmp4)를 고를 수 있다 (MOV/AVI와 같은 영상 출력 + 컨테이너 오디오 MP3)', () => {
  assert.equal(VIDEO_FORMATS.FMP4, 'fmp4');
  const single = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, videoFormat: VIDEO_FORMATS.FMP4 });
  assert.deepEqual(single.outputs, [{ kind: 'video', format: 'fmp4', audioCodec: 'mp3' }]);
  const split = resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO_SPLIT, audioFormat: 'wav', videoFormat: 'fmp4' });
  assert.deepEqual(split.outputs, [{ kind: 'video', format: 'fmp4', audioCodec: 'mp3' }, { kind: 'audio', format: 'wav' }]);
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

// ---- 오디오 소스 (탭 / 마이크 / 탭+마이크) ----
import { AUDIO_SOURCES } from '../constants.js';

test('AUDIO_SOURCES 상수: 탭(tab, 기본) / 마이크(mic) / 탭+마이크(tab+mic)', () => {
  assert.deepEqual(AUDIO_SOURCES, { TAB: 'tab', MIC: 'mic', TAB_AND_MIC: 'tab+mic' });
});

test('오디오 소스가 없으면 기존 동작(탭 오디오만): captureTabAudio true, captureMic false', () => {
  for (const mode of Object.values(RECORDING_MODES)) {
    const plan = resolveRecordingPlan({ mode, audioFormat: 'wav', videoFormat: 'mp4' });
    assert.equal(plan.audioSource, 'tab', mode);
    assert.equal(plan.captureTabAudio, true, mode);
    assert.equal(plan.captureMic, false, mode);
    assert.equal(plan.micDeviceId, null, `${mode}: 마이크를 쓰지 않으면 장치 ID 없음`);
  }
});

// 3가지 소스 × 3가지 모드: 영상은 모드로만 정해지고(항상 녹화를 시작한 탭에서), 출력 파일 목록도 소스와 무관
const SOURCE_CASES = [
  ['tab', { captureTabAudio: true, captureMic: false }],
  ['mic', { captureTabAudio: false, captureMic: true }],
  ['tab+mic', { captureTabAudio: true, captureMic: true }]
];
const MODE_CASES = [
  [RECORDING_MODES.AUDIO_ONLY, false, [{ kind: 'audio', format: 'wav' }]],
  [RECORDING_MODES.VIDEO_AUDIO, true, [{ kind: 'video', format: 'mp4', audioCodec: 'mp3' }]],
  [RECORDING_MODES.VIDEO_AUDIO_SPLIT, true, [{ kind: 'video', format: 'mp4', audioCodec: 'mp3' }, { kind: 'audio', format: 'wav' }]]
];
for (const [source, expected] of SOURCE_CASES) {
  for (const [mode, captureVideo, outputs] of MODE_CASES) {
    test(`오디오 소스 ${source} × ${mode}: captureTabAudio ${expected.captureTabAudio}, captureMic ${expected.captureMic}, captureVideo ${captureVideo}, 출력 파일은 모드대로`, () => {
      const plan = resolveRecordingPlan({ mode, audioFormat: 'wav', videoFormat: 'mp4', audioSource: source, micDeviceId: 'usb-mic-1' });
      assert.equal(plan.mode, mode);
      assert.equal(plan.audioSource, source);
      assert.equal(plan.captureVideo, captureVideo, '영상 캡처는 모드로만 결정');
      assert.equal(plan.captureTabAudio, expected.captureTabAudio);
      assert.equal(plan.captureMic, expected.captureMic);
      assert.equal(plan.micDeviceId, expected.captureMic ? 'usb-mic-1' : null, '장치 ID는 마이크를 쓸 때만 계획에 담음');
      assert.deepEqual(plan.outputs, outputs, '출력 파일 목록은 오디오 소스와 무관');
    });
  }
}

test('마이크 소스에서 장치 ID가 비어 있으면(기본 마이크) micDeviceId는 null', () => {
  for (const micDeviceId of [undefined, null, '']) {
    const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioSource: 'mic', micDeviceId });
    assert.equal(plan.captureMic, true);
    assert.equal(plan.micDeviceId, null, String(micDeviceId));
  }
});

test('지원하지 않는 오디오 소스는 에러를 던진다', () => {
  assert.throws(() => resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioSource: 'system' }), /오디오 소스/);
  assert.throws(() => resolveRecordingPlan({ mode: RECORDING_MODES.VIDEO_AUDIO, audioSource: 'MIC' }), /오디오 소스/);
});

test('micDeviceId는 문자열만 받는다 (그 외 값은 기본 마이크)', () => {
  const plan = resolveRecordingPlan({ mode: RECORDING_MODES.AUDIO_ONLY, audioSource: 'tab+mic', micDeviceId: { exact: 'x' } });
  assert.equal(plan.micDeviceId, null);
});

import { planCapturesTab } from '../recording-plan.js';

test('planCapturesTab: 영상 또는 탭 오디오를 캡처할 때만 탭 캡처(스트림 ID)가 필요하다 (오디오만 + 마이크는 탭을 캡처하지 않음)', () => {
  const cases = [
    [RECORDING_MODES.AUDIO_ONLY, 'tab', true],
    [RECORDING_MODES.AUDIO_ONLY, 'tab+mic', true],
    [RECORDING_MODES.AUDIO_ONLY, 'mic', false],
    [RECORDING_MODES.VIDEO_AUDIO, 'mic', true],
    [RECORDING_MODES.VIDEO_AUDIO_SPLIT, 'mic', true],
    [RECORDING_MODES.VIDEO_AUDIO, 'tab', true]
  ];
  for (const [mode, audioSource, expected] of cases) {
    assert.equal(planCapturesTab(resolveRecordingPlan({ mode, audioSource })), expected, `${mode} + ${audioSource}`);
  }
  // 이전 형식 계획(오디오 소스 필드 없음)은 기존처럼 탭을 캡처
  assert.equal(planCapturesTab({ mode: RECORDING_MODES.AUDIO_ONLY, captureVideo: false, outputs: [] }), true);
  assert.equal(planCapturesTab(null), true);
});
