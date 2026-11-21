import * as api from "./api.js";
import { THEMES, applyTheme, clampContrast } from "./themes.js";
import * as compose from "./compose.js";
import * as contacts from "./contacts.js";
import * as viewer from "./viewer.js";
import * as files from "./files.js";
import * as people from "./people.js";
import * as contactsFile from "./contactsfile.js";
import { parse, check, nativeQuery, evaluate, describe, CAP } from "./query.js";
import * as update from "./update.js";
import { darkenHtml, PAGE as DARK } from "./darken.js";
import { attr, esc, noBidi, plural } from "./text.js";
import { cleanLink } from "./links.js";
import { drawGuide, drawHelp, focusStep, rich, pageLink, copyRow, copyText } from "./guide.js";
import * as awake from "./awake.js";

const $ = id => document.getElementById(id);
// The name the page shows: the adapter's title where it gives one, otherwise the extension's name
// as its manifest gives it, since this client serves more than one extension.
const APP = api.PROVIDER.title || chrome.runtime.getManifest().name || "Baltazar Mail";
const SYSTEM_ORDER = ["INBOX", "DRAFT", "SENT", "ARCHIVE", "BULK", "TRASH"];
const PAGE = 100;
const DRAG_TYPE = "application/x-baltazar-mail-ids";

// ---------- settings ----------
const DEFAULTS = { layout: "vertical", theme: "light", darkTheme: "dark", lightTheme: "light", contrast: 0, pollSec: 20, awake: true, markReadSec: 2, undoSendSec: 10, composeHtml: true, composeFont: compose.DEFAULT_FONT, composeSize: 13, scaledImages: "full", images: "safe", links: "asis", readerOriginal: false, messageZoom: 100, contactZoom: 100, textPct: 100, rowPct: 100, folderW: 230, listW: 460, listH: 40, expanded: [] };
let settings = { ...DEFAULTS };

async function loadSettings() {
  const stored = (await chrome.storage.local.get("settings")).settings || {};
  settings = { ...DEFAULTS, ...stored };
  // Row height used to be pixels at the normal text size (22 px is 100%).
  if (stored.rowH && stored.rowPct == null) settings.rowPct = Math.min(150, Math.max(80, Math.round(stored.rowH / 22 * 20) * 5));
  delete settings.rowH;
  // A palette that is gone (renamed or dropped in an update) falls back to the default.
  for (const sel of ["darkTheme", "lightTheme"]) if (!THEMES[settings[sel]]) settings[sel] = DEFAULTS[sel];
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
  const wasDark = document.documentElement.dataset.theme === "dark";
  applyTheme(mode === "dark" ? settings.darkTheme : settings.lightTheme, settings.contrast);
  syncDarkButton();
  if (wasDark !== darkApp() && currentBody && state.openId) showBody();
  $("app").classList.toggle("horizontal", settings.layout === "horizontal");
  const r = document.documentElement.style;
  // Saved pane sizes are kept, but shown no wider than the window allows: the reader keeps 300 px.
  const room = Math.max(0, innerWidth - 10);
  const folderW = Math.max(120, Math.min(settings.folderW, Math.round(room * 0.3)));
  const listW = settings.layout === "horizontal" ? settings.listW : Math.max(200, Math.min(settings.listW, room - folderW - 300));
  r.setProperty("--folder-w", folderW + "px");
  r.setProperty("--list-w", listW + "px");
  r.setProperty("--list-h", settings.listH + "%");
  // Text size, as a percentage of the 13px design size, scales every text in the interface
  // together. Row height is relative to the text: 100% is 1.7 lines of it (22 px at normal
  // size), and the 80% minimum still fits the 1.35 line height, at every text size.
  const fs = 13 * settings.textPct / 100;
  r.setProperty("--fs", fs + "px");
  r.setProperty("--row-h", Math.round(fs * 1.7 * settings.rowPct / 100) + "px");
  // The recent messages on a contact's page have a zoom of their own on top of the text size
  // (zoomContact); the page's heading keeps the size of the rest of the interface
  $("person").style.setProperty("--p-fu", fs * settings.contactZoom / 100 / 13 + "px");
}

function syncSettingsForm() {
  $("darkTheme").value = settings.darkTheme;
  $("lightTheme").value = settings.lightTheme;
  $("contrast").value = settings.contrast;
  $("contrast-n").textContent = settings.contrast;
  for (const el of document.querySelectorAll("#settings input[type=radio]")) el.checked = settings[el.name] === el.value;
  $("poll").value = settings.pollSec;
  $("awake").checked = settings.awake;
  $("density").value = settings.rowPct;
  $("textpct").value = settings.textPct;
  $("markread").value = settings.markReadSec == null ? "" : settings.markReadSec;
  $("undosend").value = settings.undoSendSec;
  if (!$("composeFont").options.length) compose.fillFonts($("composeFont"));
  // a font saved as a bare name (or an older list) shows as its entry
  $("composeFont").value = compose.fontEntry(settings.composeFont)?.[1] || compose.DEFAULT_FONT; $("composeSize").value = String(settings.composeSize);
}

function applySettings() { applyLayout(); syncSettingsForm(); startPolling(); }
systemDark.addEventListener("change", () => { if (settings.theme === "system") applyLayout(); });

// ---------- state ----------
const state = {
  folders: [], byId: new Map(), expanded: new Set(),
  view: { kind: "folder", folderId: null, term: "" },
  messages: [], more: false, selected: -1, openId: null, elsewhere: [], loading: false,
  marked: new Set(), anchor: -1,
  modseq: new Map(), polling: null, kbFolder: -1, listToken: 0, signedIn: false,
};

// ---------- helpers ----------
let saidAt = 0;                  // when the status line last said something (ms)
const status = (msg, ms) => { saidAt = Date.now(); $("st-msg").textContent = msg; if (ms != null) $("st-lat").textContent = `${ms} ms`; };
// A running count (the Contacts build, a step a second for minutes) takes the status line only
// once what it last said has been there long enough to read, and does not count as said itself.
const SAID_FOR = 4000;
const statusQuietly = msg => { if (Date.now() - saidAt >= SAID_FOR) $("st-msg").textContent = msg; };
const folderType = f => f ? (SYSTEM_ORDER.find(t => f.types?.includes(t)) || null) : null;
// System folders of the primary account (the one holding the mailbox's own Inbox, folder 1 at
// Yahoo); linked accounts bring an Inbox, Sent and so on of their own.
const ofPrimary = f => { const acct = state.byId.get("1")?.acctId; return acct == null || f.acctId == null || f.acctId === acct; };
const folderByType = t => { const all = state.folders.filter(f => f.types.includes(t)); return all.find(ofPrimary) || all[0]; };
const inboxId = () => folderByType("INBOX")?.id ?? "1";
const isHidden = f => f.types.some(t => t === "SYNC" || t === "INVISIBLE");
// The BULK folder type is the spam folder, shown as Spam whatever the provider calls it.
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
const plainSubject = s => noBidi(s || "(no subject)").replace(/\^_/g, "");

// What the user must not miss (something failed or did not happen) appears in a notice above the
// status bar until dismissed; routine progress stays in the status line. A notice given a key is
// also cleared by clearNotice(key) once its cause is resolved. Errors offer a copyable report; an
// action ({ label, run }) is a link after the text.
let noticeKey = null, noticeReport = "";
function notify(text, { info = false, key = null, err = null, what = "", detail = "", action = null } = {}) {
  status(detail ? `${text} ${detail}` : text);
  const tech = document.createElement("span");
  tech.className = "tech"; tech.textContent = detail;
  const act = action && Object.assign(document.createElement("button"), { type: "button", className: "link", textContent: action.label, onclick: action.run });
  $("notice-text").replaceChildren(text, ...(detail ? [" ", tech] : []), ...(act ? [" ", act] : []));
  $("notice").classList.toggle("info", info);
  noticeKey = key;
  noticeReport = err ? errorReport(what, err) : "";
  $("notice-copy").classList.toggle("hidden", !noticeReport);
  $("notice").classList.remove("hidden");
}
function clearNotice(key) { if (key === noticeKey) $("notice").classList.add("hidden"); }
function errorReport(what, e) {
  const detail = e.detail === undefined ? "" : (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)).slice(0, 1500);
  return [`${APP} ${chrome.runtime.getManifest().version}`, navigator.userAgent, `${what}: ${e.name}: ${e.message}`,
    detail, (e.stack || "").split("\n").slice(1, 6).join("\n")].filter(Boolean).join("\n");
}
$("notice-close").onclick = () => $("notice").classList.add("hidden");
async function copyReport(report, button) {
  let text = report;
  try { const how = (await chrome.management.getSelf()).installType; text = text.replace(/^[^\n]*/, m => `${m} (${how})`); } catch { /* version alone */ }
  try { await copyText(text, button); } catch { status("could not copy to the clipboard"); }
}
$("notice-copy").onclick = () => copyReport(noticeReport, $("notice-copy"));

// What failed, in words, for each action that reports errors; the technical cause follows it.
const FAILED = {
  start: "Could not load your mailbox.", list: "Could not load the message list.",
  "fetching the message": "Could not open the message.", "rendering the message": "Could not show the message.",
  "mark read": "Could not mark the message as read.", draft: "Could not open the draft.",
  send: "The message was not sent; it is back in the composer.", print: "Could not print the message.",
  undo: "Could not undo the last action.", redo: "Could not redo the action.", compose: "Could not open the composer.",
  mark: "Could not change whether the messages are read.", star: "Could not change the stars.",
  move: "Could not move the messages.", archive: "Could not archive the messages.", delete: "Could not delete the messages.",
  spam: "Could not mark the messages as spam.", notspam: "Could not mark the messages as not spam.",
  create: "Could not create the folder.", rename: "Could not rename the folder.", "move folder": "Could not move the folder.",
  "delete folder": "Could not delete the folder.", empty: "Could not empty the folder.", "mark all read": "Could not mark the folder read.",
  "sign out": "Could not sign out.", files: "Could not list the folder's attachments.",
};
// A request that never reached the mail service fails with the browser's bare "Failed to fetch".
const cause = e => e instanceof TypeError && /fetch/i.test(e.message) ? `${api.PROVIDER.name} could not be reached; check the connection.` : e.message;

// Errors that mean "no session" show the sign-in panel; others a notice, or with quiet (a
// background check that simply runs again) only the status line.
function handleError(e, what, { quiet = false } = {}) {
  if (e instanceof api.NotSignedIn) { showSignIn(e); return; }
  console.error(what, e);
  if (quiet) status(`${what}: ${cause(e)}`);
  else notify(FAILED[what] || `Something went wrong (${what}).`, { detail: cause(e), err: e, what });
}

// ---------- folders ----------
function renderFolders() {
  const list = $("folder-list");
  const filter = $("folder-filter").value.toLowerCase();
  const visible = state.folders.filter(f => !isHidden(f));
  // System folders in their usual order, the primary account's before a linked account's.
  const sys = visible.filter(folderType).sort((a, b) => SYSTEM_ORDER.indexOf(folderType(a)) - SYSTEM_ORDER.indexOf(folderType(b)) || ofPrimary(b) - ofPrimary(a));
  // User folders sorted by path segment, so "Work/Sub" follows "Work" rather than "Work.x".
  const byPath = (a, b) => {
    const x = a.name.split("/"), y = b.name.split("/");
    for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = x[i].localeCompare(y[i], undefined, { sensitivity: "base" }); if (c) return c; }
    return x.length - y.length;
  };
  const user = visible.filter(f => !folderType(f)).sort(byPath);
  // A user folder whose path starts with a system folder's name ("Inbox/Receipts") nests under it.
  const userNames = new Set([...user, ...sys].map(f => f.name));
  const hasChildren = new Set();
  for (const f of user) { const p = f.name.split("/"); for (let i = 1; i < p.length; i++) hasChildren.add(p.slice(0, i).join("/")); }
  const under = new Map(sys.map(s => [s, user.filter(u => u.name.startsWith(s.name + "/") && (u.acctId || "1") === (s.acctId || "1"))]));
  const nested = new Set([...under.values()].flat());
  const frag = document.createDocumentFragment();
  const add = (f, depth, twisty, label = folderName(f).split("/").pop()) => {
    const el = document.createElement("div");
    el.className = "folder" + (f.unread ? " unread" : "") + (folderType(f) ? " sys" : "") +
      ((state.view.kind === "folder" ? state.view.folderId : state.view.kind === "files" ? state.view.of : null) === f.id ? " active" : "");
    el.dataset.id = f.id;
    el.style.paddingLeft = `${8 + depth * 12}px`;
    el.innerHTML = `${twistyHtml(twisty)}<span class="nm" title="${esc(folderName(f))}">${esc(label)}</span><span class="ct"></span>`;
    el.onclick = e => {
      if (e.target.closest(".tw") && twisty) { toggleExpand(f.name); return; }
      openFolder(f.id);
    };
    el.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showFolderMenu(f, e.clientX, e.clientY); };
    // a double click opens or closes a folder's subfolders (the first click has opened the folder)
    el.ondblclick = e => { if (twisty && !e.target.closest(".tw")) toggleExpand(f.name); };
    const droppable = !["DRAFT", "SENT"].includes(folderType(f));
    el.ondragover = e => { if (droppable && e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); el.classList.add("drop"); } };
    el.ondragleave = () => el.classList.remove("drop");
    el.ondrop = e => {
      el.classList.remove("drop");
      if (!droppable || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      const ids = byIds(e.dataTransfer.getData(DRAG_TYPE).split(",")).map(m => m.id);
      if (ids.length) run(() => doMove(ids, f.id));
    };
    frag.appendChild(el);
  };
  // Starred is a saved search across folders; dropping messages on it stars them.
  const addStarred = () => {
    if (filter && !"starred".includes(filter)) return;
    const el = document.createElement("div");
    el.className = "folder sys view" + (state.view.starred ? " active" : "");
    el.dataset.id = STARRED;
    el.style.paddingLeft = "8px";
    el.innerHTML = `<span class="tw"></span><span class="nm" title="Starred messages in all folders (g *)">Starred</span><span class="ct"></span>`;
    el.onclick = () => openStarred();
    el.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showFolderMenu(null, e.clientX, e.clientY); };
    el.ondragover = e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); el.classList.add("drop"); } };
    el.ondragleave = () => el.classList.remove("drop");
    el.ondrop = e => {
      el.classList.remove("drop");
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      const ids = byIds(e.dataTransfer.getData(DRAG_TYPE).split(",")).map(m => m.id);
      if (ids.length) run(() => doSetStarred(ids, true));
    };
    frag.appendChild(el);
  };
  const twisty = f => hasChildren.has(f.name) ? (state.expanded.has(f.name) ? "open" : "closed") : "";
  const addUser = f => {
    const parts = f.name.split("/");
    if (filter) { if (folderName(f).toLowerCase().includes(filter)) add(f, 0, ""); return; }
    // Only ancestors that are shown folders nest and collapse it; a missing or hidden parent
    // stays part of the name, so the folder is never out of reach.
    const shown = [];
    for (let i = 1; i < parts.length; i++) if (userNames.has(parts.slice(0, i).join("/"))) shown.push(i);
    if (shown.some(i => !state.expanded.has(parts.slice(0, i).join("/")))) return;
    add(f, shown.length, twisty(f), parts.slice(shown.at(-1) || 0).join("/"));
  };
  for (const f of sys) {
    if (filter && !folderName(f).toLowerCase().includes(filter)) { for (const u of under.get(f)) addUser(u); if (f === folderByType("INBOX")) addStarred(); continue; }
    add(f, 0, filter ? "" : twisty(f));
    for (const u of under.get(f)) addUser(u);
    if (f === folderByType("INBOX")) addStarred();
  }
  // "Folders" heads the user's own folders: its menu creates top-level folders, and its toggle
  // opens or closes the first level of subfolders. It holds no mail and opens nothing.
  if (!filter) {
    const tops = user.filter(f => !nested.has(f) && !userNames.has(parentPath(f)) && hasChildren.has(f.name));
    const open = tops.some(f => state.expanded.has(f.name));
    const head = document.createElement("div");
    head.className = "folders-head";
    head.innerHTML = `${twistyHtml(tops.length ? (open ? "open" : "closed") : "")}<span class="nm" title="Your folders. Right-click for New folder...">Folders</span>`;
    head.onclick = () => { if (tops.length) setFirstLevel(!open, tops); };
    head.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showFolderMenu("head", e.clientX, e.clientY); };
    frag.appendChild(head);
  }
  for (const f of user) if (!nested.has(f)) addUser(f);
  list.innerHTML = "";
  list.appendChild(frag);
  $("contacts-link").classList.toggle("active", state.view.kind === "contacts");
  updateFolderCounts();
  const items = list.querySelectorAll(".folder");
  if (state.kbFolder >= 0 && items[state.kbFolder]) items[state.kbFolder].classList.add("kb");
}

// The expand toggle: a chevron that points down when open; data-tw carries the state.
const CHEVRON = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.8 6.8 5 3.5 8.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const twistyHtml = state => `<span class="tw"${state ? ` data-tw="${state}"` : ""}>${state ? CHEVRON : ""}</span>`;

// ---------- folder management ----------
// User folders can be moved, renamed, given subfolders and deleted when empty; system folders
// offer what fits them (Mark all read, Empty Trash and Spam). Folders are never moved by dragging.
// Folders are compared by id (a poll replaces every folder record) and paths only within one
// account, as a linked account can have folders of the same names.
const managed = f => !!f && !folderType(f);
const acctOf = f => String(f?.acctId || folderByType("INBOX")?.acctId || "1");
const sameAcct = (a, b) => acctOf(a) === acctOf(b);
// Folders may also live under Inbox.
const canParent = f => managed(f) || f.id === folderByType("INBOX")?.id;
const leafName = f => f.name.split("/").pop();
const parentPath = f => f.name.split("/").slice(0, -1).join("/");
const parentOf = f => state.folders.find(p => p.name === parentPath(f) && sameAcct(p, f))?.id ?? "";
const subfolders = f => state.folders.filter(x => x.name.startsWith(f.name + "/") && sameAcct(x, f));
// Where a folder may go: user folders and Inbox of its account, never itself or anything inside it.
const parentChoices = f => state.folders.filter(p => canParent(p) && sameAcct(p, f) && !isHidden(p) && p.id !== f.id && !p.name.startsWith(f.name + "/"))
  .sort((a, b) => (managed(a) ? 1 : 0) - (managed(b) ? 1 : 0) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

// f: a folder, null for Starred, or "head" for the Folders heading.
function showFolderMenu(f, x, y) {
  if (f && f !== "head") f = state.byId.get(f.id) || f;
  const t = f === "head" ? "" : f ? folderType(f) : "STARRED";
  // A folder's menu opens with Show attachments, which only looks, where a hasty click lands. Mark
  // all read, which cannot be undone, follows in a group of its own. What cannot apply is greyed out,
  // with the reason as its tooltip: Mark all read with nothing unread, Delete while the counts say
  // the folder or a subfolder holds mail, Empty when there is nothing in it. Delete and Empty check
  // again when chosen, with the folder list read afresh.
  const real = f && f !== "head";
  const markRead = real && !f.unread ? ["mark-read", "Mark all read", "", "Nothing in it is unread", true] : ["mark-read", "Mark all read"];
  const showFiles = ["files", "Show attachments", "", "List every attachment in the folder's mail in place of its messages, until you leave it"];
  // a provider whose counts take in mail in Trash (holdsMail) is asked when Delete is chosen
  const full = real && !api.holdsMail ? [f, ...subfolders(f)].filter(x => (x.total || 0) > 0) : [];
  const held = full.reduce((s, x) => s + x.total, 0);
  const del = full.length ? ["delete", "Delete", "", `Only an empty folder can be deleted: ${full.length > 1 || full[0] !== f ? "it and its subfolders hold" : "it holds"} ${plural(held, "message")}`, true] : ["delete", "Delete"];
  const empty = label => real && !f.total ? ["empty", label, "", "It is already empty", true] : ["empty", label];
  const items = f === "head" ? [["new", "New folder..."], null, ["expand", "Expand all"], ["collapse", "Collapse all"]]
    : !f ? [markRead]
    : managed(f) ? [showFiles, null, markRead, null, ["move", "Move..."], ["rename", "Rename..."], ["sub", "Create subfolder..."], null, del]
    : t === "TRASH" ? [showFiles, null, markRead, null, empty("Empty Trash...")]
    : t === "BULK" ? [showFiles, null, markRead, null, empty("Empty Spam...")]
    : t === "DRAFT" ? [showFiles]
    : t === "INBOX" && f.id === folderByType("INBOX")?.id ? [showFiles, null, markRead, null, ["sub", "Create subfolder..."]]
    : [showFiles, null, markRead];
  openMenu(x, y, items, act => {
    if (act === "files") openFiles(f.id);
    else if (act === "new") createFolderIn(null);
    else if (act === "expand") setExpandedAll(true);
    else if (act === "collapse") setExpandedAll(false);
    else if (act === "move") openMovePicker([], f);
    else if (act === "rename") renameFolderAsk(f);
    else if (act === "sub") createFolderIn(f);
    else if (act === "delete") deleteFolderAsk(f);
    else if (act === "empty") emptyFolderAsk(f);
    else if (act === "mark-read") markAllRead(f);
  });
}

// The Folders toggle: the top-level folders open to show their own subfolders and nothing deeper,
// or close; folders under Inbox keep their state.
function setFirstLevel(open, tops) {
  const userPaths = new Set(state.folders.filter(managed).map(f => f.name));
  state.expanded = new Set([...state.expanded].filter(n => !userPaths.has(n) || n.startsWith(folderByType("INBOX")?.name + "/")));
  if (open) for (const f of tops) state.expanded.add(f.name);
  saveSettings(); renderFolders();
}

function setExpandedAll(open) {
  state.expanded = new Set(open ? state.folders.filter(f => subfolders(f).length).map(f => f.name) : []);
  saveSettings(); renderFolders();
}

// A folder name is one path segment: not empty, no "/", not taken by a sibling.
function checkFolderName(name, parent, except = null, acct = except ? acctOf(except) : acctOf(null)) {
  if (!name) return "Enter a name.";
  if (name.includes("/")) return "A folder name cannot contain /.";
  const full = parent ? `${parent}/${name}` : name;
  if (state.folders.some(f => f.id !== except?.id && acctOf(f) === acct && f.name.toLowerCase() === full.toLowerCase())) return `A folder named "${full}" already exists.`;
  return "";
}

async function createFolderIn(parent) {
  const where = parent ? parent.name : "";
  const acct = acctOf(parent);
  const name = await askName(parent ? `New folder in "${folderName(parent)}"` : "New folder", "", n => checkFolderName(n, where, null, acct));
  if (name == null) return;
  await folderOp("create", () => api.createFolder(where ? `${where}/${name}` : name, acct), `created folder "${name}"`);
  if (parent) { state.expanded.add(parent.name); saveSettings(); renderFolders(); }
}

async function renameFolderAsk(f) {
  const name = await askName(`Rename "${folderName(f)}"`, leafName(f), n => n === leafName(f) ? "" : checkFolderName(n, parentPath(f), f));
  if (name == null || name === leafName(f)) return;
  const to = parentPath(f) ? `${parentPath(f)}/${name}` : name;
  await folderOp("rename", () => api.renameFolder(f.id, to), `renamed to "${name}"`, () => renamePaths(f.name, to));
}

async function moveFolder(f, target) {
  const to = target === TOP_LEVEL ? leafName(f) : `${target.name}/${leafName(f)}`;
  const err = checkFolderName(leafName(f), target === TOP_LEVEL ? "" : target.name, f);
  if (err) { notify(`Could not move the folder: ${err}`); return; }
  await folderOp("move folder", () => api.renameFolder(f.id, to), `moved "${leafName(f)}" to ${target === TOP_LEVEL ? "Folders" : `"${folderName(target)}"`}`, () => renamePaths(f.name, to));
  if (target !== TOP_LEVEL) { state.expanded.add(target.name); saveSettings(); renderFolders(); }
}

// Expanded subtrees follow a renamed or moved folder.
function renamePaths(from, to) {
  state.expanded = new Set([...state.expanded].map(n => n === from ? to : n.startsWith(from + "/") ? to + n.slice(from.length) : n));
  saveSettings();
}

// A folder is deleted only when it and every folder inside it hold no messages; its subfolders
// go with it, innermost first.
async function deleteFolderAsk(f) {
  try { await loadFolders(true); } catch (e) { handleError(e, "delete folder"); return; }
  f = state.byId.get(f.id); if (!f) return;
  const tree = [f, ...subfolders(f)];
  if (api.holdsMail) {
    let holds;
    try { holds = await api.holdsMail(tree.map(x => x.id)); } catch (e) { handleError(e, "delete folder"); return; }
    if (holds) { notify(`"${folderName(f)}" is not empty: ${tree.length > 1 ? "it or its subfolders hold mail" : "it holds mail"}. Move or delete it first.`); return; }
  }
  const full = api.holdsMail ? [] : tree.filter(x => (x.total || 0) > 0);
  if (full.length) {
    const n = full.reduce((s, x) => s + x.total, 0);
    notify(`"${folderName(f)}" is not empty: ${full.length > 1 || full[0] !== f ? `it and its subfolders hold` : "it holds"} ${plural(n, "message")}. Move or delete them first.`);
    return;
  }
  const subs = tree.length - 1;
  if (!confirm(`Delete the folder "${folderName(f)}"${subs ? ` and its ${plural(subs, "empty subfolder")}` : ""}?`)) return;
  const order = tree.sort((a, b) => b.name.split("/").length - a.name.split("/").length);
  await folderOp("delete folder", async () => { for (const x of order) await deleteOne(x.id); }, `deleted folder "${leafName(f)}"`, () => {
    const shown = state.view.kind === "files" ? state.view.of : state.view.kind === "folder" ? state.view.folderId : null;
    files.forget(tree.map(x => x.id));
    if (tree.some(x => x.id === shown)) openFolder(inboxId());
  });
}

// The folder list can lag a deletion: a refused delete counts as done when the folder is no
// longer listed, and one that still is gets a second try after a moment.
async function deleteOne(id) {
  try { await api.deleteFolder(id); return; } catch (e) {
    await new Promise(ok => setTimeout(ok, 1500));
    await loadFolders(true);
    if (!state.byId.has(id)) return;
    try { await api.deleteFolder(id); } catch (e2) { await loadFolders(true); if (state.byId.has(id)) throw e2; }
  }
}

async function emptyFolderAsk(f) {
  try { await loadFolders(true); } catch (e) { handleError(e, "empty"); return; }
  f = state.byId.get(f.id); if (!f) return;
  if (!f.total) { status(`${folderName(f)} is already empty`); return; }
  if (!confirm(`Permanently delete all ${plural(f.total, "message")} in ${folderName(f)}? This cannot be undone.`)) return;
  await folderOp("empty", () => api.emptyFolder(f.id, f.total, f.acctId || "1"), `emptied ${folderName(f)}`, () => {
    if (state.view.kind === "folder" && state.view.folderId === f.id) { clearReader(); loadList("fresh"); }
    else if (state.view.kind === "files" && files.scopeIds().includes(f.id)) { clearReader(); files.reload(); }
  });
}

// The provider marks a folder read as one operation. When it reports that it changed nothing
// while the folder still counts unread mail, the unread messages are found and marked one by one.
// Folder counts can trail the change, so the folder shows read at once and the counts are read
// again a few seconds later.
// Marks unread messages read a page at a time until none are left; a page that comes back
// unchanged, or that the provider refuses in part, stops it with an error.
async function markEachRead(page) {
  let prev = "";
  for (let i = 0; i < 50; i++) {
    const ids = (await page()).messages.map(m => m.id).filter(api.isMessageId);
    if (!ids.length) return;
    const key = ids.join();
    if (key === prev) throw new Error(`${api.PROVIDER.name} kept ${plural(ids.length, "message")} unread`);
    prev = key;
    const r = await api.setRead(ids, true);
    if (r.failed?.length) throw new Error(`${api.PROVIDER.name} did not mark ${plural(r.failed.length, "message")} read`);
  }
}

async function markAllRead(f) {
  try {
    if (f) {
      if (!f.unread) { status(`${folderName(f)} has no unread mail`); return; }
      const r = await api.markFolderRead(f.id, f.unread, f.acctId || "1");
      // A bulk operation can finish having changed nothing (seen on Yahoo's Spam); what is still
      // unread is then marked message by message.
      if (r.changed === 0) await markEachRead(() => api.query(api.queries.unreadIn(f.id), 100));
    } else {
      // Starred is a search across folders: every starred unread message, not only those loaded
      await markEachRead(() => api.search(api.queries.starred(true), 100));
    }
  } catch (e) { handleError(e, "mark all read"); return; }
  // the rows shown read are those marked: the folder's, or the starred ones (Starred is no folder)
  const here = f ? state.view.kind === "folder" && state.view.folderId === f.id : !!state.view.starred;
  for (const m of state.messages) if (here || (f ? m.folder?.id === f.id : m.flags?.flagged)) m.flags = { ...m.flags, read: true };
  if (f) { const live = state.byId.get(f.id); if (live) live.unread = 0; }
  renderList(); updateFolderCounts();
  status(`marked ${f ? folderName(f) : "Starred"} read`);
  setTimeout(() => loadFolders(true).catch(() => {}), 4000);
}

// Runs one folder change, then reloads the folder list; failures go to the notice bar.
async function folderOp(what, call, done, after) {
  try {
    await call();
    after?.();
    await loadFolders(true);
    status(done);
  } catch (e) { handleError(e, what); try { await loadFolders(true); } catch { /* the next poll retries */ } }
}

// A dialog closes on a click on its backdrop only when the press also began there, so a text
// selection dragged out of the input does not close it.
function backdropCloses(el, close) {
  let down = null;
  el.onmousedown = e => { down = e.target; };
  el.onclick = e => { if (e.target === el && down === el) close(); down = null; };
}
// Tab and Shift+Tab stay among a dialog's own controls.
function trapFocus(box) {
  box.addEventListener("keydown", e => {
    if (e.key !== "Tab") return;
    const items = [...box.querySelectorAll("input, button, [tabindex]")].filter(x => !x.disabled && x.offsetParent);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement), n = items.length;
    e.preventDefault(); e.stopPropagation();
    items[(i + (e.shiftKey ? n - 1 : 1)) % n].focus();
  });
}

// ---------- name dialog ----------
// Resolves with the trimmed name, or null when cancelled; check returns an error to show, or "".
let promptDone = null;
function askName(title, value, check) {
  return new Promise(resolve => {
    $("prompt-title").textContent = title;
    const input = $("prompt-input"), err = $("prompt-err");
    input.value = value; err.textContent = "";
    $("promptbox").classList.remove("hidden");
    input.focus(); input.select();
    const finish = v => { $("promptbox").classList.add("hidden"); promptDone = null; $("list").focus(); resolve(v); };
    const ok = () => { const v = input.value.trim(), e = check(v); if (e) { err.textContent = e; input.focus(); return; } finish(v); };
    promptDone = () => finish(null);
    input.oninput = () => { err.textContent = ""; };
    input.onkeydown = e => {
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ok(); }
      else if (e.key === "Escape") { e.preventDefault(); finish(null); }
      if (e.key !== "Tab") e.stopPropagation();          // Tab goes on to the dialog's focus trap
    };
    $("prompt-ok").onclick = ok;
    $("prompt-cancel").onclick = () => finish(null);
    backdropCloses($("promptbox"), () => finish(null));
  });
}
trapFocus($("promptbox-box"));

// Patch counts in place so the tree (and any focus in its filter) is not rebuilt for a flag change.
function updateFolderCounts() {
  for (const el of $("folder-list").querySelectorAll(".folder")) {
    if (el.dataset.id === STARRED) { el.querySelector(".ct").textContent = state.starredCount == null ? "" : state.starredCount >= STARRED_MAX && !state.starredExact ? `${STARRED_MAX}+` : (state.starredCount || ""); continue; }
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

// Folder changes seen by any folder refresh wait here until acted on, so none is lost to a refresh
// made for another reason (after a send or a move) or while an action was running.
const listDirty = new Set(), contactsDirty = new Set();
async function actOnChanges() {
  const v = state.view;
  if (v.kind === "folder" && listDirty.has(v.folderId) && !busy) { listDirty.clear(); await loadList("refresh"); }
  else if (v.kind === "files" && !busy && files.scopeIds().some(id => listDirty.has(id))) { listDirty.clear(); await files.reload(); }
  if (contactsDirty.has(inboxId()) || contactsDirty.has(folderByType("SENT")?.id)) { contactsDirty.clear(); syncContacts(); }
}

let lastFoldersShown = "", lastStarredCount = 0;
async function loadFolders(silent = false) {
  const r = await api.folders();
  state.folders = r.folders;
  state.byId = new Map(r.folders.map(f => [f.id, f]));
  const changed = [];
  for (const f of r.folders) {
    const prev = state.modseq.get(f.id);
    if (prev !== undefined && prev !== f.highestModSeq) { changed.push(f.id); listDirty.add(f.id); contactsDirty.add(f.id); }
    state.modseq.set(f.id, f.highestModSeq);
  }
  // A poll sees a change in some folder nearly every time; the tree is redrawn only when what it
  // shows changed, and the Starred count (where the provider keeps none, a 500-message search)
  // is redone at most once a minute, or at once while Starred is open.
  const shown = JSON.stringify(r.folders.map(f => [f.id, f.name, f.unread, f.total, f.types]));
  if (shown !== lastFoldersShown) { lastFoldersShown = shown; renderFolders(); }
  if (state.starredCount == null || (changed.length && (state.view.starred || Date.now() - lastStarredCount > 60000))) { lastStarredCount = Date.now(); refreshStarredCount(); }
  if (!silent) status(`${r.folders.length} folders`, r.ms);
  return changed;
}

function updateTitle() {
  const unread = folderByType("INBOX")?.unread || 0;
  document.title = (unread ? `(${unread}) ` : "") + APP;
  noteInbox(unread);
}

// Mail that arrives while this tab is in the background puts a red dot on the tab icon (all a
// pinned tab shows) and on the toolbar button; looking at the tab clears it.
let lastUnread = null, newMail = false;
function noteInbox(unread) {
  if (lastUnread != null && unread > lastUnread && document.visibilityState === "hidden") setNewMail(true);
  lastUnread = unread;
  if (document.visibilityState === "visible") looked();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { setNewMail(false); looked(); } });

// The time the tab was last looked at is kept across browser restarts, so a tab that loads in the
// background (a pinned tab when the browser starts) can put up the dot for unread Inbox mail that
// arrived while the browser was closed.
const looked = () => chrome.storage.local.set({ inboxSeen: Date.now() }).catch(() => {});
async function noteMissed() {
  if (document.visibilityState !== "hidden") return;
  const seen = (await chrome.storage.local.get("inboxSeen").catch(() => ({}))).inboxSeen;
  if (!seen || document.visibilityState !== "hidden" || state.view.folderId !== inboxId()) return;
  if (state.messages.some(m => !m.flags?.read && (Number(m.headers?.date) * 1000) > seen)) setNewMail(true);
}

const PLAIN_ICONS = { 16: "icons/16.png", 32: "icons/32.png" };
async function dottedIcon(size) {
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = PLAIN_ICONS[size]; });
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), k = size / 32;
  g.drawImage(img, 0, 0, size, size);
  g.fillStyle = "#e5322d"; g.strokeStyle = "#ffffff"; g.lineWidth = Math.max(1, 1.75 * k);
  g.beginPath(); g.arc(24.5 * k, 24.5 * k, 7 * k, 0, 2 * Math.PI); g.fill(); g.stroke();
  return { url: c.toDataURL("image/png"), data: g.getImageData(0, 0, size, size) };
}
async function setNewMail(on) {
  if (on === newMail) return;
  newMail = on;
  const link = document.querySelector('link[rel="icon"]');
  try {
    if (!on) { link.href = PLAIN_ICONS[32]; await chrome.action.setIcon({ path: PLAIN_ICONS }); return; }
    const [i16, i32] = await Promise.all([dottedIcon(16), dottedIcon(32)]);
    if (!newMail) return;
    link.href = i32.url;
    await chrome.action.setIcon({ imageData: { 16: i16.data, 32: i32.data } });
  } catch { /* the icon is a convenience; mail works without it */ }
}

// ---------- list ----------
// Shown on a row under the pointer and on selected rows, just before the date.
const TRASH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v5M9.2 6.5v5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// mode: "fresh" (new view), "refresh" (same view, keep cursor and marks by id, same depth), "more" (next page).
// focusId: after a refresh, put the cursor on this message and open it (undo of a move).
// told: the status line reports the load. A refresh the app makes by itself says nothing, so it
// cannot cover the confirmation of what the user just did; one the user asked for (R) does.
async function loadList(mode = "fresh", focusId = null, { told = mode !== "refresh" } = {}) {
  const v = state.view;
  // a folder's attachments keep a list of their own: what would refresh the message list
  // refreshes that one
  if (v.kind === "files") { if (mode === "refresh") await files.reload(told); return; }
  if (v.kind === "contacts") { if (mode === "refresh") await people.reload(); return; }
  const token = ++state.listToken;
  const prevView = state.prevView;
  const cursorId = state.messages[state.selected]?.id ?? null;
  const oldOrder = state.messages.map(m => m.id), oldCursor = state.selected;
  const offset = mode === "more" ? state.messages.length : 0;
  // A refresh asks for one more than it shows, so a full answer tells whether more exist.
  const shownN = Math.max(PAGE, state.messages.filter(x => !x.elsewhere).length);
  const count = mode === "refresh" ? shownN + 1 : PAGE;
  if (mode !== "more" && v.kind === "folder") listDirty.delete(v.folderId);
  // a load that is discarded or fails leaves its folder still to be refreshed
  const stillDirty = () => { if (mode !== "more" && v.kind === "folder") listDirty.add(v.folderId); };
  if (mode === "refresh") state.refreshing = token;
  // what a fresh load replaces, put back if it fails
  const shown = mode === "fresh" ? { messages: state.messages, selected: state.selected, anchor: state.anchor, marked: new Set(state.marked), more: state.more, elsewhere: state.elsewhere } : null;
  if (mode === "fresh") { state.messages = []; state.selected = -1; state.anchor = -1; state.marked.clear(); state.more = false; state.loading = true; renderList(); }
  else if (mode === "more" && !state.messages.length) return;
  if (told) status(mode === "more" ? "loading more..." : "loading...");
  let r, other = null;
  try {
    // Searches the provider can answer in one query page normally; compound ones it cannot (AND
    // between words, NOT of words or senders, at Yahoo) are evaluated whole by query.js. A scoped
    // search also searches everything outside the scope; those hits are listed below the scoped ones.
    const nq = v.kind === "search" ? (v.raw || nativeQuery(parse(v.term), api.dialect)) : null;
    if (v.kind === "search" && !nq) {
      const t0 = performance.now(), ast = parse(v.term);
      const runQ = (s, n) => api.query(s, n).then(x => x.messages);
      const [res, oth] = await Promise.all([
        evaluate(ast, runQ, api.scopeFilter({ include: v.scope }), api.dialect),
        v.scope ? evaluate(ast, runQ, api.scopeFilter({ exclude: v.scope }), api.dialect).catch(() => null) : null,
      ]);
      r = { messages: res.messages, ms: Math.round(performance.now() - t0), complete: true, truncated: res.truncated || !!oth?.truncated };
      if (oth) other = { messages: oth.messages.slice(0, ELSEWHERE_MAX) };
    } else if (v.kind === "search" && v.scope) {
      const scoped = mode === "more" ? state.messages.filter(x => !x.elsewhere).length : 0;
      [r, other] = await Promise.all([
        api.searchScoped(nq, { include: v.scope }, count, scoped),
        mode === "more" ? null : api.searchScoped(nq, { exclude: v.scope }, ELSEWHERE_MAX, 0).catch(() => ({ messages: [] })),
      ]);
    } else r = v.kind === "search" ? await api.search(nq, count, offset) : await api.list(v.folderId, count, offset);
  } catch (e) {
    if (token !== state.listToken) { stillDirty(); return; }
    if (state.refreshing === token) state.refreshing = null;
    state.loading = false;
    stillDirty();
    if (mode === "fresh" && prevView) {
      state.view = prevView; Object.assign(state, shown);
      if (prevView.kind === "files") showFilesPane(true);
      if (prevView.kind === "contacts") showPeoplePane(true);
      renderFolders(); renderList();
    }
    handleError(e, "list");
    return;
  }
  if (token !== state.listToken) { stillDirty(); return; }
  if (state.refreshing === token) state.refreshing = null;
  state.loading = false;
  state.prevView = null;
  if (other) state.elsewhere = other.messages.map(x => ({ ...x, elsewhere: true }));
  else if (mode !== "more") state.elsewhere = [];
  if (mode === "more") {
    const have = new Set(state.messages.map(m => m.id));
    state.messages = state.messages.filter(x => !x.elsewhere).concat(r.messages.filter(m => !have.has(m.id)));
  } else state.messages = r.messages;
  if (mode === "refresh" && r.messages.length > shownN) { state.messages = state.messages.slice(0, shownN); state.more = !r.complete; }
  else state.more = !r.complete && r.messages.length >= (mode === "refresh" ? count : PAGE);
  if (!state.more) state.messages = state.messages.concat(state.elsewhere);
  if (mode !== "more") {
    const ids = new Set(state.messages.map(m => m.id));
    for (const id of state.marked) if (!ids.has(id)) state.marked.delete(id);
    const at = id => state.messages.findIndex(m => m.id === id);
    state.selected = mode !== "refresh" ? -1 : focusId && ids.has(focusId) ? at(focusId) : at(cursorId);
    // The cursor row went away elsewhere (another device): take its nearest survivor, next first.
    if (mode === "refresh" && state.selected < 0 && oldCursor >= 0) {
      const next = oldOrder.slice(oldCursor + 1).find(id => ids.has(id)) ?? oldOrder.slice(0, oldCursor).reverse().find(id => ids.has(id));
      if (next) state.selected = at(next);
    }
    state.anchor = state.selected;
    if (mode === "refresh") {
      const gone = state.openId && oldOrder.includes(state.openId) && !ids.has(state.openId);
      if (gone || (focusId && state.messages[state.selected]?.id === focusId)) followCursor();
    } else if (state.openId && !ids.has(state.openId) && v.kind === "folder") clearReader();
  }
  renderList();
  const name = v.starred ? "Starred" : v.kind === "search" ? `“${v.term}” in ${v.scope ? v.scope.name : "all mail"}` : (folderName(state.byId.get(v.folderId)) || v.folderId);
  $("list-title").textContent = noBidi(name);
  $("list-title").title = v.kind === "search" && !v.raw ? `Searched for: ${describe(parse(v.term))}` : "";
  const elseN = state.elsewhere.length, elseStr = elseN >= ELSEWHERE_MAX ? `${ELSEWHERE_MAX}+` : String(elseN);
  if (v.kind === "search" && v.scope && elseN && state.more) {
    // Elsewhere hits wait below the scoped pages; offer them up front.
    const link = document.createElement("a");
    link.className = "else-link"; link.href = "#";
    link.textContent = `+${elseStr} elsewhere`; link.title = "Search all mail (Shift+Enter in the search box)";
    link.onclick = e => { e.preventDefault(); doSearch(v.term, true); };
    $("list-title").append(" ", link);
  }
  const scopedN = state.messages.filter(x => !x.elsewhere).length;
  if (told) status(`${name}: ${scopedN} messages${v.scope && elseN ? `, ${elseStr} more in other folders` : ""}${r.truncated ? ` (a term matched over ${CAP} messages; only the newest ${CAP} were combined)` : ""}`, r.ms);
}

// Shown in place of the list when a view has no messages.
function emptyNote() {
  const v = state.view, el = document.createElement("div");
  el.className = "list-empty";
  let main, sub = "";
  if (v.starred) main = "No starred messages.";
  else if (v.kind === "search") {
    main = `Nothing matches “${esc(v.term)}”${v.scope ? ` in ${esc(v.scope.name)} or any other folder` : ""}.`;
    sub = v.scope || v.raw ? "" : "Press ? in the search box for search syntax.";
  } else {
    const f = state.byId.get(v.folderId);
    main = `No messages in ${esc(folderName(f) || "this folder")}.`;
    // An empty parent folder often just groups subfolders; say where the mail is.
    const subs = f ? subfolders(f).filter(x => !isHidden(x)) : [];
    const total = subs.reduce((s, x) => s + (x.total || 0), 0);
    if (subs.length) sub = total ? `Its ${subs.length} subfolder${subs.length === 1 ? " holds" : "s hold"} ${total.toLocaleString()} message${total === 1 ? "" : "s"}.` : "Its subfolders are empty too.";
  }
  el.innerHTML = `<div>${main}</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
  return el;
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
  let divided = false;
  state.messages.forEach((m, i) => {
    const h = m.headers || {};
    if (m.elsewhere && !divided) {
      divided = true; lastDay = null;
      const v = state.view, n = state.elsewhere.length, scopedN = i;
      const d = document.createElement("div");
      d.className = "elsewhere";
      d.setAttribute("role", "presentation");
      d.innerHTML = `<span>${scopedN ? "" : `Nothing in ${esc(v.scope?.name || "this folder")}. `}${n >= ELSEWHERE_MAX ? `${ELSEWHERE_MAX}+ matches` : `${n} match${n === 1 ? "" : "es"}`} in other folders</span>` +
        `<a href="#" title="Search all mail, with paging (Shift+Enter in the search box)">Search all mail</a>`;
      d.querySelector("a").onclick = e => { e.preventDefault(); doSearch(v.term, true); };
      frag.appendChild(d);
    }
    const day = dayLabel(h.date);
    // each row's name carries its date, so screen readers skip the day headings
    if (day !== lastDay) { const d = document.createElement("div"); d.className = "day"; d.setAttribute("aria-hidden", "true"); d.textContent = day; frag.appendChild(d); lastDay = day; }
    const el = document.createElement("div");
    el.className = "row" + (m.flags?.read ? "" : " unread") + (m.elsewhere ? " else" : "") + (i === state.selected ? " sel" : "") + (state.marked.has(m.id) ? " marked" : "");
    el.dataset.i = i;
    el.id = `row-${i}`;
    el.setAttribute("role", "option");
    el.draggable = true;
    const who = outgoing ? h.to?.[0] : h.from?.[0];
    el.innerHTML = `<span class="st" title="Star / unstar (s)"></span><span class="fl"></span><span class="fr" data-email="${attr(who?.email || "")}">${esc(who?.name || who?.email || "")}</span>` +
      `<span class="sb">${subjectHtml(h.subject)}${showFolder ? `<em>${esc(m.folder?.name || "")}</em>` : ""}</span>` +
      `<span class="dt"><span class="tr" title="Delete (Del)">${TRASH_ICON}</span>${fmtDate(h.date)}</span>`;
    paintFlags(el, m);
    el.onclick = e => {
      if (e.target.classList.contains("st")) { e.stopPropagation(); run(() => doSetStarred([m.id], !m.flags?.flagged)); return; }
      // The trash icon deletes every selected row when it is one of them, else only its own row,
      // leaving the selection as it is.
      if (e.target.closest(".tr")) { e.stopPropagation(); if (state.marked.has(m.id)) runAction("delete"); else run(() => doDelete([m.id])); return; }
      if (e.shiftKey) { markRange(state.anchor < 0 ? i : state.anchor, i); select(i, false); return; }
      // Ctrl/⌘-click adds a row to the selection, which starts with the row already selected
      if (e.ctrlKey || e.metaKey) {
        if (!state.marked.size && state.selected >= 0 && state.selected !== i) toggleMark(state.selected);
        toggleMark(i); select(i, false); return;
      }
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
  if (!state.messages.length && !state.loading) frag.appendChild(emptyNote());
  rows.appendChild(frag);
  rows.scrollTop = scrollTop;
  $("more").classList.toggle("hidden", !state.more);
  updateToolbar();
}

let dragging = null;
document.addEventListener("dragend", () => { dragging?.classList.remove("dragging"); dragging = null; });

const CLIP = `<svg viewBox="0 0 16 16" aria-label="has attachments"><path d="M10.5 4.5 5.4 9.6a1.6 1.6 0 0 0 2.3 2.3l5.4-5.4a3 3 0 0 0-4.3-4.3L3.4 7.6a4.4 4.4 0 0 0 6.2 6.2l4-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function paintFlags(el, m) {
  const st = el.querySelector(".st");
  st.textContent = m.flags?.flagged ? "★" : "☆";
  st.classList.toggle("on", !!m.flags?.flagged);
  el.querySelector(".fl").innerHTML = fileCount(m) ? CLIP : "";
  el.setAttribute("aria-label", rowLabel(m));
}
// What a screen reader says for a row: its state, then who, what and when.
function rowLabel(m) {
  const h = m.headers || {};
  const who = (["SENT", "DRAFT"].includes(folderType(state.byId.get(state.view.folderId))) ? h.to?.[0] : h.from?.[0]) || {};
  return [m.flags?.read ? "" : "Unread", noBidi(who.name || who.email || ""), plainSubject(h.subject) || "(no subject)", toDate(h.date)?.toLocaleString() || "",
    m.flags?.flagged ? "starred" : "", fileCount(m) ? "has attachments" : "", m.elsewhere ? `in ${noBidi(m.folder?.name || "another folder")}` : ""].filter(Boolean).join(", ");
}
// The list is a multi-select listbox: the selection is what is selected, or the cursor row when
// nothing is; the focused list names the cursor row as its active descendant.
function syncAria() {
  const rows = $("rows");
  rows.querySelectorAll(".row").forEach(el => {
    const m = state.messages[Number(el.dataset.i)];
    el.setAttribute("aria-selected", String(state.marked.size ? state.marked.has(m?.id) : Number(el.dataset.i) === state.selected));
  });
  // in a folder's attachments the list's active descendant is the selected attachment (files.js),
  // and in Contacts the person under the cursor (people.js)
  if (state.view.kind === "files" || state.view.kind === "contacts") {}
  else if (state.selected >= 0 && rowEl(state.selected)) $("list").setAttribute("aria-activedescendant", `row-${state.selected}`);
  else $("list").removeAttribute("aria-activedescendant");
  rows.setAttribute("aria-label", $("list-title").textContent || "Messages");
}
// Files a message carries, as the attachment strip counts them: images built into the body
// (disposition inline) are not files. Older list entries without the part list fall back to the count.
const fileCount = m => Array.isArray(m.attachments) ? m.attachments.filter(a => a.disposition !== "inline").length : (m.attachmentCount || 0);
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
    if (b.dataset.act === "undo") b.disabled = !pendingSends.length && (busy || !undoStack.length);   // z also cancels a send
    else if (b.dataset.act === "redo") b.disabled = busy || !redoStack.length;
    else b.disabled = busy || n === 0;
  }
  const first = state.messages.filter(m => state.marked.has(m.id))[0] || state.messages[state.selected];
  $("toolbar").querySelector('[data-act="read"]').textContent = first && !first.flags?.read ? "Mark read" : "Mark unread";
  $("toolbar").querySelector('[data-act="star"]').textContent = first && first.flags?.flagged ? "Unstar" : "Star";
  $("toolbar").querySelector('[data-act="spam"]').textContent = spamLabel();
  const elseN = state.messages.filter(x => x.elsewhere).length;
  $("list-count").textContent = `${state.messages.length - elseN}${state.more ? "+" : ""}${elseN ? ` (+${elseN} elsewhere)` : ""}` + (state.marked.size ? ` · ${state.marked.size} selected` : "");
  syncAria();
}

// ---------- reader ----------
let currentBody = null;
// The row of the message in the reader, which a search that does not find it leaves there.
let readerRow = null;
let markReadTimer = null;

// DOMPurify (vendor/purify.min.js) removes anything in a message that could run, navigate or
// submit, whatever the sender wrote and whether or not the provider cleaned it first. Links (HTML
// and SVG <a>, image-map <area>) open in a new tab, since the reader frame cannot navigate.
// The reader shrinks wide images with height:auto, which would otherwise follow the picture's own
// shape; an image's width and height attributes set its proportions instead, as mail clients
// honour them (a 640x1 spacer built from a 1x1 PNG stays one pixel tall, not a 640px square). A
// height attribute alone caps the height, so a spacer given its width in CSS stays flat too; a
// cap, not a height, so a narrow column still shrinks a picture in proportion.
const purify = globalThis.DOMPurify;
// A link's target resolves against the app's page, so only absolute web, mail and phone links keep
// theirs: a relative one would open an extension page. An in-message anchor scrolls the message
// (see setFrame). With the links setting at "clean", a web link loses its tracking (see links.js),
// and so does its text when that is the link written out, as in plain-text mail. Only mail is
// cleaned this way (cleanHtml); HTML pasted into the composer, which shares this hook, is not.
const LINK_OK = /^(https?:\/\/|mailto:|tel:)/i;
let cleaningLinks = false;
purify.addHook("afterSanitizeAttributes", node => {
  if ((node.localName === "a" || node.localName === "area") && (node.hasAttribute("href") || node.hasAttribute("xlink:href"))) {
    const href = (node.getAttribute("href") ?? node.getAttribute("xlink:href") ?? "").trim();
    if (/^#[^#]*$/.test(href) && node.localName === "a") { node.removeAttribute("target"); return; }
    if (!LINK_OK.test(href)) { node.removeAttribute("href"); node.removeAttribute("xlink:href"); node.removeAttribute("target"); return; }
    const clean = cleaningLinks ? cleanLink(href) : href;
    if (clean !== href) {
      node.setAttribute(node.hasAttribute("href") ? "href" : "xlink:href", clean);
      const t = node.firstChild;
      if (node.childNodes.length === 1 && t.nodeType === Node.TEXT_NODE && t.data.trim() === href) t.data = t.data.replace(href, clean);
    }
    node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "IMG" && !node.style.aspectRatio) {
    const w = Number(node.getAttribute("width")), h = Number(node.getAttribute("height"));
    if (w > 0 && h > 0) node.style.aspectRatio = `${w} / ${h}`;
    else if (h > 0 && !node.style.maxHeight) node.style.maxHeight = `${h}px`;
  }
});
// A message's own style sheets may not depend on what the message says. An attribute selector
// matches on values (a link's address, with the token in it) and :has() on what an element holds,
// so with images loading, a rule under either can fetch an address picked by the content and so
// tell a server what the message says. A provider may hand over the sender's CSS as written, so
// every sheet is read by the browser's own parser and loses the rules such a selector applies or
// sits in the condition of. A rule for :host goes too: in a printed copy, where each message is
// in a shadow root, it would style the message's own box and could move it over the header. A
// sheet with none of them keeps its text as written.
const READS_CONTENT = /\[|:has\(|:host/i;
function pruneRules(owner) {
  let cut = 0;
  for (let i = owner.cssRules.length - 1; i >= 0; i--) {
    const rule = owner.cssRules[i], text = rule.cssText, brace = text.indexOf("{");
    if (READS_CONTENT.test(rule.selectorText ?? (brace < 0 ? "" : text.slice(0, brace)))) { owner.deleteRule(i); cut++; }
    else if (rule instanceof CSSGroupingRule || rule instanceof CSSStyleRule) cut += pruneRules(rule);
  }
  return cut;
}
function contentBlindCss(css) {
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(css); } catch { return ""; }
  if (!pruneRules(sheet)) return css;
  // As the browser writes a sheet back, a string in it may spell the end of the style element,
  // which the text as written never can; the escape keeps the string and ends nothing.
  return [...sheet.cssRules].map(r => r.cssText).join("\n").replace(/<(?=\/style)/gi, "\\3c ");
}
purify.addHook("afterSanitizeAttributes", node => {
  if (node.localName === "style") node.textContent = contentBlindCss(node.textContent);
});
function cleanHtml(html) {
  cleaningLinks = settings.links === "clean";
  try { return purify.sanitize(html, { FORCE_BODY: true, FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option"], FORBID_ATTR: ["ping"], ADD_ATTR: ["target"] }); }
  finally { cleaningLinks = false; }
}

// Inline images (cid parts of the message) cannot be loaded by the sandboxed frame, which has no
// session; the provider fetches them here (api.inlineSource) and they go to the frame as data:
// URLs. body: the api.body result the HTML belongs to. Only sources the provider recognises as
// references to that message's own parts are asked for, at most max per message (60 to read
// one), so references to anything else take none of them.
const ownImages = (root, body) => [...root.querySelectorAll("img[src]")].filter(img => api.isInlineRef(img.getAttribute("src"), body));
async function inlineImages(html, body, max = 60) {
  const tpl = document.createElement("template");      // inert: nothing in it loads
  tpl.innerHTML = html;
  const imgs = ownImages(tpl.content, body);
  if (!imgs.length) return html;
  const srcs = [...new Set(imgs.map(img => img.getAttribute("src")))].slice(0, max);
  const got = new Map(await Promise.all(srcs.map(async s => [s, await api.inlineSource(s, body).catch(() => null)])));
  for (const img of imgs) { const d = got.get(img.getAttribute("src")); if (typeof d === "string") img.setAttribute("src", d); }
  return tpl.innerHTML;
}
// How many of the message's own inline pictures its HTML still refers to, after inlineImages:
// those that could not be fetched.
function imagesLeft(html, body) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return new Set(ownImages(tpl.content, body).map(img => img.getAttribute("src"))).size;
}

// ---------- contact cards ----------
// Hover an address in the reader header or a sender in the list to see what the address book
// knows about the person and the last messages exchanged with them.
const addrHtml = l => (l || []).map(a => `<span class="who" data-email="${attr(a.email || "")}" data-name="${attr(a.name || "")}">${esc(a.name ? `${a.name} <${a.email}>` : a.email || "")}</span>`).join(", ");

let cardTimer = null, cardHideTimer = null, cardFor = null;
function wireContactCards() {
  const show = el => {
    clearTimeout(cardHideTimer); clearTimeout(cardTimer);
    const email = el.dataset.email; if (!email) return;
    cardTimer = setTimeout(() => openCard(el, email, el.dataset.name), 450);
  };
  const leave = () => { clearTimeout(cardTimer); cardHideTimer = setTimeout(closeCard, 250); };
  // Hover works on the reader header's addresses only; in the list, right-click › About sender.
  document.addEventListener("mouseover", e => { const el = e.target.closest(".who"); if (el) show(el); else if (e.target.closest("#card")) clearTimeout(cardHideTimer); });
  document.addEventListener("mouseout", e => { if (e.target.closest(".who, #card")) leave(); });
  document.addEventListener("mousedown", e => { if (!e.target.closest("#card")) closeCard(); });
}

function closeCard() { $("card").classList.add("hidden"); cardFor = null; }

let cardSeq = 0;
async function openCard(anchor, email, name) {
  const card = $("card"), seq = ++cardSeq;
  cardFor = email;
  const c = await contacts.lookup(email);
  if (seq !== cardSeq) return;          // a newer card was asked for meanwhile
  const me = email.toLowerCase() === $("account").textContent.toLowerCase();
  const when = s => s ? new Date(s * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "never";
  card.innerHTML = `<div class="card-head"><b>${esc(c?.name || name || email)}</b><span>${esc(email)}</span></div>
    <div class="card-stats">${me ? "This is you." : c ? `Last exchange ${when(c.last)} · <a href="#" data-c="book" title="Show this address in Contacts">Open in Contacts</a>` : "Not in Contacts yet."}</div>
    <div class="card-actions"><button data-c="write">Write</button><button data-c="search">Find all from</button><button data-c="copy">Copy address</button></div>
    <div class="card-recent"><i>loading recent messages...</i></div>`;
  const r = anchor.getBoundingClientRect();
  card.classList.remove("hidden");
  card.style.left = Math.max(4, Math.min(r.left, innerWidth - card.offsetWidth - 8)) + "px";
  card.style.top = (r.bottom + card.offsetHeight + 6 > innerHeight ? Math.max(4, r.top - card.offsetHeight - 4) : r.bottom + 4) + "px";
  card.onclick = async e => {
    const b = e.target.closest("[data-c]"); if (!b) return;
    if (b.dataset.c === "write") { closeCard(); writeTo([{ name: c?.name || name || "", email }]); }
    else if (b.dataset.c === "book") { e.preventDefault(); closeCard(); openContacts({ select: email }); }
    else if (b.dataset.c === "search") { closeCard(); findFrom(email); }
    else if (b.dataset.c === "copy") { await navigator.clipboard.writeText(email).catch(() => {}); b.textContent = "Copied"; }
  };
  const q = api.queries.person(email);
  let res;
  try { res = await api.search(q, 5); } catch { res = { messages: [] }; }
  if (cardFor !== email || seq !== cardSeq) return;
  const recent = card.querySelector(".card-recent");
  recent.innerHTML = res.messages.length ? res.messages.map(m => {
    const out = (m.headers.from?.[0]?.email || "").toLowerCase() !== email.toLowerCase();
    return `<div data-id="${attr(m.id)}" title="${esc(plainSubject(m.headers.subject))}">${people.dirIcon(out)}<span class="subj">${esc(plainSubject(m.headers.subject))}</span><span class="dt">${fmtDate(m.headers.date)}</span></div>`;
  }).join("") : "<i>No messages found.</i>";
  recent.onclick = e => {
    const row = e.target.closest("[data-id]"), m = row && res.messages.find(x => x.id === row.dataset.id);
    closeCard();
    if (m) goToMessage(m, email); else searchPerson(email);
  };
}

// Opens a message's folder with the message highlighted and open in the reader, loading further
// pages of the folder until it turns up; failing that, the person's search shows it.
const GO_TO_PAGES = 10;
async function goToMessage(m, email) {
  const from = focusWhere();
  const fid = m.folder?.id;
  if (!fid || !state.byId.has(fid)) { searchPerson(email); return; }
  await openFolder(fid);
  const v = state.view;
  let i = state.messages.findIndex(x => x.id === m.id);
  for (let n = 0; i < 0 && state.more && n < GO_TO_PAGES && state.view === v; n++) {
    await loadList("more");
    i = state.messages.findIndex(x => x.id === m.id);
  }
  if (state.view !== v) return;            // the user went elsewhere meanwhile
  if (i < 0) { status(`that message is further back in ${folderName(state.byId.get(fid))}; showing the search`); searchPerson(email); return; }
  clearMarks(); select(i);
  focusListIfStill(from);
  if (folderType(state.byId.get(fid)) === "DRAFT") editDraft(i); else open(i);
}

// Only address characters reach the search box: quotes, parentheses and backslashes would end the term.
const bareAddress = email => String(email).replace(/["()\\\s]/g, "");
// All mail from (or to) an address, or any of several, in every folder.
const findFrom = (emails, field = "from") => doSearch([].concat(emails).map(e => `${field}:${bareAddress(e)}`).join(" OR "), true);
// All mail with a person, either way. openId: a message to select and open there. A search begun
// in Contacts, or in a search that was, goes back to Contacts (Esc).
async function searchPerson(email, openId = null) {
  const from = focusWhere();
  const back = [state.view, state.view.back].find(v => v?.kind === "contacts");
  leaveView();
  state.prevView = state.view;
  state.view = { kind: "search", folderId: null, term: email, raw: api.queries.person(email), back };
  $("search").value = email;
  updateScopeChip();
  renderFolders();
  const v = state.view;
  await loadList("fresh");
  focusListIfStill(from);
  const i = openId && state.view === v ? state.messages.findIndex(m => m.id === openId) : -1;
  if (i >= 0) { select(i); open(i); }
}
// A new message to these people ({ name, email }). When the message being written cannot be put
// away, no new one opens, and that message keeps the recipients it had.
async function writeTo(list) {
  if (!(await startCompose("new"))) return;
  for (const a of list) compose.addRecipient(a);
}

// look: "light" (as written), "dark" (declared colours darkened, see darken.js) or "dim" (as
// written, at 90% brightness so a white message does not glare in a dark app).
// Images come only from where the provider allows (api.IMAGE_SRC) and data: URLs, and are asked
// for without a referrer. The document says so itself, since the frame's own referrerpolicy
// attribute covers only the loading of the frame, not what the document in it then asks for.
function bodyDoc(html, images, look = "light") {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${images ? `${api.IMAGE_SRC} data:` : "'none'"};`;
  const dark = look === "dark";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>body{margin:12px 16px;font:14px/1.45 -apple-system,"Segoe UI",system-ui,sans-serif;color:${dark ? DARK.fg : "#111"};word-wrap:break-word}` +
    (dark ? `html{background:${DARK.bg};color-scheme:dark}a{color:${DARK.link}}` : look === "dim" ? "html{background:#fff;filter:brightness(.9)}" : "") +
    // The text size setting and the message zoom scale the message as a whole, so mail that
    // fixes its own sizes follows too.
    (messageScale() !== 1 ? `html{zoom:${messageScale()}}` : "") +
    `img{max-width:100%;height:auto${images ? "" : ";display:none"}}pre{white-space:pre-wrap}blockquote{border-left:3px solid ${dark ? DARK.rule : "#ccc"};margin:6px 0;padding-left:10px;color:${dark ? DARK.quote : "#444"}}</style></head>` +
    `<body>${html}</body></html>`;
}

// The open message in the reader. In a dark theme it is darkened unless the sun/moon button in
// the header asked for the original colours; that one choice applies to every message.
let bodyImages = false;
const darkApp = () => document.documentElement.dataset.theme === "dark";
function showBody(images = bodyImages) {
  bodyImages = images;
  const look = !darkApp() ? "light" : settings.readerOriginal ? "dim" : "dark";
  setFrame(bodyDoc(look === "dark" ? darkenHtml(currentBody.html) : currentBody.html, images, look), look === "dark" ? DARK.bg : "#fff");
}
function syncDarkButton() {
  const b = $("r-dark");
  b.classList.toggle("hidden", !darkApp());
  b.textContent = settings.readerOriginal ? "☾" : "☀";
  b.title = settings.readerOriginal ? "Darken messages" : "Show messages in their original colours";
}
function toggleReaderColours() {
  settings.readerOriginal = !settings.readerOriginal;
  saveSettings(); syncDarkButton();
  if (currentBody && state.openId) showBody();
}
// An HTML attachment is shown as a message is: cleaned, and in a dark theme darkened, unless
// messages are shown in their original colours.
function attachedHtml(source) {
  const html = cleanHtml(source), dark = darkApp() && !settings.readerOriginal;
  return { html: dark ? darkenHtml(html) : html, page: dark ? DARK : null };
}

// The message zoom, on top of the text size setting, is one choice for every message read or
// written: steps of 10% between 50% and 300%, 0 back to normal. The open frame, or the editor, is
// scaled in place, so the message keeps its scroll position; the next message gets it from bodyDoc
// or from the composer as it opens. A badge over the pane shows the level for a moment.
const messageScale = () => settings.textPct * settings.messageZoom / 10000;
function zoomMessage(dir) {
  const writing = compose.isOpen();
  if (!writing && !(currentBody && state.openId)) return;
  settings.messageZoom = dir === 0 ? 100 : Math.min(300, Math.max(50, settings.messageZoom + dir * 10));
  saveSettings();
  if (writing) compose.applyZoom();
  else { const html = $("r-body").contentDocument?.documentElement; if (html) html.style.zoom = messageScale(); }
  showZoomBadge(writing ? $("c-body") : $("r-body"));
}
// The recent messages on a contact's page in Contacts are zoomed the same way (Ctrl+wheel over
// them, or + - 0 there), as a choice of its own kept with the settings. The name, address and
// buttons above them stay as they are, as a message's heading does.
function zoomContact(dir) {
  settings.contactZoom = dir === 0 ? 100 : Math.min(300, Math.max(50, settings.contactZoom + dir * 10));
  saveSettings();
  applyLayout();
  showZoomBadge($("person").querySelector(".p-recent") || $("person"), settings.contactZoom);
}
let zoomBadgeTimer;
function showZoomBadge(pane, pct = settings.messageZoom) {
  const b = $("zoom-badge"), r = pane.getBoundingClientRect();
  b.textContent = `${pct}%`;
  b.style.left = `${r.left + r.width / 2}px`; b.style.top = `${r.top + r.height / 2}px`;
  b.classList.add("show");
  clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = setTimeout(() => b.classList.remove("show"), 900);
}

// how: "user" (a click or Enter) or "auto" (the reader following the cursor or restoring a folder).
// Only what the user opens, or sees opened, is marked read: never a message they marked unread in
// this session that the reader reopened by itself.
const keptUnread = new Set();
async function open(i, how = "user") {
  const m = state.messages[i];
  if (m) await openMessage(m, how);
}
// m: a row of the list, or of a folder's attachments, whose rows are not in it.
async function openMessage(m, how = "user") {
  if (how === "user") keptUnread.delete(m.id);
  if (!(await compose.close(true))) return;
  state.openId = m.id;
  clearTimeout(markReadTimer);
  status("fetching body...");
  let r;
  // a failure for a message the user has left meanwhile is no news about the one now open
  try { r = await api.body(m.id); } catch (e) { if (api.isGone(e)) { messageGone(m.id); return; } if (state.openId === m.id) showReaderError(e, "fetching the message"); return; }
  if (state.openId !== m.id) return;
  try { await renderMessage(m, r, how); } catch (e) { showReaderError(e, "rendering the message"); }
}

// A message removed elsewhere (another device, or a draft already discarded) leaves the list
// quietly; the list is refreshed in case more changed.
function messageGone(id) {
  if (state.openId === id) clearReader();
  removeLocal([id]);
  loadList("refresh").finally(() => status("that message no longer exists; the list was refreshed"));
}

function showReaderError(e, what) {
  handleError(e, what);
  if (e instanceof api.NotSignedIn) return;
  currentBody = null; readerRow = null;      // the previous message must not come back on a redraw, or print
  $("reader-empty").textContent = `Error ${what}: ${e.message}`;
  $("reader-empty").classList.remove("hidden");
  $("reader-head").classList.add("hidden");
  $("r-body").classList.add("hidden");
}

// A fresh frame per message: a sandboxed srcdoc frame that has been hidden and reused
// does not reliably repaint in every Chromium build.
// The frame runs no scripts (no allow-scripts, and its CSP has no script-src) but shares the
// app's origin, so the app hears keys pressed while the message has focus: shortcuts work there
// as anywhere else, and the keys that scroll the message stay with it. Its images are limited to
// the provider's image hosts and data: URLs, so mail cannot make a request that carries session cookies.
const READER_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "]);
function setFrame(doc, bg = "#fff") {
  const old = $("r-body");
  const f = document.createElement("iframe");
  f.id = "r-body";
  f.style.background = bg;
  f.setAttribute("sandbox", READER_SANDBOX);
  f.setAttribute("referrerpolicy", "no-referrer");
  f.addEventListener("load", () => {
    const doc = f.contentDocument;
    doc?.addEventListener("keydown", e => { if (!SCROLL_KEYS.has(e.key) || e.ctrlKey || e.metaKey) onKey(e); });
    for (const t of ACTIVITY) doc?.addEventListener(t, markActive, { capture: true, passive: true });
    // An in-message anchor (#section) would resolve against the app's URL and load it into the
    // frame; the app scrolls to the target instead.
    doc?.addEventListener("click", e => {
      const a = e.target.closest?.('a[href^="#"]'); if (!a) return;
      e.preventDefault();
      let id = a.getAttribute("href").slice(1); try { id = decodeURIComponent(id); } catch { /* as written */ }
      (id && (doc.getElementById(id) || doc.getElementsByName(id)[0]))?.scrollIntoView();
    });
    // Ctrl+wheel over the message zooms the message, not the tab.
    doc?.addEventListener("wheel", e => { if (e.ctrlKey) { e.preventDefault(); zoomMessage(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
  });
  f.srcdoc = doc;
  old.replaceWith(f);
}

// r.source keeps the HTML as the provider gave it, for relinkBody.
async function renderMessage(m, r, how = "user") {
  r.source = r.html;
  r.html = cleanHtml(r.html);
  currentBody = r; readerRow = m;
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
  $("r-folder").textContent = noBidi(r.message.folder?.name);
  const inTrash = rowInTrash(m);
  $("r-delete").textContent = inTrash ? "Undelete" : "Delete";
  $("r-delete").title = inTrash ? "Move this message to Inbox" : "Delete this message";
  const auto = autoImages(r.message);
  // images, and anything else that loads a picture: CSS backgrounds, SVG images, posters
  const hasImg = /<img\b|url\(|\bbackground\s*=|<image\b|\bposter\s*=|image-set\(/i.test(r.html);
  $("r-images").classList.toggle("hidden", !hasImg || auto);
  viewer.renderStrip(r.message, r.attachments, id => state.openId === id);
  if (auto) { const inlined = await inlineImages(r.html, r); if (state.openId !== m.id) return; r.html = inlined; }
  showBody(auto);
  status(plainSubject(h.subject).slice(0, 60), r.ms);
  clearTimeout(markReadTimer);
  if (settings.markReadSec != null && !m.flags?.read && !(how === "auto" && keptUnread.has(m.id))) {
    // In a hidden tab nobody has read it yet: the timer starts again once the tab is seen.
    // The message is found by its id each time, as a refresh of the list puts new rows in place
    // of the old; one that is no row of the list (a message shown from a folder's attachments)
    // has its folder counted here. While an action runs, the mark waits for it.
    const fire = () => {
      const row = () => state.messages.find(x => x.id === m.id);
      if (state.openId !== m.id || (row() || m).flags?.read) return;
      if (document.hidden) { document.addEventListener("visibilitychange", function again() { if (document.hidden) return; document.removeEventListener("visibilitychange", again); if (state.openId === m.id) arm(); }); return; }
      if (busy) { arm(500); return; }
      run(async () => {
        try {
          const r2 = await api.setRead([m.id], true);
          applyFlags(r2.ok, { read: true });
          if (r2.ok.includes(m.id) && !row()) {
            if (!m.flags?.read) bumpFolder(m.folder?.id, 0, -1);
            m.flags = { ...(m.flags || {}), read: true };
            updateFolderCounts();
          }
        }
        catch (e) { handleError(e, "mark read"); }
      });
    };
    const arm = (ms = settings.markReadSec * 1000) => { clearTimeout(markReadTimer); markReadTimer = setTimeout(fire, ms); };
    arm();
  }
}

async function loadImages() {
  if (!currentBody) return;
  const id = state.openId;
  currentBody.html = await inlineImages(currentBody.html, currentBody);
  if (state.openId === id) { showBody(true); $("r-images").classList.add("hidden"); }
}

// A change to the links setting redraws the open message at once, so a link that cleaning broke
// can be had as the sender wrote it without opening the message again.
async function relinkBody() {
  const body = currentBody;
  if (!body || !state.openId) return;
  let html = cleanHtml(body.source);
  if (bodyImages) html = await inlineImages(html, body);
  if (currentBody !== body) return;
  body.html = html;
  showBody();
}

const READER_EMPTY = "Select a message to read it. Press ? for keyboard shortcuts.";
function clearReader() {
  state.openId = null; currentBody = null; readerRow = null;
  $("reader-empty").textContent = READER_EMPTY;
  $("r-attach").classList.add("hidden");
  clearTimeout(markReadTimer);
  $("reader-empty").classList.remove("hidden");
  $("reader-head").classList.add("hidden");
  $("r-body").classList.add("hidden");
}

// ---------- compose integration ----------
function hideReaderForCompose(hide) {
  for (const id of ["reader"]) $(id).classList.toggle("hidden", hide);
}

// Reply, reply all and forward answer the message in the reader, wherever the cursor is. The body
// is taken once, so opening another message meanwhile cannot change what is answered. A failure
// brings the reader back. Answers whether it opened a composer.
let composeSeq = 0;
async function startCompose(mode) {
  const seq = ++composeSeq;
  if (!(await compose.close(true))) return;
  const me = $("account").textContent;
  const body = currentBody, images = bodyImages;
  if (mode !== "new" && (!body || !state.openId || body.message.id !== state.openId)) { status("open a message first"); return; }
  hideReaderForCompose(true);
  try {
    // the reader stays hidden only if a composer is open once the opening is over
    if (mode === "new") { const opened = await compose.open({ mode, myEmail: me }); hideReaderForCompose(compose.isOpen()); return opened; }
    status("preparing...");
    const html = await inlineImages(body.html, body);
    if (seq !== composeSeq) return;
    body.html = html;
    const opened = await compose.open({ mode, message: body.message, body, images, myEmail: me });
    hideReaderForCompose(compose.isOpen());
    status("");
    return opened;
  } catch (e) { if (!compose.isOpen()) hideReaderForCompose(false); handleError(e, "compose"); }
}

async function editDraft(i, { anyway = false } = {}) {
  const m = state.messages[i]; if (!m) return;
  const seq = ++composeSeq;              // a later click on another draft wins
  if (!(await compose.close(true))) return;
  status("loading draft...");
  let r;
  try { r = await api.body(m.id); } catch (e) { if (api.isGone(e)) messageGone(m.id); else handleError(e, "draft"); return; }
  if (seq !== composeSeq) return;
  // Each save replaces the draft, so its inline images and attachments must travel again with
  // it: images as embedded data, attachments as files fetched from the provider. If they cannot
  // be loaded the draft stays closed, so a save cannot strip them; a picture that cannot be had
  // at all may be given up with Open anyway.
  r.html = await inlineImages(r.html, r, Infinity);
  if (seq !== composeSeq) return;
  const missing = imagesLeft(r.html, r);
  if (missing && !anyway) {
    const reopen = () => { clearNotice("draft"); const j = state.messages.findIndex(x => x.id === m.id); if (j >= 0) editDraft(j, { anyway: true }); };
    notify(`Could not load ${plural(missing, "picture")} of the draft, so it was not opened: saving it would leave ${missing === 1 ? "that picture" : "them"} out.`, { key: "draft", what: "draft", action: { label: "Open anyway", run: reopen } });
    return;
  }
  const atts = r.attachments.filter(a => a.disposition !== "inline" && a.partId);
  let files = [];
  if (atts.length) {
    status(`loading the draft's ${plural(atts.length, "attachment")}...`);
    try {
      files = await Promise.all(atts.map(async a => {
        const x = await api.partBytes(m.id, a);
        return new File([x.bytes], a.filename || x.filename || "attachment", { type: x.type || "application/octet-stream" });
      }));
    } catch (e) { notify("Could not load the draft's attachments, so it was not opened (it is unchanged).", { detail: e.message, err: e, what: "draft" }); return; }
  }
  if (seq !== composeSeq) return;
  hideReaderForCompose(true);
  // a draft's quote may come from mail whose images the reader holds back; with images set to
  // never, so does the reopened draft
  await compose.open({ mode: "draft", message: r.message, body: r, files, partIds: atts.map(a => a.partId), myEmail: $("account").textContent, images: settings.images !== "never" });
  hideReaderForCompose(compose.isOpen());
  status("");
}

// Undo-send: the message is held client-side for settings.undoSendSec, then sent.
// Sends wait undoSendSec before going out, each on its own timer; z cancels the newest.
const pendingSends = [];
let sendTicker = null;
function scheduleSend(job) {
  const secs = settings.undoSendSec;
  const entry = { job, until: Date.now() + secs * 1000 };
  const fire = async () => {
    const i = pendingSends.indexOf(entry); if (i >= 0) pendingSends.splice(i, 1);
    showUndo();
    status(`sending...`);
    try {
      const r = await job.run();
      // The confirmation comes after the follow-up (the folders and the list the send changed),
      // whose own status would otherwise cover it at once.
      await loadFolders(true).catch(() => {}); await actOnChanges().catch(() => {});
      status(`sent: ${job.label.replace(/^send /, "")}`, r.ms);
    }
    catch (e) { handleError(e, "send"); await job.restore(); hideReaderForCompose(compose.isOpen()); }
  };
  if (!secs) { fire(); return; }
  entry.timer = setTimeout(fire, secs * 1000);
  pendingSends.push(entry);
  showUndo();
  if (!sendTicker) sendTicker = setInterval(() => { showUndo(); if (!pendingSends.length) { clearInterval(sendTicker); sendTicker = null; } }, 1000);
}

async function cancelSend() {
  const entry = pendingSends.pop();
  if (!entry) return false;
  clearTimeout(entry.timer);
  showUndo();
  status("send cancelled; message reopened");
  await entry.job.restore();
  hideReaderForCompose(compose.isOpen());
  return true;
}

// Closing or reloading the tab would drop messages still waiting to be sent and composer changes
// not yet in Drafts; the browser asks first.
window.addEventListener("beforeunload", e => {
  if (pendingSends.length || compose.hasUnsaved()) { e.preventDefault(); e.returnValue = ""; }
});

// ---------- print ----------
// Opens print.html in a new tab with the messages' sanitised HTML; several selected messages print as one document.
// Whether a message's remote images load by the setting: always, never, or except in Spam and Trash.
function autoImages(message) {
  const ft = folderType(state.byId.get(message.folder?.id)) || folderType(state.byId.get(state.view.folderId));
  return settings.images === "always" || (settings.images !== "never" && ft !== "BULK" && ft !== "TRASH");
}
// The same decision for a message, honouring images the user loaded in the reader.
const imagesFor = message => currentBody && message.id === currentBody.message.id ? bodyImages : autoImages(message);

// Printed messages show remote images only when the reader would. The print page enforces that
// with its own image policy (print.js); this removes what that policy would block anyway, so the
// page shows no broken images. An image that still refers to a part of the message (one that
// could not be inlined) is always dropped.
function printableImages(html, allowed) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const img of tpl.content.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (src.startsWith("data:")) { img.removeAttribute("srcset"); continue; }
    if (!allowed || api.isStrayImage(src)) img.remove(); else img.removeAttribute("srcset");
  }
  if (!allowed) {
    for (const el of tpl.content.querySelectorAll("[background]")) el.removeAttribute("background");
    for (const el of tpl.content.querySelectorAll("[style]")) el.setAttribute("style", el.getAttribute("style").replace(/url\([^)]*\)/gi, "none"));
    for (const st of tpl.content.querySelectorAll("style")) st.textContent = st.textContent.replace(/url\([^)]*\)/gi, "none");
  }
  return tpl.innerHTML;
}

async function printMessages() {
  const ids = state.marked.size ? targetIds() : (currentBody ? [currentBody.message.id] : []);
  if (!ids.length) { status("open or select a message to print"); return; }
  status(`preparing ${plural(ids.length, "message")} for printing...`);
  const bodies = [];
  for (const id of ids) {
    let r;
    if (currentBody && currentBody.message.id === id) r = currentBody;
    else { try { r = await api.body(id); r.html = cleanHtml(r.html); } catch (e) { handleError(e, "print"); return; } }
    bodies.push(r);
  }
  // The printed page has one rule for images: they load only if every message's may, and a
  // message whose images may load keeps them only then, so none prints as a broken image.
  const images = bodies.every(r => imagesFor(r.message));
  const messages = [];
  for (const r of bodies) messages.push({ headers: r.message.headers, attachments: r.attachments.filter(a => a.disposition !== "inline").map(a => a.filename), html: printableImages(await inlineImages(r.html, r), images), images });
  const key = `print:${Date.now()}`;
  // The hand-off goes through session storage, whose quota a large selection with images can pass.
  try { await chrome.storage.session.set({ [key]: { messages, images, auto: true } }); }
  catch (e) { notify(`Could not print ${plural(messages.length, "message")}: too much to hand to the print page at once. Try fewer.`, { detail: e.message, err: e, what: "print" }); return; }
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
  // A removed cursor moves to the first remaining row after it, else the last one before it.
  const after = curRemoved ? state.messages.slice(state.selected + 1).find(m => !set.has(m.id)) : null;
  state.messages = keep;
  state.elsewhere = state.elsewhere.filter(m => !set.has(m.id));
  for (const id of ids) state.marked.delete(id);
  const openGone = state.openId && set.has(state.openId);
  state.selected = !curRemoved ? keep.findIndex(m => m.id === cur?.id) : after ? keep.indexOf(after) : keep.length - 1;
  state.anchor = state.selected;
  renderList();
  if (curRemoved && state.selected >= 0) select(state.selected);
  if (openGone) followCursor();
}

// The open message left the list: the reader moves on to the cursor row and empties only when
// the list does. While composing, opening would close the draft, so the reader just clears.
function followCursor() {
  if (state.selected >= 0 && !compose.isOpen()) open(state.selected, "auto"); else clearReader();
}

function bumpFolder(id, dTotal, dUnread) {
  const f = state.byId.get(id); if (!f) return;
  f.total = Math.max(0, (f.total || 0) + dTotal);
  f.unread = Math.max(0, (f.unread || 0) + dUnread);
}

// ---------- serialisation ----------
// All mutations, undo and redo run one at a time; repeats while busy are dropped, not queued.
// Each one makes list loads already in flight stale, so they cannot undo its changes; a folder's
// first page among them is loaded again afterwards, or the folder would stay empty.
let busy = false;
async function run(fn) {
  if (busy) { status("busy, try again in a moment"); return; }
  const firstPage = state.loading;
  busy = true; ++state.listToken; updateToolbar();
  const refreshing = state.refreshing;       // a refresh in flight, which this makes stale
  state.refreshing = null;
  try { await fn(); } finally {
    busy = false; updateToolbar();
    if (firstPage && state.loading) loadList("fresh");
    else if (refreshing || (state.view.kind === "folder" && listDirty.has(state.view.folderId))) loadList("refresh");
  }
}

// ---------- undo ----------
const undoStack = [], redoStack = [];
const UNDO_MAX = 50;

function pushUndo(entry) {
  entry.fails = 0;
  undoStack.push(entry); if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  showUndo();
}

function showUndo() {
  const el = $("st-undo");
  const pendingSend = pendingSends[pendingSends.length - 1];
  if (pendingSend) {
    const left = Math.max(0, Math.ceil((pendingSend.until - Date.now()) / 1000));
    const more = pendingSends.length > 1 ? ` (and ${plural(pendingSends.length - 1, "more message")} waiting)` : "";
    el.textContent = `Sending in ${left} s: ${pendingSend.job.label}${more}; press z to cancel`;
    el.classList.add("pending");
  } else {
    el.classList.remove("pending");
    const u = undoStack[undoStack.length - 1], r = redoStack[redoStack.length - 1];
    el.textContent = (u ? `Undo: ${u.label} (z)` : "") + (u && r ? "   " : "") + (r ? `Redo: ${r.label} (Shift+Z)` : "");
  }
  updateToolbar();
}

// Undo and redo steps return the api results; ids that failed are reported like a first try's.
const failedOf = res => (Array.isArray(res) ? res : [res]).flatMap(r => r?.failed || []);
// A step that fails stays for one more try (the network may be back); failing again, it is taken
// off the list so the older entries stay reachable.
async function undoOrRedo(from, to, step, words) {
  const e = from.pop(); if (!e) return;
  status(`${words[0]}: ${e.label}...`);
  let ok = false;
  try {
    const failed = failedOf(await e[step]());
    ok = true; e.fails = 0; to.push(e);
    if (failed.length) notify(`${failed.length} of ${plural(e.count || failed.length, "message")} could not be ${words[2]}; the rest were.`, { err: Object.assign(new Error(`${failed.length} failed`), { detail: { failed } }), what: step });
    else status(`${words[1]}: ${e.label}`);
  } catch (err) {
    e.fails = (e.fails || 0) + 1;
    if (e.fails >= 2) { notify(`Could not ${step} “${e.label}” twice, so it was removed from the undo list.`, { detail: cause(err), err, what: step }); console.error(step, err); }
    else { from.push(e); handleError(err, step); }
  }
  showUndo();
  await loadFolders(true).catch(() => {});
  await loadList("refresh", ok && step === "undo" ? e.reopen : null);
}
const undo = () => undoOrRedo(undoStack, redoStack, "undo", ["undoing", "undone", "put back"]);
const redo = () => undoOrRedo(redoStack, undoStack, "redo", ["redoing", "redone", "changed again"]);

// ---------- actions ----------
const byIds = ids => { const set = new Set(ids); return state.messages.filter(m => set.has(m.id)); };
// The same, with the message open in the reader where the list no longer holds it.
const rowsOrOpen = ids => { const out = byIds(ids); if (readerRow && ids.includes(readerRow.id) && !out.some(m => m.id === readerRow.id)) out.push(readerRow); return out; };
const groupBy = (pairs) => { const g = new Map(); for (const [k, v] of pairs) { if (!g.has(k)) g.set(k, []); g.get(k).push(v); } return g; };
// Some messages of a batch failed: say how many, and that the rest went through.
const DONE = { mark: "changed", star: "changed", move: "moved", archive: "archived", delete: "deleted", spam: "marked as spam", notspam: "marked not spam" };
const partial = (r, what) => {
  if (!r.failed.length) return;
  const n = r.failed.length, total = n + r.ok.length;
  const err = Object.assign(new Error(`${n} of ${total} failed`), { detail: { failed: r.failed } });
  notify(`${n} of ${plural(total, "message")} could not be ${DONE[what] || "changed"}; the rest were.`, { err, what });
};

async function doSetRead(ids, read) {
  if (!ids.length) return;
  const before = byIds(ids).map(m => [!!m.flags?.read, m.id]);
  try {
    const r = await api.setRead(ids, read);
    applyFlags(r.ok, { read });
    for (const id of r.ok) if (read) keptUnread.delete(id); else keptUnread.add(id);
    status(`marked ${plural(r.ok.length, "message")} ${read ? "read" : "unread"}`, r.ms); partial(r, "mark");
    const okSet = new Set(r.ok);
    pushUndo({ label: `mark ${plural(r.ok.length, "message")} ${read ? "read" : "unread"}`, count: r.ok.length,
      undo: async () => { const out = []; for (const [was, g] of groupBy(before.filter(([, id]) => okSet.has(id)))) out.push(await api.setRead(g, was)); return out; },
      redo: () => api.setRead(r.ok, read) });
  } catch (e) { handleError(e, "mark"); }
}

async function doSetStarred(ids, flagged) {
  if (!ids.length) return;
  const before = byIds(ids).map(m => [!!m.flags?.flagged, m.id]);
  try {
    const r = await api.setStarred(ids, flagged);
    applyFlags(r.ok, { flagged });
    refreshStarredCount();
    status(`${flagged ? "starred" : "unstarred"} ${plural(r.ok.length, "message")}`, r.ms); partial(r, "star");
    const okSet = new Set(r.ok);
    pushUndo({ label: `${flagged ? "star" : "unstar"} ${plural(r.ok.length, "message")}`, count: r.ok.length,
      undo: async () => { const out = []; for (const [was, g] of groupBy(before.filter(([, id]) => okSet.has(id)))) out.push(await api.setStarred(g, was)); return out; },
      redo: () => api.setStarred(r.ok, flagged) });
  } catch (e) { handleError(e, "star"); }
}

async function doMove(ids, folderId, verb = "move") {
  if (!ids.length) return;
  const dest = state.byId.get(String(folderId)); if (!dest) { status("unknown destination folder"); return; }
  const msgs = rowsOrOpen(ids);
  const fallback = state.view.kind === "folder" ? state.view.folderId : null;
  const origins = msgs.map(m => ({ id: m.id, from: m.folder?.id ?? fallback, unread: !m.flags?.read }));
  const moving = origins.filter(o => o.from !== dest.id);
  if (!moving.length) { status(`already in ${folderName(dest)}`); return; }
  const openWas = state.openId;
  // the folder each message is shown in, for a provider whose move depends on it (Gmail's labels)
  const from = Object.fromEntries(moving.filter(o => o.from != null).map(o => [o.id, o.from]));
  try {
    const r = await api.move(moving.map(o => o.id), dest.id, { from });
    const okSet = new Set(r.ok);
    const done = moving.filter(o => okSet.has(o.id));
    for (const o of done) { bumpFolder(o.from, -1, o.unread ? -1 : 0); bumpFolder(dest.id, 1, o.unread ? 1 : 0); }
    const v = state.view;
    const leaves = v.kind === "folder" ? v.folderId !== dest.id
      : ["TRASH", "BULK"].includes(folderType(dest)) && !v.scope?.ids?.includes(dest.id);
    if (leaves) removeLocal(r.ok);
    else { for (const m of byIds(r.ok)) m.folder = { ...(m.folder || {}), id: dest.id, name: dest.name }; renderList(); }
    // the open message moved from outside the list leaves the reader
    if (readerRow && okSet.has(readerRow.id) && !state.messages.some(m => m.id === readerRow.id)) clearReader();
    updateFolderCounts();
    const n = plural(done.length, "message"), where = folderName(dest).split("/").pop();
    const words = { move: [`move ${n} to ${where}`, `moved ${n} to ${where}`], archive: [`archive ${n}`, `archived ${n}`], delete: [`delete ${n}`, `deleted ${n}`],
      spam: [`mark ${n} as spam`, `marked ${n} as spam`], notspam: [`mark ${n} not spam`, `marked ${n} not spam, moved to Inbox`],
      undelete: [`restore ${n} to ${where}`, `restored ${n} to ${where}`] }[verb];
    status(words[1], r.ms); partial(r, verb);
    const known = done.filter(o => o.from);
    // Contacts mirrors the mail outside Trash and Spam: these messages have left it, or come back
    // to it, and an undo turns that round (see mailLeft). A message that comes back into Drafts was
    // never sent, so it tells nothing of whom the user writes to.
    const moved = msgs.filter(m => okSet.has(m.id));
    const unsent = f => folderType(f) === "DRAFT", origin = new Map(known.map(o => [o.id, o.from]));
    const toDest = unsent(dest) ? [] : moved, toOrigin = moved.filter(m => !unsent(state.byId.get(origin.get(m.id))));
    const [went, came] = outOfMail(dest) ? [() => mailLeft(moved), () => mailBack(toOrigin)]
      : done.some(o => outOfMail(state.byId.get(o.from))) ? [() => mailBack(toDest), () => mailLeft(moved)] : [() => {}, () => {}];
    went();
    // A provider that can take back exactly what its move changed says how (undo); otherwise each
    // message moves back to the folder it came from. A redo's own answer undoes the redo.
    let last = r;
    pushUndo({ label: words[0], reopen: openWas && okSet.has(openWas) ? openWas : null, count: done.length,
      undo: async () => {
        const out = [];
        if (last.undo) out.push(await last.undo());
        else {
          for (const [from, g] of groupBy(known.map(o => [o.from, o.id]))) out.push(await api.move(g, from));
          if (known.length < done.length) notify(`${done.length - known.length} message(s) had no known origin folder and stayed in ${dest.name}`, { info: true });
        }
        came();
        return out.flat();
      },
      redo: async () => { last = await api.move(done.map(o => o.id), dest.id, { from }); went(); return last; } });
  } catch (e) { handleError(e, verb); }
}

// ---------- contacts mirror the mail that is kept ----------
// Mail in Trash and Spam is not mail with a person (a person's search leaves both out). When
// messages go there, each address in them that the book knows is looked up, a little after and one
// at a time, and forgotten if no mail with it is left (the ones the user pinned or hid, and the
// ones mail was copied to, stay: contacts.forget). When messages come back out, their addresses
// are learned again as a scan would have learned them. Undo and redo of such a move do the same,
// so a delete undone leaves the book as it was.
const outOfMail = f => ["TRASH", "BULK"].includes(folderType(f));
const CHECK_MAX = 200, CHECK_GAP = 300, CHECK_AFTER = 1500;
const toCheck = new Set();
let checking = false;
const pause = ms => new Promise(ok => setTimeout(ok, ms));
const addressesOf = msgs => [...new Set(msgs.flatMap(m => [...(m.headers?.from || []), ...(m.headers?.to || []), ...(m.headers?.cc || [])]).map(a => (a.email || "").toLowerCase()).filter(Boolean))];
function mailLeft(msgs) {
  for (const e of addressesOf(msgs)) if (toCheck.size < CHECK_MAX) toCheck.add(e);
  if (!checking && toCheck.size) checkContacts();
}
async function mailBack(msgs) {
  for (const e of addressesOf(msgs)) toCheck.delete(e);
  try { await contacts.learn(msgs); } catch (e) { console.error("contacts", e); }
  if (people.isShown()) people.reload();
}
async function checkContacts() {
  checking = true;
  let forgot = 0;
  try {
    await pause(CHECK_AFTER);               // the move has reached the provider's search by then
    while (toCheck.size) {
      const email = toCheck.values().next().value;
      toCheck.delete(email);
      const known = await contacts.lookup(email);
      if (!known || known.copied || known.given || known.added) continue;     // not in the book, or kept whatever a search says: nothing to ask
      let left;
      try { left = (await api.search(api.queries.person(email), 1)).messages?.length > 0; } catch { continue; }   // not known: it stays
      if (!left && !toCheck.has(email)) forgot += (await contacts.forget([email])).length;
      await pause(CHECK_GAP);
    }
  } catch (e) { console.error("contacts", e); }
  finally { checking = false; }
  if (forgot && people.isShown()) people.reload();
}

// Spam is a move to the spam folder (the provider's filter learns from the move); Not spam moves to Inbox.
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

// Undelete moves the reader's message from Trash to Inbox: Trash keeps no record of where a
// message came from, and Inbox is where it is found again.
const rowInTrash = m => folderType(state.byId.get(m?.folder?.id)) === "TRASH";
const doUndelete = id => doMove([id], inboxId(), "undelete");

// Delete moves to Trash. Permanent deletion only while viewing the Trash folder itself.
async function doDelete(ids) {
  if (!ids.length) return;
  const trash = folderByType("TRASH"); if (!trash) { status("no Trash folder"); return; }
  const v = state.view;
  const viewingTrash = v.kind === "folder" ? v.folderId === trash.id : !!v.scope?.ids?.includes(trash.id) && byIds(ids).every(m => m.folder?.id === trash.id);
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
    case "undo": if (pendingSends.length) return cancelSend(); return run(undo);
    case "redo": return run(redo);
  }
}

// ---------- context menu ----------
function showContextMenu(x, y) {
  const ids = targetIds(); if (!ids.length) return;
  const first = byIds(ids)[0];
  const n = ids.length > 1 ? ` (${ids.length})` : "";
  // The person the rows show (sender, or recipient in Sent and Drafts), if it is the same for all.
  const outgoing = ["SENT", "DRAFT"].includes(folderType(state.byId.get(state.view.folderId)));
  const people = byIds(ids).map(m => (outgoing ? m.headers?.to?.[0] : m.headers?.from?.[0]) || {});
  const who = people[0]?.email && people.every(p => (p.email || "").toLowerCase() === people[0].email.toLowerCase()) ? people[0] : null;
  // Reply and Forward answer the row that was clicked; drafts are edited, not answered.
  const answerable = folderType(state.byId.get(state.view.folderId)) !== "DRAFT";
  const whoTitle = who && (who.name ? `${who.name} <${who.email}>` : who.email);
  // [action, label, shortcut, tooltip]; null is a separator
  const items = [
    ...(answerable ? [["reply", "Reply", "r"], ["replyAll", "Reply all", "a"], ["forward", "Forward", "f"], null] : []),
    ["archive", "Archive" + n, "e"], ["move", "Move..." + n, "v"], ["spam", spamLabel(ids) + n, "!"], ["delete", "Delete" + n, "Del"], null,
    ["read", (first.flags?.read ? "Mark unread" : "Mark read") + n, "u"],
    ["star", (first.flags?.flagged ? "Unstar" : "Star") + n, "s"],
    ...(who ? [null, ["find", outgoing ? "Find all to" : "Find all from", "", whoTitle],
      ["about", outgoing ? "About recipient..." : "About sender...", "", whoTitle]] : []),
  ];
  openMenu(x, y, items, act => {
    if (act === "about") openCard({ getBoundingClientRect: () => ({ left: x, top: y, bottom: y }) }, who.email, who.name || "");
    else if (act === "find") findFrom(who.email, outgoing ? "to" : "from");
    else if (act === "reply" || act === "replyAll" || act === "forward") answerRow(state.selected, act);
    else runAction(act);
  });
}
// A context menu at (x, y). items: [action, label, shortcut, tooltip, disabled], or null for a
// separator. A disabled item is greyed out, and a click on it leaves the menu open.
function openMenu(x, y, items, onPick) {
  const ctx = $("ctx");
  ctx.innerHTML = items.map(it => it ? `<div data-act="${it[0]}"${it[4] ? ' class="off" aria-disabled="true"' : ""}${it[3] ? ` title="${esc(it[3])}"` : ""}><span>${esc(it[1])}</span>${it[2] ? `<kbd>${esc(it[2])}</kbd>` : ""}</div>` : "<hr>").join("");
  ctx.classList.remove("hidden");
  ctx.style.left = Math.min(x, innerWidth - ctx.offsetWidth - 4) + "px";
  ctx.style.top = Math.min(y, innerHeight - ctx.offsetHeight - 4) + "px";
  ctx.onclick = e => { const a = e.target.closest("[data-act]"); if (a?.classList.contains("off")) return; hideContextMenu(); if (a) onPick(a.dataset.act); };
}
function hideContextMenu() { $("ctx").classList.add("hidden"); }
// Reply or forward a row from the menu: the row is opened first, as the composer answers the
// open message.
async function answerRow(i, mode) {
  const m = state.messages[i]; if (!m) return;
  if (state.openId !== m.id || currentBody?.message?.id !== m.id) await open(i);
  if (state.openId === m.id) startCompose(mode);
}
document.addEventListener("mousedown", e => { if (!e.target.closest("#ctx")) hideContextMenu(); });
window.addEventListener("blur", hideContextMenu);

// ---------- move picker ----------
// Picks a folder for messages, or a new parent for a folder (move.folder), with TOP_LEVEL first.
let moveTargets = [], moveKb = 0, moveIds = [], moveFolderOf = null;
const TOP_LEVEL = { id: "", name: "Folders" };
function openMovePicker(ids, folder = null) {
  if (!ids.length && !folder) return;
  moveIds = ids; moveFolderOf = folder;
  $("movebox").classList.remove("hidden");
  $("move-filter").value = "";
  $("move-filter").placeholder = folder ? `Move "${folderName(folder)}" into...` : "Move to folder...";
  renderMoveList();
  $("move-filter").focus();
}
function renderMoveList() {
  const filter = $("move-filter").value.toLowerCase();
  const byName = (a, b) => (folderType(b) ? 1 : 0) - (folderType(a) ? 1 : 0) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (moveFolderOf) {
    const f = moveFolderOf;
    const here = t => t === TOP_LEVEL ? !parentPath(f) : t.id === parentOf(f);
    moveTargets = [TOP_LEVEL, ...parentChoices(f)].filter(t => !here(t) && (!filter || t.name.toLowerCase().includes(filter)));
  } else {
    const cur = state.view.kind === "folder" ? state.view.folderId : null;
    moveTargets = state.folders.filter(f => !isHidden(f) && f.id !== cur && !f.types.includes("DRAFT"))
      .filter(f => !filter || folderName(f).toLowerCase().includes(filter)).sort(byName);
  }
  moveKb = 0;
  $("move-list").innerHTML = moveTargets.map((f, i) => `<div data-i="${i}" class="${i === moveKb ? "kb" : ""}">${esc(f === TOP_LEVEL ? f.name : folderName(f))}</div>`).join("");
}
function closeMovePicker() { $("movebox").classList.add("hidden"); $("list").focus(); }
function pickMove(t) {
  const ids = moveIds, folder = moveFolderOf; closeMovePicker();
  if (folder) moveFolder(folder, t); else run(() => doMove(ids, t.id));
}
function wireMovePicker() {
  $("move-filter").oninput = renderMoveList;
  $("move-list").onclick = e => { const d = e.target.closest("[data-i]"); if (d) pickMove(moveTargets[Number(d.dataset.i)]); };
  backdropCloses($("movebox"), closeMovePicker);
  trapFocus($("movebox-box"));
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
// Each folder (and Starred) remembers, for this session, the highlighted message, the selection,
// the message open in the reader and the list's scroll position; returning to it restores them.
// A folder not visited yet opens with nothing selected and an empty reader. Searches are one-offs.
const viewMemory = new Map();
const viewKey = v => v.kind === "folder" ? `f:${v.folderId}` : v.starred ? "starred" : null;
function leaveView() {
  if (state.view.kind === "files") showFilesPane(false);   // Files remembers its own selection
  if (state.view.kind === "contacts") showPeoplePane(false);   // and so does Contacts
  const key = viewKey(state.view); if (!key) return;
  viewMemory.set(key, { cursorId: state.messages[state.selected]?.id ?? null, marked: [...state.marked],
    openId: state.openId, scrollTop: $("rows").scrollTop });
}
function restoreView() {
  const key = viewKey(state.view), mem = key && viewMemory.get(key);
  const at = id => state.messages.findIndex(m => m.id === id);
  if (!mem) { clearReader(); return; }
  const ids = new Set(state.messages.map(m => m.id));
  state.marked = new Set(mem.marked.filter(id => ids.has(id)));
  state.selected = state.anchor = mem.cursorId ? at(mem.cursorId) : -1;
  renderList();
  $("rows").scrollTop = mem.scrollTop;
  // While composing, opening would close the draft (as in followCursor)
  if (mem.openId && ids.has(mem.openId) && !compose.isOpen()) open(at(mem.openId), "auto"); else clearReader();
}

// After a view loads, the list takes the keyboard only if focus is still where it was when the
// load began; a user who moved on (search box, composer) keeps typing there.
const focusWhere = () => document.activeElement;
function focusListIfStill(from) {
  const now = document.activeElement;
  if (now === from || now === document.body || now === null) $("list").focus();
}

async function openFolder(id) {
  const from = focusWhere();
  leaveView();
  state.prevView = state.view;
  state.view = { kind: "folder", folderId: id, term: "" };
  $("search").value = "";
  scopeOff = false; updateScopeChip();
  renderFolders();
  const v = state.view;
  await loadList("fresh");
  if (state.view === v) restoreView();
  focusListIfStill(from);
}

// Attachments of a folder (its menu: Show attachments): their own list in the message list's
// place (files.js), with the folder highlighted in the tree, until another view is opened (Esc:
// the folder's messages). The message list is emptied, so message actions find nothing to act
// on; the reader shows a selected attachment's message.
function showFilesPane(on) {
  $("app").classList.toggle("files-view", on);
  if (on) files.resume(); else files.hide();
}
async function openFiles(id) {
  if (!state.byId.has(id)) return;
  const from = focusWhere();
  leaveView();
  state.prevView = state.view;
  state.view = { kind: "files", folderId: null, of: id, term: "" };
  ++state.listToken;        // a message list still loading is not wanted now
  Object.assign(state, { messages: [], selected: -1, anchor: -1, more: false, elsewhere: [], loading: false });
  state.marked.clear();
  $("search").value = "";
  scopeOff = false; updateScopeChip();
  renderFolders(); renderList(); clearReader();
  $("app").classList.add("files-view");
  const v = state.view;
  await files.show(id);
  if (state.view === v) focusListIfStill(from);
}
// The Files hooks: the provider's search in the folder (and its subfolders), and the app's reader,
// menus, dates and errors.
function filesScope(id, withSubs) {
  const f = state.byId.get(id); if (!f) return null;
  const subs = subfolders(f).filter(x => !isHidden(x));
  return { name: folderName(f).split("/").pop(), full: folderName(f), ids: [f.id, ...(withSubs ? subs.map(x => x.id) : [])], subs: subs.length };
}
// The subfolder a file's message is in, named only when the message is not in the folder itself.
// A row names the folder it is shown in (folder); where a message can be in several folders at
// once, the row names them all (labelIds), and its folder may be one outside the list, such as Inbox.
function filesWhere(m, id) {
  const f = state.byId.get(id); if (!f) return "";
  const at = [m.folder?.id, ...(m.labelIds || [])].map(x => state.byId.get(x)).filter(x => x && sameAcct(x, f));
  if (at.some(x => x.id === id)) return "";
  const sub = at.find(x => x.name.startsWith(f.name + "/"));
  return sub ? folderName(sub).split("/").pop() : "";
}
const outgoingRow = m => ["SENT", "DRAFT"].includes(folderType(state.byId.get(m.folder?.id)));
const filesHooks = {
  storage: chrome.storage.local,
  search: (ids, count, offset) => api.searchScoped(api.queries.files(), { include: { ids } }, count, offset),
  scope: filesScope, listed: api.isListed,
  who: m => (outgoingRow(m) ? m.headers?.to?.[0] : m.headers?.from?.[0]) || {},
  where: filesWhere,
  date: fmtDate,
  openRow: (m, how) => openMessage(m, how),
  // shown, or on its way: not while the composer has the reader's place
  isOpen: id => state.openId === id && !$("reader").classList.contains("hidden"),
  menu: openMenu,
  goTo: m => goToMessage(m, m.headers?.from?.[0]?.email || ""),
  status,
  fail: e => handleError(e, "files"),
};

// Contacts (the sidebar's Contacts row, g c): the address book in the message list's place and the
// selected person's page in the reader's (people.js), until another view is opened. The message
// list is emptied, so message actions find nothing to act on. Esc leaves for the view it was
// opened from (back); a search begun here comes back here. However it is left, it is shown again
// as it was.
function showPeoplePane(on) {
  if (!on) people.hide();          // while its list is still laid out, so it can note its place
  $("app").classList.toggle("contacts-view", on);
  if (on) people.resume();
}
// opts: { select: an address to show, filter: text for the filter box }
async function openContacts(opts = {}) {
  const cur = state.view;
  if (cur.kind === "contacts") { await people.show(opts); people.focusFilter(); return; }
  let back = cur.kind === "search" && !cur.starred ? cur.back : cur;
  if (back?.kind === "contacts") back = back.back;
  leaveView();
  state.prevView = cur;
  state.view = { kind: "contacts", folderId: null, term: "", back };
  ++state.listToken;        // a message list still loading is not wanted now
  Object.assign(state, { messages: [], selected: -1, anchor: -1, more: false, elsewhere: [], loading: false });
  state.marked.clear();
  $("search").value = "";
  scopeOff = false; updateScopeChip();
  renderFolders(); renderList(); clearReader();
  $("app").classList.add("contacts-view");
  const v = state.view;
  await people.show(opts);
  if (state.view === v && !compose.isOpen()) { if (opts.filter !== undefined) people.focusFilter(); else people.focus(); }
}
// The view a search or Contacts was opened from, shown again. A folder's attachments give way to
// the folder's messages.
function openBack(b) {
  if (b?.kind === "contacts") openContacts();
  else if (b?.starred) openStarred();
  else openFolder((b?.kind === "files" ? b.of : b?.folderId) || inboxId());
}
const peopleHooks = {
  write: list => writeTo(list),
  mailWith: (email, openId) => searchPerson(email, openId),
  find: (emails, field) => findFrom(emails, field),
  recent: (email, count) => api.search(api.queries.person(email), count),
  draft: m => folderType(state.byId.get(String(m.folder?.id))) === "DRAFT",
  trash: TRASH_ICON,
  subject: m => plainSubject(m.headers?.subject),
  date: fmtDate,
  menu: openMenu,
  status,
  leave: () => openBack(state.view.back),
  undoable: pushUndo,
  note: contactsNote,
};
// What Contacts says above its list while the book's first build is under way; "" once it is built.
// A provider that paces the build (api.LIMITS.scanAfter) takes a long while over it.
async function contactsNote() {
  if (await contacts.isBuilt()) return "";
  const sofar = buildProgress("");
  return `Contacts is still being built from your message headers${api.LIMITS.scanAfter ? ", a little at a time while you are not using the app" : ""}.${sofar ? ` ${sofar[0].toUpperCase()}${sofar.slice(1)}.` : ""} The addresses learned so far are listed and can be used; come back later for the complete list.`;
}
// How far the first build has come, for the status line and Contacts' notice: the message headers
// read of those there are to read (only headers are read, and the count says so: what, unless the
// sentence before it has said it) and, for a build that runs on without waiting for the user to be
// away, how long is left at the pace it has kept since it started here. "" before its first step.
let building = null;             // { read, total, from: read when the build started here, at: when that was (ms) }
function buildProgress(what = " message headers") {
  if (!building) return "";
  const { read, total, from, at } = building, secs = (Date.now() - at) / 1000;
  if (!total) return `${read.toLocaleString()}${what} read`;
  const counts = `${read.toLocaleString()} of ${total.toLocaleString()}${what} read`;
  if (api.LIMITS.scanAfter || secs < 5 || read <= from || read >= total) return counts;
  const left = (total - read) / ((read - from) / secs);
  return `${counts}, ${left < 50 ? "less than a minute" : `about ${Math.max(1, Math.round(left / 60))} min`} left`;
}

const STARRED = "starred";
const STARRED_Q = api.queries.starred();
const STARRED_MAX = 500;

// A search reports no total, so the count is the length of the starred list itself.
let starredCounting = null;
function refreshStarredCount() {
  if (starredCounting) { starredCounting.again = true; return; }
  starredCounting = { again: false };
  // a provider that keeps the count itself (Gmail) answers it exactly; otherwise it is a search, capped
  const counted = api.starredCount ? api.starredCount().then(n => ({ n, exact: true })) : api.search(STARRED_Q, STARRED_MAX).then(r => ({ n: r.messages.length, exact: false }));
  counted
    .then(r => { state.starredCount = r.n; state.starredExact = r.exact; updateFolderCounts(); })
    .catch(() => {})
    .finally(() => { const again = starredCounting.again; starredCounting = null; if (again) refreshStarredCount(); });
}
async function openStarred() {
  const from = focusWhere();
  leaveView();
  state.prevView = state.view;
  state.view = { kind: "search", folderId: null, term: "Starred", raw: STARRED_Q, starred: true };
  $("search").value = "";
  scopeOff = false; updateScopeChip();
  renderFolders();
  const v = state.view;
  await loadList("fresh");
  if (state.view === v) restoreView();
  focusListIfStill(from);
}

// ---------- search scope ----------
// A search covers the folder being viewed and its subfolders (or Starred), shown as a chip in
// the search box. The chip toggles to all mail; Shift+Enter always searches all mail.
const ELSEWHERE_MAX = 50;
let scopeOff = false;

function scopeOfView(v = state.view) {
  if (v.starred) return { starred: true, name: "Starred" };
  if (v.kind === "search") return v.scope || (v.back ? scopeOfView(v.back) : null);
  const f = state.byId.get(v.kind === "files" ? v.of : v.folderId);
  if (!f) return null;
  const subs = subfolders(f).filter(x => !isHidden(x));
  return { id: f.id, name: folderName(f).split("/").pop(), full: folderName(f), ids: [f.id, ...subs.map(x => x.id)], subs: subs.length };
}

function updateScopeChip() {
  const chip = $("search-scope"), s = scopeOfView();
  chip.classList.toggle("hidden", !s);
  if (!s) return;
  chip.classList.toggle("off", scopeOff);
  chip.textContent = scopeOff ? "All mail" : `in ${s.name}`;
  chip.title = scopeOff ? `Searching all mail. Click to search only ${s.full || s.name}.`
    : `Searching ${s.full || s.name}${s.subs ? ` and ${s.subs} subfolder${s.subs === 1 ? "" : "s"}` : ""}. Click (or Backspace in an empty box) for all mail; Shift+Enter searches all mail.`;
}

async function doSearch(term, everywhere = false) {
  const from = focusWhere();
  term = term.trim();
  if (!term) return;
  let ast;
  try { ast = parse(term); check(ast, api.dialect); } catch (e) { notify(`Could not search: ${e.message}.`); return; }
  if (!ast) { status("nothing to search for"); return; }
  const scope = everywhere || scopeOff ? null : scopeOfView();
  // a search from a search returns where the first one came from; Starred is a place of its own
  const back = state.view.kind === "search" && !state.view.starred ? state.view.back : state.view;
  leaveView();
  state.prevView = state.view;
  state.view = { kind: "search", folderId: null, term, scope, back };
  $("search").value = term;
  if (everywhere) scopeOff = true;
  renderFolders();
  updateScopeChip();
  await loadList("fresh");
  focusListIfStill(from);
}

// ---------- keyboard ----------
// + - 0 zoom what the reader's place shows: a contact's recent messages in Contacts, else the message.
const zoomPane = dir => state.view.kind === "contacts" && !compose.isOpen() ? zoomContact(dir) : zoomMessage(dir);
let pendingG = false;
const modals = ["help", "settings", "movebox", "promptbox"];
// On a Mac, shortcuts shown as Ctrl+X are labelled as the Command key the user presses.
const IS_MAC = /^mac/i.test(navigator.userAgentData?.platform || navigator.platform || "");
function macLabels() {
  if (!IS_MAC) return;
  const mac = s => s.replace(/Ctrl\+/g, "⌘").replace(/Ctrl-/g, "⌘-");
  for (const el of document.querySelectorAll("[title*='Ctrl']")) el.title = mac(el.title);
  const walk = document.createTreeWalker($("help"), NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.includes("Ctrl")) n.nodeValue = mac(n.nodeValue);
}

const SYMBOL_KEYS = new Set(["#", "!", "?", "/", "*", ","]);
const REPEATLESS = new Set(["e", "#", "Delete", "Backspace", "!", "p", "s", "u", "v", "x", "z", "Z", "c", "r", "a", "f", "R"]);
function onKey(e) {
  if (e.target.closest && e.target.closest("#compose")) return;
  // keys typed into the sign-in page (its paste box, its buttons and links) are the page's own
  if (e.target.closest && e.target.closest("#signin")) return;
  if (viewer.isOpen()) { viewer.onKey(e); return; }
  const openModal = modals.find(id => !$(id).classList.contains("hidden"));
  if (openModal) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (openModal === "movebox") closeMovePicker();
      else if (openModal === "promptbox") promptDone?.();
      else $(openModal).classList.add("hidden");
    }
    return;
  }
  const inSearch = document.activeElement === $("search");
  const inFolderFilter = document.activeElement === $("folder-filter");
  const inPeopleFilter = document.activeElement === $("p-filter");
  const onButton = document.activeElement?.tagName === "BUTTON";
  if (e.key === "Escape" && !$("search-help").classList.contains("hidden")) { e.preventDefault(); toggleSearchHelp(false); return; }
  if (e.key === "Escape" && searchSuggestOpen()) { e.preventDefault(); hideSearchSuggest(); return; }
  if (e.key === "Escape" && !$("card").classList.contains("hidden")) { e.preventDefault(); closeCard(); return; }
  if (e.key === "Escape") {
    if (inSearch) {
      $("search").value = ""; $("search").blur();
      // a search returns where it was begun: a folder (for its attachments, its messages), Starred or Contacts
      if (state.view.kind === "search" && !state.view.starred) openBack(state.view.back);
      return;
    }
    if (inFolderFilter) { e.preventDefault(); state.kbFolder = -1; renderFolders(); $("list").focus(); return; }   // the filter's text stays
    if (!$("ctx").classList.contains("hidden")) { hideContextMenu(); return; }
    if (state.view.kind === "contacts") { e.preventDefault(); people.escape(); return; }
    if (state.marked.size) { clearMarks(); return; }
    if (state.view.kind === "files") { openFolder(state.view.of); return; }
    // a person's mail shown from Contacts gives way to Contacts again
    if (state.view.kind === "search" && state.view.back?.kind === "contacts" && document.activeElement === $("list")) { openContacts(); return; }
  }
  if (inSearch) {
    const typing = e.isComposing || e.keyCode === 229;
    if (searchSuggestOpen() && !typing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveSearchSuggest(e.key === "ArrowDown" ? 1 : -1); return; }
      // Enter takes the highlighted person; with none highlighted it searches for what was typed
      if ((e.key === "Enter" && sgSel >= 0) || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); pickSearchSuggest(Math.max(0, sgSel)); return; }
    }
    if (e.key === "Enter" && !typing) { hideSearchSuggest(); toggleSearchHelp(false); doSearch($("search").value, e.shiftKey); }
    else if (e.key === "Backspace" && !$("search").value && scopeOfView() && !scopeOff) { scopeOff = true; updateScopeChip(); }
    return;
  }
  if (inFolderFilter) {
    const items = [...$("folder-list").querySelectorAll(".folder")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      state.kbFolder = Math.max(0, Math.min(items.length - 1, state.kbFolder + (e.key === "ArrowDown" ? 1 : -1)));
      items.forEach((el, i) => el.classList.toggle("kb", i === state.kbFolder));
      items[state.kbFolder]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const el = items[state.kbFolder] || items[0];
      if (el) { state.kbFolder = -1; el.dataset.id === STARRED ? openStarred() : openFolder(el.dataset.id); }
    }
    return;
  }
  // the Contacts filter box takes what is typed; its arrows and Enter are the list's
  if (inPeopleFilter) { people.onFilterKey(e); return; }
  if (onButton && (e.key === "Enter" || e.key === " ")) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === "z" || e.key === "Z") { e.preventDefault(); runAction(e.shiftKey ? "redo" : "undo"); }
    else if (e.key === "y") { e.preventDefault(); runAction("redo"); }
    else if (e.key === "a" && document.activeElement === $("list")) { e.preventDefault(); if (state.view.kind === "contacts") people.markAll(); else markRange(0, state.messages.length - 1); }
    return;
  }
  // Alt with a letter belongs to the browser and the system. A symbol command may need Option
  // (macOS) or AltGr (many European layouts) to type, so it still counts.
  if (e.altKey && !SYMBOL_KEYS.has(e.key)) return;
  // Caps Lock flips a letter's case, which here would swap z and Z (undo, redo) or r and R; the
  // case comes from Shift. A held key does not repeat an action that changes mail.
  if (/^[a-z]$/i.test(e.key) && e.getModifierState?.("CapsLock")) e = new Proxy(e, { get: (t, p) => p === "key" ? (t.shiftKey ? t.key.toUpperCase() : t.key.toLowerCase()) : typeof t[p] === "function" ? t[p].bind(t) : t[p] });
  if (e.repeat && REPEATLESS.has(e.key)) { e.preventDefault(); return; }
  if (pendingG) {
    pendingG = false;
    const map = { i: "INBOX", s: "SENT", t: "TRASH", d: "DRAFT", a: "ARCHIVE", b: "BULK" };
    if (map[e.key]) { const f = folderByType(map[e.key]); if (f) openFolder(f.id); return; }
    if (e.key === "f") { e.preventDefault(); $("folder-filter").focus(); state.kbFolder = -1; return; }
    if (e.key === "*") { e.preventDefault(); openStarred(); return; }
    if (e.key === "c") { e.preventDefault(); openContacts(); return; }
    return;
  }
  if (state.view.kind === "files" && files.onKey(e)) return;
  if (state.view.kind === "contacts" && people.onKey(e)) return;
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
    case "R": loadList("refresh", null, { told: true }); break;
    case "n": if (state.more) loadList("more"); break;
    case "i": loadImages(); break;
    case "+": case "=": zoomPane(1); break;
    case "-": zoomPane(-1); break;
    case "0": zoomPane(0); break;
    case "p": printMessages(); break;
    case "t": toggleTheme(); break;
    case ",": openSettings(true); break;
    case "?": $("help").classList.toggle("hidden"); break;
    case "Home": select(0); break;
    case "End": select(state.messages.length - 1); break;
    case "x": toggleMark(state.selected); break;
    case "e": runAction("archive"); break;
    case "#": case "Delete": runAction("delete"); break;
    case "Backspace": if (!e.target.closest?.("input, textarea, select, [contenteditable]")) { e.preventDefault(); runAction("delete"); } break;   // the Mac delete key
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
  const wasSystem = settings.theme === "system";
  settings.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applySettings(); saveSettings();
  status(`${settings.theme} theme${wasSystem ? "; Follow system is off (Settings turns it back on)" : ""}`);
}

function openSettings(show) {
  $("settings").classList.toggle("hidden", !show);
  if (show) { showAwakeSteps(false); renderAwake(); renderContactsRow(); }
}

function wireSettings() {
  for (const [sel, dark] of [["darkTheme", true], ["lightTheme", false]]) {
    const el = $(sel);
    el.innerHTML = Object.entries(THEMES).filter(([, t]) => t.dark === dark).map(([id, t]) => `<option value="${id}">${t.name}</option>`).join("");
    el.onchange = () => { settings[sel] = el.value; applySettings(); saveSettings(); };
  }
  // The palette follows the slider while it moves; the setting is saved when it is let go.
  $("contrast").oninput = () => {
    settings.contrast = clampContrast($("contrast").value);
    $("contrast-n").textContent = settings.contrast;
    applyLayout();
  };
  $("contrast").onchange = () => { settings.contrast = clampContrast($("contrast").value); applySettings(); saveSettings(); };
  for (const el of document.querySelectorAll("#settings input[type=radio]"))
    el.onchange = () => { settings[el.name] = el.value; applySettings(); saveSettings(); if (el.name === "links") relinkBody(); };
  $("poll").onchange = () => { settings.pollSec = Math.max(5, Number($("poll").value) || 20); applySettings(); saveSettings(); };
  $("awake").onchange = () => { settings.awake = $("awake").checked; applyAwake(); saveSettings(); renderAwake(); };
  $("awake-how").onclick = () => showAwakeSteps($("awake-steps").classList.contains("hidden"));
  $("ct-rebuild").onclick = () => rebuildContacts();
  $("composeFont").onchange = () => { settings.composeFont = $("composeFont").value; saveSettings(); };
  $("composeSize").onchange = () => { settings.composeSize = Number($("composeSize").value) || 13; saveSettings(); };
  $("undosend").onchange = () => { settings.undoSendSec = Math.min(60, Math.max(0, Number($("undosend").value) || 0)); saveSettings(); };
  $("markread").onchange = () => { const v = $("markread").value.trim(); settings.markReadSec = v === "" ? null : Math.max(0, Number(v) || 0); saveSettings(); };
  $("textpct").onchange = () => {
    settings.textPct = Math.min(150, Math.max(85, Math.round((Number($("textpct").value) || 100) / 5) * 5));
    applySettings(); saveSettings();
    if (currentBody && state.openId) showBody();
  };
  $("density").onchange = () => { settings.rowPct = Math.min(150, Math.max(80, Math.round((Number($("density").value) || 100) / 5) * 5)); applySettings(); saveSettings(); };
  $("settings-close").onclick = () => openSettings(false);
  // A provider the extension signs in to itself (Gmail) can be signed out of here, after a
  // confirmation, since it withdraws the permission at Google. The address book and the folders'
  // Files choices go with the sign-in, and the page loads afresh, so nothing of the mailbox stays in memory; the sign-in
  // panel then asks again.
  if (api.signOut) {
    $("signout").classList.remove("hidden");
    $("signout").onclick = async () => {
      if (pendingSends.length) { openSettings(false); status("not signed out: a message is still waiting to be sent"); return; }
      if (!confirm(`Sign out of ${$("account").textContent || "this account"}? The extension's access to the account is withdrawn at Google and its Contacts are cleared.`)) return;
      openSettings(false);
      if (!(await compose.close(true))) return;
      try { await api.signOut(); } catch (e) { handleError(e, "sign out"); return; }
      await contacts.clear().catch(() => {});
      await chrome.storage.local.remove(CONTACTS_AFTER).catch(() => {});
      await files.clear();
      location.reload();
    };
  }
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

// A background tab can be put to sleep (Edge's sleeping tabs) and then checks nothing. When it
// wakes or comes into view, check at once instead of waiting for the next interval.
let lastPoll = 0, polling = false;
function pollNow() { if (state.signedIn && !polling && Date.now() - lastPoll > 3000) { poll(); startPolling(); } }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollNow(); });
document.addEventListener("resume", pollNow);

// ---------- staying awake ----------
// While signed in, the tab holds the lock that keeps a browser from putting it to sleep
// (ext/awake.js), unless Settings says otherwise. A sleep that happens all the same is recorded
// for Settings to tell; the first long one of a tab that was to stay awake is also told in a
// notice, once, with the way to the browser's own setting, which Settings always offers.
function applyAwake() { if (settings.awake && state.signedIn) awake.hold(); else awake.release(); }
awake.watch(async (start, length) => {
  if (!state.signedIn) return;
  const wasHeld = awake.held();
  await awake.note(start, length, wasHeld).catch(() => {});
  if (!$("settings").classList.contains("hidden")) renderAwake();
  if (wasHeld && length >= awake.LONG && await awake.noteOnce().catch(() => false))
    notify(awake.wakeNote(length), { info: true, key: "sleep", action: { label: "What to do", run: async () => { clearNotice("sleep"); openSettings(true); await renderAwake(); showAwakeSteps(true); } } });
});
async function renderAwake() {
  const r = awake.report(await awake.sleeps().catch(() => []), { now: Date.now(), on: settings.awake });
  $("awake-status").textContent = r.text;
  $("awake-how").textContent = r.steps ? "How to stop that" : "Browser's own setting";
}
// The browser's own list of pages it keeps awake: this copy's address to add, and where. A page of
// the browser's settings cannot be linked to, so its button opens it in a tab.
function showAwakeSteps(show) {
  const box = $("awake-steps");
  $("awake-how").setAttribute("aria-expanded", String(show));
  box.classList.toggle("hidden", !show);
  if (!show) return;
  const s = awake.steps(awake.browser(), chrome.runtime.id);
  const list = holding("ol", ...s.lines.map(t => holding("li", rich(t))));
  list.className = "g-lines";
  const open = s.open && Object.assign(document.createElement("button"), { type: "button", id: "awake-open", textContent: s.open.label,
    onclick: () => chrome.tabs.create({ url: s.open.url }).catch(() => status(`open ${s.open.url} from the address bar`)) });
  box.replaceChildren(holding("p", s.lead), copyRow(s.copy), list, ...(open ? [holding("p", open)] : []));
  box.scrollIntoView({ block: "nearest" });
}

async function poll() {
  if (busy || polling) return;
  polling = true; lastPoll = Date.now();
  try {
    await loadFolders(true);
    await actOnChanges();
  } catch (e) { handleError(e, "poll", { quiet: true }); }
  finally { polling = false; }
  checkUpdate().catch(() => {});  // network at most once a day; otherwise a storage read
}

// The installed version heads Settings; when GitHub has a newer release, a note at the foot of
// Settings says so and the gear gets a dot.
async function checkUpdate() {
  const have = chrome.runtime.getManifest().version, note = $("update-note");
  $("app-version").textContent = `${APP} ${have}`;
  $("app-repo").href = update.REPO;
  if (!await loadedFromZip()) return;
  const v = await update.latest().catch(() => null);
  const avail = !!v && update.newer(v, have);
  $("gear").classList.toggle("has-update", avail);
  $("gear").title = avail ? `Settings (version ${v} available)` : "Settings";
  note.classList.toggle("hidden", !avail);
  if (!avail) return;
  const a = Object.assign(document.createElement("a"), { href: update.RELEASES, target: "_blank", rel: "noopener", textContent: "Download it from GitHub" });
  note.replaceChildren(`Version ${v} is available. `, a, ". Checked daily with GitHub; no data about you is sent.");
}

// A release ZIP is loaded with "Load unpacked" and never updates itself, so only then is GitHub
// asked. A store install is updated by the browser and contacts nothing but the mail service.
async function loadedFromZip() {
  try { return (await chrome.management.getSelf()).installType === "development"; } catch { return false; }
}

// ---------- startup ----------
// The sign-in panel, worded by the provider: what is missing, where to sign in, and its button.
function fillSignIn() {
  const s = api.PROVIDER.signIn;
  $("signin-title").textContent = APP;
  $("signin-text").textContent = s.text;
  const link = $("signin-link");
  link.classList.toggle("hidden", !s.link);
  if (s.link) { link.href = s.link.href; link.textContent = s.link.label; }
  $("signin-then").textContent = s.link ? ", then " : "";
  $("retry").textContent = s.button;
  $("signin-end").textContent = s.link ? "." : "";
}

// e: the NotSignedIn that brought the panel, which a provider with a setup guide may explain.
function showSignIn(e) {
  state.signedIn = false;
  startPolling();
  clearTimeout(startRetry);
  $("signin-none").classList.remove("hidden"); $("signin-fail").classList.add("hidden");
  $("signin").classList.remove("hidden");
  $("app").classList.add("hidden");
  if (api.setup) drawSignIn({ error: e }).catch(err => console.error("sign-in page", err));
}

// The sign-in page of a provider with a setup guide (api.setup): the guide while there is no
// Client ID or a new one is being set up, its last step holding the sign-in button; otherwise the
// button alone, with what Google will ask and help at hand. The same view is not drawn twice, so
// calls that arrive together (several requests failing at once) keep what is typed and where the
// focus is; a failure to explain is shown either way.
let signInView = null, signInDrawn = "";
async function drawSignIn({ error = null, force = false, focus = false } = {}) {
  const view = await api.setup.view();
  const advice = error ? await api.setup.explain(error) : null;
  const key = JSON.stringify([view.kind, view.route, view.step, view.clientId, view.account]);
  if (key === signInDrawn && !force && !advice) return;
  signInView = view; signInDrawn = key;
  $("signin").classList.add("rich");
  $("signin-none").append($("signin-ready"));      // home again before the guide is drawn anew
  $("signin-text").replaceChildren(rich(view.text));
  const guide = view.kind === "guide", step = guide ? view.steps.find(s => s.id === view.step) : null;
  $("signin-guide").classList.toggle("hidden", !guide);
  if (guide) {
    drawGuide($("signin-guide"), view, {
      step: id => moveGuide(view.route, id),
      route: route => moveGuide(route, null),
      check: api.setup.check,
      paste: async text => {
        const r = await api.setup.paste(text, view.route);
        if (r.id) { await drawSignIn({ force: true, focus: true }); if (r.warn) showAdvice({ text: r.warn, note: true }); }
        return r;
      },
    });
    if (step?.signIn) $("signin-guide").querySelector(".g-slot")?.append($("signin-ready"));
  }
  $("signin-ready").classList.toggle("hidden", guide && !step?.signIn);
  $("signin-notes").classList.toggle("hidden", guide);
  $("signin-notes").replaceChildren(...view.notes.map(t => holding("li", rich(t))));
  $("signin-trouble").textContent = view.trouble;
  $("signin-reset").textContent = view.reset;
  $("signin-reset").classList.toggle("hidden", guide);
  $("signin-more").classList.remove("hidden");
  $("signin-help").classList.add("hidden");
  showAdvice(advice);
  if (focus) focusStep($("signin-guide"));
}
async function moveGuide(route, step) {
  await api.setup.at(route, step);
  await drawSignIn({ force: true, focus: true });
}
// A failed sign-in in words (null clears it): the sentence and its page to open, the list of
// what Google's window may have said, and the button's label for a press that needs no window.
const holding = (tag, ...kids) => { const n = document.createElement(tag); n.append(...kids); return n; };
function showAdvice(a) {
  const box = $("signin-alert");
  box.classList.toggle("hidden", !a);
  box.classList.toggle("note", !!a?.note);
  box.replaceChildren(...(a ? [holding("p", rich(a.text))] : []), ...(a?.open ? [holding("p", pageLink(a.open))] : []));
  $("retry").textContent = a?.held ? a.button : api.PROVIDER.signIn.button;
  if (a?.help && signInView) { drawHelp($("signin-help"), signInView.help, { pick: a.pick }); $("signin-help").classList.remove("hidden"); }
}
// The sign-in button of a provider with a setup guide: it says it is waiting while Google's window
// is open, and a sign-in that fails stays on the page with its reason; only one that succeeds goes
// on to load the mailbox.
async function pressSignIn() {
  const b = $("retry"), wait = $("signin-wait");
  if (b.disabled) return;
  b.disabled = true;
  showAdvice(null);
  wait.textContent = api.PROVIDER.signIn.waiting || "";
  wait.classList.toggle("hidden", !wait.textContent);
  let failed = null;
  try { await api.signIn(); } catch (e) { failed = e; }
  b.disabled = false;
  wait.classList.add("hidden");
  if (!failed) { start(); return; }
  if (!(failed instanceof api.NotSignedIn)) { showStartError(failed); return; }
  console.warn("sign-in", failed.code, failed.message);
  if (failed.code === "setup") { await drawSignIn({ force: true, focus: true }); return; }
  showAdvice(await api.setup.explain(failed));
}

// The mailbox could not be loaded (offline, the service down): the reason is shown on a page of
// its own, since the app and its notice bar are hidden, and loading is tried again by itself.
let startRetry = null, startReport = "", starting = false;
function showStartError(e) {
  console.error("start", e);
  state.signedIn = false;
  startPolling();
  const tech = Object.assign(document.createElement("span"), { className: "tech", textContent: cause(e) });
  $("fail-text").replaceChildren(FAILED.start, " ", tech);
  startReport = errorReport("start", e);
  $("signin-none").classList.add("hidden"); $("signin-fail").classList.remove("hidden");
  $("signin").classList.remove("hidden");
  $("app").classList.add("hidden");
  clearTimeout(startRetry);
  startRetry = setTimeout(start, 30000);
}
const startFailed = () => !$("signin-fail").classList.contains("hidden") && !$("signin").classList.contains("hidden");
window.addEventListener("online", () => { if (startFailed()) start(); });

async function start() {
  if (starting) return;
  starting = true;
  clearTimeout(startRetry);
  try { await startUp(); } finally { starting = false; }
}
async function startUp() {
  // A new-mail dot left on the toolbar button by an earlier load of this page (a reload, or the
  // browser discarding the tab) goes; and the browser is asked not to discard this tab, which
  // would stop the mail checks.
  try { chrome.action.setIcon({ path: PLAIN_ICONS }).catch(() => {}); } catch { /* no toolbar button */ }
  try { chrome.tabs.getCurrent().then(t => t && chrome.tabs.update(t.id, { autoDiscardable: false })).catch(() => {}); } catch { /* not in a tab */ }
  await loadSettings();
  applyLayout(); syncSettingsForm();
  // a failure page of an earlier try stays up while this one waits, until it succeeds
  if (!startFailed()) $("signin").classList.add("hidden");
  try {
    const s = await api.bootstrap();
    $("signin").classList.add("hidden");
    $("account").textContent = s.email;
    // the address book belongs to one account; another one signed in starts it afresh
    if (s.email) await contacts.useAccount(s.email).catch(() => {});
    await files.useAccount(s.email);
    $("app").classList.remove("hidden");
    await loadFolders();
    state.signedIn = true;
    startPolling();
    applyAwake();
    await openFolder(inboxId());
    noteMissed();
    syncContacts();
  } catch (e) { if (e instanceof api.NotSignedIn) showSignIn(e); else showStartError(e); }
  checkUpdate().catch(() => {});
}

// Address book: built on first run from all the mail outside Spam and Trash, then refreshed on
// each poll that sees Inbox or Sent change.
// A provider whose requests cost quota (Gmail: api.LIMITS.scanAfter) builds it out of the way:
// not before scanAfter has passed since the mailbox was first opened, when the user is likely
// trying the app, and then a step at a time, each once the user has left the app alone for
// api.LIMITS.scanIdle (no click, key or wheel, here or in a message) or the tab is hidden. The time
// the build may start is kept, so a reload does not start the wait again; Sign out forgets it.
const CONTACTS_AFTER = "contactsAfter";
let lastInput = Date.now();
const markActive = () => { lastInput = Date.now(); };
const ACTIVITY = ["pointerdown", "keydown", "wheel"];
for (const t of ACTIVITY) document.addEventListener(t, markActive, { capture: true, passive: true });
async function untilIdle() {
  for (;;) {
    const after = (await chrome.storage.local.get(CONTACTS_AFTER))[CONTACTS_AFTER] || 0;
    const wait = contacts.paceWait({ now: Date.now(), after, lastInput, idle: api.LIMITS.scanIdle, hidden: document.hidden });
    if (!wait) return;
    await new Promise(ok => setTimeout(ok, Math.min(wait, 30e3) + 50));
  }
}
// What the build has to read, for its progress and for saying beforehand how long it takes: Sent,
// Inbox, and the mail in neither (nor in Drafts).
function buildTotals() {
  const sent = folderByType("SENT"), inbox = state.byId.get(inboxId()), drafts = folderByType("DRAFT");
  return { sent: sent?.total || 0, inbox: inbox?.total || 0, rest: api.countAll(state.folders, [sent?.id, inbox?.id, drafts?.id].filter(Boolean)) };
}
// The sync under way: one at a time, and a rebuild waits for it. One asked for meanwhile (a poll
// that saw new mail during the first build) runs once it ends, so that mail is learned while it is
// still in Inbox or Sent.
let contactsRun = null, contactsAgain = false;
function syncContacts() {
  if (contactsRun) { contactsAgain = true; return contactsRun; }
  return contactsRun = runContactsSync().finally(() => { contactsRun = null; if (contactsAgain) { contactsAgain = false; syncContacts(); } });
}
async function runContactsSync() {
  try {
    const own = [$("account").textContent];
    try { own.push(...(await api.accounts()).accounts.map(a => a.email)); } catch {}
    contacts.setOwnAddresses(own);
    const first = !(await contacts.isBuilt());
    const slow = first && !!api.LIMITS.scanAfter;
    if (slow && !(await chrome.storage.local.get(CONTACTS_AFTER))[CONTACTS_AFTER]) await chrome.storage.local.set({ [CONTACTS_AFTER]: Date.now() + api.LIMITS.scanAfter });
    let shownAt = 0;
    const n = await contacts.sync({ inbox: inboxId(), sent: folderByType("SENT")?.id, drafts: folderByType("DRAFT")?.id, totals: buildTotals(), pace: slow ? untilIdle : null,
      progress: first ? ({ read, total }) => {
        building = { read, total, from: building?.from ?? read, at: building?.at ?? Date.now() };
        statusQuietly(`building Contacts: ${buildProgress()}`);
        // Contacts and Settings, when open, say what has been learned so far, every few seconds
        if (Date.now() - shownAt > 3000) { shownAt = Date.now(); if (people.isShown()) people.refresh(); renderContactsRow(); }
      } : null });
    building = null;
    // The routine learn after a poll says nothing: a status would cover one the user is reading,
    // such as the confirmation of a send.
    if (first) status(`Contacts: ${(await contacts.count()).toLocaleString()} addresses${n ? ` (${n.toLocaleString()} message headers read)` : ""}`);
    if ((n || first) && people.isShown()) people.reload();
  } catch (e) { status(`Contacts: ${e.message}`); }
  finally { building = null; renderContactsRow(); }
}

// ---------- Settings › Contacts ----------
// How many contacts there are, or how far their build has come, and Rebuild, which reads the
// headers of all the mail again: minutes of requests, so it asks first and says how long, and is
// greyed out while a build is under way. Of what the user chose it keeps the pins and the names
// they gave (contacts.rebuild), and it lets the first build's own path do the rest, so a rebuild
// cut short carries on the next time.
const STEP_MS = 400;             // what a step of the build takes at the provider, besides its pause
async function renderContactsRow() {
  if ($("settings").classList.contains("hidden")) return;
  const [built, n] = await Promise.all([contacts.isBuilt().catch(() => true), contacts.count().catch(() => 0)]);
  const count = `${n.toLocaleString()} contact${n === 1 ? "" : "s"}`;
  $("ct-count").textContent = built ? `${count}, learned from your message headers.` : `Being built: ${buildProgress() || "about to start"}. ${count} so far.`;
  $("ct-rebuild").disabled = !built;
}
function rebuildTakes() {
  if (api.LIMITS.scanAfter) return ", a little at a time while you are not using the app";
  const page = api.LIMITS.scanPage || 100, t = buildTotals();
  const secs = [t.sent, t.inbox, t.rest].reduce((s, n) => s + Math.ceil(n / page), 0) * (STEP_MS + (api.LIMITS.scanGap || 0)) / 1000;
  return `, which takes ${secs < 90 ? "about a minute" : `about ${Math.round(secs / 60)} minutes`}`;
}
async function rebuildContacts() {
  if (!confirm(`Rebuild Contacts? The headers of all your mail are read again${rebuildTakes()}. Until that is done the list is incomplete. Only your pins and the names you gave are kept.`)) return;
  $("ct-rebuild").disabled = true;
  try {
    // a sync under way ends first, and none asked for meanwhile follows it: the rebuild reads all
    do { contactsAgain = false; await contactsRun?.catch(() => {}); } while (contactsRun);
    await contacts.rebuild();
  } catch (e) { handleError(e, "rebuild"); }
  renderContactsRow();
  syncContacts();
}

// ---------- Contacts to a file and from one ----------
// The sidebar's Contacts row has a menu of its own: Export writes every contact to a text file
// (contactsfile.js), and the two imports read one back. Import and merge takes what the file says
// and leaves the rest; Import and replace makes the list what the file says, taking out every
// contact that is not in it, so it asks first and refuses a file with a line it cannot read, which
// would take that line's contact out. Both can be undone as one step.
const IMPORT_MAX = 8 * 1048576;
async function exportContacts() {
  try {
    const rows = await contacts.all(), day = new Date();
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`, name = `baltazar-contacts-${date}.txt`;
    const text = contactsFile.format(rows, { account: $("account").textContent, date, eol: /win/i.test(navigator.platform) ? "\r\n" : "\n" });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })), download: name });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
    status(`exported ${rows.length.toLocaleString()} contact${rows.length === 1 ? "" : "s"} to ${name}`);
  } catch (e) { handleError(e, "export"); }
}
function importContacts(replace) {
  const pick = Object.assign(document.createElement("input"), { type: "file", accept: ".txt,text/plain" });
  pick.onchange = async () => {
    const file = pick.files[0]; if (!file) return;
    const named = noBidi(file.name);
    try {
      if (file.size > IMPORT_MAX) { notify(`${named} is too large to be a list of contacts.`, { info: true }); return; }
      const { entries, errors } = contactsFile.parse(await file.text());
      const unread = errors.length ? `${plural(errors.length, "line")} could not be read: ${errors.slice(0, 3).map(x => `line ${x.line}, ${x.why}`).join("; ")}${errors.length > 3 ? `; and ${errors.length - 3} more` : ""}.` : "";
      if (!entries.length) { notify(`No contacts were found in ${named}. ${unread}`.trim(), { info: true }); return; }
      if (replace && errors.length) { notify(`Contacts were not replaced, since a line that cannot be read would take its contact out: in ${named}, ${unread}`, { info: true }); return; }
      // a build under way would put back, one by one, what a replacement has just taken out
      if (replace && !(await contacts.isBuilt())) { notify("Contacts are still being built from your mail; replace them once that is done.", { info: true }); return; }
      if (replace && !confirm(`Replace Contacts with the ${plural(entries.length, "contact")} in ${named}? Every contact that is not in the file is removed; the mail brings one back when it names it again. Undo (z) puts the list back as it is now.`)) return;
      const opts = { replace };
      let done = await contacts.importList(entries, opts);
      const c = done.counts, said = [[c.removed, "removed"], [c.added, "added"], [c.renamed, "renamed"], [c.pinned, "pinned"], [c.unpinned, "unpinned"], [c.hidden, "hidden"], [c.shown, "unhidden"], [c.restored, "restored"]].filter(x => x[0]).map(x => `${x[0].toLocaleString()} ${x[1]}`).join(", ");
      if (done.changed) pushUndo({ label: `${replace ? "replace Contacts with" : "merge"} ${named}`, count: done.changed, undo: () => contacts.undoImport(done.undo), redo: async () => { done = await contacts.importList(entries, opts); } });
      const what = `${replace ? "replaced Contacts with" : "merged"} ${named}: ${said || "nothing to change, Contacts already say what it says"}`;
      if (errors.length) notify(`${what[0].toUpperCase()}${what.slice(1)}. ${unread}`, { info: true }); else status(what);
      if (people.isShown()) people.reload();
      renderContactsRow();
    } catch (e) { handleError(e, "import"); }
  };
  pick.click();
}
$("contacts-link").oncontextmenu = e => {
  e.preventDefault();
  openMenu(e.clientX, e.clientY, [["export", "Export...", "", "Write every contact to a text file, a contact a line"], null,
    ["merge", "Import and merge...", "", "Take the names, pins and hides a file says, and add its new addresses"],
    ["replace", "Import and replace...", "", "Make the list what a file says: contacts that are not in it are removed"]],
  a => a === "export" ? exportContacts() : importContacts(a === "replace"));
};

document.addEventListener("keydown", onKey);
macLabels();
document.title = APP;
$("brand").textContent = APP;
$("app-trademark").textContent = api.PROVIDER.trademark;
fillSignIn();
$("retry").onclick = () => api.setup ? pressSignIn() : api.signIn().then(start, start);
$("signin-trouble").onclick = () => {
  const help = $("signin-help"), show = help.classList.contains("hidden");
  if (show && signInView) drawHelp(help, signInView.help);
  help.classList.toggle("hidden", !show);
};
$("signin-reset").onclick = async () => {
  await api.setup.reset();
  await drawSignIn({ force: true });
  $("g-paste-in")?.focus();
};
$("fail-retry").onclick = () => start();
$("fail-copy").onclick = () => copyReport(startReport, $("fail-copy"));
$("folder-filter").oninput = () => { state.kbFolder = -1; renderFolders(); };
wireSettings();
wireSplitters();
window.addEventListener("resize", () => applyLayout());
wireMovePicker();
wireContactCards();
viewer.init({ thumb: api.thumbnail, bytes: api.partBytes, docPages: api.docPages, extractText: api.extractText, originalUrl: api.originalUrl, listed: api.isListed, attachedHtml, status, providerName: api.PROVIDER.name });
files.init(filesHooks);
people.init(peopleHooks);
$("contacts-link").onclick = () => openContacts();
// Ctrl+wheel over a contact's recent messages zooms them, not the tab.
$("person").addEventListener("wheel", e => { if (e.ctrlKey && e.target.closest?.(".p-recent")) { e.preventDefault(); zoomContact(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
$("toolbar").onclick = e => { const b = e.target.closest("button[data-act]"); if (b && !b.disabled) runAction(b.dataset.act); };
$("r-images").onclick = loadImages;
$("r-print").onclick = printMessages;
$("r-delete").onclick = () => { const id = state.openId; if (id) run(() => rowInTrash(rowsOrOpen([id])[0]) ? doUndelete(id) : doDelete([id])); };
$("r-dark").onclick = toggleReaderColours;
$("compose-btn").onclick = () => startCompose("new");
for (const b of document.querySelectorAll("[data-reply]")) b.onclick = () => startCompose(b.dataset.reply);
compose.init({
  status, notify, clearNotice, folderByType, settings: () => settings, zoom: messageScale, zoomMessage,
  saveSetting: (k, v) => { settings[k] = v; saveSettings(); },
  onClose: () => { hideReaderForCompose(false); $("list").focus(); if (folderType(state.byId.get(state.view.folderId)) === "DRAFT") loadList("refresh"); },
  // a discarded draft's rows go at once; the refresh on close ran before the delete
  onDiscarded: ids => { removeLocal(ids); if (folderType(state.byId.get(state.view.folderId)) === "DRAFT") loadList("refresh"); },
  scheduleSend,
});
$("more-btn").onclick = () => loadList("more");
$("search-scope").onclick = () => { scopeOff = !scopeOff; updateScopeChip(); $("search").focus(); };

// ---------- people in the search box ----------
// A name typed in the search box offers the people it could mean in a list under the box (the
// addresses suggested while writing, so none that is hidden). Nothing is highlighted until an
// arrow key moves there, so Enter still searches for what was typed. A pick puts the address in
// the word's place, after from: or to: where the word had one; a word that was all the box held
// shows all mail with the person at once. The last line opens Contacts filtered by the word.
const SUGGEST_MAX = 6;
let sgItems = [], sgSel = -1, sgSeq = 0, sgWord = null;
// What is being typed that could name a person, likeliest first: everything in the box when it is
// only plain words (a name in full), then the word the caret ends, with its from: or to: apart.
// Nothing when the caret is inside a word, or the word is an operator or another field's value.
function searchWords() {
  const box = $("search"), end = box.selectionStart ?? box.value.length;
  if (end !== box.selectionEnd || /^\S/.test(box.value.slice(end))) return [];
  const before = box.value.slice(0, end), all = before.trim(), out = [];
  if (!box.value.slice(end).trim() && /\s/.test(all) && !/[:()"]|(^|\s)(AND|OR|NOT|-\S*)(\s|$)/.test(all))
    out.push({ start: before.length - before.trimStart().length, end, field: "", text: all });
  const m = /(^|[\s(])((?:from|to):)?([^\s:()"-][^\s:()"]+)$/i.exec(before);
  if (m && !/^(AND|OR|NOT)$/.test(m[3])) out.push({ start: m.index + m[1].length, end, field: (m[2] || "").toLowerCase(), text: m[3] });
  return out;
}
const searchSuggestOpen = () => !$("search-suggest").classList.contains("hidden");
function hideSearchSuggest() { ++sgSeq; sgItems = []; sgSel = -1; $("search-suggest").classList.add("hidden"); }
async function suggestPeople() {
  const seq = ++sgSeq;
  let w = null, items = [];
  for (w of searchWords()) {
    items = await contacts.suggest(w.text, SUGGEST_MAX);
    if (seq !== sgSeq || document.activeElement !== $("search")) return;
    if (items.length) break;
  }
  if (!items.length) { hideSearchSuggest(); return; }
  toggleSearchHelp(false);
  sgItems = items; sgSel = -1; sgWord = w; sgSeq = seq;
  const pop = $("search-suggest"), box = $("search-box").getBoundingClientRect();
  pop.innerHTML = items.map((a, i) => `<div data-i="${i}" id="sg-${i}" role="option" title="${esc(w.field ? `${w.field}${a.email}` : `All mail with ${a.name || a.email}`)}"><span>${a.name ? `${esc(a.name)}<i>${esc(a.email)}</i>` : esc(a.email)}</span></div>`).join("") +
    `<div data-i="${items.length}" id="sg-${items.length}" class="sg-all" role="option" title="Open Contacts filtered by this word"><span>Contacts matching “${esc(w.text)}”...</span></div>`;
  pop.style.left = `${box.left}px`; pop.style.top = `${box.bottom + 2}px`; pop.style.width = `${box.width}px`;
  pop.classList.remove("hidden");
}
// Past either end of the list the highlight goes back to what was typed.
function moveSearchSuggest(d) {
  const n = sgItems.length + 1;
  sgSel = sgSel < 0 ? (d > 0 ? 0 : n - 1) : sgSel + d;
  if (sgSel >= n) sgSel = -1;
  $("search-suggest").querySelectorAll("div").forEach((el, i) => el.classList.toggle("kb", i === sgSel));
  if (sgSel >= 0) $("search").setAttribute("aria-activedescendant", `sg-${sgSel}`); else $("search").removeAttribute("aria-activedescendant");
}
function pickSearchSuggest(i) {
  const w = sgWord, a = sgItems[i], box = $("search");
  hideSearchSuggest();
  box.removeAttribute("aria-activedescendant");
  if (!w) return;
  if (!a) { openContacts({ filter: w.text }); return; }
  const rest = box.value.slice(w.end).replace(/^\s+/, "");
  if (!w.field && !box.value.slice(0, w.start).trim() && !rest) { searchPerson(a.email); return; }
  const head = box.value.slice(0, w.start) + w.field + a.email + " ";
  box.value = head + rest;
  box.focus(); box.setSelectionRange(head.length, head.length);
}
$("search").addEventListener("input", e => { if (!e.isComposing) suggestPeople(); });
$("search").addEventListener("blur", hideSearchSuggest);
$("search-suggest").onmousedown = e => {
  e.preventDefault();                                       // the box keeps the focus
  const d = e.target.closest("[data-i]"); if (d) pickSearchSuggest(Number(d.dataset.i));
};
window.addEventListener("resize", hideSearchSuggest);

// Search help: a popover under the search box; examples fill the box.
function toggleSearchHelp(show = $("search-help").classList.contains("hidden")) {
  const pop = $("search-help");
  if (show) hideSearchSuggest();
  pop.classList.toggle("hidden", !show);
  $("search-help-btn").classList.toggle("on", show);
  if (!show) return;
  const box = $("search-box").getBoundingClientRect();
  pop.style.top = `${box.bottom + 6}px`;
  pop.style.left = `${Math.max(12, Math.min(box.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 12))}px`;
}
$("search-help-btn").onmousedown = e => e.preventDefault();   // keep focus where it is
$("search-help-btn").onclick = () => toggleSearchHelp();
$("search-help").onclick = e => {
  const code = e.target.closest("td:first-child code");
  if (!code) return;
  $("search").value = code.textContent;
  $("search").focus();
};
document.addEventListener("mousedown", e => { if (!e.target.closest("#search-help, #search-help-btn, #search-box")) toggleSearchHelp(false); });
window.addEventListener("resize", () => { if (!$("search-help").classList.contains("hidden")) toggleSearchHelp(true); });
$("help").onclick = e => { if (e.target.id === "help") $("help").classList.add("hidden"); };
start();
