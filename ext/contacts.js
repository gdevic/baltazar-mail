import * as api from "./api.js";

// Address book built from the user's own Inbox and Sent headers, kept in IndexedDB.
// One entry per lowercase address: counts of messages sent to and received from it, the display
// names seen (the most frequent one is shown), and the last time it was used.

const DB = "ymail-lite", STORE = "contacts", META = "meta";
let db = null;
let own = new Set();
let cache = null;          // Map email -> entry, loaded once; writes go through to IndexedDB
const SCAN_PAGE = 100;

function openDb() {
  if (db) return Promise.resolve(db);
  return new Promise((ok, no) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { const d = req.result; d.createObjectStore(STORE, { keyPath: "email" }); d.createObjectStore(META, { keyPath: "key" }); };
    req.onsuccess = () => ok(db = req.result);
    req.onerror = () => no(req.error);
  });
}

const tx = (store, mode, fn) => openDb().then(d => new Promise((ok, no) => {
  const t = d.transaction(store, mode), s = t.objectStore(store);
  const r = fn(s);
  t.oncomplete = () => ok(r && r.result !== undefined ? r.result : r);
  t.onerror = () => no(t.error);
}));

async function loadAll() {
  if (cache) return cache;
  const rows = await tx(STORE, "readonly", s => s.getAll());
  cache = new Map((rows || []).map(r => [r.email, r]));
  return cache;
}

export function setOwnAddresses(list) { own = new Set(list.map(e => e.toLowerCase())); }

const isNoReply = e => /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?)[@.+-]/i.test(e);

// Record one message's addresses. direction: "sent" (we wrote it) or "received".
async function record(m, direction, pending) {
  const h = m.headers || {}; const when = Number(h.date) || 0;
  const lists = direction === "sent" ? [h.to, h.cc, h.bcc] : [h.from, h.to, h.cc];
  for (const list of lists) for (const a of list || []) {
    const email = (a.email || "").trim().toLowerCase();
    if (!email || !email.includes("@") || own.has(email)) continue;
    const e = pending.get(email) || cache.get(email) || { email, name: "", names: {}, sent: 0, received: 0, last: 0, lastSent: 0 };
    if (a.name && a.name.trim()) { const n = a.name.trim(); e.names[n] = (e.names[n] || 0) + 1; }
    if (direction === "sent") { e.sent++; e.lastSent = Math.max(e.lastSent, when); } else e.received++;
    e.last = Math.max(e.last, when);
    pending.set(email, e);
  }
}

async function flush(pending) {
  if (!pending.size) return;
  for (const e of pending.values()) {
    e.name = Object.entries(e.names).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    cache.set(e.email, e);
  }
  await tx(STORE, "readwrite", s => { for (const e of pending.values()) s.put(e); });
  pending.clear();
}

async function getMeta(key) { const r = await tx(META, "readonly", s => s.get(key)); return r ? r.value : null; }
async function setMeta(key, value) { await tx(META, "readwrite", s => s.put({ key, value })); }

// Walk a folder newest-first. full: everything; otherwise stop at messages older than the last scan.
async function scanFolder(folderId, direction, full, progress) {
  await loadAll();
  const metaKey = `scan:${folderId}`;
  const prev = full ? null : await getMeta(metaKey);
  const newestSeen = prev?.newest || 0;
  let offset = 0, newest = newestSeen, done = false, seen = 0;
  const pending = new Map();
  while (!done) {
    const r = await api.list(folderId, SCAN_PAGE, offset);
    for (const m of r.messages) {
      const when = Number(m.headers?.date) || 0;
      if (!full && when <= newestSeen) { done = true; break; }
      await record(m, direction, pending);
      newest = Math.max(newest, when); seen++;
    }
    offset += r.messages.length;
    if (r.messages.length < SCAN_PAGE) done = true;
    if (pending.size >= 300) await flush(pending);
    progress?.(folderId, seen);
  }
  await flush(pending);
  await setMeta(metaKey, { newest, at: Date.now() });
  return seen;
}

// Initial build (first run) or incremental refresh. inbox/sent are folder ids.
export async function sync({ inbox, sent, full = false, progress } = {}) {
  await loadAll();
  const built = await getMeta("built");
  const doFull = full || !built;
  let n = 0;
  if (sent) n += await scanFolder(sent, "sent", doFull, progress);
  if (inbox) n += await scanFolder(inbox, "received", doFull, progress);
  if (doFull) await setMeta("built", Date.now());
  return n;
}

export async function isBuilt() { return !!(await getMeta("built")); }

// Called after the user sends a message, so new recipients rank at once.
export async function noteSent(recipients) {
  await loadAll();
  const pending = new Map();
  await record({ headers: { to: recipients, date: String(Math.floor(Date.now() / 1000)) } }, "sent", pending);
  await flush(pending);
}

// Recency first, frequency second: a correspondent used recently outranks a frequent old one,
// but frequent correspondents stay above strangers of similar age.
function score(e, now) {
  const days = Math.max(0, (now - e.last) / 86400);
  const weight = e.sent * 3 + e.received;
  return weight * Math.exp(-days / 120) + (e.sent ? 0.5 : 0) - (isNoReply(e.email) ? 1e6 : 0);
}

// Addresses the user never wants suggested (newsletters and the like). Still counted, never shown.
export async function hide(email, hidden = true) {
  await loadAll();
  const e = cache.get(email.toLowerCase()); if (!e) return;
  e.hidden = hidden;
  await tx(STORE, "readwrite", s => s.put(e));
}

export async function hiddenList() {
  await loadAll();
  return [...cache.values()].filter(e => e.hidden).sort((a, b) => a.email.localeCompare(b.email)).map(e => ({ name: e.name, email: e.email }));
}

export async function suggest(query, limit = 8, exclude = new Set()) {
  await loadAll();
  const q = (query || "").trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (const e of cache.values()) {
    if (exclude.has(e.email) || e.hidden) continue;
    if (q) {
      const name = e.name.toLowerCase();
      const words = name.split(/\s+/);
      const hit = e.email.startsWith(q) || name.startsWith(q) || words.some(w => w.startsWith(q)) || e.email.slice(e.email.indexOf("@") + 1).startsWith(q) || e.email.includes(q);
      if (!hit) continue;
    }
    rows.push(e);
  }
  rows.sort((a, b) => (q ? score(b, now) - score(a, now) : b.last - a.last) || b.sent - a.sent);
  return rows.slice(0, limit).map(e => ({ name: e.name, email: e.email }));
}

export async function count() { await loadAll(); return cache.size; }
