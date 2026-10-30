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
    el.onclick = e => { if (e.target === el) this.input.focus(); };
    this.input.oninput = () => { dirty = true; this.suggest(); };
    this.input.onkeydown = e => this.onKey(e);
    this.input.onblur = () => setTimeout(() => { if (document.activeElement !== this.input) { this.commit(false); hideSuggest(); } }, 150);
    this.input.onfocus = () => this.suggest();
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
  async suggest() {
    const exclude = new Set(this.list.map(a => a.email.toLowerCase()));
    const items = await contacts.suggest(this.input.value, 8, exclude);
    if (document.activeElement !== this.input) return;
    showSuggest(this, items);
  }
  onKey(e) {
    const sg = $("c-suggest"), open = !sg.classList.contains("hidden");
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); moveSuggest(e.key === "ArrowDown" ? 1 : -1); return; }
    if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideSuggest(); return; }
    if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") {
      if (open && suggestSel >= 0) { e.preventDefault(); this.add(suggestItems[suggestSel]); this.input.value = ""; hideSuggest(); this.suggest(); return; }
      if (this.input.value.trim()) { if (e.key !== "Tab") e.preventDefault(); this.commit(true); hideSuggest(); return; }
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "Backspace" && !this.input.value && this.list.length) { this.list.pop(); dirty = true; this.render(); }
  }
}

let suggestField = null, suggestItems = [], suggestSel = -1;
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
    if (h) { await contacts.hide(h.dataset.hide); hooks.status(`${h.dataset.hide} will not be suggested again (restore in settings)`); field.input.focus(); field.suggest(); return; }
    const d = e.target.closest("[data-i]"); if (!d) return;
    field.add(items[Number(d.dataset.i)]); field.input.value = ""; hideSuggest(); field.input.focus(); field.suggest();
  };
}
function moveSuggest(d) {
  if (!suggestItems.length) return;
  suggestSel = (suggestSel + d + suggestItems.length) % suggestItems.length;
  $("c-suggest").querySelectorAll("div").forEach((el, i) => el.classList.toggle("kb", i === suggestSel));
}
function hideSuggest() { $("c-suggest").classList.add("hidden"); suggestSel = -1; }

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
  for (const b of $("c-toolbar").querySelectorAll("button[data-cmd]")) b.onclick = e => { e.preventDefault(); format(b.dataset.cmd); };
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
  draft = { csid: String(Date.now()), mode: "new", inReplyTo: null, files: [], savedId: null, quoteHtml: "", quoteText: "", html: true };
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
      if (opts.body.attachments?.length) hooks.status("note: attachments of the original are not forwarded yet");
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
  $("c-editor").innerHTML = bodyHtml || sig;
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

export function close(save = true) {
  if (!isOpen()) return;
  clearInterval(autosaveTimer);
  const finish = () => { $("compose").classList.add("hidden"); $("c-editor").innerHTML = ""; $("c-text").value = ""; draft = null; hooks.onClose(); };
  if (save && dirty && hasContent()) saveNow(true).finally(finish); else finish();
}

// ---------- editor ----------
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

function format(cmd) {
  const ed = $("c-editor"); ed.focus();
  if (cmd === "link") { const url = prompt("Link URL:"); if (url && /^https?:\/\//i.test(url)) document.execCommand("createLink", false, url); return; }
  if (cmd === "code") { document.execCommand("formatBlock", false, "pre"); return; }
  document.execCommand(cmd, false, null);
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
  el.innerHTML = draft.files.map((f, i) => `<span class="c-file">${esc(f.name)} <i>${Math.round(f.size / 1024)} KB</i> <a href="#" data-i="${i}" title="Remove">×</a></span>`).join("");
  el.onclick = e => { const a = e.target.closest("a[data-i]"); if (a) { e.preventDefault(); draft.files.splice(Number(a.dataset.i), 1); dirty = true; renderFiles(); } };
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
  return !!(!fields.to.isEmpty() || $("c-subject").value.trim() || (draft.html ? $("c-editor").innerText.trim() : $("c-text").value.trim()) || draft.files.length);
}

function strictGet(f) { if (!f.commit(true)) throw new Error(`Not an address: ${f.input.value.trim()}`); return f.get(); }

function collect() {
  const acct = accounts.find(a => a.email === $("c-from").value) || accounts[0];
  const from = { name: acct?.sendingName || "", email: acct?.email || $("c-from").value };
  const d = {
    csid: draft.csid, from, replyTo: acct?.replyToAddress ? { email: acct.replyToAddress } : from,
    to: strictGet(fields.to), cc: strictGet(fields.cc), bcc: strictGet(fields.bcc),
    subject: $("c-subject").value.trim(), inReplyTo: draft.inReplyTo, files: draft.files,
    draftFolderId: hooks.folderByType("DRAFT")?.id,
  };
  if (draft.html) d.html = `<div>${$("c-editor").innerHTML}</div>` + (draft.quoteHtml ? `<br>${draft.quoteHtml}` : "");
  else d.text = $("c-text").value + (draft.quoteText ? `\n\n${draft.quoteText}` : "");
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
  const snapshot = { ...draft, d };
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
  draft = { csid: snap.csid, mode: snap.mode, inReplyTo: snap.inReplyTo, files: snap.files, savedId: snap.savedId, quoteHtml: snap.quoteHtml, quoteText: snap.quoteText, html: snap.html };
  $("c-title").textContent = "Message not sent";
  $("c-from").value = snap.d.from.email;
  fields.to.set(snap.d.to); fields.cc.set(snap.d.cc); fields.bcc.set(snap.d.bcc);
  $("c-cc-row").classList.toggle("hidden", !snap.d.cc.length); $("c-bcc-row").classList.toggle("hidden", !snap.d.bcc.length);
  $("c-subject").value = snap.d.subject;
  setMode(snap.html);
  if (snap.html) { const own = snap.d.html.replace(/<br>(<div class="ymq">[\s\S]*)$/, ""); $("c-editor").innerHTML = own.replace(/^<div>/, "").replace(/<\/div>$/, ""); }
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
