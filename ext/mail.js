import * as api from "./api.js";
import { THEMES, applyTheme } from "./themes.js";

const $ = id => document.getElementById(id);
const SYSTEM_ORDER = ["INBOX", "DRAFT", "SENT", "ARCHIVE", "BULK", "TRASH"];
const PAGE = 100;

const DEFAULTS = { layout: "vertical", theme: "dark", darkTheme: "dark", lightTheme: "light", pollSec: 20, rowH: 22, folderW: 230, listW: 460, listH: 40, expanded: [] };
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
  clearInterval(state.polling);
  state.polling = setInterval(poll, Math.max(5, settings.pollSec) * 1000);
}
systemDark.addEventListener("change", () => { if (settings.theme === "system") applySettings(); });

const state = {
  folders: [], byId: new Map(), expanded: new Set(),
  view: { kind: "folder", folderId: "1", term: "" },
  messages: [], offset: 0, more: false, selected: -1, openId: null,
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
    el.className = "row" + (m.flags?.read ? "" : " unread") + (i === state.selected ? " sel" : "");
    el.dataset.i = i;
    const who = state.view.folderId === "2" || state.view.folderId === "3" ? (h.to?.[0]) : (h.from?.[0]);
    const flags = (m.flags?.flagged ? "★" : "") + (m.attachmentCount ? "⌘" : "");
    el.innerHTML = `<span class="fl">${flags}</span><span class="fr" title="${esc(addr(who))}">${esc(who?.name || who?.email || "")}</span>` +
      `<span class="sb">${subjectHtml(h.subject)}${showFolder ? `<em>${esc(m.folder?.name || "")}</em>` : ""}</span>` +
      `<span class="dt">${fmtDate(h.date)}</span>`;
    el.onclick = () => { select(i); open(i); };
    frag.appendChild(el);
  });
  rows.appendChild(frag);
  $("more").classList.toggle("hidden", !state.more);
}

function select(i) {
  if (i < 0 || i >= state.messages.length) return;
  state.selected = i;
  $("rows").querySelectorAll(".row.sel").forEach(e => e.classList.remove("sel"));
  const el = $("rows").querySelector(`.row[data-i="${i}"]`);
  if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }); }
}

// ---------- reader ----------
let currentBody = null;

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
}

function loadImages() {
  if (currentBody) $("r-body").srcdoc = bodyDoc(currentBody.html, true);
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
  if (e.key === "Escape") {
    if (!$("help").classList.contains("hidden")) { $("help").classList.add("hidden"); return; }
    if (!$("settings").classList.contains("hidden")) { openSettings(false); return; }
    if (inSearch) { $("search").value = ""; $("search").blur(); if (state.view.kind === "search") openFolder("1"); return; }
    if (inFolderFilter) { $("list").focus(); return; }
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
  if (e.ctrlKey || e.altKey || e.metaKey) return;
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
$("r-images").onclick = loadImages;
$("more-btn").onclick = () => loadList({ append: true });
$("help").onclick = e => { if (e.target.id === "help") $("help").classList.add("hidden"); };
start().catch(e => { status(`error: ${e.message}`); console.error(e); });
