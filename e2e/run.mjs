// recorda E2E - 헤드리스 Chrome(Puppeteer)에 실제 확장을 로드해 녹음/녹화 전체 흐름을 검증하고
// 녹화 중 CPU/메모리 사용량을 측정합니다.
//
// 자동화 불가 항목: chrome.tabCapture.getMediaStreamId는 사용자의 확장 아이콘 클릭이 있어야 동작하므로
// Service Worker 안에서 getMediaStreamId / offscreen API를 스텁하고, offscreen.html을 탭으로 열어
// getUserMedia만 캔버스(영상) + 오실레이터(오디오) 스트림으로 대체합니다.
// 그 외 popup → background → offscreen → chrome.downloads → 파일까지는 모두 실제 코드입니다.
//
// 사용법: cd e2e && node run.mjs [--duration=10] [--only=mp4,avi] [--long=60] [--saveToFolder] [--recordAgain[=10]]
//  --recordAgain[=초]: 폴더 저장 시나리오에서 중지 후 "다시 녹화할 수 있는 상태"(대기 중·버튼 활성·SW IDLE·OPFS 임시 정리)까지의
//                     시간을 잰 뒤, 같은 브라우저에서 짧은 두 번째 녹화(기본 10초)를 실제로 해서 끝까지 저장되는지 확인
//  --saveToFolder: 모든 시나리오를 "사용자 폴더 직접 저장"으로 실행 (폴더 = offscreen 출처의 OPFS 루트. 헤드리스에서는 폴더 선택 창을
//                  띄울 수 없으므로 save-location.js로 OPFS 루트 핸들을 저장 폴더로 등록). folder-* 시나리오는 항상 폴더 저장
//  crash-fmp4: --only로 지정할 때만 실행 (Chrome을 SIGKILL하므로 마지막에 실행되고 이후 시나리오는 건너뜀).
//              fMP4 폴더 녹화 20초 뒤 브라우저 프로세스를 죽이고, 프로필의 File System에 남은 가장 큰 최근 파일(스왑/부분 파일)을 ffprobe로 확인
import puppeteer from 'puppeteer';
import { execFileSync, spawnSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, rmSync, openSync, writeSync, closeSync, readSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPressureThrottle } from './pressure-throttle.mjs';

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
//  RECORDA_EVICT_SCRIPT : 페이지 캐시 해제 스크립트(python). 지정 시 30초마다 프로필·출력 디렉토리의 캐시를 비움 (장시간 녹화용)
const EVICT_SCRIPT = process.env.RECORDA_EVICT_SCRIPT || '';
//  RECORDA_ANON_LIMIT_MB : 프로세스 메모리(anon) 상한. 넘으면 Chrome 강제 종료 (기본 2600)
const ANON_LIMIT_MB = Number(process.env.RECORDA_ANON_LIMIT_MB || 2600);
let evictFast = false; // 중지 이후에는 대량 읽기/쓰기가 일어나므로 캐시를 2초마다 비움
//  RECORDA_THROTTLE_MB : (테스트 환경용) 컨테이너 메모리(페이지 캐시 포함)가 이 값을 넘으면 확장 렌더러를 잠시 멈춤(SIGSTOP)
//                        → writeback이 따라잡으면 재개. 멈춘 시간은 report.json의 throttle*에 따로 기록 (e2e/pressure-throttle.mjs)
const THROTTLE_MB = Number(process.env.RECORDA_THROTTLE_MB || 0);
let throttle = null;

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
const RECORD_AGAIN_SEC = args.recordAgain ? (args.recordAgain === true ? 10 : Number(args.recordAgain)) : 0;
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
  { id: 'resize-aspect-mp4', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'mp4', expect: ['mp4'], resizeAt: 4, resizeTo: [960, 720], expectNormalized: true, extractFrame: true },
  // 일시정지/재개: 8초 녹화 → 4초 일시정지 → 4초 녹화. duration은 일시정지를 뺀 녹화 시간(파일 길이 기대값 12초, 일시정지 포함 시 16초)
  { id: 'pause-mp4', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'mp4', expect: ['mp4'], duration: 12, pause: { at: 8, seconds: 4 } },
  // 사용자 폴더 직접 저장: 결과 파일을 폴더(여기서는 OPFS 루트)에 바로 기록 → chrome.downloads 복사 없음
  { id: 'folder-split-mp4-wav', mode: 'VIDEO_AUDIO_SPLIT', audio: 'wav', video: 'mp4', expect: ['mp4', 'wav'], saveToFolder: true },
  // 조각 MP4(fMP4): 녹화 중 약 2초마다 moof+mdat 조각 기록. 파일 확장자는 .mp4 (expect는 확장자)
  { id: 'video-fmp4', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'fmp4', expect: ['mp4'] },
  { id: 'folder-split-fmp4-wav', mode: 'VIDEO_AUDIO_SPLIT', audio: 'wav', video: 'fmp4', expect: ['mp4', 'wav'], saveToFolder: true },
  // 일시정지/재개 + fMP4: 조각의 tfdt가 일시정지 앞뒤로 끊김 없이 이어지는지
  { id: 'pause-fmp4', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'fmp4', expect: ['mp4'], duration: 12, pause: { at: 8, seconds: 4 } },
  // 비정상 종료: fMP4 폴더 녹화 중 Chrome SIGKILL → 남은 부분 파일 확인 (--only로만 실행, 헤드리스의 "폴더"는 프로필 안 OPFS 루트)
  { id: 'crash-fmp4', mode: 'VIDEO_AUDIO', audio: 'mp3', video: 'fmp4', expect: ['mp4'], saveToFolder: true, duration: 20, crashAt: 20, explicitOnly: true }
].filter(s => (!ONLY || ONLY.includes(s.id)) && (!s.explicitOnly || (ONLY && ONLY.includes(s.id))))
  // Chrome을 죽이는 시나리오는 맨 뒤로
  .sort((a, b) => (a.crashAt ? 1 : 0) - (b.crashAt ? 1 : 0));

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

// ---- offscreen → background 메시지 기록 (DOWNLOAD_FILE / RECORDING_COMPLETE 확인용, 모든 문서 로드 전에 설치) ----
function offscreenMessageSpyScript() {
  return `
    (() => {
      window.__e2eSent = [];
      try {
        const runtime = chrome.runtime;
        const original = runtime.sendMessage.bind(runtime);
        const spy = (message, ...rest) => {
          try {
            const action = message && message.action;
            const data = action === 'RECORDING_COMPLETE' ? JSON.parse(JSON.stringify(message.data))
              : action === 'DOWNLOAD_FILE' ? { filename: message.data && message.data.filename } : null;
            window.__e2eSent.push({ action, at: Date.now(), data });
          } catch { /* 기록 실패는 무시 */ }
          return original(message, ...rest);
        };
        try { runtime.sendMessage = spy; } catch { /* 아래에서 재정의 */ }
        if (runtime.sendMessage !== spy) Object.defineProperty(runtime, 'sendMessage', { value: spy, configurable: true, writable: true });
        window.__e2eSpyInstalled = runtime.sendMessage === spy;
      } catch (error) {
        window.__e2eSpyError = String(error);
      }
    })();
  `;
}

// ---- 사용자 폴더 저장 (OPFS 루트를 저장 폴더로) ----
// offscreen 출처에서 save-location.js로 저장 폴더를 설정/해제 (IndexedDB 핸들 + chrome.storage.sync 미러)
async function configureSaveFolder(offPage, useFolder) {
  return offPage.evaluate(async (folder) => {
    const location = await import('./save-location.js');
    if (folder) {
      const root = await navigator.storage.getDirectory();
      await location.saveDirectoryHandle(root);
    } else {
      await location.clearDirectoryHandle();
    }
    return location.getSaveLocationInfo();
  }, useFolder);
}

// OPFS 루트의 파일 목록 (이름, 크기)
function listOpfsRoot(offPage) {
  return offPage.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const out = [];
    for await (const [name, handle] of root.entries()) {
      out.push({ name, kind: handle.kind, size: handle.kind === 'file' ? (await handle.getFile()).size : null });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });
}

// OPFS 루트 파일을 ffprobe 검증용으로 출력 디렉토리에 내보냄 (4 MB씩 base64로 전달)
async function exportOpfsFile(offPage, name, dest) {
  const CHUNK = 4 * 1024 * 1024;
  const size = await offPage.evaluate(async (n) => (await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile()).size, name);
  const fd = openSync(dest, 'w');
  try {
    for (let offset = 0; offset < size; offset += CHUNK) {
      const b64 = await offPage.evaluate(async (n, start, end) => {
        const file = await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile();
        const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      }, name, offset, Math.min(size, offset + CHUNK));
      writeSync(fd, Buffer.from(b64, 'base64'));
    }
  } finally {
    closeSync(fd);
  }
  return size;
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
// --verify=light: 장시간 파일은 전체 디코딩 대신 패킷 수/스트림 정보와 마지막 20초 디코딩만 검사
const VERIFY_LIGHT = args.verify === 'light';
function probe(path) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', VERIFY_LIGHT ? '-count_packets' : '-count_frames', '-of', 'json', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const info = JSON.parse(out);
  if (VERIFY_LIGHT) for (const st of info.streams) st.nb_read_frames = st.nb_read_packets;
  return info;
}
// null 머서는 영상 타임베이스가 1/fps라 한 프레임 간격보다 촘촘한 프레임을 '비단조 dts'로 경고함 → 실제 디코딩 오류와 분리
const DTS_WARNING = /non monotonically increasing dts to muxer/;
function decodeErrors(path) {
  const r = spawnSync(FFMPEG, ['-v', 'error', ...(VERIFY_LIGHT ? ['-sseof', '-20'] : []), '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  const lines = (r.stderr || '').trim().split('\n').filter(Boolean);
  return {
    errors: lines.filter(l => !DTS_WARNING.test(l)).join('\n'),
    bunchedFrameWarnings: lines.filter(l => DTS_WARNING.test(l)).length
  };
}
// --verify=light 보조: 파일 중간 구간 디코딩 (기본: 길이의 절반 지점부터 20초, --decodeAt=초로 지정)
function decodeWindowErrors(path, startSec, seconds = 20) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(startSec), '-t', String(seconds), '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  const lines = (r.stderr || '').trim().split('\n').filter(Boolean);
  return { startSec, seconds, errors: lines.filter(l => !DTS_WARNING.test(l)).join('\n'), exitCode: r.status };
}
// 오디오 패킷 타임라인 검사: 컨테이너 헤더(예: AVI nBlockAlign)가 잘못되면 DTS는 단조 증가하지만 스케일이 틀어짐
function audioTimeline(path) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=dts_time,pts_time', '-of', 'csv=p=0', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const rows = out.trim().split('\n').filter(Boolean).map(l => l.split(',').map(Number));
    const times = rows.map(r => (isNaN(r[0]) ? r[1] : r[0])).filter(n => !isNaN(n));
    if (!times.length) return null;
    return { packets: times.length, firstSec: +times[0].toFixed(3), lastSec: +times[times.length - 1].toFixed(3) };
  } catch { return null; }
}
// 영상 프레임 타이밍 통계 (DTS 간격)
function frameTiming(path) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', VERIFY_LIGHT ? 'packet=dts_time' : 'frame=pkt_dts_time', '-of', 'csv=p=0', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

// ---- fMP4 구조 검사 (moof 헤더만 디스크에서 읽음 → GB 단위 파일도 메모리 일정) ----
// 최상위 상자를 따라가며 moof(mfhd/traf/tfhd/tfdt/trun)를 해석: 조각 수, 트랙별 tfdt 연속성(앞 조각 끝 = 다음 조각 tfdt),
// 키프레임으로 시작하는 조각 비율, 최대 조각 길이, 활성화되지 않은 조각(free로 남은 쓰다 만 조각), 잘린 마지막 상자
function fmp4Structure(path) {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const head = Buffer.alloc(16);
    const top = [];
    const fragments = [];
    let o = 0, truncatedAt = null;
    const timescales = { 1: 90000, 2: null };
    while (o + 8 <= size) {
      readSync(fd, head, 0, 16, o);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - o;
      if (boxSize < 8) { truncatedAt = o; break; }
      top.push(type);
      if (o + boxSize > size) { truncatedAt = o; top[top.length - 1] += '(잘림)'; break; }
      if (type === 'moov') {
        const moov = Buffer.alloc(boxSize);
        readSync(fd, moov, 0, boxSize, o);
        const i = moov.indexOf('mdhd', 0, 'latin1');
        // 오디오 트랙(두 번째 mdhd)의 timescale
        const j = i >= 0 ? moov.indexOf('mdhd', i + 4, 'latin1') : -1;
        if (j >= 0) timescales[2] = moov.readUInt32BE(j + 4 + 4 + 8);
      }
      if (type === 'moof') {
        const moof = Buffer.alloc(boxSize);
        readSync(fd, moof, 0, boxSize, o);
        const frag = { offset: o, tracks: {} };
        const walk = (start, end, cb) => { for (let p = start; p + 8 <= end;) { const bs = moof.readUInt32BE(p); const t = moof.toString('latin1', p + 4, p + 8); cb(t, p, bs); if (bs < 8) break; p += bs; } };
        walk(8, boxSize, (t, p, bs) => {
          if (t === 'mfhd') frag.sequence = moof.readUInt32BE(p + 12);
          if (t !== 'traf') return;
          const tr = { base: 0, count: 0, duration: 0, firstFlags: null };
          let trackId = 0;
          walk(p + 8, p + bs, (c, q) => {
            if (c === 'tfhd') trackId = moof.readUInt32BE(q + 12);
            if (c === 'tfdt') tr.base = moof[q + 8] === 1 ? Number(moof.readBigUInt64BE(q + 12)) : moof.readUInt32BE(q + 12);
            if (c === 'trun') {
              const flags = moof.readUInt32BE(q + 8) & 0xFFFFFF;
              tr.count = moof.readUInt32BE(q + 12);
              let e = q + 16 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
              const per = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0) + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
              for (let k = 0; k < tr.count; k++, e += per) {
                if (flags & 0x100) tr.duration += moof.readUInt32BE(e);
                if (k === 0 && (flags & 0x400)) tr.firstFlags = moof.readUInt32BE(e + ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0));
              }
            }
          });
          frag.tracks[trackId] = tr;
        });
        fragments.push(frag);
      }
      o += boxSize;
    }
    const continuityErrors = [];
    for (const id of [1, 2]) {
      let expected = null;
      for (const f of fragments) {
        const t = f.tracks[id];
        if (!t) continue;
        if (expected !== null && t.base !== expected) continuityErrors.push(`트랙 ${id} 조각 #${f.sequence}: tfdt ${t.base} ≠ 앞 조각 끝 ${expected}`);
        expected = t.base + t.duration;
      }
    }
    const videoFrags = fragments.filter(f => f.tracks[1]);
    // 조각 길이 통계는 마지막 조각(마지막 샘플을 오디오 끝까지 늘림)을 뺀 값
    const durs = videoFrags.slice(0, -1).map(f => f.tracks[1].duration / 90000);
    const sequential = fragments.every((f, k) => f.sequence === k + 1);
    return {
      top: [...new Set(top)],
      fragments: fragments.length,
      sequential,
      inactiveFragments: top.filter(t => t === 'free').length, // 쓰다 만 조각(활성화 전) - 완료 파일에는 없어야 함 (mvex 안의 free는 최상위가 아님)
      continuityErrors,
      videoSamples: videoFrags.reduce((n, f) => n + f.tracks[1].count, 0),
      audioFrames: fragments.reduce((n, f) => n + (f.tracks[2] ? f.tracks[2].count : 0), 0),
      keyframeStartRatio: videoFrags.length ? +(videoFrags.filter(f => f.tracks[1].firstFlags === 0x02000000).length / videoFrags.length).toFixed(3) : null,
      maxFragmentSec: durs.length ? +Math.max(...durs).toFixed(3) : null,
      medianFragmentSec: durs.length ? +durs.slice().sort((a, b) => a - b)[Math.floor(durs.length / 2)].toFixed(3) : null,
      videoEndSec: videoFrags.length ? +((videoFrags.at(-1).tracks[1].base + videoFrags.at(-1).tracks[1].duration) / 90000).toFixed(3) : null,
      audioEndSec: timescales[2] && fragments.some(f => f.tracks[2]) ? +((fragments.filter(f => f.tracks[2]).at(-1).tracks[2].base + fragments.filter(f => f.tracks[2]).at(-1).tracks[2].duration) / timescales[2]).toFixed(3) : null,
      truncatedAt
    };
  } finally {
    closeSync(fd);
  }
}

// 잘린 파일도 읽을 수 있게 종료 코드와 무관하게 ffprobe JSON을 읽음 (비정상 종료 분석용)
function probeLoose(path) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let info = { streams: [], format: {} };
  try { info = JSON.parse(r.stdout || '{}'); } catch { /* 읽지 못함 */ }
  return { info, stderr: (r.stderr || '').trim(), status: r.status };
}

// 파일 앞부분만 읽기 (GB 단위 파일을 통째로 읽지 않도록)
function readHead(path, bytes) {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(bytes); readSync(fd, b, 0, bytes, 0); return b; } finally { closeSync(fd); }
}

// 디렉토리 아래 파일 목록 (경로, 크기, 수정 시각)
function walkFiles(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) { try { const st = statSync(p); out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs }); } catch { /* 사라짐 */ } }
  }
  return out;
}

// ---- 중지 후 "다시 녹화 가능" 상태 대기 ----
// 팝업: 상태 "대기 중" + 녹화 버튼 활성("녹화 시작"), SW: storage.session 상태 IDLE(또는 없음),
// 폴더 저장이면 OPFS 임시 데이터(recorda-recordings/<세션>)까지 지워진 시점. 50 ms 간격으로 확인
async function waitUntilReady({ popPage, worker, offPage, tStop, requireTempCleaned, timeoutMs = 120_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  const readTemp = () => offPage.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle('recorda-recordings');
      const names = [];
      for await (const k of base.keys()) names.push(k);
      return names;
    } catch (e) { return e && e.name === 'NotFoundError' ? [] : [`? ${e && e.message}`]; }
  }).catch(e => [`? ${e.message}`]);
  while (Date.now() < deadline) {
    // 팝업만 먼저 확인 (머싱 중인 offscreen 페이지에 부담을 주지 않도록), 팝업이 준비되면 SW·OPFS 임시 데이터 확인
    const ui = await popPage.evaluate(() => {
      const b = document.querySelector('#recordButton');
      return { status: document.querySelector('#status').textContent.trim(), buttonText: b.textContent.trim(), buttonDisabled: b.disabled };
    }).catch(e => ({ error: e.message }));
    const uiReady = ui.status === '대기 중' && !ui.buttonDisabled && ui.buttonText === '녹화 시작';
    if (uiReady) {
      const session = await worker.evaluate(() => chrome.storage.session.get('recordingState').then(r => r.recordingState || null)).catch(e => ({ error: e.message }));
      const temp = await readTemp();
      last = { ui, sessionState: session && session.state, temp, atMs: Date.now() - tStop };
      if ((!session || session.state === 'IDLE') && (!requireTempCleaned || temp.length === 0)) return { readyMs: Date.now() - tStop, ...last };
    } else {
      last = { ui, atMs: Date.now() - tStop };
    }
    await sleep(50);
  }
  return { readyMs: null, ...last };
}

// ---- 같은 브라우저에서 다시 녹화 (--recordAgain) ----
// 실제 확장은 완료 후 Offscreen 문서를 닫고 다음 시작 때 새로 만들므로, 하네스도 offscreen 탭을 새로 불러온 뒤 팝업으로 녹화
async function recordAgain({ seconds, popPage, offPage, worker, extensionId, saveToFolder }) {
  const out = { seconds };
  await offPage.evaluate(() => { try { clearInterval(window.__e2e.timer); window.__e2e.audioCtx && window.__e2e.audioCtx.close(); } catch {} }).catch(() => {});
  const opfsBefore = new Set((await listOpfsRoot(offPage)).map(e => e.name));
  await offPage.goto(`chrome-extension://${extensionId}/offscreen.html`, { waitUntil: 'load' });
  // 첫 녹화 완료 메시지가 아직 떠 있으면(5초 후 사라짐) 사라질 때까지 기다려 두 번째 완료 메시지와 섞이지 않게 함
  await popPage.waitForFunction(() => !document.querySelector('#message').classList.contains('show'), { timeout: 15_000 }).catch(() => {});
  const t0 = Date.now();
  await popPage.click('#recordButton');
  await popPage.waitForFunction(() => /녹화 중|녹음 중/.test(document.querySelector('#status').textContent), { timeout: 20_000 });
  out.startLatencyMs = Date.now() - t0;
  await sleep(seconds * 1000);
  const tStop = Date.now();
  await popPage.click('#recordButton');
  const readyPromise = waitUntilReady({ popPage, worker, offPage, tStop, requireTempCleaned: saveToFolder });
  await popPage.waitForFunction(() => {
    const m = document.querySelector('#message');
    return m.classList.contains('show') && (m.classList.contains('success') || m.classList.contains('error'));
  }, { timeout: 120_000 });
  out.stopToPopupMs = Date.now() - tStop;
  const message = await popPage.$eval('#message', el => ({ text: el.textContent, cls: el.className }));
  out.popupMessage = message.text;
  out.success = message.cls.includes('success');
  const sent = await offPage.evaluate(() => window.__e2eSent || []);
  const complete = sent.filter(m => m.action === 'RECORDING_COMPLETE').at(-1);
  out.stopToCompleteMs = complete ? complete.at - tStop : null;
  out.recordingComplete = complete ? complete.data : null;
  out.downloadMessages = sent.filter(m => m.action === 'DOWNLOAD_FILE').length;
  const ready = await readyPromise;
  out.stopToReadyMs = ready.readyMs;
  out.readyState = ready;
  if (throttle) out.throttleStop = throttle.summary(tStop);
  out.created = saveToFolder ? (await listOpfsRoot(offPage)).filter(e => e.kind === 'file' && !opfsBefore.has(e.name)) : [];
  return out;
}

// ---- 일시정지/재개 (팝업 버튼 클릭 → Background → Offscreen) ----
async function checkPauseResume(sc, result, popPage, worker, toSeconds) {
  const readUi = () => popPage.evaluate(() => ({
    status: document.querySelector('#status').textContent.trim(),
    time: document.querySelector('#timeDisplay').textContent.trim(),
    pauseText: document.querySelector('#pauseButton').textContent.trim(),
    selectsDisabled: [...document.querySelectorAll('select')].every(sel => sel.disabled)
  }));
  const readSession = () => worker.evaluate(() => chrome.storage.session.get('recordingState').then(r => r.recordingState)).catch(e => ({ error: e.message }));

  // 일시정지
  const timeBefore = (await popPage.$eval('#timeDisplay', el => el.textContent)).trim();
  await popPage.click('#pauseButton');
  await popPage.waitForFunction(() => document.querySelector('#status').textContent.trim() === '일시정지', { timeout: 10_000 });
  const pausedUi = await readUi();
  const pausedSession = await readSession();
  result.pauseCheck = { timeBefore, pausedUi, pausedSession };
  result.checks.push({ name: `일시정지: 상태 "${pausedUi.status}", 버튼 "${pausedUi.pauseText}", 설정 선택 비활성 ${pausedUi.selectsDisabled}`, pass: pausedUi.status === '일시정지' && pausedUi.pauseText === '재개' && pausedUi.selectsDisabled });
  result.checks.push({ name: `일시정지: SW storage.session 상태 ${pausedSession && pausedSession.state} (pausedAt ${pausedSession && typeof pausedSession.pausedAt === 'number' ? '기록됨' : '없음'})`, pass: !!pausedSession && pausedSession.state === 'PAUSED' && typeof pausedSession.pausedAt === 'number' });

  // 일시정지 유지: 1초 간격으로 시간 표시가 멈춰 있는지 확인
  const times = [pausedUi.time];
  for (let i = 0; i < sc.pause.seconds; i++) {
    await sleep(1000);
    times.push((await popPage.$eval('#timeDisplay', el => el.textContent)).trim());
  }
  const stillPaused = await readSession();
  result.pauseCheck.timesWhilePaused = times;
  result.checks.push({ name: `일시정지 ${sc.pause.seconds}s 동안 시간 표시 고정: ${times.join(' → ')} (일시정지 직전 ${timeBefore})`, pass: times.every(t => t === pausedUi.time) && toSeconds(pausedUi.time) >= toSeconds(timeBefore) && toSeconds(pausedUi.time) - toSeconds(timeBefore) <= 1 });
  result.checks.push({ name: `일시정지 유지 중 SW storage.session 상태 ${stillPaused && stillPaused.state}`, pass: !!stillPaused && stillPaused.state === 'PAUSED' });

  // 재개
  await popPage.click('#pauseButton');
  await popPage.waitForFunction(() => /녹화 중|녹음 중/.test(document.querySelector('#status').textContent), { timeout: 10_000 });
  const resumedUi = await readUi();
  const resumedSession = await readSession();
  Object.assign(result.pauseCheck, { resumedUi, resumedSession });
  const jump = toSeconds(resumedUi.time) - toSeconds(pausedUi.time);
  result.checks.push({ name: `재개: 시간 표시 ${pausedUi.time} → ${resumedUi.time} (멈춘 값에서 이어짐), 버튼 "${resumedUi.pauseText}"`, pass: jump >= 0 && jump <= 1 && resumedUi.pauseText === '일시정지' });
  const pausedTotalMs = resumedSession && resumedSession.pausedTotalMs;
  result.checks.push({ name: `재개: SW storage.session 상태 ${resumedSession && resumedSession.state}, pausedTotalMs ${pausedTotalMs}ms ≈ ${sc.pause.seconds * 1000}ms`, pass: !!resumedSession && resumedSession.state === 'RECORDING' && resumedSession.pausedAt === null && Math.abs(pausedTotalMs - sc.pause.seconds * 1000) < 1000 });
  log(`  일시정지 확인: ${timeBefore} → 일시정지 ${times.join('/')} → 재개 ${resumedUi.time}, SW 상태 ${pausedSession && pausedSession.state} → ${resumedSession && resumedSession.state} (pausedTotalMs ${pausedTotalMs})`);
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
  throttle = THROTTLE_MB > 0 ? startPressureThrottle({ thresholdMB: THROTTLE_MB, log }) : null;
  if (throttle) log(`메모리 압력 스로틀: 컨테이너 ${THROTTLE_MB} MB 초과 시 확장 렌더러 일시정지 (테스트 환경 장치)`);

  // 전역 메모리 가드: 녹화 중뿐 아니라 중지 후 처리 중에도 상한 근접 시 Chrome 종료 (컨테이너 재기동 방지)
  let globalAbort = null;
  const memGuard = setInterval(() => {
    const cg = cgroupMemory();
    if (cg && (cg.currentMB > MEM_LIMIT_MB + 128 || cg.anonMB > ANON_LIMIT_MB) && !globalAbort) {
      globalAbort = `컨테이너 메모리 ${cg.currentMB} MB (anon ${cg.anonMB}, file ${cg.fileMB}) → Chrome 강제 종료`;
      log('⛔ ' + globalAbort);
      if (throttle) throttle.stop();
      try { browser.process().kill('SIGKILL'); } catch { /* 무시 */ }
    }
  }, 1000);
  memGuard.unref();
  // 페이지 캐시 해제 루프 (디스크에 쓴 녹화 데이터가 컨테이너 메모리로 집계되는 것을 억제)
  // 비동기 실행: 이벤트 루프를 막으면 중지 소요 시간 측정이 왜곡되므로 execFile 사용
  let evictTimer = null;
  if (EVICT_SCRIPT) {
    const dirs = [USER_DATA_DIR, OUT_DIR].filter(Boolean);
    let running = false, lastEvict = 0;
    evictTimer = setInterval(() => {
      const cg = cgroupMemory();
      const now = Date.now();
      const due = evictFast || (cg && cg.fileMB > 600) || now - lastEvict >= 30_000;
      if (!due || running) return;
      running = true; lastEvict = now;
      execFile('python3', [EVICT_SCRIPT, ...dirs], { timeout: 30_000 }, () => { running = false; });
    }, 2000);
    evictTimer.unref();
  }
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
  // crash-fmp4: 브라우저를 죽인 뒤에는 시나리오를 더 진행하지 않음
  let crashed = false;
  class CrashDone extends Error {}
  const sampler = new ResourceSampler(browserPid);

  // 유휴 기준값: 페이지만 열어둔 상태
  const offPage = await browser.newPage();
  await offPage.evaluateOnNewDocument(offscreenMessageSpyScript());
  const popPage = await browser.newPage();
  await sleep(1500);
  const baseline = sampler.sample();
  log(`유휴 PSS ${(baseline.totalRss / 1048576).toFixed(0)} MB, 프로세스 ${baseline.procCount}개`);

  for (const sc of SCENARIOS) {
    const duration = sc.duration || DURATION;
    const width = Number(args.width) || sc.width || 1280, height = Number(args.height) || sc.height || 720;
    const saveToFolder = !!(sc.saveToFolder || args.saveToFolder);
    log(`===== ${sc.id} (${sc.mode}, audio=${sc.audio}, video=${sc.video}, ${width}x${height}, ${duration}s, 저장: ${saveToFolder ? '폴더(OPFS 루트) 직접 기록' : '다운로드'}) =====`);
    const result = { id: sc.id, mode: sc.mode, audioFormat: sc.audio, videoFormat: sc.video, width, height, durationSec: duration, saveToFolder, ok: false, checks: [], files: [] };
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
      const spyInstalled = await offPage.evaluate(() => window.__e2eSpyInstalled === true);
      if (!spyInstalled) log('  ⚠ offscreen 메시지 기록 설치 실패:', await offPage.evaluate(() => window.__e2eSpyError || '?'));

      // 저장 위치: 폴더 시나리오면 OPFS 루트를 저장 폴더로 등록, 아니면 기본(다운로드)으로
      const saveInfo = await configureSaveFolder(offPage, saveToFolder);
      const opfsBefore = saveToFolder ? new Set((await listOpfsRoot(offPage)).map(e => e.name)) : null;
      result.checks.push({ name: `저장 위치 설정: ${saveInfo.mode}${saveInfo.name ? ` (${saveInfo.name})` : ''}`, pass: saveInfo.mode === (saveToFolder ? 'folder' : 'downloads') });

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

      const ui = await popPage.evaluate(() => ({
        videoColumnDisabled: document.getElementById('videoColumn').classList.contains('disabled'),
        videoSelectDisabled: document.getElementById('videoFormatSelect').disabled,
        audioFormatDisabled: document.getElementById('formatSelect').disabled,
        // 저장 위치는 팝업에 표시하지 않음 (설정 페이지에서만 확인·변경)
        saveLocationShown: !!document.getElementById('saveLocation') || /저장:|다운로드 폴더/.test(document.getElementById('mainContainer').innerText)
      }));
      const mirror = await worker.evaluate(() => chrome.storage.sync.get('settings').then(r => (r.settings || {}))).catch(() => ({}));
      result.checks.push({
        name: `popup: 모드별 설정 활성 규칙 (영상 열 ${ui.videoColumnDisabled ? '비활성' : '활성'}, 오디오 포맷 ${ui.audioFormatDisabled ? '비활성' : '활성'})`,
        pass: ui.videoColumnDisabled === (sc.mode === 'AUDIO_ONLY') && ui.videoSelectDisabled === (sc.mode === 'AUDIO_ONLY') && ui.audioFormatDisabled === (sc.mode === 'VIDEO_AUDIO')
      });
      result.checks.push({ name: `저장 위치 미러(storage.sync) ${mirror.saveLocationMode || 'downloads'}${mirror.saveLocationName ? ` (${mirror.saveLocationName})` : ''}, 팝업에는 저장 위치 ${ui.saveLocationShown ? '표시됨' : '미표시'}`, pass: (mirror.saveLocationMode || 'downloads') === (saveToFolder ? 'folder' : 'downloads') && !ui.saveLocationShown });

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

      // 녹화 진행 대기 (10초 단위로 컨테이너 메모리 확인)
      let aborted = null;
      const recordFor = async (seconds) => {
        for (let waited = 0; waited < seconds && !aborted; waited += 10) {
          await sleep(Math.min(10, seconds - waited) * 1000);
          const cg = cgroupMemory();
          if (cg && cg.currentMB > MEM_LIMIT_MB) {
            aborted = `컨테이너 메모리 ${cg.currentMB} MB > 한계 ${MEM_LIMIT_MB} MB (anon ${cg.anonMB}, file ${cg.fileMB}) → 녹화 조기 중단`;
            log('  ⚠ ' + aborted);
          }
          const last = sampler2.samples[sampler2.samples.length - 1];
          // CPU는 1초 표본이라 흔들리므로 최근 60초 평균도 함께 (첫 표본은 이전 값이 없어 0%라 제외)
          const recent = sampler2.samples.slice(Math.max(1, sampler2.samples.length - 60));
          const avgCpu = recent.length ? recent.reduce((sum, s) => sum + s.cpuPct, 0) / recent.length : 0;
          if (duration >= 300 && last && (waited + 10) % 60 === 0) log(`  진행 ${Math.min(waited + 10, seconds)}s: PSS ${Math.round(last.totalRss / 1048576)} MB, 렌더러 ${Math.round(last.maxRendererRss / 1048576)} MB, JS힙 ${last.jsHeapMB === null ? '?' : Math.round(last.jsHeapMB)} MB, CPU ${Math.round(last.cpuPct)}% (60초 평균 ${Math.round(avgCpu)}%)${cg ? `, 컨테이너 ${cg.currentMB} MB (anon ${cg.anonMB})` : ''}`);
        }
      };
      const toSeconds = (text) => text.trim().split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
      if (sc.pause) {
        await recordFor(sc.pause.at);
        if (!aborted) await checkPauseResume(sc, result, popPage, worker, toSeconds);
        if (!aborted) await recordFor(duration - sc.pause.at);
      } else {
        await recordFor(duration);
      }
      result.abortedEarly = aborted;
      if (aborted) result.checks.push({ name: aborted, pass: false });
      const elapsedText = await popPage.$eval('#timeDisplay', el => el.textContent);
      result.checks.push({ name: `popup: 경과 시간 표시 ${elapsedText}`, pass: elapsedText !== '00:00' });
      if (sc.pause) {
        // 팝업 시간도 일시정지를 뺀 녹화 시간이어야 함 (일시정지 포함 시 약 16초)
        result.checks.push({ name: `popup: 중지 직전 표시 ${elapsedText.trim()} ≈ 녹화 ${duration}s (일시정지 ${sc.pause.seconds}s 제외)`, pass: Math.abs(toSeconds(elapsedText) - duration) <= 1.5 });
      }

      if (sc.crashAt) {
        // ---- 비정상 종료: fMP4 폴더 녹화 중 Chrome 브라우저 프로세스를 SIGKILL → 프로필에 남은 부분(스왑) 파일 확인 ----
        // 헤드리스의 "폴더"는 OPFS 루트라 실제 폴더의 <이름>.mp4.crswap 대신 프로필의 File System 안에 난독화된 이름으로 남음
        result.opfsRootBeforeCrash = await listOpfsRoot(offPage).catch((e) => [{ error: e.message }]);
        const profileDir = USER_DATA_DIR || ((browser.process().spawnargs || []).find(a => a.startsWith('--user-data-dir=')) || '').split('=').slice(1).join('=');
        const killedPid = browser.process().pid;
        sampler2.stop();
        const tKill = Date.now();
        try { process.kill(killedPid, 'SIGKILL'); } catch (e) { log('  SIGKILL 실패:', e.message); }
        crashed = true;
        evictFast = false;
        // 자식 프로세스(렌더러·GPU·유틸리티)가 모두 끝날 때까지 (최대 15초, 남으면 SIGKILL)
        const chromeAlive = () => spawnSync('pgrep', ['-f', 'chrome-linux64/chrom[e]'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
        for (let i = 0; i < 150 && chromeAlive().length; i++) await sleep(100);
        const leftover = chromeAlive();
        if (leftover.length) { for (const pid of leftover) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* 이미 끝남 */ } } await sleep(500); }
        log(`  Chrome SIGKILL (녹화 ${sc.crashAt}초 후, pid ${killedPid}), 남은 프로세스 정리 ${leftover.length}개, ${Date.now() - tKill} ms`);
        const fsDir = join(profileDir, 'Default', 'File System');
        const recent = walkFiles(join(profileDir, 'Default')).filter(x => x.mtimeMs >= t0 - 2000).sort((a, b) => b.size - a.size);
        const inFs = recent.filter(x => x.path.startsWith(fsDir + '/'));
        const pick = inFs[0] || recent[0] || null;
        result.crash = {
          killedAfterSec: sc.crashAt,
          profileDir,
          fileSystemDir: fsDir,
          fileSystemDirExists: existsSync(fsDir),
          largestRecentFiles: recent.slice(0, 6).map(x => ({ path: x.path.slice(profileDir.length + 1), sizeMB: +(x.size / 1048576).toFixed(2) })),
          picked: pick ? { path: pick.path.slice(profileDir.length + 1), sizeMB: +(pick.size / 1048576).toFixed(2), inFileSystemDir: pick.path.startsWith(fsDir + '/') } : null
        };
        if (pick) {
          const copy = join(OUT_DIR, 'crash-fmp4-partial.mp4');
          copyFileSync(pick.path, copy);
          const head = readHead(copy, 12);
          const pr = probeLoose(copy);
          const pv = (pr.info.streams || []).find(x => x.codec_type === 'video');
          const pa = (pr.info.streams || []).find(x => x.codec_type === 'audio');
          const dec = spawnSync(FFMPEG, ['-v', 'error', '-i', copy, '-f', 'null', '-'], { encoding: 'utf8' });
          let structure = null;
          try { structure = fmp4Structure(copy); } catch (e) { structure = { error: e.message }; }
          Object.assign(result.crash, {
            ftyp: head.toString('latin1', 4, 12),
            structure,
            probe: {
              video: pv ? { codec: pv.codec_name, frames: Number(pv.nb_read_frames), duration: Number(pv.duration) } : null,
              audio: pa ? { codec: pa.codec_name, frames: Number(pa.nb_read_frames), duration: Number(pa.duration) } : null,
              formatDurationSec: pr.info.format ? Number(pr.info.format.duration) : null,
              stderr: pr.stderr.slice(0, 400)
            },
            decodeExit: dec.status,
            // null 머서의 '비단조 dts' 경고(한 프레임 간격 미만 프레임)는 실제 디코딩 오류가 아니므로 따로 셈
            decodeErrors: (dec.stderr || '').trim().split('\n').filter(l => l && !DTS_WARNING.test(l)).slice(0, 5),
            bunchedFrameWarnings: (dec.stderr || '').split('\n').filter(l => DTS_WARNING.test(l)).length
          });
          const frames = pv ? Number(pv.nb_read_frames) : 0;
          result.crash.decodes = frames > 0 && dec.status === 0 && result.crash.decodeErrors.length === 0;
          log(`  비정상 종료 후 남은 파일: ${result.crash.picked.path} ${result.crash.picked.sizeMB} MB (File System 안: ${result.crash.picked.inFileSystemDir}) | ftyp ${result.crash.ftyp} | 조각 ${structure && structure.fragments} (활성 전 ${structure && structure.inactiveFragments}) | ffprobe 영상 ${frames}프레임 ${pv ? Number(pv.duration).toFixed(2) : '-'}s, 오디오 ${pa ? Number(pa.nb_read_frames) : 0}프레임 | 디코딩 종료 코드 ${dec.status}`);
          result.checks.push({ name: `비정상 종료 후 남은 부분 파일: ${result.crash.picked.path} (${result.crash.picked.sizeMB} MB, ftyp ${result.crash.ftyp})`, pass: true });
          result.checks.push({ name: `부분 파일 디코딩(보고용, OPFS는 복구를 약속하지 않음): 영상 ${frames}프레임 ≈ ${pv ? Number(pv.duration).toFixed(1) : 0}초 / 녹화 ${sc.crashAt}초, 완전한 조각 ${structure && structure.fragments}개`, pass: true });
        } else {
          result.checks.push({ name: `비정상 종료 후 프로필에서 최근 파일을 찾지 못함 (${fsDir})`, pass: false });
        }
        result.ok = result.checks.every(c => c.pass);
        throw new CrashDone();
      }

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
      evictFast = true;
      const tStop = Date.now();
      await popPage.click('#recordButton');
      // 중지 클릭부터 "다시 녹화 가능"(대기 중·버튼 활성·SW IDLE, 폴더 저장이면 OPFS 임시 정리)까지를 동시에 감시
      const readyPromise = waitUntilReady({ popPage, worker, offPage, tStop, requireTempCleaned: saveToFolder, timeoutMs: Math.max(180_000, duration * 1000) });
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

      let files = [];
      if (saveToFolder) {
        // 폴더 저장: DOWNLOAD_FILE 없이 RECORDING_COMPLETE(savedTo folder)만, 파일은 OPFS 루트에 직접 기록됨
        await sleep(300);
        const sent = await offPage.evaluate(() => window.__e2eSent || []);
        const downloadMessages = sent.filter(m => m.action === 'DOWNLOAD_FILE');
        const complete = sent.filter(m => m.action === 'RECORDING_COMPLETE').at(-1);
        const downloadItems = (await collectDownloads(worker)).slice(downloadsBefore);
        result.recordingComplete = complete ? complete.data : null;
        result.checks.push({ name: `폴더 저장: offscreen이 보낸 DOWNLOAD_FILE ${downloadMessages.length}개, chrome.downloads 호출 ${downloadItems.length}회`, pass: spyInstalled && downloadMessages.length === 0 && downloadItems.length === 0 });
        const completeFiles = complete ? complete.data.files : [];
        result.checks.push({
          name: `폴더 저장: RECORDING_COMPLETE savedTo=${complete && complete.data.savedTo}, 파일별 ${completeFiles.map(f => `${f.filename}→${f.savedTo}(${f.location})`).join(', ')}${complete && complete.data.warning ? `, 경고: ${complete.data.warning}` : ''}`,
          pass: !!complete && complete.data.savedTo === 'folder' && completeFiles.length === sc.expect.length && completeFiles.every(f => f.savedTo === 'folder' && f.location === saveInfo.name) && !complete.data.warning
        });
        const opfsAfter = await listOpfsRoot(offPage);
        const created = opfsAfter.filter(e => e.kind === 'file' && !opfsBefore.has(e.name));
        result.opfsRootAfter = opfsAfter;
        const sizesMatch = completeFiles.every(f => created.some(e => e.name === f.filename && e.size === f.size));
        result.checks.push({ name: `폴더(OPFS 루트)에 새 파일 ${created.length}개: ${created.map(e => `${e.name} ${(e.size / 1048576).toFixed(2)} MB`).join(', ')} (루트 항목: ${opfsAfter.map(e => e.name).join(', ')})`, pass: created.length === sc.expect.length && sizesMatch && created.every(e => /^recorda_\d{8}_\d{6}\.[a-z0-9]+$/.test(e.name)) });
        const tStopClick = tStop;
        const completeAt = complete ? complete.at : null;
        const t = complete && complete.data.timings;
        result.folderStopToCompleteMs = completeAt ? completeAt - tStopClick : null;
        log(`  폴더 저장: 중지 클릭 → RECORDING_COMPLETE ${result.folderStopToCompleteMs} ms, → 팝업 완료 메시지 ${stopLatencyMs} ms | offscreen 단계별(ms) ${JSON.stringify(t)}`);
        result.checks.push({ name: `폴더 저장: 중지 → 완료 ${stopLatencyMs} ms (offscreen 처리 ${t && t.totalMs} ms: 영상 머싱+기록 ${t && t.videoMs}, WAV 마감 ${t && t.audioMs}, 다운로드 요청 ${t && t.downloadRequestMs}, OPFS 임시 정리 ${t && t.cleanupMs})`, pass: !!t && t.downloadRequestMs <= 5 });
        // 다시 녹화 가능 상태까지 (팝업 대기 중·버튼 활성, SW IDLE, OPFS 임시 데이터 삭제)
        const ready = await readyPromise;
        result.stopToReadyMs = ready.readyMs;
        result.readyState = ready;
        if (throttle) {
          result.throttleRecording = throttle.summary(t0);
          result.throttleStop = throttle.summary(tStop);
          result.throttleRecording.pauses -= result.throttleStop.pauses;
          result.throttleRecording.totalPausedMs -= result.throttleStop.totalPausedMs;
          log(`  스로틀(중지 클릭 → 지금): 일시정지 ${result.throttleStop.pauses}회, 누적 ${(result.throttleStop.totalPausedMs / 1000).toFixed(1)}초, 최장 ${result.throttleStop.maxPauseMs} ms | 녹화 중 ${result.throttleRecording.pauses}회`);
        }
        log(`  다시 녹화 가능: 중지 클릭 → ${ready.readyMs} ms (팝업 "${ready.ui && ready.ui.status}", 버튼 "${ready.ui && ready.ui.buttonText}"${ready.ui && ready.ui.buttonDisabled ? ' 비활성' : ' 활성'}, SW ${ready.sessionState || '없음(IDLE)'}, OPFS 임시 ${JSON.stringify(ready.temp)})`);
        result.checks.push({ name: `중지 → 다시 녹화 가능(대기 중·버튼 활성·SW IDLE·OPFS 임시 정리) ${ready.readyMs} ms`, pass: typeof ready.readyMs === 'number' });
        const expectedDuration = new Map(created.map(e => [e.name, duration]));
        if (RECORD_AGAIN_SEC > 0) {
          log(`  같은 브라우저에서 다시 녹화 ${RECORD_AGAIN_SEC}초...`);
          const again = await recordAgain({ seconds: RECORD_AGAIN_SEC, popPage, offPage, worker, extensionId, saveToFolder });
          result.recordAgain = again;
          const at = again.recordingComplete && again.recordingComplete.timings;
          log(`  다시 녹화: 시작 ${again.startLatencyMs} ms, 중지 → RECORDING_COMPLETE ${again.stopToCompleteMs} ms, → 팝업 완료 ${again.stopToPopupMs} ms, → 다시 녹화 가능 ${again.stopToReadyMs} ms | 파일 ${again.created.map(e => `${e.name} ${(e.size / 1048576).toFixed(2)} MB`).join(', ')} | offscreen 단계별(ms) ${JSON.stringify(at)}`);
          const againFiles = again.recordingComplete ? again.recordingComplete.files : [];
          result.checks.push({ name: `다시 녹화: 완료 메시지 "${again.popupMessage}" (중지 → 완료 ${again.stopToPopupMs} ms)`, pass: again.success });
          result.checks.push({ name: `다시 녹화: RECORDING_COMPLETE savedTo=${again.recordingComplete && again.recordingComplete.savedTo}, DOWNLOAD_FILE ${again.downloadMessages}개, 새 파일 ${again.created.length}개`, pass: !!again.recordingComplete && again.recordingComplete.savedTo === 'folder' && again.downloadMessages === 0 && again.created.length === sc.expect.length && againFiles.every(f => again.created.some(e => e.name === f.filename && e.size === f.size)) });
          result.checks.push({ name: `다시 녹화 후에도 다시 녹화 가능 상태 ${again.stopToReadyMs} ms`, pass: typeof again.stopToReadyMs === 'number' });
          for (const e of again.created) { created.push(e); expectedDuration.set(e.name, RECORD_AGAIN_SEC); }
        }
        result.expectedDurations = Object.fromEntries(expectedDuration);
        // ffprobe 검증용으로 내보낸 뒤 OPFS 루트에서 삭제 (다음 실행에 남지 않도록)
        const tExport = Date.now();
        for (const entry of created) {
          await exportOpfsFile(offPage, entry.name, join(OUT_DIR, entry.name));
          await offPage.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n), entry.name);
        }
        if (created.length) log(`  내보내기 ${created.length}개 파일 ${((Date.now() - tExport) / 1000).toFixed(1)}초${throttle ? ` (스로틀 ${JSON.stringify(throttle.summary(tExport))})` : ''}`);
        files = created.map(e => e.name);
      } else {
        // chrome.downloads 완료 대기 후 요청 파일명으로 복원
        const deadline = Date.now() + Math.max(120_000, duration * 500);
        let downloadItems = [];
        while (Date.now() < deadline) {
          downloadItems = (await collectDownloads(worker)).slice(downloadsBefore);
          if (downloadItems.length >= sc.expect.length && downloadItems.every(d => d.state === 'complete' || d.state === 'interrupted')) break;
          await sleep(500);
        }
        result.downloads = downloadItems.map(d => ({ id: d.id, requested: d.requested, state: d.state, error: d.error }));
        const ready = await readyPromise;
        result.stopToReadyMs = ready.readyMs;
        result.readyState = ready;
        log(`  다시 녹화 가능(대기 중·버튼 활성·SW IDLE): 중지 클릭 → ${ready.readyMs} ms`);
        files = readdirSync(OUT_DIR).filter(f => !before.has(f) && !f.endsWith('.crdownload') && !/^[0-9a-f-]{36}$/.test(f));
        result.checks.push({ name: `chrome.downloads 상태: ${downloadItems.map(d => `${d.requested}=${d.state}`).join(', ')}`, pass: downloadItems.length === sc.expect.length && downloadItems.every(d => d.state === 'complete') });
        const sentDownloads = (await offPage.evaluate(() => window.__e2eSent || [])).filter(m => m.action === 'DOWNLOAD_FILE');
        const complete = (await offPage.evaluate(() => window.__e2eSent || [])).filter(m => m.action === 'RECORDING_COMPLETE').at(-1);
        if (complete) result.recordingComplete = complete.data;
        if (spyInstalled) result.checks.push({ name: `다운로드 저장: DOWNLOAD_FILE ${sentDownloads.length}개, RECORDING_COMPLETE savedTo=${complete && complete.data.savedTo}`, pass: sentDownloads.length === sc.expect.length && !!complete && complete.data.savedTo === 'downloads' });
      }
      const exts = files.map(f => f.split('.').pop()).sort();
      const expectedExts = RECORD_AGAIN_SEC > 0 && saveToFolder ? [...sc.expect, ...sc.expect] : [...sc.expect];
      result.checks.push({ name: `${saveToFolder ? '폴더' : '다운로드'} 파일 ${files.length}개: ${files.join(', ')}`, pass: JSON.stringify(exts) === JSON.stringify(expectedExts.sort()) });

      // 파일 검증 (--recordAgain이면 두 번째 녹화 파일도 그 길이로 검사)
      for (const f of files) {
        const path = join(OUT_DIR, f);
        const fileDuration = (result.expectedDurations && result.expectedDurations[f]) || duration;
        const info = probe(path);
        const v = info.streams.find(s => s.codec_type === 'video');
        const a = info.streams.find(s => s.codec_type === 'audio');
        const decode = decodeErrors(path);
        const errors = decode.errors;
        const timing = v ? frameTiming(path) : null;
        const fileResult = {
          name: f,
          expectedDurationSec: fileDuration,
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
        result.checks.push({ name: `${f}: 길이 ${fileResult.durationSec}s ≈ 녹화 ${fileDuration}s`, pass: Math.abs(fileResult.durationSec - fileDuration) < 1.5 });
        if (VERIFY_LIGHT) {
          // 패킷 수 (light 검증은 -count_packets) + 파일 중간 20초 디코딩
          fileResult.packets = Object.fromEntries(info.streams.map(st => [st.codec_type, Number(st.nb_read_packets)]));
          if (fileResult.durationSec > 60) {
            const mid = Number(args.decodeAt) || Math.floor(fileResult.durationSec / 2);
            const w = decodeWindowErrors(path, mid, 20);
            fileResult.midDecode = w;
            result.checks.push({ name: `${f}: ${mid}s부터 20초 디코딩 오류 없음`, pass: w.errors === '' && w.exitCode === 0, detail: w.errors.slice(0, 300) });
          }
        }
        if (sc.pause) {
          const wallSec = duration + sc.pause.seconds;
          result.checks.push({ name: `${f}: 일시정지 ${sc.pause.seconds}s 제외 → 파일 길이 ${fileResult.durationSec}s ≈ ${duration}s (일시정지 포함이면 ${wallSec}s)`, pass: Math.abs(fileResult.durationSec - duration) < 1.5 && fileResult.durationSec < duration + sc.pause.seconds / 2 });
          if (timing) result.checks.push({ name: `${f}: 재개 지점에도 영상 끊김 없음 (최대 프레임 간격 ${timing.maxDeltaMs}ms < 300ms)`, pass: timing.maxDeltaMs < 300 });
        }
        if (sc.video === 'fmp4' && ext === 'mp4') {
          // 조각 MP4 구조: ftyp(iso5) → moov → (moof, mdat)×N, 순번 연속, 쓰다 만(활성화 전) 조각 없음, 조각 tfdt 연속(일시정지 앞뒤 포함)
          const st = fmp4Structure(path);
          fileResult.fmp4 = st;
          const ftypBrand = readHead(path, 12).toString('latin1', 8, 12);
          result.checks.push({ name: `${f}: fMP4 구조 ${st.top.join('→')} (ftyp ${ftypBrand}), 조각 ${st.fragments}개, mfhd 순번 연속 ${st.sequential}, 활성화 안 된 조각 ${st.inactiveFragments}개`, pass: ftypBrand === 'iso5' && st.top[0] === 'ftyp' && st.top[1] === 'moov' && st.fragments > 0 && st.sequential && st.inactiveFragments === 0 && st.truncatedAt === null });
          result.checks.push({ name: `${f}: 조각 tfdt가 끊김 없이 이어짐 (영상·오디오${sc.pause ? ', 일시정지 앞뒤 포함' : ''}, 불연속 ${st.continuityErrors.length}건)`, pass: st.continuityErrors.length === 0, detail: st.continuityErrors.slice(0, 3).join('; ') });
          result.checks.push({ name: `${f}: 조각 길이 중앙값 ${st.medianFragmentSec}s · 최대 ${st.maxFragmentSec}s, 키프레임으로 시작하는 조각 ${st.keyframeStartRatio === null ? '-' : Math.round(st.keyframeStartRatio * 100)}%`, pass: st.fragments === 1 || (st.maxFragmentSec <= 3 && st.keyframeStartRatio >= 0.9) });
          if (v && a) result.checks.push({ name: `${f}: 조각의 샘플 수 = ffprobe 패킷 수 (영상 ${st.videoSamples}/${v.nb_read_frames}, 오디오 ${st.audioFrames}/${a.nb_read_frames})`, pass: st.videoSamples === Number(v.nb_read_frames) && st.audioFrames === Number(a.nb_read_frames) });
        }
        const aTimeline = a ? audioTimeline(path) : null;
        fileResult.audioTimeline = aTimeline;
        if (aTimeline) {
          result.checks.push({ name: `${f}: 마지막 오디오 패킷 시각 ${aTimeline.lastSec}s ≈ 파일 길이 ${fileResult.durationSec}s (패킷 ${aTimeline.packets}개)`, pass: Math.abs(aTimeline.lastSec - fileResult.durationSec) < 1.0 });
        }
        if (expectVideo) {
          result.checks.push({ name: `${f}: h264 ${v && v.width}x${v && v.height}, ${v && v.nb_read_frames}프레임`, pass: !!v && v.codec_name === 'h264' && v.width === width && v.height === height && Number(v.nb_read_frames) > fileDuration * 10 });
          result.checks.push({ name: `${f}: 오디오 mp3 포함`, pass: !!a && a.codec_name === 'mp3' });
          if (v && a) result.checks.push({ name: `${f}: A/V 길이 차이 ${Math.abs(Number(v.duration) - Number(a.duration)).toFixed(2)}s`, pass: Math.abs(Number(v.duration) - Number(a.duration)) < 0.35 });
        } else {
          const expectCodec = ext === 'wav' ? 'pcm_s16le' : 'mp3';
          result.checks.push({ name: `${f}: 오디오 코덱 ${a && a.codec_name}`, pass: !!a && a.codec_name === expectCodec && !v });
        }
      }

      // 인코딩 통계 (offscreen 콘솔에서)
      const statsLine = offLogs.find(l => l.includes('[VideoRecordingSession] 머싱 완료') || l.includes('[VideoRecordingSession] 기록 완료'));
      if (statsLine) result.encoderStats = statsLine;
      const timingLine = offLogs.find(l => l.includes('중지 후 단계별 시간'));
      if (timingLine) {
        try { result.stopTimings = JSON.parse(timingLine.slice(timingLine.indexOf('{'))); } catch { /* 무시 */ }
        log(`  중지 후 단계별(ms): ${timingLine.slice(timingLine.indexOf('{'))} | 중지 클릭→저장 완료 ${result.stopProcessingMs} ms`);
      }
      const dropLine = offLogs.find(l => l.includes('[VideoTrackEncoder] 완료'));
      if (dropLine) result.encoderStats = (result.encoderStats || '') + ' | ' + dropLine;
      if (sc.pause) {
        const mP = dropLine && dropLine.match(/"paused":(\d+)/);
        const mO = dropLine && dropLine.match(/"pauseOffsetMs":(\d+)/);
        const pausedFrames = mP ? Number(mP[1]) : -1;
        const pauseOffsetMs = mO ? Number(mO[1]) : -1;
        const pausedTotalMs = result.pauseCheck && result.pauseCheck.resumedSession ? result.pauseCheck.resumedSession.pausedTotalMs : null;
        result.checks.push({ name: `영상 인코더: 일시정지 중 프레임 ${pausedFrames}개 버림, 타임스탬프에서 ${pauseOffsetMs}ms 제외 (SW 기록 일시정지 ${pausedTotalMs}ms)`, pass: pausedFrames > 0 && typeof pausedTotalMs === 'number' && Math.abs(pauseOffsetMs - pausedTotalMs) < 250 });
      }
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
      if (!(error instanceof CrashDone)) {
        result.error = error.message;
        result.ok = false;
        log('오류:', error.message);
      }
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

    if (crashed) break; // 브라우저를 죽였으므로 남은 시나리오 없음 (crash 시나리오는 항상 마지막)
    // 다음 시나리오를 위해 offscreen 페이지 상태 초기화
    await offPage.evaluate(() => { try { clearInterval(window.__e2e.timer); window.__e2e.audioCtx && window.__e2e.audioCtx.close(); } catch {} }).catch(() => {});
    await sleep(1000);
  }

  clearInterval(keepAlive);
  if (throttle) { report.throttle = throttle.summary(0); throttle.stop(); }
  report.swLogsTail = swLogs.slice(-30);
  report.finishedAt = new Date().toISOString();
  report.passed = report.scenarios.filter(s => s.ok).length;
  report.total = report.scenarios.length;
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  log(`완료: ${report.passed}/${report.total} 시나리오 통과. 리포트: ${join(OUT_DIR, 'report.json')}`);

  if (crashed) { try { browser.disconnect(); } catch { /* 이미 끊김 */ } } else await browser.close();
  process.exit(report.passed === report.total ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
