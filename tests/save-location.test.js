// 저장 위치(사용자가 고른 폴더) 관리 테스트 - IndexedDB 핸들 보관 + chrome.storage.sync 문자열 미러링
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { createFakeIndexedDB } from './helpers/fake-idb.js';
import { FakeDirectoryHandle } from './helpers/fake-opfs.js';
import { STORAGE_KEYS, DEFAULT_SETTINGS, SAVE_LOCATIONS } from '../constants.js';
import { saveSettings, loadSettings } from '../storage.js';
import {
  setIndexedDBFactory,
  saveDirectoryHandle,
  loadDirectoryHandle,
  clearDirectoryHandle,
  getSaveLocationInfo,
  folderDisplayName,
  queryFolderPermission,
  requestFolderPermission,
  verifyFolderWritable,
  findAvailableBaseName,
  SAVE_LOCATION_DB
} from '../save-location.js';

let fake;
let idb;
beforeEach(() => {
  fake = installFakeChrome();
  idb = createFakeIndexedDB();
  setIndexedDBFactory(idb);
});

const mirrored = () => fake.chrome.__storage[STORAGE_KEYS.SETTINGS];

test('saveDirectoryHandle은 폴더 핸들을 IndexedDB에 그대로 보관하고, chrome.storage.sync에는 모드/이름 문자열만 미러링한다 (다른 설정 유지)', async () => {
  await saveSettings({ fileFormat: 'wav', recordingMode: 'VIDEO_AUDIO' });
  const dir = new FakeDirectoryHandle('Recordings');
  await saveDirectoryHandle(dir);

  const entry = idb.peek(SAVE_LOCATION_DB.NAME, SAVE_LOCATION_DB.STORE, SAVE_LOCATION_DB.KEY);
  assert.ok(entry, 'IndexedDB에 항목 저장');
  assert.equal(entry.handle, dir, '핸들 객체 자체를 저장 (구조화 복제 가능)');

  const settings = mirrored();
  assert.equal(settings.saveLocationMode, SAVE_LOCATIONS.FOLDER);
  assert.equal(settings.saveLocationName, 'Recordings');
  assert.equal(settings.fileFormat, 'wav', '기존 설정 유지');
  assert.equal(settings.recordingMode, 'VIDEO_AUDIO');
  for (const [k, v] of Object.entries(settings)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof v), `sync 설정에는 문자열/숫자만: ${k}=${typeof v}`);
  }
  assert.equal(idb.stats.opens, idb.stats.closes, 'IndexedDB 연결은 작업마다 닫음 (버전 업그레이드 차단 방지)');
});

test('loadDirectoryHandle은 저장된 핸들을 돌려주고, 저장된 것이 없으면 null을 돌려준다', async () => {
  assert.equal(await loadDirectoryHandle(), null);
  const dir = new FakeDirectoryHandle('Clips');
  await saveDirectoryHandle(dir);
  assert.equal(await loadDirectoryHandle(), dir);
});

test('clearDirectoryHandle은 핸들을 지우고 미러링 설정을 기본(다운로드 폴더)으로 되돌린다', async () => {
  await saveDirectoryHandle(new FakeDirectoryHandle('Clips'));
  await clearDirectoryHandle();
  assert.equal(await loadDirectoryHandle(), null);
  assert.equal(mirrored().saveLocationMode, SAVE_LOCATIONS.DOWNLOADS);
  assert.equal(mirrored().saveLocationName, '');
});

test('getSaveLocationInfo는 { mode, name }을 돌려주고, IndexedDB를 열 수 없으면 기본(다운로드)으로 답한다', async () => {
  assert.deepEqual(await getSaveLocationInfo(), { mode: SAVE_LOCATIONS.DOWNLOADS, name: '' });
  await saveDirectoryHandle(new FakeDirectoryHandle('My Videos'));
  assert.deepEqual(await getSaveLocationInfo(), { mode: SAVE_LOCATIONS.FOLDER, name: 'My Videos' });

  setIndexedDBFactory(createFakeIndexedDB({ failOpen: new Error('IDB 손상') }));
  assert.deepEqual(await getSaveLocationInfo(), { mode: SAVE_LOCATIONS.DOWNLOADS, name: '' });
  await assert.rejects(() => loadDirectoryHandle(), /IDB 손상/, 'loadDirectoryHandle은 오류를 그대로 알림 (호출자가 폴백 결정)');
});

test('IndexedDB가 없는 환경(주입도 없음)에서는 명확한 오류를 낸다', async () => {
  setIndexedDBFactory(null);
  const saved = globalThis.indexedDB;
  delete globalThis.indexedDB;
  try {
    await assert.rejects(() => loadDirectoryHandle(), /IndexedDB/);
    assert.deepEqual(await getSaveLocationInfo(), { mode: SAVE_LOCATIONS.DOWNLOADS, name: '' });
  } finally {
    if (saved) globalThis.indexedDB = saved;
  }
});

test('saveDirectoryHandle은 폴더 핸들이 아니면 거부한다', async () => {
  await assert.rejects(() => saveDirectoryHandle(null), /폴더/);
  await assert.rejects(() => saveDirectoryHandle({ kind: 'file', name: 'a.txt' }), /폴더/);
  assert.equal(await loadDirectoryHandle(), null);
});

test('folderDisplayName은 이름이 없는 핸들(예: OPFS 루트)에 대체 이름을 준다', () => {
  assert.equal(folderDisplayName(new FakeDirectoryHandle('Rec')), 'Rec');
  assert.equal(folderDisplayName(new FakeDirectoryHandle('')), '선택한 폴더');
  assert.equal(folderDisplayName(null), '');
});

test('queryFolderPermission은 readwrite 권한 상태를 돌려준다 (API가 없으면 granted, 조회 실패는 denied)', async () => {
  assert.equal(await queryFolderPermission(new FakeDirectoryHandle('a', { permission: 'granted' })), 'granted');
  assert.equal(await queryFolderPermission(new FakeDirectoryHandle('a', { permission: 'prompt' })), 'prompt');
  assert.equal(await queryFolderPermission({ kind: 'directory', name: 'old' }), 'granted');
  assert.equal(await queryFolderPermission({ kind: 'directory', name: 'x', queryPermission: async () => { throw new Error('boom'); } }), 'denied');
  let descriptor = null;
  await queryFolderPermission({ kind: 'directory', queryPermission: async (d) => { descriptor = d; return 'granted'; } });
  assert.deepEqual(descriptor, { mode: 'readwrite' });
});

test('requestFolderPermission은 readwrite로 권한을 요청하고, 요청 자체가 실패하면(사용자 제스처 없음 등) 현재 상태를 돌려준다', async () => {
  const dir = new FakeDirectoryHandle('a', { permission: 'prompt' });
  dir.requestPermissionResult = 'granted';
  assert.equal(await requestFolderPermission(dir), 'granted');
  assert.deepEqual(dir.permissionRequests, [{ mode: 'readwrite' }]);

  const noGesture = {
    kind: 'directory',
    queryPermission: async () => 'prompt',
    requestPermission: async () => { throw new DOMException('User activation is required', 'SecurityError'); }
  };
  assert.equal(await requestFolderPermission(noGesture), 'prompt');
});

test('verifyFolderWritable은 작은 확인 파일을 만들고 지워 쓰기 가능 여부를 확인한다', async () => {
  const dir = new FakeDirectoryHandle('ok');
  await verifyFolderWritable(dir);
  assert.deepEqual(dir.fileNames(), [], '확인 파일은 삭제됨');

  const readOnly = new FakeDirectoryHandle('ro');
  readOnly.faults = { createWritable: new DOMException('denied', 'NotAllowedError') };
  await assert.rejects(() => verifyFolderWritable(readOnly), /NotAllowedError|denied/);
  assert.deepEqual(readOnly.fileNames(), [], '실패해도 빈 확인 파일을 남기지 않음');
});

test('findAvailableBaseName은 같은 이름의 파일이 있으면 " (n)"을 붙여 모든 출력 확장자가 비어 있는 이름을 고른다', async () => {
  const dir = new FakeDirectoryHandle('rec');
  assert.equal(await findAvailableBaseName(dir, 'recorda_20261016_120000', ['mp4', 'wav']), 'recorda_20261016_120000');
  await dir.getFileHandle('recorda_20261016_120000.wav', { create: true });
  assert.equal(await findAvailableBaseName(dir, 'recorda_20261016_120000', ['mp4', 'wav']), 'recorda_20261016_120000 (1)');
  await dir.getFileHandle('recorda_20261016_120000 (1).mp4', { create: true });
  assert.equal(await findAvailableBaseName(dir, 'recorda_20261016_120000', ['mp4', 'wav']), 'recorda_20261016_120000 (2)');
  assert.equal(await findAvailableBaseName(dir, 'recorda_20261016_120000', ['mp3']), 'recorda_20261016_120000', '확장자가 다르면 충돌 아님');
});

test('saveSettings는 여러 키를 한 번에 병합 저장하고 loadSettings 기본값에는 저장 위치(다운로드)가 포함된다', async () => {
  assert.equal(DEFAULT_SETTINGS.saveLocationMode, SAVE_LOCATIONS.DOWNLOADS);
  assert.equal(DEFAULT_SETTINGS.saveLocationName, '');
  assert.equal((await loadSettings()).saveLocationMode, SAVE_LOCATIONS.DOWNLOADS);
  assert.equal(await saveSettings({ bitrate: 192, sampleRate: 48000 }), true);
  const s = await loadSettings();
  assert.equal(s.bitrate, 192);
  assert.equal(s.sampleRate, 48000);
  assert.equal(s.fileFormat, DEFAULT_SETTINGS.fileFormat);
});
