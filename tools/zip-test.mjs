// Golden values for the ZIP writer, ext/zip.js: the checksum, MS-DOS dates, the names files take,
// the bytes of an archive, and an archive read back by the bundled JSZip. node tools/zip-test.mjs
import { createRequire } from "module";
import { crc32, dosDateTime, flatName, uniqueName, zipWriter } from "../ext/zip.js";

const JSZip = createRequire(import.meta.url)("../ext/vendor/jszip.min.js");
let fail = 0;
const eq = (got, want, what) => { if (got !== want) { fail++; console.log("FAIL", what, "got", JSON.stringify(got), "want", JSON.stringify(want)); } };
const bytes = s => new TextEncoder().encode(s);
const ch = (...codes) => String.fromCharCode(...codes);
const read = async parts => new Uint8Array(await new Blob(parts).arrayBuffer());

// CRC-32: the standard check value, a pangram, nothing, and a checksum carried on
eq(crc32(bytes("123456789")), 0xcbf43926, "crc of 123456789");
eq(crc32(bytes("The quick brown fox jumps over the lazy dog")), 0x414fa339, "crc of the pangram");
eq(crc32(new Uint8Array(0)), 0, "crc of nothing");
eq(crc32(bytes("56789"), crc32(bytes("1234"))), 0xcbf43926, "crc carried on");

// MS-DOS dates, in local time, two seconds apart, 1980 at the earliest
const when = new Date(2026, 10, 22, 14, 30, 47);
eq(JSON.stringify(dosDateTime(when)), JSON.stringify({ date: 23926, time: 29655 }), "22 November 2026, 14:30:47");
eq(JSON.stringify(dosDateTime(new Date(1970, 0, 1))), JSON.stringify({ date: 33, time: 0 }), "before 1980: 1 January 1980");
eq(JSON.stringify(dosDateTime(new Date(2200, 0, 1))), JSON.stringify({ date: 65439, time: 49021 }), "after 2107: its last moment");

// names: flat, and safe to unpack anywhere
eq(flatName("report.pdf"), "report.pdf", "a plain name");
eq(flatName("../../etc/passwd"), ".._.._etc_passwd", "no folder in it");
eq(flatName('a\\b/c:d*e?f"g<h>i|j.txt'), "a_b_c_d_e_f_g_h_i_j.txt", "the characters Windows refuses");
eq(flatName(`invoice${ch(0x202e)}fdp.exe`), "invoicefdp.exe", "a bidi override goes");
eq(flatName(`tab${ch(9)}and${ch(0)}nul.txt`), "tabandnul.txt", "control characters go");
eq(flatName("  notes.txt. . "), "notes.txt", "spaces around it and trailing dots go");
eq(flatName("..."), "", "dots alone are nothing");
eq(flatName(""), "", "nothing");
eq(flatName("CON"), "_CON", "a device name");
eq(flatName("nul.txt"), "_nul.txt", "a device name with an extension");
eq(flatName("console.txt"), "console.txt", "a name that only starts like one");
eq(flatName(`e${ch(0x301)}t${ch(0xe9)}.txt`), `${ch(0xe9)}t${ch(0xe9)}.txt`, "composed (NFC)");
eq(flatName(`${"x".repeat(200)}.pdf`), `${"x".repeat(146)}.pdf`, "a long name is cut, keeping its extension");
eq(flatName("y".repeat(160)), "y".repeat(150), "a long name without an extension");

const taken = new Set();
const unique = ["a.pdf", "A.PDF", "a.pdf", "a (2).pdf", "b", "b", ".env", ".env"].map(n => uniqueName(n, taken));
eq(unique.join("|"), "a.pdf|A (2).PDF|a (3).pdf|a (2) (2).pdf|b|b (2)|.env|.env (2)", "repeated names, ignoring case");

// an empty archive is its end record alone
{
  const got = await read(zipWriter().finish());
  eq(Array.from(got).join(","), "80,75,5,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0", "an empty archive");
}

// one file, field by field: local header, central directory, end record
{
  const w = zipWriter();
  w.add("check.txt", bytes("123456789"), when);
  const got = await read(w.finish()), v = new DataView(got.buffer);
  const local = 30 + 9 + 9 + 9, central = 46 + 9 + 9;
  eq(got.length, local + central + 22, "one file: size");
  eq(v.getUint32(0, true), 0x04034b50, "local: signature");
  eq(v.getUint16(4, true), 20, "local: version needed");
  eq(v.getUint16(6, true), 0x0800, "local: UTF-8 names");
  eq(v.getUint16(8, true), 0, "local: stored");
  eq(v.getUint16(10, true), 29655, "local: time");
  eq(v.getUint16(12, true), 23926, "local: date");
  eq(v.getUint32(14, true), 0xcbf43926, "local: crc");
  eq(v.getUint32(18, true), 9, "local: compressed size");
  eq(v.getUint32(22, true), 9, "local: size");
  eq(v.getUint16(26, true), 9, "local: name length");
  eq(v.getUint16(28, true), 9, "local: extra length");
  eq(new TextDecoder().decode(got.slice(30, 39)), "check.txt", "local: name");
  eq(v.getUint16(39, true), 0x5455, "local: extended timestamp");
  eq(v.getUint16(41, true), 5, "local: its size");
  eq(v.getUint8(43), 1, "local: modification time only");
  eq(v.getUint32(44, true), Math.floor(when.getTime() / 1000), "local: Unix time");
  eq(new TextDecoder().decode(got.slice(48, 57)), "123456789", "the bytes, stored");
  const c = local;
  eq(v.getUint32(c, true), 0x02014b50, "central: signature");
  eq(v.getUint16(c + 4, true), 20, "central: made by");
  eq(v.getUint16(c + 8, true), 0x0800, "central: UTF-8 names");
  eq(v.getUint32(c + 16, true), 0xcbf43926, "central: crc");
  eq(v.getUint32(c + 42, true), 0, "central: where its local header is");
  eq(new TextDecoder().decode(got.slice(c + 46, c + 55)), "check.txt", "central: name");
  const e = local + central;
  eq(v.getUint32(e, true), 0x06054b50, "end: signature");
  eq(v.getUint16(e + 8, true), 1, "end: entries here");
  eq(v.getUint16(e + 10, true), 1, "end: entries in all");
  eq(v.getUint32(e + 12, true), central, "end: central directory size");
  eq(v.getUint32(e + 16, true), local, "end: central directory offset");
}

// read back by JSZip: names in other scripts, binary bytes, an empty file, a view into a larger
// buffer, the dates (JSZip reads the MS-DOS date as UTC), and every checksum checked
{
  const w = zipWriter();
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const big = new Uint8Array(300).fill(7), view = new Uint8Array(big.buffer, 100, 50);
  const files = [
    { name: `${ch(0x41f, 0x440, 0x438, 0x432, 0x435, 0x442)}.txt`, data: bytes("hello"), at: when },
    { name: `${ch(0x65e5, 0x672c)}.bin`, data: all, at: new Date(2001, 1, 3, 4, 5, 6) },
    { name: "empty.txt", data: new Uint8Array(0), at: when },
    { name: "view.bin", data: view, at: when },
    { name: "buffer.bin", data: bytes("abc").buffer, at: when },
  ];
  for (const f of files) w.add(f.name, f.data, f.at);
  eq(w.count, files.length, "entries counted");
  const blob = new Blob(w.finish(), { type: "application/zip" });
  let z = null;
  try { z = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true }); } catch (e) { fail++; console.log("FAIL JSZip could not read the archive:", e.message); }
  if (z) {
    eq(Object.keys(z.files).join("|"), files.map(f => f.name).join("|"), "JSZip: the names, in order");
    for (const f of files) {
      const entry = z.files[f.name];
      if (!entry) continue;
      const got = await entry.async("uint8array"), want = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
      eq(Array.from(got).join(","), Array.from(want).join(","), `JSZip: the bytes of ${f.name}`);
      eq(entry.dir, false, `JSZip: ${f.name} is a file`);
      const d = entry.date, at = f.at;
      eq([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()].join("-"), [at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()].join("-"), `JSZip: the date of ${f.name}`);
    }
  }
}

// nothing goes in once the archive is finished
{
  const w = zipWriter();
  w.finish();
  let threw = false;
  try { w.add("late.txt", bytes("x"), when); } catch { threw = true; }
  eq(threw, true, "no file after finish");
}

console.log(fail ? `zip: ${fail} FAILED` : "zip: PASS");
if (fail) process.exit(1);
