// 브라우저 저장소. 실패해도 앱은 동작한다(사생활 보호 모드 등).

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
  json(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
};

// templates: 기존 틀(키 'templates'), exams: 출제 이력, bank: 문항 은행
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open('examMaker', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('templates')) db.createObjectStore('templates');
        if (!db.objectStoreNames.contains('exams')) db.createObjectStore('exams', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('bank')) db.createObjectStore('bank', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

async function run(name, mode, fn) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const t = db.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const idb = {
  async get(name, key) { try { return await run(name, 'readonly', (s) => s.get(key)); } catch { return undefined; } },
  async all(name) { try { return (await run(name, 'readonly', (s) => s.getAll())) || []; } catch { return []; } },
  async put(name, value, key) {
    try { await run(name, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))); return true; } catch { return false; }
  },
  async del(name, key) { try { await run(name, 'readwrite', (s) => s.delete(key)); return true; } catch { return false; } },
  async clear(name) { try { await run(name, 'readwrite', (s) => s.clear()); return true; } catch { return false; } },
};
