// Attachment strip under the message body and the viewer. Attachment bytes come from the provider
// adapter. Images and media play in native elements here; everything else is parsed and drawn in
// the sandboxed render.html (PDF.js, docx-preview, SheetJS, ZIP listings, text). Formats with no
// renderer there use the provider's document converter and extracted text, when it has them.

import { asText, hexDump } from "./bytes.js";
import { esc, noBidi, plural } from "./text.js";
import { zipWriter, flatName, uniqueName } from "./zip.js";

const $ = id => document.getElementById(id);
export const sizeStr = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`;
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

// A file's kind by its extension, and by the type the sender gave only when the extension says
// nothing: senders often give a generic type (a .docx sent as application/zip).
export function kindOf(a) {
  const ext = extOf(a.filename), sub = (a.subtype || "").toLowerCase(), type = (a.type || "").toLowerCase();
  const byExt = ext === "pdf" ? "pdf" : IMAGE.has(ext) ? "image" : ext === "html" || ext === "htm" ? "html" : AUDIO.has(ext) ? "audio" : VIDEO.has(ext) ? "video"
    : ZIP.has(ext) ? "zip" : OFFICE_DOC.has(ext) ? "doc" : OFFICE_SHEET.has(ext) ? "sheet" : OFFICE_SLIDE.has(ext) ? "slide" : CODE.has(ext) ? "code" : TEXT.has(ext) ? "text" : null;
  if (byExt) return byExt;
  if (sub === "pdf") return "pdf";
  if (type === "image") return "image";
  if (sub === "html") return "html";
  if (type === "audio") return "audio";
  if (type === "video") return "video";
  if (sub === "zip" || sub === "x-zip-compressed") return "zip";
  if (/wordprocessing|msword/.test(sub)) return "doc";
  if (/spreadsheet|excel/.test(sub)) return "sheet";
  if (/presentation|powerpoint/.test(sub)) return "slide";
  if (type === "text") return "text";
  return "other";
}
const LABEL = { pdf: "PDF", image: "IMG", html: "HTML", audio: "AUD", video: "VID", zip: "ZIP", doc: "DOC", sheet: "XLS", slide: "PPT", code: "CODE", text: "TXT", other: "FILE" };
// The coloured tile a file shows as: its kind's label, or for text and code its own extension.
export function tile(a) {
  const k = kindOf(a), ext = extOf(a.filename);
  return { kind: k, cls: `k-${k}`, text: (k === "text" || k === "code") && ext ? ext.toUpperCase().slice(0, 4) : LABEL[k] };
}

// { thumb(msgId, a) -> data URL | null, bytes(msgId, a) -> { bytes, type, filename }, docPages?(docId, start, end, retry),
//   extractText?(a) -> string, originalUrl?(a) -> url | null, listed(a) -> whether the strip shows it,
//   attachedHtml(html) -> { html, page: the colours of its darkened page | null }, status(msg), notify(text),
//   menu(x, y, items, onPick), limits: the provider's LIMITS (fetchGap), providerName }
let hooks = null;
// The files the viewer steps through, each with the id of the message it belongs to (msgId).
let items = [], index = 0;
let shown = 0;        // counts show() calls: a file left before it is drawn is drawn no more
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

// Shows file i of list, whose entries carry their message's id (msgId); the arrows step through
// the list, whichever messages its files come from.
export function open(list, i) {
  items = list;
  show(i);
}

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
// The files under the message, each with its message's id and date; the ones Ctrl-click selected,
// by their place in the strip; and the subject, which names a ZIP of them.
const strip = { items: [], marked: new Set(), subject: "" };
const modKey = () => /^mac/i.test(navigator.userAgentData?.platform || navigator.platform || "") ? "⌘" : "Ctrl";

export function renderStrip(message, attachments, isCurrent) {
  const box = $("r-attach"), date = message.headers?.date;
  const list = attachments.filter(a => a.disposition !== "inline" && hooks.listed(a)).map(a => ({ ...a, msgId: message.id, date }));
  Object.assign(strip, { items: list, marked: new Set(), subject: String(message.headers?.subject || "").replace(/\^_/g, "") });
  box.classList.toggle("hidden", !list.length);
  if (!list.length) { box.innerHTML = ""; return; }
  const total = list.reduce((s, a) => s + (a.size || 0), 0);
  const how = list.length > 1 ? `click to preview, ${modKey()}-click to select; right-click to download them in one ZIP file` : "click to preview";
  box.innerHTML = `<div class="att-head"><b>${list.length} attachment${list.length === 1 ? "" : "s"}</b>${sizeStr(total)}</div>` +
    list.map((a, i) => {
      const t = tile(a);
      return `<div class="att-card" data-i="${i}" title="${esc(a.filename || "attachment")}: ${how}">
        <span class="att-thumb ${t.cls}" data-i="${i}">${esc(t.text)}</span>
        <span class="att-info"><span class="att-name">${esc(a.filename || "Untitled")}</span><span class="att-size">${sizeStr(a.size)}</span></span></div>`;
    }).join("");
  box.onclick = e => {
    const c = e.target.closest(".att-card"); if (!c) return;
    if (e.ctrlKey || e.metaKey) markCard(Number(c.dataset.i)); else open(list, Number(c.dataset.i));
  };
  box.oncontextmenu = e => { e.preventDefault(); stripMenu(e.clientX, e.clientY); };
  list.forEach(async (a, i) => {
    if (kindOf(a) !== "image") return;
    const src = await hooks.thumb(message.id, a).catch(() => null);
    if (!src || !isCurrent(message.id)) return;
    const slot = box.querySelector(`.att-thumb[data-i="${i}"]`);
    if (slot) slot.replaceChildren(Object.assign(document.createElement("img"), { src, alt: "" }));
  });
}

function markCard(i) {
  if (strip.marked.has(i)) strip.marked.delete(i); else strip.marked.add(i);
  $("r-attach").querySelector(`.att-card[data-i="${i}"]`)?.classList.toggle("marked", strip.marked.has(i));
}
// Esc: the strip's selection goes, when it has one on screen.
export function unmarkStrip() {
  if (!strip.marked.size || !$("r-attach").getClientRects().length) return false;
  strip.marked.clear();
  $("r-attach").querySelectorAll(".att-card.marked").forEach(c => c.classList.remove("marked"));
  return true;
}
// Right-click in the strip: all its files, or the selected ones when they are some but not all.
function stripMenu(x, y) {
  const { items, marked, subject } = strip, n = items.length, k = marked.size;
  if (!n) return;
  hooks.menu(x, y, [["all", "Download all", "", n > 1 ? "In one ZIP file" : ""], ...(k && k < n ? [["marked", `Download selected (${k})`, "", k > 1 ? "In one ZIP file" : ""]] : [])],
    act => downloadZip(act === "marked" ? items.filter((_, i) => marked.has(i)) : items, subject));
}

// ---------- fetching ----------
// The provider hands over an attachment's bytes (hooks.bytes). The blob's type comes from the
// file name. The sender's header is used only for an image, audio or video type the name does
// not settle; anything else is untyped, since an image opened in a tab from the viewer would
// otherwise show the sender's HTML at the extension's address.
const MEDIA_TYPE = /^(image\/(png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)|audio\/[\w.+-]+|video\/[\w.+-]+)$/i;
async function fetchBlob(a) {
  const { bytes, type } = await hooks.bytes(a.msgId, a);
  return new Blob([bytes], { type: MIME[extOf(a.filename)] || (MEDIA_TYPE.test(type || "") ? type : "application/octet-stream") });
}

// A text file's characters, in the encoding asText recognises (UTF-8, Windows-1252, UTF-16 with
// its mark); what it takes for binary is read as UTF-8 all the same, as the file says it is text.
async function textOf(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return asText(bytes) ?? new TextDecoder().decode(bytes);
}

function objectUrl(blob, type) {
  const u = URL.createObjectURL(type && blob.type !== type ? new Blob([blob], { type }) : blob);
  objectUrls.push(u);
  return u;
}

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  avif: "image/avif", ico: "image/x-icon", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
  opus: "audio/ogg", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg" };

// ---------- viewer ----------
let current = null;   // { cleanup(), zoom(dir) } for the renderer on screen

// The file on screen goes, with the object URLs that held its bytes.
function teardown() {
  try { current?.cleanup?.(); } catch {}
  current = null;
  $("v-zoom").classList.add("hidden");
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

function close() {
  teardown();
  $("viewer").classList.add("hidden");
  $("v-body").innerHTML = "";
}

const center = html => `<div class="v-center">${html}</div>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// An SVG is drawn once into a bitmap and shown as that. As an image it runs nothing and loads
// nothing, but opened in a tab from the viewer ("Open image in new tab") the file itself would be
// a document of the sender's under the extension's address. The bitmap has the picture's own
// size at the screen's density, as far as RASTER_MAX pixels a side.
const RASTER_MAX = 4096;
async function rasterized(blob) {
  const src = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const w = img.naturalWidth || 300, h = img.naturalHeight || 150;
    const density = Math.min(devicePixelRatio || 1, RASTER_MAX / Math.max(w, h));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * density)), Math.max(1, Math.round(h * density)));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return { blob: await canvas.convertToBlob({ type: "image/png" }), density };
  } finally { URL.revokeObjectURL(src); }
}

// ---------- pictures ----------
// A picture opens whole, at its own size when that fits the pane. The wheel zooms it about the
// pointer, and + and - about the middle of the pane: from whole up to ZOOM_MAX times its own size
// (or the size that fills the pane, for a small one), stopping at its own size on the way. While
// it is larger than the pane, dragging moves it, never further than its own edge. scale is CSS
// pixels to a pixel of the picture.
const ZOOM_MAX = 8, ZOOM_STEP = 1.25, WHEEL_ZOOM = 0.002;
function picture(canvas, img, meta) {
  const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
  let scale = 0, x = 0, y = 0, whole = true, said = 0;
  const fills = () => Math.min(canvas.clientWidth / w, canvas.clientHeight / h);
  function place() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (whole) scale = Math.min(1, fills());
    const sw = w * scale, sh = h * scale;
    // Centred along an axis it fits on; along one it does not, its edges stay outside the pane.
    x = sw <= W ? (W - sw) / 2 : Math.min(0, Math.max(W - sw, x));
    y = sh <= H ? (H - sh) / 2 : Math.min(0, Math.max(H - sh, y));
    Object.assign(img.style, { left: `${x}px`, top: `${y}px`, width: `${sw}px`, height: `${sh}px` });
    img.classList.add("placed");
    canvas.classList.toggle("pan", sw > W + 0.5 || sh > H + 0.5);
    const percent = Math.round(scale * 100);
    if (percent !== said) meta(`${w} × ${h} · ${said = percent}%`);
  }
  // The point of the picture at (px, py) of the pane stays there.
  function zoomTo(next, px, py) {
    if (!scale) return;
    const least = Math.min(1, fills());
    next = Math.min(Math.max(ZOOM_MAX, fills()), Math.max(least, next));
    if ((scale < 1 && next > 1) || (scale > 1 && next < 1)) next = 1;
    whole = next <= least;
    x = px - ((px - x) * next) / scale;
    y = py - ((py - y) * next) / scale;
    scale = next;
    place();
  }
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomTo(scale * Math.exp(-Math.max(-240, Math.min(240, e.deltaY)) * WHEEL_ZOOM), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  canvas.onpointerdown = e => {
    if (e.button !== 0 || !canvas.classList.contains("pan")) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("panning");
    let px = e.clientX, py = e.clientY;
    canvas.onpointermove = m => { x += m.clientX - px; y += m.clientY - py; px = m.clientX; py = m.clientY; place(); };
  };
  canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = () => { canvas.onpointermove = null; canvas.classList.remove("panning"); };
  const resized = new ResizeObserver(place);
  resized.observe(canvas);
  place();
  $("v-fit").title = "Whole picture (0)";
  $("v-zoom").classList.remove("hidden");
  current = { cleanup: () => resized.disconnect(),
    zoom: dir => { if (dir) zoomTo(scale * ZOOM_STEP ** dir, canvas.clientWidth / 2, canvas.clientHeight / 2); else { whole = true; place(); } } };
}

// In a dark theme the renderers that draw text and tables themselves take the app's palette, and
// a document's pages lie on its background; in a light one a file is shown on white paper.
const ROLES = ["bg", "bg2", "bg3", "fg", "fg2", "fg3", "line", "accent"];
function palette() {
  const root = document.documentElement;
  if (root.dataset.theme !== "dark") return null;
  const css = getComputedStyle(root);
  return Object.fromEntries(ROLES.map(k => [k, css.getPropertyValue(`--${k}`).trim()]));
}

// Office formats that have a renderer here; the rest go to the provider's converter.
const isDocx = a => extOf(a.filename) === "docx" || /wordprocessingml/.test(a.subtype || "");
const isSheet = a => ["xlsx", "xlsm", "xls", "ods", "numbers"].includes(extOf(a.filename)) || /spreadsheetml|ms-excel/.test(a.subtype || "");

async function show(i) {
  if (!items.length) return;
  teardown();
  index = (i + items.length) % items.length;
  const a = items[index], k = kindOf(a), seq = ++shown;
  $("viewer").classList.remove("hidden");
  $("v-name").textContent = noBidi(a.filename || "Untitled");
  const meta = extra => { $("v-meta").textContent = `${sizeStr(a.size)} · ${LABEL[k]}${extra ? ` · ${extra}` : ""}${items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}`; };
  meta("");
  $("v-prev").disabled = $("v-next").disabled = items.length < 2;
  const body = $("v-body");
  body.innerHTML = center("Loading...");
  const stale = () => seq !== shown || !isOpen();
  const ctx = { a, k, body, stale, meta };
  const bytes = async () => (await fetchBlob(a)).arrayBuffer();
  let converted = false;     // the provider's converter was tried already, so a failure does not ask it again
  try {
    if (k === "pdf") return await sandboxed(ctx, { kind: "pdf", bytes: await bytes() });
    if (k === "doc" && isDocx(a)) return await sandboxed(ctx, { kind: "docx", bytes: await bytes() });
    if (k === "sheet" && isSheet(a)) return await sandboxed(ctx, { kind: "sheet", bytes: await bytes() });
    if (k === "doc" || k === "sheet" || k === "slide" || k === "other") { converted = true; return await showConverted(ctx); }
    const blob = await fetchBlob(a);
    if (stale()) return;
    const ext = extOf(a.filename);
    if (k === "image") {
      const drawn = ext === "svg" ? await rasterized(blob) : null;
      if (stale()) return;
      body.innerHTML = `<div class="v-canvas"><img class="v-img" alt="" draggable="false"></div>`;
      const img = body.querySelector("img");
      img.src = drawn ? objectUrl(drawn.blob) : objectUrl(blob, MIME[ext]);
      if (drawn) img.srcset = `${img.src} ${drawn.density}x`;
      await img.decode();
      if (stale()) return;
      picture(img.parentNode, img, meta);
    } else if (k === "audio" || k === "video") {
      body.innerHTML = center(`<${k} controls autoplay></${k}>`);
      body.querySelector(k).src = objectUrl(blob, MIME[ext]);
    } else if (k === "html") {
      const { html, page } = hooks.attachedHtml(await textOf(blob));
      body.innerHTML = `<iframe sandbox="" referrerpolicy="no-referrer" title="HTML"></iframe>`;
      const frame = body.querySelector("iframe");
      if (page) frame.style.background = page.bg;
      frame.srcdoc = `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
        (page ? `<style>html{background:${page.bg};color-scheme:dark}body{color:${page.fg}}a{color:${page.link}}</style>` : "") + html;
    } else if (k === "zip") {
      await sandboxed(ctx, { kind: "zip", bytes: await blob.arrayBuffer() });
    } else {
      if (blob.size > 3 * 1048576) { body.innerHTML = center(`Too large to preview (${sizeStr(blob.size)}). <button id="v-dl2">Download</button>`); $("v-dl2").onclick = () => download(a); return; }
      await sandboxed(ctx, { kind: "text", text: await textOf(blob), ext });
    }
  } catch (e) {
    if (stale()) return;
    // The renderer or the bytes failed: the provider's converter, then its plain text, then give up.
    try { if (!converted && k !== "image" && k !== "audio" && k !== "video" && k !== "zip") return await showConverted(ctx); } catch {}
    if (stale()) return;
    // A small file nothing could preview can still be read: as text when it looks like text,
    // otherwise as a hex dump.
    let raw = null;
    if ((a.size || 0) <= RAW_VIEW_MAX) {
      try { raw = new Uint8Array(await (await fetchBlob(a)).arrayBuffer()); } catch {}
      if (raw && raw.length > RAW_VIEW_MAX) raw = null;
    }
    if (stale()) return;
    const text = raw && asText(raw);
    body.innerHTML = center(`No preview available for this file${e instanceof NoPreview ? "" : ` (${esc(e.message)})`}. ` +
      (raw ? `<button id="v-raw">${text != null ? "View as text" : "View as binary"}</button> ` : "") + `<button id="v-dl2">Download</button>`);
    $("v-dl2").onclick = () => download(a);
    if (raw) $("v-raw").onclick = () => showRaw(ctx, raw, text);
  }
}

const RAW_VIEW_MAX = 100 * 1024;
async function showRaw(ctx, raw, text) {
  const { a, body, stale, meta } = ctx;
  body.innerHTML = center("Loading...");
  meta(text != null ? "as text" : "as binary");
  try {
    if (text != null) await sandboxed(ctx, { kind: "text", text: text.replace(/[\x00-\x08\x0b\x0e-\x1a\x1c-\x1f\x7f]/g, "\u00b7"), ext: "txt" });
    else await sandboxed(ctx, { kind: "text", text: hexDump(raw), ext: "txt", source: "hex", size: raw.length });
  } catch (e) {
    if (stale()) return;
    body.innerHTML = center(`Could not show the file (${esc(e.message)}). <button id="v-dl2">Download</button>`);
    $("v-dl2").onclick = () => download(a);
  }
}

// ---------- sandboxed rendering ----------
// Files are parsed and drawn by render.html, a manifest sandbox page: opaque origin, no cookies,
// no extension APIs, no network beyond its own files (see render.js). Messages from it are
// treated as untrusted: only known types are acted on, and links are checked before opening.
const SAFE_LINK = /^(https?:|mailto:)/i;
const CHUNK = 3;

function sandboxed(ctx, request) {
  const { a, body, stale, meta } = ctx;
  if (stale()) return Promise.resolve();      // its bytes came after the user moved on
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.className = "v-box";
    frame.title = "Preview";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.visibility = "hidden";
    const send = (m, transfer) => frame.contentWindow?.postMessage(m, "*", transfer || []);
    // 30 s for the sandbox to start, then 2 minutes to render; a preview that fails takes its
    // frame with it, so a fallback never sits next to a frame still drawing.
    const fail = message => { clearTimeout(timer); window.removeEventListener("message", onMessage); frame.remove(); reject(new Error(message)); };
    let timer = setTimeout(() => fail("the preview did not start"), 30000);
    const onMessage = async e => {
      if (e.source !== frame.contentWindow || stale()) return;
      const m = e.data || {};
      switch (m.type) {
        case "ready":
          clearTimeout(timer);
          timer = setTimeout(() => fail("the preview took too long"), 120000);
          send({ type: "render", ...request, palette: palette() }, request.bytes ? [request.bytes] : []);
          break;
        case "done":
          clearTimeout(timer);
          frame.style.visibility = "";
          body.querySelector(".v-center")?.remove();
          frame.focus();
          resolve();
          break;
        case "error":
          fail(String(m.message || "preview failed").slice(0, 200));
          break;
        case "meta":
          meta(String(m.text || "").slice(0, 120));
          break;
        case "zoomable":
          $("v-fit").title = "Fit width (0)";
          $("v-zoom").classList.remove("hidden");
          if (current) current.zoom = dir => send({ type: "zoom", dir });
          break;
        case "link":
          if (typeof m.href === "string" && SAFE_LINK.test(m.href.trim())) window.open(m.href.trim(), "_blank", "noopener,noreferrer");
          break;
        case "key":
          if (["Escape", "ArrowLeft", "ArrowRight"].includes(m.key)) onKey({ key: m.key, preventDefault() {} });
          break;
        case "more":
          if (request.kind !== "pages" || !Number.isInteger(m.next) || m.next < 1 || m.next > request.total) break;
          try {
            const r = await fetchPages(a.documentId, m.next, Math.min(request.total, m.next + CHUNK - 1), stale);
            if (r && !stale()) send({ type: "pages", pages: r.pages.map(p => ({ html: p.html, css: p.css })) });
          } catch (err) { send({ type: "pages", error: err.message }); }
          break;
      }
    };
    window.addEventListener("message", onMessage);
    current = { cleanup: () => { clearTimeout(timer); window.removeEventListener("message", onMessage); } };
    frame.src = "render.html";
    body.appendChild(frame);
  });
}

// ----- Formats with no renderer here: the provider's converter (pages load as you scroll), then its text -----
const PENDING = new Set([605, 612, 621, 814]);

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
  const { a, stale } = ctx;
  if (!a.documentId || !hooks.docPages) return showText(ctx);
  const first = await fetchPages(a.documentId, 1, CHUNK, stale);
  if (!first || stale()) return;
  const total = first.total || first.pages.length;
  await sandboxed(ctx, { kind: "pages", total, pages: first.pages.map(p => ({ html: p.html, css: p.css })), provider: hooks.providerName });
}

// Nothing here draws the file and the provider has neither a converter nor its text: the notice
// says as much by itself, with no reason to add.
class NoPreview extends Error {}

async function showText(ctx) {
  const { a, k, stale } = ctx;
  if (!hooks.extractText) throw new NoPreview("no preview available");
  const text = await hooks.extractText(a);
  if (stale()) return;
  await sandboxed(ctx, { kind: "text", text, ext: extOf(a.filename), source: k === "text" || k === "code" ? "stored" : "extracted", provider: hooks.providerName });
}

// ---------- download / open ----------
function save(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob); link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

export async function download(a) {
  try {
    save(await fetchBlob(a), noBidi(a.filename || "attachment"));
  } catch {
    // The provider's own link, when it has one: a background tab follows it and saves the original.
    const u = hooks.originalUrl?.(a);
    if (u) chrome.tabs.create({ url: u, active: false }); else hooks.status("could not fetch the attachment");
  }
}

// Several files saved as one ZIP file named after name (a subject, a folder): list holds them,
// each with its message's id (msgId) and date (date, epoch seconds), which the file in the ZIP
// takes. They are fetched one message at a time, with the provider's pause between messages
// (limits.fetchGap), each file put into the archive as it comes; one that cannot be fetched is
// left out and named afterwards. ZIP_MAX caps the files and the bytes, by the sizes the provider
// lists; Esc stops it (cancelZip). One file alone is saved as itself.
export const ZIP_MAX = { files: 100, bytes: 100 * 1048576 };
let zipping = null;          // { cancelled } while a ZIP is being put together
const dateOf = epoch => { const d = new Date(Number(epoch) * 1000); return isNaN(d) ? new Date() : d; };
const named = (list, most = 10) => list.slice(0, most).map(a => `"${noBidi(a.filename || "attachment")}"`).join(", ") + (list.length > most ? ` and ${list.length - most} more` : "");

export function cancelZip() {
  if (!zipping) return false;
  zipping.cancelled = true;
  zipping = null;
  hooks.status("ZIP download cancelled");
  return true;
}

export async function downloadZip(list, name) {
  if (!list.length) return;
  if (list.length === 1) return download(list[0]);
  if (zipping) { hooks.status("a ZIP file is still being made (Esc cancels it)"); return; }
  const total = list.reduce((s, a) => s + (a.size || 0), 0);
  if (list.length > ZIP_MAX.files || total > ZIP_MAX.bytes) {
    hooks.notify(`Too much for one ZIP file: ${plural(list.length, "attachment")}, ${sizeStr(total)}. Select at most ${ZIP_MAX.files} attachments and ${Math.round(ZIP_MAX.bytes / 1048576)} MB.`);
    return;
  }
  const run = zipping = { cancelled: false };
  const zip = zipWriter(), taken = new Set(), missing = [], byMessage = new Map();
  for (const a of list) byMessage.set(a.msgId, [...(byMessage.get(a.msgId) || []), a]);
  let done = 0;
  try {
    for (const [n, files] of [...byMessage.values()].entries()) {
      if (n && hooks.limits?.fetchGap) await sleep(hooks.limits.fetchGap);
      for (const a of files) {
        if (run.cancelled) return;
        hooks.status(`downloading ${++done} of ${list.length} attachments (Esc cancels)`);
        let got = null;
        try { got = await hooks.bytes(a.msgId, a); } catch {}
        if (run.cancelled) return;
        if (got?.bytes) zip.add(uniqueName(flatName(a.filename) || "attachment", taken), got.bytes, dateOf(a.date));
        else missing.push(a);
      }
    }
  } catch (e) {
    if (!run.cancelled) hooks.notify(`Could not make the ZIP file (${e.message}).`);
    return;
  } finally { if (zipping === run) zipping = null; }
  if (!zip.count) { hooks.notify(`Could not fetch the attachments, so no ZIP file was saved: ${named(missing)}.`); return; }
  const file = `${flatName(name) || "attachments"}.zip`, blob = new Blob(zip.finish(), { type: "application/zip" });
  save(blob, file);
  hooks.status(`${file}: ${plural(zip.count, "attachment")}, ${sizeStr(blob.size)}`);
  if (missing.length) hooks.notify(`Left out of ${file}, as ${missing.length === 1 ? "it" : "they"} could not be fetched: ${named(missing)}.`);
}

// A blob opened in a tab is shown under the extension's own address, so only types the browser
// displays inertly are opened that way, and the type comes from the file name, never from the
// sender's MIME header. Anything else is downloaded instead.
const OPEN_SAFE = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", m4v: "video/mp4" };

async function openInTab(a) {
  const k = kindOf(a), ext = extOf(a.filename);
  const type = OPEN_SAFE[ext] || (k === "text" || k === "code" ? "text/plain;charset=utf-8" : null);
  if (!type) return download(a);
  try {
    const blob = await fetchBlob(a);
    const u = URL.createObjectURL(new Blob([type.startsWith("text/") ? await textOf(blob) : blob], { type }));
    window.open(u, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  } catch {
    const u = hooks.originalUrl?.(a);
    if (u) chrome.tabs.create({ url: u }); else hooks.status("could not fetch the attachment");
  }
}
