// IndexedDB 가짜 구현 (Node 테스트용) - save-location.js가 쓰는 범위만 흉내
// open(+onupgradeneeded) / objectStore put·get·delete / 트랜잭션 oncomplete 순서를 실제처럼 비동기로 재현합니다.
// 값은 참조 그대로 보관합니다 (실제 IndexedDB는 구조화 복제로 FileSystemDirectoryHandle을 저장).

const later = (fn) => setTimeout(fn, 0);

function makeRequest() {
  return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
}

export function createFakeIndexedDB({ failOpen = null } = {}) {
  const databases = new Map(); // name → { version, stores: Map<storeName, Map<key, value>> }
  const stats = { opens: 0, closes: 0, transactions: [] };

  function makeStore(data, tx) {
    const op = (fn) => {
      const req = makeRequest();
      tx.pending++;
      later(() => {
        try {
          req.result = fn();
          if (req.onsuccess) req.onsuccess({ target: req });
        } catch (error) {
          req.error = error;
          tx.error = error;
          if (req.onerror) req.onerror({ target: req });
          if (tx.onerror) tx.onerror({ target: tx });
        }
        tx.pending--;
        tx.settle();
      });
      return req;
    };
    const writable = () => {
      if (tx.mode !== 'readwrite') throw new DOMException('읽기 전용 트랜잭션', 'ReadOnlyError');
    };
    return {
      put: (value, key) => { writable(); return op(() => { data.set(key, value); return key; }); },
      get: (key) => op(() => data.get(key)),
      delete: (key) => { writable(); return op(() => { data.delete(key); return undefined; }); }
    };
  }

  function makeDb(name, entry) {
    const db = {
      name,
      upgrading: false,
      closed: false,
      get version() { return entry.version; },
      objectStoreNames: { contains: (n) => entry.stores.has(n) },
      createObjectStore(n) {
        if (!db.upgrading) throw new DOMException('upgrade 중에만 생성 가능', 'InvalidStateError');
        entry.stores.set(n, new Map());
      },
      transaction(storeNames, mode = 'readonly') {
        if (db.closed) throw new DOMException('닫힌 연결', 'InvalidStateError');
        for (const n of [].concat(storeNames)) {
          if (!entry.stores.has(n)) throw new DOMException(`저장소 없음: ${n}`, 'NotFoundError');
        }
        const tx = {
          mode,
          pending: 0,
          done: false,
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: (n) => makeStore(entry.stores.get(n), tx),
          settle() {
            if (tx.done || tx.pending > 0) return;
            tx.done = true;
            later(() => {
              if (tx.error) { if (tx.onabort) tx.onabort({ target: tx }); return; }
              if (tx.oncomplete) tx.oncomplete({ target: tx });
            });
          }
        };
        stats.transactions.push(mode);
        // 요청이 하나도 없으면 다음 틱에 완료
        later(() => tx.settle());
        return tx;
      },
      close() { db.closed = true; stats.closes++; }
    };
    return db;
  }

  return {
    open(name, version = 1) {
      const req = makeRequest();
      stats.opens++;
      later(() => {
        if (failOpen) {
          req.error = failOpen;
          if (req.onerror) req.onerror({ target: req });
          return;
        }
        let entry = databases.get(name);
        if (!entry) { entry = { version: 0, stores: new Map() }; databases.set(name, entry); }
        const db = makeDb(name, entry);
        req.result = db;
        if (version > entry.version) {
          const oldVersion = entry.version;
          entry.version = version;
          db.upgrading = true;
          try { if (req.onupgradeneeded) req.onupgradeneeded({ oldVersion, newVersion: version, target: req }); } finally { db.upgrading = false; }
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    /** 테스트 검사용: 저장된 값 직접 조회 */
    peek(dbName, storeName, key) {
      const entry = databases.get(dbName);
      const store = entry && entry.stores.get(storeName);
      return store ? store.get(key) : undefined;
    },
    databases,
    stats
  };
}
