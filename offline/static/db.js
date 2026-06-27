const DB = (() => {
  const NAME = "srst-offline";
  const VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("episodes")) db.createObjectStore("episodes", { keyPath: "key" });
        if (!db.objectStoreNames.contains("segments")) db.createObjectStore("segments", { keyPath: "vtt" });
        if (!db.objectStoreNames.contains("favorites")) db.createObjectStore("favorites", { keyPath: "id" });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      t.onerror = () => reject(t.error);
    }));
  }

  const put = (store, value) => tx(store, "readwrite", (s) => s.put(value));
  const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
  const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
  const all = (store) => tx(store, "readonly", (s) => s.getAll());

  return { open, put, get, del, all };
})();
