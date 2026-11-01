// Attachment names as mail clients write them, through ext/mime.js. node tools/mime-test.mjs
import { listParts, extract } from "../ext/mime.js";

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
// a huge RFC 2231 parameter decodes instead of overflowing the stack
{
  let got; try { got = name(`attachment; filename*=utf-8''${"a".repeat(300000)}.pdf`); } catch (e) { got = e.name; }
  ok(got?.length === 300004, "huge RFC 2231 parameter: " + String(got).slice(0, 40));
}

{
  const enc = t => new TextEncoder().encode(t);
  const dec = b => new TextDecoder().decode(b);
  // a boundary that is a prefix of a nested one does not cut the outer part short
  const nested = enc("Content-Type: multipart/mixed; boundary=\"X\"\r\n\r\n--X\r\nContent-Type: multipart/related; boundary=\"X-1\"\r\n\r\n" +
    "--X-1\r\nContent-Type: text/html\r\n\r\n<p>hi</p>\r\n--X-1\r\nContent-Type: image/png; name=\"a.png\"\r\nContent-Transfer-Encoding: base64\r\n\r\nUE5H\r\n--X-1--\r\n" +
    "--X\r\nContent-Type: application/pdf; name=\"b.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERg==\r\n--X--\r\n");
  const np = listParts(nested);
  ok(np.parts.map(p => p.partId).join() === "1.1,1.2,2" && dec(extract(np, "1.2", "a.png").bytes) === "PNG" && dec(extract(np, "2", "b.pdf").bytes) === "%PDF",
    "--X does not match --X-1: " + np.parts.map(p => `${p.partId}:${p.filename}`).join());
  // quoted-printable: trailing spaces on a line are padding; a soft break may carry them too
  const qp = listParts(enc("Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nline one   \r\nsoft=  \r\nbreak=3D\r\n"));
  ok(dec(extract(qp, "1").bytes) === "line one\r\nsoftbreak=\r\n", "quoted-printable whitespace: " + JSON.stringify(dec(extract(qp, "1").bytes)));
  // a part with no headers starts with its blank line; its first paragraph is body
  const bare = listParts(enc("Content-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\n\r\nFirst paragraph.\r\n\r\nSecond.\r\n--B--\r\n"));
  ok(dec(extract(bare, "1").bytes) === "First paragraph.\r\n\r\nSecond.", "headerless part keeps its first paragraph: " + JSON.stringify(dec(extract(bare, "1").bytes)));
  // a raw UTF-8 filename (no encoding, as some clients send) reads as UTF-8
  ok(name(`attachment; filename="résumé.pdf"`) === "résumé.pdf", "raw UTF-8 name: " + name(`attachment; filename="résumé.pdf"`));
  // attachments of a forwarded message (message/rfc822) are reached
  const fwd = listParts(enc("Content-Type: multipart/mixed; boundary=\"O\"\r\n\r\n--O\r\nContent-Type: text/plain\r\n\r\nsee below\r\n" +
    "--O\r\nContent-Type: message/rfc822\r\n\r\nSubject: inner\r\nContent-Type: multipart/mixed; boundary=\"I\"\r\n\r\n--I\r\nContent-Type: text/plain\r\n\r\ninner body\r\n" +
    "--I\r\nContent-Type: application/pdf; name=\"inner.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERg==\r\n--I--\r\n--O--\r\n"));
  ok(fwd.parts.some(p => p.partId === "2.2" && p.filename === "inner.pdf") && dec(extract(fwd, "2.2", "inner.pdf").bytes) === "%PDF" && fwd.parts.some(p => p.partId === "2" && p.type === "message/rfc822"),
    "attachments inside a forwarded message: " + fwd.parts.map(p => `${p.partId}:${p.type}:${p.filename}`).join());
}
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
