// Small in-memory caches: the newest entries up to a limit, and failures that expire so the
// thing is tried again later.

const CACHE_MAX = 200;
export const RETRY_FAILED = 60e3;

// Insertion order is age: a write moves the key to the newest end, and the oldest keys go first.
export function remember(map, key, value, max = CACHE_MAX) {
  map.delete(key); map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

// For a value that comes later: the promise is kept until it comes, so that callers meanwhile share
// it, then what came, in the same place; and while the values come weigh more than maxBytes (by
// sizeOf), the oldest of them go, the one just come aside.
export function rememberUntil(map, key, promise, { max = CACHE_MAX, maxBytes = Infinity, sizeOf = () => 0 } = {}) {
  remember(map, key, promise, max);
  promise.then(v => {
    if (map.get(key) !== promise) return;
    map.set(key, v);
    let total = 0;
    for (const x of map.values()) if (!(x instanceof Promise)) total += sizeOf(x);
    for (const [k, x] of map) {
      if (total <= maxBytes) break;
      if (k === key || x instanceof Promise) continue;
      total -= sizeOf(x); map.delete(k);
    }
  }, () => {});
  return promise;
}

export const failure = (now = Date.now()) => ({ failed: now });
export const recent = (time, now = Date.now()) => time != null && now - time < RETRY_FAILED;
export const freshFailure = (c, now = Date.now()) => recent(c?.failed, now);
