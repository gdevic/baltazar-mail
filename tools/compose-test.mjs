// Address parsing and reply recipients in ext/compose.js. node tools/compose-test.mjs
import { parseAddrs, replyRecipients } from "../ext/compose.js";

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
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
