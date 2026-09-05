/**
 * Lapex Flash — Generic TTL/LRU cache
 * Service workers can be evicted after ~30s idle, wiping module-scope
 * state — every write is also mirrored to chrome.storage.local so a
 * fresh worker can rehydrate instead of losing the cache entirely.
 */
const CACHE_TTL_MS      = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_ENTRIES = 500;

function setCacheItem(cacheObj, key, data, storageKey) {
  const keys = Object.keys(cacheObj);
  if (keys.length >= MAX_CACHE_ENTRIES) {
    keys.slice(0, 50).forEach(k => delete cacheObj[k]);
  }
  cacheObj[key] = { timestamp: Date.now(), data };
  if (storageKey) {
    chrome.storage.local.set({ [storageKey]: cacheObj }).catch(() => {});
  }
}

function getCacheItem(cacheObj, key) {
  const item = cacheObj[key];
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL_MS) {
    delete cacheObj[key];
    return null;
  }
  return item.data;
}

const hydratedKeys = new Set();

/** Lazily loads a persisted cache object from storage, once per SW lifetime. */
async function hydrateCacheFromStorage(cacheObj, storageKey) {
  if (hydratedKeys.has(storageKey)) return;
  hydratedKeys.add(storageKey);
  try {
    const stored = await chrome.storage.local.get(storageKey);
    const saved  = stored[storageKey];
    if (saved && typeof saved === 'object') {
      Object.assign(cacheObj, saved);
    }
  } catch (_) {}
}
