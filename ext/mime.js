// Minimal MIME reader: pulls one attachment's bytes out of a raw RFC 822 message. Parts are
// numbered the IMAP way (1, 2, 2.1, ...), which is how Yahoo's partId counts them.

const latin1 = bytes => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return s;
};

// Limits that keep a hostile message from making parsing slow: every search stays inside its own
// part, header blocks are bounded, and so are the number of parts and the nesting depth.
const HEADER_MAX = 256 * 1024, MAX_PARTS = 1000, MAX_DEPTH = 16;

function head(s, start, end) {
  // a part that starts with its blank line has no headers
  if (s.startsWith("\r\n", start)) return { headers: {}, bodyStart: start + 2 };
  if (s[start] === "\n") return { headers: {}, bodyStart: start + 1 };
  const block = s.slice(start, Math.min(end, start + HEADER_MAX));
  const a = block.indexOf("\r\n\r\n"), b = block.indexOf("\n\n");
  let he = end, bs = end;
  if (a >= 0 && (b < 0 || a < b)) { he = start + a; bs = he + 4; }
  else if (b >= 0) { he = start + b; bs = he + 2; }
  const headers = {};
  for (const line of s.slice(start, he).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c > 0) { const k = line.slice(0, c).trim().toLowerCase(); if (!(k in headers)) headers[k] = line.slice(c + 1).trim(); }
  }
  return { headers, bodyStart: bs };
}

// "type/sub; a=1; b*=utf-8''x%20y; c*0=..; c*1=.." -> { value, params }. A parameter given both
// plainly and in RFC 2231 form (filename and filename*) takes the RFC 2231 value; the plain one is
// the fallback for clients that cannot read the other.
function parseParams(v) {
  const out = { value: "", params: {} };
  const parts = []; let cur = "", q = false;
  for (const ch of v || "") {
    if (ch === '"') { q = !q; cur += ch; }
    else if (ch === ";" && !q) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);
  out.value = parts.shift().trim().toLowerCase();
  const pieces = {}, plain = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    let k = p.slice(0, eq).trim().toLowerCase(), val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = k.match(/^([^*]+)(?:\*(\d+))?(\*)?$/);
    if (!m) continue;
    if (m[2] === undefined && !m[3]) { if (!(m[1] in plain)) plain[m[1]] = val; continue; }
    (pieces[m[1]] ||= []).push({ n: Number(m[2] || 0), enc: !!m[3], val });
  }
  for (const [k, list] of Object.entries(pieces)) {
    list.sort((x, y) => x.n - y.n);
    let charset = null;
    const bytes = [];
    const add = t => { for (let j = 0; j < t.length; j++) bytes.push(t.charCodeAt(j) & 255); };   // no spread: a value can be huge
    for (const [i, p] of list.entries()) {
      let val = p.val;
      if (p.enc) {
        if (i === 0) { const m = val.match(/^([^']*)'[^']*'(.*)$/); if (m) { charset = m[1] || "utf-8"; val = m[2]; } }
        add(unescape(val));
      } else add(val);
    }
    out.params[k] = charset ? decodeBytes(new Uint8Array(bytes), charset) : list.map(p => p.val).join("");
  }
  for (const [k, val] of Object.entries(plain)) if (!(k in out.params)) out.params[k] = val;
  return out;
}

function decodeBytes(bytes, charset) {
  try { return new TextDecoder(charset || "utf-8").decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

// RFC 2047 encoded words, as seen in attachment names.
function decodeWords(s) {
  return String(s || "").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (m, cs, enc, text) => {
    try {
      const bin = enc.toLowerCase() === "b" ? atob(text) : text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16)));
      return decodeBytes(Uint8Array.from(bin, c => c.charCodeAt(0)), cs);
    } catch { return m; }
  });
}

function splitParts(s, start, end, boundary) {
  const delim = "--" + boundary, out = [];
  const region = s.slice(start, end);                 // searches cannot run past this part
  const find = from => {
    for (let k = from - start; ;) {
      k = region.indexOf(delim, k);
      if (k < 0) return -1;
      // a delimiter starts a line and ends it (after an optional closing "--"): --X is not --X-1
      const after = region.slice(k + delim.length, k + delim.length + 2) === "--" ? k + delim.length + 2 : k + delim.length;
      if ((k === 0 || region[k - 1] === "\n") && /^[ \t]*(\r?\n|$)/.test(region.slice(after, after + 80))) return start + k;
      k += delim.length;
    }
  };
  let cur = -1, k = find(start), closed = false;
  while (k >= 0 && out.length < MAX_PARTS) {
    if (cur >= 0) { let e = k; if (s[e - 1] === "\n") e--; if (s[e - 1] === "\r") e--; out.push([cur, Math.max(cur, e)]); }
    if (s.startsWith("--", k + delim.length)) { closed = true; break; }
    const nl = s.indexOf("\n", k);
    cur = nl < 0 || nl >= end ? end : nl + 1;
    k = find(cur);
  }
  if (!closed && cur >= 0 && cur < end) out.push([cur, end]);
  return out;
}

function walk(s, start, end, num, out, depth = 0) {
  if (out.length >= MAX_PARTS) return;
  const { headers, bodyStart } = head(s, start, end);
  const ct = parseParams(headers["content-type"] || "text/plain");
  if (ct.value.startsWith("multipart/") && ct.params.boundary && depth < MAX_DEPTH) {
    splitParts(s, bodyStart, end, ct.params.boundary).forEach(([a, b], i) => walk(s, a, b, num ? `${num}.${i + 1}` : String(i + 1), out, depth + 1));
    return;
  }
  const cd = parseParams(headers["content-disposition"] || "");
  const inner = ct.value === "message/rfc822" && depth < MAX_DEPTH;
  out.push({
    partId: num || "1", type: ct.value, start: bodyStart, end,
    encoding: (headers["content-transfer-encoding"] || "").trim().toLowerCase(),
    filename: decodeWords(rawUtf8(cd.params.filename || ct.params.name || "")),
  });
  // A forwarded message's own parts are numbered under it, the IMAP way: 2.1, 2.2, ...
  if (inner) walkMessage(s, bodyStart, end, num || "1", out, depth + 1);
}

function walkMessage(s, start, end, num, out, depth) {
  const { headers, bodyStart } = head(s, start, end);
  const ct = parseParams(headers["content-type"] || "text/plain");
  if (ct.value.startsWith("multipart/") && ct.params.boundary) {
    splitParts(s, bodyStart, end, ct.params.boundary).forEach(([a, b], i) => walk(s, a, b, `${num}.${i + 1}`, out, depth + 1));
  } else walk(s, start, end, `${num}.1`, out, depth + 1);
}

// Header text is read byte for byte; a name some clients write as raw UTF-8 is decoded as such
// when it is valid UTF-8, and left as it is otherwise.
function rawUtf8(v) {
  if (!/[\x80-\xff]/.test(v) || /[^\x00-\xff]/.test(v)) return v;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(v, c => c.charCodeAt(0))); } catch { return v; }
}

export function listParts(bytes) {
  const s = latin1(bytes), out = [];
  walk(s, 0, s.length, "", out);
  return { s, parts: out };
}

function decodeBody(s, p) {
  const body = s.slice(p.start, p.end);
  let bin;
  if (p.encoding === "base64") bin = atob(body.replace(/[^A-Za-z0-9+/=]/g, "").replace(/=+(?=[A-Za-z0-9+/])/g, ""));
  // quoted-printable: whitespace at a line end is padding, also after a soft break's "="
  else if (p.encoding === "quoted-printable") bin = body.replace(/=[ \t]*\r?\n/g, "").replace(/[ \t]+(?=\r?\n|$)/g, "").replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16)));
  else bin = body;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const norm = n => String(n || "").normalize("NFC").trim().toLowerCase();

// The part Yahoo calls partId, cross-checked by filename (some servers number differently).
export function extract(parsed, partId, filename) {
  const { s, parts } = parsed;
  let p = parts.find(x => x.partId === String(partId));
  if (filename && (!p || norm(p.filename) !== norm(filename))) p = parts.find(x => norm(x.filename) === norm(filename)) || p;
  if (!p) throw new Error("attachment not found in message source");
  return { bytes: decodeBody(s, p), type: p.type, filename: p.filename };
}
