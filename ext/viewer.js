// Attachment strip under the message body and an in-app viewer. Attachment bytes come from the
// message source and are rendered locally: PDF.js for PDF, docx-preview for Word, SheetJS for
// spreadsheets, native elements for images and media. Formats with no renderer here use
// Yahoo's document converter, and failing that, Yahoo's extracted text.

import { listParts, extract } from "./mime.js";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sizeStr = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`;
const extOf = n => (String(n || "").match(/\.([a-z0-9]{1,6})$/i)?.[1] || "").toLowerCase();

const TEXT = new Set(["txt", "log", "md", "markdown", "ini", "cfg", "conf", "yaml", "yml", "toml", "ics", "vcf", "eml", "csv", "tsv", "json", "xml", "srt", "diff", "patch"]);
const CODE = new Set(["c", "h", "cpp", "hpp", "cc", "cs", "java", "py", "js", "ts", "go", "rs", "sh", "bat", "ps1", "pl", "rb", "php", "sql", "v", "sv", "vh", "vhd", "vhdl", "asm", "s", "inc", "mk", "cmake", "tcl", "qsf", "sdc", "ucf", "xdc", "lua", "kt", "swift"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const OFFICE_DOC = new Set(["doc", "docx", "rtf", "odt", "pages"]);
const OFFICE_SHEET = new Set(["xls", "xlsx", "ods", "numbers"]);
const OFFICE_SLIDE = new Set(["ppt", "pptx", "odp", "key"]);
const ZIP = new Set(["zip", "jar", "apk", "docm"]);

function kindOf(a) {
  const ext = extOf(a.filename), sub = (a.subtype || "").toLowerCase(), type = (a.type || "").toLowerCase();
  if (ext === "pdf" || sub === "pdf") return "pdf";
  if (IMAGE.has(ext) || type === "image") return "image";
  if (ext === "html" || ext === "htm" || sub === "html") return "html";
  if (AUDIO.has(ext) || type === "audio") return "audio";
  if (VIDEO.has(ext) || type === "video") return "video";
  if (ZIP.has(ext) || sub === "zip" || sub === "x-zip-compressed") return "zip";
  if (OFFICE_DOC.has(ext) || /wordprocessing|msword/.test(sub)) return "doc";
  if (OFFICE_SHEET.has(ext) || /spreadsheet|excel/.test(sub)) return "sheet";
  if (OFFICE_SLIDE.has(ext) || /presentation|powerpoint/.test(sub)) return "slide";
  if (CODE.has(ext)) return "code";
  if (TEXT.has(ext) || type === "text") return "text";
  return "other";
}
const LABEL = { pdf: "PDF", image: "IMG", html: "HTML", audio: "AUD", video: "VID", zip: "ZIP", doc: "DOC", sheet: "XLS", slide: "PPT", code: "CODE", text: "TXT", other: "FILE" };
const CLASS = { pdf: "k-pdf", image: "k-image", html: "k-html", audio: "k-audio", video: "k-video", zip: "k-zip", doc: "k-doc", sheet: "k-sheet", slide: "k-slide", code: "k-code", text: "k-text", other: "k-other" };

let hooks = null;   // { thumb(a), raw(msgId) -> Uint8Array, docPages(docId, start, end, retry), cleanHtml(html), status(msg) }
let items = [], index = 0, msgId = null;
let objectUrls = [];

export function init(h) {
  hooks = h;
  $("v-close").onclick = close;
  $("v-prev").onclick = () => show(index - 1);
  $("v-next").onclick = () => show(index + 1);
  $("v-dl").onclick = () => download(items[index]);
  $("v-open").onclick = () => openInTab(items[index]);
  $("viewer").onclick = e => { if (e.target.id === "viewer") close(); };
  $("v-zin").onclick = () => current?.zoom?.(1);
  $("v-zout").onclick = () => current?.zoom?.(-1);
  $("v-fit").onclick = () => current?.zoom?.(0);
}

export function isOpen() { return !$("viewer").classList.contains("hidden"); }

export function onKey(e) {
  if (e.key === "Escape") close();
  else if (e.key === "ArrowLeft") show(index - 1);
  else if (e.key === "ArrowRight") show(index + 1);
  else if (current?.zoom && (e.key === "+" || e.key === "=")) current.zoom(1);
  else if (current?.zoom && e.key === "-") current.zoom(-1);
  else if (current?.zoom && e.key === "0") current.zoom(0);
  else return false;
  e.preventDefault();
  return true;
}

// ---------- strip ----------
export function renderStrip(message, attachments, isCurrent) {
  const box = $("r-attach");
  items = attachments.filter(a => a.disposition !== "inline" && /^https:\/\//i.test(a.downloadUrl || ""));
  msgId = message.id;
  box.classList.toggle("hidden", !items.length);
  if (!items.length) { box.innerHTML = ""; return; }
  const total = items.reduce((s, a) => s + (a.size || 0), 0);
  box.innerHTML = `<div class="att-head"><b>${items.length} attachment${items.length === 1 ? "" : "s"}</b>${sizeStr(total)}</div>` +
    items.map((a, i) => {
      const k = kindOf(a);
      return `<div class="att-card" data-i="${i}" title="${esc(a.filename || "attachment")}: click to preview">
        <span class="att-thumb ${CLASS[k]}" data-i="${i}">${(k === "text" || k === "code") && extOf(a.filename) ? esc(extOf(a.filename).toUpperCase().slice(0, 4)) : LABEL[k]}</span>
        <span class="att-info"><span class="att-name">${esc(a.filename || "Untitled")}</span><span class="att-size">${sizeStr(a.size)}</span></span></div>`;
    }).join("");
  box.onclick = e => { const c = e.target.closest(".att-card"); if (c) show(Number(c.dataset.i)); };
  items.forEach(async (a, i) => {
    if (kindOf(a) !== "image" || !a.thumbnailUrl) return;
    const src = await hooks.thumb(a);
    if (!src || !isCurrent(message.id)) return;
    const slot = box.querySelector(`.att-thumb[data-i="${i}"]`);
    if (slot) slot.innerHTML = `<img src="${src}" alt="">`;
  });
}

// ---------- fetching ----------
// Yahoo's download links cannot be fetched, so attachment bytes are cut out of the message's
// raw source (one fetch per message, shared by all its attachments).
const rawCache = new Map();      // msgId -> Promise<parsed MIME>
function parsedMessage(id) {
  if (!rawCache.has(id)) {
    rawCache.set(id, hooks.raw(id).then(listParts));
    while (rawCache.size > 3) rawCache.delete(rawCache.keys().next().value);
  }
  const p = rawCache.get(id);
  p.catch(() => rawCache.delete(id));
  return p;
}

async function fetchBlob(a, id = msgId) {
  const { bytes, type } = extract(await parsedMessage(id), a.partId, a.filename);
  return new Blob([bytes], { type: MIME[extOf(a.filename)] || type || "application/octet-stream" });
}

async function extractedText(a) {
  if (!a.textExtractionUrl) throw new Error("no text extraction available");
  const resp = await fetch(a.textExtractionUrl.replace(/&amp;/g, "&"), { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const j = await resp.json();
  const t = j?.result?.textExtractResult;
  if (typeof t !== "string") throw new Error("no text in response");
  return t;
}

function objectUrl(blob, type) {
  const u = URL.createObjectURL(type && blob.type !== type ? new Blob([blob], { type }) : blob);
  objectUrls.push(u);
  return u;
}

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4" };

// ---------- libraries (loaded on first use) ----------
const loaded = new Map();
function loadScript(path) {
  if (!loaded.has(path)) loaded.set(path, new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = path; s.onload = ok; s.onerror = () => { loaded.delete(path); no(new Error(`could not load ${path}`)); };
    document.head.appendChild(s);
  }));
  return loaded.get(path);
}
function loadCss(path) {
  if (document.querySelector(`link[href="${path}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = path;
  document.head.appendChild(l);
}

const PDFJS = "vendor/pdfjs/";
let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) pdfjs = (async () => {
    const lib = await import(`./${PDFJS}pdf.min.mjs`);
    lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(`${PDFJS}pdf.worker.min.mjs`);
    globalThis.pdfjsLib = lib;           // pdf_viewer.mjs reads the core library from here
    const ui = await import(`./${PDFJS}pdf_viewer.mjs`);
    loadCss(`${PDFJS}pdf_viewer.css`);
    return { lib, ui };
  })().catch(e => { pdfjs = null; throw e; });
  return pdfjs;
}

// ---------- viewer ----------
let current = null;   // { cleanup(), zoom(dir) } for the renderer on screen

function teardown() {
  try { current?.cleanup?.(); } catch {}
  current = null;
  $("v-zoom").classList.add("hidden");
}

function close() {
  teardown();
  $("viewer").classList.add("hidden");
  $("v-body").innerHTML = "";
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

const center = html => `<div class="v-center">${html}</div>`;
const note = text => `<div class="v-note">${esc(text)}</div>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Office formats that have a renderer here; the rest go to Yahoo's converter.
const isDocx = a => extOf(a.filename) === "docx" || /wordprocessingml/.test(a.subtype || "");
const isSheet = a => ["xlsx", "xlsm", "xls", "ods", "numbers"].includes(extOf(a.filename)) || /spreadsheetml|ms-excel/.test(a.subtype || "");

async function show(i) {
  if (!items.length) return;
  teardown();
  index = (i + items.length) % items.length;
  const a = items[index], k = kindOf(a), id = msgId, at = index;
  $("viewer").classList.remove("hidden");
  $("v-name").textContent = a.filename || "Untitled";
  const meta = extra => { $("v-meta").textContent = `${sizeStr(a.size)} · ${LABEL[k]}${extra ? ` · ${extra}` : ""}${items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}`; };
  meta("");
  $("v-prev").disabled = $("v-next").disabled = items.length < 2;
  const body = $("v-body");
  body.innerHTML = center("Loading…");
  const stale = () => msgId !== id || index !== at || !isOpen();
  const ctx = { a, k, body, stale, meta };
  try {
    if (k === "pdf") return await showPdf(ctx, await fetchBlob(a));
    if (k === "doc" && isDocx(a)) return await showDocx(ctx, await fetchBlob(a));
    if (k === "sheet" && isSheet(a)) return await showSheet(ctx, await fetchBlob(a));
    if (k === "doc" || k === "sheet" || k === "slide") return await showConverted(ctx);
    if (k === "other") return await showConverted(ctx);
    const blob = await fetchBlob(a);
    if (stale()) return;
    const ext = extOf(a.filename);
    if (k === "image") {
      body.innerHTML = `<img class="v-img" alt="">`;
      const img = body.querySelector("img");
      img.src = objectUrl(blob, MIME[ext]);
      img.onclick = () => img.classList.toggle("full");
    } else if (k === "audio" || k === "video") {
      body.innerHTML = center(`<${k} controls autoplay></${k}>`);
      body.querySelector(k).src = objectUrl(blob, MIME[ext]);
    } else if (k === "html") {
      const html = hooks.cleanHtml(await blob.text());
      body.innerHTML = `<iframe sandbox="" referrerpolicy="no-referrer" title="HTML"></iframe>`;
      body.querySelector("iframe").srcdoc = `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:">${html}`;
    } else if (k === "zip") {
      const entries = await zipListing(blob);
      if (stale()) return;
      body.innerHTML = note(`${entries.length} entries; download to extract.`) +
        `<table><tr><th>Name</th><th>Size</th><th>Packed</th><th>Modified</th></tr>${entries.map(e =>
          `<tr><td>${esc(e.name)}</td><td>${e.dir ? "" : sizeStr(e.size)}</td><td>${e.dir ? "" : sizeStr(e.packed)}</td><td>${esc(e.date)}</td></tr>`).join("")}</table>`;
    } else {
      if (blob.size > 3 * 1048576) { body.innerHTML = center(`Too large to preview (${sizeStr(blob.size)}). <button id="v-dl2">Download</button>`); $("v-dl2").onclick = () => download(a); return; }
      let text = await blob.text();
      if (ext === "csv" || ext === "tsv") { renderTable(body, text, ext === "tsv" ? "\t" : null); return; }
      if (ext === "json") { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
      body.innerHTML = "<pre></pre>";
      body.querySelector("pre").textContent = text;
    }
  } catch (e) {
    if (stale()) return;
    // The renderer or the bytes failed: Yahoo's converter, then its plain text, then give up.
    try { if (k !== "image" && k !== "audio" && k !== "video" && k !== "zip") return await showConverted(ctx); } catch {}
    if (stale()) return;
    body.innerHTML = center(`No preview available for this file (${esc(e.message)}). <button id="v-dl2">Download</button>`);
    $("v-dl2").onclick = () => download(a);
  }
}

// ----- PDF: PDF.js with its text layer, so text can be selected and searched -----
async function showPdf({ body, stale, meta }, blob) {
  const { lib, ui } = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  if (stale()) return;
  const base = chrome.runtime.getURL(PDFJS);
  const task = lib.getDocument({
    data, cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/",
    wasmUrl: base + "wasm/", iccUrl: base + "iccs/", enableScripting: false, isEvalSupported: false,
  });
  const doc = await task.promise;
  if (stale()) { doc.destroy(); return; }
  body.innerHTML = `<div class="v-pdf" tabindex="-1"><div class="pdfViewer"></div></div>`;
  const container = body.querySelector(".v-pdf");
  const eventBus = new ui.EventBus();
  const linkService = new ui.PDFLinkService({ eventBus, externalLinkTarget: ui.LinkTarget.BLANK, externalLinkRel: "noopener noreferrer nofollow" });
  const viewer = new ui.PDFViewer({ container, eventBus, linkService, textLayerMode: 1, annotationMode: lib.AnnotationMode.ENABLE, removePageBorders: false });
  linkService.setViewer(viewer);
  eventBus.on("pagesinit", () => { viewer.currentScaleValue = "page-width"; container.focus(); });
  const pageInfo = () => meta(`page ${viewer.currentPageNumber} of ${doc.numPages}`);
  eventBus.on("pagechanging", pageInfo);
  viewer.setDocument(doc);
  linkService.setDocument(doc);
  pageInfo();
  $("v-zoom").classList.remove("hidden");
  current = {
    cleanup: () => { viewer.setDocument(null); linkService.setDocument(null); doc.destroy(); },
    zoom: dir => {
      if (dir === 0) viewer.currentScaleValue = "page-width";
      else viewer.currentScale = Math.min(5, Math.max(0.25, viewer.currentScale * (dir > 0 ? 1.2 : 1 / 1.2)));
    },
  };
}

// Links inside rendered documents open in a new tab; in-document anchors scroll.
function guardLinks(host, root) {
  host.addEventListener("click", e => {
    const link = e.composedPath().find(n => n.tagName === "A" && n.getAttribute?.("href"));
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute("href");
    if (href.startsWith("#")) {
      const name = decodeURIComponent(href.slice(1));
      (root.getElementById?.(name) || root.querySelector(`[name="${CSS.escape(name)}"]`))?.scrollIntoView({ block: "start" });
    } else if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
  });
}

// ----- Word (.docx): docx-preview, rendered into a shadow root so its styles stay put -----
async function showDocx({ body, stale }, blob) {
  await loadScript("vendor/jszip.min.js");
  await loadScript("vendor/docx-preview.min.js");
  if (stale()) return;
  const host = document.createElement("div");
  host.className = "v-doc"; host.tabIndex = -1;
  const root = host.attachShadow({ mode: "open" });
  const wrap = document.createElement("div");
  root.appendChild(wrap);
  await globalThis.docx.renderAsync(blob, wrap, wrap, { inWrapper: true, ignoreLastRenderedPageBreak: true, useBase64URL: true, renderComments: false, experimental: true });
  if (stale()) return;
  body.innerHTML = "";
  body.appendChild(host);
  guardLinks(host, root);
  host.focus();
}

// ----- Spreadsheets: SheetJS, one tab per sheet, an Excel-style grid -----
const colName = n => { let s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
const MAX_ROWS = 5000, MAX_COLS = 200;

async function showSheet({ body, stale, meta }, blob) {
  await loadScript("vendor/xlsx.full.min.js");
  const wb = globalThis.XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: "array", sheetRows: MAX_ROWS + 1, cellStyles: false });
  if (stale()) return;
  const names = wb.SheetNames;
  body.innerHTML = `<div class="v-sheet"><div class="v-grid" tabindex="-1"></div><div class="v-tabs">${names.map((n, i) => `<button data-i="${i}">${esc(n)}</button>`).join("")}</div></div>`;
  const grid = body.querySelector(".v-grid"), tabs = body.querySelector(".v-tabs");
  const render = i => {
    tabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", Number(b.dataset.i) === i));
    const ws = wb.Sheets[names[i]];
    const rows = globalThis.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: true });
    const cols = Math.min(MAX_COLS, rows.reduce((m, r) => Math.max(m, r.length), 0));
    const shown = rows.slice(0, MAX_ROWS);
    meta(`${names.length > 1 ? `sheet ${i + 1} of ${names.length} · ` : ""}${rows.length >= MAX_ROWS ? `first ${MAX_ROWS} rows` : `${rows.length} rows`}`);
    grid.innerHTML = `<table><thead><tr><th class="rn"></th>${Array.from({ length: cols }, (_, c) => `<th>${colName(c)}</th>`).join("")}</tr></thead><tbody>${
      shown.map((r, ri) => `<tr><th class="rn">${ri + 1}</th>${Array.from({ length: cols }, (_, c) => {
        const v = r[c] ?? "";
        return `<td${/^-?[\d.,]+%?$|^[$€£¥]/.test(v) ? ' class="num"' : ""}>${esc(v)}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table>`;
    grid.scrollTo(0, 0);
    grid.focus();
  };
  tabs.onclick = e => { const b = e.target.closest("button"); if (b) render(Number(b.dataset.i)); };
  tabs.classList.toggle("hidden", names.length < 2);
  render(0);
}

// ----- Everything else: Yahoo's converter (pages load as you scroll), then its plain text -----
const PENDING = new Set([605, 612, 621, 814]);
function sanitizePage(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, meta, link, base, object, embed, iframe, form, frame").forEach(e => e.remove());
  for (const el of doc.querySelectorAll("*")) {
    for (const at of [...el.attributes]) {
      if (at.name.startsWith("on") || at.name === "ping") el.removeAttribute(at.name);
      else if (/^(href|src|xlink:href|action)$/.test(at.name) && !/^(https?:|mailto:|#|data:image\/)/i.test(at.value.trim())) el.removeAttribute(at.name);
    }
  }
  return doc.body.innerHTML;
}
const decodeEntities = s => { const t = document.createElement("textarea"); t.innerHTML = s; return t.value; };

async function fetchPages(docId, s, e, stale) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await hooks.docPages(docId, s, e, attempt);
    if (r.code === 800 && r.pages.length && r.pages.every(p => p.ok)) return r;
    if (r.code !== 800 && !PENDING.has(r.code) && r.pages.length === 0 && attempt > 0) throw new Error(`converter code ${r.code}`);
    if (stale()) return null;
    await sleep(700 * (attempt + 1));
  }
  throw new Error("converter did not finish");
}

async function showConverted(ctx) {
  const { a, body, stale, meta } = ctx;
  if (!a.documentId) return showText(ctx);
  const CHUNK = 3;
  const first = await fetchPages(a.documentId, 1, CHUNK, stale);
  if (!first || stale()) return;
  const total = first.total || first.pages.length;
  const imageLike = first.pages.some(p => /data:image\/(jpeg|png);base64,[^"]{2000}/.test(p.html.slice(0, 4000)) && !/<p[\s>]/.test(p.html.slice(0, 4000)));
  body.innerHTML = note("Converted by Yahoo. Download for the original.") + `<div class="v-pages${imageLike ? " img" : ""}" tabindex="-1"></div><div class="v-more"></div>`;
  const list = body.querySelector(".v-pages"), more = body.querySelector(".v-more");
  meta(`${total} page${total === 1 ? "" : "s"}`);
  const add = r => {
    for (const p of r.pages) {
      const host = document.createElement("div");
      host.className = "v-page";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>:host{display:block} .aps-page{position:relative;overflow:auto} img{max-width:100%;height:auto}</style><style>${decodeEntities(p.css).replace(/<\/?style[^>]*>/gi, "")}</style>${sanitizePage(decodeEntities(p.html))}`;
      guardLinks(host, root);
      list.appendChild(host);
    }
  };
  add(first);
  list.focus();
  let next = first.pages.length + 1, busy = false;
  if (next > total) { more.remove(); return; }
  more.textContent = "Loading more pages…";
  const io = new IntersectionObserver(async ([entry]) => {
    if (!entry.isIntersecting || busy || stale()) return;
    busy = true;
    try {
      const r = await fetchPages(a.documentId, next, Math.min(total, next + CHUNK - 1), stale);
      if (!r || stale()) return;
      add(r);
      next += r.pages.length;
      if (next > total) { io.disconnect(); more.remove(); }
    } catch (e) { io.disconnect(); more.textContent = `Could not load the remaining pages (${e.message}).`; }
    finally { busy = false; }
  }, { root: body, rootMargin: "600px" });
  io.observe(more);
  current = { cleanup: () => io.disconnect() };
}

async function showText({ a, k, body, stale }) {
  const t = await extractedText(a);
  if (stale()) return;
  if ((extOf(a.filename) === "csv" || extOf(a.filename) === "tsv") && t) { renderTable(body, t, extOf(a.filename) === "tsv" ? "\t" : null); return; }
  body.innerHTML = note(k === "text" || k === "code" ? "Text as stored by Yahoo." : "Text extracted by Yahoo; layout, images and formatting are not shown. Download for the original.") + "<pre></pre>";
  body.querySelector("pre").textContent = t || "(no text)";
}

function renderTable(body, text, sep) {
  const first = text.split(/\r?\n/, 1)[0];
  sep = sep || ([",", ";", "\t", "|"].map(s => [s, first.split(s).length]).sort((x, y) => y[1] - x[1])[0][0]);
  const rows = parseDelimited(text, sep);
  const shown = rows.slice(0, 2000);
  body.innerHTML = note(`${rows.length} rows${rows.length > shown.length ? `, first ${shown.length} shown` : ""}; separator “${sep === "\t" ? "tab" : sep}”.`) +
    `<table>${shown.map((r, i) => `<tr>${r.map(c => i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
}

function parseDelimited(text, sep) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"' && cell === "") q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Lists a ZIP's entries from its central directory; no decompression needed.
async function zipListing(blob) {
  const tail = new DataView(await blob.slice(Math.max(0, blob.size - 65557)).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const out = []; let p = 0;
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const time = cd.getUint16(p + 12, true), date = cd.getUint16(p + 14, true);
    const packed = cd.getUint32(p + 20, true), size = cd.getUint32(p + 24, true);
    const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
    const d = `${1980 + (date >> 9)}-${String((date >> 5) & 15).padStart(2, "0")}-${String(date & 31).padStart(2, "0")} ${String(time >> 11).padStart(2, "0")}:${String((time >> 5) & 63).padStart(2, "0")}`;
    out.push({ name, size, packed, date: d, dir: name.endsWith("/") });
    p += 46 + nl + xl + cl;
  }
  return out;
}

// ---------- download / open ----------
async function download(a) {
  try {
    const blob = await fetchBlob(a);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = a.filename || "attachment";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  } catch {
    // A background tab on Yahoo's link: the browser follows the redirect and saves the original.
    chrome.tabs.create({ url: a.downloadUrl.replace(/&amp;/g, "&"), active: false });
  }
}

async function openInTab(a) {
  const k = kindOf(a), ext = extOf(a.filename);
  try {
    const blob = await fetchBlob(a);
    const u = URL.createObjectURL(new Blob([blob], { type: MIME[ext] || (k === "text" || k === "code" ? "text/plain;charset=utf-8" : blob.type) }));
    window.open(u, "_blank");
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  } catch { chrome.tabs.create({ url: a.downloadUrl.replace(/&amp;/g, "&") }); }
}
