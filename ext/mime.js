// Minimal MIME reader: pulls one attachment's bytes out of a raw RFC 822 message. Parts are
// numbered the IMAP way (1, 2, 2.1, ...), which is how Yahoo's partId counts them.

const latin1 = bytes => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return s;
};

function head(s, start, end) {
  const a = s.indexOf("\r\n\r\n", start), b = s.indexOf("\n\n", start);
  let he = end, bs = end;
  if (a >= 0 && a < end && (b < 0 || a < b)) { he = a; bs = a + 4; }
  else if (b >= 0 && b < end) { he = b; bs = b + 2; }
  const headers = {};
  for (const line of s.slice(start, he).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c > 0) { const k = line.slice(0, c).trim().toLowerCase(); if (!(k in headers)) headers[k] = line.slice(c + 1).trim(); }
  }
  return { headers, bodyStart: bs };
}

// "type/sub; a=1; b*=utf-8''x%20y; c*0=..; c*1=.." -> { value, params }
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
  const pieces = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    let k = p.slice(0, eq).trim().toLowerCase(), val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = k.match(/^([^*]+)(?:\*(\d+))?(\*)?$/);
    if (!m) continue;
    (pieces[m[1]] ||= []).push({ n: Number(m[2] || 0), enc: !!m[3], val });
  }
  for (const [k, list] of Object.entries(pieces)) {
    list.sort((x, y) => x.n - y.n);
    let charset = null, bytes = [];
    for (const [i, p] of list.entries()) {
      let val = p.val;
      if (p.enc) {
        if (i === 0) { const m = val.match(/^([^']*)'[^']*'(.*)$/); if (m) { charset = m[1] || "utf-8"; val = m[2]; } }
        bytes.push(...unescape(val).split("").map(c => c.charCodeAt(0) & 255));
      } else bytes.push(...[...val].map(c => c.charCodeAt(0) & 255));
    }
    out.params[k] = charset ? decodeBytes(new Uint8Array(bytes), charset) : list.map(p => p.val).join("");
  }
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
  const find = from => {
    for (let k = from; ;) {
      k = s.indexOf(delim, k);
      if (k < 0 || k >= end) return -1;
      if (k === start || s[k - 1] === "\n") return k;
      k += delim.length;
    }
  };
  let cur = -1, k = find(start), closed = false;
  while (k >= 0) {
    if (cur >= 0) { let e = k; if (s[e - 1] === "\n") e--; if (s[e - 1] === "\r") e--; out.push([cur, Math.max(cur, e)]); }
    if (s.startsWith("--", k + delim.length)) { closed = true; break; }
    const nl = s.indexOf("\n", k);
    cur = nl < 0 || nl >= end ? end : nl + 1;
    k = find(cur);
  }
  if (!closed && cur >= 0 && cur < end) out.push([cur, end]);
  return out;
}

function walk(s, start, end, num, out) {
  const { headers, bodyStart } = head(s, start, end);
  const ct = parseParams(headers["content-type"] || "text/plain");
  if (ct.value.startsWith("multipart/") && ct.params.boundary) {
    splitParts(s, bodyStart, end, ct.params.boundary).forEach(([a, b], i) => walk(s, a, b, num ? `${num}.${i + 1}` : String(i + 1), out));
    return;
  }
  const cd = parseParams(headers["content-disposition"] || "");
  out.push({
    partId: num || "1", type: ct.value, start: bodyStart, end,
    encoding: (headers["content-transfer-encoding"] || "").trim().toLowerCase(),
    filename: decodeWords(cd.params.filename || ct.params.name || ""),
  });
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
  else if (p.encoding === "quoted-printable") bin = body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16)));
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
