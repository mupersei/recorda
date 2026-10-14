// recorda E2E - 헤드리스 Chrome(Puppeteer)에 실제 확장을 로드해 녹음/녹화 전체 흐름을 검증하고
// 녹화 중 CPU/메모리 사용량을 측정합니다.
//
// 자동화 불가 항목: chrome.tabCapture.getMediaStreamId는 사용자의 확장 아이콘 클릭이 있어야 동작하므로
// Service Worker 안에서 getMediaStreamId / offscreen API를 스텁하고, offscreen.html을 탭으로 열어
// getUserMedia만 캔버스(영상) + 오실레이터(오디오) 스트림으로 대체합니다.
// 그 외 popup → background → offscreen → chrome.downloads → 파일까지는 모두 실제 코드입니다.
//
// 사용법: cd e2e && node run.mjs [--duration=10] [--only=mp4,avi] [--long=60]
import puppeteer from 'puppeteer';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '..');
const OUT_DIR = process.env.RECORDA_E2E_OUT || join(__dirname, 'output');
// 환경 설정 (모두 선택 사항)
//  CHROME_LIB_DIR : Chrome 실행에 필요한 공유 라이브러리를 별도 디렉토리에 추출해 둔 경우 그 루트 (usr/lib/x86_64-linux-gnu 포함)
//  RECORDA_FFPROBE / RECORDA_FFMPEG : PATH에 없을 때 ffprobe / ffmpeg 실행 파일 경로
const LIB_DIR = process.env.CHROME_LIB_DIR || '';
const FFPROBE = process.env.RECORDA_FFPROBE || 'ffprobe';
const FFMPEG = process.env.RECORDA_FFMPEG || 'ffmpeg';
//  CHROME_USER_DATA_DIR : Chrome 프로필 위치 (OPFS 녹화 임시 파일이 여기에 쌓이므로 용량이 넉넉한 디스크로)
//  RECORDA_MEM_LIMIT_MB : 컨테이너(cgroup) 메모리 사용량이 이 값을 넘으면 녹화를 중단해 재기동을 피함 (기본 3072)
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || '';
const MEM_LIMIT_MB = Number(process.env.RECORDA_MEM_LIMIT_MB || 3072);

// cgroup v2 메모리 사용량 (anon = 실제 프로세스 메모리, file = 페이지 캐시)
function cgroupMemory() {
  try {
    const current = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8')) / 1048576;
    const stat = readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
    const pick = (k) => Number((stat.match(new RegExp(`^${k} (\\d+)`, 'm')) || [0, 0])[1]) / 1048576;
    return { currentMB: Math.round(current), anonMB: Math.round(pick('anon')), fileMB: Math.round(pick('file')) };
  } catch { return null; }
}

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const DURATION = Number(args.duration || 10);
const LONG_DURATION = Number(args.long || 0);
const ONLY = args.only ? String(args.only).split(',') : null;

// ---- 테스트 매트릭스 ----
const SCENARIOS = [
  { id: 'audio-mp3', mode: 'AUDIO_ONLY', audio: 'mp3', video: 'mp4', expect: ['mp3'] },
  { id: 'audio-wav', mode: 'AUDIO_ONLY', audio: 'wav', video: 'mp4', expect: ['wav'] },
  { id: 'video-mp4', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'mp4', expect: ['mp4'] },
  { id: 'video-mov', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'mov', expect: ['mov'] },
  { id: 'video-avi', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'avi', expect: ['avi'] },
  { id: 'split-mp4-mp3', mode: 'VIDEO_AUDIO_SPLIT', audio: 'mp3', video: 'mp4', expect: ['mp4', 'mp3'] },
  { id: 'split-mp4-wav', mode: 'VIDEO_AUDIO_SPLIT', audio: 'wav', video: 'mp4', expect: ['mp4', 'wav'] },
  { id: 'split-mov-mp3', mode: 'VIDEO_AUDIO_SPLIT', audio: 'mp3', video: 'mov', expect: ['mov', 'mp3'] },
  { id: 'split-mov-wav', mode: 'VIDEO_AUDIO_SPLIT', audio: 'wav', video: 'mov', expect: ['mov', 'wav'] },
  { id: 'split-avi-mp3', mode: 'VIDEO_AUDIO_SPLIT', audio: 'mp3', video: 'avi', expect: ['avi', 'mp3'] },
  { id: 'split-avi-wav', mode: 'VIDEO_AUDIO_SPLIT', audio: 'wav', video: 'avi', expect: ['avi', 'wav'] },
  // 녹화 중 탭 크기 변경(같은 비율): 인코더 스케일링으로 처리, 파일 해상도 유지, 캔버스 정규화 없음
  { id: 'resize-mp4', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'mp4', expect: ['mp4'], resizeAt: 4, resizeTo: [960, 540], expectNormalized: false },
  // 녹화 중 비율 변경(16:9 → 4:3): 캔버스 레터박스 정규화 경로. 마지막 프레임을 PNG로 추출해 확인
  { id: 'resize-aspect-mp4', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'mp4', expect: ['mp4'], resizeAt: 4, resizeTo: [960, 720], expectNormalized: true, extractFrame: true }
].filter(s => !ONLY || ONLY.includes(s.id));

if (LONG_DURATION > 0) {
  SCENARIOS.push({ id: `long-mp4-1080p-${LONG_DURATION}s`, mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'mp4', expect: ['mp4'], duration: LONG_DURATION, width: 1920, height: 1080 });
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 가짜 getUserMedia (offscreen 페이지에 주입) ----
function fakeMediaScript(width, height, resize = null) {
  return `
    (() => {
      const W = ${width}, H = ${height};
      const RESIZE = ${JSON.stringify(resize)};
      window.__e2e = { frames: 0 };
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        window.__e2e.constraints = JSON.parse(JSON.stringify(constraints));
        const stream = new MediaStream();
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume();
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 440;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 2;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 200;
        lfo.connect(lfoGain).connect(osc.frequency);
        const gain = ctx.createGain();
        gain.gain.value = 0.5;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain).connect(dest);
        osc.start(); lfo.start();
        stream.addTrack(dest.stream.getAudioTracks()[0]);
        window.__e2e.audioCtx = ctx;

        if (constraints.video) {
          const canvas = document.createElement('canvas');
          canvas.width = W; canvas.height = H;
          document.body.appendChild(canvas);
          const g = canvas.getContext('2d');
          const start = performance.now();
          let resized = false;
          const draw = () => {
            const t = (performance.now() - start) / 1000;
            if (RESIZE && !resized && t >= RESIZE.at) {
              canvas.width = RESIZE.to[0]; canvas.height = RESIZE.to[1];
              resized = true;
              window.__e2e.resizedAtFrame = window.__e2e.frames;
            }
            const W = canvas.width, H = canvas.height;
            g.fillStyle = 'hsl(' + ((t * 40) % 360) + ',60%,25%)';
            g.fillRect(0, 0, W, H);
            for (let i = 0; i < 6; i++) {
              g.fillStyle = 'hsl(' + ((i * 60 + t * 90) % 360) + ',90%,60%)';
              const x = (W / 2) + Math.cos(t * 2 + i) * W * 0.35 - 40;
              const y = (H / 2) + Math.sin(t * 3 + i) * H * 0.35 - 40;
              g.fillRect(x, y, 80, 80);
            }
            g.fillStyle = '#fff';
            g.font = Math.round(H / 10) + 'px monospace';
            g.fillText('frame ' + window.__e2e.frames + '  t=' + t.toFixed(2) + 's', 20, Math.round(H / 8));
            window.__e2e.frames++;
          };
          draw();
          window.__e2e.timer = setInterval(draw, 1000 / 30);
          const vs = canvas.captureStream(30);
          stream.addTrack(vs.getVideoTracks()[0]);
        }
        return stream;
      };
    })();
  `;
}

// ---- 리소스 측정 (/proc 기반, Chrome 프로세스 트리 전체) ----
const CLK_TCK = 100;
function procTree(rootPid) {
  const procs = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      const ppid = Number(fields[1]);
      const utime = Number(fields[11]), stime = Number(fields[12]);
      let rss = Number(fields[21]) * 4096;
      // PSS(비례 배분된 공유 메모리)로 중복 계산 방지. 없으면 RSS 사용
      try {
        const roll = readFileSync(`/proc/${d}/smaps_rollup`, 'utf8');
        const m = roll.match(/^Pss:\s+(\d+) kB/m);
        if (m) rss = Number(m[1]) * 1024;
      } catch {}
      let cmd = '';
      try { cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch {}
      procs.set(Number(d), { pid: Number(d), ppid, cpuTicks: utime + stime, rss, cmd });
    } catch { /* 종료된 프로세스 */ }
  }
  const members = [];
  const walk = (pid) => {
    const p = procs.get(pid);
    if (!p) return;
    members.push(p);
    for (const q of procs.values()) if (q.ppid === pid) walk(q.pid);
  };
  walk(rootPid);
  return members;
}
function procType(cmd) {
  const m = cmd.match(/--type=([a-z-]+)/);
  if (!m) return 'browser';
  if (m[1] === 'utility') {
    const s = cmd.match(/--utility-sub-type=([A-Za-z.]+)/);
    return 'utility' + (s ? ':' + s[1].split('.').pop() : '');
  }
  return m[1];
}
class ResourceSampler {
  constructor(rootPid, heapProbe = null) { this.rootPid = rootPid; this.samples = []; this.prev = null; this.timer = null; this.heapProbe = heapProbe; }
  sample() {
    const now = Date.now();
    const members = procTree(this.rootPid);
    const byType = {};
    let totalRss = 0, totalTicks = 0, maxRendererRss = 0;
    for (const p of members) {
      const t = procType(p.cmd);
      byType[t] = byType[t] || { rss: 0, ticks: 0, count: 0 };
      byType[t].rss += p.rss; byType[t].ticks += p.cpuTicks; byType[t].count++;
      totalRss += p.rss; totalTicks += p.cpuTicks;
      if (t === 'renderer') maxRendererRss = Math.max(maxRendererRss, p.rss);
    }
    const s = { t: now, totalRss, totalTicks, byType, maxRendererRss, procCount: members.length, cpuPct: 0, cpuPctByType: {}, jsHeapMB: null };
    if (this.heapProbe) this.heapProbe().then(v => { s.jsHeapMB = v; }).catch(() => {});
    if (this.prev) {
      const dt = (now - this.prev.t) / 1000;
      s.cpuPct = ((totalTicks - this.prev.totalTicks) / CLK_TCK) / dt * 100;
      for (const [k, v] of Object.entries(byType)) {
        const pv = this.prev.byType[k];
        s.cpuPctByType[k] = pv ? ((v.ticks - pv.ticks) / CLK_TCK) / dt * 100 : 0;
      }
    }
    this.prev = s;
    this.samples.push(s);
    return s;
  }
  start(intervalMs = 1000) { this.sample(); this.timer = setInterval(() => this.sample(), intervalMs); }
  stop() { clearInterval(this.timer); this.sample(); return this.samples; }
}
function summarize(samples, baseline) {
  const rss = samples.map(s => s.totalRss);
  const cpu = samples.slice(1).map(s => s.cpuPct);
  const peakIdx = rss.indexOf(Math.max(...rss));
  const peak = samples[peakIdx];
  const types = Object.keys(peak.byType).sort((a, b) => peak.byType[b].rss - peak.byType[a].rss);
  const heaps = samples.map(s => s.jsHeapMB).filter(v => typeof v === 'number');
  const step = Math.max(1, Math.floor(samples.length / 200)); // 최대 200점
  const series = samples.filter((_, i) => i % step === 0 || i === samples.length - 1).map(s => ({
    t: Math.round((s.t - samples[0].t) / 1000), pssMB: Math.round(s.totalRss / 1048576), rendererMB: Math.round(s.maxRendererRss / 1048576), cpuPct: Math.round(s.cpuPct), jsHeapMB: s.jsHeapMB === null ? null : Math.round(s.jsHeapMB)
  }));
  return {
    series,
    samples: samples.length,
    memoryMetric: 'PSS',
    baselinePssMB: +(baseline.totalRss / 1048576).toFixed(1),
    peakPssMB: +(Math.max(...rss) / 1048576).toFixed(1),
    peakPssDeltaMB: +((Math.max(...rss) - baseline.totalRss) / 1048576).toFixed(1),
    peakRendererPssMB: +(Math.max(...samples.map(s => s.maxRendererRss)) / 1048576).toFixed(1),
    baselineRendererPssMB: +(baseline.maxRendererRss / 1048576).toFixed(1),
    offscreenJsHeapStartMB: heaps.length ? +heaps[0].toFixed(1) : null,
    offscreenJsHeapPeakMB: heaps.length ? +Math.max(...heaps).toFixed(1) : null,
    offscreenJsHeapEndMB: heaps.length ? +heaps[heaps.length - 1].toFixed(1) : null,
    avgCpuPct: cpu.length ? +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1) : 0,
    peakCpuPct: cpu.length ? +Math.max(...cpu).toFixed(1) : 0,
    peakByProcessMB: Object.fromEntries(types.slice(0, 5).map(t => [t, +(peak.byType[t].rss / 1048576).toFixed(1)])),
    avgCpuByProcessPct: Object.fromEntries(types.slice(0, 5).map(t => {
      const vals = samples.slice(1).map(s => s.cpuPctByType[t] || 0);
      return [t, +(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)).toFixed(1)];
    }))
  };
}

// ---- ffprobe / ffmpeg ----
function probe(path) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', path], { encoding: 'utf8' });
  return JSON.parse(out);
}
// null 머서는 영상 타임베이스가 1/fps라 한 프레임 간격보다 촘촘한 프레임을 '비단조 dts'로 경고함 → 실제 디코딩 오류와 분리
const DTS_WARNING = /non monotonically increasing dts to muxer/;
function decodeErrors(path) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  const lines = (r.stderr || '').trim().split('\n').filter(Boolean);
  return {
    errors: lines.filter(l => !DTS_WARNING.test(l)).join('\n'),
    bunchedFrameWarnings: lines.filter(l => DTS_WARNING.test(l)).length
  };
}
// 오디오 패킷 타임라인 검사: 컨테이너 헤더(예: AVI nBlockAlign)가 잘못되면 DTS는 단조 증가하지만 스케일이 틀어짐
function audioTimeline(path) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=dts_time,pts_time', '-of', 'csv=p=0', path], { encoding: 'utf8' });
    const rows = out.trim().split('\n').filter(Boolean).map(l => l.split(',').map(Number));
    const times = rows.map(r => (isNaN(r[0]) ? r[1] : r[0])).filter(n => !isNaN(n));
    if (!times.length) return null;
    return { packets: times.length, firstSec: +times[0].toFixed(3), lastSec: +times[times.length - 1].toFixed(3) };
  } catch { return null; }
}
// 영상 프레임 타이밍 통계 (DTS 간격)
function frameTiming(path) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pkt_dts_time', '-of', 'csv=p=0', path], { encoding: 'utf8' });
    const ts = out.trim().split('\n').map(Number).filter(n => !isNaN(n));
    const deltas = ts.slice(1).map((t, i) => (t - ts[i]) * 1000).sort((a, b) => a - b);
    if (!deltas.length) return null;
    const pct = (p) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))];
    return {
      frames: ts.length,
      minDeltaMs: +deltas[0].toFixed(1), p50DeltaMs: +pct(0.5).toFixed(1), p95DeltaMs: +pct(0.95).toFixed(1), maxDeltaMs: +deltas[deltas.length - 1].toFixed(1),
      nonIncreasing: deltas.filter(d => d <= 0).length,
      under10ms: deltas.filter(d => d < 10).length
    };
  } catch { return null; }
}

// ---- 메인 ----
async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null' };
  if (LIB_DIR) {
    env.LD_LIBRARY_PATH = `${LIB_DIR}/usr/lib/x86_64-linux-gnu:${LIB_DIR}/lib/x86_64-linux-gnu:${process.env.LD_LIBRARY_PATH || ''}`;
  }

  const browser = await puppeteer.launch({
    headless: true,
    env,
    protocolTimeout: 300_000,
    userDataDir: USER_DATA_DIR || undefined,
    args: [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--disable-features=DialMediaRouteProvider',
      '--window-size=1400,900'
    ]
  });
  const browserPid = browser.process().pid;
  log('Chrome 실행, pid', browserPid, await browser.version());

  // 다운로드 디렉토리 설정 (chrome.downloads 포함 모든 다운로드)
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT_DIR, eventsEnabled: true });
  // 헤드리스에서는 저장 파일명이 GUID로 바뀌므로, SW가 기록한 요청 파일명으로 완료 후 복원
  const renamed = new Set();
  async function collectDownloads(worker) {
    const items = await worker.evaluate(async () => {
      const out = [];
      for (const d of self.__e2eDownloads) {
        const [item] = await chrome.downloads.search({ id: d.id });
        out.push({ id: d.id, requested: d.requested, state: item ? item.state : 'missing', path: item ? item.filename : null, error: item ? item.error : null });
      }
      return out;
    });
    for (const it of items) {
      if (it.state === 'complete' && it.path && !renamed.has(it.id) && existsSync(it.path)) {
        let target = join(OUT_DIR, it.requested);
        let n = 1;
        while (existsSync(target)) target = join(OUT_DIR, it.requested.replace(/(\.[a-z0-9]+)$/, ` (${n++})$1`));
        execFileSync('mv', [it.path, target]);
        renamed.add(it.id);
        it.finalPath = target;
      }
    }
    return items;
  }

  // 확장 Service Worker 찾기
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 30_000 });
  const extensionId = new URL(swTarget.url()).host;
  const worker = await swTarget.worker();
  log('확장 ID', extensionId);

  const swLogs = [];
  worker.on('console', m => {
    Promise.all(m.args().map(a => a.jsonValue().catch(() => '?')))
      .then(vals => swLogs.push(`${new Date().toISOString().slice(11, 23)} [SW] ` + vals.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' ')))
      .catch(() => swLogs.push(`[SW] ${m.text()}`));
  });
  const popLogs = [];

  // SW 시작 직후에는 chrome.* 바인딩이 아직 없을 수 있어 준비될 때까지 대기
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = await worker.evaluate(() => {
      try { return typeof chrome === 'object' && typeof chrome.runtime === 'object' && typeof chrome.tabCapture === 'object' && typeof chrome.offscreen === 'object'; } catch { return false; }
    }).catch(() => false);
    if (ready) break;
    await sleep(200);
  }

  // tabCapture / offscreen API 스텁 (사용자 클릭이 필요한 부분만)
  const stubResult = await worker.evaluate(() => {
    const define = (obj, key, value) => {
      try { obj[key] = value; } catch { /* fallthrough */ }
      if (obj[key] !== value) Object.defineProperty(obj, key, { value, configurable: true, writable: true });
      return obj[key] === value;
    };
    const r = {};
    r.getMediaStreamId = define(chrome.tabCapture, 'getMediaStreamId', async ({ targetTabId }) => `e2e-stream-${targetTabId}`);
    r.createDocument = define(chrome.offscreen, 'createDocument', async () => {});
    r.closeDocument = define(chrome.offscreen, 'closeDocument', async () => {});
    r.getContexts = define(chrome.runtime, 'getContexts', async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    // 다운로드는 실제 API를 그대로 쓰되, 확장이 요청한 파일명과 ID를 기록 (헤드리스는 GUID로 저장하므로 복원용)
    self.__e2eDownloads = [];
    const origDownload = chrome.downloads.download.bind(chrome.downloads);
    r.downloadWrap = define(chrome.downloads, 'download', async (opts) => {
      const id = await origDownload(opts);
      self.__e2eDownloads.push({ id, requested: opts.filename });
      return id;
    });
    return r;
  });
  log('SW 스텁:', JSON.stringify(stubResult));
  if (!Object.values(stubResult).every(Boolean)) throw new Error('Service Worker API 스텁 실패');

  // Service Worker가 유휴 종료되지 않도록 주기적으로 ping
  const keepAlive = setInterval(() => worker.evaluate(() => 1).catch(() => {}), 10_000);

  const report = { chrome: await browser.version(), startedAt: new Date().toISOString(), scenarios: [] };
  const sampler = new ResourceSampler(browserPid);

  // 유휴 기준값: 페이지만 열어둔 상태
  const offPage = await browser.newPage();
  const popPage = await browser.newPage();
  await sleep(1500);
  const baseline = sampler.sample();
  log(`유휴 PSS ${(baseline.totalRss / 1048576).toFixed(0)} MB, 프로세스 ${baseline.procCount}개`);

  for (const sc of SCENARIOS) {
    const duration = sc.duration || DURATION;
    const width = Number(args.width) || sc.width || 1280, height = Number(args.height) || sc.height || 720;
    log(`===== ${sc.id} (${sc.mode}, audio=${sc.audio}, video=${sc.video}, ${width}x${height}, ${duration}s) =====`);
    const result = { id: sc.id, mode: sc.mode, audioFormat: sc.audio, videoFormat: sc.video, width, height, durationSec: duration, ok: false, checks: [], files: [] };
    const before = new Set(readdirSync(OUT_DIR));
    const offLogs = [];
    const downloadsBefore = (await collectDownloads(worker)).length;
    let swLogStart = swLogs.length;
    let popLogStart = popLogs.length;

    try {
      // offscreen 페이지 (가짜 getUserMedia 주입 후 로드)
      await offPage.removeAllListeners('console');
      offPage.on('console', m => {
        Promise.all(m.args().map(a => a.jsonValue().catch(() => '?')))
          .then(vals => offLogs.push(vals.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' ')))
          .catch(() => offLogs.push(m.text()));
      });
      offPage.on('pageerror', e => offLogs.push('PAGEERROR ' + e.message));
      await offPage.evaluateOnNewDocument(fakeMediaScript(width, height, sc.resizeAt ? { at: sc.resizeAt, to: sc.resizeTo } : null));
      await offPage.goto(`chrome-extension://${extensionId}/offscreen.html`, { waitUntil: 'load' });

      // popup 페이지
      popPage.removeAllListeners('console');
      popPage.on('console', m => {
        Promise.all(m.args().map(a => a.jsonValue().catch(() => '?')))
          .then(vals => popLogs.push(`${new Date().toISOString().slice(11, 23)} [POPUP] ` + vals.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' ')))
          .catch(() => popLogs.push(`[POPUP] ${m.text()}`));
      });
      swLogStart = swLogs.length;
      popLogStart = popLogs.length;
      await popPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
      await popPage.waitForSelector('#mainContainer.loaded', { timeout: 10_000 });
      await popPage.select('#modeSelect', sc.mode);
      await popPage.select('#formatSelect', sc.audio);
      await popPage.select('#videoFormatSelect', sc.video);
      await sleep(300); // 설정 저장 대기

      const videoGroupHidden = await popPage.$eval('#videoFormatGroup', el => el.classList.contains('hidden'));
      result.checks.push({ name: 'popup: 영상 포맷 선택 표시 여부가 모드와 일치', pass: videoGroupHidden === (sc.mode === 'AUDIO_ONLY') });

      // 녹화 시작
      const sampler2 = new ResourceSampler(browserPid, () => offPage.metrics().then(m => m.JSHeapUsedSize / 1048576));
      sampler2.start(1000);
      const t0 = Date.now();
      await popPage.click('#recordButton');
      await popPage.waitForFunction(() => /녹화 중|녹음 중/.test(document.querySelector('#status').textContent), { timeout: 20_000 });
      const startLatencyMs = Date.now() - t0;
      const statusText = await popPage.$eval('#status', el => el.textContent);
      result.checks.push({ name: `popup: 시작 후 상태 "${statusText.trim()}" (${startLatencyMs}ms)`, pass: true });

      // 캡처 제약 확인
      await sleep(500);
      const constraints = await offPage.evaluate(() => window.__e2e.constraints);
      result.checks.push({ name: 'getUserMedia: video 제약 요청 여부가 모드와 일치', pass: !!constraints.video === (sc.mode !== 'AUDIO_ONLY'), detail: JSON.stringify(constraints.video || false) });

      let aborted = null;
      for (let waited = 0; waited < duration && !aborted; waited += 10) {
        await sleep(Math.min(10, duration - waited) * 1000);
        const cg = cgroupMemory();
        if (cg && cg.currentMB > MEM_LIMIT_MB) {
          aborted = `컨테이너 메모리 ${cg.currentMB} MB > 한계 ${MEM_LIMIT_MB} MB (anon ${cg.anonMB}, file ${cg.fileMB}) → 녹화 조기 중단`;
          log('  ⚠ ' + aborted);
        }
        const last = sampler2.samples[sampler2.samples.length - 1];
        if (duration >= 300 && last && (waited + 10) % 60 === 0) log(`  진행 ${Math.min(waited + 10, duration)}s: PSS ${Math.round(last.totalRss / 1048576)} MB, 렌더러 ${Math.round(last.maxRendererRss / 1048576)} MB, JS힙 ${last.jsHeapMB === null ? '?' : Math.round(last.jsHeapMB)} MB, CPU ${Math.round(last.cpuPct)}%${cg ? `, 컨테이너 ${cg.currentMB} MB (anon ${cg.anonMB})` : ''}`);
      }
      result.abortedEarly = aborted;
      if (aborted) result.checks.push({ name: aborted, pass: false });
      const elapsedText = await popPage.$eval('#timeDisplay', el => el.textContent);
      result.checks.push({ name: `popup: 경과 시간 표시 ${elapsedText}`, pass: elapsedText !== '00:00' });

      // 실제 Chrome의 storage.session에 녹화 상태가 영속화되는지 (SW 재시작 복구의 전제)
      const session = await worker.evaluate(() => chrome.storage.session.get('recordingState').then(r => r.recordingState)).catch(e => ({ error: e.message }));
      result.checks.push({ name: `SW storage.session에 RECORDING 상태 저장됨 (${session && session.state})`, pass: !!session && session.state === 'RECORDING' && typeof session.startTime === 'number' });
      const heartbeats = swLogs.filter(l => /RECORDING_HEARTBEAT/.test(l)).length;
      result.swHeartbeatsSeen = heartbeats;
      if (sc.resizeAt) {
        const resizedAtFrame = await offPage.evaluate(() => window.__e2e.resizedAtFrame);
        result.checks.push({ name: `소스 크기 변경 발생 (프레임 #${resizedAtFrame})`, pass: typeof resizedAtFrame === 'number' });
      }

      // 녹화 중지 → 완료 대기
      const tStop = Date.now();
      await popPage.click('#recordButton');
      // 최종 메시지(success/error)까지 대기. 중간의 "저장 중..." info 메시지는 통과하지 않음
      await popPage.waitForFunction(() => {
        const m = document.querySelector('#message');
        if (m.classList.contains('show') && m.classList.contains('info') && /저장 중/.test(m.textContent)) window.__sawSaving = true;
        return m.classList.contains('show') && (m.classList.contains('success') || m.classList.contains('error'));
      }, { timeout: Math.max(180_000, duration * 1000) });
      const sawSaving = await popPage.evaluate(() => !!window.__sawSaving);
      result.sawSavingMessage = sawSaving;
      const stopLatencyMs = Date.now() - tStop;
      const samples = sampler2.stop();
      const message = await popPage.$eval('#message', el => ({ text: el.textContent, cls: el.className }));
      result.popupMessage = message.text;
      result.stopProcessingMs = stopLatencyMs;
      result.checks.push({ name: `popup: 완료 메시지 "${message.text}" (${stopLatencyMs}ms, 저장 중 표시: ${sawSaving ? '있음' : '없음'})`, pass: message.cls.includes('success') });

      // chrome.downloads 완료 대기 후 요청 파일명으로 복원
      const deadline = Date.now() + Math.max(120_000, duration * 500);
      let files = [];
      let downloadItems = [];
      while (Date.now() < deadline) {
        downloadItems = (await collectDownloads(worker)).slice(downloadsBefore);
        if (downloadItems.length >= sc.expect.length && downloadItems.every(d => d.state === 'complete' || d.state === 'interrupted')) break;
        await sleep(500);
      }
      result.downloads = downloadItems.map(d => ({ id: d.id, requested: d.requested, state: d.state, error: d.error }));
      files = readdirSync(OUT_DIR).filter(f => !before.has(f) && !f.endsWith('.crdownload') && !/^[0-9a-f-]{36}$/.test(f));
      result.checks.push({ name: `chrome.downloads 상태: ${downloadItems.map(d => `${d.requested}=${d.state}`).join(', ')}`, pass: downloadItems.length === sc.expect.length && downloadItems.every(d => d.state === 'complete') });
      const exts = files.map(f => f.split('.').pop()).sort();
      result.checks.push({ name: `다운로드 파일 ${files.length}개: ${files.join(', ')}`, pass: JSON.stringify(exts) === JSON.stringify([...sc.expect].sort()) });

      // 파일 검증
      for (const f of files) {
        const path = join(OUT_DIR, f);
        const info = probe(path);
        const v = info.streams.find(s => s.codec_type === 'video');
        const a = info.streams.find(s => s.codec_type === 'audio');
        const decode = decodeErrors(path);
        const errors = decode.errors;
        const timing = v ? frameTiming(path) : null;
        const fileResult = {
          name: f,
          sizeMB: +(statSync(path).size / 1048576).toFixed(2),
          format: info.format.format_name,
          durationSec: +Number(info.format.duration).toFixed(2),
          video: v ? { codec: v.codec_name, w: v.width, h: v.height, frames: Number(v.nb_read_frames), fps: v.r_frame_rate, duration: +Number(v.duration).toFixed(2) } : null,
          audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels, duration: +Number(a.duration).toFixed(2) } : null,
          decodeErrors: errors,
          bunchedFrameWarnings: decode.bunchedFrameWarnings,
          frameTiming: timing
        };
        result.files.push(fileResult);
        const ext = f.split('.').pop();
        const expectVideo = ['mp4', 'mov', 'avi'].includes(ext);
        result.checks.push({ name: `${f}: ffmpeg 전체 디코딩 오류 없음${decode.bunchedFrameWarnings ? ` (한 프레임 간격 미만 프레임 ${decode.bunchedFrameWarnings}건은 경고로만 기록)` : ''}`, pass: errors === '', detail: errors.slice(0, 300) });
        result.checks.push({ name: `${f}: 파일명 규칙 recorda_YYYYMMDD_HHMMSS.${ext}`, pass: /^recorda_\d{8}_\d{6}\.[a-z0-9]+$/.test(f) });
        if (timing) result.checks.push({ name: `${f}: 프레임 DTS 단조 증가 (간격 p50 ${timing.p50DeltaMs}ms, 최소 ${timing.minDeltaMs}ms, 최대 ${timing.maxDeltaMs}ms, 10ms 미만 ${timing.under10ms}건)`, pass: timing.nonIncreasing === 0 });
        result.checks.push({ name: `${f}: 길이 ${fileResult.durationSec}s ≈ 녹화 ${duration}s`, pass: Math.abs(fileResult.durationSec - duration) < 1.5 });
        const aTimeline = a ? audioTimeline(path) : null;
        fileResult.audioTimeline = aTimeline;
        if (aTimeline) {
          result.checks.push({ name: `${f}: 마지막 오디오 패킷 시각 ${aTimeline.lastSec}s ≈ 파일 길이 ${fileResult.durationSec}s (패킷 ${aTimeline.packets}개)`, pass: Math.abs(aTimeline.lastSec - fileResult.durationSec) < 1.0 });
        }
        if (expectVideo) {
          result.checks.push({ name: `${f}: h264 ${v && v.width}x${v && v.height}, ${v && v.nb_read_frames}프레임`, pass: !!v && v.codec_name === 'h264' && v.width === width && v.height === height && Number(v.nb_read_frames) > duration * 10 });
          result.checks.push({ name: `${f}: 오디오 mp3 포함`, pass: !!a && a.codec_name === 'mp3' });
          if (v && a) result.checks.push({ name: `${f}: A/V 길이 차이 ${Math.abs(Number(v.duration) - Number(a.duration)).toFixed(2)}s`, pass: Math.abs(Number(v.duration) - Number(a.duration)) < 0.35 });
        } else {
          const expectCodec = ext === 'wav' ? 'pcm_s16le' : 'mp3';
          result.checks.push({ name: `${f}: 오디오 코덱 ${a && a.codec_name}`, pass: !!a && a.codec_name === expectCodec && !v });
        }
      }

      // 인코딩 통계 (offscreen 콘솔에서)
      const statsLine = offLogs.find(l => l.includes('[VideoRecordingSession] 머싱 완료'));
      if (statsLine) result.encoderStats = statsLine;
      const dropLine = offLogs.find(l => l.includes('[VideoTrackEncoder] 완료'));
      if (dropLine) result.encoderStats = (result.encoderStats || '') + ' | ' + dropLine;
      if (sc.resizeAt) {
        const mN = dropLine && dropLine.match(/"normalized":(\d+)/);
        const mS = dropLine && dropLine.match(/"scaled":(\d+)/);
        const normalized = mN ? Number(mN[1]) : -1;
        const scaled = mS ? Number(mS[1]) : -1;
        if (sc.expectNormalized) {
          result.checks.push({ name: `비율 변경 → 캔버스 레터박스 정규화 사용 (normalized=${normalized}, scaled=${scaled})`, pass: normalized > 0 });
        } else {
          result.checks.push({ name: `같은 비율 → 캔버스 없이 인코더 스케일링 (normalized=${normalized}, scaled=${scaled})`, pass: normalized === 0 && scaled > 0 });
        }
      }
      if (sc.extractFrame && result.files[0]) {
        const src = join(OUT_DIR, result.files[0].name);
        const png = join(OUT_DIR, `${sc.id}-last-frame.png`);
        try {
          execFileSync(FFMPEG, ['-v', 'error', '-y', '-sseof', '-0.5', '-i', src, '-frames:v', '1', png]);
          result.extractedFrame = png;
        } catch (error) { result.extractedFrameError = error.message; }
      }
      const codecLine = offLogs.find(l => l.includes('사용 코덱'));
      if (codecLine) result.codec = codecLine.split(':').pop().trim();
      const fakeFrames = await offPage.evaluate(() => window.__e2e.frames).catch(() => null);
      result.sourceFramesDrawn = fakeFrames;

      result.resources = summarize(samples, baseline);
      result.ok = result.checks.every(c => c.pass);
    } catch (error) {
      result.error = error.message;
      result.ok = false;
      log('오류:', error.message);
    }

    result.offscreenErrors = offLogs.filter(l => /PAGEERROR|실패|Error|에러/.test(l)).slice(0, 10);
    if (!result.ok) {
      // 실패 원인 분석용: 이번 시나리오 동안의 SW / popup / offscreen 로그
      result.debugLogs = {
        sw: swLogs.slice(typeof swLogStart === 'number' ? swLogStart : 0).slice(-80),
        popup: popLogs.slice(typeof popLogStart === 'number' ? popLogStart : 0).slice(-80),
        offscreen: offLogs.slice(-60)
      };
    }
    report.scenarios.push(result);
    for (const c of result.checks) log(`  ${c.pass ? '✔' : '✖'} ${c.name}${c.detail && !c.pass ? ' — ' + c.detail : ''}`);
    if (result.resources) log(`  리소스: 전체 PSS 피크 ${result.resources.peakPssMB} MB (+${result.resources.peakPssDeltaMB} MB), 렌더러 최대 ${result.resources.peakRendererPssMB} MB, offscreen JS 힙 ${result.resources.offscreenJsHeapStartMB}→${result.resources.offscreenJsHeapPeakMB} MB, 평균 CPU ${result.resources.avgCpuPct}%, 피크 CPU ${result.resources.peakCpuPct}%`);
    if (result.encoderStats) log(`  인코더: ${result.encoderStats}`);
    log(`  → ${result.ok ? 'PASS' : 'FAIL'}`);

    // 다음 시나리오를 위해 offscreen 페이지 상태 초기화
    await offPage.evaluate(() => { try { clearInterval(window.__e2e.timer); window.__e2e.audioCtx && window.__e2e.audioCtx.close(); } catch {} }).catch(() => {});
    await sleep(1000);
  }

  clearInterval(keepAlive);
  report.swLogsTail = swLogs.slice(-30);
  report.finishedAt = new Date().toISOString();
  report.passed = report.scenarios.filter(s => s.ok).length;
  report.total = report.scenarios.length;
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  log(`완료: ${report.passed}/${report.total} 시나리오 통과. 리포트: ${join(OUT_DIR, 'report.json')}`);

  await browser.close();
  process.exit(report.passed === report.total ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
