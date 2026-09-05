/**
 * Lapex Flash — IndexedDB wrapper for synced Apex class/trigger source.
 * chrome.storage.local's 10MB quota is too small for whole-org Apex
 * source, so this lives in IndexedDB instead (available in the side
 * panel page the same as in any web page).
 */
const DB_NAME = 'lapexflash_metadata';
const DB_VERSION = 1;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sources')) {
        const store = db.createObjectStore('sources', { keyPath: 'key' });
        store.createIndex('orgId', 'orgId', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      }
      if (!db.objectStoreNames.contains('syncs')) {
        db.createObjectStore('syncs', { keyPath: 'orgId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function putSources(orgId, records) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sources', 'syncs'], 'readwrite');
    const store = tx.objectStore('sources');
    const index = store.index('orgId');
    const range = IDBKeyRange.only(orgId);

    const clearReq = index.openCursor(range);
    clearReq.onsuccess = () => {
      const cursor = clearReq.result;
      if (cursor) { cursor.delete(); cursor.continue(); return; }

      let classCount = 0, triggerCount = 0;
      records.forEach(r => {
        store.put({ key: `${orgId}::${r.type}::${r.name}`, orgId, type: r.type, name: r.name, body: r.body, syncedAt: Date.now() });
        if (r.type === 'ApexClass') classCount++; else triggerCount++;
      });

      tx.objectStore('syncs').put({ orgId, lastSyncedAt: Date.now(), classCount, triggerCount });
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getSourcesByOrg(orgId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sources', 'readonly');
    const index = tx.objectStore('sources').index('orgId');
    const req = index.getAll(IDBKeyRange.only(orgId));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getSyncInfo(orgId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('syncs', 'readonly');
    const req = tx.objectStore('syncs').get(orgId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
