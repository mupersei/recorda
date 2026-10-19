// 테스트 환경용 메모리 압력 스로틀 (RECORDA_THROTTLE_MB)
//
// 이 샌드박스는 컨테이너 메모리 한도(4 GiB)에 페이지 캐시까지 포함되고, 볼륨 쓰기 속도가 약 100 MB/s입니다.
// 수 GB 파일을 머싱하면(청크 저장소 읽기 + 결과 파일 쓰기) 쓴 데이터가 디스크로 나가기 전까지 더러운 페이지로 쌓여
// (호스트 커널의 dirty 한도가 컨테이너보다 훨씬 큼) 확장 프로세스 메모리(anon)는 그대로인데도 하네스 가드를 넘습니다
// (3시간 1차 실행: 중지 9초 만에 file 캐시 734 → 2,020 MB, anon 1,266 → 1,290 MB → 가드가 Chrome 종료).
// 그래서 컨테이너 메모리가 임계값을 넘으면 확장 렌더러(--extension-process: offscreen·팝업 페이지)를 잠시 멈춰(SIGSTOP)
// 새 쓰기를 막고, writeback(캐시 해제 데몬)이 따라잡아 내려가면 재개(SIGCONT)합니다. 멈춘 시간은 따로 집계해 보고합니다.
// 확장 코드와 무관한 환경 장치이며, 측정된 중지 시간은 "디스크 속도에 묶인" 보수적인 값이 됩니다.
import { readFileSync, readdirSync } from 'node:fs';

function cgroupCurrentMB() {
  try { return Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8')) / 1048576; } catch { return 0; }
}

/** 확장 렌더러 프로세스 (Chrome 하나만 실행하므로 --extension-process 렌더러 = 이 하네스의 Chrome) */
function extensionRendererPids() {
  const pids = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (cmd.includes('--type=renderer') && cmd.includes('--extension-process')) pids.push(Number(d));
    } catch { /* 종료됨 */ }
  }
  return pids;
}

/**
 * @param {{thresholdMB:number, hysteresisMB?:number, maxPauseMs?:number, minRunMs?:number, intervalMs?:number, log?:Function}} options
 */
export function startPressureThrottle({ thresholdMB, hysteresisMB = 300, maxPauseMs = 3000, minRunMs = 500, intervalMs = 100, log = () => {} }) {
  const state = { thresholdMB, pauses: 0, totalPausedMs: 0, maxPauseMs: 0, events: [], paused: false, pids: [], since: 0, resumedAt: 0, firstPauseAt: null, lastPauseAt: null };
  const resume = (reason) => {
    for (const pid of state.pids) { try { process.kill(pid, 'SIGCONT'); } catch { /* 종료됨 */ } }
    const dur = Date.now() - state.since;
    state.totalPausedMs += dur;
    state.maxPauseMs = Math.max(state.maxPauseMs, dur);
    if (state.events.length < 2000) state.events.push({ at: state.since, ms: dur, reason });
    state.paused = false;
    state.resumedAt = Date.now();
  };
  let lastLog = 0;
  const timer = setInterval(() => {
    const mb = cgroupCurrentMB();
    const now = Date.now();
    if (!state.paused) {
      if (mb > thresholdMB && now - state.resumedAt >= minRunMs) {
        state.pids = extensionRendererPids();
        for (const pid of state.pids) { try { process.kill(pid, 'SIGSTOP'); } catch { /* 종료됨 */ } }
        state.paused = true;
        state.since = now;
        state.pauses++;
        if (state.firstPauseAt === null) state.firstPauseAt = now;
        state.lastPauseAt = now;
        if (now - lastLog > 10_000) { lastLog = now; log(`  스로틀: 컨테이너 ${Math.round(mb)} MB > ${thresholdMB} MB → 확장 렌더러 일시정지 (누적 ${state.pauses}회, ${(state.totalPausedMs / 1000).toFixed(1)}초)`); }
      }
    } else if (mb < thresholdMB - hysteresisMB || now - state.since >= maxPauseMs) {
      resume(mb < thresholdMB - hysteresisMB ? 'drained' : 'maxPause');
    }
  }, intervalMs);
  timer.unref();
  return {
    state,
    /** 집계 (구간 시작 시각 이후만: since) */
    summary(since = 0) {
      const ev = state.events.filter(e => e.at >= since);
      return { thresholdMB, pauses: ev.length, totalPausedMs: ev.reduce((s, e) => s + e.ms, 0), maxPauseMs: ev.reduce((m, e) => Math.max(m, e.ms), 0), maxPauseHits: ev.filter(e => e.reason === 'maxPause').length };
    },
    stop() {
      clearInterval(timer);
      if (state.paused) resume('stop');
    }
  };
}
