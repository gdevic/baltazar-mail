// Golden values for the record of a tab's sleeps and what Settings tells of it, in ext/awake.js.
// node tools/awake-test.mjs
const store = {};
globalThis.chrome = { storage: { local: { async get(k) { return { [k]: store[k] }; }, async set(o) { Object.assign(store, structuredClone(o)); } } } };
const { kept, sleeps, note, noteOnce, span, report, wakeNote, steps, browser, held, hold, release, WEEK, SHORT, LONG } = await import("../ext/awake.js");

let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
const now = 1_800_000_000_000, min = 60e3, hour = 3600e3, day = 86400e3;

// lengths as the user reads them
const spans = [[45e3, "45 s"], [400, "1 s"], [min, "1 min"], [12 * min, "12 min"], [hour, "1 h"], [2 * hour + 10 * min, "2 h 10 min"], [47 * hour, "47 h"], [3 * day, "3 days"]];
for (const [ms, want] of spans) ok(span(ms) === want, `span(${ms}) = ${span(ms)}, want ${want}`);

// the record keeps the last week, drops what is too short to matter, and survives bad storage
const old = [now - 8 * day, hour, true], recent = [now - day, 2 * hour, true], brief = [now - hour, SHORT - 1, true], unheld = [now - 2 * hour, 20 * min, false];
ok(JSON.stringify(kept([old, recent, brief, unheld], now)) === JSON.stringify([recent, unheld]), "a week is kept, short sleeps are not");
ok(kept(null, now).length === 0 && kept("x", now).length === 0 && kept([7, null, recent], now).length === 1, "anything else in storage is ignored");
ok(kept([[now - WEEK - hour, 2 * hour, true]], now).length === 1, "a sleep that ended within the week still counts");
ok(kept(Array.from({ length: 80 }, (_, i) => [now - (80 - i) * min * 5, 2 * min, true]), now).length === 50, "at most 50 are kept");
ok(kept([[now + hour, hour, true]], now).length === 0, "a sleep dated after now is not kept");

await note(now - 3 * hour, 30e3, true, now);
ok(store.sleeps === undefined, "a sleep under a minute is not written");
await note(now - 3 * hour, 2 * hour, true, now);
await note(now - 30 * min, 15 * min, false, now);
ok(JSON.stringify(await sleeps(now)) === JSON.stringify([[now - 3 * hour, 2 * hour, true], [now - 30 * min, 15 * min, false]]), "sleeps are appended with whether the lock was held: " + JSON.stringify(store.sleeps));
ok((await sleeps(now + 8 * day)).length === 0, "and are gone a week later");
ok(await noteOnce() === true && await noteOnce() === false && store.sleepNoted === true, "the note about a long sleep is given once");

// what Settings says
const log = await sleeps(now);
const on = report(log, { now, on: true }), off = report(log, { now, on: false });
ok(on.text === "The browser still put this tab to sleep once in the last 7 days, for 2 h." && on.slept === 1 && on.steps, "kept awake, only the sleeps under the lock count, and the steps are offered: " + JSON.stringify(on));
ok(off.text === "The browser put this tab to sleep 2 times in the last 7 days, for 2 h at the longest." && off.slept === 2 && !off.steps, "not kept awake, every sleep counts and no steps are offered: " + JSON.stringify(off));
const none = report([unheld], { now, on: true }), never = report([], { now, on: false });
ok(none.text === "Kept awake: the browser has not put this tab to sleep in the last 7 days." && !none.slept && !none.steps, "kept awake and never slept: " + JSON.stringify(none));
ok(never.text === "The browser may put this tab to sleep in the background. Mail is then checked when you come back to it." && !never.steps, "switched off: " + JSON.stringify(never));
ok(wakeNote(LONG) === "The browser put this tab to sleep for 10 min, so mail was not checked.", "the note: " + wakeNote(LONG));

// the browser's own setting: this copy's address, Edge's page by its address, no guessed page elsewhere
const ID = "enejfhgeailmbkfpdgfdlajlfhnnbafd";
const edge = steps("edge", ID), other = steps("chrome", ID);
ok(edge.copy.value === `chrome-extension://${ID}/` && other.copy.value === edge.copy.value, "the address to add is this copy's, with its scheme and the slash");
ok(edge.open.url === "edge://settings/system" && edge.lines.some(l => l.includes("**Always keep these sites active**")) && edge.lines.some(l => l.includes("**Add site**")), "Edge's steps name its page and labels");
ok(other.open === null && other.lines.length === 2, "another browser gets no page that is not known");
ok(edge.lead.startsWith("Edge has a list") && other.lead.startsWith("The browser has a list"), "each says why, in its browser's name");
const banned = [String.fromCharCode(0x2014), String.fromCharCode(0x2026)];
for (const t of [on.text, off.text, none.text, never.text, wakeNote(LONG), ...edge.lines, ...other.lines, edge.lead, other.lead, edge.open.label, edge.copy.label])
  ok(!banned.some(c => t.includes(c)), "plain punctuation: " + t);

// without Web Locks there is no lock to take, and without brands no browser to name
const be = navigator => Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
be({});
ok(browser() === "other", "no brand, no browser named");
hold(); ok(!held(), "no Web Locks, nothing held");
const asked = [];
be({ locks: { request: (name, run) => { asked.push(name); return Promise.resolve(run()); } }, userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Microsoft Edge" }] } });
hold(); hold();
ok(asked.length === 1 && /^awake-[0-9a-f-]{36}$/.test(asked[0]) && held(), "one lock, under a name of this tab's own: " + asked);
release(); ok(!held(), "release gives it back");
hold(); ok(asked.length === 2 && asked[1] !== asked[0], "and it can be taken again");
release();
ok(browser() === "edge", "Edge is known by its brand");
be({ userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }] }, userAgent: "Chrome/142.0.0.0" });
ok(browser() === "chrome", "Chrome by its");

console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
