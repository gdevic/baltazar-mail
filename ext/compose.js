import * as api from "./api.js";

// Compose panel: new message, reply, reply all, forward, or editing a draft.
// Owns its DOM under #compose; talks to the rest of the app through the hooks given to init().

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = a => a?.name ? `${a.name} <${a.email}>` : (a?.email || "");
const fmtList = l => (l || []).map(fmt).join(", ");

let hooks = null;          // { status, folderByType, settings, onClose, onSent, scheduleSend }
let accounts = [];
let draft = null;          // current compose state
let autosaveTimer = null;
let dirty = false;

export function init(h) {
  hooks = h;
  const c = $("compose");
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
  $("c-to").value = fmtList(to); $("c-cc").value = fmtList(cc); $("c-bcc").value = "";
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
  if (opts.mode === "new") $("c-to").focus(); else focusEditor();
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
  return !!($("c-to").value.trim() || $("c-subject").value.trim() || (draft.html ? $("c-editor").innerText.trim() : $("c-text").value.trim()) || draft.files.length);
}

function collect() {
  const acct = accounts.find(a => a.email === $("c-from").value) || accounts[0];
  const from = { name: acct?.sendingName || "", email: acct?.email || $("c-from").value };
  const d = {
    csid: draft.csid, from, replyTo: acct?.replyToAddress ? { email: acct.replyToAddress } : from,
    to: parseAddrs($("c-to").value), cc: parseAddrs($("c-cc").value), bcc: parseAddrs($("c-bcc").value),
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
  if (!d.to.length && !d.cc.length && !d.bcc.length) { hooks.status("no recipients"); $("c-to").focus(); return; }
  if (!d.subject && !confirm("Send without a subject?")) return;
  const sentId = hooks.folderByType("SENT")?.id;
  if (!sentId || !d.draftFolderId) { hooks.status("Sent or Drafts folder not found"); return; }
  const snapshot = { ...draft, d };
  clearInterval(autosaveTimer);
  $("compose").classList.add("hidden"); $("c-editor").innerHTML = ""; $("c-text").value = ""; draft = null; dirty = false;
  hooks.onClose();
  hooks.scheduleSend({
    label: `send "${d.subject || "(no subject)"}" to ${d.to.map(a => a.email).join(", ")}`,
    run: () => api.send(d, sentId),
    restore: () => reopenFrom(snapshot),
  });
}

async function reopenFrom(snap) {
  await loadAccounts();
  draft = { csid: snap.csid, mode: snap.mode, inReplyTo: snap.inReplyTo, files: snap.files, savedId: snap.savedId, quoteHtml: snap.quoteHtml, quoteText: snap.quoteText, html: snap.html };
  $("c-title").textContent = "Message not sent";
  $("c-from").value = snap.d.from.email;
  $("c-to").value = fmtList(snap.d.to); $("c-cc").value = fmtList(snap.d.cc); $("c-bcc").value = fmtList(snap.d.bcc);
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
