// IndexedDB wrapper for FXBG Palantir offline persistence
const DB_NAME = 'fxbg_city_manager';
const DB_VERSION = 1;

let db = null;

export async function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('events')) {
        const events = db.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains('reports')) {
        const reports = db.createObjectStore('reports', { keyPath: 'id' });
        reports.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
  });
}

export async function saveEvents(events) {
  const tx = db.transaction('events', 'readwrite');
  for (const evt of events) await tx.objectStore('events').put(evt);
  return tx.complete;
}

export async function getEvents() {
  const tx = db.transaction('events', 'readonly');
  return await tx.objectStore('events').getAll();
}

export async function saveMeta(key, value) {
  const tx = db.transaction('meta', 'readwrite');
  await tx.objectStore('meta').put({ key, value });
}

export async function getMeta(key) {
  const tx = db.transaction('meta', 'readonly');
  const result = await tx.objectStore('meta').get(key);
  return result?.value;
}

export async function saveReports(reports) {
  const tx = db.transaction('reports', 'readwrite');
  for (const r of reports) await tx.objectStore('reports').put(r);
}

export async function getReports() {
  const tx = db.transaction('reports', 'readonly');
  return await tx.objectStore('reports').getAll();
}
