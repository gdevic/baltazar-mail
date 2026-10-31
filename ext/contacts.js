import * as api from "./api.js";

// Address book built from the user's own Inbox and Sent headers, kept in IndexedDB.
// One entry per lowercase address: counts of messages sent to and received from it, the display
// names seen (the most frequent one is shown), and the last time it was used.

const DB = "baltazar-mail", STORE = "contacts", META = "meta";
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

// Machine senders, recognized from the address alone (no network, no headers):
//  1. the local part says noreply anywhere, has an unambiguous machine word anywhere
//     (auto-reply, automated, newsletter, info...), or its first word names a role (news,
//     receipts, support...)
//  2. the local part is a generated token: 20+ characters with 6+ digits (bounce/VERP ids)
//  3. the domain is a bulk-mail subdomain (email.x.com, t.x.com, appmail.x.com), a sending
//     domain (x-mail.com, infos-x.com, xemail.com) or under the .email TLD
// Only applied to addresses never written to, so a wrong guess costs one unsuggested stranger.
const NO_REPLY = /no-?reply|do-?not-?reply|dont-?reply/;
const MACHINE_WORD = /-(auto-?reply|auto-?responder|automated|newsletters?|mailer-?daemon|notifications?|bounces?|info)\d*(?=-)/;
const ROLE_WORD = /^(bounces?|notifications?|notify|notices?|alerts?|automated|newsletters?|news|marketing|updates?|mailer|mail|sendmail|reply|postmaster|promo(tions?)?|offers?|deals|messages?|messenger|receipts?|transactions?|orders?|invoices?|billing|statements?|accounts?|edelivery|surveys?|websurvey|membership|rewards|tickets?|info|information|sales|support|service|services|hello|team)\d*$/;
const BULK_LABEL = /mail|^([etom]|em|ma|m\d|msg|txn|news|newsletter|info|infos|update|updates|mkt|marketing|send|bounces?|notify|notifications?|notice|alerts?|reply|promo|offers?|campaign|comms|communications|comunicaciones|messaging|orders?|print)\d*$/;
const BULK_WORD = /^(e?mails?|info|infos|news|notice|notify|surveys?|alerts?|promo|offers?)$/;
export function machineAddress(email) {
  email = email.toLowerCase();
  const at = email.lastIndexOf("@"), local = email.slice(0, at), labels = email.slice(at + 1).split(".");
  const dashed = `-${local.replace(/[._+]/g, "-")}-`;
  if (NO_REPLY.test(dashed) || MACHINE_WORD.test(dashed) || ROLE_WORD.test(local.split(/[._+-]/)[0])) return true;
  if (local.length >= 20 && (local.match(/\d/g) || []).length >= 6) return true;
  const name = labels[labels.length - 2] || "";
  const academic = labels[labels.length - 1] === "edu" || labels.includes("ac");  // mail.uni.edu is a person
  return labels[labels.length - 1] === "email" || (!academic && labels.slice(0, -2).some(l => BULK_LABEL.test(l))) ||
    (name.includes("-") && name.split("-").some(w => BULK_WORD.test(w))) || (name.length > 5 && name.endsWith("email"));
}
const machineMemo = new Map();
const isMachine = email => { let m = machineMemo.get(email); if (m === undefined) machineMemo.set(email, m = machineAddress(email)); return m; };

// hidden: true or false once the user decides; unset, a machine sender never written to is hidden.
export const isHidden = e => e.hidden ?? (!e.sent && isMachine(e.email));

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
  return weight * Math.exp(-days / 120) + (e.sent ? 0.5 : 0) - (e.hidden === undefined && isMachine(e.email) ? 1e6 : 0);
}

// Addresses the user never wants suggested (newsletters and the like). Still counted, never shown.
export async function hide(email, hidden = true) {
  await loadAll();
  const e = cache.get(email.toLowerCase()); if (!e) return;
  e.hidden = hidden;
  await tx(STORE, "readwrite", s => s.put(e));
}

// Every entry, for the address book manager.
export async function all() {
  await loadAll();
  return [...cache.values()].map(e => ({ name: e.name, email: e.email, sent: e.sent || 0, received: e.received || 0, last: e.last || 0, hidden: isHidden(e) }));
}

export async function hideMany(emails, hidden = true) {
  await loadAll();
  const list = emails.map(x => cache.get(String(x).toLowerCase())).filter(Boolean);
  for (const e of list) e.hidden = hidden;
  if (list.length) await tx(STORE, "readwrite", s => { for (const e of list) s.put(e); });
}

export async function hiddenList() {
  await loadAll();
  return [...cache.values()].filter(isHidden).sort((a, b) => a.email.localeCompare(b.email)).map(e => ({ name: e.name, email: e.email }));
}

export async function suggest(query, limit = 8, exclude = new Set()) {
  await loadAll();
  const q = (query || "").trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (const e of cache.values()) {
    if (exclude.has(e.email) || isHidden(e)) continue;
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

export async function lookup(email) {
  await loadAll();
  const e = cache.get(String(email || "").toLowerCase());
  return e ? { name: e.name, email: e.email, sent: e.sent, received: e.received, last: e.last, lastSent: e.lastSent, hidden: isHidden(e) } : null;
}
