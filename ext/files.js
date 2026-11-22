// A folder's attachments ("Files" in the code): the files attached to its mail in one list, shown
// in the message list's place when asked for (the folder's menu: Show attachments) until another
// view is opened. Its Subfolders box adds the subfolders' attachments; the folders that have it
// ticked are kept per account on this computer.
// The list comes from the provider's search for mail with attachments in those folders, a page of
// PAGE messages at a time. List rows already name each message's files, so no message is fetched
// to build the list; a file's bytes are fetched only to preview or save it, and selecting a file
// shows the message it came with in the reader.
// Files are selected for a ZIP download as messages are in their list (Ctrl-click, Shift-click, x,
// Ctrl+A for every file listed so far), and kept by key while the list is loaded again or longer.

import { tile, sizeStr, open as preview, download, downloadZip } from "./viewer.js";
import { esc, noBidi, plural } from "./text.js";
import { norm } from "./mime.js";

const $ = id => document.getElementById(id);
const PAGE = 100;
const KEY = "folderFiles";
// "2 attachments", or "100+ attachments" while more pages remain
const counted = () => `${st.items.length}${st.more ? "+" : ""} attachment${st.items.length === 1 && !st.more ? "" : "s"}`;
const countText = () => counted() + (st.marked.size ? ` · ${st.marked.size} selected` : "");

// ---------- what is listed ----------
// Images built into a message's text (disposition inline) are not files, and neither is a picture
// without a name: a sender's logo or icon that a provider counts as an attachment.
export const isFile = a => !!a && a.disposition !== "inline" && (!!a.filename || !/^image$/i.test(a.type || ""));
// A file sent again is one entry, listed with the newest message that carries it: the same
// content where the provider names it (Yahoo's objectId), otherwise the same name and size.
const sameAs = a => a.objectId ? `o:${a.objectId}` : a.filename && a.size ? `n:${norm(a.filename)}:${a.size}` : null;

// The entries for list rows, newest message first: each file with its row, its message's id
// (msgId) and how many messages carry it (copies). seen holds the entries already listed, so a
// further page counts its copies against them; listed(a) says whether the provider can fetch a file.
export function filesOf(rows, { seen = new Map(), listed = () => true } = {}) {
  const out = [];
  for (const row of rows || []) {
    (Array.isArray(row.attachments) ? row.attachments : []).forEach((a, i) => {
      if (!isFile(a) || !listed(a)) return;
      const same = sameAs(a), prev = same && seen.get(same);
      if (prev) { prev.copies++; return; }
      const item = { ...a, key: `${row.id}/${a.partId ?? i}`, msgId: row.id, row, copies: 1 };
      if (same) seen.set(same, item);
      out.push(item);
    });
  }
  return out;
}

// ---------- the Subfolders choice ----------
// { [account]: { [folderId]: { subs: true } } }: the folders whose Files include their subfolders'.
// Folder ids stay the same when a folder is renamed or moved.
let all = {}, account = "", mine = {};
export async function useAccount(email) {
  account = String(email || "");
  try { all = (await hooks.storage.get(KEY))[KEY] || {}; } catch { all = {}; }
  mine = Object.fromEntries(Object.entries(all[account] || {}).filter(([, v]) => v?.subs));
}
function store() {
  if (Object.keys(mine).length) all[account] = mine; else delete all[account];
  return hooks.storage.set({ [KEY]: all }).catch(() => {});
}
const withSubs = id => !!mine[id]?.subs;
function setSubs(id, on) {
  if (on) mine[id] = { subs: true }; else delete mine[id];
  store();
}
// Deleted folders keep no choice, and an account signed out keeps none.
export function forget(ids) {
  const gone = ids.filter(id => mine[id]);
  for (const id of gone) delete mine[id];
  if (gone.length) store();
}
export function clear() { mine = {}; return store(); }

// ---------- the pane ----------
// hooks: { storage, search(ids, count, offset) -> { messages, ms }, scope(folderId, subs) -> { ids,
//   name, full, subs } | null, listed(a), who(row) -> { name, email }, where(row, folderId) -> the
//   subfolder a row is in, or "", date(epoch), openRow(row, how), isOpen(msgId) -> whether the
//   reader shows that message, menu(x, y, items, onPick), goTo(row), status(msg, ms), fail(e) }
let hooks = null;
// selected: the cursor's entry; marked: the keys of the selected entries; anchor: where a Shift-click range starts
const st = { folderId: null, items: [], rows: 0, more: false, loading: false, failed: false, token: 0, selected: -1, marked: new Set(), anchor: -1, seen: new Map(), shown: false };
const memory = new Map();        // folder id -> key of the entry last selected there, this session

export function init(h) {
  hooks = h;
  $("f-subs-box").onchange = e => { setSubs(st.folderId, e.target.checked); load("fresh"); };
  $("f-more-btn").onclick = () => load("more");
  const rows = $("f-rows");
  const at = e => { const el = e.target.closest(".frow"); return el ? Number(el.dataset.i) : -1; };
  rows.onclick = e => {
    const i = at(e); if (i < 0) return;
    if (e.shiftKey) { markRange(st.anchor < 0 ? i : st.anchor, i); select(i, false); return; }
    // Ctrl/⌘-click adds an entry to the selection, which starts with the cursor's entry
    if (e.ctrlKey || e.metaKey) {
      if (!st.marked.size && st.selected >= 0 && st.selected !== i) mark(st.selected);
      mark(i); select(i); return;
    }
    clearMarks();
    (e.target.closest(".ft") ? previewAt : pick)(i);
  };
  rows.ondblclick = e => { const i = at(e); if (i >= 0 && !e.target.closest(".ft") && !e.shiftKey && !e.ctrlKey && !e.metaKey) previewAt(i); };
  rows.oncontextmenu = e => {
    const i = at(e); if (i < 0) return;
    e.preventDefault();
    if (!st.marked.has(st.items[i].key)) clearMarks();
    select(i, false); rowMenu(e.clientX, e.clientY);
  };
}

// The folders the list covers, to refresh it when one of them changes.
export const scopeIds = () => (st.shown && hooks.scope(st.folderId, withSubs(st.folderId))?.ids) || [];

export async function show(id) {
  st.shown = true;
  if (st.folderId !== id) { st.folderId = id; st.items = []; st.rows = 0; st.selected = -1; }
  await load("fresh");
}
export function hide() { st.shown = false; st.loading = false; ++st.token; }
// Shown again as it was (a view change that failed comes back here), loaded again only if it was
// left before its first page came.
export function resume() {
  st.shown = true;
  if (!st.rows && !st.items.length) load("fresh"); else render();
}
// The list loaded again in the same depth, keeping the selected entry; quiet unless told.
export function reload(told = false) { if (st.shown) return load("reload", told); }

// mode: "fresh" (first page; the entry last selected in this folder is selected again and its
// message shown), "reload" (as many messages as are listed, the selection kept), "more" (next page).
async function load(mode, told = mode !== "reload") {
  // a next page only after the one before it, and never in place of a list still coming
  if (mode === "more" && (!st.more || st.loading)) return;
  const id = st.folderId, sc = hooks.scope(id, withSubs(id));
  if (!sc) return;
  const token = ++st.token;
  const count = mode === "reload" ? Math.max(PAGE, st.rows) : PAGE, offset = mode === "more" ? st.rows : 0;
  const keep = mode === "reload" ? st.items[st.selected]?.key : mode === "fresh" ? memory.get(id) : null;
  st.loading = true;
  if (mode === "fresh") { st.items = []; st.rows = 0; st.more = false; st.selected = st.anchor = -1; st.marked.clear(); render(); }
  if (told) hooks.status(mode === "more" ? "loading more attachments..." : "loading attachments...");
  let r;
  try { r = await hooks.search(sc.ids, count, offset); } catch (e) {
    if (token !== st.token) return;
    // a fresh load that failed says so, rather than that the folder has no attachments
    st.loading = false; if (mode === "fresh") st.failed = true; render(); hooks.fail(e);
    return;
  }
  if (token !== st.token || !st.shown) return;
  st.loading = false; st.failed = false;
  const rows = r.messages || [];
  if (mode === "more") { st.items = st.items.concat(filesOf(rows, { seen: st.seen, listed: hooks.listed })); st.rows += rows.length; }
  else { st.seen = new Map(); st.items = filesOf(rows, { seen: st.seen, listed: hooks.listed }); st.rows = rows.length; }
  st.more = rows.length >= count;
  if (keep) st.selected = st.anchor = st.items.findIndex(x => x.key === keep);
  if (st.marked.size) { const keys = new Set(st.items.map(x => x.key)); for (const k of [...st.marked]) if (!keys.has(k)) st.marked.delete(k); }
  render();
  if (mode === "fresh" && st.selected >= 0) hooks.openRow(st.items[st.selected].row, "auto");
  if (told) hooks.status(`${sc.name}: ${counted()} from ${plural(new Set(st.items.map(x => x.msgId)).size, "message")}`, r.ms);
}

function render() {
  const sc = hooks.scope(st.folderId, withSubs(st.folderId));
  const name = noBidi(sc?.full || "");
  $("f-title").textContent = `Attachments in ${noBidi(sc?.name || "")}`;
  $("f-title").title = `Attachments in the mail of ${name}${withSubs(st.folderId) && sc?.subs ? ` and its ${plural(sc.subs, "subfolder")}` : ""}; Esc goes back to its messages`;
  $("f-count").textContent = (st.loading || st.failed) && !st.items.length ? "" : countText();
  $("f-subs").classList.toggle("hidden", !sc?.subs);
  $("f-subs-box").checked = withSubs(st.folderId);
  $("f-subs").title = `List the attachments of its ${plural(sc?.subs || 0, "subfolder")} too; the folder keeps this choice`;
  const box = $("f-rows"), top = box.scrollTop;
  box.setAttribute("aria-label", `Attachments in ${name}`);
  if (st.items.length) box.innerHTML = st.items.map(rowHtml).join("");
  else box.innerHTML = `<div class="list-empty">${st.loading ? "<div>Loading attachments...</div>" : st.failed ? "<div>The attachments could not be loaded.</div>" : emptyHtml(sc, name)}</div>`;
  box.scrollTop = top;
  $("f-more").classList.toggle("hidden", !st.more);
  syncAria();
}

function emptyHtml(sc, name) {
  const subs = sc?.subs || 0, on = withSubs(st.folderId);
  const sub = !subs ? "" : on ? "" : `Its ${plural(subs, "subfolder")} ${subs === 1 ? "is" : "are"} not included: tick Subfolders to list ${subs === 1 ? "its" : "their"} attachments too.`;
  return `<div>No attachments in ${esc(name)}${on && subs ? " or its subfolders" : ""}.</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
}

function rowHtml(a, i) {
  const t = tile(a), who = hooks.who(a.row) || {}, where = hooks.where(a.row, st.folderId);
  const name = a.filename || "Untitled", person = who.name || who.email || "", date = hooks.date(a.row.headers?.date);
  const subject = noBidi(a.row.headers?.subject || "(no subject)").replace(/\^_/g, "");
  const tip = [name, `${person ? `From ${person}: ` : ""}${subject}`, ...(a.copies > 1 ? [`Also in ${plural(a.copies - 1, "older message")}`] : []), "Click to see its message; click its badge, press Enter or double-click to open the attachment as well"].map(noBidi).join("\n");
  const label = [name, t.text, a.size ? sizeStr(a.size) : "", person, date, where ? `in ${where}` : ""].filter(Boolean).join(", ");
  const marked = st.marked.has(a.key);
  return `<div class="frow${i === st.selected ? " sel" : ""}${marked ? " marked" : ""}" id="frow-${i}" data-i="${i}" role="option" aria-selected="${st.marked.size ? marked : i === st.selected}" aria-label="${esc(label)}" title="${esc(tip)}">` +
    `<span class="ft ${t.cls}" title="${esc(`${noBidi(name)}\nClick to open the attachment and show its message (Enter)`)}">${esc(t.text)}</span>` +
    `<span class="fn">${esc(name)}${where ? `<em>${esc(where)}</em>` : ""}</span>` +
    `<span class="fw">${esc(person)}</span>` +
    `<span class="fz">${a.size ? sizeStr(a.size) : ""}</span>` +
    `<span class="dt">${esc(date)}</span></div>`;
}

function syncAria() {
  if (st.selected >= 0 && $(`frow-${st.selected}`)) $("list").setAttribute("aria-activedescendant", `frow-${st.selected}`);
  else $("list").removeAttribute("aria-activedescendant");
}

function select(i, resetAnchor = true) {
  if (i < 0 || i >= st.items.length) return;
  $(`frow-${st.selected}`)?.classList.remove("sel");
  st.selected = i;
  if (resetAnchor) st.anchor = i;
  memory.set(st.folderId, st.items[i].key);
  const el = $(`frow-${i}`);
  if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }); }
  paint();
}

// The rows as the selection has them: what is selected is the marked entries, or the cursor's
// entry when none is marked.
function paint() {
  for (const el of $("f-rows").querySelectorAll(".frow")) {
    const i = Number(el.dataset.i), on = st.marked.has(st.items[i]?.key);
    el.classList.toggle("marked", on);
    el.setAttribute("aria-selected", String(st.marked.size ? on : i === st.selected));
  }
  if (st.items.length) $("f-count").textContent = countText();
  syncAria();
}
function mark(i) {
  const key = st.items[i]?.key; if (!key) return;
  if (st.marked.has(key)) st.marked.delete(key); else st.marked.add(key);
  st.anchor = i;
  paint();
}
function markRange(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = Math.max(0, lo); i <= Math.min(st.items.length - 1, hi); i++) st.marked.add(st.items[i].key);
  paint();
}
// Esc: true when there was a selection to clear.
export function clearMarks() {
  if (!st.shown || !st.marked.size) return false;
  st.marked.clear();
  paint();
  return true;
}
// Ctrl+A: every entry listed so far.
export function markAll() {
  if (!st.shown || !st.items.length) return;
  for (const a of st.items) st.marked.add(a.key);
  paint();
  hooks.status(`${plural(st.marked.size, "attachment")} selected`);
}

// A click selects a file and shows its message in the reader; a click on its type badge, Enter or
// a double click also previews the file over it, as a badge under a message does. A message
// already shown is not fetched again.
function showMessage(a) { if (!hooks.isOpen(a.msgId)) hooks.openRow(a.row, "user"); }
function pick(i) {
  select(i);
  showMessage(st.items[i]);
}
function previewAt(i) {
  if (i < 0 || !st.items[i]) return;
  select(i);
  showMessage(st.items[i]);
  preview(st.items, i);
}

// Download all is every entry listed so far, and Download selected the marked ones when they are
// some but not all; both save one ZIP file named after the folder.
function rowMenu(x, y) {
  const a = st.items[st.selected]; if (!a) return;
  const n = st.items.length, k = st.marked.size;
  hooks.menu(x, y, [["preview", "Preview", "Enter"], ["download", "Download"],
    ["all", "Download all", "", n > 1 ? `${st.more ? "The attachments listed so far, in" : "In"} one ZIP file` : ""],
    ...(k && k < n ? [["marked", `Download selected (${k})`, "", k > 1 ? "In one ZIP file" : ""]] : []),
    null, ["message", "Show the message in its folder"]], act => {
    if (act === "preview") previewAt(st.selected);
    else if (act === "download") download(a);
    else if (act === "all") zip(st.items);
    else if (act === "marked") zip(st.items.filter(x => st.marked.has(x.key)));
    else if (act === "message") hooks.goTo(a.row);
  });
}
function zip(list) {
  const sc = hooks.scope(st.folderId, withSubs(st.folderId));
  downloadZip(list.map(a => ({ ...a, date: a.row.headers?.date })), `${sc?.name || "Folder"} attachments`);
}

// Keys for the list while it is shown; true when the key was the list's.
export function onKey(e) {
  if (!st.shown) return false;
  switch (e.key) {
    case "j": case "ArrowDown": e.preventDefault(); select(Math.min(st.items.length - 1, st.selected + 1)); return true;
    case "k": case "ArrowUp": e.preventDefault(); select(Math.max(0, st.selected - 1)); return true;
    case "Home": e.preventDefault(); select(0); return true;
    case "End": e.preventDefault(); select(st.items.length - 1); return true;
    case "Enter": case "o": previewAt(st.selected); return true;
    case "x": if (st.selected >= 0) mark(st.selected); return true;
    case "n": load("more"); return true;
    case "R": reload(true); return true;
  }
  return false;
}
