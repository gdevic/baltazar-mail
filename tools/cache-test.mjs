// Golden values for the bounded caches and expiring failures in ext/cache.js.
import assert from "node:assert/strict";
import { remember, failure, freshFailure, recent, RETRY_FAILED } from "../ext/cache.js";

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
console.log("cache: PASS");
