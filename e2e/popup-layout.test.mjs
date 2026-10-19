// 팝업 레이아웃 테스트 - 실제 Chrome에서 popup.html을 열어 모든 모드/상태에서 세로 스크롤 없이 표시되는지 확인
// 실행: cd e2e && node --test popup-layout.test.mjs   (CHROME_LIB_DIR 등 환경 변수는 run.mjs와 동일)
// 스크린샷: e2e/output/popup-<모드>.png(대기), popup-<모드>-RECORDING.png(녹화 중), settings-page.png (RECORDA_E2E_OUT으로 위치 변경)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.RECORDA_E2E_OUT || join(dirname(fileURLToPath(import.meta.url)), 'output');
const MODES = ['AUDIO_ONLY', 'VIDEO_AUDIO', 'VIDEO_AUDIO_SPLIT'];
// Chrome 확장 팝업의 최대 크기 (이보다 크면 팝업 안에 스크롤이 생김)
const POPUP_MAX_HEIGHT = 600;
const POPUP_MAX_WIDTH = 800;

let browser, page, extensionId, swWorker;

before(async () => {
  const LIB_DIR = process.env.CHROME_LIB_DIR || '';
  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null' };
  if (LIB_DIR) env.LD_LIBRARY_PATH = `${LIB_DIR}/usr/lib/x86_64-linux-gnu:${LIB_DIR}/lib/x86_64-linux-gnu:${process.env.LD_LIBRARY_PATH || ''}`;
  browser = await puppeteer.launch({
    headless: true, env,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`]
  });
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 30_000 });
  extensionId = new URL(sw.url()).host;
  swWorker = await sw.worker();
  // SW 시작 직후에는 chrome.* 바인딩이 아직 없을 수 있어 준비될 때까지 대기
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = await swWorker.evaluate(() => typeof chrome === 'object' && typeof chrome.runtime === 'object').catch(() => false);
    if (ready) break;
    await new Promise(r => setTimeout(r, 200));
  }
  page = await browser.newPage();
  // scrollHeight는 뷰포트보다 작아질 수 없으므로, 내용보다 작은 뷰포트에서 재야 콘텐츠의 실제 높이가 나온다
  await page.setViewport({ width: POPUP_MAX_WIDTH, height: 100 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
  await page.waitForSelector('#mainContainer.loaded', { timeout: 10_000 });
});

after(async () => { if (browser) await browser.close(); });

async function layout() {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const width = Math.max(body.scrollWidth, body.getBoundingClientRect().width);
    const height = Math.max(doc.scrollHeight, body.scrollHeight);
    const container = document.getElementById('mainContainer').getBoundingClientRect();
    const bodyStyle = getComputedStyle(body);
    return {
      width, height,
      containerBottom: Math.ceil(container.bottom + parseFloat(bodyStyle.paddingBottom)),
      overflowY: bodyStyle.overflowY
    };
  });
}

async function setMode(mode) {
  await page.select('#modeSelect', mode);
  await new Promise(r => setTimeout(r, 50));
}

// 긴 뷰포트에서 렌더링한 뒤 콘텐츠(body) 영역만 잘라 실제 팝업 크기로 저장 (측정용 뷰포트는 다시 높이 100으로)
async function screenshotPopup(name) {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.setViewport({ width: POPUP_MAX_WIDTH, height: 900, deviceScaleFactor: 2 });
  // 로딩 페이드인(opacity 0.15s)이 끝나고 배율 변경 후 다시 그려질 때까지 대기
  await page.waitForFunction(() => getComputedStyle(document.getElementById('mainContainer')).opacity === '1', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 250));
  const box = await page.evaluate(() => {
    const body = document.body.getBoundingClientRect();
    const container = document.getElementById('mainContainer').getBoundingClientRect();
    return { width: Math.ceil(body.width), height: Math.ceil(container.bottom + parseFloat(getComputedStyle(document.body).paddingBottom)) };
  });
  const path = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path, clip: { x: 0, y: 0, width: box.width, height: box.height } });
  await page.setViewport({ width: POPUP_MAX_WIDTH, height: 100, deviceScaleFactor: 1 });
  console.log(`[popup-layout] 스크린샷 ${path} (${box.width}x${box.height})`);
  return box;
}

for (const mode of MODES) {
  test(`${mode} 모드: 대기 상태 팝업 전체 높이가 ${POPUP_MAX_HEIGHT}px 이내라 스크롤이 생기지 않는다 (스크린샷 저장)`, async () => {
    await setMode(mode);
    const l = await layout();
    assert.ok(l.height <= POPUP_MAX_HEIGHT, `높이 ${l.height}px > ${POPUP_MAX_HEIGHT}px`);
    assert.ok(l.containerBottom <= POPUP_MAX_HEIGHT, `컨테이너 하단 ${l.containerBottom}px`);
    assert.ok(l.width <= POPUP_MAX_WIDTH, `폭 ${l.width}px`);
    console.log(`[popup-layout] ${mode} IDLE: 높이 ${l.height}px, 폭 ${l.width}px`);
    const shot = await screenshotPopup(`popup-${mode}`);
    assert.ok(shot.height <= POPUP_MAX_HEIGHT && shot.width <= POPUP_MAX_WIDTH);
  });
}

test('가장 긴 상태(분리 저장 모드 + 긴 폴더명 완료 메시지 + 오류 + 시:분:초 시간 표시)에서도 스크롤이 생기지 않는다', async () => {
  await setMode('VIDEO_AUDIO_SPLIT');
  await page.evaluate(() => {
    document.getElementById('timeDisplay').textContent = '12:34:56';
    const m = document.getElementById('message');
    m.textContent = "녹화가 완료되었습니다. '2026 회의 녹화 모음 (팀 공유용) 원본 보관'에 1개 (WAV), 다운로드 폴더에 1개 (MP4) 저장되었습니다. 파일 저장에 실패했습니다: recorda_20261013_000000 (1).mp3 (FILE_FAILED)";
    m.className = 'message error show';
  });
  try {
    for (const mode of MODES) {
      await setMode(mode);
      const l = await layout();
      console.log(`[popup-layout] 가장 긴 상태 (${mode}): 높이 ${l.height}px`);
      assert.ok(l.height <= POPUP_MAX_HEIGHT, `${mode}: 높이 ${l.height}px > ${POPUP_MAX_HEIGHT}px`);
    }
  } finally {
    await page.evaluate(() => { document.getElementById('message').className = 'message'; document.getElementById('timeDisplay').textContent = '00:00'; });
  }
});

test('영상 설정은 왼쪽 열("영상"), 오디오 설정은 오른쪽 열("오디오")에 나란히 있고, 녹화 모드는 두 열 위 전체 폭이다', async () => {
  for (const mode of MODES) {
    await setMode(mode);
    const c = await page.evaluate(() => {
      const rect = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
      const inside = (columnId, id) => document.getElementById(columnId).contains(document.getElementById(id));
      return {
        video: rect('videoColumn'),
        audio: rect('audioColumn'),
        mode: rect('modeSelect'),
        videoTitle: document.querySelector('#videoColumn .column-title').textContent.trim(),
        audioTitle: document.querySelector('#audioColumn .column-title').textContent.trim(),
        placement: {
          videoFormat: inside('videoColumn', 'videoFormatSelect'),
          audioFormat: inside('audioColumn', 'formatSelect'),
          bitrate: inside('audioColumn', 'bitrateSelect'),
          sampleRate: inside('audioColumn', 'sampleRateSelect'),
          modeOutside: !inside('videoColumn', 'modeSelect') && !inside('audioColumn', 'modeSelect')
        }
      };
    });
    assert.equal(c.videoTitle, '영상');
    assert.equal(c.audioTitle, '오디오');
    assert.ok(c.video.width > 0 && c.video.height > 0 && c.audio.width > 0 && c.audio.height > 0, `${mode}: 두 열 모두 표시`);
    assert.ok(c.video.right <= c.audio.left, `${mode}: 왼쪽 열 오른쪽 끝 ${c.video.right} ≤ 오른쪽 열 왼쪽 끝 ${c.audio.left}`);
    assert.ok(Math.abs(c.video.top - c.audio.top) <= 1, `${mode}: 두 열이 같은 줄 (${c.video.top} / ${c.audio.top})`);
    assert.deepEqual(c.placement, { videoFormat: true, audioFormat: true, bitrate: true, sampleRate: true, modeOutside: true });
    assert.ok(c.mode.bottom <= c.video.top, '녹화 모드는 두 열 위');
    assert.ok(c.mode.width >= c.audio.right - c.video.left - 1, `녹화 모드 선택은 두 열 전체 폭 (${c.mode.width})`);
  }
});

test('모드별 활성 규칙: AUDIO_ONLY는 영상 열 비활성(회색, "영상 녹화 안 함"), VIDEO_AUDIO는 오디오 포맷만 비활성("영상 파일에 포함"), 분리 저장은 모두 활성', async () => {
  const read = () => page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const visible = (el) => !!el && !el.classList.contains('hidden') && el.getBoundingClientRect().height > 0;
    return {
      videoColumnVisible: visible($('videoColumn')),
      videoColumnDisabled: $('videoColumn').classList.contains('disabled'),
      videoLabelColor: getComputedStyle($('videoFormatGroup').querySelector('label')).color,
      audioLabelColor: getComputedStyle($('audioFormatGroup').querySelector('label')).color,
      disabled: { video: $('videoFormatSelect').disabled, format: $('formatSelect').disabled, bitrate: $('bitrateSelect').disabled, sampleRate: $('sampleRateSelect').disabled, mode: $('modeSelect').disabled },
      videoNote: visible($('videoColumnNote')) ? $('videoColumnNote').textContent.trim() : null,
      audioNote: visible($('audioFormatNote')) ? $('audioFormatNote').textContent.trim() : null
    };
  });

  await setMode('VIDEO_AUDIO_SPLIT');
  const split = await read();
  assert.deepEqual(split.disabled, { video: false, format: false, bitrate: false, sampleRate: false, mode: false });
  assert.equal(split.videoColumnDisabled, false);
  assert.equal(split.videoNote, null);
  assert.equal(split.audioNote, null);

  await setMode('AUDIO_ONLY');
  const audioOnly = await read();
  assert.equal(audioOnly.videoColumnVisible, true, '영상 열은 숨기지 않고');
  assert.equal(audioOnly.videoColumnDisabled, true, '비활성 표시');
  assert.deepEqual(audioOnly.disabled, { video: true, format: false, bitrate: false, sampleRate: false, mode: false });
  assert.equal(audioOnly.videoNote, '영상 녹화 안 함');
  assert.notEqual(audioOnly.videoLabelColor, split.videoLabelColor, '영상 열 글자가 회색으로 흐려짐');
  assert.equal(audioOnly.audioNote, null);

  await setMode('VIDEO_AUDIO');
  const single = await read();
  assert.equal(single.videoColumnDisabled, false);
  assert.deepEqual(single.disabled, { video: false, format: true, bitrate: false, sampleRate: false, mode: false }, '비트레이트·샘플레이트는 영상 파일 속 MP3에 적용되므로 활성');
  assert.equal(single.audioNote, '영상 파일에 포함');
  assert.notEqual(single.audioLabelColor, split.audioLabelColor, '오디오 포맷 라벨이 회색');
  assert.equal(single.videoNote, null);
  await setMode('VIDEO_AUDIO_SPLIT');
});

test('영상 힌트(영상 열)는 영상 모드에서만 보인다', async () => {
  const hintVisible = () => page.$eval('#videoHint', el => el.getBoundingClientRect().height > 0);
  await setMode('AUDIO_ONLY');
  assert.equal(await hintVisible(), false, '오디오 전용 모드에서는 영상 힌트 숨김');
  await setMode('VIDEO_AUDIO');
  assert.equal(await hintVisible(), true);
});

test('영상 포맷에 fMP4(조각)가 있고(값 fmp4, 짧은 라벨), 고르면 storage.sync에 videoFormat: fmp4로 저장되어 팝업을 다시 열어도 유지된다', async () => {
  await setMode('VIDEO_AUDIO');
  const options = await page.$$eval('#videoFormatSelect option', els => els.map(o => [o.value, o.textContent.trim()]));
  assert.deepEqual(options, [['mp4', 'MP4'], ['fmp4', 'fMP4 (조각)'], ['mov', 'MOV'], ['avi', 'AVI']]);
  await page.select('#videoFormatSelect', 'fmp4');
  await swWorker.evaluate(() => new Promise(r => setTimeout(r, 300)));
  const saved = await swWorker.evaluate(() => chrome.storage.sync.get('settings').then(r => (r.settings || {}).videoFormat));
  assert.equal(saved, 'fmp4', 'chrome.storage.sync settings.videoFormat');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#mainContainer.loaded', { timeout: 10_000 });
  assert.equal(await page.$eval('#videoFormatSelect', el => el.value), 'fmp4', '다시 열어도 fMP4 선택 유지');
  const l = await layout();
  assert.ok(l.height <= POPUP_MAX_HEIGHT, `fMP4 선택 상태 높이 ${l.height}px`);
  await page.select('#videoFormatSelect', 'mp4');
  await swWorker.evaluate(() => new Promise(r => setTimeout(r, 300)));
});

test('영상 힌트는 fMP4 설명(빠른 종료, 녹화 중 생성된 조각까지 보존)을 담고, 힌트가 길어져도 영상 열이 오디오 열보다 길어지지 않는다 (팝업 높이 그대로)', async () => {
  await setMode('VIDEO_AUDIO_SPLIT');
  const r = await page.evaluate(() => ({
    hint: document.getElementById('videoHint').textContent.trim(),
    video: document.getElementById('videoColumn').getBoundingClientRect().height,
    audio: document.getElementById('audioColumn').getBoundingClientRect().height,
    videoContent: (() => { const col = document.getElementById('videoColumn'); const last = [...col.children].filter(c => c.getBoundingClientRect().height > 0).at(-1); return last.getBoundingClientRect().bottom - col.getBoundingClientRect().top; })(),
    audioContent: (() => { const col = document.getElementById('audioColumn'); const last = [...col.children].filter(c => c.getBoundingClientRect().height > 0).at(-1); return last.getBoundingClientRect().bottom - col.getBoundingClientRect().top; })()
  }));
  assert.match(r.hint, /fMP4/);
  assert.match(r.hint, /빠른 종료/);
  assert.match(r.hint, /녹화 중 생성된 조각까지 보존/);
  assert.ok(r.videoContent <= r.audioContent, `영상 열 내용 ${r.videoContent}px ≤ 오디오 열 내용 ${r.audioContent}px (힌트가 열 높이를 늘리지 않음)`);
  console.log(`[popup-layout] 영상 열 내용 ${Math.round(r.videoContent)}px / 오디오 열 내용 ${Math.round(r.audioContent)}px, 열 높이 ${r.video}/${r.audio}px`);
});

test('모든 select의 선택 항목 텍스트가 잘리지 않고 표시된다 (텍스트 폭 ≤ 선택 상자 내부 폭)', async () => {
  await setMode('VIDEO_AUDIO_SPLIT');
  const clipped = await page.evaluate(() => {
    const canvas = document.createElement('canvas').getContext('2d');
    const out = [];
    for (const sel of document.querySelectorAll('select')) {
      const cs = getComputedStyle(sel);
      canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      // 화살표 영역(약 24px)과 좌우 패딩을 뺀 폭 안에 모든 옵션 텍스트가 들어가야 함
      const inner = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 24;
      for (const opt of sel.options) {
        const w = canvas.measureText(opt.textContent).width;
        if (w > inner) out.push(`${sel.id}: "${opt.textContent}" ${Math.round(w)}px > ${Math.round(inner)}px`);
      }
    }
    return out;
  });
  assert.deepEqual(clipped, [], clipped.join('\n'));
});

test('팝업은 세로 스크롤을 숨기지 않고(overflow 조작 없이) 내용 자체가 맞아야 한다', async () => {
  const l = await layout();
  assert.notEqual(l.overflowY, 'hidden', 'overflow:hidden으로 스크롤만 감추면 안 됨');
});

// ---- 녹화 중 / 일시정지 상태 ----
// Background(SW)에서 STATE_CHANGED를 보내 팝업의 실제 updateUI 경로로 상태를 바꿈 (녹화 자체는 시작하지 않음)
async function pushState(data) {
  await swWorker.evaluate((d) => chrome.runtime.sendMessage({ action: 'STATE_CHANGED', data: d }).catch(() => null), data);
  await new Promise(r => setTimeout(r, 100));
}
const sessionState = (state, mode, extra = {}) => ({
  state, mode, isRecording: state === 'RECORDING', paused: state === 'PAUSED', elapsed: 0, files: [], saving: false, ...extra
});
async function controls() {
  return page.evaluate(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      return { visible: !el.classList.contains('hidden') && r.height > 0, text: el.textContent.trim(), disabled: el.disabled, top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), clipped: el.scrollWidth > el.clientWidth };
    };
    return {
      pause: box('pauseButton'),
      record: box('recordButton'),
      status: document.getElementById('status').textContent.trim(),
      time: document.getElementById('timeDisplay').textContent.trim(),
      selectsDisabled: [...document.querySelectorAll('select')].every(sel => sel.disabled)
    };
  });
}

test('대기 상태에서는 일시정지 버튼이 숨겨지고 시작 버튼만 전체 폭으로 보인다', async () => {
  await pushState(sessionState('IDLE', 'VIDEO_AUDIO'));
  const c = await controls();
  assert.equal(c.pause.visible, false);
  assert.equal(c.record.visible, true);
  assert.equal(c.record.text, '녹화 시작');
});

// ---- 저장 위치: 팝업에는 표시하지 않음 (설정 페이지 settings.html에서만 확인·변경) ----
// 저장 위치 줄이 있던 자리의 문구: "저장: 다운로드 폴더" / "저장: <폴더명>"
const SAVE_LOCATION_TEXT = /저장:|저장 위치|다운로드 폴더/;
async function popupSaveLocationText() {
  return page.evaluate(() => {
    const container = document.getElementById('mainContainer');
    return {
      element: !!document.getElementById('saveLocation') || !!container.querySelector('.save-location'),
      text: container.innerText
    };
  });
}
// sync 미러(saveLocationMode/Name)를 바꾸고, 팝업의 storage.onChanged 리스너가 처리할 때까지 대기
// (팝업 리스너는 popup.js 로드 때 먼저 등록되므로, 나중에 등록한 이 리스너가 불리면 팝업 쪽 처리도 끝난 것)
async function setSaveLocationMirror(folderName) {
  const current = await swWorker.evaluate(() => chrome.storage.sync.get('settings').then(r => r.settings || {}));
  if ((current.saveLocationMode || 'downloads') === (folderName ? 'folder' : 'downloads') && (current.saveLocationName || '') === (folderName || '')) return; // 변경 없음 (변경 이벤트도 없음)
  // 리스너를 먼저 등록한 뒤 SW에서 미러를 바꿈
  await page.evaluate((mode) => {
    window.__mirrorApplied = new Promise((resolve) => {
      const listener = (changes, area) => {
        if (area !== 'sync' || !changes.settings || !changes.settings.newValue || changes.settings.newValue.saveLocationMode !== mode) return;
        chrome.storage.onChanged.removeListener(listener);
        setTimeout(resolve, 0);
      };
      chrome.storage.onChanged.addListener(listener);
      setTimeout(resolve, 3000); // 값이 이미 같아 변경 이벤트가 없을 때
    });
  }, folderName ? 'folder' : 'downloads');
  await swWorker.evaluate(async (name) => {
    const { settings = {} } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, saveLocationMode: name ? 'folder' : 'downloads', saveLocationName: name || '' } });
  }, folderName);
  await page.evaluate(() => window.__mirrorApplied);
}

test('저장 위치는 팝업에 표시하지 않는다: 기본(다운로드)·폴더 설정, 대기·녹화 중·일시정지 모두 저장 위치 줄과 문구가 없다 (설정 페이지에서만)', async () => {
  await setMode('VIDEO_AUDIO_SPLIT');
  try {
    for (const folder of [null, '녹화 모음']) {
      await setSaveLocationMirror(folder);
      for (const state of ['IDLE', 'RECORDING', 'PAUSED']) {
        await pushState(sessionState(state, 'VIDEO_AUDIO_SPLIT', state === 'IDLE' ? {} : { startTime: Date.now(), effectiveStartTime: Date.now(), pausedAt: state === 'PAUSED' ? Date.now() : null }));
        const r = await popupSaveLocationText();
        const where = `${folder ? `폴더 '${folder}'` : '기본(다운로드)'} / ${state}`;
        assert.equal(r.element, false, `${where}: 저장 위치 요소 없음`);
        assert.doesNotMatch(r.text, SAVE_LOCATION_TEXT, `${where}: 팝업 문구에 저장 위치 없음\n${r.text}`);
        if (folder) assert.ok(!r.text.includes(folder), `${where}: 폴더 이름이 팝업에 보이지 않음`);
      }
      await pushState(sessionState('IDLE', 'VIDEO_AUDIO_SPLIT'));
    }
    // 설정(⚙) 버튼은 그대로 (저장 위치는 설정 페이지에서)
    assert.equal(await page.$eval('#settingsButton', el => el.textContent.trim()), '⚙');
  } finally {
    await setSaveLocationMirror(null);
    await pushState(sessionState('IDLE', 'VIDEO_AUDIO_SPLIT'));
  }
});

for (const mode of MODES) {
  test(`${mode} 모드 녹화 중/일시정지: 일시정지(재개) 버튼이 중지 버튼 옆에 보이고 팝업 높이가 ${POPUP_MAX_HEIGHT}px 이내라 스크롤이 생기지 않는다`, async () => {
    await setMode(mode);
    for (const state of ['RECORDING', 'PAUSED']) {
      await pushState(sessionState(state, mode, { startTime: Date.now() - 3_000, effectiveStartTime: Date.now() - 3_000, elapsed: 3 }));
      const c = await controls();
      assert.equal(c.pause.visible, true, `${state}: 일시정지 버튼 표시`);
      assert.equal(c.record.visible, true, `${state}: 중지 버튼 표시`);
      assert.equal(c.pause.top, c.record.top, `${state}: 두 버튼이 한 줄`);
      assert.ok(c.pause.right <= c.record.left, `${state}: 일시정지 버튼이 중지 버튼 왼쪽`);
      assert.ok(!c.pause.clipped && !c.record.clipped, `${state}: 버튼 글자가 잘리지 않음`);
      const l = await layout();
      assert.ok(l.height <= POPUP_MAX_HEIGHT, `${state}: 높이 ${l.height}px > ${POPUP_MAX_HEIGHT}px`);
      assert.ok(l.containerBottom <= POPUP_MAX_HEIGHT, `${state}: 컨테이너 하단 ${l.containerBottom}px`);
      console.log(`[popup-layout] ${mode} ${state}: 높이 ${l.height}px`);
      if (state === 'RECORDING') {
        const shot = await screenshotPopup(`popup-${mode}-RECORDING`);
        assert.ok(shot.height <= POPUP_MAX_HEIGHT && shot.width <= POPUP_MAX_WIDTH);
      }
    }
    await pushState(sessionState('IDLE', mode));
  });
}

test('일시정지 상태: 상태 "일시정지", 버튼 "재개", 설정 선택 비활성, 경과 시간이 멈춘다', async () => {
  await setMode('VIDEO_AUDIO');
  const startTime = Date.now() - 80_000;
  await pushState(sessionState('PAUSED', 'VIDEO_AUDIO', { startTime, effectiveStartTime: startTime + 5_000, pausedTotalMs: 5_000, pausedAt: Date.now() - 2_000, elapsed: 73 }));
  const c1 = await controls();
  assert.equal(c1.status, '일시정지');
  assert.equal(c1.pause.text, '재개');
  assert.equal(c1.pause.disabled, false);
  assert.equal(c1.record.text, '녹화 중지');
  assert.equal(c1.record.disabled, false, '일시정지 중에도 중지 가능');
  assert.equal(c1.selectsDisabled, true, '일시정지 중에도 설정 변경 불가');
  assert.equal(c1.time, '01:13', 'Background가 계산한 일시정지 시점 경과 시간');
  await new Promise(r => setTimeout(r, 1_600));
  const c2 = await controls();
  assert.equal(c2.time, '01:13', '일시정지 중에는 시간이 흐르지 않음');
});

test('재개: effectiveStartTime 기준으로 멈춘 값에서 이어서 흐르고, 버튼은 다시 "일시정지"가 된다', async () => {
  // 시작 80초 전, 일시정지 누적 6.8초 → 경과 73.2초에서 재개 (팝업 타이머는 1초 간격 틱이라 경계에서 여유를 둠)
  const startTime = Date.now() - 80_000;
  await pushState(sessionState('RECORDING', 'VIDEO_AUDIO', { startTime, effectiveStartTime: startTime + 6_800, pausedTotalMs: 6_800, elapsed: 73 }));
  const c1 = await controls();
  assert.equal(c1.status, '녹화 중...');
  assert.equal(c1.pause.text, '일시정지');
  assert.equal(c1.time, '01:13', '일시정지 시간을 뺀 값에서 이어짐 (원래 startTime 기준이면 01:20)');
  await new Promise(r => setTimeout(r, 1_300));
  const c2 = await controls();
  assert.equal(c2.time, '01:14', '재개 후에는 다시 흐름');
  await pushState(sessionState('IDLE', 'VIDEO_AUDIO'));
  const c3 = await controls();
  assert.equal(c3.pause.visible, false, '대기 상태로 돌아가면 숨김');
  assert.equal(c3.selectsDisabled, false);
});


test('녹화 중/일시정지 중에는 모드와 상관없이 두 열의 모든 설정이 비활성이고, 대기로 돌아오면 모드 규칙이 다시 적용된다', async () => {
  await setMode('VIDEO_AUDIO');
  const disabledAll = () => page.evaluate(() => ['modeSelect', 'videoFormatSelect', 'formatSelect', 'bitrateSelect', 'sampleRateSelect'].map(id => [id, document.getElementById(id).disabled]));
  await pushState(sessionState('RECORDING', 'VIDEO_AUDIO', { startTime: Date.now(), effectiveStartTime: Date.now() }));
  assert.ok((await disabledAll()).every(([, d]) => d), JSON.stringify(await disabledAll()));
  await pushState(sessionState('PAUSED', 'VIDEO_AUDIO', { startTime: Date.now(), effectiveStartTime: Date.now(), pausedAt: Date.now() }));
  assert.ok((await disabledAll()).every(([, d]) => d));
  await pushState(sessionState('IDLE', 'VIDEO_AUDIO'));
  assert.deepEqual(Object.fromEntries(await disabledAll()), { modeSelect: false, videoFormatSelect: false, formatSelect: true, bitrateSelect: false, sampleRateSelect: false });
});

test('완료 메시지는 파일이 저장된 곳을 알려 준다 (폴더: "\'<폴더명>\'에 저장", 기본: "다운로드 폴더에 저장")', async () => {
  const files = (savedTo, location) => [
    { kind: 'video', format: 'mp4', filename: 'recorda_x.mp4', size: 10, savedTo, location },
    { kind: 'audio', format: 'wav', filename: 'recorda_x.wav', size: 5, savedTo, location }
  ];
  const messageText = () => page.$eval('#message', el => ({ text: el.textContent.trim(), cls: el.className }));
  await pushState(sessionState('IDLE', 'VIDEO_AUDIO_SPLIT', { files: files('folder', 'Recordings') }));
  let m = await messageText();
  assert.match(m.cls, /success/);
  assert.equal(m.text, "녹화가 완료되어 2개 파일이 'Recordings'에 저장되었습니다. (MP4, WAV)");
  await pushState(sessionState('IDLE', 'VIDEO_AUDIO_SPLIT', { files: files('downloads', null) }));
  m = await messageText();
  assert.equal(m.text, '녹화가 완료되어 2개 파일이 다운로드 폴더에 저장되었습니다. (MP4, WAV)');
  await pushState(sessionState('IDLE', 'VIDEO_AUDIO_SPLIT', { files: [files('downloads', null)[0], files('folder', 'Recordings')[1]] }));
  m = await messageText();
  assert.equal(m.text, "녹화가 완료되었습니다. 'Recordings'에 1개 (WAV), 다운로드 폴더에 1개 (MP4) 저장되었습니다.");
  // fMP4는 .mp4 파일이라 "MP4"로 표시 (RECORDING_COMPLETE의 label, 없으면 포맷 값에서)
  const fmp4Files = [{ ...files('folder', 'Recordings')[0], format: 'fmp4', label: 'MP4' }, files('folder', 'Recordings')[1]];
  await pushState(sessionState('IDLE', 'VIDEO_AUDIO_SPLIT', { files: fmp4Files }));
  m = await messageText();
  assert.equal(m.text, "녹화가 완료되어 2개 파일이 'Recordings'에 저장되었습니다. (MP4, WAV)");
  await pushState(sessionState('IDLE', 'VIDEO_AUDIO_SPLIT', { files: [{ ...fmp4Files[0], label: undefined, savedTo: 'downloads', location: null }] }));
  m = await messageText();
  assert.equal(m.text, '녹화가 완료되어 1개 파일이 다운로드 폴더에 저장되었습니다. (MP4)', 'label이 없어도 fmp4 → MP4');
  const l = await layout();
  assert.ok(l.height <= POPUP_MAX_HEIGHT, `높이 ${l.height}px`);
  await page.evaluate(() => { document.getElementById('message').className = 'message'; });
});

// ---- 녹화 시작 시 저장 폴더 권한 확인 (팝업 = 사용자 제스처) ----
// START_RECORDING은 Background로 보내지 않고 가로채 saveLocation만 확인 (실제 녹화는 run.mjs E2E에서)
test('녹화 시작 시 폴더 모드면 권한을 확인·요청해 saveLocation을 정하고, 권한이 없거나 폴더 정보가 없으면 이번 녹화만 다운로드로 저장한다고 안내한다', async () => {
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#mainContainer.loaded', { timeout: 10_000 });
  await page.evaluate(async () => {
    // 팝업 리스너(popup.js)가 sync 미러 변경을 처리한 뒤에 녹화를 시작하도록, 이 페이지에서 변경 이벤트를 기다림
    window.__mirrorChanged = (mode) => new Promise((resolve) => {
      const listener = (changes, area) => {
        if (area !== 'sync' || !changes.settings || !changes.settings.newValue || changes.settings.newValue.saveLocationMode !== mode) return;
        chrome.storage.onChanged.removeListener(listener);
        setTimeout(resolve, 0);
      };
      chrome.storage.onChanged.addListener(listener);
      setTimeout(resolve, 3000); // 값이 이미 같아 변경 이벤트가 없을 때
    });
    // 저장 폴더: OPFS 하위 폴더 (실제 IndexedDB + chrome.storage.sync 미러)
    const location = await import('./save-location.js');
    const root = await navigator.storage.getDirectory();
    const folderApplied = window.__mirrorChanged('folder');
    await location.saveDirectoryHandle(await root.getDirectoryHandle('Popup Folder', { create: true }));
    await folderApplied;
    window.__starts = [];
    window.__permission = { query: 'prompt', request: 'granted', requests: 0 };
    FileSystemHandle.prototype.queryPermission = async function () { return window.__permission.query; };
    FileSystemHandle.prototype.requestPermission = async function (descriptor) {
      window.__permission.requests++;
      window.__permission.lastDescriptor = descriptor;
      return window.__permission.request;
    };
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      if (message && message.action === 'START_RECORDING') {
        window.__starts.push(message.data);
        return { success: true, data: null };
      }
      return original(message);
    };
  });
  const start = async () => {
    await pushState(sessionState('IDLE', 'VIDEO_AUDIO'));
    await page.evaluate(() => { document.getElementById('message').className = 'message'; });
    const before = await page.evaluate(() => window.__starts.length);
    await page.click('#recordButton');
    await page.waitForFunction((n) => window.__starts.length > n, { timeout: 5000 }, before);
    await new Promise(r => setTimeout(r, 100));
    return page.evaluate(() => {
      const m = document.getElementById('message');
      return { data: window.__starts.at(-1), permission: { ...window.__permission }, message: m.classList.contains('show') ? m.textContent.trim() : '', messageClass: m.className };
    });
  };

  try {
    // 1) prompt → requestPermission(readwrite) → granted: 폴더에 저장
    let r = await start();
    assert.equal(r.data.saveLocation, 'folder');
    assert.equal(r.permission.requests, 1, '권한 요청');
    assert.deepEqual(r.permission.lastDescriptor, { mode: 'readwrite' });
    assert.equal(r.message, '', '안내 없음');

    // 2) 이미 granted면 다시 묻지 않음
    await page.evaluate(() => { window.__permission = { query: 'granted', request: 'granted', requests: 0 }; });
    r = await start();
    assert.equal(r.data.saveLocation, 'folder');
    assert.equal(r.permission.requests, 0);

    // 3) 요청이 거부되면 이번 녹화만 다운로드로 + 안내
    await page.evaluate(() => { window.__permission = { query: 'prompt', request: 'denied', requests: 0 }; });
    r = await start();
    assert.equal(r.data.saveLocation, 'downloads');
    assert.equal(r.permission.requests, 1);
    assert.match(r.messageClass, /info/);
    assert.match(r.message, /권한/);
    assert.match(r.message, /다운로드 폴더/);
    let l = await layout();
    assert.ok(l.height <= POPUP_MAX_HEIGHT, `안내 표시 중 높이 ${l.height}px`);

    // 4) 미러는 폴더인데 IndexedDB에 핸들이 없으면(다른 프로필 동기화 등) 다운로드로 + 안내
    await page.evaluate(async () => {
      const location = await import('./save-location.js');
      const { settings } = await chrome.storage.sync.get('settings');
      await location.clearDirectoryHandle();
      const folderApplied = window.__mirrorChanged('folder');
      await chrome.storage.sync.set({ settings: { ...settings, saveLocationMode: 'folder', saveLocationName: 'Popup Folder' } });
      await folderApplied;
    });
    r = await start();
    assert.equal(r.data.saveLocation, 'downloads');
    assert.match(r.message, /찾을 수 없어/);
  } finally {
    await page.evaluate(async () => {
      const location = await import('./save-location.js');
      await location.clearDirectoryHandle();
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#mainContainer.loaded', { timeout: 10_000 });
    await pushState(sessionState('IDLE', 'VIDEO_AUDIO'));
  }
  const after = await popupSaveLocationText();
  assert.equal(after.element, false, '팝업에 저장 위치 요소 없음');
  assert.doesNotMatch(after.text, SAVE_LOCATION_TEXT);
});

// ---- 헤더 설정 버튼 / 설정 페이지 ----
// 헤더 한 줄: 제목 · 상태 · ⚙가 같은 세로 중앙선 (⚙는 상태 줄 상자와 같은 높이의 정사각형, 위쪽 오프셋 없음)
async function headerGeometry() {
  return page.evaluate(() => {
    window.scrollTo(0, 0); // 앞선 클릭으로 측정용(높이 100px) 뷰포트가 스크롤돼 있을 수 있어 좌표를 페이지 기준으로 맞춤
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, centerY: (r.top + r.bottom) / 2 }; };
    const container = document.getElementById('mainContainer');
    const cs = getComputedStyle(container);
    const status = document.getElementById('status');
    const button = document.getElementById('settingsButton');
    const bs = getComputedStyle(button);
    return {
      title: box(document.querySelector('.header h1')),
      status: box(status),
      statusText: status.textContent.trim(),
      statusLineHeight: parseFloat(getComputedStyle(status).lineHeight),
      button: box(button),
      buttonOffset: { marginTop: bs.marginTop, position: bs.position, top: bs.top, transform: bs.transform, verticalAlign: bs.verticalAlign },
      // 콘텐츠 오른쪽 끝 = 컨테이너 안쪽(패딩 제외) 오른쪽 끝 = 녹화 모드 선택 상자·녹화 버튼의 오른쪽 끝
      contentRight: container.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
      modeSelectRight: document.getElementById('modeSelect').getBoundingClientRect().right
    };
  });
}

test('헤더: 제목·상태·⚙가 한 줄의 같은 세로 중앙선에 있다 (상태와 ⚙ 중심 차 ≤ 2px, ⚙ = 상태 줄 높이의 정사각형·위쪽 오프셋 없음, ⚙ 오른쪽 끝 = 콘텐츠 오른쪽 끝 ±2px) - 대기/녹화 중/일시정지/파일 생성 중', async () => {
  await setMode('VIDEO_AUDIO_SPLIT');
  const now = Date.now();
  const states = [
    ['IDLE', '대기 중', {}],
    ['RECORDING', '녹화 중...', { startTime: now, effectiveStartTime: now }],
    ['PAUSED', '일시정지', { startTime: now, effectiveStartTime: now, pausedAt: now }],
    ['PROCESSING', '파일 생성 중...', {}]
  ];
  try {
    for (const [state, text, extra] of states) {
      await pushState(sessionState(state, 'VIDEO_AUDIO_SPLIT', extra));
      const g = await headerGeometry();
      const where = `${state} "${g.statusText}"`;
      assert.equal(g.statusText, text);
      assert.ok(Math.abs(g.status.height - g.statusLineHeight) <= 0.5, `${where}: 상태는 한 줄 (${g.status.height}px)`);
      assert.ok(Math.abs(g.status.centerY - g.button.centerY) <= 2, `${where}: 상태 중심 ${g.status.centerY} / ⚙ 중심 ${g.button.centerY}`);
      assert.ok(Math.abs(g.title.centerY - g.button.centerY) <= 2, `${where}: 제목 중심 ${g.title.centerY} / ⚙ 중심 ${g.button.centerY}`);
      assert.ok(Math.abs(g.button.width - g.button.height) <= 0.5, `${where}: ⚙ 정사각형 (${g.button.width}x${g.button.height})`);
      assert.ok(Math.abs(g.button.height - g.status.height) <= 0.5, `${where}: ⚙ 높이 ${g.button.height}px = 상태 줄 높이 ${g.status.height}px`);
      assert.ok(Math.abs(g.button.top - g.status.top) <= 0.5, `${where}: ⚙ 위쪽 ${g.button.top} = 상태 위쪽 ${g.status.top} (추가 오프셋 없음)`);
      assert.deepEqual({ marginTop: g.buttonOffset.marginTop, transform: g.buttonOffset.transform }, { marginTop: '0px', transform: 'none' }, `${where}: ⚙ 위쪽 여백·이동 없음`);
      assert.ok(g.buttonOffset.position === 'static' || g.buttonOffset.top === 'auto' || g.buttonOffset.top === '0px', `${where}: ⚙ 위치 이동 없음 (${JSON.stringify(g.buttonOffset)})`);
      assert.ok(Math.abs(g.button.right - g.contentRight) <= 2, `${where}: ⚙ 오른쪽 끝 ${g.button.right} / 콘텐츠 오른쪽 끝 ${g.contentRight}`);
      assert.ok(Math.abs(g.button.right - g.modeSelectRight) <= 2, `${where}: ⚙ 오른쪽 끝 ${g.button.right} / 녹화 모드 선택 상자 오른쪽 끝 ${g.modeSelectRight}`);
      assert.ok(g.status.right <= g.button.left, `${where}: 상태는 ⚙ 왼쪽`);
      console.log(`[popup-layout] 헤더 ${where}: 제목/상태/⚙ 중심 ${g.title.centerY}/${g.status.centerY}/${g.button.centerY}px, ⚙ ${g.button.width}x${g.button.height}, 오른쪽 끝 ⚙ ${g.button.right} / 콘텐츠 ${g.contentRight}`);
    }
  } finally {
    await pushState(sessionState('IDLE', 'VIDEO_AUDIO_SPLIT'));
  }
});

test('헤더 오른쪽의 설정(⚙) 버튼은 상태 표시 오른쪽 끝에 있고, 누르면 설정 페이지(settings.html, options_page)가 열린다', async () => {
  const g = await page.evaluate(() => {
    const button = document.getElementById('settingsButton');
    const b = button.getBoundingClientRect();
    const header = document.querySelector('.header').getBoundingClientRect();
    const status = document.getElementById('status').getBoundingClientRect();
    return { text: button.textContent.trim(), label: button.getAttribute('aria-label'), inHeader: b.top >= header.top - 1 && b.bottom <= header.bottom + 1, rightOfStatus: b.left >= status.right, rightGap: header.right - b.right, width: b.width };
  });
  assert.equal(g.text, '⚙');
  assert.ok(g.label && g.label.includes('설정'));
  assert.ok(g.inHeader, '헤더 줄 안');
  assert.ok(g.rightOfStatus, '상태 표시 오른쪽');
  assert.ok(g.rightGap <= 1, `헤더 오른쪽 끝 (간격 ${g.rightGap}px)`);
  assert.ok(g.width >= 20, '누를 수 있는 크기');

  const opened = browser.waitForTarget(t => t.url() === `chrome-extension://${extensionId}/settings.html`, { timeout: 10_000 });
  await page.click('#settingsButton');
  const target = await opened;
  const settingsPage = await target.page();
  await settingsPage.waitForSelector('#currentLocation', { timeout: 10_000 });
  await settingsPage.close();
  await page.bringToFront();
});

test('설정 페이지: 기본 표시 → 폴더 선택(쓰기 확인 후 저장, 팝업에는 저장 위치 미표시) → 쓰기 불가 폴더 거부 → 권한 다시 요청 → 기본(다운로드)으로 되돌리기', async () => {
  const settings = await browser.newPage();
  await settings.setViewport({ width: 900, height: 700 });
  const errors = [];
  settings.on('pageerror', e => errors.push(e.message));
  await settings.goto(`chrome-extension://${extensionId}/settings.html`, { waitUntil: 'load' });
  await settings.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 10_000 });
  const read = () => settings.evaluate(() => {
    const visible = (id) => { const el = document.getElementById(id); return !!el && !el.classList.contains('hidden') && el.getBoundingClientRect().height > 0; };
    return {
      location: document.getElementById('currentLocation').textContent.trim(),
      resetDisabled: document.getElementById('resetFolderButton').disabled,
      permissionVisible: visible('permissionRow'),
      permission: document.getElementById('permissionStatus').textContent.trim(),
      permissionState: document.getElementById('permissionStatus').dataset.state || null,
      requestVisible: visible('requestPermissionButton'),
      message: visible('settingsMessage') ? document.getElementById('settingsMessage').textContent.trim() : '',
      messageType: document.getElementById('settingsMessage').dataset.type || ''
    };
  });
  const mirror = () => swWorker.evaluate(() => chrome.storage.sync.get('settings').then(r => r.settings || {}));

  let s = await read();
  assert.equal(s.location, '기본: 다운로드 폴더');
  assert.equal(s.resetDisabled, true);
  assert.equal(s.permissionVisible, false);
  // 폴더 설정 아래 안내: fMP4 비정상 종료 시 .crswap 임시 파일을 .mp4로 바꾸면 재생, 다운로드 저장은 복구 불가
  const crswap = await settings.$eval('#crswapNote', el => el.textContent.replace(/\s+/g, ' ').trim());
  assert.match(crswap, /fMP4/);
  assert.match(crswap, /\.crswap/);
  assert.match(crswap, /\.mp4/);
  assert.match(crswap, /복구할 수 없습니다/);

  // 헤드리스에서는 실제 폴더 선택 창을 띄울 수 없어 showDirectoryPicker를 OPFS 하위 폴더를 돌려주는 스텁으로 대체
  await settings.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('E2E Recordings', { create: true });
    window.__pickerCalls = [];
    window.showDirectoryPicker = async (options) => { window.__pickerCalls.push(options); return dir; };
  });
  await settings.click('#pickFolderButton');
  await settings.waitForFunction(() => document.getElementById('currentLocation').textContent.includes('E2E Recordings'), { timeout: 10_000 });
  s = await read();
  const pickerCalls = await settings.evaluate(() => window.__pickerCalls);
  assert.equal(pickerCalls.length, 1);
  assert.equal(pickerCalls[0].mode, 'readwrite', 'readwrite로 선택 창 요청');
  assert.equal(s.location, 'E2E Recordings');
  assert.equal(s.resetDisabled, false);
  assert.equal(s.permissionVisible, true);
  assert.equal(s.permissionState, 'granted');
  assert.match(s.permission, /허용/);
  assert.equal(s.requestVisible, false, '허용 상태에서는 권한 요청 버튼 숨김');
  assert.equal(s.messageType, 'success', s.message);
  const leftovers = await settings.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('E2E Recordings');
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    return names;
  });
  assert.deepEqual(leftovers, [], '쓰기 확인 파일은 지워짐');
  let m = await mirror();
  assert.equal(m.saveLocationMode, 'folder');
  assert.equal(m.saveLocationName, 'E2E Recordings');

  // 팝업에는 저장 위치를 표시하지 않음: 폴더를 골라도 팝업 문구에 폴더 이름·저장 위치가 없음 (설정 페이지에서만)
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#mainContainer.loaded', { timeout: 10_000 });
  const popupText = await popupSaveLocationText();
  assert.equal(popupText.element, false, '팝업에 저장 위치 요소 없음');
  assert.ok(!popupText.text.includes('E2E Recordings'), `팝업에 폴더 이름 없음\n${popupText.text}`);
  assert.doesNotMatch(popupText.text, SAVE_LOCATION_TEXT);

  // 쓰기 불가 폴더: 확인 파일 생성이 거부되면 오류를 보여 주고 기존 설정 유지
  await settings.evaluate(() => {
    window.showDirectoryPicker = async () => ({
      kind: 'directory',
      name: 'ReadOnly',
      queryPermission: async () => 'granted',
      getFileHandle: async () => { throw new DOMException('The request is not allowed', 'NotAllowedError'); },
      removeEntry: async () => {}
    });
  });
  await settings.click('#pickFolderButton');
  await settings.waitForFunction(() => document.getElementById('settingsMessage').dataset.type === 'error', { timeout: 10_000 });
  s = await read();
  assert.match(s.message, /쓸 수 없습니다/);
  assert.equal(s.location, 'E2E Recordings', '기존 폴더 유지');

  // 선택 취소(AbortError)는 오류로 보지 않음
  await settings.evaluate(() => { window.showDirectoryPicker = async () => { throw new DOMException('The user aborted a request.', 'AbortError'); }; });
  await settings.click('#pickFolderButton');
  await new Promise(r => setTimeout(r, 300));
  s = await read();
  assert.notEqual(s.messageType, 'error', `취소는 오류 아님: ${s.message}`);

  // 권한 상태가 prompt면(예: Chrome 재시작 후) "권한 다시 요청" 버튼으로 requestPermission
  await settings.evaluateOnNewDocument(() => {
    window.__requests = [];
    FileSystemHandle.prototype.queryPermission = async function () { return window.__granted ? 'granted' : 'prompt'; };
    FileSystemHandle.prototype.requestPermission = async function (descriptor) { window.__requests.push(descriptor); window.__granted = true; return 'granted'; };
  });
  await settings.reload({ waitUntil: 'load' });
  await settings.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 10_000 });
  s = await read();
  assert.equal(s.location, 'E2E Recordings', 'IndexedDB에서 핸들 복원');
  assert.equal(s.permissionState, 'prompt');
  assert.equal(s.requestVisible, true);
  await settings.click('#requestPermissionButton');
  await settings.waitForFunction(() => document.getElementById('permissionStatus').dataset.state === 'granted', { timeout: 5000 });
  assert.deepEqual(await settings.evaluate(() => window.__requests), [{ mode: 'readwrite' }]);

  await screenshotSettings(settings);

  // 기본으로 되돌리기
  await settings.click('#resetFolderButton');
  await settings.waitForFunction(() => document.getElementById('currentLocation').textContent.trim() === '기본: 다운로드 폴더', { timeout: 5000 });
  s = await read();
  assert.equal(s.resetDisabled, true);
  assert.equal(s.permissionVisible, false);
  m = await mirror();
  assert.equal(m.saveLocationMode, 'downloads');
  assert.equal(m.saveLocationName, '');
  assert.deepEqual(errors, [], '페이지 오류 없음');
  await settings.close();
  await page.bringToFront();
});

async function screenshotSettings(settings) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 'settings-page.png');
  await settings.screenshot({ path, fullPage: true });
  console.log(`[popup-layout] 스크린샷 ${path}`);
}
