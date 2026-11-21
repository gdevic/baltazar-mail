import * as api from "./api.js";
import { noBidi } from "./text.js";

// Address book built from the headers of the user's own mail (every folder but Spam, Trash and
// Drafts when the book is first built, Inbox and Sent from then on), kept in IndexedDB. It feeds
// the address suggestions (while writing, and in the search box) and the Contacts view (people.js).
// One entry per lowercase address: the display names seen, when mail last went either way, when
// the user last wrote to it, whether mail was copied to it (Cc or Bcc), and the user's own choices
// about it (hidden, pinned).
// Nothing is counted; recency is all the ranking needs.
// The book mirrors the mail that is kept: an entry with no mail left outside Spam and Trash is
// forgotten when that is found out (forget), unless the user pinned it or hid it, or mail was
// copied to it; a hidden sender that writes again is then still hidden.

// The address book has a version, DB_VERSION, kept with the database itself (it is the IndexedDB
// version). It stands for what a build records about an address and which mail it reads: raise it
// by one with any change that makes a book built before no longer what a build would now give,
// and every such book is invalidated, once, the first time the new version opens it:
//  - a book of a lower version has its build unmarked (the meta store, with the scan's bookmarks,
//    is emptied of all but the account the book is kept for, so that another account signing in
//    still starts afresh), so it is built anew as a first build is, keeping all that the user
//    chose for an address (CHOICES, see resetRows): the user did not ask for this build, so it
//    takes nothing of theirs away, unlike a Rebuild (rebuild);
//  - a book of a higher version, which a newer copy of the extension made, cannot be opened as
//    this one at all: it is dropped whole, the user's choices with it, and a new one begun.
// A book of this version is kept as built, however often it is opened.
export const DB_VERSION = 2;
const DB = "baltazar-mail", STORE = "contacts", META = "meta";
let db = null, opening = null;
let own = new Set();
let cache = null;          // Map email -> entry, loaded once; writes go through to IndexedDB
const SCAN_PAGE = 100;
const EVERYWHERE = "*";    // in place of a folder id: all mail, whatever folder it is in (api.listAll)

// The one connection, opened once however many ask at the same time, with the book brought to
// DB_VERSION as said there. It is given up when another tab needs the database to itself (to bring
// it to another version, or to drop it), and opened again when next needed.
function openDb() {
  if (db) return Promise.resolve(db);
  const open = () => new Promise((ok, no) => {
    const req = indexedDB.open(DB, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = req.result;
      // an older book is built anew, for the account it was kept for
      if (e.oldVersion) { const meta = req.transaction.objectStore(META); meta.delete(IDBKeyRange.upperBound("account", true)); meta.delete(IDBKeyRange.lowerBound("account", true)); }
      else { d.createObjectStore(STORE, { keyPath: "email" }); d.createObjectStore(META, { keyPath: "key" }); }
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
  const drop = () => new Promise((ok, no) => { const req = indexedDB.deleteDatabase(DB); req.onsuccess = () => ok(); req.onerror = () => no(req.error); });
  return opening ||= open().catch(e => e?.name === "VersionError" ? drop().then(open) : Promise.reject(e)).then(d => {
    d.onversionchange = () => { d.close(); if (db === d) { db = null; opening = null; cache = null; } };
    return (db = d);
  }, e => { opening = null; throw e; });
}

const tx = (store, mode, fn) => openDb().then(d => new Promise((ok, no) => {
  const t = d.transaction(store, mode), s = t.objectStore(store);
  const r = fn(s);
  t.oncomplete = () => ok(r && r.result !== undefined ? r.result : r);
  t.onerror = () => no(t.error);
}));

// Tabs share the store: after a write, the others drop their copy and read it again when next
// needed. Writes merge into what is stored, inside one transaction, so no tab undoes another's.
let bc = null;
function channel() {
  if (!bc && typeof BroadcastChannel !== "undefined") { bc = new BroadcastChannel("baltazar-contacts"); bc.onmessage = () => { cache = null; }; bc.unref?.(); }
  return bc;
}
const changed = () => channel()?.postMessage("changed");
// mutate(stored or undefined, email) -> the row to store, or null to leave it; returns the rows written.
const updateRows = (emails, mutate) => openDb().then(d => new Promise((ok, no) => {
  const t = d.transaction(STORE, "readwrite"), s = t.objectStore(STORE), out = [];
  for (const email of emails) {
    const r = s.get(email);
    r.onsuccess = () => { const row = mutate(r.result, email); if (row) { s.put(row); out.push(row); } };
  }
  t.oncomplete = () => { for (const row of out) cache?.set(row.email, row); changed(); ok(out); };
  t.onerror = () => no(t.error);
}));

async function loadAll() {
  channel();
  if (cache) return cache;
  const rows = await tx(STORE, "readonly", s => s.getAll());
  cache = new Map((rows || []).map(r => [r.email, r]));
  return cache;
}

export function setOwnAddresses(list) { own = new Set(list.map(e => e.toLowerCase())); }
// The Inbox's folder id, as the sync is told it (see isOwn).
let inboxFolder = null;
export function setInbox(id) { inboxFolder = id == null ? null : String(id); }

// Machine senders, recognized from the address alone (no network, no headers):
//  1. the local part says noreply anywhere, has an unambiguous machine word anywhere
//     (auto-reply, automated, newsletter, unsubscribe, info...), or its first word names a
//     role (news, receipts, support...)
//  2. the local part is a generated token: 20+ characters with 6+ digits (bounce/VERP ids)
//  3. the domain is a bulk-mail subdomain (email.x.com, t.x.com, appmail.x.com), a sending
//     domain (x-mail.com, infos-x.com, xemail.com) or under the .email TLD
// Only applied to addresses never written to, and rule 3 only to those never copied on mail (see
// guessed), so a wrong guess costs one unsuggested stranger.
const NO_REPLY = /no-?reply|do-?not-?reply|dont-?reply/;
const MACHINE_WORD = /-(auto-?reply|auto-?responder|automated|newsletters?|mailer-?daemon|notifications?|bounces?|unsubscribe|info)\d*(?=-)/;
const ROLE_WORD = /^(bounces?|notifications?|notify|notices?|alerts?|automated|newsletters?|news|marketing|updates?|mailer|mail|sendmail|reply|postmaster|promo(tions?)?|offers?|deals|messages?|messenger|receipts?|transactions?|orders?|invoices?|billing|statements?|accounts?|edelivery|surveys?|websurvey|membership|rewards|tickets?|info|information|sales|support|service|services|hello|team)\d*$/;
const BULK_LABEL = /mail|^([etom]|em|ma|m\d|msg|txn|news|newsletter|info|infos|update|updates|mkt|marketing|send|bounces?|notify|notifications?|notice|alerts?|reply|promo|offers?|campaign|comms|communications|comunicaciones|messaging|orders?|print)\d*$/;
const BULK_WORD = /^(e?mails?|info|infos|news|notice|notify|surveys?|alerts?|promo|offers?)$/;
const SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|ne|or|go|gob|gen|ltd|plc|nic|mil)$/;
// Which part of an address says machine: its local part (rules 1 and 2) or its domain (rule 3).
function machineParts(email) {
  email = email.toLowerCase();
  const at = email.lastIndexOf("@"), local = email.slice(0, at), labels = email.slice(at + 1).split(".");
  // The registrable domain is two labels, or three under a country's second level (hotmail.co.uk)
  const n = labels.length, sld = n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL.test(labels[n - 2]) ? 3 : 2;
  const dashed = `-${local.replace(/[._+]/g, "-")}-`;
  const byLocal = NO_REPLY.test(dashed) || MACHINE_WORD.test(dashed) || ROLE_WORD.test(local.split(/[._+-]/)[0]) || (local.length >= 20 && (local.match(/\d/g) || []).length >= 6);
  const name = labels[n - sld] || "";
  const academic = labels[n - 1] === "edu" || labels.includes("ac");  // mail.uni.edu is a person
  const byDomain = labels[n - 1] === "email" || (!academic && labels.slice(0, -sld).some(l => BULK_LABEL.test(l))) ||
    (name.includes("-") && name.split("-").some(w => BULK_WORD.test(w))) || (name.length > 5 && name.endsWith("email"));
  return { local: byLocal, domain: byDomain };
}
export function machineAddress(email) { const m = machineParts(email); return m.local || m.domain; }
const machineMemo = new Map();
const machineOf = email => { let m = machineMemo.get(email); if (m === undefined) machineMemo.set(email, m = machineParts(email)); return m; };

// What the user chose for an entry, which no mail tells and a full build keeps (a Rebuild only
// REBUILT of it): hidden (true or false; unset while the user has not said), pinned (when), given
// (the user's own name for it), added (the user put the address in the book, where it stays though
// no mail names it) and deleted (the user deleted the contact: the entry stays stored, so that the
// address is known to be unwanted whatever mail names it later, until a Rebuild, and is in no list,
// count or suggestion).
const CHOICES = ["hidden", "pinned", "given", "added", "deleted"];
const REBUILT = ["pinned", "given"];
const chosen = e => e.hidden !== undefined || !!e.pinned || !!e.given || !!e.added || !!e.deleted;

// The guess about an entry. An address named for a role or a machine (info@, noreply@) is one
// wherever it is seen. A domain that looks like a bulk sender's says nothing of an address mail
// was copied to: whoever wrote that mail named it as one of its readers, and a person's mailbox
// at a provider's email. subdomain is the likelier one.
const guessed = e => { const m = machineOf(e.email); return m.local || (m.domain && !e.copied); };

// hidden: true or false once the user decides; unset, a machine sender never written to is hidden.
export const isHidden = e => e.hidden ?? (!e.lastSent && guessed(e));

// A display name is only as good as whoever wrote it. Names are kept by source, best first: the
// user's own (recipients of mail they sent), the person's own (the From of mail they sent), and
// anyone else's (other recipients of received mail, which any sender can label as they like).
// The shown name is the most frequent of the best source that has one, unless the user gave the
// entry a name of their own (given), which is shown before any of them. names holds names recorded
// before sources were kept, and counts as anyone else's.
const SOURCES = ["mine", "self", "others"];
const NAMES_KEPT = 8, NAME_MAX = 100;
export function noteName(e, raw, source) {
  const n = noBidi(raw).trim().slice(0, NAME_MAX);
  if (!n) return;
  const m = ((e.nameBy ||= {})[source] ||= {});
  m[n] = (m[n] || 0) + 1;
  const keys = Object.keys(m);
  if (keys.length > NAMES_KEPT) delete m[keys.reduce((lo, k) => m[k] < m[lo] ? k : lo)];
}
export function bestName(e) {
  if (e.given) return e.given;
  for (const s of SOURCES) {
    const m = { ...(s === "others" ? e.names : null), ...e.nameBy?.[s] };
    const top = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
    if (top) return top[0];
  }
  return "";
}

// Whether the user wrote a message: its From is one of the user's own addresses, wherever the
// message is kept (a copy to oneself, or a reply filed beside its original, is in no Sent folder),
// except in Inbox: mail arrives there with whatever From its sender writes, so a message there is
// taken as received until the user files it elsewhere.
const isOwn = m => own.has((m.headers?.from?.[0]?.email || "").trim().toLowerCase()) && !(inboxFolder && String(m.folder?.id) === inboxFolder);

// Record one message's addresses into pending (address -> what this scan adds). A message the user
// wrote (inSent: it was read from Sent; otherwise its From says so) tells whom the user wrote to;
// any other tells who wrote, and who else was named. An address in a Cc or Bcc is marked copied.
export function record(m, pending, inSent = false) {
  const h = m.headers || {}, when = Number(h.date) || 0, mine = inSent || isOwn(m);
  const lists = mine ? [h.to, h.cc, h.bcc] : [h.from, h.to, h.cc];
  for (const list of lists) for (const a of list || []) {
    const email = (a.email || "").trim().toLowerCase();
    if (!email || !email.includes("@") || own.has(email)) continue;
    const e = pending.get(email) || { email, nameBy: {}, last: 0, lastSent: 0, copied: false };
    noteName(e, a.name, mine ? "mine" : list === h.from ? "self" : "others");
    if (mine) e.lastSent = Math.max(e.lastSent, when);
    if (list === h.cc || list === h.bcc) e.copied = true;
    e.last = Math.max(e.last, when);
    pending.set(email, e);
  }
}

// Adds what a scan saw to the stored entries.
async function flush(pending) {
  if (!pending.size) return;
  const adds = new Map(pending); pending.clear();
  await updateRows([...adds.keys()], (stored, email) => {
    const d = adds.get(email);
    const e = stored || { email, name: "", nameBy: {}, last: 0, lastSent: 0 };
    delete e.sent; delete e.received;            // no message counts are kept
    e.last = Math.max(e.last || 0, d.last); e.lastSent = Math.max(e.lastSent || 0, d.lastSent);
    if (d.copied) e.copied = true;
    for (const [src, names] of Object.entries(d.nameBy)) for (const [n, c] of Object.entries(names)) for (let i = 0; i < c; i++) noteName(e, n, src);
    e.name = bestName(e);
    return e;
  });
}

// A full build reads every message again, so it starts from nothing: every entry goes, but for the
// ones the user chose something for (keep: the choices that count), which stay as those choices
// alone until the build names them.
function resetRows(keep = CHOICES) {
  return openDb().then(d => new Promise((ok, no) => {
    const t = d.transaction(STORE, "readwrite");
    t.objectStore(STORE).openCursor().onsuccess = e => {
      const c = e.target.result; if (!c) return;
      const r = c.value, kept = { email: r.email, name: "", nameBy: {}, last: 0, lastSent: 0, copied: false };
      for (const k of keep) if (r[k] !== undefined) kept[k] = r[k];
      kept.name = bestName(kept);
      if (chosen(kept)) c.update(kept); else c.delete();
      c.continue();
    };
    t.oncomplete = () => { cache = null; changed(); ok(); };
    t.onerror = () => no(t.error);
  }));
}

async function getMeta(key) { const r = await tx(META, "readonly", s => s.get(key)); return r ? r.value : null; }
async function setMeta(key, value) { await tx(META, "readwrite", s => s.put({ key, value })); }
async function dropMeta(...keys) { await tx(META, "readwrite", s => { for (const k of keys) s.delete(k); }); }

// One message of a newest-first scan: whether to stop, whether to record it, and the bookmark (the
// newest date recorded). A date more than a day ahead (a sender's wrong clock) never moves the
// bookmark, or every later scan would stop at its first message; incremental scans pass over such
// a message, so only a full scan records it, once.
export function scanStep(when, newest, { full, newestSeen, now }) {
  if (when > now + 86400) return { stop: false, record: full, newest };
  if (!full && when <= newestSeen) return { stop: true, record: false, newest };
  return { stop: false, record: true, newest: Math.max(newest, when) };
}

// Walk a folder newest-first, api.LIMITS.scanPage rows a step (SCAN_PAGE where the provider names
// none). full: everything the provider lets a full scan read (api.LIMITS.scanMax rows); a full
// scan keeps its place after every step, so one cut short (the tab closed) carries on from there.
// Otherwise stop at messages older than the last scan. folderId: a folder's id, or EVERYWHERE.
// inSent: the folder is Sent, so every message in it is the user's (see record). skip: ids of
// folders whose mail is left out: the provider is asked not to list it, and a row of theirs that
// comes all the same is passed over (see sync). progress(recorded, read): messages recorded and
// rows read so far. pace: awaited before each step (see sync). Gives { recorded, read }: the
// messages this call recorded, and the rows of the folder read in all.
async function scanFolder(folderId, inSent, full, progress, pace, skip = null) {
  await loadAll();
  const metaKey = `scan:${folderId}`, fillKey = `fill:${folderId}`, page = api.LIMITS.scanPage || SCAN_PAGE;
  const prev = full ? null : await getMeta(metaKey);
  const resume = full ? await getMeta(fillKey) : null;
  if (resume?.done) {
    if (!(await getMeta(metaKey))) await setMeta(metaKey, { newest: resume.newest, at: Date.now() });
    return { recorded: 0, read: resume.offset || 0 };
  }
  const newestSeen = prev?.newest || 0;
  let offset = resume?.offset || 0, newest = resume?.newest || newestSeen, seen = resume?.seen || 0, done = false;
  const pending = new Map(), now = Date.now() / 1000;
  while (!done) {
    await pace?.();
    // background: a provider with a request quota (Gmail) paces the scan to leave room for browsing
    const r = await (folderId === EVERYWHERE ? api.listAll(page, offset, { background: true, exclude: [...(skip || [])] }) : api.list(folderId, page, offset, { background: true }));
    for (const m of r.messages) {
      const step = scanStep(Number(m.headers?.date) || 0, newest, { full, newestSeen, now });
      if (step.stop) { done = true; break; }
      if (step.record && !skip?.has(String(m.folder?.id))) { record(m, pending, inSent); seen++; }
      newest = step.newest;
    }
    offset += r.messages.length;
    if (r.messages.length < page || (full && offset >= api.LIMITS.scanMax)) done = true;
    if (full) { await flush(pending); await setMeta(fillKey, { offset, newest, seen, done }); }
    else if (pending.size >= 300) await flush(pending);
    progress?.(seen, offset);
    // a provider that names a pause between steps (api.LIMITS.scanGap) is not asked back to back
    if (!done && api.LIMITS.scanGap) await new Promise(ok => setTimeout(ok, api.LIMITS.scanGap));
  }
  await flush(pending);
  await setMeta(metaKey, { newest, at: Date.now() });
  return { recorded: seen - (resume?.seen || 0), read: offset };
}

// Initial build (first run) or incremental refresh. inbox, sent and drafts are folder ids. The
// build reads Sent, then Inbox, then all the mail there is outside Spam and Trash, whatever folder
// it was filed in; that last pass leaves out Sent and Inbox, which were read, and Drafts, whose
// recipients were not written to. The refresh reads Sent and Inbox only: mail gets to the other
// folders from the Inbox, where it was learned. A first build cut short carries on where it
// stopped the next time; full starts one afresh. pace: awaited before each step of the scan, by a
// provider whose first build goes only as the user allows (see paceWait). totals: how many
// messages { sent, inbox, rest } hold, rest being what the last pass has to read. progress({ read,
// total }): rows read so far of those the passes have to read, as far as totals says.
export async function sync({ inbox, sent, drafts, totals = {}, full = false, progress, pace } = {}) {
  setInbox(inbox);
  await loadAll();
  const built = await getMeta("built");
  const doFull = full || !built;
  const folders = [...new Set([sent, inbox].filter(Boolean)), ...(doFull ? [EVERYWHERE] : [])];
  const elsewhere = new Set([sent, inbox, drafts].filter(Boolean).map(String));
  const fills = folders.map(id => `fill:${id}`);
  if (doFull && (full || !(await getMeta("filling")))) {
    await resetRows();
    await dropMeta(...fills);
    await setMeta("filling", Date.now());
  }
  const holds = id => Math.min(api.LIMITS.scanMax, (id === EVERYWHERE ? totals.rest : id === sent ? totals.sent : totals.inbox) || 0);
  const total = folders.reduce((sum, id) => sum + holds(id), 0);
  let n = 0, before = 0;
  for (const id of folders) {
    const r = await scanFolder(id, id === sent, doFull, progress && ((seen, read) => progress({ read: total ? Math.min(total, before + read) : before + read, total })), pace, id === EVERYWHERE ? elsewhere : null);
    n += r.recorded; before += r.read;
  }
  if (doFull) { await setMeta("built", Date.now()); await dropMeta("filling", ...fills); }
  return n;
}

// How long the first build waits before its next step (0: go now): until after, the time it may
// start, and then until the user has left the app alone for idle ms since their last input
// (lastInput), unless the tab is hidden. All times in ms.
export function paceWait({ now, after = 0, lastInput = 0, idle = 0, hidden = false }) {
  return Math.max(0, after - now, hidden ? 0 : lastInput + idle - now);
}

export async function isBuilt() { return !!(await getMeta("built")); }

// Everything learnt, scan bookmarks and hide choices included, gone (signing out).
export async function clear() {
  await openDb();
  await new Promise((ok, no) => {
    const t = db.transaction([STORE, META], "readwrite");
    t.objectStore(STORE).clear(); t.objectStore(META).clear();
    t.oncomplete = ok; t.onerror = () => no(t.error);
  });
  cache = null;
  changed();
}

// The address book is one account's: when another account signs in, it starts afresh. The first
// account seen is simply noted.
export async function useAccount(email) {
  const who = String(email).toLowerCase(), was = await getMeta("account");
  if (was === who) return;
  if (was) await clear();
  await setMeta("account", who);
}

// Called after the user sends a message, so new recipients rank at once.
export async function noteSent(recipients) {
  await loadAll();
  const pending = new Map();
  record({ headers: { to: recipients, date: String(Math.floor(Date.now() / 1000)) } }, pending, true);
  await flush(pending);
}

// Recency ranks: the last exchange either way, and above it the last time the user wrote to the
// person, so people the user writes to stay above senders of similar age.
function score(e, now) {
  const fade = t => t ? Math.exp(-Math.max(0, (now - t) / 86400) / 120) : 0;
  return fade(e.last) + (e.lastSent ? 0.5 + 2 * fade(e.lastSent) : 0) - (e.hidden === undefined && guessed(e) ? 1e6 : 0);
}

// An entry as the Contacts view lists it: pinned is when the user pinned it (0: not pinned),
// copied whether mail was copied to it, given the user's own name for it ("": none, and name is
// the one the mail gives), and added whether the user put it in the book.
const row = e => ({ name: e.name || "", email: e.email, last: e.last || 0, lastSent: e.lastSent || 0, hidden: isHidden(e), pinned: e.pinned || 0, copied: !!e.copied, given: e.given || "", added: !!e.added });

// Every contact, for the Contacts view: every entry the user has not deleted.
export async function all() {
  await loadAll();
  return [...cache.values()].filter(e => !e.deleted).map(row);
}

// Contacts lists every entry in one of three piles: "hidden" (never suggested: what the user hid,
// and machine senders never written to), "people" (written to, or pinned) and "others" (the rest:
// addresses that wrote, or were named in mail, and were never written to).
export const pileOf = r => r.hidden ? "hidden" : (r.pinned || r.lastSent) ? "people" : "others";

// The Contacts filter: q (lowercase) anywhere in the address or the name.
export const matchOf = (r, q) => !q || r.email.includes(q) || (r.name || "").toLowerCase().includes(q);

// Latest first: by "wrote", when the user last wrote to it; by "last", the last mail either way.
export function sortRows(rows, by = "last") {
  const when = by === "wrote" ? r => r.lastSent : r => r.last;
  return [...rows].sort((a, b) => when(b) - when(a) || a.email.localeCompare(b.email));
}
// Pinned entries in the order they were pinned.
export const pinnedFirst = rows => rows.filter(r => r.pinned).sort((a, b) => a.pinned - b.pinned || a.email.localeCompare(b.email));

// The user's choice about entries: shown at once from the cache, then stored.
async function setFlags(emails, change) {
  const keys = emails.map(x => String(x).toLowerCase());
  const c = await loadAll();
  for (const k of keys) { const e = c.get(k); if (e) change(e); }
  await updateRows(keys, stored => { if (stored) change(stored); return stored; });
}

// Hidden addresses are never suggested (newsletters and the like), and Contacts lists them apart;
// they are still recorded. Pinned entries head the people in Contacts; one already pinned keeps
// its place. The two exclude each other: a pinned entry cannot be hidden, nor a hidden one pinned,
// until it is unpinned or unhidden.
export async function hide(email, hidden = true) { await hideMany([email], hidden); }
export async function hideMany(emails, hidden = true) { await setFlags(emails, e => { if (!hidden || !e.pinned) e.hidden = hidden; }); }
export async function pinMany(emails, pinned = true) {
  const at = Math.floor(Date.now() / 1000);
  await setFlags(emails, e => { if (!pinned) delete e.pinned; else if (!isHidden(e)) e.pinned ||= at; });
}
// The user's own name for an entry; "" takes it back, and the name the mail gives shows again.
export async function rename(email, name) {
  const given = noBidi(name).trim().slice(0, NAME_MAX);
  await setFlags([email], e => { if (given) e.given = given; else delete e.given; e.name = bestName(e); });
}
// Contacts deleted: out of every list, and kept out whatever mail names them later, until a
// Rebuild. Undo brings them back, and so does importing a file that names one (planImport).
export async function deleteMany(emails) { await setFlags(emails, e => { e.deleted = true; }); }
// The user's choices about entries as they are stored (CHOICES, each undefined while the user has
// not said), and the same put back (undo).
export async function choices(emails) {
  const c = await loadAll();
  return emails.map(x => c.get(String(x).toLowerCase())).filter(Boolean).map(e => ({ email: e.email, ...Object.fromEntries(CHOICES.map(k => [k, e[k]])) }));
}
export async function restoreChoices(list) {
  const was = new Map(list.map(x => [x.email, x]));
  await setFlags([...was.keys()], e => { for (const k of CHOICES) if (was.get(e.email)[k] === undefined) delete e[k]; else e[k] = was.get(e.email)[k]; e.name = bestName(e); });
}

// Entries with no mail left are forgotten: all of emails but the ones the user pinned, hid, named,
// added or deleted (whose entry is what keeps them out), and the ones mail was copied to. That no mail is left is a search's word, and a search
// cannot be relied on for every message an address was copied on (Yahoo's finds none it was a Bcc
// of), so for such an address it proves nothing. Gives the rows taken out, as they were stored.
export function forget(emails) {
  const keys = emails.map(x => String(x).toLowerCase());
  return openDb().then(d => new Promise((ok, no) => {
    const t = d.transaction(STORE, "readwrite"), s = t.objectStore(STORE), out = [];
    for (const k of keys) {
      const r = s.get(k);
      r.onsuccess = () => { const e = r.result; if (e && !e.pinned && !e.copied && e.hidden !== true && !e.given && !e.added && !e.deleted) { s.delete(k); out.push(e); } };
    }
    t.oncomplete = () => { for (const row of out) cache?.delete(row.email); changed(); ok(out); };
    t.onerror = () => no(t.error);
  }));
}
// Rows forgotten, stored again as they were (the forgetting was undone); an address learned again
// meanwhile keeps what it has learned.
export const putBack = rows => updateRows(rows.map(r => r.email), (stored, email) => stored ? null : rows.find(r => r.email === email));

// Mail put back where the book looks (out of Trash or Spam): its addresses are learned as a scan
// would have learned them.
export async function learn(messages) {
  await loadAll();
  const pending = new Map();
  for (const m of messages) record(m, pending);
  await flush(pending);
}

// A person's page found mail with them (people.js), in whatever folder it is kept. When the user
// wrote one of those messages later than the book knows them to have written to the person (a
// reply kept where no scan reads), the book takes its date. Nothing is asked of the provider.
// True when the book changed.
export async function wrote(email, messages) {
  const key = String(email).toLowerCase(), e = (await loadAll()).get(key);
  const when = Math.max(0, ...messages.filter(isOwn).map(m => Number(m.headers?.date) || 0));
  if (!e || when <= (e.lastSent || 0)) return false;
  await updateRows([key], stored => stored ? Object.assign(stored, { lastSent: Math.max(stored.lastSent || 0, when), last: Math.max(stored.last || 0, when) }) : null);
  return true;
}

// Rebuild: the book is made anew from the mail, keeping of what the user chose only the pins and
// the names they gave (REBUILT); what they hid, added or deleted goes, and the mail decides again.
// Every entry is cut down to those at once, and the build is unmarked, as a book of a lower version
// has it when it is opened (see DB_VERSION): the next sync builds the book as a first build is, and
// one cut short carries on the next time. The account the book belongs to stays noted.
export async function rebuild() {
  await resetRows(REBUILT);
  const who = await getMeta("account");
  await tx(META, "readwrite", s => { s.clear(); if (who) s.put({ key: "account", value: who }); });
}

// What an import makes of the book. rows: the stored entries, by address; entries: the contacts a
// file names ({ email, name, pinned, hidden }, see contactsfile.js).
// Merging takes what the file says and leaves the rest: a name that is not the one shown becomes
// the user's own name for the contact, the word pinned pins it and hidden hides it, and an address
// the book lacks is added.
// Replacing makes the book what the file says: a name is the user's own where the mail does not
// give it, and the user's own name goes where the file has none; a contact is pinned or hidden
// exactly when its line says so, the pinned ones in the order of their lines; and every contact the
// file does not list is taken out.
// Either way a line that names a contact the user deleted brings it back: the file says it is one.
// An entry is written only where the file differs from it, so a file exported and imported
// unchanged changes nothing. Gives { put: the entries to store, drop: the addresses to take out,
// counts: { added, renamed, pinned, unpinned, hidden, shown, removed, restored } }.
export function planImport(rows, entries, { replace = false, now = Math.floor(Date.now() / 1000) } = {}) {
  const put = [], listed = new Set(), counts = { added: 0, renamed: 0, pinned: 0, unpinned: 0, hidden: 0, shown: 0, removed: 0, restored: 0 };
  const mine = entries.filter(x => !own.has(x.email));
  // replacing puts the pins in the file's order, unless they are in it already (pins made at once
  // share a time, which is in order); the pins it gives are dated so that the last one is now
  const pins = mine.filter(x => x.pinned).map(x => rows.get(x.email)?.pinned || 0);
  const reorder = replace && pins.some((p, i) => !p || (i && p < pins[i - 1]));
  const fresh = mine.filter(x => !x.hidden && x.pinned && (reorder || !rows.get(x.email)?.pinned));
  const pinAt = new Map(fresh.map((x, i) => [x.email, now - fresh.length + 1 + i]));
  for (const x of mine) {
    listed.add(x.email);
    const stored = rows.get(x.email);
    // a contact the user deleted is one the book lacks, and its line brings it back
    const was = stored?.deleted ? null : stored;
    const e = stored ? structuredClone(stored) : { email: x.email, name: "", nameBy: {}, last: 0, lastSent: 0, copied: false, added: true };
    if (stored?.deleted) { delete e.deleted; e.added = true; }
    // a given name the file shows unchanged stays the user's, though the mail now says the same
    if (replace) { const learned = bestName({ ...e, given: "" }); if (x.name && x.name !== learned) e.given = x.name; else if (x.name !== bestName(e)) delete e.given; }
    else if (x.name && x.name !== bestName(e)) e.given = x.name;
    // hidden and shown are written as a choice only where the guess about the address says
    // otherwise, and a contact already shown or hidden as the file says keeps the choice it has
    const guess = isHidden({ ...e, hidden: undefined });
    const set = hidden => { if (isHidden(e) === hidden) return; if (hidden === guess) delete e.hidden; else e.hidden = hidden; };
    if (x.hidden) { set(true); delete e.pinned; }
    else if (x.pinned) { set(false); if (pinAt.has(x.email)) e.pinned = pinAt.get(x.email); }
    else if (replace) { set(false); delete e.pinned; }
    e.name = bestName(e);
    const a = { name: e.name, pinned: !!e.pinned, hidden: isHidden(e) }, b = was && { name: bestName(was), pinned: !!was.pinned, hidden: isHidden(was) };
    if (!was) counts[stored ? "restored" : "added"]++;
    else {
      if (a.name !== b.name) counts.renamed++;
      if (a.pinned !== b.pinned) counts[a.pinned ? "pinned" : "unpinned"]++;
      if (a.hidden !== b.hidden) counts[a.hidden ? "hidden" : "shown"]++;
    }
    if (!was || CHOICES.some(k => e[k] !== was[k])) put.push(e);
  }
  // what the user deleted is in no list to be taken out of, and stays known as unwanted
  const drop = replace ? [...rows.keys()].filter(k => !listed.has(k) && !rows.get(k).deleted) : [];
  counts.removed = drop.length;
  return { put, drop, counts };
}

// Entries stored and addresses taken out in one go.
const write = (put, drop) => openDb().then(d => new Promise((ok, no) => {
  const t = d.transaction(STORE, "readwrite"), s = t.objectStore(STORE);
  for (const e of put) s.put(e);
  for (const k of drop) s.delete(k);
  t.oncomplete = () => { for (const e of put) cache?.set(e.email, e); for (const k of drop) cache?.delete(k); changed(); ok(); };
  t.onerror = () => no(t.error);
}));

// An import carried out (see planImport). Gives its counts, how many entries it changed, and
// undo: what undoImport takes to put the book back as it was.
export async function importList(entries, opts = {}) {
  const c = await loadAll(), plan = planImport(c, entries, opts);
  const before = [...plan.put.map(e => c.get(e.email)), ...plan.drop.map(k => c.get(k))].filter(Boolean).map(e => structuredClone(e));
  const created = plan.put.filter(e => !c.has(e.email)).map(e => e.email);
  await write(plan.put, plan.drop);
  return { counts: plan.counts, changed: plan.put.length + plan.drop.length, undo: { before, created } };
}
// An import taken back: the entries it added go, the ones it took out come back as they were, and
// the ones it changed get back what the user had chosen for them, keeping what the mail has taught
// about them since.
export const undoImport = undo => openDb().then(d => new Promise((ok, no) => {
  const t = d.transaction(STORE, "readwrite"), s = t.objectStore(STORE), out = [];
  for (const was of undo.before) {
    const r = s.get(was.email);
    r.onsuccess = () => {
      const e = r.result || was;
      if (r.result) { for (const k of CHOICES) if (was[k] === undefined) delete e[k]; else e[k] = was[k]; e.name = bestName(e); }
      s.put(e); out.push(e);
    };
  }
  for (const k of undo.created) s.delete(k);
  t.oncomplete = () => { for (const e of out) cache?.set(e.email, e); for (const k of undo.created) cache?.delete(k); changed(); ok(); };
  t.onerror = () => no(t.error);
}));

// Whether an address completes what was typed: the address, or a word of its name, starts with
// it. Only a completion may be taken for the typed text; an address that merely contains it is
// offered, never chosen by a key.
export function completes(query, a) {
  const q = String(query || "").trim().toLowerCase(), name = String(a?.name || "").toLowerCase();
  return !!q && (String(a?.email || "").toLowerCase().startsWith(q) || name.startsWith(q) || name.split(/\s+/).some(w => w.startsWith(q)));
}

// The addresses that match what was typed: the address itself first, then its completions, then
// those that only contain it, each group by how recently and how often it was written.
export async function suggest(query, limit = 8, exclude = new Set()) {
  await loadAll();
  const q = (query || "").trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (const e of cache.values()) {
    if (exclude.has(e.email) || e.deleted || isHidden(e)) continue;
    const rank = !q || e.email === q ? 0 : completes(q, e) ? 1 : e.email.includes(q) ? 2 : -1;
    if (rank >= 0) rows.push({ e, rank });
  }
  rows.sort((a, b) => a.rank - b.rank || (q ? score(b.e, now) - score(a.e, now) : b.e.last - a.e.last) || (b.e.lastSent || 0) - (a.e.lastSent || 0));
  return rows.slice(0, limit).map(({ e }) => ({ name: e.name, email: e.email }));
}

// How many contacts there are, and one of them by its address: neither knows of a deleted one.
export async function count() { await loadAll(); return [...cache.values()].filter(e => !e.deleted).length; }

export async function lookup(email) {
  await loadAll();
  const e = cache.get(String(email || "").toLowerCase());
  return e && !e.deleted ? row(e) : null;
}
