import * as api from "./api.js";
import * as contacts from "./contacts.js";

// Compose panel: new message, reply, reply all, forward, or editing a draft.
// Owns its DOM under #compose; talks to the rest of the app through the hooks given to init().

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = a => a?.name ? `${a.name} <${a.email}>` : (a?.email || "");
const fmtList = l => (l || []).map(fmt).join(", ");

let hooks = null;          // { status, folderByType, settings, onClose, onSent, scheduleSend }

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
    this.input.onblur = () => setTimeout(() => { if (document.activeElement !== this.input) { this.commit(false); hideSuggest(); } }, 150);
    this.input.onpaste = e => { const t = e.clipboardData.getData("text"); if (/[,;<]/.test(t)) { e.preventDefault(); this.addText(t); } };
  }
  set(list) { this.list = (list || []).map(a => ({ name: a.name || "", email: a.email })); this.render(); }
  get() { this.commit(false); return this.list.slice(); }
  text() { return this.list.map(fmt).join(", ") + (this.input.value.trim() ? (this.list.length ? ", " : "") + this.input.value.trim() : ""); }
  isEmpty() { return !this.list.length && !this.input.value.trim(); }
  focus() { this.input.focus(); }
  add(a) { if (!this.list.some(x => x.email.toLowerCase() === a.email.toLowerCase())) this.list.push(a); dirty = true; this.render(); }
  addText(t) { let parts; try { parts = parseAddrs(t); } catch (e) { hooks.status(e.message); this.input.value = t; return; } for (const a of parts) this.add(a); this.input.value = ""; }
  commit(strict) {
    const v = this.input.value.trim(); if (!v) return true;
    try { for (const a of parseAddrs(v)) this.add(a); this.input.value = ""; return true; }
    catch (e) { if (strict) hooks.status(e.message); return false; }
  }
  render() {
    for (const ch of [...this.el.querySelectorAll(".chip")]) ch.remove();
    for (const [i, a] of this.list.entries()) {
      const ch = document.createElement("span"); ch.className = "chip"; ch.title = fmt(a);
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
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideSuggest(); return; }
    if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") {
      if (open && suggestSel >= 0) { e.preventDefault(); this.add(suggestItems[suggestSel]); this.input.value = ""; hideSuggest(); return; }
      if (this.input.value.trim()) { if (e.key !== "Tab") e.preventDefault(); this.commit(true); hideSuggest(); return; }
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "Backspace" && !this.input.value && this.list.length) { this.list.pop(); dirty = true; this.render(); }
  }
}

let suggestField = null, suggestItems = [], suggestSel = -1, suggestSeq = 0;
function showSuggest(field, items) {
  const sg = $("c-suggest");
  suggestField = field; suggestItems = items; suggestSel = items.length ? 0 : -1;
  if (!items.length) { hideSuggest(); return; }
  sg.innerHTML = items.map((a, i) => `<div data-i="${i}" class="${i === suggestSel ? "kb" : ""}"><span>${a.name ? `${esc(a.name)}<i>${esc(a.email)}</i>` : esc(a.email)}</span><a class="hide" data-hide="${esc(a.email)}" title="Never suggest this address">×</a></div>`).join("");
  const r = field.input.getBoundingClientRect();
  sg.style.left = Math.min(r.left, innerWidth - 300) + "px"; sg.style.top = (r.bottom + 2) + "px";
  sg.classList.remove("hidden");
  sg.onmousedown = async e => {
    e.preventDefault();
    const h = e.target.closest("[data-hide]");
    if (h) { await contacts.hide(h.dataset.hide); hooks.status(`${h.dataset.hide} will not be suggested again (restore in settings)`); field.input.focus(); field.suggest(true); return; }
    const d = e.target.closest("[data-i]"); if (!d) return;
    field.add(items[Number(d.dataset.i)]); field.input.value = ""; hideSuggest(); field.input.focus();
  };
}
function moveSuggest(d) {
  if (!suggestItems.length) return;
  suggestSel = (suggestSel + d + suggestItems.length) % suggestItems.length;
  $("c-suggest").querySelectorAll("div").forEach((el, i) => el.classList.toggle("kb", i === suggestSel));
}
function hideSuggest() { ++suggestSeq; $("c-suggest").classList.add("hidden"); suggestSel = -1; }

const fields = {};
let accounts = [];
let draft = null;          // current compose state
let autosaveTimer = null;
let dirty = false;

export function init(h) {
  hooks = h;
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
  $("c-quote-toggle").onclick = () => toggleQuote();
  $("c-cc-toggle").onclick = () => { $("c-cc-row").classList.toggle("hidden"); $("c-bcc-row").classList.toggle("hidden"); };
  for (const b of $("c-toolbar").querySelectorAll("button[data-cmd]")) { b.onmousedown = e => e.preventDefault(); b.onclick = e => { e.preventDefault(); format(b.dataset.cmd); }; }
  $("c-font").onmousedown = $("c-size").onmousedown = () => saveRange();
  $("c-font").onchange = () => { restoreRange(); exec("fontName", $("c-font").value); syncFontControls(); };
  $("c-size").onchange = () => { restoreRange(); setFontSize(Number($("c-size").value)); syncFontControls(); };
  document.addEventListener("selectionchange", () => { if (isOpen() && draft?.html && $("c-editor").contains(getSelection().anchorNode)) syncFontControls(); });
  for (const b of $("c-toolbar").querySelectorAll("button[data-pal]")) { b.onmousedown = e => e.preventDefault(); b.onclick = e => { e.preventDefault(); togglePalette(b); }; }
  document.addEventListener("mousedown", e => { if (!e.target.closest("#c-palette") && !e.target.closest("[data-pal]")) hidePalette(); });
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
    if (rest.length) { addFiles(rest); hooks.status(`attached ${rest.length} file${rest.length === 1 ? "" : "s"}`); }
  });
  ed.addEventListener("click", e => { ed.querySelectorAll("img.sel").forEach(i => i.classList.remove("sel")); if (e.target.tagName === "IMG") e.target.classList.add("sel"); });
  ed.addEventListener("keydown", e => { const sel = ed.querySelector("img.sel"); if (sel && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); sel.remove(); dirty = true; } });
  c.addEventListener("input", () => { dirty = true; });
  c.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); c.classList.add("drop"); } });
  c.addEventListener("dragleave", () => c.classList.remove("drop"));
  c.addEventListener("drop", e => { c.classList.remove("drop"); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });
  c.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveNow(); }
    e.stopPropagation();
  });
}

export function addRecipient(a) { fields.to?.add(a); }

export function isOpen() { return !$("compose").classList.contains("hidden"); }

async function loadAccounts() {
  if (accounts.length) return accounts;
  try { accounts = (await api.accounts()).accounts.filter(a => a.isSending || a.isPrimary || a.type === "ALIAS"); }
  catch (e) { hooks.status(`accounts: ${e.message}`); accounts = []; }
  const sel = $("c-from");
  sel.innerHTML = accounts.map(a => `<option value="${esc(a.email)}">${esc(a.sendingName ? `${a.sendingName} <${a.email}>` : a.email)}</option>`).join("");
  return accounts;
}

// ---------- open ----------
// opts: { mode: "new"|"reply"|"replyAll"|"forward"|"draft", message, body (from api.body), myEmail }
export async function open(opts) {
  await loadAccounts();
  const me = opts.myEmail;
  const primary = accounts.find(a => a.isPrimary) || accounts[0] || { email: me, sendingName: "" };
  const m = opts.message, h = m?.headers || {};
  draft = { csid: String(Date.now()), mode: "new", inReplyTo: null, files: [], refs: [], savedId: null, quoteHtml: "", quoteText: "", html: true };
  let to = [], cc = [], subject = "", bodyHtml = "";
  const mine = new Set(accounts.map(a => a.email.toLowerCase()).concat([me.toLowerCase()]));
  const notMe = l => (l || []).filter(a => !mine.has((a.email || "").toLowerCase()));
  const quoteHeader = () => `On ${new Date(Number(h.date) * 1000).toLocaleString()}, ${esc(fmt((h.from || [])[0]))} wrote:`;
  switch (opts.mode) {
    case "reply":
    case "replyAll": {
      const replyTo = h.replyTo?.length ? h.replyTo : h.from;
      to = replyTo || [];
      if (opts.mode === "replyAll") { to = to.concat(notMe(h.to)); cc = notMe(h.cc); }
      subject = /^re:/i.test(h.subject || "") ? h.subject : `Re: ${h.subject || ""}`;
      draft.inReplyTo = { id: m.id, replied: true };
      draft.quoteHtml = `<div class="ymq"><div>${quoteHeader()}</div><blockquote style="border-left:1px solid #ccc;margin:0 0 0 .8em;padding-left:1em">${opts.body.html}</blockquote></div>`;
      draft.quoteText = `${quoteHeader().replace(/&lt;/g, "<").replace(/&gt;/g, ">")}\n` + toText(opts.body.html).split("\n").map(l => "> " + l).join("\n");
      break;
    }
    case "forward": {
      subject = /^fwd?:/i.test(h.subject || "") ? h.subject : `Fwd: ${h.subject || ""}`;
      draft.inReplyTo = { id: m.id, forwarded: true };
      const hdr = `---------- Forwarded message ----------<br>From: ${esc(fmtList(h.from))}<br>Date: ${new Date(Number(h.date) * 1000).toLocaleString()}<br>Subject: ${esc(h.subject || "")}<br>To: ${esc(fmtList(h.to))}${h.cc?.length ? `<br>Cc: ${esc(fmtList(h.cc))}` : ""}<br><br>`;
      draft.quoteHtml = `<div class="ymq">${hdr}${opts.body.html}</div>`;
      draft.quoteText = hdr.replace(/<br>/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") + toText(opts.body.html);
      draft.refs = (opts.body.attachments || []).filter(a => a.disposition !== "inline" && a.partId)
        .map(a => ({ messageId: m.id, partId: a.partId, contentId: a.contentId, filename: a.filename || "Untitled", size: a.size || 0 }));
      break;
    }
    case "draft": {
      draft.csid = m.csid || draft.csid;
      draft.savedId = m.id;
      to = h.to || []; cc = h.cc || []; subject = h.subject || "";
      bodyHtml = opts.body.html || "";
      if (m.inReplyTo?.messageReference?.id) draft.inReplyTo = { id: m.inReplyTo.messageReference.id, replied: !!m.inReplyTo.replied, forwarded: !!m.inReplyTo.forwarded };
      break;
    }
  }
  draft.mode = opts.mode;
  $("c-title").textContent = { new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward", draft: "Draft" }[opts.mode];
  const fromAcct = accounts.find(a => (h.from?.[0]?.email || "").toLowerCase() === a.email.toLowerCase() && opts.mode === "draft") || primary;
  $("c-from").value = fromAcct.email;
  fields.to.set(to); fields.cc.set(cc); fields.bcc.set([]);
  $("c-cc-row").classList.toggle("hidden", !cc.length); $("c-bcc-row").classList.add("hidden");
  $("c-subject").value = subject;
  const sig = fromAcct.signatureActive && fromAcct.signature ? `<div><br></div><div><br></div><div class="ymsig">${fromAcct.signature}</div>` : "<div><br></div>";
  setMode(hooks.settings().composeHtml !== false);
  applyDefaultFont();
  $("c-editor").innerHTML = bodyHtml || sig;
  syncFontControls();
  $("c-text").value = bodyHtml ? toText(bodyHtml) : (fromAcct.signatureActive && fromAcct.signature ? "\n\n" + toText(fromAcct.signature) : "");
  renderQuote(false);
  renderFiles();
  $("compose").classList.remove("hidden");
  dirty = false;
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => { if (dirty && hasContent()) saveNow(true); }, 30000);
  if (opts.mode === "new") fields.to.focus(); else focusEditor();
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

// Closes the composer. With save, a message the user has changed goes to Drafts first;
// an untouched reply or empty new message is simply dropped.
export async function close(save = true) {
  if (!isOpen()) return;
  clearInterval(autosaveTimer);
  hideSuggest();
  if (save && dirty && hasContent()) { await saveNow(true); hooks.status("message saved to Drafts"); }
  $("compose").classList.add("hidden"); $("c-editor").innerHTML = ""; $("c-text").value = ""; draft = null;
  hooks.onClose();
}

// ---------- editor ----------
function defaultFont() {
  const st = hooks.settings();
  return { family: st.composeFont || "Helvetica Neue, Helvetica, Arial, sans-serif", size: Number(st.composeSize) || 13 };
}
function applyDefaultFont() {
  const f = defaultFont();
  $("c-editor").style.font = `${f.size}px/1.45 ${f.family}`;
  $("c-text").style.font = `${f.size}px/1.45 ${/courier|consolas|mono/i.test(f.family) ? f.family : "Consolas, 'Courier New', monospace"}`;
}

function setMode(html) {
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
  hooks.saveSetting("composeHtml", html);
}

// ---------- font controls ----------
// The Font and Size boxes always show what applies at the caret (or selection start).
let fontRange = null;
function saveRange() { const s = getSelection(); fontRange = s.rangeCount && $("c-editor").contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null; }
function restoreRange() { const ed = $("c-editor"); ed.focus(); if (fontRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(fontRange); } }

function showValue(sel, value) {
  let opt = [...sel.options].find(o => o.value.toLowerCase() === String(value).toLowerCase());
  if (!opt) { sel.querySelectorAll("option[data-dyn]").forEach(o => o.remove()); opt = new Option(value, value); opt.dataset.dyn = "1"; sel.add(opt, 0); }
  sel.value = opt.value;
}

export function syncFontControls() {
  const ed = $("c-editor");
  const s = getSelection();
  let node = s.rangeCount && ed.contains(s.anchorNode) ? s.anchorNode : ed;
  if (node.nodeType !== 1) node = node.parentElement;
  const cs = getComputedStyle(node);
  const families = cs.fontFamily.split(",").map(f => f.trim().replace(/^["']|["']$/g, ""));
  const fontSel = $("c-font");
  const known = families.find(f => [...fontSel.options].some(o => !o.dataset.dyn && o.value.toLowerCase() === f.toLowerCase()));
  showValue(fontSel, known || families[0] || "");
  showValue($("c-size"), String(Math.round(parseFloat(cs.fontSize))));
}

// execCommand only knows sizes 1-7; apply size 7 and rewrite those elements to the real pixel size.
function setFontSize(px) {
  document.execCommand("styleWithCSS", false, false);
  document.execCommand("fontSize", false, "7");
  for (const f of $("c-editor").querySelectorAll('font[size="7"]')) {
    const span = document.createElement("span");
    span.style.fontSize = px + "px";
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
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
  pal.innerHTML = `<button class="pal-default" data-c="${fore ? "#000000" : ""}">${fore ? "Default (black)" : "No highlight"}</button>` +
    (fore ? FORE : BACK).map(c => `<span class="sw" data-c="${c}" style="background:${c}" title="${c}"></span>`).join("");
  const r = btn.getBoundingClientRect();
  pal.style.left = Math.min(r.left, innerWidth - 240) + "px"; pal.style.top = (r.bottom + 2) + "px";
  pal.classList.remove("hidden");
  const apply = c => { hidePalette(); $("c-editor").focus(); if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
    if (fore) exec("foreColor", c || "#000000"); else if (c) exec("hiliteColor", c); else exec("hiliteColor", "transparent"); };
  pal.onclick = e => {
    const sw = e.target.closest("[data-c]"); if (sw) apply(sw.dataset.c);
  };
}
function hidePalette() { $("c-palette").classList.add("hidden"); }

function exec(cmd, arg = null) {
  const ed = $("c-editor"); ed.focus();
  document.execCommand("styleWithCSS", false, true);
  document.execCommand(cmd, false, arg);
  dirty = true;
}

function format(cmd) {
  if (cmd === "link") { const url = prompt("Link URL:"); if (url && /^https?:\/\//i.test(url)) exec("createLink", url); return; }
  if (cmd === "code") { exec("formatBlock", "pre"); return; }
  if (cmd === "image") { $("c-imgfile").click(); return; }
  exec(cmd);
}

// Images pasted, dropped or picked are placed at the caret as data: URLs; on save/send they
// become inline attachments referenced by cid:.
function placeCaretAt(x, y) {
  const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
}

async function insertImages(files) {
  const ed = $("c-editor"); ed.focus();
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { hooks.status(`${f.name}: larger than 10 MB, attach it instead`); continue; }
    const dataUrl = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(f); });
    const img = document.createElement("img");
    img.src = dataUrl; img.alt = f.name; img.dataset.name = f.name || `pasted-${Date.now()}.png`;
    const sel = getSelection();
    if (sel.rangeCount && ed.contains(sel.anchorNode)) { const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(img); r.setStartAfter(img); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    else ed.appendChild(img);
  }
  dirty = true;
}

// Returns { html, inline } with data: images replaced by cid: references and their bytes as Files.
function extractInline(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const inline = [];
  let n = 0;
  for (const img of doc.querySelectorAll("img[src^='data:']")) {
    const m = img.getAttribute("src").match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) { img.remove(); continue; }
    const mime = m[1] || "image/png";
    const bytes = m[2] ? Uint8Array.from(atob(m[3]), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    const ext = (mime.split("/")[1] || "png").replace("jpeg", "jpg");
    const name = `inline-${++n}.${ext}`;
    const contentId = `${Date.now()}-${n}@baltazar-mail`;
    inline.push({ file: new File([bytes], name, { type: mime }), contentId });
    img.setAttribute("src", `cid:${contentId}`);
    img.removeAttribute("class"); img.removeAttribute("data-name");
  }
  return { html: doc.body.innerHTML, inline };
}

function renderQuote(expanded) {
  const has = !!draft.quoteHtml;
  $("c-quote-wrap").classList.toggle("hidden", !has);
  if (!has) return;
  $("c-quote").innerHTML = draft.html ? draft.quoteHtml : `<pre>${esc(draft.quoteText)}</pre>`;
  $("c-quote").classList.toggle("hidden", !expanded);
  $("c-quote-toggle").textContent = expanded ? "Hide quoted text" : "Show quoted text";
}
function toggleQuote() { renderQuote($("c-quote").classList.contains("hidden")); }

function toText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script").forEach(e => e.remove());
  doc.querySelectorAll("br").forEach(e => e.replaceWith("\n"));
  doc.querySelectorAll("p, div, tr, li, h1, h2, h3, h4, blockquote, pre").forEach(e => e.append("\n"));
  return doc.body.textContent.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function textToHtml(t) { return esc(t).replace(/\n/g, "<br>"); }

// ---------- attachments ----------
function addFiles(files) {
  for (const f of files) if (!draft.files.some(x => x.name === f.name && x.size === f.size)) draft.files.push(f);
  dirty = true; renderFiles();
}
function renderFiles() {
  const el = $("c-filelist");
  const kb = n => `${Math.max(1, Math.round(n / 1024))} KB`;
  el.innerHTML = (draft.refs || []).map((r, i) => `<span class="c-file" title="Forwarded from the original message">↪ ${esc(r.filename)} <i>${kb(r.size)}</i> <a href="#" data-ref="${i}" title="Remove">×</a></span>`).join("") +
    draft.files.map((f, i) => `<span class="c-file">${esc(f.name)} <i>${kb(f.size)}</i> <a href="#" data-i="${i}" title="Remove">×</a></span>`).join("");
  el.onclick = e => {
    const a = e.target.closest("a[data-i], a[data-ref]"); if (!a) return;
    e.preventDefault();
    if (a.dataset.ref != null) draft.refs.splice(Number(a.dataset.ref), 1); else draft.files.splice(Number(a.dataset.i), 1);
    dirty = true; renderFiles();
  };
}

// ---------- addresses ----------
export function parseAddrs(s) {
  const out = [];
  for (const part of String(s || "").split(/[,;]+/)) {
    const p = part.trim(); if (!p) continue;
    const m = p.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
    const email = (m ? m[2] : p).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Not an address: ${p}`);
    out.push(m && m[1]?.trim() ? { name: m[1].trim(), email } : { email });
  }
  return out;
}

function hasContent() {
  return !!(!fields.to.isEmpty() || $("c-subject").value.trim() || (draft.html ? $("c-editor").innerText.trim() : $("c-text").value.trim()) || draft.files.length || draft.refs?.length);
}

function strictGet(f) { if (!f.commit(true)) throw new Error(`Not an address: ${f.input.value.trim()}`); return f.get(); }

function collect() {
  const acct = accounts.find(a => a.email === $("c-from").value) || accounts[0];
  const from = { name: acct?.sendingName || "", email: acct?.email || $("c-from").value };
  const d = {
    csid: draft.csid, from, replyTo: acct?.replyToAddress ? { email: acct.replyToAddress } : from,
    to: strictGet(fields.to), cc: strictGet(fields.cc), bcc: strictGet(fields.bcc),
    subject: $("c-subject").value.trim(), inReplyTo: draft.inReplyTo, files: draft.files, refs: draft.refs || [],
    draftFolderId: hooks.folderByType("DRAFT")?.id,
  };
  if (draft.html) {
    // Images in the quoted original travel as new inline parts too, so recipients see them.
    const f = defaultFont();
    const { html, inline } = extractInline(`<div style="font-family:${f.family};font-size:${f.size}px">${$("c-editor").innerHTML}</div>` + (draft.quoteHtml ? `<br>${draft.quoteHtml}` : ""));
    d.html = html;
    d.inline = inline;
  } else d.text = $("c-text").value + (draft.quoteText ? `\n\n${draft.quoteText}` : "");
  return d;
}

// ---------- save / send ----------
async function saveNow(silent = false) {
  if (!draft) return;
  let d;
  try { d = collect(); } catch (e) { if (!silent) hooks.status(e.message); return; }
  if (!d.draftFolderId) { hooks.status("no Drafts folder"); return; }
  try {
    const r = await api.saveDraft(d);
    draft.savedId = r.message?.id || draft.savedId;
    dirty = false;
    hooks.status(`draft saved${silent ? "" : ""}`, r.ms);
  } catch (e) { hooks.status(`draft save failed: ${e.message}`); }
}

async function send() {
  if (!draft) return;
  let d;
  try { d = collect(); } catch (e) { hooks.status(e.message); return; }
  if (!d.to.length && !d.cc.length && !d.bcc.length) { hooks.status("no recipients"); fields.to.focus(); return; }
  if (!d.subject && !confirm("Send without a subject?")) return;
  const sentId = hooks.folderByType("SENT")?.id;
  if (!sentId || !d.draftFolderId) { hooks.status("Sent or Drafts folder not found"); return; }
  const snapshot = { ...draft, d, editorHtml: draft.html ? $("c-editor").innerHTML : null };
  clearInterval(autosaveTimer);
  $("compose").classList.add("hidden"); $("c-editor").innerHTML = ""; $("c-text").value = ""; draft = null; dirty = false;
  hooks.onClose();
  hooks.scheduleSend({
    label: `send "${d.subject || "(no subject)"}" to ${d.to.map(a => a.email).join(", ")}`,
    run: async () => { const r = await api.send(d, sentId); contacts.noteSent([...d.to, ...d.cc, ...d.bcc]).catch(() => {}); return r; },
    restore: () => reopenFrom(snapshot),
  });
}

async function reopenFrom(snap) {
  await loadAccounts();
  draft = { csid: snap.csid, mode: snap.mode, inReplyTo: snap.inReplyTo, files: snap.files, refs: snap.refs || [], savedId: snap.savedId, quoteHtml: snap.quoteHtml, quoteText: snap.quoteText, html: snap.html };
  $("c-title").textContent = "Message not sent";
  $("c-from").value = snap.d.from.email;
  fields.to.set(snap.d.to); fields.cc.set(snap.d.cc); fields.bcc.set(snap.d.bcc);
  $("c-cc-row").classList.toggle("hidden", !snap.d.cc.length); $("c-bcc-row").classList.toggle("hidden", !snap.d.bcc.length);
  $("c-subject").value = snap.d.subject;
  setMode(snap.html);
  applyDefaultFont();
  if (snap.html) $("c-editor").innerHTML = snap.editorHtml || "";
  else $("c-text").value = snap.d.text.replace(/\n\n[\s\S]*$/, m => snap.quoteText && m.trim() === snap.quoteText.trim() ? "" : m);
  renderQuote(false); renderFiles();
  $("compose").classList.remove("hidden");
  dirty = true;
  autosaveTimer = setInterval(() => { if (dirty && hasContent()) saveNow(true); }, 30000);
  focusEditor();
}

async function discard() {
  if (!draft) return;
  if (hasContent() && !confirm("Discard this message?")) return;
  const id = draft.savedId;
  close(false);
  if (id) { try { await api.deleteForever([id]); hooks.status("draft discarded"); } catch (e) { hooks.status(`could not delete draft: ${e.message}`); } }
}
