import * as api from "./api.js";
import { THEMES, applyTheme } from "./themes.js";
import * as compose from "./compose.js";
import * as contacts from "./contacts.js";

const $ = id => document.getElementById(id);
const SYSTEM_ORDER = ["INBOX", "DRAFT", "SENT", "ARCHIVE", "BULK", "TRASH"];
const PAGE = 100;
const DRAG_TYPE = "application/x-ymail-ids";

// ---------- settings ----------
const DEFAULTS = { layout: "vertical", theme: "dark", darkTheme: "dark", lightTheme: "light", pollSec: 20, markReadSec: 2, undoSendSec: 10, composeHtml: true, composeFont: "Helvetica Neue, Helvetica, Arial, sans-serif", composeSize: 13, images: "safe", rowH: 22, folderW: 230, listW: 460, listH: 40, expanded: [] };
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

// Visual settings only; the poll timer is managed separately so drags don't restart it.
function applyLayout() {
  const mode = settings.theme === "system" ? (systemDark.matches ? "dark" : "light") : settings.theme;
  applyTheme(mode === "dark" ? settings.darkTheme : settings.lightTheme);
  $("app").classList.toggle("horizontal", settings.layout === "horizontal");
  const r = document.documentElement.style;
  r.setProperty("--folder-w", settings.folderW + "px");
  r.setProperty("--list-w", settings.listW + "px");
  r.setProperty("--list-h", settings.listH + "%");
  r.setProperty("--row-h", settings.rowH + "px");
}

function syncSettingsForm() {
  $("darkTheme").value = settings.darkTheme;
  $("lightTheme").value = settings.lightTheme;
  for (const el of document.querySelectorAll("#settings input[type=radio]")) el.checked = settings[el.name] === el.value;
  $("poll").value = settings.pollSec;
  $("density").value = settings.rowH;
  $("markread").value = settings.markReadSec == null ? "" : settings.markReadSec;
  $("undosend").value = settings.undoSendSec;
  $("composeFont").value = settings.composeFont; $("composeSize").value = String(settings.composeSize);
}

function applySettings() { applyLayout(); syncSettingsForm(); startPolling(); }
systemDark.addEventListener("change", () => { if (settings.theme === "system") applyLayout(); });

// ---------- state ----------
const state = {
  folders: [], byId: new Map(), expanded: new Set(),
  view: { kind: "folder", folderId: null, term: "" },
  messages: [], more: false, selected: -1, openId: null,
  marked: new Set(), anchor: -1,
  modseq: new Map(), polling: null, kbFolder: -1, listToken: 0, signedIn: false,
};

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const addr = a => a?.name ? `${a.name} <${a.email}>` : (a?.email || "");
const addrs = l => (l || []).map(addr).join(", ");
const status = (msg, ms) => { $("st-msg").textContent = msg; if (ms != null) $("st-lat").textContent = `${ms} ms`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const folderType = f => f ? (SYSTEM_ORDER.find(t => f.types?.includes(t)) || null) : null;
const folderByType = t => state.folders.find(f => f.types.includes(t));
const inboxId = () => folderByType("INBOX")?.id ?? "1";
const isHidden = f => f.types.some(t => t === "SYNC" || t === "INVISIBLE");
// Yahoo names the spam folder "Bulk" internally; the web UI shows it as Spam.
const folderName = f => f ? (folderType(f) === "BULK" ? "Spam" : f.name) : "";

function toDate(epoch) {
  const d = new Date(Number(epoch) * 1000);
  return isNaN(d) ? null : d;
}

function fmtDate(epoch) {
  const d = toDate(epoch); if (!d) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" });
}

function dayLabel(epoch) {
  const d = toDate(epoch); if (!d) return "Undated";
  const now = new Date();
  const diff = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { year: "numeric", month: "long" });
}

// Subjects from search carry ^_term^_ hit markers; turn them into <mark>.
const subjectHtml = s => esc(s || "(no subject)").replace(/\^_(.*?)\^_/g, "<mark>$1</mark>");
const plainSubject = s => (s || "(no subject)").replace(/\^_/g, "");

// Errors that mean "no session": show the sign-in panel instead of a status line.
function handleError(e, what) {
  if (e instanceof api.NotSignedIn) { showSignIn(); return; }
  status(`${what}: ${e.message}`);
  console.error(what, e);
}

// ---------- folders ----------
function renderFolders() {
  const list = $("folder-list");
  const filter = $("folder-filter").value.toLowerCase();
  const visible = state.folders.filter(f => !isHidden(f));
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
    el.innerHTML = `<span class="tw">${twisty}</span><span class="nm" title="${esc(folderName(f))}">${esc(folderName(f).split("/").pop())}</span><span class="ct"></span>`;
    el.onclick = e => {
      if (e.target.classList.contains("tw") && twisty) { toggleExpand(f.name); return; }
      openFolder(f.id);
    };
    const droppable = !["DRAFT", "SENT"].includes(folderType(f));
    el.ondragover = e => { if (droppable && e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); el.classList.add("drop"); } };
    el.ondragleave = () => el.classList.remove("drop");
    el.ondrop = e => {
      el.classList.remove("drop");
      if (!droppable || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      const ids = e.dataTransfer.getData(DRAG_TYPE).split(",").filter(Boolean);
      if (ids.length) run(() => doMove(ids, f.id));
    };
    frag.appendChild(el);
  };
  for (const f of sys) { if (filter && !folderName(f).toLowerCase().includes(filter)) continue; add(f, 0, ""); }
  for (const f of user) {
    const parts = f.name.split("/");
    if (filter) { if (folderName(f).toLowerCase().includes(filter)) add(f, 0, ""); continue; }
    let hidden = false;
    for (let i = 1; i < parts.length; i++) if (!state.expanded.has(parts.slice(0, i).join("/"))) { hidden = true; break; }
    if (hidden) continue;
    const kids = hasChildren.has(f.name);
    add(f, parts.length - 1, kids ? (state.expanded.has(f.name) ? "▾" : "▸") : "");
  }
  list.innerHTML = "";
  list.appendChild(frag);
  updateFolderCounts();
  const items = list.querySelectorAll(".folder");
  if (state.kbFolder >= 0 && items[state.kbFolder]) items[state.kbFolder].classList.add("kb");
}

// Patch counts in place so the tree (and any focus in its filter) is not rebuilt for a flag change.
function updateFolderCounts() {
  for (const el of $("folder-list").querySelectorAll(".folder")) {
    const f = state.byId.get(el.dataset.id); if (!f) continue;
    el.querySelector(".ct").textContent = f.unread ? f.unread : (f.total || "");
    el.classList.toggle("unread", !!f.unread);
  }
  updateTitle();
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
  if (!silent) status(`${r.folders.length} folders`, r.ms);
  return changed;
}

function updateTitle() {
  const inbox = folderByType("INBOX");
  document.title = (inbox?.unread ? `(${inbox.unread}) ` : "") + "YMail";
}

// ---------- list ----------
// mode: "fresh" (new view), "refresh" (same view, keep cursor and marks by id, same depth), "more" (next page).
async function loadList(mode = "fresh") {
  const v = state.view;
  const token = ++state.listToken;
  const prevView = state.prevView;
  const cursorId = state.messages[state.selected]?.id ?? null;
  const offset = mode === "more" ? state.messages.length : 0;
  const count = mode === "refresh" ? Math.max(PAGE, state.messages.length) : PAGE;
  if (mode === "fresh") { state.messages = []; state.selected = -1; state.anchor = -1; state.marked.clear(); state.more = false; renderList(); }
  else if (mode === "more" && !state.messages.length) return;
  status(mode === "more" ? "loading more…" : "loading…");
  let r;
  try {
    r = v.kind === "search" ? await api.search(v.raw || v.term, null, count, offset, !!v.raw) : await api.list(v.folderId, count, offset);
  } catch (e) {
    if (token !== state.listToken) return;
    if (mode === "fresh" && prevView) { state.view = prevView; renderFolders(); }
    handleError(e, "list");
    return;
  }
  if (token !== state.listToken) return;
  state.prevView = null;
  if (mode === "more") {
    const have = new Set(state.messages.map(m => m.id));
    state.messages = state.messages.concat(r.messages.filter(m => !have.has(m.id)));
  } else state.messages = r.messages;
  state.more = r.messages.length >= Math.min(count, PAGE);
  if (mode !== "more") {
    const ids = new Set(state.messages.map(m => m.id));
    for (const id of state.marked) if (!ids.has(id)) state.marked.delete(id);
    state.selected = mode === "refresh" ? state.messages.findIndex(m => m.id === cursorId) : -1;
    state.anchor = state.selected;
    if (state.openId && !ids.has(state.openId) && v.kind === "folder") clearReader();
  }
  renderList();
  const name = v.kind === "search" ? `search: ${v.term}` : (folderName(state.byId.get(v.folderId)) || v.folderId);
  $("list-title").textContent = name;
  status(`${name}: ${state.messages.length} messages`, r.ms);
}

function renderList() {
  const rows = $("rows");
  const scrollTop = rows.scrollTop;
  rows.innerHTML = "";
  dragging = null;
  const frag = document.createDocumentFragment();
  let lastDay = null;
  const showFolder = state.view.kind === "search";
  const outgoing = ["SENT", "DRAFT"].includes(folderType(state.byId.get(state.view.folderId)));
  state.messages.forEach((m, i) => {
    const h = m.headers || {};
    const day = dayLabel(h.date);
    if (day !== lastDay) { const d = document.createElement("div"); d.className = "day"; d.textContent = day; frag.appendChild(d); lastDay = day; }
    const el = document.createElement("div");
    el.className = "row" + (m.flags?.read ? "" : " unread") + (i === state.selected ? " sel" : "") + (state.marked.has(m.id) ? " marked" : "");
    el.dataset.i = i;
    el.draggable = true;
    const who = outgoing ? h.to?.[0] : h.from?.[0];
    el.innerHTML = `<span class="st" title="Star / unstar (s)"></span><span class="fl"></span><span class="fr" data-email="${esc(who?.email || "")}" data-name="${esc(who?.name || "")}">${esc(who?.name || who?.email || "")}</span>` +
      `<span class="sb">${subjectHtml(h.subject)}${showFolder ? `<em>${esc(m.folder?.name || "")}</em>` : ""}</span>` +
      `<span class="dt">${fmtDate(h.date)}</span>`;
    paintFlags(el, m);
    el.onclick = e => {
      if (e.target.classList.contains("st")) { e.stopPropagation(); run(() => doSetStarred([m.id], !m.flags?.flagged)); return; }
      if (e.shiftKey) { markRange(state.anchor < 0 ? i : state.anchor, i); select(i, false); return; }
      if (e.ctrlKey || e.metaKey) { toggleMark(i); select(i, false); return; }
      clearMarks(); select(i);
      if (folderType(state.byId.get(state.view.folderId)) === "DRAFT") editDraft(i); else open(i);
    };
    el.oncontextmenu = e => { e.preventDefault(); if (!state.marked.has(m.id)) clearMarks(); select(i, false); showContextMenu(e.clientX, e.clientY); };
    el.ondragstart = e => {
      if (!state.marked.has(m.id)) { clearMarks(); select(i, false); }
      const ids = targetIds();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_TYPE, ids.join(","));
      e.dataTransfer.setData("text/plain", `${ids.length} message(s)`);
      el.classList.add("dragging");
      dragging = el;
    };
    el.ondragend = () => { el.classList.remove("dragging"); dragging = null; };
    frag.appendChild(el);
  });
  rows.appendChild(frag);
  rows.scrollTop = scrollTop;
  $("more").classList.toggle("hidden", !state.more);
  updateToolbar();
}

let dragging = null;
document.addEventListener("dragend", () => { dragging?.classList.remove("dragging"); dragging = null; });

function paintFlags(el, m) {
  const st = el.querySelector(".st");
  st.textContent = m.flags?.flagged ? "★" : "☆";
  st.classList.toggle("on", !!m.flags?.flagged);
  el.querySelector(".fl").textContent = m.attachmentCount ? "📎" : "";
}
const rowEl = i => $("rows").querySelector(`.row[data-i="${i}"]`);

function select(i, resetAnchor = true) {
  if (i < 0 || i >= state.messages.length) return;
  state.selected = i;
  if (resetAnchor) state.anchor = i;
  $("rows").querySelectorAll(".row.sel").forEach(e => e.classList.remove("sel"));
  const el = rowEl(i);
  if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }); }
  updateToolbar();
}

function toggleMark(i) {
  const m = state.messages[i]; if (!m) return;
  if (state.marked.has(m.id)) state.marked.delete(m.id); else state.marked.add(m.id);
  state.anchor = i;
  rowEl(i)?.classList.toggle("marked", state.marked.has(m.id));
  updateToolbar();
}

function markRange(a, b) {
  const n = state.messages.length; if (!n) return;
  const clamp = x => Math.max(0, Math.min(n - 1, x));
  const [lo, hi] = a < b ? [clamp(a), clamp(b)] : [clamp(b), clamp(a)];
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

function spamLabel(ids) {
  const msgs = byIds(ids || targetIds());
  return inSpamView() || (msgs.length && msgs.every(m => folderType(state.byId.get(m.folder?.id)) === "BULK")) ? "Not spam" : "Spam";
}

function updateToolbar() {
  const n = state.marked.size || (state.selected >= 0 ? 1 : 0);
  for (const b of $("toolbar").querySelectorAll("button[data-act]")) {
    if (b.dataset.act === "undo") b.disabled = busy || !undoStack.length;
    else if (b.dataset.act === "redo") b.disabled = busy || !redoStack.length;
    else b.disabled = busy || n === 0;
  }
  const first = state.messages.filter(m => state.marked.has(m.id))[0] || state.messages[state.selected];
  $("toolbar").querySelector('[data-act="read"]').textContent = first && !first.flags?.read ? "Mark read" : "Mark unread";
  $("toolbar").querySelector('[data-act="star"]').textContent = first && first.flags?.flagged ? "Unstar" : "Star";
  $("toolbar").querySelector('[data-act="spam"]').textContent = spamLabel();
  $("list-count").textContent = `${state.messages.length}${state.more ? "+" : ""}` + (state.marked.size ? ` · ${state.marked.size} selected` : "");
}

// ---------- reader ----------
let currentBody = null;
let markReadTimer = null;

// Yahoo's HTML is server-sanitised; this strips what could still navigate or beacon from the frame.
function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, meta, link, base, object, embed, iframe, form").forEach(e => e.remove());
  for (const el of doc.querySelectorAll("*")) {
    for (const a of [...el.attributes]) {
      if (a.name === "ping" || a.name.startsWith("on")) el.removeAttribute(a.name);
      else if (/^(href|src|action)$/.test(a.name) && !/^(https?:|mailto:|cid:|#)/i.test(a.value.trim())) el.removeAttribute(a.name);
    }
  }
  return doc.body.innerHTML;
}

// Inline parts (cid images) are served by cloud-apis.mail.yahoo.com and need the session cookies,
// which the sandboxed frame cannot send. Fetch them here and hand the frame data: URLs instead.
const partCache = new Map();
async function inlineYahooParts(html) {
  const re = /(<img\b[^>]*?\ssrc=)(["'])(https:\/\/[a-z0-9.-]*mail\.yahoo\.com\/[^"']+)\2/gi;
  const urls = [...new Set([...html.matchAll(re)].map(m => m[3]))].slice(0, 60);
  if (!urls.length) return html;
  await Promise.all(urls.map(async u => {
    if (partCache.has(u)) return;
    try {
      const resp = await fetch(u.replace(/&amp;/g, "&"), { credentials: "include" });
      if (!resp.ok) throw new Error(resp.status);
      const blob = await resp.blob();
      if (!/^image\//.test(blob.type) && blob.type) throw new Error(blob.type);
      const dataUrl = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(blob); });
      partCache.set(u, dataUrl);
    } catch { partCache.set(u, null); }
  }));
  return html.replace(re, (m, pre, qu, u) => partCache.get(u) ? `${pre}${qu}${partCache.get(u)}${qu}` : m);
}

// ---------- contact cards ----------
// Hover an address in the reader header or a sender in the list to see what the address book
// knows about the person and the last messages exchanged with them.
const addrHtml = l => (l || []).map(a => `<span class="who" data-email="${esc(a.email || "")}" data-name="${esc(a.name || "")}">${esc(a.name ? `${a.name} <${a.email}>` : a.email || "")}</span>`).join(", ");

let cardTimer = null, cardHideTimer = null, cardFor = null;
function wireContactCards() {
  const show = el => {
    clearTimeout(cardHideTimer); clearTimeout(cardTimer);
    const email = el.dataset.email; if (!email) return;
    cardTimer = setTimeout(() => openCard(el, email, el.dataset.name), 450);
  };
  const leave = () => { clearTimeout(cardTimer); cardHideTimer = setTimeout(closeCard, 250); };
  document.addEventListener("mouseover", e => { const el = e.target.closest(".who, .row .fr"); if (el) show(el); else if (e.target.closest("#card")) clearTimeout(cardHideTimer); });
  document.addEventListener("mouseout", e => { if (e.target.closest(".who, .row .fr, #card")) leave(); });
}

function closeCard() { $("card").classList.add("hidden"); cardFor = null; }

async function openCard(anchor, email, name) {
  const card = $("card");
  cardFor = email;
  const c = await contacts.lookup(email);
  const me = email.toLowerCase() === $("account").textContent.toLowerCase();
  const when = s => s ? new Date(s * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "never";
  card.innerHTML = `<div class="card-head"><b>${esc(c?.name || name || email)}</b><span>${esc(email)}</span></div>
    <div class="card-stats">${me ? "This is you." : c ? `You wrote ${plural(c.sent, "time")} · they wrote ${plural(c.received, "time")}<br>Last exchange ${when(c.last)}` : "Not in your address book yet."}</div>
    <div class="card-actions"><button data-c="write">Write</button><button data-c="search">All mail</button><button data-c="copy">Copy address</button></div>
    <div class="card-recent"><i>loading recent messages…</i></div>`;
  const r = anchor.getBoundingClientRect();
  card.classList.remove("hidden");
  card.style.left = Math.max(4, Math.min(r.left, innerWidth - card.offsetWidth - 8)) + "px";
  card.style.top = (r.bottom + card.offsetHeight + 6 > innerHeight ? Math.max(4, r.top - card.offsetHeight - 4) : r.bottom + 4) + "px";
  card.onclick = async e => {
    const b = e.target.closest("[data-c]"); if (!b) return;
    if (b.dataset.c === "write") { closeCard(); await startCompose("new"); compose.addRecipient({ name: c?.name || name || "", email }); }
    else if (b.dataset.c === "search") { closeCard(); searchPerson(email); }
    else if (b.dataset.c === "copy") { await navigator.clipboard.writeText(email).catch(() => {}); b.textContent = "Copied"; }
  };
  const q = personQuery(email);
  let res;
  try { res = await api.search(q, null, 5, 0, true); } catch { res = { messages: [] }; }
  if (cardFor !== email) return;
  const recent = card.querySelector(".card-recent");
  recent.innerHTML = res.messages.length ? res.messages.map(m => {
    const out = (m.headers.from?.[0]?.email || "").toLowerCase() !== email.toLowerCase();
    return `<div title="${esc(plainSubject(m.headers.subject))}"><span class="dir">${out ? "→" : "←"}</span><span class="subj">${esc(plainSubject(m.headers.subject))}</span><span class="dt">${fmtDate(m.headers.date)}</span></div>`;
  }).join("") : "<i>No messages found.</i>";
  recent.onclick = () => { closeCard(); searchPerson(email); };
}

const personQuery = email => `(from:("${email.replace(/"/g, "")}") OR to:("${email.replace(/"/g, "")}"))`;
async function searchPerson(email) {
  state.prevView = state.view;
  state.view = { kind: "search", folderId: null, term: email, raw: personQuery(email) };
  $("search").value = email;
  renderFolders();
  await loadList("fresh");
  $("list").focus();
}

// ---------- attachment previews ----------
// Cards under the header: a thumbnail for images and PDFs (Yahoo renders those server-side,
// behind the session cookies, so the page fetches them), a type tile for everything else.
const thumbCache = new Map();
const extOf = n => (String(n || "").match(/\.([a-z0-9]{1,5})$/i)?.[1] || "").toUpperCase();
const kbStr = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`;

async function thumbFor(a) {
  const key = a.thumbnailUrl;
  if (thumbCache.has(key)) return thumbCache.get(key);
  let url = key.replace(/&amp;/g, "&");
  if (!/[?&]size=/.test(url)) url += (url.includes("?") ? "&" : "?") + "size=240w";
  const p = (async () => {
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (!/^image\//.test(blob.type)) return null;
      return await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(blob); });
    } catch { return null; }
  })();
  thumbCache.set(key, p);
  return p;
}

function renderAttachments(r, images) {
  const box = $("r-attach");
  const list = r.attachments.filter(a => a.disposition !== "inline" && /^https:\/\//i.test(a.downloadUrl || ""));
  box.classList.toggle("hidden", !list.length);
  box.innerHTML = list.map((a, i) => {
    const ext = extOf(a.filename) || (a.subtype || "").toUpperCase().slice(0, 4) || "FILE";
    return `<a class="att-card" href="${esc(a.downloadUrl)}" target="_blank" rel="noopener" title="${esc(a.filename || "attachment")} (${kbStr(a.size)})">
      <span class="att-thumb" data-i="${i}"><span class="att-ext">${esc(ext)}</span></span>
      <span class="att-name">${esc(a.filename || "Untitled")}</span><span class="att-size">${kbStr(a.size)}</span></a>`;
  }).join("");
  const id = r.message.id;
  list.forEach(async (a, i) => {
    const previewable = a.type === "image" || /pdf/i.test(a.subtype || "") || /\.pdf$/i.test(a.filename || "");
    if (!previewable || !a.thumbnailUrl) return;
    const src = await thumbFor(a);
    if (!src || state.openId !== id) return;
    const slot = box.querySelector(`.att-thumb[data-i="${i}"]`);
    if (slot) slot.innerHTML = `<img src="${src}" alt="">`;
  });
}

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
  if (compose.isOpen()) await compose.close(true);
  state.openId = m.id;
  clearTimeout(markReadTimer);
  status("fetching body…");
  let r;
  try { r = await api.body(m.id); } catch (e) { showReaderError(e, "fetching the message"); return; }
  if (state.openId !== m.id) return;
  try { await renderMessage(m, r); } catch (e) { showReaderError(e, "rendering the message"); }
}

function showReaderError(e, what) {
  handleError(e, what);
  if (e instanceof api.NotSignedIn) return;
  $("reader-empty").textContent = `Error ${what}: ${e.message}`;
  $("reader-empty").classList.remove("hidden");
  $("reader-head").classList.add("hidden");
  $("r-body").classList.add("hidden");
}

// A fresh frame per message: a sandboxed srcdoc frame that has been hidden and reused
// does not reliably repaint in every Chromium build.
function setFrame(doc) {
  const old = $("r-body");
  const f = document.createElement("iframe");
  f.id = "r-body";
  f.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  f.setAttribute("referrerpolicy", "no-referrer");
  f.srcdoc = doc;
  old.replaceWith(f);
}

async function renderMessage(m, r) {
  r.html = cleanHtml(r.html);
  currentBody = r;
  const h = r.message.headers || {};
  $("reader-empty").classList.add("hidden");
  $("reader-head").classList.remove("hidden");
  $("r-body").classList.remove("hidden");
  $("r-subject").textContent = plainSubject(h.subject);
  $("r-from").innerHTML = addrHtml(h.from);
  $("r-to").innerHTML = addrHtml(h.to);
  $("r-cc-row").classList.toggle("hidden", !(h.cc && h.cc.length));
  $("r-cc").innerHTML = addrHtml(h.cc);
  $("r-date").textContent = toDate(h.date)?.toLocaleString() || "";
  $("r-folder").textContent = r.message.folder?.name || "";
  const ft = folderType(state.byId.get(r.message.folder?.id)) || folderType(state.byId.get(state.view.folderId));
  const auto = settings.images === "always" || (settings.images !== "never" && ft !== "BULK" && ft !== "TRASH");
  const hasImg = /<img\b/i.test(r.html);
  $("r-images").classList.toggle("hidden", !hasImg || auto);
  renderAttachments(r, auto);
  if (auto) { const inlined = await inlineYahooParts(r.html); if (state.openId !== m.id) return; r.html = inlined; }
  setFrame(bodyDoc(r.html, auto));
  status(plainSubject(h.subject).slice(0, 60), r.ms);
  if (settings.markReadSec != null && !m.flags?.read) {
    markReadTimer = setTimeout(() => {
      if (state.openId !== m.id || m.flags?.read) return;
      run(async () => {
        try { const r2 = await api.setRead([m.id], true); applyFlags(r2.ok, { read: true }); }
        catch (e) { handleError(e, "mark read"); }
      });
    }, settings.markReadSec * 1000);
  }
}

async function loadImages() {
  if (!currentBody) return;
  const id = state.openId;
  currentBody.html = await inlineYahooParts(currentBody.html);
  if (state.openId === id) setFrame(bodyDoc(currentBody.html, true));
}

function clearReader() {
  state.openId = null; currentBody = null;
  clearTimeout(markReadTimer);
  $("reader-empty").classList.remove("hidden");
  $("reader-head").classList.add("hidden");
  $("r-body").classList.add("hidden");
}

// ---------- compose integration ----------
function hideReaderForCompose(hide) {
  for (const id of ["reader"]) $(id).classList.toggle("hidden", hide);
}

async function startCompose(mode) {
  if (compose.isOpen()) await compose.close(true);
  const me = $("account").textContent;
  if (mode === "new") { hideReaderForCompose(true); await compose.open({ mode, myEmail: me }); return; }
  const m = state.messages[state.selected];
  if (!m || !currentBody || currentBody.message.id !== m.id) { status("open a message first"); return; }
  hideReaderForCompose(true);
  status("preparing…");
  currentBody.html = await inlineYahooParts(currentBody.html);
  await compose.open({ mode, message: currentBody.message, body: currentBody, myEmail: me });
  status("");
}

async function editDraft(i) {
  const m = state.messages[i]; if (!m) return;
  if (compose.isOpen()) await compose.close(true);
  status("loading draft…");
  let r;
  try { r = await api.body(m.id); } catch (e) { handleError(e, "draft"); return; }
  hideReaderForCompose(true);
  await compose.open({ mode: "draft", message: r.message, body: r, myEmail: $("account").textContent });
}

// Undo-send: the message is held client-side for settings.undoSendSec, then sent.
let pendingSend = null;
function scheduleSend(job) {
  const secs = settings.undoSendSec;
  const fire = async () => {
    pendingSend = null; showUndo();
    status(`sending…`);
    try { const r = await job.run(); status(`sent: ${job.label.replace(/^send /, "")}`, r.ms); await loadFolders(true).catch(() => {}); }
    catch (e) { handleError(e, "send"); await job.restore(); hideReaderForCompose(true); }
  };
  if (!secs) { fire(); return; }
  pendingSend = { job, timer: setTimeout(fire, secs * 1000), until: Date.now() + secs * 1000 };
  showUndo();
  const tick = () => { if (!pendingSend) return; showUndo(); setTimeout(tick, 1000); };
  tick();
}

async function cancelSend() {
  if (!pendingSend) return false;
  clearTimeout(pendingSend.timer);
  const job = pendingSend.job; pendingSend = null;
  showUndo();
  status("send cancelled; message reopened");
  hideReaderForCompose(true);
  await job.restore();
  return true;
}

// ---------- print ----------
// Opens print.html in a new tab with the messages' sanitised HTML; several selected messages print as one document.
async function printMessages() {
  const ids = state.marked.size ? targetIds() : (currentBody ? [currentBody.message.id] : []);
  if (!ids.length) { status("open or select a message to print"); return; }
  status(`preparing ${plural(ids.length, "message")} for printing…`);
  const messages = [];
  for (const id of ids) {
    let r;
    if (currentBody && currentBody.message.id === id) r = currentBody;
    else { try { r = await api.body(id); r.html = cleanHtml(r.html); } catch (e) { handleError(e, "print"); return; } }
    const html = await inlineYahooParts(r.html);
    messages.push({ headers: r.message.headers, attachments: r.attachments.filter(a => a.disposition !== "inline").map(a => a.filename), html });
  }
  const key = `print:${Date.now()}`;
  await chrome.storage.session.set({ [key]: { messages, auto: true } });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?job=${encodeURIComponent(key)}`) });
  status(`print: ${plural(messages.length, "message")}`);
}

// ---------- local model updates ----------
function applyFlags(ids, flags) {
  const set = new Set(ids);
  state.messages.forEach((m, i) => {
    if (!set.has(m.id)) return;
    const wasUnread = !m.flags?.read;
    m.flags = { ...(m.flags || {}), ...flags };
    const el = rowEl(i);
    if (el) { el.classList.toggle("unread", !m.flags.read); paintFlags(el, m); }
    if ("read" in flags && wasUnread !== !m.flags.read) {
      const f = state.byId.get(m.folder?.id);
      if (f) f.unread = Math.max(0, (f.unread || 0) + (m.flags.read ? -1 : 1));
    }
  });
  updateFolderCounts(); updateToolbar();
}

// Remove rows that left the current view and keep the cursor on a sensible row.
function removeLocal(ids) {
  const set = new Set(ids);
  const keep = state.messages.filter(m => !set.has(m.id));
  if (keep.length === state.messages.length) return;
  const cur = state.messages[state.selected];
  const curRemoved = cur && set.has(cur.id);
  state.messages = keep;
  for (const id of ids) state.marked.delete(id);
  if (state.openId && set.has(state.openId)) clearReader();
  state.selected = curRemoved ? Math.min(state.selected, keep.length - 1) : keep.findIndex(m => m.id === cur?.id);
  state.anchor = state.selected;
  renderList();
  if (curRemoved && state.selected >= 0) select(state.selected);
}

function bumpFolder(id, dTotal, dUnread) {
  const f = state.byId.get(id); if (!f) return;
  f.total = Math.max(0, (f.total || 0) + dTotal);
  f.unread = Math.max(0, (f.unread || 0) + dUnread);
}

// ---------- serialisation ----------
// All mutations, undo and redo run one at a time; repeats while busy are dropped, not queued.
let busy = false;
async function run(fn) {
  if (busy) { status("busy, try again in a moment"); return; }
  busy = true; ++state.listToken; updateToolbar();
  try { await fn(); } finally { busy = false; updateToolbar(); }
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
  const el = $("st-undo");
  if (pendingSend) {
    const left = Math.max(0, Math.ceil((pendingSend.until - Date.now()) / 1000));
    el.textContent = `Sending in ${left} s: ${pendingSend.job.label} — press z to cancel`;
    el.classList.add("pending");
  } else {
    el.classList.remove("pending");
    const u = undoStack[undoStack.length - 1], r = redoStack[redoStack.length - 1];
    el.textContent = (u ? `Undo: ${u.label} (z)` : "") + (u && r ? "   " : "") + (r ? `Redo: ${r.label} (Shift+Z)` : "");
  }
  updateToolbar();
}

async function undo() {
  const e = undoStack.pop(); if (!e) return;
  status(`undoing: ${e.label}…`);
  try { await e.undo(); redoStack.push(e); status(`undone: ${e.label}`); }
  catch (err) { undoStack.push(e); handleError(err, "undo"); }
  showUndo();
  await loadFolders(true).catch(() => {});
  await loadList("refresh");
}

async function redo() {
  const e = redoStack.pop(); if (!e) return;
  status(`redoing: ${e.label}…`);
  try { await e.redo(); undoStack.push(e); status(`redone: ${e.label}`); }
  catch (err) { redoStack.push(e); handleError(err, "redo"); }
  showUndo();
  await loadFolders(true).catch(() => {});
  await loadList("refresh");
}

// ---------- actions ----------
const byIds = ids => { const set = new Set(ids); return state.messages.filter(m => set.has(m.id)); };
const groupBy = (pairs) => { const g = new Map(); for (const [k, v] of pairs) { if (!g.has(k)) g.set(k, []); g.get(k).push(v); } return g; };
const partial = (r, what) => { if (r.failed.length) status(`${what}: ${r.failed.length} of ${r.ok.length + r.failed.length} failed; the rest done`); };

async function doSetRead(ids, read) {
  if (!ids.length) return;
  const before = byIds(ids).map(m => [!!m.flags?.read, m.id]);
  try {
    const r = await api.setRead(ids, read);
    applyFlags(r.ok, { read });
    status(`marked ${plural(r.ok.length, "message")} ${read ? "read" : "unread"}`, r.ms); partial(r, "mark");
    const okSet = new Set(r.ok);
    pushUndo({ label: `mark ${plural(r.ok.length, "message")} ${read ? "read" : "unread"}`,
      undo: async () => { for (const [was, g] of groupBy(before.filter(([, id]) => okSet.has(id)))) await api.setRead(g, was); },
      redo: () => api.setRead(r.ok, read) });
  } catch (e) { handleError(e, "mark"); }
}

async function doSetStarred(ids, flagged) {
  if (!ids.length) return;
  const before = byIds(ids).map(m => [!!m.flags?.flagged, m.id]);
  try {
    const r = await api.setStarred(ids, flagged);
    applyFlags(r.ok, { flagged });
    status(`${flagged ? "starred" : "unstarred"} ${plural(r.ok.length, "message")}`, r.ms); partial(r, "star");
    const okSet = new Set(r.ok);
    pushUndo({ label: `${flagged ? "star" : "unstar"} ${plural(r.ok.length, "message")}`,
      undo: async () => { for (const [was, g] of groupBy(before.filter(([, id]) => okSet.has(id)))) await api.setStarred(g, was); },
      redo: () => api.setStarred(r.ok, flagged) });
  } catch (e) { handleError(e, "star"); }
}

async function doMove(ids, folderId, verb = "move") {
  if (!ids.length) return;
  const dest = state.byId.get(String(folderId)); if (!dest) { status("unknown destination folder"); return; }
  const msgs = byIds(ids);
  const fallback = state.view.kind === "folder" ? state.view.folderId : null;
  const origins = msgs.map(m => ({ id: m.id, from: m.folder?.id ?? fallback, unread: !m.flags?.read }));
  const moving = origins.filter(o => o.from !== dest.id);
  if (!moving.length) { status(`already in ${folderName(dest)}`); return; }
  try {
    const r = await api.move(moving.map(o => o.id), dest.id);
    const okSet = new Set(r.ok);
    const done = moving.filter(o => okSet.has(o.id));
    for (const o of done) { bumpFolder(o.from, -1, o.unread ? -1 : 0); bumpFolder(dest.id, 1, o.unread ? 1 : 0); }
    if (state.view.kind === "folder" && state.view.folderId !== dest.id) removeLocal(r.ok);
    else { for (const m of byIds(r.ok)) m.folder = { ...(m.folder || {}), id: dest.id, name: dest.name }; renderList(); }
    updateFolderCounts();
    const n = plural(done.length, "message"), where = folderName(dest).split("/").pop();
    const words = { move: [`move ${n} to ${where}`, `moved ${n} to ${where}`], archive: [`archive ${n}`, `archived ${n}`], delete: [`delete ${n}`, `deleted ${n}`],
      spam: [`mark ${n} as spam`, `marked ${n} as spam`], notspam: [`mark ${n} not spam`, `marked ${n} not spam, moved to Inbox`] }[verb];
    status(words[1], r.ms); partial(r, verb);
    const known = done.filter(o => o.from);
    pushUndo({ label: words[0],
      undo: async () => {
        for (const [from, g] of groupBy(known.map(o => [o.from, o.id]))) await api.move(g, from);
        if (known.length < done.length) status(`${done.length - known.length} message(s) had no known origin folder and stayed in ${dest.name}`);
      },
      redo: () => api.move(done.map(o => o.id), dest.id) });
  } catch (e) { handleError(e, verb); }
}

// Yahoo's Spam button is a move to the Bulk folder (its filter learns from the move); Not spam moves to Inbox.
const inSpamView = () => state.view.kind === "folder" && folderType(state.byId.get(state.view.folderId)) === "BULK";
async function doSpam(ids) {
  const msgs = byIds(ids);
  const allSpam = msgs.length && msgs.every(m => folderType(state.byId.get(m.folder?.id)) === "BULK");
  if (inSpamView() || allSpam) { await doMove(ids, inboxId(), "notspam"); return; }
  const bulk = folderByType("BULK"); if (!bulk) { status("no Spam folder"); return; }
  await doMove(ids, bulk.id, "spam");
}

async function doArchive(ids) {
  const f = folderByType("ARCHIVE"); if (!f) { status("no Archive folder"); return; }
  await doMove(ids, f.id, "archive");
}

// Delete moves to Trash. Permanent deletion only while viewing the Trash folder itself.
async function doDelete(ids) {
  if (!ids.length) return;
  const trash = folderByType("TRASH"); if (!trash) { status("no Trash folder"); return; }
  const viewingTrash = state.view.kind === "folder" && state.view.folderId === trash.id;
  if (!viewingTrash) { await doMove(ids, trash.id, "delete"); return; }
  ids = byIds(ids).filter(m => m.folder?.id === trash.id).map(m => m.id);
  if (!ids.length) { status("nothing in Trash selected"); return; }
  if (!confirm(`Permanently delete ${plural(ids.length, "message")} from Trash? This cannot be undone.`)) return;
  try {
    const r = await api.deleteForever(ids);
    for (const m of byIds(r.ok)) bumpFolder(trash.id, -1, m.flags?.read ? 0 : -1);
    removeLocal(r.ok); updateFolderCounts();
    status(`permanently deleted ${plural(r.ok.length, "message")}`, r.ms); partial(r, "delete");
  } catch (e) { handleError(e, "delete"); }
}

function runAction(act) {
  const ids = targetIds();
  const first = byIds(ids)[0];
  switch (act) {
    case "archive": return run(() => doArchive(ids));
    case "delete": return run(() => doDelete(ids));
    case "move": return openMovePicker(ids);
    case "read": return run(() => doSetRead(ids, first ? !first.flags?.read : true));
    case "star": return run(() => doSetStarred(ids, first ? !first.flags?.flagged : true));
    case "spam": return run(() => doSpam(ids));
    case "undo": if (pendingSend) return cancelSend(); return run(undo);
    case "redo": return run(redo);
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
    ["archive", "Archive" + n], ["move", "Move to…" + n], ["delete", "Delete" + n], null,
    ["spam", (spamLabel(ids)) + n],
  ];
  const ctx = $("ctx");
  ctx.innerHTML = items.map(it => it ? `<div data-act="${it[0]}">${esc(it[1])}</div>` : "<hr>").join("");
  ctx.classList.remove("hidden");
  ctx.style.left = Math.min(x, innerWidth - ctx.offsetWidth - 4) + "px";
  ctx.style.top = Math.min(y, innerHeight - ctx.offsetHeight - 4) + "px";
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
  moveTargets = state.folders.filter(f => !isHidden(f) && f.id !== cur && !f.types.includes("DRAFT"))
    .filter(f => !filter || folderName(f).toLowerCase().includes(filter))
    .sort((a, b) => (folderType(b) ? 1 : 0) - (folderType(a) ? 1 : 0) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  moveKb = 0;
  $("move-list").innerHTML = moveTargets.map((f, i) => `<div data-i="${i}" class="${i === moveKb ? "kb" : ""}">${esc(folderName(f))}</div>`).join("");
}
function closeMovePicker() { $("movebox").classList.add("hidden"); $("list").focus(); }
function pickMove(f) { const ids = moveIds; closeMovePicker(); run(() => doMove(ids, f.id)); }
function wireMovePicker() {
  $("move-filter").oninput = renderMoveList;
  $("move-list").onclick = e => { const d = e.target.closest("[data-i]"); if (d) pickMove(moveTargets[Number(d.dataset.i)]); };
  $("movebox").onclick = e => { if (e.target.id === "movebox") closeMovePicker(); };
  $("move-filter").onkeydown = e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveKb = Math.max(0, Math.min(moveTargets.length - 1, moveKb + (e.key === "ArrowDown" ? 1 : -1)));
      $("move-list").querySelectorAll("div").forEach((d, i) => d.classList.toggle("kb", i === moveKb));
      $("move-list").children[moveKb]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { const f = moveTargets[moveKb]; if (f) pickMove(f); }
    if (e.key !== "Escape") e.stopPropagation();
  };
}

// ---------- navigation ----------
async function openFolder(id) {
  state.prevView = state.view;
  state.view = { kind: "folder", folderId: id, term: "" };
  $("search").value = "";
  renderFolders();
  await loadList("fresh");
  $("list").focus();
}

async function doSearch(term) {
  term = term.trim();
  if (!term) return;
  state.prevView = state.view;
  state.view = { kind: "search", folderId: null, term };
  renderFolders();
  await loadList("fresh");
  $("list").focus();
}

// ---------- keyboard ----------
let pendingG = false;
const modals = ["help", "settings", "movebox"];
function onKey(e) {
  if (e.target.closest && e.target.closest("#compose")) return;
  const openModal = modals.find(id => !$(id).classList.contains("hidden"));
  if (openModal) {
    if (e.key === "Escape") { if (openModal === "movebox") closeMovePicker(); else $(openModal).classList.add("hidden"); }
    return;
  }
  const inSearch = document.activeElement === $("search");
  const inFolderFilter = document.activeElement === $("folder-filter");
  const onButton = document.activeElement?.tagName === "BUTTON";
  if (e.key === "Escape") {
    if (inSearch) { $("search").value = ""; $("search").blur(); if (state.view.kind === "search") openFolder(inboxId()); return; }
    if (inFolderFilter) { state.kbFolder = -1; renderFolders(); $("list").focus(); return; }
    if (!$("ctx").classList.contains("hidden")) { hideContextMenu(); return; }
    if (state.marked.size) { clearMarks(); return; }
  }
  if (inSearch) { if (e.key === "Enter") doSearch($("search").value); return; }
  if (inFolderFilter) {
    const items = [...$("folder-list").querySelectorAll(".folder")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      state.kbFolder = Math.max(0, Math.min(items.length - 1, state.kbFolder + (e.key === "ArrowDown" ? 1 : -1)));
      items.forEach((el, i) => el.classList.toggle("kb", i === state.kbFolder));
      items[state.kbFolder]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const el = items[state.kbFolder] || items[0];
      if (el) { state.kbFolder = -1; openFolder(el.dataset.id); }
    }
    return;
  }
  if (onButton && (e.key === "Enter" || e.key === " ")) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === "z" || e.key === "Z") { e.preventDefault(); runAction(e.shiftKey ? "redo" : "undo"); }
    else if (e.key === "y") { e.preventDefault(); runAction("redo"); }
    else if (e.key === "a" && document.activeElement === $("list")) { e.preventDefault(); markRange(0, state.messages.length - 1); }
    return;
  }
  if (e.altKey) return;
  if (pendingG) {
    pendingG = false;
    const map = { i: "INBOX", s: "SENT", t: "TRASH", d: "DRAFT", a: "ARCHIVE", b: "BULK" };
    if (map[e.key]) { const f = folderByType(map[e.key]); if (f) openFolder(f.id); return; }
    if (e.key === "f") { e.preventDefault(); $("folder-filter").focus(); state.kbFolder = -1; return; }
    return;
  }
  switch (e.key) {
    case "j": case "ArrowDown": e.preventDefault(); select(state.selected + 1); break;
    case "k": case "ArrowUp": e.preventDefault(); select(state.selected - 1); break;
    case "Enter": case "o": if (state.selected >= 0) (folderType(state.byId.get(state.view.folderId)) === "DRAFT" ? editDraft(state.selected) : open(state.selected)); break;
    case "c": e.preventDefault(); startCompose("new"); break;
    case "a": e.preventDefault(); startCompose("replyAll"); break;
    case "f": e.preventDefault(); startCompose("forward"); break;
    case "/": e.preventDefault(); $("search").focus(); $("search").select(); break;
    case "g": pendingG = true; setTimeout(() => pendingG = false, 1200); break;
    case "r": e.preventDefault(); startCompose("reply"); break;
    case "R": loadList("refresh"); break;
    case "n": if (state.more) loadList("more"); break;
    case "i": loadImages(); break;
    case "p": printMessages(); break;
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
    case "!": runAction("spam"); break;
    case "z": e.preventDefault(); runAction("undo"); break;
    case "Z": e.preventDefault(); runAction("redo"); break;
  }
}

// ---------- theme / settings ----------
function toggleTheme() {
  settings.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applySettings(); saveSettings();
}

function openSettings(show) {
  $("settings").classList.toggle("hidden", !show);
  if (show) renderHidden();
}

async function renderHidden() {
  const list = await contacts.hiddenList();
  $("hidden-summary").textContent = list.length ? `${list.length} hidden from suggestions (× in the dropdown hides; restore here):` : "No hidden addresses. The × in the address dropdown hides one for good.";
  $("hidden-list").innerHTML = list.map(a => `<div><span>${esc(a.name ? `${a.name} <${a.email}>` : a.email)}</span><button data-restore="${esc(a.email)}">Restore</button></div>`).join("");
  $("hidden-list").onclick = async e => { const b = e.target.closest("[data-restore]"); if (b) { await contacts.hide(b.dataset.restore, false); renderHidden(); } };
}

function wireSettings() {
  for (const [sel, dark] of [["darkTheme", true], ["lightTheme", false]]) {
    const el = $(sel);
    el.innerHTML = Object.entries(THEMES).filter(([, t]) => t.dark === dark).map(([id, t]) => `<option value="${id}">${t.name}</option>`).join("");
    el.onchange = () => { settings[sel] = el.value; applySettings(); saveSettings(); };
  }
  for (const el of document.querySelectorAll("#settings input[type=radio]"))
    el.onchange = () => { settings[el.name] = el.value; applySettings(); saveSettings(); };
  $("poll").onchange = () => { settings.pollSec = Math.max(5, Number($("poll").value) || 20); applySettings(); saveSettings(); };
  $("composeFont").onchange = () => { settings.composeFont = $("composeFont").value; saveSettings(); };
  $("composeSize").onchange = () => { settings.composeSize = Number($("composeSize").value) || 13; saveSettings(); };
  $("undosend").onchange = () => { settings.undoSendSec = Math.min(60, Math.max(0, Number($("undosend").value) || 0)); saveSettings(); };
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
      const move = ev => { onMove(ev); applyLayout(); };
      const up = () => { el.classList.remove("drag"); document.body.classList.remove("dragging");
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); saveSettings(); };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    };
  };
  const app = $("app");
  drag($("split1"), ev => { settings.folderW = Math.max(120, Math.min(600, ev.clientX)); });
  drag($("split2"), ev => {
    if (settings.layout === "horizontal") {
      const top = $("top").getBoundingClientRect().bottom;
      settings.listH = Math.max(15, Math.min(85, Math.round((ev.clientY - top) / app.clientHeight * 100)));
    } else {
      settings.listW = Math.max(200, Math.min(app.clientWidth - settings.folderW - 300, ev.clientX - settings.folderW - 5));
    }
  });
}

// ---------- polling ----------
function startPolling() {
  clearInterval(state.polling);
  if (state.signedIn) state.polling = setInterval(poll, Math.max(5, settings.pollSec) * 1000);
}

async function poll() {
  if (busy) return;
  try {
    const changed = await loadFolders(true);
    const v = state.view;
    if (v.kind === "folder" && changed.includes(v.folderId) && !busy) await loadList("refresh");
    if (changed.includes(inboxId()) || changed.includes(folderByType("SENT")?.id)) syncContacts();
  } catch (e) { handleError(e, "poll"); }
}

// ---------- startup ----------
function showSignIn() {
  state.signedIn = false;
  startPolling();
  $("signin").classList.remove("hidden");
  $("app").classList.add("hidden");
}

async function start() {
  await loadSettings();
  applyLayout(); syncSettingsForm();
  $("signin").classList.add("hidden");
  try {
    const s = await api.bootstrap();
    $("account").textContent = s.email;
    $("app").classList.remove("hidden");
    await loadFolders();
    state.signedIn = true;
    startPolling();
    await openFolder(inboxId());
    syncContacts();
  } catch (e) { handleError(e, "start"); }
}

// Address book: full build on first run, then incremental on each poll that sees Inbox or Sent change.
let contactsBusy = false;
async function syncContacts(full = false) {
  if (contactsBusy) return;
  contactsBusy = true;
  try {
    const own = [$("account").textContent];
    try { own.push(...(await api.accounts()).accounts.map(a => a.email)); } catch {}
    contacts.setOwnAddresses(own);
    const first = !(await contacts.isBuilt());
    const n = await contacts.sync({ inbox: inboxId(), sent: folderByType("SENT")?.id, full,
      progress: first ? (fid, seen) => status(`building address book: ${seen} messages in ${folderName(state.byId.get(fid))}…`) : null });
    if (first || n) status(`address book: ${await contacts.count()} addresses${n ? ` (+${n} messages scanned)` : ""}`);
  } catch (e) { status(`address book: ${e.message}`); }
  finally { contactsBusy = false; }
}

document.addEventListener("keydown", onKey);
$("retry").onclick = () => api.bootstrap(true).then(start, start);
$("folder-filter").oninput = () => { state.kbFolder = -1; renderFolders(); };
wireSettings();
wireSplitters();
wireMovePicker();
wireContactCards();
$("toolbar").onclick = e => { const b = e.target.closest("button[data-act]"); if (b && !b.disabled) runAction(b.dataset.act); };
$("r-images").onclick = loadImages;
$("r-print").onclick = printMessages;
$("compose-btn").onclick = () => startCompose("new");
for (const b of document.querySelectorAll("[data-reply]")) b.onclick = () => startCompose(b.dataset.reply);
compose.init({
  status, folderByType, settings: () => settings,
  saveSetting: (k, v) => { settings[k] = v; saveSettings(); },
  onClose: () => { hideReaderForCompose(false); $("list").focus(); if (folderType(state.byId.get(state.view.folderId)) === "DRAFT") loadList("refresh"); },
  scheduleSend,
});
$("more-btn").onclick = () => loadList("more");
$("help").onclick = e => { if (e.target.id === "help") $("help").classList.add("hidden"); };
start();
