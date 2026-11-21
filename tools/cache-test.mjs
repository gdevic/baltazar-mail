// Golden values for the bounded caches and expiring failures in ext/cache.js.
import assert from "node:assert/strict";
import { remember, rememberUntil, failure, freshFailure, recent, RETRY_FAILED } from "../ext/cache.js";

const m = new Map();
for (let i = 0; i < 5; i++) remember(m, i, i, 3);
assert.deepEqual([...m.keys()], [2, 3, 4]);
remember(m, 2, "again", 3);                 // a rewrite makes the key newest
remember(m, 5, 5, 3);
assert.deepEqual([...m.keys()], [4, 2, 5]);
assert.equal(m.get(2), "again");

const t = 1e12;
assert.equal(freshFailure(failure(t), t), true);
assert.equal(freshFailure(failure(t), t + RETRY_FAILED - 1), true);
assert.equal(freshFailure(failure(t), t + RETRY_FAILED), false);
assert.equal(freshFailure("data:image/png;base64,AA", t), false);
assert.equal(freshFailure(undefined, t), false);
assert.equal(recent(undefined, t), false);
assert.equal(recent(t - 1, t), true);
assert.equal(recent(t - RETRY_FAILED, t), false);
// a cache bounded by bytes: what came replaces its promise in place, and the oldest that came go
// until the rest fits, the newest kept even alone over the limit
{
  const c = new Map(), opts = { max: 10, maxBytes: 10, sizeOf: v => v.length };
  const waiting = new Promise(() => {});
  rememberUntil(c, "slow", waiting, opts);
  for (const k of ["a", "b", "c"]) await rememberUntil(c, k, Promise.resolve("xxxx"), opts);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual([...c.keys()], ["slow", "b", "c"]);
  assert.equal(c.get("slow"), waiting);
  assert.equal(c.get("c"), "xxxx");
  await rememberUntil(c, "big", Promise.resolve("x".repeat(30)), opts);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual([...c.keys()], ["slow", "big"]);
}
console.log("cache: PASS");
