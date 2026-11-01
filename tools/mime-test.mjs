// Attachment names as mail clients write them, through ext/mime.js. node tools/mime-test.mjs
import { listParts } from "../ext/mime.js";

let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
const message = disposition => new TextEncoder().encode("From: a@x\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n" +
  "--B\r\nContent-Type: text/plain\r\n\r\nbody\r\n" +
  `--B\r\nContent-Type: application/pdf\r\nContent-Disposition: ${disposition}\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERg==\r\n--B--\r\n`);
const name = disposition => listParts(message(disposition)).parts[1]?.filename;

ok(name(`attachment; filename="resume.pdf"; filename*=utf-8''r%C3%A9sum%C3%A9.pdf`) === "résumé.pdf", "filename* wins over filename: " + name(`attachment; filename="resume.pdf"; filename*=utf-8''r%C3%A9sum%C3%A9.pdf`));
ok(name(`attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf; filename="resume.pdf"`) === "résumé.pdf", "in either order");
ok(name(`attachment;\r\n filename*0*=utf-8''Quarterly%20; filename*1*=r%C3%A9port; filename*2=.pdf`) === "Quarterly réport.pdf", "continuations joined and decoded: " + name(`attachment;\r\n filename*0*=utf-8''Quarterly%20; filename*1*=r%C3%A9port; filename*2=.pdf`));
ok(name(`attachment; filename="plain \\"quoted\\".pdf"`) === 'plain "quoted".pdf', "plain quoted name with escapes");
ok(name(`attachment; filename="=?UTF-8?B?w6l0w6kucGRm?="`) === "été.pdf", "RFC 2047 encoded word: " + name(`attachment; filename="=?UTF-8?B?w6l0w6kucGRm?="`));
ok(name(`attachment`) === "", "no name");

console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
