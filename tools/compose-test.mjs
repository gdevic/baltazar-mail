// Address parsing and reply recipients in ext/compose.js. node tools/compose-test.mjs
import { createRequire } from "node:module";
// ext/compose.js imports the adapter beside it, so it is tested in the built Yahoo extension.
createRequire(import.meta.url)("./build.js").build("yahoo");
const { parseAddrs, replyRecipients, linkTarget, sentSize } = await import("../dist/baltazar-mail/compose.js");

let fail = 0;
const eq = (got, want, what) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { fail++; console.log("FAIL", what, "got", g, "want", w); } };
const err = f => { try { f(); return null; } catch (e) { return e.message; } };

eq(parseAddrs('"Smith, John" <j@x.com>, ann@y.org'), [{ name: "Smith, John", email: "j@x.com" }, { email: "ann@y.org" }], "comma inside a quoted name");
eq(parseAddrs("Ann <ann@y.org>; bob@z.net"), [{ name: "Ann", email: "ann@y.org" }, { email: "bob@z.net" }], "semicolon separates");
eq(parseAddrs("mailto:a@b.com"), [{ email: "a@b.com" }], "a mailto: link gives its address");
eq(!!err(() => parseAddrs("a:b@c.com")), true, "a colon is not part of an address");
eq(!!err(() => parseAddrs("john")), true, "a bare word is refused");
eq(parseAddrs('"O\'Brien" <ob@x.ie>'), [{ name: "O'Brien", email: "ob@x.ie" }], "apostrophe in a name");

const me = new Set(["me@yahoo.com"]);
const A = { name: "Ann", email: "ann@y.org" }, B = { name: "Bob", email: "bob@z.net" }, M = { name: "Me", email: "me@yahoo.com" };
eq(replyRecipients("reply", { from: [A], to: [M] }, me), { to: [A], cc: [] }, "reply goes to the sender");
eq(replyRecipients("reply", { from: [A], replyTo: [B], to: [M] }, me), { to: [B], cc: [] }, "reply-to wins");
eq(replyRecipients("reply", { from: [M], to: [A, B] }, me), { to: [A, B], cc: [] }, "reply to one's own sent mail goes to its recipients");
eq(replyRecipients("replyAll", { from: [M], to: [A], cc: [B, M] }, me), { to: [A], cc: [B] }, "reply all to one's own sent mail");
eq(replyRecipients("replyAll", { from: [A], to: [M, B, { email: "ANN@y.org" }], cc: [B, A] }, me), { to: [A, B], cc: [] }, "recipients are listed once");
// what people type into the link dialog
for (const [input, want] of [["https://x.org/a?b=1", "https://x.org/a?b=1"], ["HTTP://X.ORG", "HTTP://X.ORG"], ["example.com", "https://example.com"],
  ["www.example.co.uk/path#top", "https://www.example.co.uk/path#top"], ["host.example.com:8080/x", "https://host.example.com:8080/x"], ["me@example.com", "mailto:me@example.com"],
  ["mailto:me@example.com", "mailto:me@example.com"], [" spaced.org ", "https://spaced.org"], ["not a link", null], ["javascript:alert(1)", null], ["localhost", null], ["", null]])
  eq(linkTarget(input), want, `link target for ${JSON.stringify(input)}`);
// the size a picture shown smaller is sent at: twice the shown width, never more than its own
eq(sentSize(4000, 3000, null), null, "a picture with no width of its own goes whole");
eq(sentSize(4000, 3000, 400), { w: 800, h: 600 }, "shown at a tenth, sent at twice that");
eq(sentSize(800, 600, 200), { w: 400, h: 300 }, "shown at a quarter, sent at half");
eq(sentSize(800, 600, 400), null, "shown at half, twice that is the whole picture");
eq(sentSize(800, 600, 640), null, "shown wider than half goes whole");
eq(sentSize(1001, 333, 100), { w: 200, h: 67 }, "the height is rounded");
eq(sentSize(5000, 2, 24), { w: 48, h: 1 }, "never less than one pixel high");
eq(sentSize(0, 0, 200), null, "a picture with no size of its own goes whole");
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
