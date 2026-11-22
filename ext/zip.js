// A ZIP archive written as it is filled: each file is stored as it is (method 0, no compression),
// with its CRC-32, its date and a UTF-8 name, and its bytes go into a Blob at once, so a large
// archive is never one buffer. finish() adds the central directory and gives the Blob parts.
// Without ZIP64 an archive holds at most 65,535 files and 4 GB, far above what the client puts in
// one. The names a caller gives are used as they are; flatName and uniqueName make them safe.
// JSZip reads ZIP files in the sandbox (render.js); writing needs none of it.

import { noBidi } from "./text.js";

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

// The CRC-32 of bytes (the ZIP and PNG checksum), carried on from crc when given.
export function crc32(bytes, crc = 0) {
  let c = (~crc) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

// A date in the two 16-bit words of MS-DOS, in local time to two seconds, as unzip tools show
// it; the years it can hold are 1980 to 2107.
export function dosDateTime(when) {
  const d = when instanceof Date && !isNaN(when) ? when : new Date();
  const y = d.getFullYear();
  if (y < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (y > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return { date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2) };
}

// A sender's file name as a name with no folder in it, which no unzip tool and no file system
// takes for anything else: bidi controls and control characters go, path separators and the
// characters Windows refuses become "_", a trailing dot or space goes (Windows drops them), and
// a device name (CON, NUL, COM1...) gets "_" in front. A long name is cut to MAX_NAME characters,
// keeping its extension. "" when nothing is left.
const MAX_NAME = 150;
export function flatName(name) {
  let s = noBidi(name).normalize("NFC").replace(/[\x00-\x1f\x7f]/g, "").replace(/[\\/:*?"<>|]/g, "_").trim();
  const chars = [...s];
  if (chars.length > MAX_NAME) {
    const ext = [...(s.match(/\.[^.]{1,10}$/)?.[0] || "")];
    s = chars.slice(0, MAX_NAME - ext.length).join("").trimEnd() + ext.join("");
  }
  s = s.replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s)) s = `_${s}`;
  return s;
}

// name, or when taken already (ignoring case, as Windows and macOS do) "name (2).ext", then (3)
// and on; the name given back is added to taken, a Set of lower-cased names.
export function uniqueName(name, taken) {
  const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${stem} (${n})${ext}`;
  taken.add(out.toLowerCase());
  return out;
}

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const VERSION = 20;          // 2.0, made on MS-DOS: plain files, no Unix modes
const UTF8 = 0x0800;         // general purpose flag bit 11: the name is UTF-8
const MAX_U16 = 0xffff, MAX_U32 = 0xffffffff;

// The extended timestamp field (0x5455): the modification time in Unix seconds, the exact
// moment where the MS-DOS date has no time zone.
function stamp(when) {
  const secs = Math.max(0, Math.min(0x7fffffff, Math.floor((when instanceof Date && !isNaN(when) ? when : new Date()).getTime() / 1000)));
  const b = new Uint8Array(9), v = new DataView(b.buffer);
  v.setUint16(0, 0x5455, true); v.setUint16(2, 5, true); v.setUint8(4, 1); v.setUint32(5, secs, true);
  return b;
}

export function zipWriter() {
  const parts = [], central = [], enc = new TextEncoder();
  let offset = 0, count = 0, finished = false;
  return {
    get count() { return count; },
    // One file: name as stored, bytes (an ArrayBuffer or a view of one), when (a Date) its date.
    add(name, bytes, when) {
      if (finished) throw new Error("the ZIP is finished");
      const data = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
      const nameBytes = enc.encode(name), extra = stamp(when), { date, time } = dosDateTime(when), crc = crc32(data);
      if (count + 1 > MAX_U16 || nameBytes.length > MAX_U16 || offset + 30 + nameBytes.length + extra.length + data.length > MAX_U32) throw new Error("too large for a ZIP file");
      const head = new Uint8Array(30 + nameBytes.length + extra.length), h = new DataView(head.buffer);
      h.setUint32(0, SIG_LOCAL, true); h.setUint16(4, VERSION, true); h.setUint16(6, UTF8, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, nameBytes.length, true); h.setUint16(28, extra.length, true);
      head.set(nameBytes, 30); head.set(extra, 30 + nameBytes.length);
      const entry = new Uint8Array(46 + nameBytes.length + extra.length), c = new DataView(entry.buffer);
      c.setUint32(0, SIG_CENTRAL, true); c.setUint16(4, VERSION, true); c.setUint16(6, VERSION, true); c.setUint16(8, UTF8, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, nameBytes.length, true); c.setUint16(30, extra.length, true);
      // comment length, disk, internal and external attributes stay 0
      c.setUint32(42, offset, true);
      entry.set(nameBytes, 46); entry.set(extra, 46 + nameBytes.length);
      parts.push(head, new Blob([data]));
      central.push(entry);
      offset += head.length + data.length;
      count++;
    },
    // The archive's parts, for new Blob(parts, { type: "application/zip" }).
    finish() {
      if (!finished) {
        const size = central.reduce((s, e) => s + e.length, 0);
        if (offset + size > MAX_U32) throw new Error("too large for a ZIP file");
        const end = new Uint8Array(22), v = new DataView(end.buffer);
        v.setUint32(0, SIG_END, true); v.setUint16(8, count, true); v.setUint16(10, count, true);
        v.setUint32(12, size, true); v.setUint32(16, offset, true);
        parts.push(...central, end);
        finished = true;
      }
      return parts;
    },
  };
}
