// chrome.* 확장 API 가짜 구현 (Node 통합 테스트용)

export function installFakeChrome({ streamId = 'stream-123', offscreenExists = false, downloadsAvailable = true } = {}) {
  const calls = { sendMessage: [], downloads: [], badges: [], alarms: [], offscreen: [], order: [] };
  const listeners = { onMessage: [], onAlarm: [], onDownloadChanged: [], onStorageChanged: [], onInstalled: [] };
  let nextDownloadId = 1;
  const storage = {};
  const sessionStorage = {};
  const downloadItems = new Map();

  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
      onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      sendMessage: async (message) => {
        calls.sendMessage.push(message);
        const handler = chrome.__respondTo && chrome.__respondTo[message.action];
        return handler ? handler(message) : { success: true };
      },
      getContexts: async () => (offscreenExists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [])
    },
    tabCapture: {
      getMediaStreamId: async ({ targetTabId }) => {
        calls.lastTargetTabId = targetTabId;
        calls.order.push('getMediaStreamId');
        if (chrome.__streamIdError) throw new Error(chrome.__streamIdError);
        return streamId;
      }
    },
    offscreen: {
      createDocument: async (opts) => { calls.offscreen.push(['create', opts]); calls.order.push('createDocument'); offscreenExists = true; },
      closeDocument: async () => { calls.offscreen.push(['close']); calls.order.push('closeDocument'); offscreenExists = false; }
    },
    tabs: {
      onRemoved: { addListener: (fn) => (listeners.onTabRemoved = listeners.onTabRemoved || []).push(fn) }
    },
    action: {
      setBadgeText: (o) => calls.badges.push(o.text),
      setBadgeBackgroundColor: () => {}
    },
    alarms: {
      create: (name, info) => calls.alarms.push(['create', name, info]),
      clear: (name) => calls.alarms.push(['clear', name]),
      onAlarm: { addListener: (fn) => listeners.onAlarm.push(fn) }
    },
    storage: {
      sync: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (obj) => { Object.assign(storage, obj); }
      },
      session: {
        get: async (key) => {
          if (typeof key === 'string') return { [key]: sessionStorage[key] };
          if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, sessionStorage[k]]));
          return { ...sessionStorage };
        },
        set: async (obj) => {
          if (chrome.__sessionSetDelayMs) await new Promise(r => setTimeout(r, chrome.__sessionSetDelayMs));
          Object.assign(sessionStorage, JSON.parse(JSON.stringify(obj)));
        },
        remove: async (keys) => { for (const k of [].concat(keys)) delete sessionStorage[k]; }
      },
      onChanged: { addListener: (fn) => listeners.onStorageChanged.push(fn) }
    },
    __respondTo: {},
    __storage: storage,
    __session: sessionStorage,
    __streamIdError: null,
    __instantComplete: false,
    __searchDelayMs: 0,
    __sessionSetDelayMs: 0,
    __offscreenExists: () => offscreenExists,
    __setOffscreenExists: (v) => { offscreenExists = v; }
  };

  if (downloadsAvailable) {
    chrome.downloads = {
      download: async (opts) => {
        calls.downloads.push(opts);
        const id = nextDownloadId++;
        // __instantComplete: 작은 파일처럼 download()가 끝나기도 전에 이미 완료된 상태를 흉내
        downloadItems.set(id, { id, filename: opts.filename, state: chrome.__instantComplete ? 'complete' : 'in_progress' });
        return id;
      },
      search: async (query) => {
        // 실제 Chrome의 IPC 지연 흉내 (완료 처리 경합 재현용)
        if (chrome.__searchDelayMs) await new Promise(r => setTimeout(r, chrome.__searchDelayMs));
        const items = [...downloadItems.values()];
        if (query && query.id !== undefined) return items.filter(i => i.id === query.id);
        if (query && query.state) return items.filter(i => i.state === query.state);
        return items;
      },
      onChanged: { addListener: (fn) => listeners.onDownloadChanged.push(fn) }
    };
  }

  globalThis.chrome = chrome;

  /** 등록된 onMessage 리스너에 메시지를 보내고 sendResponse 결과를 기다림 */
  const dispatch = (message) => new Promise((resolve) => {
    let responded = false;
    for (const fn of listeners.onMessage) {
      const keep = fn(message, { id: 'fake' }, (response) => { responded = true; resolve(response); });
      if (keep === false && !responded) continue;
    }
    // 아무 리스너도 응답하지 않으면 undefined
    setTimeout(() => { if (!responded) resolve(undefined); }, 50);
  });

  const fireDownloadChanged = (delta) => {
    const item = downloadItems.get(delta.id);
    if (item && delta.state) item.state = delta.state.current;
    listeners.onDownloadChanged.forEach(fn => fn(delta));
  };
  const fireAlarm = (name) => listeners.onAlarm.forEach(fn => fn({ name }));
  const fireTabRemoved = (tabId) => (listeners.onTabRemoved || []).forEach(fn => fn(tabId, {}));

  return { chrome, calls, listeners, dispatch, fireDownloadChanged, fireAlarm, fireTabRemoved };
}
