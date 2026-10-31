// Golden values for the text-or-binary check and the hex dump in ext/bytes.js. node tools/bytes-test.mjs
import { asText, hexDump } from "../ext/bytes.js";

const enc = s => new TextEncoder().encode(s);
let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
ok(asText(enc("hello, world\r\n\ttabbed\n")) === "hello, world\r\n\ttabbed\n", "ASCII text");
ok(asText(enc("Žolnai čevapčići 日本語")) === "Žolnai čevapčići 日本語", "UTF-8 text");
ok(asText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x6f, 0x6b])) === "café – ok", "Windows-1252 text");
ok(asText(new Uint8Array([0xff, 0xfe, 0x68, 0, 0x69, 0])) === "hi", "UTF-16LE with BOM");
ok(asText(new Uint8Array([0xfe, 0xff, 0, 0x68, 0, 0x69])) === "hi", "UTF-16BE with BOM");
ok(asText(new Uint8Array([])) === "", "empty file is text");
ok(asText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])) === null, "PNG is binary");
ok(asText(new Uint8Array([0x50, 0x4b, 3, 4, 0x14, 0, 0, 0])) === null, "ZIP is binary");
const noisy = enc("x".repeat(97) + "\x01\x02\x03"); ok(asText(noisy) === null, "3% control characters is binary");
const quiet = enc("x".repeat(199) + "\x01"); ok(asText(quiet) !== null, "0.5% control characters is text");
ok(asText(enc("\x1b[31mred\x1b[0m")) !== null, "ANSI escapes are text");
ok(hexDump(enc("ABCDEFGHIJKLMNOPQ\n")) ===
  "00000000  41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50  ABCDEFGHIJKLMNOP\n" +
  "00000010  51 0a                                             Q.", "hex dump layout");
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
