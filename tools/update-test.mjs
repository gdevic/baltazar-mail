// Golden values for the release check in ext/update.js. node tools/update-test.mjs
const store = {};
globalThis.chrome = { storage: { local: { async get(k) { return { [k]: store[k] }; }, async set(o) { Object.assign(store, o); } } } };
let calls = 0, tag = "v0.15.0", lastInit = null;
globalThis.fetch = async (url, init) => { calls++; lastInit = init; return { ok: true, json: async () => ({ tag_name: tag }) }; };
const { newer, latest } = await import("../ext/update.js");

let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
ok(newer("0.15.0", "0.14.0") && newer("1.0.0", "0.99.99") && newer("0.14.10", "0.14.9"), "newer versions");
ok(!newer("0.14.0", "0.14.0") && !newer("0.9.9", "0.14.0"), "same or older");
const t = 1e12;
ok(await latest(t) === "0.15.0" && calls === 1, "first check asks GitHub");
ok(lastInit.credentials === "omit" && lastInit.referrerPolicy === "no-referrer", "no cookies, no referrer");
ok(await latest(t + 3600e3) === "0.15.0" && calls === 1, "answer reused within a day");
ok(await latest(t + 86400e3) === "0.15.0" && calls === 2, "asks again after a day");
tag = "<b>1.0</b>";
ok(await latest(t + 2 * 86400e3) === "0.15.0" && store.updateCheck.next === t + 2 * 86400e3 + 3600e3, "bad tag ignored, retried in an hour");
globalThis.fetch = async () => { calls++; throw new TypeError("offline"); };
ok(await latest(t + 3 * 86400e3) === "0.15.0", "offline keeps the last answer");
const before = calls; await Promise.all([latest(t + 9e9), latest(t + 9e9)]);
ok(calls === before + 1, "concurrent checks share one request");
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
