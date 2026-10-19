// 녹화 종료 → 영상 파일 생성 소요 시간·메모리 벤치마크 (실제 Chrome, OPFS, chrome.downloads)
//
// 실제 녹화 대신, 인코더 출력과 같은 크기 분포의 합성 H.264/MP3 샘플을 저장소에 넣고
// 사용자가 "중지"를 누른 뒤 일어나는 단계만 실제 코드로 측정합니다.
//   1) 저장소 finalize  2) 머싱(writeMp4/writeAvi → OPFS 파일)  3) chrome.downloads 저장
// 머싱 단계 동안 Chrome 프로세스(렌더러·브라우저) RSS와 컨테이너(cgroup) 메모리를 100 ms마다 측정해 피크를 보고합니다.
// 샘플 메타데이터는 확장과 같은 SampleIndex(typed array)로 만듭니다. 이전 버전 확장(RECORDA_EXT_DIR)에는 SampleIndex가
// 없으므로 그때는 기존처럼 샘플 객체 배열로 만들어 같은 조건에서 전/후를 비교할 수 있습니다.
//
// 리소스 상한(CPU 2, 메모리 4Gi) 보호: Chrome 1개만 사용, 컨테이너 메모리가 RECORDA_MEM_LIMIT_MB(기본 3000)를
// 넘으면 즉시 중단, 시나리오 사이에 OPFS/다운로드 파일 삭제와 페이지 캐시 해제.
//
// 사용법:
//   node finalize-bench.mjs --mode=count --minutes=60 --format=mp4   # 1시간 샘플 수, 작은 페이로드 (호출 횟수 비용)
//   node finalize-bench.mjs --mode=bytes --minutes=10 --mbps=2.5     # 실제 크기 데이터 (처리량·메모리)
//   옵션: --download=0 (chrome.downloads 단계 생략), --sampleMs=100
//   환경: RECORDA_EXT_DIR (측정할 확장 디렉토리, 기본 이 저장소), RECORDA_BENCH_DIR, CHROME_LIB_DIR, RECORDA_MEM_LIMIT_MB
import puppeteer from 'puppeteer';
import { readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPressureThrottle } from './pressure-throttle.mjs';

const EXT_DIR = process.env.RECORDA_EXT_DIR ? resolve(process.env.RECORDA_EXT_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const MODE = args.mode || 'count';
const MINUTES = Number(args.minutes || 60);
const MBPS = Number(args.mbps || 6);
const FORMATS = String(args.format || 'mp4').split(',');
const DOWNLOAD = args.download !== '0';
const SAMPLE_MS = Number(args.sampleMs || 100);
const MEM_LIMIT_MB = Number(process.env.RECORDA_MEM_LIMIT_MB || 3000);
const WORK_DIR = process.env.RECORDA_BENCH_DIR || '/workspace/.tools/bench';
const LIB_DIR = process.env.CHROME_LIB_DIR || '';
// RECORDA_THROTTLE_MB: (테스트 환경용) 컨테이너 메모리가 이 값을 넘으면 확장 렌더러를 잠시 멈춤 (e2e/pressure-throttle.mjs)
const THROTTLE_MB = Number(process.env.RECORDA_THROTTLE_MB || 0);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const MB = (bytes) => Math.round(bytes / 1048576);

function cgroup() {
  try {
    const current = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    const stat = readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
    const pick = (k) => Number((stat.match(new RegExp(`^${k} (\\d+)`, 'm')) || [0, 0])[1]);
    return { current: MB(current), anon: MB(pick('anon')), file: MB(pick('file')) };
  } catch { return { current: 0, anon: 0, file: 0 }; }
}

/** Chrome 프로세스 트리의 RSS (VmRSS, 프로세스 종류별: browser / renderer / gpu-process / utility:<종류> …) */
function chromeRss(rootPid) {
  const procs = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const status = readFileSync(`/proc/${d}/status`, 'utf8');
      const ppid = Number((status.match(/^PPid:\s+(\d+)/m) || [0, 0])[1]);
      const rss = Number((status.match(/^VmRSS:\s+(\d+) kB/m) || [0, 0])[1]) * 1024;
      const anon = Number((status.match(/^RssAnon:\s+(\d+) kB/m) || [0, 0])[1]) * 1024;
      const shmem = Number((status.match(/^RssShmem:\s+(\d+) kB/m) || [0, 0])[1]) * 1024;
      let type = 'browser';
      try {
        const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8');
        const m = cmd.match(/--type=([a-z-]+)/);
        if (m) {
          type = m[1];
          const sub = cmd.match(/--utility-sub-type=([A-Za-z._]+)/);
          if (type === 'utility' && sub) type = `utility:${sub[1].split('.').pop()}`;
        }
      } catch { /* 종료됨 */ }
      procs.set(Number(d), { pid: Number(d), ppid, rss, anon, shmem, type });
    } catch { /* 종료된 프로세스 */ }
  }
  const out = { browser: 0, rendererMax: 0, rendererSum: 0, other: 0, total: 0 };
  const byType = {};
  const walk = (pid, depth) => {
    const p = procs.get(pid);
    if (!p) return;
    out.total += p.rss;
    const type = depth === 0 ? 'browser' : p.type;
    byType[type] = (byType[type] || 0) + p.rss;
    if (p.type === 'renderer' && depth > 0) { byType[`renderer#${p.pid}.anon`] = p.anon; byType[`renderer#${p.pid}.shmem`] = p.shmem; }
    if (depth === 0) out.browser += p.rss;
    else if (p.type === 'renderer') { out.rendererSum += p.rss; out.rendererMax = Math.max(out.rendererMax, p.rss); }
    else out.other += p.rss;
    for (const q of procs.values()) if (q.ppid === pid) walk(q.pid, depth + 1);
  };
  walk(rootPid, 0);
  const result = { browser: MB(out.browser), rendererMax: MB(out.rendererMax), rendererSum: MB(out.rendererSum), other: MB(out.other), total: MB(out.total) };
  for (const [k, v] of Object.entries(byType)) result[`type:${k}`] = MB(v);
  return result;
}

/** 비동기 작업 동안 SAMPLE_MS 간격으로 메모리 표본 → 피크와 시작값 */
async function sampleDuring(rootPid, work) {
  const start = { ...chromeRss(rootPid), cg: cgroup() };
  const peak = JSON.parse(JSON.stringify(start));
  const series = [];
  const t0 = Date.now();
  const take = () => {
    const r = chromeRss(rootPid);
    const cg = cgroup();
    for (const k of Object.keys(r)) peak[k] = Math.max(peak[k] || 0, r[k]);
    for (const k of Object.keys(cg)) peak.cg[k] = Math.max(peak.cg[k], cg[k]);
    series.push({ t: Date.now() - t0, rendererMax: r.rendererMax, browser: r.browser, total: r.total, anon: cg.anon, file: cg.file });
  };
  const timer = setInterval(take, SAMPLE_MS);
  try {
    const result = await work();
    take();
    return { result, start, peak, end: series[series.length - 1], series };
  } finally {
    clearInterval(timer);
  }
}

/** 디렉토리 아래 파일의 페이지 캐시 해제 (cgroup 메모리에 잡히는 file 캐시를 줄임) */
function evictCache(dir) {
  try {
    execFileSync('python3', ['-c', `
import os,sys
for r,_,fs in os.walk(sys.argv[1]):
    for f in fs:
        try:
            fd=os.open(os.path.join(r,f),os.O_RDONLY); os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED); os.close(fd)
        except OSError: pass
`, dir]);
  } catch { /* 무시 */ }
}

async function main() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  const profile = join(WORK_DIR, 'profile');
  const downloads = join(WORK_DIR, 'downloads');
  mkdirSync(profile, { recursive: true });
  mkdirSync(downloads, { recursive: true });

  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: '/dev/null' };
  if (LIB_DIR) env.LD_LIBRARY_PATH = `${LIB_DIR}/usr/lib/x86_64-linux-gnu:${LIB_DIR}/lib/x86_64-linux-gnu`;
  const browser = await puppeteer.launch({
    headless: true, env, userDataDir: profile, protocolTimeout: 1_800_000,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`]
  });
  const browserPid = browser.process().pid;
  log('확장:', EXT_DIR, '| Chrome', await browser.version());
  const throttle = THROTTLE_MB > 0 ? startPressureThrottle({ thresholdMB: THROTTLE_MB, log }) : null;
  if (throttle) log(`메모리 압력 스로틀: 컨테이너 ${THROTTLE_MB} MB 초과 시 확장 렌더러 일시정지`);

  // 메모리 가드
  let aborted = null;
  const guard = setInterval(() => {
    const mb = cgroup().current;
    if (mb > MEM_LIMIT_MB && !aborted) {
      aborted = `컨테이너 메모리 ${mb} MB > ${MEM_LIMIT_MB} MB → 중단`;
      log('⚠', aborted);
      browser.process()?.kill('SIGKILL');
    }
  }, 500);

  try {
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 30_000 });
    const id = new URL(sw.url()).host;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${id}/offscreen.html`, { waitUntil: 'load' });

    for (const format of FORMATS) {
      log(`===== ${format.toUpperCase()} | mode=${MODE} | ${MINUTES}분 | ${MODE === 'bytes' ? MBPS + ' Mbps' : '작은 페이로드'} =====`);
      // 1) 녹화 중 단계 흉내 (사용자가 기다리는 시간이 아님): 시간 순서대로 영상/오디오 append
      const tSetup = Date.now();
      const setup = await page.evaluate(async ({ id, format, mode, minutes, mbps }) => {
        const base = `chrome-extension://${id}`;
        const { createRecordingStorage } = await import(`${base}/storage/chunk-store.js`);
        let SampleIndex = null;
        try { ({ SampleIndex } = await import(`${base}/storage/sample-index.js`)); } catch { /* 이전 버전: 샘플 객체 배열 */ }

        const fps = 30, gop = 60, sampleRate = 48000, mp3Frame = 1152;
        const videoCount = Math.round(minutes * 60 * fps);
        const audioCount = Math.round(minutes * 60 * sampleRate / mp3Frame);
        // 크기 분포: bytes 모드는 목표 비트레이트(키프레임 = P프레임 4배), count 모드는 작은 고정 크기
        const avg = mode === 'bytes' ? Math.round(mbps * 1e6 / 8 / fps) : 64;
        const pSize = mode === 'bytes' ? Math.round(avg * gop / (gop + 3)) : 64;
        const kSize = mode === 'bytes' ? pSize * 4 : 64;
        const aSize = mode === 'bytes' ? 418 : 32;
        const makeNal = (size) => { const b = new Uint8Array(size); new DataView(b.buffer).setUint32(0, size - 4); b[4] = 0x41; return b; };
        const kBuf = makeNal(kSize), pBuf = makeNal(pSize);
        const aBuf = new Uint8Array(aSize); aBuf[0] = 0xFF; aBuf[1] = 0xFB;

        const storage = await createRecordingStorage(navigator.storage, `bench-${format}-${Date.now()}`);
        const vStore = await storage.createChunkStore('video.bin');
        const aStore = await storage.createChunkStore('audio.bin');
        const append = (store, buf) => (typeof store.appendBytes === 'function' ? store.appendBytes(buf) : store.append(buf).offset);

        const t0 = performance.now();
        const vIndex = SampleIndex ? new SampleIndex({ kind: 'video' }) : null;
        const aIndex = SampleIndex ? new SampleIndex({ kind: 'audio' }) : null;
        const vSamples = [], aFrames = [];
        let ai = 0;
        const pushAudio = () => {
          if (aIndex) aIndex.pushFrame(append(aStore, aBuf), aSize, mp3Frame);
          else aFrames.push({ ref: aStore.append(aBuf), samples: mp3Frame });
          ai++;
        };
        for (let vi = 0; vi < videoCount; vi++) {
          const key = vi % gop === 0;
          const buf = key ? kBuf : pBuf;
          const ts = Math.round(vi * 1e6 / fps);
          if (vIndex) vIndex.push(append(vStore, buf), buf.length, ts, key, 1);
          else vSamples.push({ ref: vStore.append(buf), nalCount: 1, timestamp: ts, keyframe: key });
          const tUs = (vi + 1) * 1e6 / fps;
          while (ai < audioCount && ai * mp3Frame * 1e6 / sampleRate < tUs) pushAudio();
          // 실제 녹화는 실시간으로 들어오므로 디스크 쓰기가 밀리지 않음 → 합성 입력도 쓰기 완료를 기다려 적체를 막음
          if (vi % 600 === 0) { await vStore.flush(); await aStore.flush(); }
        }
        while (ai < audioCount) pushAudio();
        await vStore.flush(); await aStore.flush();
        window.__bench = {
          storage, vStore, aStore,
          video: vIndex ? { width: 1920, height: 1080, avcC: new Uint8Array([1, 0x42, 0x00, 0x2A, 0xFF, 0xE1, 0, 4, 0x67, 0x42, 0x00, 0x2A, 1, 0, 2, 0x68, 0xCE]), index: vIndex, store: vStore }
            : { width: 1920, height: 1080, avcC: new Uint8Array([1, 0x42, 0x00, 0x2A, 0xFF, 0xE1, 0, 4, 0x67, 0x42, 0x00, 0x2A, 1, 0, 2, 0x68, 0xCE]), samples: vSamples, store: vStore },
          audio: aIndex ? { codec: 'mp3', sampleRate, channels: 2, bitrate: 128000, index: aIndex, store: aStore }
            : { codec: 'mp3', sampleRate, channels: 2, bitrate: 128000, frames: aFrames, store: aStore }
        };
        return { metadata: vIndex ? 'SampleIndex' : 'objects', videoCount, audioCount, tAppendS: +((performance.now() - t0) / 1000).toFixed(2), jsHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576) };
      }, { id, format, mode: MODE, minutes: MINUTES, mbps: MBPS });
      log('준비:', JSON.stringify(setup), throttle ? `| 스로틀 ${JSON.stringify(throttle.summary(tSetup))}` : '');
      evictCache(WORK_DIR);
      await new Promise(r => setTimeout(r, 1000));

      // ===== 여기부터 사용자가 "중지" 후 기다리는 시간: finalize + 머싱 (메모리 표본) =====
      const tMuxStart = Date.now();
      const mux = await sampleDuring(browserPid, () => page.evaluate(async ({ id, format }) => {
        const base = `chrome-extension://${id}`;
        const { writeMp4 } = await import(`${base}/muxers/mp4-muxer.js`);
        const { writeAvi } = await import(`${base}/muxers/avi-muxer.js`);
        const b = window.__bench;
        const heap0 = performance.memory.usedJSHeapSize;
        const s0 = performance.now();
        await b.vStore.finalize();
        await b.aStore.finalize();
        const tFinalize = performance.now() - s0;
        const mime = { mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo' }[format];
        const sink = await b.storage.createFileSink(`out.${format}`, mime);
        let writeCalls = 0, readCalls = 0;
        const origWrite = sink.write.bind(sink);
        sink.write = (d) => { writeCalls++; return origWrite(d); };
        for (const st of [b.vStore, b.aStore]) {
          const origRead = st.readRange.bind(st);
          st.readRange = (o, s) => { readCalls++; return origRead(o, s); };
          if (typeof st.readInto === 'function') { const origInto = st.readInto.bind(st); st.readInto = (o, s, buf) => { readCalls++; return origInto(o, s, buf); }; }
        }
        const m0 = performance.now();
        const result = format === 'avi'
          ? await writeAvi({ video: b.video, audio: b.audio, frameRate: 30, output: sink })
          : await writeMp4({ container: format, video: b.video, audio: b.audio, output: sink });
        const tMux = performance.now() - m0;
        b.blob = result.blob;
        return {
          dataMB: +((b.vStore.size + b.aStore.size) / 1048576).toFixed(1), fileMB: +(result.blob.size / 1048576).toFixed(1),
          writeCalls, readCalls, readMode: b.vStore.readMode || 'readRange', muxTimings: result.timings || null,
          tFinalizeS: +(tFinalize / 1000).toFixed(2), tMuxS: +(tMux / 1000).toFixed(2),
          jsHeapBeforeMB: Math.round(heap0 / 1048576), jsHeapAfterMB: Math.round(performance.memory.usedJSHeapSize / 1048576)
        };
      }, { id, format }));
      const d = (k) => mux.peak[k] - mux.start[k];
      log('머싱:', JSON.stringify(mux.result), `| 벽시계 ${((Date.now() - tMuxStart) / 1000).toFixed(1)}초`, throttle ? `| 스로틀 ${JSON.stringify(throttle.summary(tMuxStart))}` : '');
      log(`  머싱 중 메모리 피크 (시작 → 피크, MB): 렌더러 ${mux.start.rendererMax} → ${mux.peak.rendererMax} (+${d('rendererMax')}), 브라우저 ${mux.start.browser} → ${mux.peak.browser} (+${d('browser')}), Chrome 합계 ${mux.start.total} → ${mux.peak.total} (+${d('total')}), 컨테이너 anon ${mux.start.cg.anon} → ${mux.peak.cg.anon} (+${mux.peak.cg.anon - mux.start.cg.anon}), file ${mux.start.cg.file} → ${mux.peak.cg.file}, current 피크 ${mux.peak.cg.current}`);
      log(`  머싱 직후: 렌더러 ${mux.end.rendererMax} MB, 브라우저 ${mux.end.browser} MB, anon ${mux.end.anon} MB (표본 ${mux.series.length}개, ${SAMPLE_MS} ms 간격)`);
      // 프로세스 종류별 RSS와 렌더러별 anon(RssAnon)·shmem(RssShmem): 변한 항목과 큰 항목만
      const types = Object.keys(mux.peak).filter(k => k.startsWith('type:') && (!k.includes('#') || mux.peak[k] !== (mux.start[k] || 0) || mux.peak[k] >= 50));
      log(`  프로세스 종류별 RSS 시작 → 피크 (MB): ${types.map(k => `${k.slice(5)} ${mux.start[k] || 0} → ${mux.peak[k]}`).join(', ')}`);

      // 3) chrome.downloads 저장 (확장과 동일 방식: blob URL)
      if (DOWNLOAD) {
        const dl = await page.evaluate(async () => {
          const b = window.__bench;
          const d0 = performance.now();
          const url = URL.createObjectURL(b.blob);
          const downloadId = await chrome.downloads.download({ url, filename: 'bench.bin', saveAs: false, conflictAction: 'uniquify' });
          const state = await new Promise((resolve) => {
            const check = async () => {
              const [item] = await chrome.downloads.search({ id: downloadId });
              if (item && (item.state === 'complete' || item.state === 'interrupted')) resolve(item.state);
              else setTimeout(check, 100);
            };
            check();
          });
          URL.revokeObjectURL(url);
          return { downloadState: state, tDownloadS: +((performance.now() - d0) / 1000).toFixed(2) };
        });
        log('다운로드:', JSON.stringify(dl), `| 중지 → 저장 합계 ${(mux.result.tFinalizeS + mux.result.tMuxS + dl.tDownloadS).toFixed(2)}초`);
      }
      await page.evaluate(async () => {
        const b = window.__bench;
        await b.vStore.dispose(); await b.aStore.dispose(); await b.storage.dispose();
        window.__bench = null;
      });
      log(`메모리: 컨테이너 ${cgroup().current} MB`);
      for (const f of readdirSync(downloads)) rmSync(join(downloads, f), { force: true });
      evictCache(WORK_DIR);
      log(`정리 후 메모리 ${cgroup().current} MB`);
    }
  } finally {
    clearInterval(guard);
    if (throttle) throttle.stop();
    try { await browser.close(); } catch { /* 이미 종료 */ }
    rmSync(WORK_DIR, { recursive: true, force: true });
    if (aborted) { console.error(aborted); process.exitCode = 2; }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
