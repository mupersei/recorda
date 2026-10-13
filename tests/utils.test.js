import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFilename, generateRecordingFilenames, formatDate } from '../utils.js';

test('generateFilename은 기존처럼 recorda_타임스탬프.확장자 형식을 유지한다', () => {
  assert.match(generateFilename('mp3'), /^recorda_\d{8}_\d{6}\.mp3$/);
});

test('generateRecordingFilenames는 출력마다 같은 타임스탬프를 공유한다', () => {
  const date = new Date(2026, 9, 12, 14, 20, 5);
  const names = generateRecordingFilenames(
    [{ kind: 'video', format: 'mp4' }, { kind: 'audio', format: 'wav' }],
    date
  );
  assert.deepEqual(names, [
    { kind: 'video', format: 'mp4', filename: 'recorda_20261012_142005.mp4' },
    { kind: 'audio', format: 'wav', filename: 'recorda_20261012_142005.wav' }
  ]);
});

test('generateRecordingFilenames는 확장자에서 특수문자를 제거한다', () => {
  const names = generateRecordingFilenames([{ kind: 'video', format: '../m.ov' }], new Date(2026, 0, 1));
  assert.equal(names[0].filename, `recorda_${formatDate(new Date(2026, 0, 1))}.mov`);
});
