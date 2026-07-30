const CACHE_PREFIX = 'fc_';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;

export async function getCache(videoId) {
  const key = CACHE_PREFIX + videoId;
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry;
}

export async function setCache(videoId, data) {
  const key = CACHE_PREFIX + videoId;
  const existing = await chrome.storage.local.get(key);
  const merged = { ...(existing[key] || {}), ...data, timestamp: Date.now() };
  await chrome.storage.local.set({ [key]: merged });
  await enforceMaxEntries();
  return merged;
}

async function enforceMaxEntries() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith(CACHE_PREFIX));
  if (entries.length <= MAX_ENTRIES) return;
  entries.sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
  const toRemove = entries.slice(0, entries.length - MAX_ENTRIES).map(([k]) => k);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}
