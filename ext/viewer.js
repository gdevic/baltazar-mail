// Attachment strip under the message body and an in-app viewer for the common formats.
// Files are fetched by the extension with the session cookies and shown from blob: URLs, so
// nothing is handed to Yahoo's own viewer and nothing leaves the browser.

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

let hooks = null;   // { thumb(a) -> Promise<dataUrl|null>, cleanHtml(html), status(msg) }
let items = [], index = 0, msgId = null;
const blobCache = new Map();     // downloadUrl -> Promise<Blob>
let objectUrls = [];

export function init(h) {
  hooks = h;
  $("v-close").onclick = close;
  $("v-prev").onclick = () => show(index - 1);
  $("v-next").onclick = () => show(index + 1);
  $("v-dl").onclick = () => download(items[index]);
  $("v-open").onclick = () => openInTab(items[index]);
  $("viewer").onclick = e => { if (e.target.id === "viewer") close(); };
}

export function isOpen() { return !$("viewer").classList.contains("hidden"); }

export function onKey(e) {
  if (e.key === "Escape") close();
  else if (e.key === "ArrowLeft") show(index - 1);
  else if (e.key === "ArrowRight") show(index + 1);
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
async function fetchBlob(a) {
  if (!blobCache.has(a.downloadUrl)) {
    blobCache.set(a.downloadUrl, (async () => {
      const resp = await fetch(a.downloadUrl.replace(/&amp;/g, "&"), { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.blob();
    })());
  }
  try { return await blobCache.get(a.downloadUrl); }
  catch (e) { blobCache.delete(a.downloadUrl); throw e; }
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

// ---------- viewer ----------
function close() {
  $("viewer").classList.add("hidden");
  $("v-body").innerHTML = "";
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

const center = html => `<div class="v-center">${html}</div>`;
const note = text => `<div class="v-note">${esc(text)}</div>`;

async function show(i) {
  if (!items.length) return;
  index = (i + items.length) % items.length;
  const a = items[index], k = kindOf(a), id = msgId, at = index;
  $("viewer").classList.remove("hidden");
  $("v-name").textContent = a.filename || "Untitled";
  $("v-meta").textContent = `${sizeStr(a.size)} · ${LABEL[k]}${items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}`;
  $("v-prev").disabled = $("v-next").disabled = items.length < 2;
  const body = $("v-body");
  body.innerHTML = center("Loading…");
  const stale = () => msgId !== id || index !== at || !isOpen();
  try {
    if (k === "doc" || k === "sheet" || k === "slide") {
      const t = await extractedText(a);
      if (stale()) return;
      body.innerHTML = note("Text extracted by Yahoo; layout and formatting are not shown. Download for the original.") + `<pre></pre>`;
      body.querySelector("pre").textContent = t || "(no text)";
      return;
    }
    const blob = await fetchBlob(a);
    if (stale()) return;
    const ext = extOf(a.filename);
    if (k === "image") {
      body.innerHTML = `<img class="v-img" alt="">`;
      const img = body.querySelector("img");
      img.src = objectUrl(blob, MIME[ext]);
      img.onclick = () => img.classList.toggle("full");
    } else if (k === "pdf") {
      body.innerHTML = `<iframe title="PDF"></iframe>`;
      body.querySelector("iframe").src = objectUrl(blob, "application/pdf");
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
    } else if (k === "text" || k === "code") {
      if (blob.size > 3 * 1048576) { body.innerHTML = center(`Too large to preview (${sizeStr(blob.size)}). <button id="v-dl2">Download</button>`); $("v-dl2").onclick = () => download(a); return; }
      let text = await blob.text();
      if (ext === "csv" || ext === "tsv") { renderTable(body, text, ext === "tsv" ? "\t" : null); return; }
      if (ext === "json") { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
      body.innerHTML = "<pre></pre>";
      body.querySelector("pre").textContent = text;
    } else {
      // Unknown type: let Yahoo try to extract text, else offer the download.
      try {
        const t = await extractedText(a);
        if (stale()) return;
        if (t && t.trim()) { body.innerHTML = note("Text extracted by Yahoo. Download for the original.") + "<pre></pre>"; body.querySelector("pre").textContent = t; return; }
      } catch {}
      body.innerHTML = center(`No preview for this file type. <button id="v-dl2">Download</button>`);
      $("v-dl2").onclick = () => download(a);
    }
  } catch (e) {
    if (stale()) return;
    body.innerHTML = center(`Could not load the preview (${esc(e.message)}). <button id="v-dl2">Open in tab</button>`);
    $("v-dl2").onclick = () => openInTab(a);
  }
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
    link.href = objectUrl(blob);
    link.download = a.filename || "attachment";
    document.body.appendChild(link); link.click(); link.remove();
  } catch { openInTab(a); }
}

async function openInTab(a) {
  const k = kindOf(a), ext = extOf(a.filename);
  try {
    const blob = await fetchBlob(a);
    const u = URL.createObjectURL(new Blob([blob], { type: MIME[ext] || (k === "text" || k === "code" ? "text/plain;charset=utf-8" : blob.type) }));
    window.open(u, "_blank");
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  } catch { window.open(a.downloadUrl, "_blank"); }
}
