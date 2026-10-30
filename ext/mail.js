import * as api from "./api.js";
import { THEMES, applyTheme } from "./themes.js";

const $ = id => document.getElementById(id);
const SYSTEM_ORDER = ["INBOX", "DRAFT", "SENT", "ARCHIVE", "BULK", "TRASH"];
const PAGE = 100;

const DEFAULTS = { layout: "vertical", theme: "dark", darkTheme: "dark", lightTheme: "light", pollSec: 20, markReadSec: 2, rowH: 22, folderW: 230, listW: 460, listH: 40, expanded: [] };
let settings = { ...DEFAULTS };

async function loadSettings() {
  const stored = (await chrome.storage.local.get("settings")).settings || {};
  settings = { ...DEFAULTS, ...stored };
  state.expanded = new Set(settings.expanded);
}

let saveTimer = null;
function saveSettings() {
  settings.expanded = [...state.expanded];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ settings }), 150);
}

const systemDark = matchMedia("(prefers-color-scheme: dark)");
function applySettings() {
  const mode = settings.theme === "system" ? (systemDark.matches ? "dark" : "light") : settings.theme;
  applyTheme(mode === "dark" ? settings.darkTheme : settings.lightTheme);
  $("darkTheme").value = settings.darkTheme;
  $("lightTheme").value = settings.lightTheme;
  const app = $("app");
  app.classList.toggle("horizontal", settings.layout === "horizontal");
  const r = document.documentElement.style;
  r.setProperty("--folder-w", settings.folderW + "px");
  r.setProperty("--list-w", settings.listW + "px");
  r.setProperty("--list-h", settings.listH + "%");
  r.setProperty("--row-h", settings.rowH + "px");
  for (const el of document.querySelectorAll("#settings input[type=radio]")) el.checked = settings[el.name] === el.value;
  $("poll").value = settings.pollSec;
  $("density").value = settings.rowH;
  $("markread").value = settings.markReadSec == null ? "" : settings.markReadSec;
  clearInterval(state.polling);
  state.polling = setInterval(poll, Math.max(5, settings.pollSec) * 1000);
}
systemDark.addEventListener("change", () => { if (settings.theme === "system") applySettings(); });

const state = {
  folders: [], byId: new Map(), expanded: new Set(),
  view: { kind: "folder", folderId: "1", term: "" },
  messages: [], offset: 0, more: false, selected: -1, openId: null,
  marked: new Set(), anchor: -1,
  modseq: new Map(), polling: null, kbFolder: -1,
};

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const addr = a => a?.name ? `${a.name} <${a.email}>` : (a?.email || "");
const addrs = l => (l || []).map(addr).join(", ");
const status = (msg, ms) => { $("st-msg").textContent = msg; if (ms != null) $("st-lat").textContent = `${ms} ms`; };

function fmtDate(epoch) {
  const d = new Date(Number(epoch) * 1000), now = new Date();
  const same = d.toDateString() === now.toDateString();
  if (same) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toISOString().slice(0, 10);
}

function dayLabel(epoch) {
  const d = new Date(Number(epoch) * 1000), now = new Date();
  const diff = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { year: "numeric", month: "long" });
}

// Subjects from search carry ^_term^_ hit markers; turn them into <mark>.
function subjectHtml(s) {
  return esc(s || "(no subject)").replace(/\^_(.*?)\^_/g, "<mark>$1</mark>");
}

// ---------- folders ----------
function folderType(f) { return SYSTEM_ORDER.find(t => f.types.includes(t)) || null; }

function renderFolders() {
  const nav = $("folders");
  const filter = nav.querySelector("input")?.value.toLowerCase() || "";
  nav.innerHTML = '<input placeholder="filter folders" autocomplete="off">';
  nav.querySelector("input").value = filter;
  const visible = state.folders.filter(f => !f.types.some(t => t === "SYNC" || t === "INVISIBLE"));
  const sys = visible.filter(folderType).sort((a, b) => SYSTEM_ORDER.indexOf(folderType(a)) - SYSTEM_ORDER.indexOf(folderType(b)));
  const user = visible.filter(f => !folderType(f)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const hasChildren = new Set();
  for (const f of user) { const p = f.name.split("/"); for (let i = 1; i < p.length; i++) hasChildren.add(p.slice(0, i).join("/")); }
  const frag = document.createDocumentFragment();
  const add = (f, depth, twisty) => {
    const el = document.createElement("div");
    el.className = "folder" + (f.unread ? " unread" : "") + (folderType(f) ? " sys" : "") +
      (state.view.kind === "folder" && state.view.folderId === f.id ? " active" : "");
    el.dataset.id = f.id;
    el.style.paddingLeft = `${8 + depth * 12}px`;
    const leaf = f.name.split("/").pop();
    el.innerHTML = `<span class="tw">${twisty}</span><span class="nm" title="${esc(f.name)}">${esc(leaf)}</span>` +
      `<span class="ct">${f.unread ? f.unread : (f.total || "")}</span>`;
    el.onclick = e => {
      if (e.target.classList.contains("tw") && twisty) { toggleExpand(f.name); return; }
      openFolder(f.id);
    };
    el.ondragover = e => { if (dragIds) { e.preventDefault(); el.classList.add("drop"); } };
    el.ondragleave = () => el.classList.remove("drop");
    el.ondrop = e => { e.preventDefault(); el.classList.remove("drop"); if (dragIds) doMove(dragIds, f.id); dragIds = null; };
    frag.appendChild(el);
  };
  for (const f of sys) add(f, 0, "");
  for (const f of user) {
    const parts = f.name.split("/");
    if (filter) { if (f.name.toLowerCase().includes(filter)) add(f, 0, ""); continue; }
    const parent = parts.slice(0, -1).join("/");
    let hidden = false;
    for (let i = 1; i < parts.length; i++) if (!state.expanded.has(parts.slice(0, i).join("/"))) { hidden = true; break; }
    if (hidden && parent) continue;
    const kids = hasChildren.has(f.name);
    add(f, parts.length - 1, kids ? (state.expanded.has(f.name) ? "▾" : "▸") : "");
  }
  nav.appendChild(frag);
  nav.querySelector("input").oninput = renderFolders;
}

function toggleExpand(name) {
  if (state.expanded.has(name)) state.expanded.delete(name); else state.expanded.add(name);
  saveSettings();
  renderFolders();
}

async function loadFolders(silent = false) {
  const r = await api.folders();
  state.folders = r.folders;
  state.byId = new Map(r.folders.map(f => [f.id, f]));
  const changed = [];
  for (const f of r.folders) {
    const prev = state.modseq.get(f.id);
    if (prev !== undefined && prev !== f.highestModSeq) changed.push(f.id);
    state.modseq.set(f.id, f.highestModSeq);
  }
  renderFolders();
  updateTitle();
  if (!silent) status(`${r.folders.length} folders`, r.ms);
  return changed;
}

function updateTitle() {
  const inbox = state.byId.get("1");
  document.title = (inbox?.unread ? `(${inbox.unread}) ` : "") + "YMail Lite";
}

// ---------- list ----------
async function loadList({ append = false, keepSelection = false } = {}) {
  const v = state.view;
  const offset = append ? state.offset + PAGE : 0;
  status(append ? "loading more…" : "loading…");
  const r = v.kind === "search" ? await api.search(v.term, null, PAGE, offset) : await api.list(v.folderId, PAGE, offset);
  const prevOpen = state.openId;
  state.messages = append ? state.messages.concat(r.messages) : r.messages;
  state.offset = offset;
  state.more = r.messages.length === PAGE;
  if (!append) state.selected = keepSelection ? state.messages.findIndex(m => m.id === prevOpen) : -1;
  if (!append) { const ids = new Set(state.messages.map(m => m.id)); for (const id of state.marked) if (!ids.has(id)) state.marked.delete(id); }
  renderList();
  const name = v.kind === "search" ? `search: ${v.term}` : (state.byId.get(v.folderId)?.name || v.folderId);
  $("list-title").textContent = name;
  $("list-count").textContent = `${state.messages.length}${state.more ? "+" : ""}`;
  status(`${name}: ${r.messages.length} messages`, r.ms);
}

function renderList() {
  const rows = $("rows");
  rows.innerHTML = "";
  const frag = document.createDocumentFragment();
  let lastDay = null;
  const showFolder = state.view.kind === "search";
  state.messages.forEach((m, i) => {
    const h = m.headers || {};
    const day = dayLabel(h.date);
    if (day !== lastDay) { const d = document.createElement("div"); d.className = "day"; d.textContent = day; frag.appendChild(d); lastDay = day; }
    const el = document.createElement("div");
    el.className = "row" + (m.flags?.read ? "" : " unread") + (i === state.selected ? " sel" : "") + (state.marked.has(m.id) ? " marked" : "");
    el.dataset.i = i;
    el.draggable = true;
    const who = state.view.folderId === "2" || state.view.folderId === "3" ? (h.to?.[0]) : (h.from?.[0]);
    const flags = (m.flags?.flagged ? "★" : "") + (m.attachmentCount ? "⌘" : "");
    el.innerHTML = `<span class="fl">${flags}</span><span class="fr" title="${esc(addr(who))}">${esc(who?.name || who?.email || "")}</span>` +
      `<span class="sb">${subjectHtml(h.subject)}${showFolder ? `<em>${esc(m.folder?.name || "")}</em>` : ""}</span>` +
      `<span class="dt">${fmtDate(h.date)}</span>`;
    el.onclick = e => {
      if (e.shiftKey) { markRange(state.anchor < 0 ? i : state.anchor, i); select(i, false); return; }
      if (e.ctrlKey || e.metaKey) { toggleMark(i); select(i, false); return; }
      clearMarks(); select(i); open(i);
    };
    el.oncontextmenu = e => { e.preventDefault(); if (!state.marked.has(m.id)) { clearMarks(); } select(i, false); showContextMenu(e.clientX, e.clientY); };
    el.ondragstart = e => {
      if (!state.marked.has(m.id)) { clearMarks(); select(i, false); }
      dragIds = targetIds();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", `${dragIds.length} message(s)`);
      el.classList.add("dragging");
    };
    el.ondragend = () => { el.classList.remove("dragging"); dragIds = null; };
    frag.appendChild(el);
  });
  rows.appendChild(frag);
  $("more").classList.toggle("hidden", !state.more);
  updateToolbar();
}

let dragIds = null;

function rowEl(i) { return $("rows").querySelector(`.row[data-i="${i}"]`); }

function toggleMark(i) {
  const m = state.messages[i]; if (!m) return;
  if (state.marked.has(m.id)) state.marked.delete(m.id); else state.marked.add(m.id);
  state.anchor = i;
  rowEl(i)?.classList.toggle("marked", state.marked.has(m.id));
  updateToolbar();
}

function markRange(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) { state.marked.add(state.messages[i].id); rowEl(i)?.classList.add("marked"); }
  updateToolbar();
}

function clearMarks() {
  if (!state.marked.size) return;
  state.marked.clear();
  $("rows").querySelectorAll(".row.marked").forEach(e => e.classList.remove("marked"));
  updateToolbar();
}

// Ids an action applies to: the multi-selection if any, else the highlighted row.
function targetIds() {
  if (state.marked.size) return state.messages.filter(m => state.marked.has(m.id)).map(m => m.id);
  const m = state.messages[state.selected];
  return m ? [m.id] : [];
}

function updateToolbar() {
  const n = state.marked.size || (state.selected >= 0 ? 1 : 0);
  for (const b of $("toolbar").querySelectorAll("button[data-act]")) {
    if (b.dataset.act === "undo") { b.disabled = !undoStack.length; continue; }
    if (b.dataset.act === "redo") { b.disabled = !redoStack.length; continue; }
    b.disabled = n === 0;
  }
  const msgs = state.messages.filter(m => state.marked.has(m.id));
  const first = msgs[0] || state.messages[state.selected];
  $("toolbar").querySelector('[data-act="read"]').textContent = first && !first.flags?.read ? "Mark read" : "Mark unread";
  $("toolbar").querySelector('[data-act="star"]').textContent = first && first.flags?.flagged ? "Unstar" : "Star";
  $("list-count").textContent = `${state.messages.length}${state.more ? "+" : ""}` + (state.marked.size ? ` · ${state.marked.size} selected` : "");
}

function select(i, resetAnchor = true) {
  if (i < 0 || i >= state.messages.length) return;
  state.selected = i;
  if (resetAnchor) state.anchor = i;
  $("rows").querySelectorAll(".row.sel").forEach(e => e.classList.remove("sel"));
  const el = rowEl(i);
  if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }); }
  updateToolbar();
}

// ---------- reader ----------
let currentBody = null;
let markReadTimer = null;

function bodyDoc(html, images) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${images ? "https: data:" : "'none'"};`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank"><style>body{margin:12px 16px;font:14px/1.45 -apple-system,"Segoe UI",system-ui,sans-serif;color:#111;word-wrap:break-word}` +
    `img{max-width:100%;height:auto${images ? "" : ";display:none"}}pre{white-space:pre-wrap}blockquote{border-left:3px solid #ccc;margin:6px 0;padding-left:10px;color:#444}</style></head>` +
    `<body>${html}</body></html>`;
}

async function open(i) {
  const m = state.messages[i];
  if (!m) return;
  state.openId = m.id;
  status("fetching body…");
  let r;
  try { r = await api.body(m.id); } catch (e) { status(`body failed: ${e.message}`); return; }
  if (state.openId !== m.id) return;
  currentBody = r;
  const h = r.message.headers || {};
  $("reader-empty").classList.add("hidden");
  $("reader-head").classList.remove("hidden");
  $("r-body").classList.remove("hidden");
  $("r-subject").textContent = (h.subject || "(no subject)").replace(/\^_/g, "");
  $("r-from").textContent = addrs(h.from);
  $("r-to").textContent = addrs(h.to);
  $("r-cc-row").classList.toggle("hidden", !(h.cc && h.cc.length));
  $("r-cc").textContent = addrs(h.cc);
  $("r-date").textContent = new Date(Number(h.date) * 1000).toLocaleString();
  $("r-folder").textContent = r.message.folder?.name || "";
  const hasImg = /<img\b/i.test(r.html);
  $("r-images").classList.toggle("hidden", !hasImg);
  const att = $("r-attach");
  att.innerHTML = r.attachments.filter(a => a.disposition !== "inline").map(a =>
    `<a href="${esc(a.downloadUrl)}" target="_blank" rel="noopener">${esc(a.filename)}</a><span style="color:var(--fg3)">${Math.round((a.size || 0) / 1024)} KB</span> `).join("");
  att.classList.toggle("hidden", !att.innerHTML);
  $("r-body").srcdoc = bodyDoc(r.html, false);
  status((h.subject || "").replace(/\^_/g, "").slice(0, 60), r.ms);
  clearTimeout(markReadTimer);
  if (settings.markReadSec != null && !m.flags?.read) {
    markReadTimer = setTimeout(async () => {
      if (state.openId !== m.id || m.flags?.read) return;
      try { await api.setRead([m.id], true); applyFlags([m.id], { read: true }); } catch (e) { status(`mark read failed: ${e.message}`); }
    }, settings.markReadSec * 1000);
  }
}

function loadImages() {
  if (currentBody) $("r-body").srcdoc = bodyDoc(currentBody.html, true);
}

// ---------- local model updates ----------
function applyFlags(ids, flags) {
  const set = new Set(ids);
  state.messages.forEach((m, i) => {
    if (!set.has(m.id)) return;
    const wasUnread = !m.flags?.read;
    m.flags = { ...(m.flags || {}), ...flags };
    const el = rowEl(i);
    if (el) {
      el.classList.toggle("unread", !m.flags.read);
      el.querySelector(".fl").textContent = (m.flags.flagged ? "★" : "") + (m.attachmentCount ? "⌘" : "");
    }
    if ("read" in flags && wasUnread !== !m.flags.read) {
      const f = state.byId.get(m.folder?.id);
      if (f) f.unread = Math.max(0, (f.unread || 0) + (m.flags.read ? -1 : 1));
    }
  });
  renderFolders(); updateTitle(); updateToolbar();
}

// Remove rows that left the current folder view and keep the cursor on a sensible row.
function removeLocal(ids) {
  const set = new Set(ids);
  const keep = state.messages.filter(m => !set.has(m.id));
  if (keep.length === state.messages.length) return;
  const cur = state.messages[state.selected];
  const curRemoved = cur && set.has(cur.id);
  state.messages = keep;
  for (const id of ids) state.marked.delete(id);
  if (curRemoved) { state.selected = Math.min(state.selected, keep.length - 1); if (state.openId && set.has(state.openId)) clearReader(); }
  else state.selected = keep.findIndex(m => m.id === cur?.id);
  renderList();
  if (curRemoved && state.selected >= 0) select(state.selected);
}

function clearReader() {
  state.openId = null; currentBody = null;
  $("reader-empty").classList.remove("hidden");
  $("reader-head").classList.add("hidden");
  $("r-body").classList.add("hidden");
}

function bumpFolder(id, dTotal, dUnread) {
  const f = state.byId.get(id); if (!f) return;
  f.total = Math.max(0, (f.total || 0) + dTotal);
  f.unread = Math.max(0, (f.unread || 0) + dUnread);
}

// ---------- undo ----------
const undoStack = [], redoStack = [];
const UNDO_MAX = 50;

function pushUndo(entry) {
  undoStack.push(entry); if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  showUndo();
}

function showUndo() {
  const u = undoStack[undoStack.length - 1], r = redoStack[redoStack.length - 1];
  $("st-undo").textContent = (u ? `Undo: ${u.label} (z)` : "") + (u && r ? "   " : "") + (r ? `Redo: ${r.label} (Shift+Z)` : "");
  updateToolbar();
}

async function undo() {
  const e = undoStack.pop(); if (!e) return;
  status(`undoing: ${e.label}…`);
  try { await e.undo(); redoStack.push(e); status(`undone: ${e.label}`); }
  catch (err) { undoStack.push(e); status(`undo failed: ${err.message}`); }
  showUndo();
  await loadList({ keepSelection: true });
}

async function redo() {
  const e = redoStack.pop(); if (!e) return;
  status(`redoing: ${e.label}…`);
  try { await e.redo(); undoStack.push(e); status(`redone: ${e.label}`); }
  catch (err) { redoStack.push(e); status(`redo failed: ${err.message}`); }
  showUndo();
  await loadList({ keepSelection: true });
}

// ---------- actions ----------
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const byIds = ids => { const set = new Set(ids); return state.messages.filter(m => set.has(m.id)); };

async function doSetRead(ids, read) {
  if (!ids.length) return;
  const before = byIds(ids).map(m => [m.id, !!m.flags?.read]);
  try {
    const r = await api.setRead(ids, read);
    applyFlags(ids, { read });
    status(`marked ${plural(ids.length, "message")} ${read ? "read" : "unread"}`, r.ms);
    pushUndo({ label: `mark ${plural(ids.length, "message")} ${read ? "read" : "unread"}`,
      undo: async () => { for (const [id, was] of before) await api.setRead([id], was); },
      redo: () => api.setRead(ids, read) });
  } catch (e) { status(`failed: ${e.message}`); }
}

async function doSetStarred(ids, flagged) {
  if (!ids.length) return;
  try {
    const r = await api.setStarred(ids, flagged);
    applyFlags(ids, { flagged });
    status(`${flagged ? "starred" : "unstarred"} ${plural(ids.length, "message")}`, r.ms);
    pushUndo({ label: `${flagged ? "star" : "unstar"} ${plural(ids.length, "message")}`,
      undo: () => api.setStarred(ids, !flagged), redo: () => api.setStarred(ids, flagged) });
  } catch (e) { status(`failed: ${e.message}`); }
}

async function doMove(ids, folderId, verb = "move") {
  if (!ids.length) return;
  const dest = state.byId.get(String(folderId)); if (!dest) return;
  const msgs = byIds(ids);
  const origins = msgs.map(m => [m.id, m.folder?.id, !m.flags?.read]);
  if (origins.every(([, from]) => from === dest.id)) { status(`already in ${dest.name}`); return; }
  try {
    const r = await api.move(ids, dest.id);
    for (const [, from, unread] of origins) { bumpFolder(from, -1, unread ? -1 : 0); bumpFolder(dest.id, 1, unread ? 1 : 0); }
    if (state.view.kind === "folder" && state.view.folderId !== dest.id) removeLocal(ids);
    else for (const m of msgs) m.folder = { ...(m.folder || {}), id: dest.id, name: dest.name };
    renderFolders(); updateTitle();
    const label = `${verb} ${plural(ids.length, "message")} to ${dest.name.split("/").pop()}`;
    status(label.replace(/^move/, "moved").replace(/^archive/, "archived").replace(/^delete/, "deleted"), r.ms);
    pushUndo({ label,
      undo: async () => { const groups = new Map(); for (const [id, from] of origins) { if (!groups.has(from)) groups.set(from, []); groups.get(from).push(id); }
        for (const [from, g] of groups) await api.move(g, from); },
      redo: () => api.move(ids, dest.id) });
  } catch (e) { status(`failed: ${e.message}`); }
}

async function doArchive(ids) {
  const f = folderByType("ARCHIVE"); if (!f) { status("no Archive folder"); return; }
  await doMove(ids, f.id, "archive");
}

async function doDelete(ids) {
  if (!ids.length) return;
  const trash = folderByType("TRASH"); if (!trash) return;
  const msgs = byIds(ids);
  const inTrash = msgs.filter(m => m.folder?.id === trash.id).map(m => m.id);
  const rest = ids.filter(id => !inTrash.includes(id));
  if (rest.length) await doMove(rest, trash.id, "delete");
  if (inTrash.length) {
    if (!confirm(`Permanently delete ${plural(inTrash.length, "message")} from Trash? This cannot be undone.`)) return;
    try {
      const r = await api.deleteForever(inTrash);
      for (const m of byIds(inTrash)) bumpFolder(trash.id, -1, m.flags?.read ? 0 : -1);
      removeLocal(inTrash); renderFolders();
      status(`permanently deleted ${plural(inTrash.length, "message")}`, r.ms);
    } catch (e) { status(`failed: ${e.message}`); }
  }
}

function runAction(act) {
  const ids = targetIds();
  const first = byIds(ids)[0];
  switch (act) {
    case "archive": return doArchive(ids);
    case "delete": return doDelete(ids);
    case "move": return openMovePicker(ids);
    case "read": return doSetRead(ids, first ? !first.flags?.read : true);
    case "star": return doSetStarred(ids, first ? !first.flags?.flagged : true);
    case "undo": return undo();
    case "redo": return redo();
    case "open": if (state.selected >= 0) open(state.selected); return;
  }
}

// ---------- context menu ----------
function showContextMenu(x, y) {
  const ids = targetIds(); if (!ids.length) return;
  const first = byIds(ids)[0];
  const n = ids.length > 1 ? ` (${ids.length})` : "";
  const items = [
    ["open", "Open"], null,
    ["read", (first.flags?.read ? "Mark unread" : "Mark read") + n],
    ["star", (first.flags?.flagged ? "Unstar" : "Star") + n], null,
    ["archive", "Archive" + n], ["move", "Move to…" + n], ["delete", "Delete" + n],
  ];
  const ctx = $("ctx");
  ctx.innerHTML = items.map(it => it ? `<div data-act="${it[0]}">${esc(it[1])}</div>` : "<hr>").join("");
  ctx.classList.remove("hidden");
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = Math.min(x, innerWidth - w - 4) + "px";
  ctx.style.top = Math.min(y, innerHeight - h - 4) + "px";
  ctx.onclick = e => { const a = e.target.closest("[data-act]"); hideContextMenu(); if (a) runAction(a.dataset.act); };
}
function hideContextMenu() { $("ctx").classList.add("hidden"); }
document.addEventListener("mousedown", e => { if (!e.target.closest("#ctx")) hideContextMenu(); });
window.addEventListener("blur", hideContextMenu);

// ---------- move picker ----------
let moveTargets = [], moveKb = 0, moveIds = [];
function openMovePicker(ids) {
  if (!ids.length) return;
  moveIds = ids;
  $("movebox").classList.remove("hidden");
  $("move-filter").value = "";
  renderMoveList();
  $("move-filter").focus();
}
function renderMoveList() {
  const filter = $("move-filter").value.toLowerCase();
  const cur = state.view.kind === "folder" ? state.view.folderId : null;
  moveTargets = state.folders.filter(f => !f.types.some(t => t === "SYNC" || t === "INVISIBLE") && f.id !== cur && !f.types.includes("DRAFT"))
    .filter(f => !filter || f.name.toLowerCase().includes(filter))
    .sort((a, b) => (folderType(b) ? 1 : 0) - (folderType(a) ? 1 : 0) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  moveKb = 0;
  $("move-list").innerHTML = moveTargets.map((f, i) => `<div data-i="${i}" class="${i === moveKb ? "kb" : ""}">${esc(f.name)}</div>`).join("");
}
function closeMovePicker() { $("movebox").classList.add("hidden"); $("list").focus(); }
function wireMovePicker() {
  $("move-filter").oninput = renderMoveList;
  $("move-list").onclick = e => { const d = e.target.closest("[data-i]"); if (!d) return; const f = moveTargets[Number(d.dataset.i)]; closeMovePicker(); doMove(moveIds, f.id); };
  $("movebox").onclick = e => { if (e.target.id === "movebox") closeMovePicker(); };
  $("move-filter").onkeydown = e => {
    if (e.key === "Escape") { closeMovePicker(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveKb = Math.max(0, Math.min(moveTargets.length - 1, moveKb + (e.key === "ArrowDown" ? 1 : -1)));
      $("move-list").querySelectorAll("div").forEach((d, i) => d.classList.toggle("kb", i === moveKb));
      $("move-list").children[moveKb]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { const f = moveTargets[moveKb]; if (f) { closeMovePicker(); doMove(moveIds, f.id); } }
    e.stopPropagation();
  };
}

// ---------- navigation ----------
async function openFolder(id) {
  state.view = { kind: "folder", folderId: id, term: "" };
  $("search").value = "";
  renderFolders();
  await loadList();
  $("list").focus();
}

async function doSearch(term) {
  term = term.trim();
  if (!term) return;
  state.view = { kind: "search", folderId: null, term };
  renderFolders();
  await loadList();
  $("list").focus();
}

function folderByType(t) { return state.folders.find(f => f.types.includes(t)); }

// ---------- keyboard ----------
let pendingG = false;
function onKey(e) {
  const inSearch = document.activeElement === $("search");
  const inFolderFilter = document.activeElement?.parentElement?.id === "folders";
  if (document.activeElement?.closest("#settings")) { if (e.key === "Escape") openSettings(false); return; }
  if (document.activeElement?.closest("#movebox")) return;
  if (e.key === "Escape") {
    if (!$("help").classList.contains("hidden")) { $("help").classList.add("hidden"); return; }
    if (!$("settings").classList.contains("hidden")) { openSettings(false); return; }
    if (inSearch) { $("search").value = ""; $("search").blur(); if (state.view.kind === "search") openFolder("1"); return; }
    if (inFolderFilter) { $("list").focus(); return; }
    if (!$("ctx").classList.contains("hidden")) { hideContextMenu(); return; }
    if (state.marked.size) { clearMarks(); return; }
  }
  if (inSearch) { if (e.key === "Enter") doSearch($("search").value); return; }
  if (inFolderFilter) {
    const items = [...$("folders").querySelectorAll(".folder")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      state.kbFolder = Math.max(0, Math.min(items.length - 1, state.kbFolder + (e.key === "ArrowDown" ? 1 : -1)));
      items.forEach((el, i) => el.classList.toggle("kb", i === state.kbFolder));
      items[state.kbFolder]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const el = items[state.kbFolder] || items[0];
      if (el) openFolder(el.dataset.id);
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === "z" || e.key === "Z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (e.key === "y") { e.preventDefault(); redo(); }
    else if (e.key === "a" && document.activeElement === $("list")) { e.preventDefault(); markRange(0, state.messages.length - 1); }
    return;
  }
  if (e.altKey) return;
  if (pendingG) {
    pendingG = false;
    const map = { i: "INBOX", s: "SENT", t: "TRASH", d: "DRAFT", a: "ARCHIVE", b: "BULK" };
    if (map[e.key]) { const f = folderByType(map[e.key]); if (f) openFolder(f.id); return; }
    if (e.key === "f") { $("folders").querySelector("input").focus(); state.kbFolder = -1; return; }
    return;
  }
  switch (e.key) {
    case "j": case "ArrowDown": e.preventDefault(); select(state.selected + 1); break;
    case "k": case "ArrowUp": e.preventDefault(); select(state.selected - 1); break;
    case "Enter": case "o": if (state.selected >= 0) open(state.selected); break;
    case "/": e.preventDefault(); $("search").focus(); $("search").select(); break;
    case "g": pendingG = true; setTimeout(() => pendingG = false, 1200); break;
    case "r": loadList({ keepSelection: true }); break;
    case "n": if (state.more) loadList({ append: true }); break;
    case "i": loadImages(); break;
    case "t": toggleTheme(); break;
    case ",": openSettings(true); break;
    case "?": $("help").classList.toggle("hidden"); break;
    case "Home": select(0); break;
    case "End": select(state.messages.length - 1); break;
    case "x": toggleMark(state.selected); break;
    case "e": runAction("archive"); break;
    case "#": case "Delete": runAction("delete"); break;
    case "v": e.preventDefault(); runAction("move"); break;
    case "u": runAction("read"); break;
    case "s": runAction("star"); break;
    case "z": undo(); break;
    case "Z": redo(); break;
  }
}

// ---------- theme / settings ----------
function toggleTheme() {
  settings.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applySettings(); saveSettings();
}

function openSettings(show) { $("settings").classList.toggle("hidden", !show); }

function wireSettings() {
  for (const [sel, dark] of [["darkTheme", true], ["lightTheme", false]]) {
    const el = $(sel);
    el.innerHTML = Object.entries(THEMES).filter(([, t]) => t.dark === dark).map(([id, t]) => `<option value="${id}">${t.name}</option>`).join("");
    el.onchange = () => { settings[sel] = el.value; applySettings(); saveSettings(); };
  }
  for (const el of document.querySelectorAll("#settings input[type=radio]"))
    el.onchange = () => { settings[el.name] = el.value; applySettings(); saveSettings(); };
  $("poll").onchange = () => { settings.pollSec = Math.max(5, Number($("poll").value) || 20); applySettings(); saveSettings(); };
  $("markread").onchange = () => { const v = $("markread").value.trim(); settings.markReadSec = v === "" ? null : Math.max(0, Number(v) || 0); saveSettings(); };
  $("density").onchange = () => { settings.rowH = Math.min(32, Math.max(18, Number($("density").value) || 22)); applySettings(); saveSettings(); };
  $("settings-close").onclick = () => openSettings(false);
  $("settings-reset").onclick = () => { Object.assign(settings, { folderW: DEFAULTS.folderW, listW: DEFAULTS.listW, listH: DEFAULTS.listH }); applySettings(); saveSettings(); };
  $("settings").onclick = e => { if (e.target.id === "settings") openSettings(false); };
  $("gear").onclick = () => openSettings($("settings").classList.contains("hidden"));
}

// ---------- splitters ----------
function wireSplitters() {
  const drag = (el, onMove) => {
    el.onmousedown = e => {
      e.preventDefault();
      el.classList.add("drag"); document.body.classList.add("dragging");
      const move = ev => { onMove(ev); applySettings(); };
      const up = () => { el.classList.remove("drag"); document.body.classList.remove("dragging");
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); saveSettings(); };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    };
  };
  const app = $("app");
  drag($("split1"), ev => { settings.folderW = Math.max(120, Math.min(600, ev.clientX)); });
  drag($("split2"), ev => {
    if (settings.layout === "horizontal") {
      const top = $("top").getBoundingClientRect().bottom, bottom = $("status").getBoundingClientRect().top;
      settings.listH = Math.max(15, Math.min(85, Math.round((ev.clientY - top) / (bottom - top) * 100)));
    } else {
      settings.listW = Math.max(200, Math.min(app.clientWidth - settings.folderW - 300, ev.clientX - settings.folderW - 5));
    }
  });
}

// ---------- polling ----------
async function poll() {
  try {
    const changed = await loadFolders(true);
    const v = state.view;
    if (v.kind === "folder" && changed.includes(v.folderId)) await loadList({ keepSelection: true });
  } catch (e) { status(`poll failed: ${e.message}`); }
}

// ---------- startup ----------
async function start() {
  await loadSettings();
  applySettings();
  $("signin").classList.add("hidden");
  try {
    const s = await api.bootstrap();
    $("account").textContent = s.email;
  } catch (e) {
    if (e instanceof api.NotSignedIn) { $("signin").classList.remove("hidden"); $("app").classList.add("hidden"); return; }
    throw e;
  }
  $("app").classList.remove("hidden");
  await loadFolders();
  await openFolder("1");
}

document.addEventListener("keydown", onKey);
$("retry").onclick = () => api.bootstrap(true).then(start, start);
wireSettings();
wireSplitters();
wireMovePicker();
$("toolbar").onclick = e => { const b = e.target.closest("button[data-act]"); if (b && !b.disabled) runAction(b.dataset.act); };
$("r-images").onclick = loadImages;
$("more-btn").onclick = () => loadList({ append: true });
$("help").onclick = e => { if (e.target.id === "help") $("help").classList.add("hidden"); };
start().catch(e => { status(`error: ${e.message}`); console.error(e); });
