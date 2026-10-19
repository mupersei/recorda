import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFilename, generateRecordingFilenames, recordingBaseName, formatDate, getActiveElapsedSeconds, fileExtension, formatLabel } from '../utils.js';

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

test('recordingBaseName은 녹화 시각으로 공통 파일명(확장자 제외)을 만든다', () => {
  assert.equal(recordingBaseName(new Date(2026, 9, 16, 9, 5, 7)), 'recorda_20261016_090507');
});

test('generateRecordingFilenames는 baseName이 주어지면(폴더에 같은 이름이 있어 " (1)"을 붙인 경우 등) 그 이름을 모든 출력에 쓴다', () => {
  const names = generateRecordingFilenames(
    [{ kind: 'video', format: 'mp4' }, { kind: 'audio', format: 'wav' }],
    new Date(2026, 9, 16),
    { baseName: 'recorda_20261016_120000 (1)' }
  );
  assert.deepEqual(names.map(n => n.filename), ['recorda_20261016_120000 (1).mp4', 'recorda_20261016_120000 (1).wav']);
});

test('generateRecordingFilenames는 확장자에서 특수문자를 제거한다', () => {
  const names = generateRecordingFilenames([{ kind: 'video', format: '../m.ov' }], new Date(2026, 0, 1));
  assert.equal(names[0].filename, `recorda_${formatDate(new Date(2026, 0, 1))}.mov`);
});

test('generateRecordingFilenames는 fMP4(조각 MP4)를 .mp4 확장자로 저장한다 (확장자 표: fmp4 → mp4)', () => {
  const names = generateRecordingFilenames(
    [{ kind: 'video', format: 'fmp4' }, { kind: 'audio', format: 'wav' }],
    new Date(2026, 9, 18, 9, 0, 0)
  );
  assert.deepEqual(names.map(n => [n.format, n.filename]), [
    ['fmp4', 'recorda_20261018_090000.mp4'],
    ['wav', 'recorda_20261018_090000.wav']
  ], '포맷 값은 fmp4 그대로, 파일명만 .mp4');
});

test('fileExtension / formatLabel: fmp4는 확장자 mp4·표시 이름 MP4, 나머지는 포맷 그대로(표시는 대문자)', () => {
  assert.equal(fileExtension('fmp4'), 'mp4');
  for (const f of ['mp4', 'mov', 'avi', 'wav', 'mp3']) assert.equal(fileExtension(f), f);
  assert.equal(formatLabel('fmp4'), 'MP4');
  assert.equal(formatLabel('mov'), 'MOV');
  assert.equal(formatLabel('wav'), 'WAV');
  assert.equal(formatLabel(undefined), '');
});

test('getActiveElapsedSeconds는 누적 일시정지 시간과 진행 중인 일시정지를 경과 시간에서 뺀다', () => {
  const start = 1_000_000;
  // 녹화 중: 25초 지났고 그중 7초는 일시정지였음
  assert.equal(getActiveElapsedSeconds({ startTime: start, pausedTotalMs: 7000 }, start + 25_000), 18);
  // 일시정지 중: 20초 시점에 멈췄다면 이후 시각과 무관하게 그 값에서 고정
  assert.equal(getActiveElapsedSeconds({ startTime: start, pausedTotalMs: 7000, pausedAt: start + 20_000 }, start + 25_000), 13);
  assert.equal(getActiveElapsedSeconds({ startTime: start, pausedTotalMs: 7000, pausedAt: start + 20_000 }, start + 90_000), 13);
  // 일시정지 기록이 없으면 기존 getElapsedSeconds와 같음 (내림)
  assert.equal(getActiveElapsedSeconds({ startTime: start }, start + 5_999), 5);
});

test('getActiveElapsedSeconds는 시작 시각이 없거나 잘못되면 0을, 음수가 되면 0을 반환한다', () => {
  assert.equal(getActiveElapsedSeconds({ startTime: null }), 0);
  assert.equal(getActiveElapsedSeconds({}), 0);
  assert.equal(getActiveElapsedSeconds(), 0);
  assert.equal(getActiveElapsedSeconds({ startTime: Number.NaN }), 0);
  assert.equal(getActiveElapsedSeconds({ startTime: 1000, pausedTotalMs: 5000 }, 2000), 0);
});
