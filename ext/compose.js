import * as api from "./api.js";
import { sniffImage, dataUrl } from "./bytes.js";
import * as contacts from "./contacts.js";
import { inlineStyles } from "./quotestyle.js";
import { esc, noBidi } from "./text.js";
import * as symbols from "./symbols.js";

// Compose panel: new message, reply, reply all, forward, or editing a draft.
// Owns its DOM under #compose; talks to the rest of the app through the hooks given to init().

const $ = id => document.getElementById(id);
const fmt = a => a?.name ? `${a.name} <${a.email}>` : (a?.email || "");
const fmtList = l => (l || []).map(fmt).join(", ");

let hooks = null;          // { status, notify, clearNotice, folderByType, settings, saveSetting, onClose, onDiscarded(ids), scheduleSend }
// Composer problems share one notice, cleared once the message saves, sends or closes.
const warn = (text, err) => hooks.notify(text, { key: "compose", err, what: "compose" });
let saveError = null;      // the error of the last failed draft save, for the notice's report

// ---------- address field: chips plus autocomplete ----------
class AddrField {
  constructor(el, placeholder) {
    this.el = el; this.list = [];
    el.innerHTML = `<input autocomplete="off" spellcheck="false" placeholder="${esc(placeholder || "")}">`;
    this.input = el.querySelector("input");
    // The recent-addresses list opens only on an explicit click in the line; typing filters as usual.
    el.onclick = e => { if (e.target === el) { this.input.focus(); this.suggest(true); } };
    this.input.onclick = () => this.suggest(true);
    this.input.oninput = () => { dirty = true; if (this.input.value.trim()) this.suggest(); else hideSuggest(); };
    this.input.onkeydown = e => this.onKey(e);
    // the one list of suggestions is closed only if this field opened it
    this.input.onblur = () => setTimeout(() => { if (document.activeElement !== this.input) { this.commit(false); if (suggestField === this) hideSuggest(); } }, 150);
    this.input.onpaste = e => { const t = e.clipboardData.getData("text"); if (/[,;<\n]|\S\s+\S+@/.test(t.trim())) { e.preventDefault(); this.addText(t); } };
  }
  set(list) { this.list = (list || []).map(a => ({ name: a.name || "", email: a.email })); this.render(); }
  get() { this.commit(false); return this.list.slice(); }
  isEmpty() { return !this.list.length && !this.input.value.trim(); }
  focus() { this.input.focus(); }
  add(a) { if (!this.list.some(x => x.email.toLowerCase() === a.email.toLowerCase())) this.list.push(a); dirty = true; this.render(); }
  addText(t) { let parts; try { parts = parseAddrs(t); } catch (e) { warn(e.message); this.input.value = t; return; } for (const a of parts) this.add(a); this.input.value = ""; }
  commit(strict) {
    const v = this.input.value.trim(); if (!v) return true;
    try { for (const a of parseAddrs(v)) this.add(a); this.input.value = ""; return true; }
    catch (e) { if (strict) warn(e.message); return false; }
  }
  render() {
    for (const ch of [...this.el.querySelectorAll(".chip")]) ch.remove();
    for (const [i, a] of this.list.entries()) {
      const ch = document.createElement("span"); ch.className = "chip"; ch.title = noBidi(fmt(a));
      ch.innerHTML = `<span>${a.name ? `<b>${esc(a.name)}</b> <i>${esc(a.email)}</i>` : esc(a.email)}</span><a title="Remove">×</a>`;
      ch.querySelector("a").onclick = () => { this.list.splice(i, 1); dirty = true; this.render(); this.input.focus(); };
      this.el.insertBefore(ch, this.input);
    }
  }
  async suggest(clicked = false) {
    if (!clicked && !this.input.value.trim()) return;
    const seq = ++suggestSeq;
    const exclude = new Set(this.list.map(a => a.email.toLowerCase()));
    const items = await contacts.suggest(this.input.value, 8, exclude);
    if (seq !== suggestSeq || document.activeElement !== this.input) return;
    showSuggest(this, items);
  }
  onKey(e) {
    const sg = $("c-suggest"), open = !sg.classList.contains("hidden");
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); moveSuggest(e.key === "ArrowDown" ? 1 : -1); return; }
    // Esc closes the suggestions; with none open it goes on to close the composer
    if (e.key === "Escape") { if (!open) return; e.preventDefault(); e.stopPropagation(); hideSuggest(); return; }
    if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") {
      // Ctrl+Enter sends what was typed, never a suggestion
      const sending = e.key === "Enter" && (e.ctrlKey || e.metaKey);
      if (open && suggestSel >= 0 && !sending) { e.preventDefault(); this.add(suggestItems[suggestSel]); this.input.value = ""; hideSuggest(); return; }
      if (this.input.value.trim()) { if (e.key !== "Tab") e.preventDefault(); this.commit(true); hideSuggest(); return; }
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "Backspace" && !this.input.value && this.list.length) { this.list.pop(); dirty = true; this.render(); }
  }
}

let suggestField = null, suggestItems = [], suggestSel = -1, suggestSeq = 0;
// The first row is preselected, for Enter to take, only when it is what was typed or completes
// it; once a whole address is typed, only that address itself. Otherwise a key commits the text.
function preselect(typed, a) {
  const t = typed.trim().toLowerCase();
  return !!a && (a.email.toLowerCase() === t || (!ADDR.test(t) && contacts.completes(t, a)));
}
function showSuggest(field, items) {
  const sg = $("c-suggest");
  suggestField = field; suggestItems = items; suggestSel = preselect(field.input.value, items[0]) ? 0 : -1;
  if (!items.length) { hideSuggest(); return; }
  sg.innerHTML = items.map((a, i) => `<div data-i="${i}" class="${i === suggestSel ? "kb" : ""}"><span>${a.name ? `${esc(a.name)}<i>${esc(a.email)}</i>` : esc(a.email)}</span><a class="hide" data-hide="${i}" title="Hide this address: it is never suggested again, and Contacts lists it under Hidden">×</a></div>`).join("");
  const r = field.input.getBoundingClientRect();
  sg.style.left = Math.min(r.left, innerWidth - 300) + "px"; sg.style.top = (r.bottom + 2) + "px";
  sg.classList.remove("hidden");
  sg.onmousedown = async e => {
    e.preventDefault();
    // the row's own address, as the list was made of it
    const h = e.target.closest("[data-hide]"), which = h && items[Number(h.dataset.hide)]?.email;
    if (which) {
      await contacts.hide(which);
      const hid = (await contacts.lookup(which))?.hidden;
      hooks.status(hid ? `${which} is hidden (Contacts › Hidden unhides it)` : `${which} is pinned in Contacts, and a pinned address cannot be hidden`);
      field.input.focus(); field.suggest(true); return;
    }
    const d = e.target.closest("[data-i]"); if (!d) return;
    field.add(items[Number(d.dataset.i)]); field.input.value = ""; hideSuggest(); field.input.focus();
  };
}
function moveSuggest(d) {
  if (!suggestItems.length) return;
  suggestSel = suggestSel < 0 ? (d > 0 ? 0 : suggestItems.length - 1) : (suggestSel + d + suggestItems.length) % suggestItems.length;
  $("c-suggest").querySelectorAll("div").forEach((el, i) => el.classList.toggle("kb", i === suggestSel));
}
function hideSuggest() { ++suggestSeq; $("c-suggest").classList.add("hidden"); suggestSel = -1; }

const fields = {};
let accounts = [];
let draft = null;          // current compose state
let autosaveTimer = null;
let dirty = false;
let saving = null;         // the draft save in flight
// A file already stored with a saved draft: { messageId, partId }. Later draft saves refer to that
// part instead of uploading the file again; a send always uploads.
const stored = new WeakMap();

export function init(h) {
  hooks = h;
  fillFonts($("c-font"));
  const c = $("compose");
  fields.to = new AddrField($("c-to"), "name <address>, address");
  fields.cc = new AddrField($("c-cc"));
  fields.bcc = new AddrField($("c-bcc"));
  $("c-send").onclick = () => send();
  $("c-save").onclick = () => saveNow();
  $("c-discard").onclick = () => discard();
  $("c-attach").onclick = () => $("c-files").click();
  $("c-files").onchange = () => { addFiles([...$("c-files").files]); $("c-files").value = ""; };
  $("c-mode").onchange = () => switchMode($("c-mode").value);
  $("c-cc-toggle").onclick = () => { $("c-cc-row").classList.toggle("hidden"); $("c-bcc-row").classList.toggle("hidden"); };
  // The header's buttons (Send has Ctrl+Enter, Save draft Ctrl+S) and the formatting tools (Ctrl+B,
  // Ctrl+I, Ctrl+U) are for the mouse: Tab goes from the subject straight into the message.
  for (const el of $("compose").querySelectorAll("#c-head button, #c-head select, #c-toolbar button, #c-toolbar select, #c-toolbar input")) el.tabIndex = -1;
  for (const b of $("c-toolbar").querySelectorAll("button[data-cmd]")) { b.onmousedown = e => e.preventDefault(); b.onclick = e => { e.preventDefault(); format(b.dataset.cmd); }; }
  // Picked with the mouse, the caret goes back to the text; stepped through with the keys, the box
  // keeps focus so the next key steps again.
  for (const id of ["c-font", "c-size"]) {
    $(id).onmousedown = () => { saveRange(); byKeys = false; };
    $(id).onkeydown = () => { byKeys = true; };
    $(id).onfocus = () => saveRange();
  }
  const picked = (id, apply) => () => { restoreRange(); apply($(id).value); syncFontControls(); if (byKeys) { saveRange(); $(id).focus(); } };
  $("c-font").onchange = picked("c-font", v => exec("fontName", v));
  $("c-size").onchange = picked("c-size", v => setFontSize(Number(v)));
  document.addEventListener("selectionchange", () => { if (isOpen() && draft?.html && $("c-editor").contains(getSelection().anchorNode)) { syncFontControls(); syncToolStates(); } });
  for (const b of $("c-toolbar").querySelectorAll("button[data-pal]")) { b.onmousedown = e => e.preventDefault(); b.onclick = e => { e.preventDefault(); togglePalette(b); }; }
  document.addEventListener("mousedown", e => {
    if (!e.target.closest("#c-palette") && !e.target.closest("[data-pal]")) hidePalette();
    if (!e.target.closest("#c-symbols") && !e.target.closest('[data-cmd="symbol"]')) hideSymbols();
  });
  // A symbol goes in where the caret or selection was when the popup opened.
  $("c-symbols").onmousedown = e => e.preventDefault();
  $("c-symbols").onclick = e => {
    const b = e.target.closest("[data-s]"); if (!b) return;
    hideSymbols(); restoreRange(); exec("insertText", symbols.textStyle(b.dataset.s));
  };
  // A symbol pasted on its own anywhere in the composer joins the picker's own symbols.
  c.addEventListener("paste", e => { symbols.pasted(e.clipboardData?.getData("text/plain")); });
  $("c-imgfile").onchange = () => { insertImages([...$("c-imgfile").files]); $("c-imgfile").value = ""; };
  const ed = $("c-editor");
  ed.addEventListener("paste", e => {
    const imgs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
    if (imgs.length) { e.preventDefault(); insertImages(imgs); }
  });
  // Dropped on the editor: images go inline at the drop point, anything else is attached.
  ed.addEventListener("drop", e => {
    const all = [...(e.dataTransfer?.files || [])];
    if (!all.length) return;
    e.preventDefault(); e.stopPropagation(); c.classList.remove("drop");
    const imgs = all.filter(f => f.type.startsWith("image/")), rest = all.filter(f => !f.type.startsWith("image/"));
    if (imgs.length) { placeCaretAt(e.clientX, e.clientY); insertImages(imgs); }
    const n = rest.length ? addFiles(rest) : 0;
    if (n) hooks.status(`attached ${n} file${n === 1 ? "" : "s"}`);
  });
  initPictureTools(ed);
  // Enter inside the quoted original splits the quote, so what is typed next is the user's own
  // text between quoted parts, not more quoted text.
  ed.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const sel = getSelection(); if (!sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode, start = node.nodeType === 1 ? node : node.parentElement;
    // only a quoted original splits; an indent (also a blockquote) stays one block
    let bq = start?.closest(".ymq blockquote"); if (!bq || !ed.contains(bq)) return;
    for (let up = bq.parentElement?.closest(".ymq blockquote"); up && ed.contains(up); up = up.parentElement?.closest(".ymq blockquote")) bq = up;
    e.preventDefault();
    splitQuote(bq, sel);
    dirty = true;
  });
  c.addEventListener("input", () => { dirty = true; });
  c.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); c.classList.add("drop"); } });
  c.addEventListener("dragleave", () => c.classList.remove("drop"));
  c.addEventListener("wheel", e => { if (e.ctrlKey && e.target.closest("#c-body")) { e.preventDefault(); hooks.zoomMessage(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
  c.addEventListener("drop", e => { c.classList.remove("drop"); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });
  c.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
    // Esc closes a popup of the toolbar first, then the composer
    else if (e.key === "Escape") { e.preventDefault(); if (popupOpen()) { hidePalette(); hideSymbols(); } else close(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveNow(); }
    // the browser's zoom keys zoom the message being written, not the tab
    else if ((e.ctrlKey || e.metaKey) && ["=", "+", "-", "0"].includes(e.key)) { e.preventDefault(); hooks.zoomMessage(e.key === "0" ? 0 : e.key === "-" ? -1 : 1); }
    e.stopPropagation();
  });
}

export function addRecipient(a) { fields.to?.add(a); }

export function isOpen() { return !$("compose").classList.contains("hidden"); }
// Changes not yet in Drafts, which closing the tab would lose.
export function hasUnsaved() { return isOpen() && (dirty || !!saving) && hasContent(); }

async function loadAccounts() {
  if (accounts.length) return accounts;
  try { accounts = (await api.accounts()).accounts.filter(a => a.isSending || a.isPrimary || a.type === "ALIAS"); }
  catch (e) { warn(`Could not load your sending addresses: ${e.message}`, e); accounts = []; }
  const sel = $("c-from");
  sel.innerHTML = accounts.map(a => `<option value="${esc(a.email)}">${esc(a.sendingName ? `${a.sendingName} <${a.email}>` : a.email)}</option>`).join("");
  return accounts;
}

// ---------- draft formats ----------
// A draft opens in the format it was saved in, never in whatever the default is now (converting
// HTML to text would lose its formatting on the next save). This app records the format of each
// draft it saves under the draft's csid, which survives every save; for a draft saved elsewhere the
// message's own type and body tell. The record goes when the draft is sent or discarded.
const FORMATS_KEPT = 200;
async function formatRecords() { try { return (await chrome.storage.local.get("draftFormats")).draftFormats || {}; } catch { return {}; } }
async function recordFormat(csid, html) {
  if (!csid) return;
  const all = await formatRecords();
  delete all[csid]; all[csid] = html ? "html" : "text";
  const keys = Object.keys(all); for (const k of keys.slice(0, Math.max(0, keys.length - FORMATS_KEPT))) delete all[k];
  try { await chrome.storage.local.set({ draftFormats: all }); } catch { /* the format is then worked out from the draft */ }
}
async function forgetFormat(csid) {
  const all = await formatRecords();
  if (csid in all) { delete all[csid]; try { await chrome.storage.local.set({ draftFormats: all }); } catch { /* harmless */ } }
}
// true for HTML, false for plain text
async function draftIsHtml(message, body) {
  const rec = (await formatRecords())[message?.csid];
  if (rec) return rec === "html";
  const type = String(message?.headers?.mimeType || "").toLowerCase();
  if (type.startsWith("text/plain")) return false;
  if (body?.hasHtml === false) return false;
  if (!body?.html?.trim() && body?.text) return false;
  return true;
}

// ---------- open ----------
// opts: { mode: "new"|"reply"|"replyAll"|"forward"|"draft", message, body (from api.body), myEmail }
// Openings, of a new message and of one brought back unsent, run one at a time, and each first
// puts away (saving) the message already open: one brought back while another was loading is
// saved to Drafts, not overwritten. Answers whether the message opened.
let opening = Promise.resolve();
function oneAtATime(fn) {
  const run = opening.then(fn, fn);
  opening = run.catch(() => {});
  return run;
}
export function open(opts) { return oneAtATime(() => openNow(opts)); }
async function openNow(opts) {
  if (!(await close(true))) return false;
  await loadAccounts();
  const me = opts.myEmail;
  const primary = accounts.find(a => a.isPrimary) || accounts[0] || { email: me, sendingName: "" };
  const m = opts.message, h = m?.headers || {};
  // The original of a reply or forward, without the sender's style sheets: in the outgoing message
  // they would apply to all of it in the recipients' mail and could restyle or hide the user's own
  // text. What they give the original is in its elements instead (quotestyle.js).
  const original = ["reply", "replyAll", "forward"].includes(opts.mode) ? await inlineStyles(opts.body.html) : "";
  // images: whether the quoted message's remote images may load, as decided in the reader
  // quoteHtml and quoteText hold the original of a reply or forward until it goes into the editor
  draft = { csid: String(Date.now()), mode: "new", inReplyTo: null, files: [], refs: [], savedId: null, quoteHtml: "", quoteText: "", html: true, images: opts.images !== false };
  let to = [], cc = [], bcc = [], subject = "", bodyHtml = "", bodyText = null, html = hooks.settings().composeHtml !== false;
  const mine = new Set(accounts.map(a => a.email.toLowerCase()).concat([me.toLowerCase()]));
  // A message without a usable date is quoted without one, not as "Invalid Date".
  const sent = new Date(Number(h.date) * 1000), when = h.date && !isNaN(sent) ? sent.toLocaleString() : "";
  const quoteHeaderText = () => `${when ? `On ${when}, ` : ""}${fmt((h.from || [])[0])} wrote:`;
  const quoteHeader = () => esc(quoteHeaderText());
  switch (opts.mode) {
    case "reply":
    case "replyAll": {
      ({ to, cc } = replyRecipients(opts.mode, h, mine));
      subject = /^re:/i.test(h.subject || "") ? h.subject : `Re: ${h.subject || ""}`;
      draft.inReplyTo = { id: m.id, replied: true };
      draft.quoteHtml = `<div class="ymq"><div>${quoteHeader()}</div><blockquote style="border-left:1px solid #ccc;margin:0 0 0 .8em;padding-left:1em">${original}</blockquote></div>`;
      draft.quoteText = `${quoteHeaderText()}\n` + toText(opts.body.html).split("\n").map(l => "> " + l).join("\n");
      break;
    }
    case "forward": {
      subject = /^fwd?:/i.test(h.subject || "") ? h.subject : `Fwd: ${h.subject || ""}`;
      draft.inReplyTo = { id: m.id, forwarded: true };
      const hdr = `---------- Forwarded message ----------<br>From: ${esc(fmtList(h.from))}${when ? `<br>Date: ${when}` : ""}<br>Subject: ${esc(h.subject || "")}<br>To: ${esc(fmtList(h.to))}${h.cc?.length ? `<br>Cc: ${esc(fmtList(h.cc))}` : ""}<br><br>`;
      draft.quoteHtml = `<div class="ymq">${hdr}${original}</div>`;
      const hdrText = `---------- Forwarded message ----------\nFrom: ${fmtList(h.from)}${when ? `\nDate: ${when}` : ""}\nSubject: ${h.subject || ""}\nTo: ${fmtList(h.to)}${h.cc?.length ? `\nCc: ${fmtList(h.cc)}` : ""}\n\n`;
      draft.quoteText = hdrText + toText(opts.body.html);
      draft.refs = (opts.body.attachments || []).filter(a => a.disposition !== "inline" && a.partId)
        .map(a => ({ messageId: m.id, partId: a.partId, contentId: a.contentId, filename: a.filename || "Untitled", size: a.size || 0 }));
      break;
    }
    case "draft": {
      draft.csid = m.csid || draft.csid;
      draft.savedId = m.id;
      draft.openedFrom = m.id;      // the row it came from, which a later save replaces
      draft.files = withFiles([], opts.files || []);
      (opts.files || []).forEach((f, i) => { if (draft.files.includes(f) && opts.partIds?.[i]) stored.set(f, { messageId: m.id, partId: opts.partIds[i] }); });
      to = h.to || []; cc = h.cc || []; bcc = h.bcc || []; subject = h.subject || "";
      html = await draftIsHtml(m, opts.body);
      bodyHtml = opts.body.html || (opts.body.text ? textToHtml(opts.body.text) : "");
      bodyText = opts.body.text || toText(opts.body.html || "");
      if (api.isMessageId(m.inReplyTo?.messageReference?.id)) draft.inReplyTo = { id: m.inReplyTo.messageReference.id, replied: !!m.inReplyTo.replied, forwarded: !!m.inReplyTo.forwarded };
      break;
    }
  }
  draft.mode = opts.mode;
  $("c-title").textContent = { new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward", draft: "Draft" }[opts.mode];
  const fromAcct = accounts.find(a => (h.from?.[0]?.email || "").toLowerCase() === a.email.toLowerCase() && opts.mode === "draft") || primary;
  $("c-from").value = fromAcct.email;
  fields.to.set(to); fields.cc.set(cc); fields.bcc.set(bcc);
  // Cc and Bcc show and hide together, as their toggle does
  const copies = cc.length || bcc.length;
  $("c-cc-row").classList.toggle("hidden", !copies); $("c-bcc-row").classList.toggle("hidden", !copies);
  $("c-subject").value = subject;
  const sig = fromAcct.signatureActive && fromAcct.signature ? `<div><br></div><div><br></div><div class="ymsig">${fromAcct.signature}</div>` : "<div><br></div>";
  const sigText = fromAcct.signatureActive && fromAcct.signature ? "\n\n" + toText(fromAcct.signature) : "";
  setMode(html);
  applyDefaultFont();
  // A reply or forward has the original under the signature, in the editor, so it can be answered
  // inline. Like a reopened draft it is cleaned strictly; its remote images are held back when the
  // reader would not load them.
  const quote = draft.quoteHtml, quoteText = draft.quoteText;
  draft.quoteHtml = draft.quoteText = "";
  $("c-editor").innerHTML = editorSafe(bodyHtml || (quote ? `${sig}<div><br></div>${quote}` : sig), { images: draft.images });
  syncFontControls();
  $("c-text").value = bodyText != null ? bodyText : quoteText ? `${sigText}\n\n${quoteText}` : sigText;
  renderFiles();
  $("compose").classList.remove("hidden");
  dirty = false;
  startAutosave();
  if (opts.mode === "new") fields.to.focus(); else focusEditor();
  return true;
}

// Caret at the top of the editor (top-posting), never inside the signature.
function focusEditor() {
  const ed = draft.html ? $("c-editor") : $("c-text");
  ed.focus();
  if (!draft.html) { ed.setSelectionRange(0, 0); return; }
  const sel = getSelection(), range = document.createRange();
  const first = ed.firstChild || ed;
  range.setStart(first, 0); range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
}

// Closes the composer and returns true. With save, a message the user has changed goes to
// Drafts first; an untouched reply or empty new message is simply dropped. If the save fails,
// the composer stays open with the reason shown and close returns false, so nothing is lost.
export async function close(save = true) {
  if (!isOpen()) return true;
  if (save) await saved();   // a save in flight that fails marks the message changed again
  if (save && dirty && hasContent()) {
    const why = await saveNow(true);
    if (why) { warn(`The message was kept open because it could not be saved: ${why}. Discard closes it without saving.`, saveError); return false; }
    hooks.status("message saved to Drafts");
  }
  shut();
  return true;
}
// The composer hidden and emptied, its message let go.
function shut() {
  clearInterval(autosaveTimer);
  hideSuggest(); unpick();
  $("compose").classList.add("hidden"); $("c-editor").innerHTML = ""; $("c-text").value = ""; draft = null; dirty = false;
  hooks.clearNotice("compose");
  hooks.onClose();
}

// ---------- editor ----------
function defaultFont() {
  const st = hooks.settings();
  return { family: fontEntry(st.composeFont)?.[1] || st.composeFont || DEFAULT_FONT, size: Number(st.composeSize) || 13 };
}
function applyDefaultFont() {
  const f = defaultFont();
  $("c-editor").style.font = `${f.size}px/1.45 ${f.family}`;
  $("c-text").style.font = `${f.size}px/1.45 ${/courier|consolas|menlo|mono/i.test(f.family) ? f.family : "var(--mono)"}`;
  applyZoom();
}
// The message zoom scales the editor on screen only, text and the quoted message alike: what is
// sent keeps the chosen font size.
export function applyZoom() {
  const z = hooks.zoom();
  $("c-editor").style.zoom = z; $("c-text").style.zoom = z;
}

function setMode(html) {
  unpick(); hidePalette(); hideSymbols();
  draft.html = html;
  $("c-mode").value = html ? "html" : "text";
  $("c-editor").classList.toggle("hidden", !html);
  $("c-toolbar").classList.toggle("hidden", !html);
  $("c-text").classList.toggle("hidden", html);
}

function switchMode(v) {
  const html = v === "html";
  if (html === draft.html) return;
  if (!html && !confirm("Switch to plain text? Formatting in this message will be lost.")) { $("c-mode").value = "html"; return; }
  if (html) $("c-editor").innerHTML = textToHtml($("c-text").value); else $("c-text").value = toText($("c-editor").innerHTML);
  setMode(html); dirty = true;
  // a reopened draft keeps its own format; elsewhere the choice is also the default for new messages
  if (draft.mode !== "draft") hooks.saveSetting("composeHtml", html);
}

// ---------- font controls ----------
// The fonts offered, by the name shown, each with fallbacks for recipients who lack it: whatever
// font is picked goes into the sent message, which is read on other systems.
const FONTS = [
  ["Helvetica", "Helvetica Neue, Helvetica, Arial, sans-serif"],
  ["Arial", "Arial, Helvetica, sans-serif"],
  ["Segoe UI", "Segoe UI, -apple-system, Roboto, Helvetica Neue, Arial, sans-serif"],
  ["Verdana", "Verdana, Geneva, sans-serif"],
  ["Tahoma", "Tahoma, Verdana, Segoe UI, sans-serif"],
  ["Trebuchet MS", "Trebuchet MS, Helvetica, sans-serif"],
  ["Georgia", "Georgia, Times New Roman, Times, serif"],
  ["Times New Roman", "Times New Roman, Times, serif"],
  ["Garamond", "Garamond, Baskerville, Georgia, serif"],
  ["Courier New", "Courier New, Courier, monospace"],
  ["Consolas", "Consolas, Menlo, Monaco, Courier New, monospace"],
  ["Comic Sans MS", "Comic Sans MS, Comic Sans, cursive"],
];
export const DEFAULT_FONT = FONTS[0][1];
const firstFamily = v => String(v || "").split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
// The list entry for a saved or applied font: by its whole value, or by its first family (a font
// saved as a bare name, or one in a quoted message).
export function fontEntry(value) {
  const f = firstFamily(value);
  return FONTS.find(([, v]) => v === value) || FONTS.find(([n, v]) => firstFamily(v) === f || n.toLowerCase() === f) || null;
}
export function fillFonts(sel) { sel.replaceChildren(...FONTS.map(([n, v]) => new Option(n, v))); }
// The Font and Size boxes always show what applies at the caret (or selection start).
let fontRange = null, byKeys = false;
function saveRange() { const s = getSelection(); fontRange = s.rangeCount && $("c-editor").contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null; }
function restoreRange() { const ed = $("c-editor"); ed.focus(); if (fontRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(fontRange); } }

// A value not in the list is shown as an extra option: in numeric order for sizes, first for fonts.
function showValue(sel, value) {
  let opt = [...sel.options].find(o => o.value.toLowerCase() === String(value).toLowerCase());
  if (!opt) {
    sel.querySelectorAll("option[data-dyn]").forEach(o => o.remove());
    opt = new Option(value, value); opt.dataset.dyn = "1";
    const n = Number(value), after = Number.isFinite(n) ? [...sel.options].find(o => Number(o.value) > n) : sel.options[0];
    sel.add(opt, after || null);
  }
  sel.value = opt.value;
}

function syncFontControls() {
  const ed = $("c-editor");
  const s = getSelection();
  let node = s.rangeCount && ed.contains(s.anchorNode) ? s.anchorNode : ed;
  if (node.nodeType !== 1) node = node.parentElement;
  const cs = getComputedStyle(node);
  const entry = fontEntry(cs.fontFamily);
  const fontSel = $("c-font");
  if (entry) { fontSel.querySelectorAll("option[data-dyn]").forEach(o => o.remove()); fontSel.value = entry[1]; }
  else showValue(fontSel, cs.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, ""));
  showValue($("c-size"), String(Math.round(parseFloat(cs.fontSize))));
}

// execCommand only knows sizes 1-7: size 7 is applied to the selection and the elements it makes
// are rewritten to the real pixel size; <font size="7"> already in the message is left as it is.
// With only a caret there is nothing to rewrite yet, so an empty sized span takes the caret, holding
// a zero-width space that is dropped when the message is saved.
const CARET_HOLD = "\u200B";
function setFontSize(px) {
  const ed = $("c-editor"), sel = getSelection();
  if (!sel.rangeCount || !ed.contains(sel.anchorNode)) return;
  if (sel.isCollapsed) {
    const span = document.createElement("span");
    span.style.fontSize = px + "px";
    span.textContent = CARET_HOLD;
    const r = sel.getRangeAt(0);
    r.insertNode(span);
    r.setStart(span.firstChild, 1); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    dirty = true;
    return;
  }
  const before = new Set(ed.querySelectorAll('font[size="7"]'));
  document.execCommand("styleWithCSS", false, false);
  document.execCommand("fontSize", false, "7");
  const made = [];
  for (const f of ed.querySelectorAll('font[size="7"]')) {
    if (before.has(f)) continue;
    const span = document.createElement("span");
    span.style.fontSize = px + "px";
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
    made.push(span);
  }
  // the selection pointed into the replaced elements; select the resized text again, so the next
  // tool acts on it
  if (made.length) {
    const r = document.createRange();
    r.setStart(made[0], 0); r.setEnd(made[made.length - 1], made[made.length - 1].childNodes.length);
    sel.removeAllRanges(); sel.addRange(r);
  }
  dirty = true;
}

// ---------- colour palettes ----------
const FORE = ["#000000", "#444444", "#888888", "#c0392b", "#d35400", "#8e5a1b", "#7f8c00", "#1e8449", "#148f77", "#1f5fbf", "#1b2a6b", "#6c3483", "#b03a8c", "#e0459a", "#2e86c1", "#b7950b"];
const BACK = ["#ffff00", "#fff2a8", "#b6f2b6", "#b3ecf5", "#cfe2ff", "#e4d4f7", "#ffd1e8", "#ffd8a8"];
let savedRange = null;
function togglePalette(btn) {
  const pal = $("c-palette");
  if (!pal.classList.contains("hidden") && pal.dataset.kind === btn.dataset.pal) { hidePalette(); return; }
  const kind = btn.dataset.pal, fore = kind === "fore";
  const sel = getSelection(); savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  pal.dataset.kind = kind;
  pal.innerHTML = `<button class="pal-default" data-c="">${fore ? "Default colour" : "No highlight"}</button>` +
    (fore ? FORE : BACK).map(c => `<span class="sw" data-c="${c}" style="background:${c}" title="${c}"></span>`).join("");
  const r = btn.getBoundingClientRect();
  pal.style.left = Math.min(r.left, innerWidth - 240) + "px"; pal.style.top = (r.bottom + 2) + "px";
  pal.classList.remove("hidden");
  const apply = c => { hidePalette(); $("c-editor").focus(); if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
    if (fore && c) exec("foreColor", c); else if (fore) clearInline(["color"]); else if (c) exec("hiliteColor", c); else exec("hiliteColor", "transparent"); };
  pal.onclick = e => {
    const sw = e.target.closest("[data-c]"); if (sw) apply(sw.dataset.c);
  };
}
function hidePalette() { $("c-palette").classList.add("hidden"); }

// ---------- symbols ----------
// The fixed symbols, and under a line the user's own (symbols.js), each shown as it goes in.
async function toggleSymbols() {
  const pop = $("c-symbols");
  if (!pop.classList.contains("hidden")) { hideSymbols(); return; }
  saveRange();
  const own = await symbols.custom();
  const cell = (c, name = "") => `<button tabindex="-1" data-s="${esc(c)}"${name ? ` title="${esc(name)}"` : ""}>${esc(symbols.textStyle(c))}</button>`;
  pop.innerHTML = symbols.FIXED.map(([c, name]) => cell(c, name)).join("") +
    (own.length ? `<hr class="sym-line">${own.map(c => cell(c)).join("")}` : "");
  const r = $("c-toolbar").querySelector('[data-cmd="symbol"]').getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - 160) + "px"; pop.style.top = (r.bottom + 2) + "px";
  pop.classList.remove("hidden");
}
function hideSymbols() { $("c-symbols").classList.add("hidden"); }
const popupOpen = () => !$("c-palette").classList.contains("hidden") || !$("c-symbols").classList.contains("hidden");

// A command without a value gets none: insertHorizontalRule takes its value as the new rule's id.
function exec(cmd, arg) {
  const ed = $("c-editor"); ed.focus();
  document.execCommand("styleWithCSS", false, true);
  if (arg === undefined) document.execCommand(cmd, false); else document.execCommand(cmd, false, arg);
  dirty = true;
  syncToolStates();
}

// What a person types for a link: a web address with or without https://, or an email address.
// Returns the href, or null for anything else.
export function linkTarget(input) {
  const v = String(input || "").trim();
  if (/^(https?:\/\/|mailto:)\S+$/i.test(v)) return v;
  if (/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(v)) return `mailto:${v}`;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}([:/?#]\S*)?$/i.test(v)) return `https://${v}`;
  return null;
}
// The link button: with the caret in a link, its address is offered to change, and an empty one
// removes the link; otherwise the selection (or, with only a caret, the address itself) becomes one.
function insertLink() {
  const ed = $("c-editor"), sel = getSelection();
  const inside = sel.rangeCount && ed.contains(sel.anchorNode) ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest("a[href]") : null;
  const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const answer = prompt("Link address (web or email):", inside?.getAttribute("href") || "");
  if (answer === null) return;
  ed.focus();
  if (range) { sel.removeAllRanges(); sel.addRange(range); }
  if (inside && ed.contains(inside)) {
    if (!answer.trim()) { inside.replaceWith(...inside.childNodes); dirty = true; return; }
    const href = linkTarget(answer);
    if (!href) { hooks.status(`"${answer.trim().slice(0, 60)}" is not a web or mail address`); return; }
    inside.setAttribute("href", href); dirty = true; return;
  }
  if (!answer.trim()) return;
  const href = linkTarget(answer);
  if (!href) { hooks.status(`"${answer.trim().slice(0, 60)}" is not a web or mail address`); return; }
  exec("createLink", href);
}

// Whether the caret (or selection start) is inside an element matching selector, in the editor.
function caretIn(selector) {
  const ed = $("c-editor"), n = getSelection().anchorNode;
  const el = n && (n.nodeType === 1 ? n : n.parentElement);
  return !!(el && ed.contains(el) && el.closest(selector) && ed.contains(el.closest(selector)));
}
// The toolbar shows what applies at the caret: bold, italic, underline, strike, lists, preformatted.
const STATEFUL = ["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList"];
function syncToolStates() {
  for (const b of $("c-toolbar").querySelectorAll("button[data-cmd]")) {
    const cmd = b.dataset.cmd;
    let on = null;
    if (STATEFUL.includes(cmd)) { try { on = document.queryCommandState(cmd); } catch { on = false; } }
    else if (cmd === "code") on = caretIn("pre");
    if (on === null) continue;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
  }
}
// Removes inline formatting the browser's removeFormat leaves (styles written as span styles, and
// font sizes) from what is wholly selected; props limits it to those style properties.
function clearInline(props = null) {
  const ed = $("c-editor"), sel = getSelection();
  if (!sel.rangeCount || !ed.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  const whole = el => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let any = false;
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      if (!t.data.length) continue;
      if (!range.intersectsNode(t)) return false;
      if (t === range.startContainer && range.startOffset > 0) return false;
      if (t === range.endContainer && range.endOffset < t.length) return false;
      any = true;
    }
    return any;
  };
  const els = [...ed.querySelectorAll("span, font, b, strong, i, em, u, s, strike")].filter(el => range.intersectsNode(el) && whole(el));
  for (const el of els.reverse()) {
    if (props) {
      for (const p of props) el.style.removeProperty(p);
      if (props.includes("color")) el.removeAttribute("color");
      if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
      if (el.attributes.length || !/^(SPAN|FONT)$/.test(el.tagName)) continue;   // still styled, or bold and the like
    }
    el.replaceWith(...el.childNodes);
  }
  dirty = true;
  syncToolStates(); syncFontControls();
}

function format(cmd) {
  if (cmd === "link") { insertLink(); return; }
  if (cmd === "code") { exec("formatBlock", caretIn("pre") ? "div" : "pre"); return; }
  if (cmd === "removeFormat") { exec("removeFormat"); clearInline(); return; }
  if (cmd === "image") { $("c-imgfile").click(); return; }
  if (cmd === "symbol") { toggleSymbols(); return; }
  exec(cmd);
}

// Splits blockquote bq at the caret: the part after the caret becomes a second quote, with an
// empty line of the user's own between them that takes the caret. Empty halves are dropped.
function splitQuote(bq, sel) {
  const r = sel.getRangeAt(0).cloneRange();
  r.setEndAfter(bq.lastChild || bq);
  const rest = r.extractContents();
  const line = document.createElement("div");
  line.appendChild(document.createElement("br"));
  const second = bq.cloneNode(false);
  second.appendChild(rest);
  bq.after(line);
  if (second.textContent.trim() || second.querySelector("img")) line.after(second);
  if (!bq.textContent.trim() && !bq.querySelector("img")) bq.remove();
  const c = document.createRange();
  c.setStart(line, 0); c.collapse(true);
  sel.removeAllRanges(); sel.addRange(c);
}

// Images pasted, dropped or picked are placed at the caret as data: URLs; on save/send they
// become inline attachments referenced by cid:.
function placeCaretAt(x, y) {
  const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
}

// A picture goes into the text only in a format that mail shows there (sniffImage); one in any
// other, such as SVG, AVIF, TIFF or HEIC, could not travel in the text, so it is attached.
async function insertImages(files) {
  const ed = $("c-editor"); ed.focus();
  const other = [];
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { warn(`${f.name} is larger than 10 MB to place in the text; attach it instead.`); continue; }
    if (carried() + f.size > api.LIMITS.messageBytes) { warn(`Not placed: ${f.name}. A message carries at most ${MB()} MB of attachments and pictures.`); continue; }
    if (!sniffImage(new Uint8Array(await f.slice(0, 12).arrayBuffer()))) { other.push(f); continue; }
    const img = document.createElement("img");
    img.src = await dataUrl(f); img.alt = f.name; img.dataset.name = f.name || `pasted-${Date.now()}.png`;
    const sel = getSelection();
    if (sel.rangeCount && ed.contains(sel.anchorNode)) { const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(img); r.setStartAfter(img); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    else ed.appendChild(img);
  }
  dirty = true;
  const n = other.length ? addFiles(other) : 0;
  if (n) hooks.status(`attached ${other.map(f => f.name).join(", ")}: a picture of that kind cannot be shown in the text of a message`);
}

// ---------- pictures in the message ----------
// A picture clicked in the editor gets a frame with a corner handle that drags its size, and a bar
// below it with preset widths, its size in the message and Delete. The tools sit beside the
// editor in its scrolled box, outside the editable area, so they move with the text and never go
// out with the message. A size is a width in the message; the picture itself goes whole, unless
// the scaledImages setting asks for it to be sent at that size (sentSize).
const MIN_PICTURE = 24;
let picked = null, pictureWatch = null;

function initPictureTools(ed) {
  const bar = $("c-imgbar"), handle = $("c-imghandle");
  pictureWatch = new ResizeObserver(() => placePictureTools());
  pictureWatch.observe(ed);
  ed.addEventListener("click", e => { if (e.target.tagName === "IMG" && ed.contains(e.target)) pick(e.target); else unpick(); });
  ed.addEventListener("input", () => unpick());
  // Delete and Backspace remove the picture, Escape lets it go (the composer stays open), and any
  // other key goes to the text.
  ed.addEventListener("keydown", e => {
    if (!picked || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removePicked(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); unpick(); }
    else unpick();
  });
  // for the mouse, like the toolbar: the caret stays in the text
  for (const el of [...bar.querySelectorAll("button"), handle]) { el.tabIndex = -1; el.addEventListener("mousedown", e => e.preventDefault()); }
  bar.onclick = e => {
    const b = e.target.closest("button"); if (!b || !picked) return;
    if (b.id === "c-imgdel") removePicked(); else setWidth(picked, Number(b.dataset.w));
  };
  // Dragging keeps the picture no wider than itself, nor than the block it sits in shows it.
  handle.onpointerdown = e => {
    if (!picked || e.button !== 0) return;
    e.preventDefault();
    const img = picked, zoom = Number(ed.style.zoom) || 1, x0 = e.clientX;
    const start = img.getBoundingClientRect().width / zoom;
    let box = img.parentElement;
    while (box !== ed && getComputedStyle(box).display.startsWith("inline")) box = box.parentElement;
    const bs = getComputedStyle(box), room = box.getBoundingClientRect().width / zoom - parseFloat(bs.paddingLeft) - parseFloat(bs.paddingRight);
    const max = Math.min(img.naturalWidth, Math.floor(room));
    handle.setPointerCapture(e.pointerId);
    handle.onpointermove = m => setWidth(img, Math.min(max, Math.max(MIN_PICTURE, start + (m.clientX - x0) / zoom)));
    handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = handle.onpointerup = handle.onpointercancel = null; };
  };
}

function pick(img) {
  if (picked !== img) { unpick(); picked = img; pictureWatch.observe(img); }
  $("c-imgframe").classList.remove("hidden"); $("c-imgbar").classList.remove("hidden");
  placePictureTools();
}
function unpick() {
  if (picked) pictureWatch?.unobserve(picked);
  picked = null;
  $("c-imgframe").classList.add("hidden"); $("c-imgbar").classList.add("hidden");
}

// The frame over the picked picture and the bar under it, in the scrolled box's own coordinates.
// A picture with no size of its own (held back, or broken) can only be deleted.
function placePictureTools() {
  if (!picked) return;
  const ed = $("c-editor"), body = $("c-body"), frame = $("c-imgframe"), bar = $("c-imgbar");
  if (!picked.isConnected || !ed.contains(picked)) { unpick(); return; }
  const r = picked.getBoundingClientRect(), b = body.getBoundingClientRect();
  const left = r.left - b.left + body.scrollLeft, top = r.top - b.top + body.scrollTop;
  Object.assign(frame.style, { left: `${left}px`, top: `${top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const nw = picked.naturalWidth, nh = picked.naturalHeight, shown = shownWidth(picked);
  $("c-imghandle").classList.toggle("hidden", !nw);
  for (const btn of bar.querySelectorAll("button[data-w]")) {
    const w = Number(btn.dataset.w);
    btn.classList.toggle("hidden", !nw);
    btn.disabled = w > 0 && w >= nw;
    btn.classList.toggle("on", w ? shown === w : shown == null);
  }
  const w = shown ?? nw;
  $("c-imgsize").textContent = nw ? `${w} × ${Math.max(1, Math.round(nh * w / nw))}` : "";
  bar.style.left = `${Math.max(0, Math.min(left, body.scrollLeft + body.clientWidth - bar.offsetWidth - 4))}px`;
  bar.style.top = `${top + r.height + 6}px`;
}

// The width a picture is given in the message, in pixels, or null when it has none of its own.
// A width in the style wins over the attribute, as it does when the message is shown.
function shownWidth(img) {
  const s = img.style.width, a = img.getAttribute("width")?.trim() || "";
  const px = s ? (/^\d+(\.\d+)?px$/.test(s) ? parseFloat(s) : null) : /^\d+$/.test(a) ? Number(a) : null;
  return px ? Math.round(px) : null;
}

// Sets the width the picture is shown at, in the style and, for mail programs that read only
// those, in the width and height attributes; no width, or one not smaller than the picture's own,
// gives the picture its own size.
function setWidth(img, w) {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw) return;
  w = Math.round(w);
  if (!w || w >= nw) {
    img.style.removeProperty("width"); img.style.removeProperty("height");
    img.removeAttribute("width"); img.removeAttribute("height");
    if (!img.getAttribute("style")?.trim()) img.removeAttribute("style");
  } else {
    w = Math.max(MIN_PICTURE, w);
    img.style.width = `${w}px`; img.style.height = "auto";
    img.setAttribute("width", String(w)); img.setAttribute("height", String(Math.max(1, Math.round(nh * w / nw))));
  }
  dirty = true;
  placePictureTools();
}

// Through the editor's own delete, so Ctrl+Z brings the picture back.
function removePicked() {
  const img = picked; if (!img) return;
  unpick();
  const ed = $("c-editor"), sel = getSelection(), r = document.createRange();
  ed.focus();
  r.selectNode(img); sel.removeAllRanges(); sel.addRange(r);
  document.execCommand("delete", false);
  if (ed.contains(img)) img.remove();
  dirty = true;
}

// The size a picture of nw × nh pixels is sent at when it is shown `shown` pixels wide: twice that
// width, which stays sharp on high-density screens, never more than its own. null: sent whole.
export function sentSize(nw, nh, shown) {
  if (!(nw > 0 && nh > 0 && shown > 0)) return null;
  const w = Math.min(nw, Math.round(2 * shown));
  return w < nw ? { w, h: Math.max(1, Math.round(nh * w / nw)) } : null;
}

// The formats a smaller picture is written in, by the picture's own; a GIF is not re-encoded, as
// that would lose its animation.
const SHRINK_TO = { "image/jpeg": "image/jpeg", "image/webp": "image/webp", "image/png": "image/png", "image/bmp": "image/png" };
// A picture of the message's own (a data: URL) re-encoded at its sentSize, as a data: URL, or null
// when it goes as it is. The new one carries none of the photo's metadata, location included.
function shrunk(img) {
  const src = img.getAttribute("src") || "", type = SHRINK_TO[src.match(/^data:([^;,]*)/i)?.[1].toLowerCase()];
  if (!type || !img.complete) return null;
  const size = sentSize(img.naturalWidth, img.naturalHeight, shownWidth(img)); if (!size) return null;
  const c = document.createElement("canvas"); c.width = size.w; c.height = size.h;
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, size.w, size.h);
  const out = type === "image/png" ? c.toDataURL(type) : c.toDataURL(type, 0.85);
  return out.length < src.length ? out : null;
}
// The editor's HTML for sending; with shrink, each picture shown smaller goes at that size. The
// editor keeps the whole pictures, for a send that is undone.
function editorHtml(shrink) {
  const ed = $("c-editor");
  if (!shrink) return ed.innerHTML;
  const smaller = new Map();
  ed.querySelectorAll("img").forEach((img, i) => { const src = shrunk(img); if (src) { img.dataset.shrunk = String(i); smaller.set(String(i), src); } });
  if (!smaller.size) return ed.innerHTML;
  const tpl = document.createElement("template");
  tpl.innerHTML = ed.innerHTML;
  for (const img of ed.querySelectorAll("img[data-shrunk]")) img.removeAttribute("data-shrunk");
  for (const img of tpl.content.querySelectorAll("img[data-shrunk]")) { img.setAttribute("src", smaller.get(img.dataset.shrunk)); img.removeAttribute("data-shrunk"); }
  return tpl.innerHTML;
}

// Returns { html, inline } with data: images replaced by cid: references and their bytes as Files.
// A data: URL's bytes and their image format, or null. Only real images, typed by their bytes,
// travel as inline parts: a quoted message can carry data: URLs of any type, which would go out
// as attachments of the sender's choosing, and ones that do not decode.
function dataImage(src) {
  try {
    const m = src.match(/^data:([^;,]*)(;base64)?,(.*)$/s); if (!m) return null;
    const bytes = m[2] ? Uint8Array.from(atob(m[3].replace(/\s/g, "")), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    const mime = sniffImage(bytes);
    return mime ? { bytes, mime } : null;
  } catch { return null; }
}

function extractInline(html, taken) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  releaseImages(doc.body);
  const inline = [];
  let n = 0;
  // An image still referring to a part of the quoted message (one that could not be inlined)
  // could not load for recipients, and may show them the mailbox's own addresses.
  for (const img of doc.querySelectorAll("img[src]")) if (api.isStrayImage(img.getAttribute("src"))) img.remove();
  for (const img of doc.querySelectorAll("img[src^='data:']")) {
    const { bytes, mime } = dataImage(img.getAttribute("src")) || {};
    if (!mime) { img.remove(); continue; }
    const ext = mime.split("/")[1].replace("jpeg", "jpg");
    let name; do name = `inline-${++n}.${ext}`; while (taken.has(name));
    const contentId = `${Date.now()}-${n}@baltazar-mail`;
    inline.push({ file: new File([bytes], name, { type: mime }), contentId });
    img.setAttribute("src", `cid:${contentId}`);
    img.removeAttribute("class"); img.removeAttribute("data-name");
  }
  return { html: doc.body.innerHTML, inline };
}

// The editor lives in the app's own page, so HTML put into it (a reopened draft, which can hold a
// quoted message, or a signature) is cleaned more strictly than in the reader: no style sheets,
// and no ids, names or classes that could collide with the app's own, apart from the quote and
// signature markers.
const KEEP_CLASSES = new Set(["ymq", "ymsig"]);
// Attributes that make a picture load; held back (renamed) while the reader's rule says no images.
// A srcset is a list of addresses, any of which may be the one loaded, so it is always held. The
// attributes read as CSS, style and SVG's painting and clipping ones, are held when they name an
// address.
const CSS_ATTRS = ["style", "fill", "stroke", "mask", "clip-path", "filter", "marker-start", "marker-mid", "marker-end", "cursor"];
const IMAGE_ATTRS = ["src", "srcset", "poster", "background", "href", "xlink:href", ...CSS_ATTRS];
const HELD = "data-held-";
function holdImages(root) {
  for (const el of root.querySelectorAll("*")) {
    for (const a of IMAGE_ATTRS) {
      const v = el.getAttribute(a); if (v == null) continue;
      const loads = CSS_ATTRS.includes(a) ? /url\(|image-set\(|\\/i.test(v)
        : a === "srcset" ? true
        : a === "href" || a === "xlink:href" ? el.namespaceURI === "http://www.w3.org/2000/svg" && el.localName !== "a"
        : !/^(data:|cid:)/i.test(v.trim());
      if (loads) { el.setAttribute(HELD + a.replace(":", "-"), v); el.removeAttribute(a); }
    }
  }
}
// The attributes held back, put back for saving and sending.
function releaseImages(root) {
  for (const el of root.querySelectorAll("*")) for (const a of IMAGE_ATTRS) {
    const k = HELD + a.replace(":", "-"), v = el.getAttribute(k);
    if (v != null) { el.setAttribute(a, v); el.removeAttribute(k); }
  }
}

function editorSafe(html, { images = true } = {}) {
  const frag = globalThis.DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ["style", "link", "meta", "form", "input", "button", "textarea", "select", "option"], FORBID_ATTR: ["id", "name", "ping"] });
  for (const el of frag.querySelectorAll("[class]")) {
    const keep = [...el.classList].filter(c => KEEP_CLASSES.has(c));
    if (keep.length) el.className = keep.join(" "); else el.removeAttribute("class");
  }
  // data: images that are not real images are dropped here, so the editor shows what is sent.
  for (const img of frag.querySelectorAll("img[src^='data:']")) if (!dataImage(img.getAttribute("src"))) img.remove();
  // Inline styles stay, but nothing may be lifted out of the editor over the app (a sender's box
  // positioned over the whole window, in a quote saved with a reply draft).
  for (const el of frag.querySelectorAll("[style]")) {
    for (const p of ["position", "z-index", "inset", "top", "right", "bottom", "left"]) el.style.removeProperty(p);
    if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
  }
  if (!images) holdImages(frag);
  const box = document.createElement("div");
  box.appendChild(frag);
  return box.innerHTML;
}

// Plain text of an HTML message: links keep their address, list items their bullet or number,
// table cells a tab between them, and a quoted message "> " before each of its lines, as plain-text
// mail quotes, nested quotes nested. The HTML source's own line breaks and indentation are not
// text, outside pre.
function toText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script").forEach(e => e.remove());
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement?.closest("pre")) n.data = n.data.replace(/\s+/g, " ");
  for (const q of [...doc.querySelectorAll("blockquote")].filter(q => !q.parentElement?.closest("blockquote")))
    q.replaceWith(doc.createTextNode(`\n${toText(q.innerHTML).split("\n").map(l => l ? `> ${l}` : ">").join("\n")}\n`));
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href").trim(), text = a.textContent.trim();
    if (/^https?:\/\//i.test(href) && text && text !== href && text !== href.replace(/\/$/, "")) a.append(` <${href}>`);
  }
  for (const li of doc.querySelectorAll("li")) {
    const ol = li.parentElement?.tagName === "OL";
    li.prepend(ol ? `${[...li.parentElement.children].filter(c => c.tagName === "LI").indexOf(li) + 1}. ` : "• ");
  }
  for (const td of doc.querySelectorAll("td, th")) if (td.nextElementSibling) td.append("\t");
  doc.querySelectorAll("br").forEach(e => e.replaceWith("\n"));
  doc.querySelectorAll("p, div, tr, li, h1, h2, h3, h4, blockquote, pre").forEach(e => e.append("\n"));
  return doc.body.textContent.replace(/ +\n/g, "\n").replace(/\n (?! )/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function textToHtml(t) { return esc(t).replace(/\n/g, "<br>"); }

// ---------- attachments ----------
// Uploaded files travel as form fields named after them and the message refers to them by that
// name, so each must be unique: a second "scan.pdf" becomes "scan (2).pdf".
function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) if (!taken.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
}
const sameFile = (a, b) => a.name === b.name && a.size === b.size;
function withFiles(list, files) {
  for (const f of files) {
    if (list.some(x => sameFile(x, f))) continue;   // the same file again
    const name = uniqueName(f.name, new Set(list.map(x => x.name)));
    list.push(name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified }));
  }
  return list;
}
// Files that would take the message over the provider's size limit are left out, with a notice.
// A file already attached is not added again, so it counts once. Returns how many were attached.
// What a message carries, as its limit (api.LIMITS.messageBytes) counts it: the files attached,
// the attachments forwarded and the pictures in its text (a data: URL holds three bytes in four
// characters).
const MB = () => Math.round(api.LIMITS.messageBytes / 1048576);
function carried() {
  const pictures = draft.html ? [...$("c-editor").querySelectorAll('img[src^="data:"]')].reduce((s, i) => s + Math.floor(i.getAttribute("src").length * 3 / 4), 0) : 0;
  return draft.files.reduce((s, f) => s + f.size, 0) + draft.refs.reduce((s, r) => s + (r.size || 0), 0) + pictures;
}
function addFiles(files) {
  const have = carried();
  const fits = [], over = [];
  let used = have;
  for (const f of files) {
    if (draft.files.some(x => sameFile(x, f)) || fits.some(x => sameFile(x, f))) continue;
    if (used + f.size <= api.LIMITS.messageBytes) { fits.push(f); used += f.size; } else over.push(f);
  }
  if (over.length) warn(`Not attached: ${over.map(f => f.name).join(", ")}. Attachments are limited to ${Math.round(api.LIMITS.messageBytes / 1048576)} MB per message.`);
  if (!fits.length) return 0;
  withFiles(draft.files, fits);
  dirty = true; renderFiles();
  return fits.length;
}
function renderFiles() {
  const el = $("c-filelist");
  const kb = n => `${Math.max(1, Math.round(n / 1024))} KB`;
  el.innerHTML = draft.refs.map((r, i) => `<span class="c-file" title="Forwarded from the original message">↪ ${esc(r.filename)} <i>${kb(r.size)}</i> <a href="#" data-ref="${i}" title="Remove" tabindex="-1">×</a></span>`).join("") +
    draft.files.map((f, i) => `<span class="c-file">${esc(f.name)} <i>${kb(f.size)}</i> <a href="#" data-i="${i}" title="Remove" tabindex="-1">×</a></span>`).join("");
  // The row sits under Subject and shows only while something is attached.
  $("c-attached-row").classList.toggle("hidden", !draft.refs.length && !draft.files.length);
  el.onclick = e => {
    const a = e.target.closest("a[data-i], a[data-ref]"); if (!a) return;
    e.preventDefault();
    if (a.dataset.ref != null) draft.refs.splice(Number(a.dataset.ref), 1); else draft.files.splice(Number(a.dataset.i), 1);
    dirty = true; renderFiles();
  };
}

// ---------- addresses ----------
// Commas, semicolons and line breaks separate addresses except inside a quoted name or <...>, and
// so does white space between bare addresses. A mailto: link gives its address, without its query.
const ADDR = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
function splitAddrs(s) {
  const out = []; let cur = "", q = false, angle = false;
  for (const ch of s) {
    if (ch === '"' && !angle) q = !q;
    else if (ch === "<" && !q) angle = true;
    else if (ch === ">" && !q) angle = false;
    if ((ch === "," || ch === ";" || ch === "\n" || ch === "\r") && !q && !angle) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
export function parseAddrs(s) {
  const out = [];
  const parts = splitAddrs(String(s || "")).flatMap(part => /[<"]/.test(part) || !/\S\s+\S/.test(part.trim()) ? [part] : part.trim().split(/\s+/));
  for (const part of parts) {
    const p = part.trim(); if (!p) continue;
    const m = p.match(/^(?:"([^"]*)"|([^"<]*?))\s*<([^>]+)>$/);
    const email = (m ? m[3] : p).trim().replace(/^mailto:([^?]*).*$/is, (x, a) => { try { return decodeURIComponent(a); } catch { return a; } });
    if (!ADDR.test(email)) throw new Error(`Not an address: ${p}`);
    const name = (m?.[1] ?? m?.[2] ?? "").trim();
    out.push(name ? { name, email } : { email });
  }
  return out;
}

// To and Cc for a reply. A reply to one's own sent message goes to its recipients; each address
// appears once, and one's own addresses are left out of reply all.
export function replyRecipients(mode, h, mine) {
  const key = a => (a?.email || "").toLowerCase();
  const isMine = a => mine.has(key(a));
  const notMe = l => (l || []).filter(a => !isMine(a));
  const fromMe = !!h.from?.length && h.from.every(isMine);
  let to = fromMe ? (h.to || []) : (h.replyTo?.length ? h.replyTo : h.from || []), cc = [];
  if (mode === "replyAll") { if (fromMe) cc = notMe(h.cc); else { to = to.concat(notMe(h.to)); cc = notMe(h.cc); } }
  const seen = new Set();
  const once = l => l.filter(a => key(a) && !seen.has(key(a)) && seen.add(key(a)));
  to = once(to); cc = once(cc);
  return { to, cc };
}

// A picture is content, though it adds nothing to the text.
function hasContent() {
  const editor = $("c-editor");
  return !!(!fields.to.isEmpty() || $("c-subject").value.trim() || (draft.html ? editor.innerText.trim() || editor.querySelector("img") : $("c-text").value.trim()) || draft.files.length || draft.refs.length);
}

function strictGet(f) { if (!f.commit(true)) throw new Error(`Not an address: ${f.input.value.trim()}`); return f.get(); }
// An address still being typed in To, Cc or Bcc, which the autosave leaves alone.
const typingAddress = () => ["to", "cc", "bcc"].some(k => !!fields[k].input.value.trim());
// Saves the message every 30 s while it has changes.
function startAutosave() {
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => { if (dirty && hasContent()) saveNow(true, { tick: true }); }, 30000);
}

// The message as it will be saved or sent. With upload (a send), every file is uploaded; otherwise files already stored with the draft go as references to their parts.
// With chipsOnly (the autosave), the recipients are the chips, and an address being typed is left as it is.
function collect(upload = false, { chipsOnly = false } = {}) {
  const who = f => chipsOnly ? f.list.slice() : strictGet(f);
  const acct = accounts.find(a => a.email === $("c-from").value) || accounts[0];
  const from = { name: acct?.sendingName || "", email: acct?.email || $("c-from").value };
  const d = {
    csid: draft.csid, from, replyTo: acct?.replyToAddress ? { email: acct.replyToAddress } : from,
    to: who(fields.to), cc: who(fields.cc), bcc: who(fields.bcc),
    subject: $("c-subject").value.trim(), inReplyTo: draft.inReplyTo, files: draft.files, refs: draft.refs,
    ownRefs: false, draftFolderId: hooks.folderByType("DRAFT")?.id,
  };
  if (!upload && draft.files.some(f => stored.has(f))) {
    d.files = draft.files.filter(f => !stored.has(f));
    d.refs = d.refs.concat(draft.files.filter(f => stored.has(f)).map(f => ({ ...stored.get(f), filename: f.name, size: f.size })));
    d.ownRefs = true;
  }
  if (draft.html) {
    // Images in the quoted original travel as new inline parts too, so recipients see them.
    const f = defaultFont();
    // A draft keeps whole pictures, so one made smaller can still be made larger when reopened.
    const shrink = upload && hooks.settings().scaledImages === "shrink";
    const { html, inline } = extractInline(`<div style="font-family:${f.family};font-size:${f.size}px">${editorHtml(shrink).replaceAll(CARET_HOLD, "")}</div>`, new Set(draft.files.map(x => x.name)));
    d.html = html;
    d.inline = inline;
  } else d.text = $("c-text").value;
  return d;
}

// ---------- save / send ----------
// Saves the message to Drafts. Returns "" when saved, otherwise the reason it was not, which is
// also shown, except during a silent save (autosave, closing). The autosave (tick) saves the
// recipients already made chips and leaves an address being typed alone; the message then stays
// changed, so a later save, or closing, takes the address once it is whole.
// Saves run one at a time, each for the message it started on: one that ends after the message
// was sent, discarded or replaced by another touches only its own message's state.
async function saveNow(silent = false, { tick = false } = {}) {
  if (!draft) return "no message";
  const mine = draft;
  if (saving) await saving.catch(() => {});
  if (draft !== mine) return "";
  saveError = null;
  let d;
  try { d = collect(false, { chipsOnly: tick }); } catch (e) { if (!silent) warn(e.message); return e.message; }
  if (!d.draftFolderId) { warn("There is no Drafts folder to save the message in."); return "no Drafts folder"; }
  dirty = tick && typingAddress();   // edits made while the save is in flight mark the message again
  // References to parts of the previous save that the provider refuses or drops: saved again, uploading
  const p = api.saveDraft(d).catch(e => { if (!d.ownRefs) throw e; return { partial: true }; })
    .then(r => r.partial && d.ownRefs ? (forgetStored(mine), api.saveDraft({ ...d, ...uploadAll(mine) })) : r);
  saving = p;
  try {
    const r = await p;
    mine.savedId = r.message?.id || mine.savedId;
    // the provider may give the draft its own lasting id on the first save (Gmail's draft id)
    mine.csid = r.message?.csid || mine.csid;
    remember(mine, r.message);
    recordFormat(mine.csid, d.html != null);
    if (draft === mine) { hooks.clearNotice("compose"); hooks.status("draft saved", r.ms); }
    return "";
  } catch (e) {
    if (draft !== mine) return "";
    dirty = true;
    saveError = e; warn(`The draft could not be saved: ${e.message}`, e); return `draft save failed: ${e.message}`;
  } finally { if (saving === p) saving = null; }
}
function forgetStored(mine) { for (const f of mine.files) stored.delete(f); }
// Every file uploaded again, with only the references to other messages' parts.
function uploadAll(mine) { return { files: mine.files, refs: mine.refs, ownRefs: false }; }
// Notes which part of the saved draft holds each file (names are unique within a message).
function remember(mine, message) {
  if (!message?.id) return;
  const parts = new Map((message.attachments || []).filter(a => a.disposition !== "inline" && a.partId && a.filename).map(a => [a.filename, a.partId]));
  for (const f of mine.files) { const pid = parts.get(f.name); if (pid) stored.set(f, { messageId: message.id, partId: pid }); else stored.delete(f); }
}
// Settles once no save is in flight.
const saved = async () => { while (saving) await saving.catch(() => {}); };

async function send() {
  if (!draft) return;
  let d;
  try { d = collect(true); } catch (e) { warn(`Not sent: ${e.message}`); return; }
  if (!d.to.length && !d.cc.length && !d.bcc.length) { warn("Not sent: the message has no recipients."); fields.to.focus(); return; }
  if (carried() > api.LIMITS.messageBytes) { warn(`Not sent: the message carries more than ${MB()} MB of attachments and pictures. Remove some first.`); return; }
  if (!d.subject && !confirm("Send without a subject?")) return;
  const sentId = hooks.folderByType("SENT")?.id;
  if (!sentId || !d.draftFolderId) { warn("Not sent: the Sent or Drafts folder was not found."); return; }
  const mine = draft;
  const snapshot = { ...draft, d, editorHtml: draft.html ? $("c-editor").innerHTML : null, ownText: draft.html ? null : $("c-text").value };
  // A save still in flight may give the message its lasting csid and saved id (Gmail's first save
  // creates the draft); the send and a composer reopened after a cancel take them once it settles.
  const settle = async () => { await saved(); d.csid = snapshot.csid = mine.csid; snapshot.savedId = mine.savedId; };
  shut();
  hooks.scheduleSend({
    label: `send "${d.subject || "(no subject)"}" to ${[...d.to, ...d.cc, ...d.bcc].map(a => a.email).join(", ")}`,
    run: async () => { await settle(); const r = await api.send(d, sentId).catch(e => { if (e.savedId) mine.savedId = snapshot.savedId = e.savedId; throw e; }); forgetFormat(d.csid); contacts.noteSent([...d.to, ...d.cc, ...d.bcc]).catch(() => {}); return r; },
    restore: async () => { await settle(); return oneAtATime(() => reopenFrom(snapshot)); },
  });
}

// Puts an unsent message (send cancelled or failed) back in the composer. A message already open
// there is saved first; if it cannot be, the unsent one goes to Drafts instead, so neither is lost.
async function reopenFrom(snap) {
  if (!(await close(true))) {
    try {
      await api.saveDraft(snap.d);
      warn(`"${snap.d.subject || "(no subject)"}" was not sent; it was saved to Drafts because another message is open.`);
    } catch (e) { warn(`"${snap.d.subject || "(no subject)"}" was not sent and could not be saved: ${e.message}`, e); }
    return;
  }
  await loadAccounts();
  draft = { csid: snap.csid, mode: snap.mode, inReplyTo: snap.inReplyTo, files: snap.files, refs: snap.refs, savedId: snap.savedId, html: snap.html, images: snap.images };
  $("c-title").textContent = "Message not sent";
  $("c-from").value = snap.d.from.email;
  fields.to.set(snap.d.to); fields.cc.set(snap.d.cc); fields.bcc.set(snap.d.bcc);
  const copies = snap.d.cc.length || snap.d.bcc.length;
  $("c-cc-row").classList.toggle("hidden", !copies); $("c-bcc-row").classList.toggle("hidden", !copies);
  $("c-subject").value = snap.d.subject;
  setMode(snap.html);
  applyDefaultFont();
  if (snap.html) $("c-editor").innerHTML = editorSafe(snap.editorHtml || "");
  else $("c-text").value = snap.ownText ?? "";
  renderFiles();
  $("compose").classList.remove("hidden");
  dirty = true;
  startAutosave();
  focusEditor();
}

async function discard() {
  if (!draft) return;
  if (hasContent() && !confirm("Discard this message?")) return;
  const mine = draft;
  close(false);
  await saved();
  const id = mine.savedId;
  if (!id) return;
  try {
    await api.deleteForever([id]);
    forgetFormat(mine.csid);
    hooks.status("draft discarded");
    hooks.onDiscarded([...new Set([id, mine.openedFrom].filter(Boolean))]);
  } catch (e) { warn(`The saved draft could not be deleted: ${e.message}`, e); }
}
