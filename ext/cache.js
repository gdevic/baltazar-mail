// Small in-memory caches: the newest entries up to a limit, and failures that expire so the
// thing is tried again later.

export const CACHE_MAX = 200, RETRY_FAILED = 60e3;

// Insertion order is age: a write moves the key to the newest end, and the oldest keys go first.
export function remember(map, key, value, max = CACHE_MAX) {
  map.delete(key); map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

export const failure = (now = Date.now()) => ({ failed: now });
export const recent = (time, now = Date.now()) => time != null && now - time < RETRY_FAILED;
export const freshFailure = (c, now = Date.now()) => recent(c?.failed, now);
