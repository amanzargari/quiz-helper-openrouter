// Tiny IndexedDB wrapper for storing extracted course materials.
// Used by the options page (<script src>) and background (importScripts).
(() => {
  const DB_NAME = 'quizhelper';
  const STORE = 'files';     // one record per course file (text already extracted)
  let dbPromise;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('course', 'course', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let out;
      Promise.resolve(fn(store)).then(r => { out = r; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const DB = {
    put: rec => tx('readwrite', s => reqP(s.put(rec))),
    delete: id => tx('readwrite', s => reqP(s.delete(id))),
    all: () => tx('readonly', s => reqP(s.getAll())),
    byCourse: course => tx('readonly', s => reqP(s.index('course').getAll(course))),
    async courses() {
      const recs = await DB.all();
      const m = new Map();
      for (const r of recs) {
        if (r.type === 'parsed') continue;
        const c = m.get(r.course) || { course: r.course, pdfs: 0, texts: 0, images: 0, chars: 0 };
        if (r.type === 'pdf') c.pdfs++;
        else if (r.type === 'image') c.images++;
        else { c.texts++; c.chars += (r.chars || 0); }
        m.set(r.course, c);
      }
      return [...m.values()].sort((a, b) => a.course.localeCompare(b.course));
    },
    async deleteCourse(course) {
      const recs = await DB.byCourse(course);
      await Promise.all(recs.map(r => DB.delete(r.id)));
    },
  };

  (typeof self !== 'undefined' ? self : window).DB = DB;
})();
