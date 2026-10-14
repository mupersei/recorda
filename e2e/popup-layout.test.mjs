// 팝업 레이아웃 테스트 - 실제 Chrome에서 popup.html을 열어 모든 모드/상태에서 세로 스크롤 없이 표시되는지 확인
// 실행: cd e2e && node --test popup-layout.test.mjs   (CHROME_LIB_DIR 등 환경 변수는 run.mjs와 동일)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Chrome 확장 팝업의 최대 크기 (이보다 크면 팝업 안에 스크롤이 생김)
const POPUP_MAX_HEIGHT = 600;
const POPUP_MAX_WIDTH = 800;

let browser, page, extensionId;

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

for (const mode of ['AUDIO_ONLY', 'VIDEO_AUDIO', 'VIDEO_AUDIO_SPLIT']) {
  test(`${mode} 모드: 대기 상태 팝업 전체 높이가 ${POPUP_MAX_HEIGHT}px 이내라 스크롤이 생기지 않는다`, async () => {
    await setMode(mode);
    const l = await layout();
    assert.ok(l.height <= POPUP_MAX_HEIGHT, `높이 ${l.height}px > ${POPUP_MAX_HEIGHT}px`);
    assert.ok(l.containerBottom <= POPUP_MAX_HEIGHT, `컨테이너 하단 ${l.containerBottom}px`);
    assert.ok(l.width <= POPUP_MAX_WIDTH, `폭 ${l.width}px`);
  });
}

test('가장 긴 상태(분리 저장 모드 + 완료 메시지 + 시:분:초 시간 표시)에서도 스크롤이 생기지 않는다', async () => {
  await setMode('VIDEO_AUDIO_SPLIT');
  await page.evaluate(() => {
    document.getElementById('timeDisplay').textContent = '12:34:56';
    const m = document.getElementById('message');
    m.textContent = '녹화가 완료되어 2개 파일이 저장되었습니다. (MP4, MP3) 파일 저장에 실패했습니다: recorda_20261013_000000.mp3 (FILE_FAILED)';
    m.className = 'message error show';
  });
  const l = await layout();
  assert.ok(l.height <= POPUP_MAX_HEIGHT, `높이 ${l.height}px > ${POPUP_MAX_HEIGHT}px`);
  await page.evaluate(() => { document.getElementById('message').className = 'message'; document.getElementById('timeDisplay').textContent = '00:00'; });
});

test('모드 전환 시 영상/오디오 포맷 선택 표시가 올바르게 바뀐다', async () => {
  const visible = async (id) => page.$eval(`#${id}`, el => !el.classList.contains('hidden') && el.getBoundingClientRect().height > 0);
  await setMode('AUDIO_ONLY');
  assert.equal(await visible('videoFormatGroup'), false);
  assert.equal(await visible('audioFormatGroup'), true);
  await setMode('VIDEO_AUDIO');
  assert.equal(await visible('videoFormatGroup'), true);
  assert.equal(await visible('audioFormatGroup'), false);
  await setMode('VIDEO_AUDIO_SPLIT');
  assert.equal(await visible('videoFormatGroup'), true);
  assert.equal(await visible('audioFormatGroup'), true);
});

test('영상 힌트는 영상 모드에서만 보인다', async () => {
  const hintVisible = () => page.$eval('#videoHint', el => el.getBoundingClientRect().height > 0);
  await setMode('AUDIO_ONLY');
  assert.equal(await hintVisible(), false, '오디오 전용 모드에서는 영상 힌트 숨김');
  await setMode('VIDEO_AUDIO');
  assert.equal(await hintVisible(), true);
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
