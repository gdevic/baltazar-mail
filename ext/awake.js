// Keeping the mail tab awake in the background, and a record of the times the browser put it to
// sleep all the same.
//
// A browser may freeze a tab the user has left (Edge's sleeping tabs after a set time; Chrome a
// tab that works hard while Energy Saver is on), and a frozen tab checks no mail. Both leave
// alone a page that holds a Web Lock, so hold() takes one and release() gives it back; each tab
// takes a lock of its own name, so two mail tabs never wait for each other. The page itself hears
// "freeze" and "resume", so watch() can tell how long a sleep lasted; a computer that slept sends
// neither, and is not counted. The sleeps of the last WEEK are kept in the extension's storage
// (SLEEPS: [[start, length, held], ...], times in ms, held: the lock was held), so Settings can
// say what happened. The browser's own list of pages it never puts to sleep is the other way to
// stay awake, and the way out when a tab holding the lock slept anyway: steps() says how to add
// this copy to it. This file names no mail service.

const SLEEPS = "sleeps", NOTED = "sleepNoted";
export const WEEK = 7 * 86400e3;
export const SHORT = 60e3;        // a sleep shorter than this cost no mail check worth telling
export const LONG = 10 * 60e3;    // a sleep this long is worth a note when the tab was to stay awake
const KEEP = 50;

// ---------- the lock ----------
let free = null;                  // gives the lock back, while it is held or asked for
export function hold() {
  if (free || !globalThis.navigator?.locks) return;
  const gone = new Promise(ok => { free = ok; });
  navigator.locks.request(`awake-${crypto.randomUUID()}`, () => gone).catch(() => {});
}
export function release() { free?.(); free = null; }
export const held = () => !!free;

// ---------- the record ----------
// The entries of log that still count at now: the last week's, the newest KEEP of them.
export const kept = (log, now) => (Array.isArray(log) ? log : [])
  .filter(e => Array.isArray(e) && e[0] <= now && (e[0] + e[1]) > (now - WEEK) && e[1] >= SHORT).slice(-KEEP);

export async function sleeps(now = Date.now()) {
  return kept((await chrome.storage.local.get(SLEEPS))[SLEEPS], now);
}
export async function note(start, length, wasHeld, now = Date.now()) {
  if (length < SHORT) return;
  await chrome.storage.local.set({ [SLEEPS]: kept([...(await sleeps(now)), [start, length, !!wasHeld]], now) });
}

// Calls back with (start, length) each time the page wakes from a freeze.
export function watch(onWake) {
  let frozenAt = 0;
  document.addEventListener("freeze", () => { frozenAt = Date.now(); });
  document.addEventListener("resume", () => {
    const start = frozenAt;
    frozenAt = 0;
    if (start) onWake(start, Date.now() - start);
  });
}

// The note about a long sleep is shown once per installation.
export async function noteOnce() {
  if ((await chrome.storage.local.get(NOTED))[NOTED]) return false;
  await chrome.storage.local.set({ [NOTED]: true });
  return true;
}

// ---------- what to tell ----------
// "45 s", "12 min", "2 h 10 min", "3 days".
export function span(ms) {
  const min = Math.round(ms / 60e3);
  if (ms < 60e3) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `${Math.round(min / 1440)} days`;
}

// What Settings says under the switch. on: the tab is to stay awake, and then only the sleeps it
// had while holding the lock count. steps: the browser's own setting is the way out.
export function report(log, { now, on }) {
  const mine = kept(log, now).filter(e => !on || e[2]);
  if (!mine.length) return {
    text: on ? "Kept awake: the browser has not put this tab to sleep in the last 7 days."
      : "The browser may put this tab to sleep in the background. Mail is then checked when you come back to it.",
    slept: 0, steps: false };
  const longest = span(Math.max(...mine.map(e => e[1])));
  const many = mine.length === 1 ? `once in the last 7 days, for ${longest}` : `${mine.length} times in the last 7 days, for ${longest} at the longest`;
  return { text: on ? `The browser still put this tab to sleep ${many}.` : `The browser put this tab to sleep ${many}.`, slept: mine.length, steps: on };
}

// The note for a tab that was to stay awake and slept for length.
export const wakeNote = length => `The browser put this tab to sleep for ${span(length)}, so mail was not checked.`;

export function browser() {
  const brands = globalThis.navigator?.userAgentData?.brands?.map(b => b.brand) || [];
  if (brands.includes("Microsoft Edge") || /\bEdg\//.test(globalThis.navigator?.userAgent || "")) return "edge";
  return brands.includes("Google Chrome") ? "chrome" : "other";
}

// The browser's own list of pages it never puts to sleep, for the copy of the extension with
// this id: why, the address to add, the page of settings where one is known, and what to do there.
export function steps(which, id) {
  const copy = { label: "This copy's address", value: `chrome-extension://${id}/` };
  const lead = `${which === "edge" ? "Edge" : "The browser"} has a list of its own of sites it never puts to sleep. A tab of this copy, once on that list, stays awake whatever the switch above says.`;
  if (which === "edge") return { lead, copy, open: { label: "Open Edge's settings", url: "edge://settings/system" },
    lines: ["Copy the address above, then open Edge's settings.", "Find **Always keep these sites active**, in the part about sleeping tabs, and click **Add site**.", "Paste the address and click **Add**."] };
  return { lead, copy, open: null,
    lines: ["Copy the address above.", "In the browser's settings, look under performance for the list of sites it always keeps active, and add the address there."] };
}
