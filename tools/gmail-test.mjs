// Unit tests for the Gmail adapter: the RFC 822 builder read back through ext/mime.js, the
// address parser, and the built adapter (dist/baltazar-mail-gmail/api.js) against the Gmail of
// gmail-mock.js, reached through fetch, with chrome mocked around it. node tools/gmail-test.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { build, parseAddresses, messageIdOf, replyHeaders, rfcDate } from "../gmail/rfc822.js";
import { listParts, extract } from "../ext/mime.js";
import { parse, nativeQuery, check } from "../ext/query.js";

const require = createRequire(import.meta.url);
const { createGmail, FX } = require("./gmail-mock.js");

let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
const text = b => new TextDecoder().decode(b);
const headersOf = raw => { const h = {}; for (const line of text(raw).split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ").split("\r\n")) { const c = line.indexOf(":"); if (c > 0) h[line.slice(0, c).toLowerCase()] = line.slice(c + 1).trim(); } return h; };

// ---------- build ----------
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 1, 2, 3]);
  const raw = await build({
    from: { name: "Me, Myself", email: "me@x.com" }, to: [{ name: "Ann", email: "ann@x.com" }, { email: "bob@x.com" }], cc: [{ name: "Zoë", email: "z@x.com" }],
    subject: "Re: Budget — résumé", date: "Mon, 02 Nov 2026 10:00:00 +0000", messageId: "m1@baltazar-mail", inReplyTo: "<orig@x.com>", references: "<a@x.com> <orig@x.com>",
    html: "<p>Hello <img src=\"cid:img1@baltazar-mail\"> there = here</p>\n<p>" + "x".repeat(200) + "</p>\n",
    inline: [{ file: { name: "inline-1.png", type: "image/png", bytes: png }, contentId: "img1@baltazar-mail" }],
    files: [new File([new TextEncoder().encode("name,qty\nZ80,2\n")], "data.csv", { type: "text/csv" }), { name: "été.pdf", type: "application/pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }],
  });
  const h = headersOf(raw);
  ok(h.from === '"Me, Myself" <me@x.com>', "a name with a comma is quoted: " + h.from);
  ok(h.to === "Ann <ann@x.com>, bob@x.com", "address list folded and joined: " + h.to);
  ok(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <z@x.com>$/.test(h.cc), "non-ASCII name as an encoded word: " + h.cc);
  ok(/^=\?utf-8\?B\?/.test(h.subject) && !/[^\x20-\x7e]/.test(h.subject), "non-ASCII subject encoded: " + h.subject);
  ok(h["message-id"] === "<m1@baltazar-mail>" && h["in-reply-to"] === "<orig@x.com>" && h.references === "<a@x.com> <orig@x.com>", "threading headers: " + JSON.stringify([h["message-id"], h["in-reply-to"], h.references]));
  ok(h["mime-version"] === "1.0" && h.date === "Mon, 02 Nov 2026 10:00:00 +0000", "date and MIME version");
  ok(!/[^\x00-\x7f]/.test(text(raw)), "the whole message is 7-bit");
  ok(text(raw).split("\r\n").every(l => l.length <= 998) && !/[^\r]\n/.test(text(raw)), "CRLF line ends, no overlong line");
  const parsed = listParts(raw);
  const names = parsed.parts.map(p => [p.partId, p.type, p.filename]);
  ok(JSON.stringify(names) === JSON.stringify([["1.1", "text/html", ""], ["1.2", "image/png", "inline-1.png"], ["2", "text/csv", "data.csv"], ["3", "application/pdf", "été.pdf"]]), "mixed holds related holds html + inline: " + JSON.stringify(names));
  const html = text(extract(parsed, "1.1").bytes);
  ok(html.includes('<img src="cid:img1@baltazar-mail">') && html.includes("there = here") && html.includes("x".repeat(200)), "HTML survives quoted-printable: " + html.slice(0, 80));
  ok(text(raw).includes("Content-ID: <img1@baltazar-mail>") && /Content-Disposition: inline; filename="inline-1.png"/.test(text(raw)), "inline part carries its Content-ID and disposition");
  ok(JSON.stringify([...extract(parsed, "1.2").bytes]) === JSON.stringify([...png]), "inline bytes round-trip");
  ok(text(extract(parsed, "2").bytes) === "name,qty\nZ80,2\n", "a File attachment round-trips");
  ok(/filename\*0\*=utf-8''%C3%A9t%C3%A9\.pdf/.test(text(raw)), "non-ASCII file name in RFC 2231 form");
}
// a plain-text message is one entity, with trailing white space protected
{
  const raw = await build({ from: { email: "me@x.com" }, to: [{ email: "a@x.com" }], subject: "plain", text: "line one \nline two\n" + "é".repeat(60) });
  const h = headersOf(raw);
  ok(h["content-type"] === "text/plain; charset=utf-8" && h["content-transfer-encoding"] === "quoted-printable", "plain text entity: " + h["content-type"]);
  ok(!("reply-to" in h) && !("cc" in h), "no empty headers");
  const parsed = listParts(raw);
  ok(parsed.parts.length === 1 && text(extract(parsed, "1").bytes) === "line one \r\nline two\r\n" + "é".repeat(60), "text round-trips with CRLF and soft breaks");
  ok(text(raw).split("\r\n").every(l => l.length <= 76), "quoted-printable lines stay short");
}
// white space that ends a line is escaped inside the line's limit, a tab too, also on the last line
{
  const body = "x".repeat(74) + " \n" + "y".repeat(75) + "\t\nlast ";
  const raw = await build({ from: { email: "me@x.com" }, to: [{ email: "a@x.com" }], subject: "edge", text: body });
  const lines = text(raw).split("\r\n\r\n").slice(1).join("\r\n\r\n").split("\r\n");
  ok(lines.every(l => l.length <= 76) && lines.includes("=20") && lines.includes("=09") && lines.at(-1) === "last=20" && !lines.some(l => /[ \t]$/.test(l)), "an escaped line end stays within 76 characters: " + JSON.stringify(lines.map(l => l.length)));
  ok(text(extract(listParts(raw), "1").bytes) === body.replace(/\n/g, "\r\n"), "and the text round-trips");
}
// a file name outside ASCII escapes what RFC 2231 keeps for itself
{
  const raw = await build({ from: { email: "me@x.com" }, to: [{ email: "a@x.com" }], subject: "s", text: "", files: [{ name: "été (1)'*.pdf", type: "application/pdf", bytes: new Uint8Array([1]) }] });
  ok(text(raw).includes("filename*0*=utf-8''%C3%A9t%C3%A9%20%281%29%27%2A.pdf"), "RFC 2231 value escapes ' ( ) *: " + (text(raw).match(/filename\*0\*=\S+/) || [])[0]);
}
// header lines stay short: a long name outside ASCII goes in RFC 2231 pieces, a subject is folded,
// and no line holding an encoded word passes 76 characters
{
  const name = "Отчёт о проделанной работе за третий квартал две тысячи двадцать шестого года.pdf";
  const raw = await build({ from: { email: "me@x.com" }, to: [{ name: "Зоя Кузнецова-Святославская", email: "z@x.com" }], subject: "Протокол встречи по бюджету на следующий год и всем связанным вопросам " + "word ".repeat(30),
    html: "<p>a</p>", inline: [{ file: { name: "p.png", type: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }, contentId: "c1" }], files: [{ name, type: "application/pdf", bytes: new Uint8Array([37, 80]) }] });
  const lines = text(raw).split("\r\n"), parts = listParts(raw).parts;
  ok(!lines.some(l => l.length > 78) && !lines.some(l => /=\?/.test(l) && l.length > 76) && parts.some(p => p.filename === name) && /filename\*1\*=/.test(text(raw)) && /type="text\/html"/.test(text(raw)),
    "short header lines, the name read back, multipart/related names its type: " + JSON.stringify(lines.filter(l => l.length > 76).map(l => l.length)));
}
// an address is written only when it is one address
{
  const refused = async m => { try { await build({ from: { email: "me@x.com" }, subject: "s", text: "", ...m }); return ""; } catch (e) { return e.message; } };
  const several = await refused({ to: [{ name: "Boss", email: "boss@corp.com,attacker@evil.com" }] });
  ok(several === "Not an address: boss@corp.com,attacker@evil.com", "several addresses in one entry are refused: " + several);
  const others = [await refused({ cc: [{ email: "a@x.com\r\nBcc: evil@x.com" }] }), await refused({ bcc: [{ email: "a@x.com b@x.com" }] }), await refused({ to: [{ email: "" }] }), await refused({ from: { email: "me" } })];
  ok(others.every(m => /^Not an address/.test(m)), "a line break, a space, an empty or a partial address is refused: " + JSON.stringify(others));
  const fine = await refused({ to: [{ email: "o'neil+tag@sub.example.co.uk" }, { name: "IP", email: "a@[192.168.0.1]" }] });
  ok(fine === "", "ordinary addresses are written: " + fine);
}
// a Reply-To that differs from From is written; one equal to From is not
{
  const a = headersOf(await build({ from: { email: "me@x.com" }, replyTo: { email: "other@x.com" }, subject: "s", text: "" }));
  const b = headersOf(await build({ from: { email: "me@x.com" }, replyTo: { email: "me@x.com" }, subject: "s", text: "" }));
  ok(a["reply-to"] === "other@x.com" && !("reply-to" in b), "Reply-To only when it differs");
  ok(/^<[0-9a-f-]{36}@baltazar-mail>$/.test(a["message-id"]), "a Message-ID is made up when none is given: " + a["message-id"]);
}
ok(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/.test(rfcDate(new Date(0))), "rfcDate: " + rfcDate(new Date(0)));

// ---------- parseAddresses ----------
const addrs = s => JSON.stringify(parseAddresses(s));
ok(addrs('"Doe, John" <john@x.com>, ann@x.com, <bob@x.com>') === JSON.stringify([{ name: "Doe, John", email: "john@x.com" }, { name: "", email: "ann@x.com" }, { name: "", email: "bob@x.com" }]), "quoted name with comma, bare, bracketed: " + addrs('"Doe, John" <john@x.com>, ann@x.com, <bob@x.com>'));
ok(addrs("=?UTF-8?B?Wm/DqyBRdcOpYmVj?= <z@x.com>") === JSON.stringify([{ name: "Zoë Québec", email: "z@x.com" }]), "encoded word name: " + addrs("=?UTF-8?B?Wm/DqyBRdcOpYmVj?= <z@x.com>"));
ok(addrs("=?utf-8?q?Caf=C3=A9_Team?= <c@x.com>") === JSON.stringify([{ name: "Café Team", email: "c@x.com" }]), "Q-encoded name: " + addrs("=?utf-8?q?Caf=C3=A9_Team?= <c@x.com>"));
ok(addrs("ann@x.com (Ann Example), Bob <bob@x.com> (comment)") === JSON.stringify([{ name: "", email: "ann@x.com" }, { name: "Bob", email: "bob@x.com" }]), "comments dropped: " + addrs("ann@x.com (Ann Example), Bob <bob@x.com> (comment)"));
ok(addrs("Team: a@x.com, \"B, C\" <b@x.com>; d@x.com") === JSON.stringify([{ name: "", email: "a@x.com" }, { name: "B, C", email: "b@x.com" }, { name: "", email: "d@x.com" }]), "group members, name dropped: " + addrs("Team: a@x.com, \"B, C\" <b@x.com>; d@x.com"));
ok(addrs("undisclosed-recipients:;") === "[]" && addrs("") === "[]" && addrs("MAILER-DAEMON") === "[]", "empty group and non-addresses give nothing");
ok(addrs('"Esc \\"q\\" \\\\" <e@x.com>') === JSON.stringify([{ name: 'Esc "q" \\', email: "e@x.com" }]), "escapes in a quoted name: " + addrs('"Esc \\"q\\" \\\\" <e@x.com>'));
ok(addrs("Plain Name <mailto:p@x.com>") === JSON.stringify([{ name: "Plain Name", email: "p@x.com" }]), "mailto: stripped");
{
  const mixed = "Boss <boss@corp.com,attacker@evil.com>, Ann <ann@x.com>, <a@x.com;b@x.com>, c@x.com d@x.com";
  ok(addrs(mixed) === JSON.stringify([{ name: "Ann", email: "ann@x.com" }]), "an entry that is not one address is left out: " + addrs(mixed));
}
ok(messageIdOf(" <abc@x.com> ") === "<abc@x.com>" && messageIdOf("none") === "", "messageIdOf");

// ---------- replyHeaders ----------
{
  const plain = replyHeaders("<orig@x.com>", "<a@x.com>\r\n <b@x.com>");
  ok(plain.inReplyTo === "<orig@x.com>" && plain.references === "<a@x.com> <b@x.com> <orig@x.com>", "a reply's References are the original's and its id: " + JSON.stringify(plain));
  ok(JSON.stringify(replyHeaders("<a@x.com>", "<a@x.com>")) === JSON.stringify({ inReplyTo: "<a@x.com>", references: "<a@x.com>" }) && JSON.stringify(replyHeaders("", "")) === "{}", "the id is not repeated, and nothing gives nothing");
  const long = replyHeaders("<orig@x.com>", Array.from({ length: 50 }, (_, i) => `<r${i}@x.com>`).join(" ")).references.split(" ");
  ok(long.length === 20 && long[0] === "<r0@x.com>" && long[1] === "<r32@x.com>" && long.at(-1) === "<orig@x.com>", "a long chain keeps its first id and its newest: " + long.join(" "));
  const huge = replyHeaders("<" + "a".repeat(5000) + "@x.com>", "junk <ok@x.com> <" + "b".repeat(300) + "@x.com> not an id " + "c".repeat(100000));
  ok(huge.inReplyTo === undefined && huge.references === "<ok@x.com>", "ids too long for a line, and what is not an id, are left out: " + JSON.stringify(huge).slice(0, 80));
}

// ---------- the adapter, built ----------
require("./build.js").build("gmail");

// chrome: session and local storage, a manifest that carries no client id (as a release's does),
// and a Google sign-in window that answers a token (silently only when the test allows it; the
// button's answer can be set with pressed).
const store = {}, local = {};
const manifest = { name: "Baltazar Mail for Gmail™", version: "0.18.0" };
const flows = [];
const CID = "123456789012-abc123def456ghi789.apps.googleusercontent.com";   // the user's own client
let silentOk = false, silentDown = "", silentRefusal = "", tokens = 0;
let silentGate = null;     // what a silent flow waits for before it answers: a promise a test opens, or one that never settles
let pressed = null;        // { reject: the browser's message } or { fragment: Google's answer } for the next interactive flow
// The tests' clock: the real one, moved on by skew where a test has time pass.
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;
const area = o => ({ get: async k => ({ [k]: o[k] }), set: async x => Object.assign(o, x), remove: async k => { delete o[k]; } });
globalThis.chrome = {
  storage: { session: area(store), local: area(local) },
  runtime: { getManifest: () => manifest },
  identity: {
    getRedirectURL: () => "https://extid.chromiumapp.org/",
    launchWebAuthFlow: async ({ url, interactive }) => {
      flows.push({ interactive, url });
      const u = new URL(url);
      if (!interactive && silentGate) await silentGate;
      if (interactive && pressed?.reject) throw new Error(pressed.reject);
      if (interactive && pressed?.fragment) return `https://extid.chromiumapp.org/#${pressed.fragment}&state=${u.searchParams.get("state")}`;
      if (!interactive && silentDown) throw new Error(silentDown);
      if (!interactive && silentRefusal) return `https://extid.chromiumapp.org/#error=${silentRefusal}&state=${u.searchParams.get("state")}`;
      if (!interactive && !silentOk) throw new Error("The user did not approve access.");
      return `https://extid.chromiumapp.org/#access_token=tok${++tokens}&token_type=Bearer&expires_in=3600&state=${u.searchParams.get("state")}`;
    },
  },
};
// FileReader, for the data: URLs the adapter makes of images
globalThis.FileReader = class { readAsDataURL(blob) { blob.arrayBuffer().then(b => { this.result = `data:${blob.type};base64,${Buffer.from(b).toString("base64")}`; this.onload?.(); }); } };

const gm = createGmail({ mime: { listParts, extract } });
const mock = gm.state;
const fetched = [];        // { at, url } of every request, for the pacing of background work
let before = null;         // (method, url, body, headers) -> an answer of its own, or null for the mock's
let hang = null;           // (method, url) -> true for a request that gets no answer until its deadline ends it
globalThis.fetch = async (url, init = {}) => {
  fetched.push({ at: Date.now(), url: String(url) });
  const method = init.method || "GET", headers = init.headers || {};
  // (the deadline's own timer does not keep Node running, so a timer of this request's does)
  if (hang?.(method, String(url))) return new Promise((_, no) => { const alive = setInterval(() => {}, 1000); init.signal.addEventListener("abort", () => { clearInterval(alive); no(init.signal.reason); }); });
  let body = init.body;
  if (body instanceof Blob) body = Buffer.from(await body.arrayBuffer()).toString("latin1");
  const r = before?.(method, String(url), body, headers) || gm.respond(method, String(url), body, headers);
  if (r.text != null) return new Response(r.text, { status: r.status, headers: { "content-type": r.contentType } });
  return new Response(r.json == null ? null : JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
};

const api = await import("../dist/baltazar-mail-gmail/api.js");
const outcome = async p => { try { return { value: await p }; } catch (e) { return { e }; } };
const lastCall = (method, re) => [...mock.calls].reverse().find(c => c.method === method && re.test(c.path));
const labelsOf = id => mock.messages.get(id).labelIds;
// label changes as { ids, addLabelIds, removeLabelIds }, made one message each or in bulk
const modsOf = () => mock.calls.filter(c => c.path === "/messages/batchModify" || /^\/messages\/[^/]+\/modify$/.test(c.path)).map(c => c.path.endsWith("/modify") ? { ids: [c.path.split("/")[2]], ...c.body, single: true } : c.body);
const lastMod = () => modsOf().at(-1);

// search dialect: the whole query in Gmail's language
{
  const nq = s => nativeQuery(parse(s), api.dialect);
  const midnight = (y, m, d) => Math.floor(new Date(y, m - 1, d).getTime() / 1000);   // the user's own, as Gmail is given it
  ok(nq("alex (picture OR photo) -spam from:bob after:2026-01-05 is:unread -has:attachment") === `alex (picture OR photo) -spam from:bob after:${midnight(2026, 1, 5)} is:unread -has:attachment`, "compiled query: " + nq("alex (picture OR photo) -spam from:bob after:2026-01-05 is:unread -has:attachment"));
  ok(nq("-(a OR b) c") === "-a -b c" && nq("NOT (a b)") === "-a OR -b" && nq("(a b) OR c") === "(a b) OR c" && nq('"quarterly review" subject:"x y"') === '"quarterly review" subject:"x y"', "De Morgan, grouping and phrases: " + JSON.stringify([nq("-(a OR b) c"), nq("NOT (a b)"), nq("(a b) OR c"), nq('"quarterly review" subject:"x y"')]));
  ok(nq('"Alex" AND "Picture"') === "Alex Picture" && nq("-is:unread -after:2026-02-01") === `is:read before:${midnight(2026, 2, 1)}`, "AND of words needs no evaluation; negations flip: " + JSON.stringify([nq('"Alex" AND "Picture"'), nq("-is:unread -after:2026-02-01")]));
  // a quoted word that Gmail would read as an operator is written quoted
  const literal = ['"-v2"', 'apple "OR" pie', 'from:"-x"', '"{a}"'].map(nq);
  ok(JSON.stringify(literal) === JSON.stringify(['"-v2"', 'apple "OR" pie', 'from:"-x"', '"{a}"']), "quoted operators stay words: " + JSON.stringify(literal));
  let err = ""; try { check(parse("is:important"), api.dialect); } catch (e) { err = e.message; }
  ok(/is:important/.test(err), "unknown is: refused: " + err);
  ok(api.queries.starred(true) === "is:starred is:unread" && api.queries.person('a@x.com") OR x') === "(from:a@x.comORx OR to:a@x.comORx OR cc:a@x.comORx)", "named queries, with only address characters: " + api.queries.person('a@x.com") OR x'));
  const odd = api.queries.person("a@x{from:bank.com}|b -c"), usual = api.queries.person("o'neil+tag@sub.example.co.uk");
  ok(odd === "(from:a@xfrombank.comb-c OR to:a@xfrombank.comb-c OR cc:a@xfrombank.comb-c)" && usual === "(from:o'neil+tag@sub.example.co.uk OR to:o'neil+tag@sub.example.co.uk OR cc:o'neil+tag@sub.example.co.uk)", "an address brings no search operator along: " + JSON.stringify([odd, usual]));
}
// batch encoding and decoding
{
  const enc = api.encodeBatch([{ method: "GET", path: "/labels/INBOX", query: { fields: "id,messagesTotal" } }, { method: "POST", path: "/messages/batchModify", json: { ids: ["a"] } }], "B");
  ok(enc.includes("GET /gmail/v1/users/me/labels/INBOX?fields=id%2CmessagesTotal HTTP/1.1") && enc.includes('{"ids":["a"]}') && enc.endsWith("--B--\r\n"), "batch request parts: " + enc.slice(0, 200));
  const dec = api.decodeBatch(`--R\r\nContent-Type: application/http\r\nContent-ID: <response-item1>\r\n\r\nHTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{"code":404}}\r\n--R\r\nContent-Type: application/http\r\nContent-ID: <response-item0>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{"id":"INBOX","messagesTotal":10}\r\n--R--\r\n`, "R", 2);
  ok(dec[0].status === 200 && dec[0].json.messagesTotal === 10 && dec[1].status === 404 && dec[1].json.error.code === 404, "answers matched to their items by Content-ID: " + JSON.stringify(dec));
}
// sign-in: nothing opens by itself; without a Google client the button opens nothing either and
// the guide shows; a pasted Client ID is kept, and the button then opens Google's window with it
{
  const a = await outcome(api.bootstrap());
  ok(a.e instanceof api.NotSignedIn && flows.length === 0 && (await api.setup.explain(a.e)) === null, "with no account signed in, nothing is tried, no window opens and there is nothing to explain: " + JSON.stringify({ e: a.e?.name, flows: flows.length }));
  const none = await outcome(api.signIn());
  const v0 = await api.setup.view();
  ok(none.e?.code === "setup" && flows.length === 0 && v0.kind === "guide" && v0.route === "quick" && v0.step === "create" && v0.steps.map(s => s.id).join() === "create,paste,api,signin" && v0.steps[0].copy.value === "https://extid.chromiumapp.org/" && /Client ID/.test(v0.text),
    "without a Google client the button opens no window, and the guide starts with this copy's redirect address: " + JSON.stringify({ code: none.e?.code, flows: flows.length, kind: v0.kind, step: v0.step, copy: v0.steps[0]?.copy }));
  const bad = await api.setup.paste("GOCSPX-abc");
  ok(/client secret/.test(bad.error) && !local.gmClientId && !local.gmSetup, "a client secret is not taken for a Client ID: " + JSON.stringify(bad));
  const good = await api.setup.paste(`  ${CID}\n`);
  const v1 = await api.setup.view(), apiStep = v1.steps.find(s => s.id === "api");
  ok(good.id === CID && local.gmClientId === CID && JSON.stringify(local.gmSetup) === '{"route":"quick","step":"api"}' && v1.kind === "guide" && v1.step === "api" && v1.own && v1.clientId === CID && apiStep.open.href.endsWith("/apis/library/gmail.googleapis.com?project=123456789012"),
    "a Client ID is kept and the guide moves on to the Gmail API of its project: " + JSON.stringify({ good, setup: local.gmSetup, step: v1.step, href: apiStep?.open.href }));
  await api.setup.at("quick", "signin");
  ok((await api.setup.view()).step === "signin", "the guide is where it was put");
  const s = await api.signIn();
  const u = new URL(flows[0].url).searchParams;
  ok(s.email === "me@gmail.com" && flows.length === 1 && flows[0].interactive && u.get("prompt") === "select_account consent" && u.get("client_id") === CID && u.get("redirect_uri") === "https://extid.chromiumapp.org/" && store.gmToken?.access_token === "tok1" && local.gmAccount === "me@gmail.com" && !local.gmSetup,
    "the button opens Google's window for the pasted client, keeps the token and the account, and ends the guide: " + JSON.stringify({ s, client: u.get("client_id"), token: store.gmToken, local }));
  const b = await api.bootstrap();
  ok(b.email === "me@gmail.com" && flows.length === 1, "a stored token is reused without a flow");
}
// folders: labels become folders; counts come in one batch; All Mail stands for the archive
{
  mock.batches.length = 0;
  const r = await api.folders();
  const f = Object.fromEntries(r.folders.map(x => [x.id, x]));
  ok(r.folders.map(x => x.id).join() === "INBOX,SENT,DRAFT,TRASH,SPAM,Label_1,Label_2,Label_3,Label_4,Label_5,ALL", "folder list: " + r.folders.map(x => x.id).join());
  ok(f.INBOX.types[0] === "INBOX" && f.INBOX.name === "Inbox" && f.INBOX.unread === 4 && f.INBOX.total === 8 && f.SPAM.types[0] === "BULK" && f.DRAFT.types[0] === "DRAFT" && f.DRAFT.total === 1, "system folders: " + JSON.stringify(f.INBOX));
  ok(f.Label_2.name === "Projects/FPGA" && f.Label_2.types.join() === "USER" && f.Label_2.total === 3 && f.Label_3.types.join() === "USER,INVISIBLE", "user labels as paths; hidden ones invisible");
  ok(f.ALL.types[0] === "ARCHIVE" && f.ALL.name === "All Mail" && f.ALL.total === mock.messages.size, "All Mail: " + JSON.stringify(f.ALL));
  const counted = mock.calls.filter(c => /^\/labels\//.test(c.path));
  ok(mock.calls.filter(c => c.path === "/labels").length === 1 && counted.length === 10 && counted.every(c => c.batched) && mock.batches.length === 1 && mock.batches[0].length === 10 && mock.batches[0].every(p => /^\/labels\//.test(p)), "counts through one batch, one get per shown label: " + JSON.stringify(mock.batches));
  // history: a change touching Projects stamps it, and All Mail, but not FPGA
  const before = Object.fromEntries(r.folders.map(x => [x.id, x.highestModSeq]));
  mock.history.push({ id: "1001", labelsAdded: [{ message: { id: "p2", labelIds: ["Label_1", "STARRED"] }, labelIds: ["STARRED"] }] });
  mock.profile.historyId = "1001"; mock.nextHistory = 1002;
  mock.batches.length = 0;
  const r2 = await api.folders();
  const after = Object.fromEntries(r2.folders.map(x => [x.id, x.highestModSeq]));
  ok(after.Label_1 !== before.Label_1 && after.ALL !== before.ALL && after.Label_2 === before.Label_2 && after.SENT === before.SENT, "history stamps the labels it names: " + JSON.stringify({ before, after }));
  ok(lastCall("GET", /^\/history$/).q.startHistoryId === "1000", "history is asked from the last id seen");
  ok(JSON.stringify(mock.batches) === '[["/labels/Label_1"]]', "only the labels the history names are counted: " + JSON.stringify(mock.batches));
  // a mailbox in which nothing happened costs the labels and the history, and no count
  mock.calls.length = 0; mock.batches.length = 0;
  const idle = await api.folders();
  ok(mock.calls.map(c => c.path).sort().join() === "/history,/labels" && mock.batches.length === 0 && JSON.stringify(idle.folders) === JSON.stringify(r2.folders), "an idle mailbox is two requests, and the folders stay as they were: " + mock.calls.map(c => c.path).join());
  // a count that changed with no record of it is seen when every label is next counted, five minutes on
  mock.addMessage({ id: "s9", labels: ["SENT"], subject: "Subject s-9", from: "Me <me@gmail.com>" });
  const r3 = await api.folders();
  skew += 5 * 60e3;
  mock.batches.length = 0;
  const r3b = await api.folders();
  ok(r3.folders.find(x => x.id === "SENT").highestModSeq === after.SENT && r3b.folders.find(x => x.id === "SENT").highestModSeq !== after.SENT && mock.batches.length === 1 && mock.batches[0].length === 10,
    "a changed count stamps the folder once every label is counted again: " + JSON.stringify(mock.batches.map(b => b.length)));
  // a history Gmail no longer has stamps everything once
  mock.historyGone = true; mock.profile.historyId = "2000"; mock.nextHistory = 2001;
  const r4 = await api.folders();
  ok(r4.folders.every(x => /^2000:all/.test(String(x.highestModSeq))), "expired history stamps every folder: " + r4.folders[0].highestModSeq);
  mock.historyGone = false;
  // a label whose counts Gmail refuses inside the batch keeps the counts it had, unstamped, and is
  // asked for again the next time, though nothing names it then; one refused once is asked again
  const r5 = await api.folders();
  skew += 5 * 60e3;
  mock.failItems = { status: 503, times: 99, match: /\/labels\/INBOX/ };
  const r6 = await api.folders();
  mock.failItems = { status: 429, times: 1, match: /\/labels\/INBOX/ };
  mock.batches.length = 0;
  const r7 = await api.folders();
  const left = mock.failItems.times;
  mock.failItems = null;
  const [i5, i6, i7] = [r5, r6, r7].map(x => x.folders.find(f => f.id === "INBOX"));
  ok(i6.unread === i5.unread && i6.total === i5.total && i6.highestModSeq === i5.highestModSeq, "failed counts keep the last ones: " + JSON.stringify([i5, i6]));
  ok(left === 0 && i7.unread === i5.unread && i7.total === i5.total && mock.batches.every(b => b.join() === "/labels/INBOX"), "a refused item is asked again, and counts that did not come the next time: " + JSON.stringify([i7, mock.batches]));
}
// lists: rows in the client's shape, paged by offset over Gmail's tokens
{
  const r = await api.list("INBOX", 3, 0);
  const m = r.messages[0];
  ok(r.messages.map(x => x.id).join() === "m1,m2,m3" && m.headers.subject === "Subject m-1" && m.headers.from[0].name === "Sender 1" && m.headers.from[0].email === "s1@x.com" && Number(m.headers.date) === Math.floor(Number(mock.messages.get("m1").internalDate) / 1000) && m.flags.read === false && m.flags.flagged === false, "rows: " + JSON.stringify({ ids: r.messages.map(x => x.id), m }));
  ok(m.folder.id === "INBOX" && m.folder.name === "Inbox" && m.attachments.length === 1 && m.attachments[0].disposition === "inline" && m.attachmentCount === 0 && r.messages[2].attachmentCount === 7, "folder and attachments from the parts: " + JSON.stringify([m.folder, m.attachments, r.messages[2].attachmentCount]));
  ok(r.messages[1].flags.read === true && r.messages[1].flags.flagged === true && r.messages[1].folder.id === "INBOX", "a read, starred message listed in Inbox stays in Inbox");
  // a row names each file as body() does, so a folder's list of attachments can fetch it from the row alone
  const pdfRow = r.messages[2].attachments.find(a => a.filename === "report.pdf");
  ok(JSON.stringify(pdfRow) === JSON.stringify({ partId: "1", filename: "report.pdf", size: mock.attachments.get("att-m3-1").length, type: "application", subtype: "pdf", disposition: "attachment" }), "a row's file has its part, size and type: " + JSON.stringify(pdfRow));
  const fromRow = await api.partBytes("m3", pdfRow);
  ok(fromRow.bytes.length === pdfRow.size && fromRow.filename === "report.pdf", "a file named by a row is fetched without the body: " + JSON.stringify([fromRow.bytes.length, fromRow.filename]));
  mock.calls.length = 0;
  const r2 = await api.list("INBOX", 3, 3);
  ok(r2.messages.map(x => x.id).join() === "m4,m5,m6" && lastCall("GET", /^\/messages$/).q.pageToken === "p3", "the next page uses Gmail's token: " + JSON.stringify(lastCall("GET", /^\/messages$/).q));
  mock.calls.length = 0;
  const r3 = await api.list("INBOX", 3, 6);
  ok(r3.messages.map(x => x.id).join() === "m7,m8" && mock.calls.filter(c => c.path === "/messages").length === 1, "paging on: " + r3.messages.map(x => x.id).join());
  // the address-book build lists in the background, with cursors of its own
  const bg = await api.list("INBOX", 2, 0, { background: true });
  ok(bg.messages.map(x => x.id).join() === "m1,m2", "a background list: " + bg.messages.map(x => x.id).join());
  mock.calls.length = 0;
  const r4 = await api.list("INBOX", 2, 4);
  ok(r4.messages.map(x => x.id).join() === "m5,m6" && mock.calls.filter(c => c.path === "/messages").length === 2, "an offset off the cursor is walked to from the start: " + r4.messages.map(x => x.id).join());
  const all = await api.list("ALL", 100, 0);
  const notSpamTrash = [...mock.messages.values()].filter(x => !x.labelIds.some(l => l === "SPAM" || l === "TRASH")).length;
  ok(all.messages.length === notSpamTrash && !lastCall("GET", /^\/messages$/).q.labelIds, "All Mail lists without a label, Spam and Trash left out: " + all.messages.length);
  const placed = Object.fromEntries(["m2", "f1", "s1"].map(id => [id, all.messages.find(x => x.id === id)?.folder.id]));
  ok(placed.m2 === "INBOX" && placed.f1 === "Label_2" && placed.s1 === "SENT", "a row listed in All Mail is placed by its labels, so archiving it there takes it out of Inbox: " + JSON.stringify(placed));
  const un = await api.query(api.queries.unreadIn("Label_1"), 100, 0);
  ok(lastCall("GET", /^\/messages$/).q.labelIds === "Label_1" && lastCall("GET", /^\/messages$/).q.q === "is:unread" && un.messages.map(x => x.id).join() === "p1,p3,p5", "unreadIn names the label outside the search: " + JSON.stringify([lastCall("GET", /^\/messages$/).q, un.messages.map(x => x.id)]));
  const st = await api.search(api.queries.starred(), 100);
  ok(st.messages.map(x => x.id).join() === "f1,m2" && st.messages[0].folder.id === "Label_2" && st.messages[0].folder.name === "Projects/FPGA", "a search result's folder is its user label: " + JSON.stringify(st.messages.map(x => [x.id, x.folder])));
  const sc = await api.searchScoped("Subject", { include: { ids: ["Label_1", "Label_2"] } }, 50, 0);
  ok(lastCall("GET", /^\/messages$/).q.q === '(label:"Projects" OR label:"Projects/FPGA") Subject' && sc.messages.map(x => x.id).join() === "p1,p2,p3,p4,p5", "a folder with subfolders is searched by label names: " + JSON.stringify([lastCall("GET", /^\/messages$/).q.q, sc.messages.map(x => x.id)]));
  const el = await api.searchScoped("Subject", { exclude: { ids: ["Label_1", "Label_2"] } }, 50, 0);
  ok(lastCall("GET", /^\/messages$/).q.q === '-label:"Projects" -label:"Projects/FPGA" Subject' && el.messages.length > 0 && el.messages.every(x => !x.labelIds.includes("Label_1") && !x.labelIds.includes("Label_2")), "elsewhere: everything less the scope's labels: " + el.messages.length);
  // rows seen before are not fetched again, and show the labels they have now
  mock.calls.length = 0;
  const seen = await api.list("INBOX", 3, 0);
  ok(seen.messages.map(x => x.id).join() === "m1,m2,m3" && mock.calls.filter(c => c.path === "/messages").length === 1 && !mock.calls.some(c => /^\/messages\/m\d$/.test(c.path)), "a list seen before costs one list call: " + JSON.stringify(mock.calls.map(c => c.path)));
  ok(await api.starredCount() === [...mock.messages.values()].filter(m => m.labelIds.includes("STARRED")).length && lastCall("GET", /^\/labels\/STARRED$/), "the Starred count is the label's own");
  // a row Gmail refuses once inside the batch is asked again; one it keeps refusing fails the list
  // rather than leaving a hole that would end the paging
  for (const id of ["x1", "x2", "x3", "x4"]) mock.addMessage({ id, labels: ["Label_x"], subject: id, from: "x <x@x.com>", cc: "", html: "<p>x</p>" });
  mock.failItems = { status: 500, times: 1, match: /\/messages\/x2\?/ };
  const rf = await api.list("Label_x", 3, 0);
  ok(rf.messages.map(x => x.id).join() === "x1,x2,x3" && mock.failItems.times === 0, "a refused row is asked again: " + rf.messages.map(x => x.id).join());
  mock.failItems = { status: 500, times: 99, match: /\/messages\/x4\?/ };
  const rg = await outcome(api.list("Label_x", 4, 0));
  mock.failItems = null;
  ok(rg.e instanceof api.ApiError && /x4/.test(rg.e.message), "a row that keeps failing fails the list: " + (rg.e?.message || rg.value?.messages.length));
  for (const id of ["x1", "x2", "x3", "x4"]) mock.messages.delete(id);
  // a list longer than Gmail's 500-id page (a refresh of many loaded rows) takes several pages
  const t = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 520; i++) mock.addMessage({ id: `b${i}`, labels: ["Label_bulk"], subject: `bulk ${i}`, from: "b <b@x.com>", cc: "", date: t - i, html: "<p>b</p>" });
  mock.calls.length = 0;
  const big = await api.list("Label_bulk", 511, 0);
  ok(big.messages.length === 511 && big.messages[510].id === "b510" && mock.calls.filter(c => c.path === "/messages").length === 2, "a long refresh follows Gmail's pages: " + JSON.stringify([big.messages.length, mock.calls.filter(c => c.path === "/messages").map(c => c.q.maxResults)]));
  for (let i = 0; i < 520; i++) mock.messages.delete(`b${i}`);
}
// body: the HTML part, the inline image by cid, the attachment's bytes
{
  const b = await api.body("m3");
  ok(b.html.startsWith("<p>Body of <b>m3</b></p>") && b.html.includes('<img src="cid:m3-pic@x">') && b.message.id === "m3" && b.message.headers.messageId === "<m3@x.com>" && b.message.threadId === "t-m3", "body html and message: " + JSON.stringify([b.html.slice(0, 60), b.message.headers.messageId]));
  ok(b.attachments.length === 8 && b.attachments[0].partId === "0.1" && b.attachments[0].contentId === "m3-pic@x" && b.attachments[0].disposition === "inline" && b.attachments[1].filename === "report.pdf" && b.attachments[1].type === "application" && b.attachments[1].subtype === "pdf" && b.attachments[1].disposition === "attachment", "attachments: " + JSON.stringify(b.attachments.slice(0, 2)));
  ok(api.isInlineRef("cid:m3-pic@x", b) && api.isInlineRef(" CID:M3-pic%40x ", b) && !api.isInlineRef("cid:other@x", b) && !api.isInlineRef("cid:m3-pic@x", { attachments: [] }) && !api.isInlineRef("https://x/y.png", b) && api.isStrayImage("cid:gone@x") && !api.isStrayImage("https://x/y.png"), "inline references are cid: sources that name the message's own parts");
  ok(api.imageOrigin("https://u1.ct.sendgrid.net/wf/open?upn=a") === "https://u1.ct.sendgrid.net/wf/open?upn=a", "a picture's address is the sender's own");
  ok(b.attachments.every(a => api.isListed(a)), "every attachment is listed");
  const src = await api.inlineSource("cid:m3-pic@x", b);
  ok(src?.startsWith("data:image/png;base64,") && lastCall("GET", /attachments/).path.endsWith("/att-m3-0.1"), "an inline image is fetched by its attachment id as a data URL: " + String(src).slice(0, 30));
  const pdf = await api.partBytes("m3", b.attachments[1]);
  ok(pdf.bytes.length === fs.statSync(path.join(FX, "report.pdf")).size && pdf.type === "application/pdf" && pdf.filename === "report.pdf", "attachment bytes: " + JSON.stringify([pdf.bytes.length, pdf.type]));
  const th = await api.thumbnail("m3", b.attachments[0]);
  ok(th?.startsWith("data:image/png"), "an image's thumbnail is the image itself");
  ok(api.originalUrl(b.attachments[1]) === null && api.docPages === undefined && api.extractText === undefined, "no download link, converter or text extraction");
  const gone = await outcome(api.body("nope"));
  ok(gone.e && api.isGone(gone.e), "a missing message is gone: " + gone.e?.message);
  const d = await api.body("d1");
  ok(d.message.csid === "r-d1" && d.message.inReplyTo?.messageReference?.id === "m3" && d.message.inReplyTo.replied && !d.message.inReplyTo.forwarded, "a draft carries its draft id and the message it answers: " + JSON.stringify([d.message.csid, d.message.inReplyTo]));
  // as some mailers send it: text, a file marked inline that the text does not show, more text
  const leaf = (partId, mimeType, value, headers = []) => ({ partId, mimeType, filename: "", headers: [{ name: "Content-Type", value: `${mimeType}; charset=utf-8` }, ...headers], body: { size: value.length, data: Buffer.from(value).toString("base64url") } });
  mock.attachments.set("att-apple-pdf", Buffer.from("%PDF-1.4 x"));
  mock.messages.set("apple1", { id: "apple1", threadId: "t-apple1", labelIds: ["INBOX"], snippet: "", internalDate: String(Date.now()), sizeEstimate: 100, payload: { partId: "", mimeType: "multipart/mixed", filename: "", headers: [{ name: "Subject", value: "Apple" }, { name: "From", value: "a <a@x.com>" }], body: { size: 0 }, parts: [
    { partId: "0", mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: [leaf("0.0", "text/plain", "Before"), leaf("0.1", "text/html", "<p>Before</p>")] },
    { partId: "1", mimeType: "application/pdf", filename: "scan.pdf", headers: [{ name: "Content-Type", value: "application/pdf; name=scan.pdf" }, { name: "Content-Disposition", value: "inline; filename=scan.pdf" }, { name: "Content-ID", value: "<scan@x>" }], body: { size: 10, attachmentId: "att-apple-pdf" } },
    leaf("2", "text/plain", "After"),
  ] } });
  const ap = await api.body("apple1");
  ok(ap.text === "Before\nAfter" && ap.html.startsWith("<p>Before</p>") && ap.html.includes(">After</div>") && ap.attachments.length === 1 && ap.attachments[0].filename === "scan.pdf" && ap.attachments[0].disposition === "attachment" && ap.message.attachments[0].disposition === "attachment", "an inline-marked file the text does not show is an attachment, and text after it is shown: " + JSON.stringify([ap.text, ap.html, ap.attachments]));
  const [arow] = (await api.search("apple1", 10)).messages;
  ok(arow?.attachmentCount === 1, "the row counts it: " + JSON.stringify(arow?.attachments));
  mock.messages.delete("apple1");
}
// a conversation is the message's thread, its messages in Spam and Trash left out, each row in the
// folder its labels place it in; a thread id that is not Gmail's never reaches a request
{
  const t = Math.floor(Date.now() / 1000), thread = { threadId: "t-plan", cc: "", html: "<p>x</p>" };
  mock.addMessage({ id: "c1", labels: ["Label_1"], subject: "Plan", from: "Alex <alex@x.com>", date: t - 400, ...thread });
  mock.addMessage({ id: "c2", labels: ["SENT"], subject: "Re: Plan", from: "Me <me@gmail.com>", inReplyTo: "<c1@x.com>", date: t - 300, ...thread });
  mock.addMessage({ id: "c3", labels: ["TRASH"], subject: "Re: Plan", from: "Bob <bob@x.com>", inReplyTo: "<c1@x.com>", date: t - 200, ...thread });
  mock.addMessage({ id: "c4", labels: ["SPAM", "UNREAD"], subject: "Re: Plan", from: "Spam <s@x.com>", inReplyTo: "<c2@x.com>", date: t - 100, ...thread });
  mock.calls.length = 0;
  const c = await api.conversation({ id: "c2", threadId: "t-plan" });
  const asked = mock.calls.filter(x => /^\/threads\//.test(x.path)), got = c.messages.map(m => `${m.id}@${m.folder.id}`).join();
  ok(c.complete && got === "c1@Label_1,c2@SENT" && asked.length === 1 && asked[0].path === "/threads/t-plan" && asked[0].q.format === "minimal" && !mock.calls.some(x => /\/messages\/c[34]\b/.test(x.path)),
    "the thread's messages outside Spam and Trash, as rows, the others not fetched: " + JSON.stringify({ got, asked }));
  const r = JSON.stringify(api.refsOf(c.messages[1]));
  ok(r === JSON.stringify({ id: "c2@x.com", parent: "c1@x.com", refs: ["c1@x.com"] }) && JSON.stringify(api.refsOf(c.messages[0])) === JSON.stringify({ id: "c1@x.com", parent: "", refs: [] }), "a row names its Message-ID, In-Reply-To and References: " + r);
  mock.calls.length = 0;
  const refused = await outcome(api.conversation({ id: "c2", threadId: "t) OR x" })), none = await api.conversation({ id: "c2" });
  ok(refused.e instanceof api.ApiError && none.complete && !none.messages.length && !mock.calls.length, "a malformed thread id is refused and a missing one names nothing, neither asking Gmail: " + JSON.stringify({ refused: refused.e?.message, none }));
  for (const id of ["c1", "c2", "c3", "c4"]) mock.messages.delete(id);
}
// mutations: label changes, a few one message each, more in bulk; a move trades the placing
// labels for the target's
{
  mock.calls.length = 0;
  const r = await api.setRead(["m1", "m3"], true);
  ok(modsOf().length === 2 && modsOf().every(b => b.single) && !mock.calls.some(c => c.path === "/messages/batchModify"), "a few messages change one each, not in bulk: " + JSON.stringify(modsOf()));
  ok(r.ok.join() === "m1,m3" && !r.failed.length && lastMod().removeLabelIds[0] === "UNREAD" && !labelsOf("m1").includes("UNREAD"), "mark read: " + JSON.stringify(lastMod()));
  await api.setStarred(["m1"], true);
  ok(lastMod().addLabelIds[0] === "STARRED" && labelsOf("m1").includes("STARRED"), "star");
  mock.calls.length = 0;
  const mv = await api.move(["m1", "p2"], "Label_2", { from: { m1: "INBOX", p2: "Label_1" } });
  const mods = modsOf();
  ok(mv.ok.join() === "m1,p2" && mods.length === 2 && mods.some(b => b.ids.join() === "m1" && b.removeLabelIds.join() === "INBOX" && b.addLabelIds.join() === "Label_2") && mods.some(b => b.ids.join() === "p2" && b.removeLabelIds.join() === "Label_1" && b.addLabelIds.join() === "Label_2"), "a move removes Inbox or the user label, one call per label set: " + JSON.stringify(mods));
  ok(labelsOf("m1").join() === "STARRED,Label_2", "the star survives a move: " + labelsOf("m1").join());
  mock.calls.length = 0;
  await api.move(["m1"], "ALL", { from: { m1: "Label_2" } });
  ok(lastMod().addLabelIds.length === 0 && lastMod().removeLabelIds.join() === "Label_2" && labelsOf("m1").join() === "STARRED", "archive from a label's folder adds nothing: " + JSON.stringify(lastMod()));
  await api.move(["m1"], "INBOX");
  ok(labelsOf("m1").includes("INBOX"), "a move to Inbox puts Inbox back");
  mock.calls.length = 0;
  mock.addMessage({ id: "n1", labels: ["INBOX", "Label_1"], subject: "n", from: "a <a@x.com>" });
  const unknown = await api.move(["n1"], "TRASH", { from: { n1: "INBOX" } });
  ok(unknown.ok.join() === "n1" && mock.calls.some(c => c.path === "/messages/n1" && c.q.format === "minimal") && labelsOf("n1").join() === "Label_1,TRASH", "a message not seen yet has its labels fetched first: " + JSON.stringify(labelsOf("n1")));
  // other labels stay through Trash, Archive and a move, and undo takes back exactly the move
  mock.addMessage({ id: "w1", labels: ["INBOX", "Label_1", "Label_4"], subject: "w", from: "a <a@x.com>" });
  const sorted = id => labelsOf(id).slice().sort().join();
  const tr = await api.move(["w1"], "TRASH", { from: { w1: "INBOX" } });
  ok(sorted("w1") === "Label_1,Label_4,TRASH", "Trash keeps the message's labels: " + sorted("w1"));
  await tr.undo();
  ok(sorted("w1") === "INBOX,Label_1,Label_4", "undo of a delete puts back what it took: " + sorted("w1"));
  const ar = await api.move(["w1"], "ALL", { from: { w1: "INBOX" } });
  ok(sorted("w1") === "Label_1,Label_4", "archive from Inbox takes only Inbox: " + sorted("w1"));
  await ar.undo();
  const lm = await api.move(["w1"], "Label_2", { from: { w1: "Label_1" } });
  ok(sorted("w1") === "Label_2,Label_4", "a move from a label's folder trades that label and Inbox for the target: " + sorted("w1"));
  const lu = await lm.undo();
  ok(sorted("w1") === "INBOX,Label_1,Label_4" && lu.ok.join() === "w1", "and its undo puts both back: " + sorted("w1"));
  const fromAll = await api.move(["w1"], "TRASH", { from: { w1: "ALL" } });
  await fromAll.undo();
  ok(sorted("w1") === "INBOX,Label_1,Label_4", "a delete from All Mail undone keeps Inbox: " + sorted("w1"));
  const bad = await outcome(api.move(["x) OR y"], "TRASH"));
  ok(bad.e instanceof api.ApiError && /malformed/.test(bad.e.message), "malformed ids are refused");
  // more than ten go in bulk
  const many = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "p1", "p3", "p4"];
  mock.calls.length = 0;
  const bulk = await api.setRead(many, false);
  ok(bulk.ok.length === 11 && mock.calls.filter(c => c.path === "/messages/batchModify").length === 1 && !modsOf().some(b => b.single), "more than ten change in bulk: " + JSON.stringify(modsOf().length));
  // a label changed elsewhere reaches a kept row through the history
  await api.folders();
  const before = (await api.search("m1", 10)).messages[0];
  mock.messages.get(before.id).labelIds = mock.messages.get(before.id).labelIds.filter(l => l !== "UNREAD");
  mock.history.push({ id: String(mock.nextHistory), labelsRemoved: [{ message: { id: before.id, labelIds: mock.messages.get(before.id).labelIds }, labelIds: ["UNREAD"] }] });
  mock.profile.historyId = String(mock.nextHistory++);
  await api.folders();
  const after = (await api.search("m1", 10)).messages[0];
  ok(before.id === after.id && !before.flags.read && after.flags.read, "a kept row follows a change made elsewhere: " + JSON.stringify([before.flags, after.flags]));
}
// folder operations, with the rename cascading to nested labels
{
  const c = await api.createFolder("Projects/New");
  ok(c.result.name === "Projects/New" && lastCall("POST", /^\/labels$/).body.labelListVisibility === "labelShow", "create: " + JSON.stringify(c.result));
  await api.folders();
  mock.calls.length = 0;
  await api.renameFolder("Label_1", "Work");
  const patches = mock.calls.filter(x => x.method === "PATCH").map(x => [x.path, x.body.name]);
  ok(JSON.stringify(patches) === JSON.stringify([["/labels/Label_1", "Work"], ["/labels/Label_2", "Work/FPGA"], [`/labels/${c.result.id}`, "Work/New"]]), "rename cascades: " + JSON.stringify(patches));
  // a label whose mail is all in Trash holds none, whatever its counts say; one in Inbox holds some
  // (asked, as Delete asks, with the folder list read afresh)
  await api.folders();
  mock.addMessage({ id: "tr1", labels: [c.result.id, "TRASH"], subject: "gone", from: "t <t@x.com>", cc: "", html: "<p>t</p>" });
  const onlyTrash = await api.holdsMail([c.result.id]);
  mock.addMessage({ id: "tr2", labels: [c.result.id, "INBOX"], subject: "kept", from: "t <t@x.com>", cc: "", html: "<p>t</p>" });
  const kept = await api.holdsMail([c.result.id]), tree = await api.holdsMail(["Label_1", c.result.id]);
  ok(onlyTrash === false && kept === true && tree === true && lastCall("GET", /^\/messages$/).q.maxResults === "1", "holdsMail asks one listing of one message: " + JSON.stringify({ onlyTrash, kept, tree }));
  for (const id of ["tr1", "tr2"]) mock.messages.delete(id);
  await api.deleteFolder(c.result.id);
  ok(!mock.labels.some(l => l.id === c.result.id), "delete");
  const badId = await outcome(api.deleteFolder("ALL"));
  ok(badId.e instanceof api.ApiError, "All Mail cannot be deleted");
  mock.calls.length = 0;
  const unread = [...mock.messages.values()].filter(m => m.labelIds.includes("INBOX") && m.labelIds.includes("UNREAD")).length;
  const mr = await api.markFolderRead("INBOX", unread);
  ok(unread > 0 && mr.changed === unread && lastCall("GET", /^\/messages$/).q.labelIds === "INBOX,UNREAD" && !("includeSpamTrash" in lastCall("GET", /^\/messages$/).q) && [...mock.messages.values()].every(m => !m.labelIds.includes("INBOX") || !m.labelIds.includes("UNREAD")), "mark folder read: " + JSON.stringify([unread, mr.changed, lastCall("GET", /^\/messages$/).q]));
  const inTrash = [...mock.messages.values()].filter(m => m.labelIds.includes("TRASH")).length;
  const em = await api.emptyFolder("TRASH", inTrash);
  ok(inTrash > 0 && em.changed === inTrash && ![...mock.messages.values()].some(m => m.labelIds.includes("TRASH")) && lastCall("GET", /^\/messages$/).q.includeSpamTrash === "true", "empty Trash deletes for good: " + JSON.stringify([inTrash, em.changed]));
}
// accounts
{
  const a = await api.accounts();
  ok(a.accounts.length === 2 && a.accounts[0].email === "me@gmail.com" && a.accounts[0].isPrimary && a.accounts[0].sendingName === "Me Myself" && a.accounts[0].signatureActive && a.accounts[1].type === "ALIAS" && a.accounts[1].replyToAddress === "r@x.com", "accounts from sendAs: " + JSON.stringify(a.accounts));
}
// drafts: the draft id is the csid; saves keep it while the message id changes; send consumes it
{
  const d = { csid: "1762000000000", from: { name: "Me", email: "me@gmail.com" }, to: [{ email: "a@x.com" }], cc: [], bcc: [], subject: "Re: Subject m-3", inReplyTo: { id: "m3", replied: true }, files: [new File([new Uint8Array([1, 2, 3])], "x.bin")], refs: [{ messageId: "m3", partId: "1", filename: "report.pdf", size: 4 }], html: "<p>hi</p>", inline: [] };
  mock.uploads.length = 0;
  const s1 = await api.saveDraft(d);
  const up = mock.uploads[0];
  ok(/^r-new\d+$/.test(s1.message.csid) && /^dm\d+$/.test(s1.message.id) && s1.message.attachments.length === 0 && !s1.partial, "first save creates the draft: " + JSON.stringify(s1.message));
  ok(up.path === "/upload/drafts" && up.method === "POST" && up.meta.message.threadId === "t-m3", "multipart upload names the thread: " + JSON.stringify(up.meta));
  const h = headersOf(new TextEncoder().encode(up.raw));
  ok(h["in-reply-to"] === "<m3@x.com>" && h.references === "<m3@x.com>" && h.subject === "Re: Subject m-3" && h.to === "a@x.com", "reply headers chain to the original: " + JSON.stringify(h));
  const parts = listParts(new TextEncoder().encode(up.raw)).parts.map(p => [p.partId, p.type, p.filename]);
  ok(JSON.stringify(parts) === JSON.stringify([["1", "text/html", ""], ["2", "application/octet-stream", "x.bin"], ["3", "application/pdf", "report.pdf"]]), "files and forwarded parts are embedded: " + JSON.stringify(parts));
  const s2 = await api.saveDraft({ ...d, csid: s1.message.csid });
  ok(mock.uploads[1].path === `/upload/drafts/${s1.message.csid}` && mock.uploads[1].method === "PUT" && s2.message.csid === s1.message.csid && s2.message.id !== s1.message.id, "a second save updates the same draft, with a new message id: " + JSON.stringify(s2.message));
  const rows = await api.list("DRAFT", 10, 0);
  ok(rows.messages.find(m => m.id === "d1")?.csid === "r-d1" && rows.messages.find(m => m.id === s2.message.id)?.csid === s2.message.csid, "draft rows carry their draft ids");
  const del = await api.deleteForever([s2.message.id]);
  ok(del.ok.join() === s2.message.id && lastCall("DELETE", /^\/drafts\//).path === `/drafts/${s2.message.csid}`, "discarding a draft deletes the draft: " + JSON.stringify(lastCall("DELETE", /^\/drafts\//)));
  const s3 = await api.saveDraft({ ...d, subject: "New thread", inReplyTo: null, refs: [], files: [] });
  ok(!mock.uploads.at(-1).meta.message.threadId, "a new message starts its own thread");
  const sent = await api.send({ ...d, csid: s3.message.csid, subject: "New thread", inReplyTo: null, refs: [], files: [] }, "SENT");
  ok(/^sent\d+$/.test(sent.message.id) && mock.uploads.at(-1).path === "/upload/drafts/send" && mock.uploads.at(-1).meta.id === s3.message.csid && !mock.drafts.some(x => x.id === s3.message.csid), "sending a saved draft sends that draft: " + JSON.stringify(mock.uploads.at(-1).meta));
  const sent2 = await api.send({ ...d, csid: "9", inReplyTo: null, refs: [], files: [], subject: "Fwd: Subject m-3" }, "SENT");
  ok(/^sent\d+$/.test(sent2.message.id) && mock.uploads.at(-1).path === "/upload/messages/send", "a message never saved is sent on its own");
  await api.send({ ...d, csid: "10", inReplyTo: { id: "m3", replied: true }, subject: "Something else", refs: [], files: [] }, "SENT");
  ok(!mock.uploads.at(-1).meta.threadId, "a changed subject leaves the thread: " + JSON.stringify(mock.uploads.at(-1).meta));
  // a thread Gmail refuses is tried once without it, whether the JSON is the message or holds it
  mock.refuseThread = "t-m3";
  const uploaded = mock.uploads.length;
  const rs = await outcome(api.send({ ...d, csid: "11", refs: [], files: [] }, "SENT"));
  const [first, second] = mock.uploads.slice(uploaded);
  ok(/^sent\d+$/.test(rs.value?.message.id || "") && mock.uploads.length === uploaded + 2 && first.path === "/upload/messages/send" && first.meta.threadId === "t-m3" && second.path === "/upload/messages/send" && !("threadId" in second.meta), "a send whose thread is refused goes out without it: " + JSON.stringify([rs.e?.message, first?.meta, second?.meta]));
  const rd = await outcome(api.saveDraft({ ...d, csid: "12", refs: [], files: [] }));
  ok(rd.value && mock.uploads.at(-2).meta.message.threadId === "t-m3" && !("threadId" in mock.uploads.at(-1).meta.message), "and so is a draft saved: " + JSON.stringify([rd.e?.message, mock.uploads.at(-1).meta]));
  mock.refuseThread = null;
  await api.deleteForever([rd.value.message.id]);
  // a draft deleted elsewhere: the next save makes a new draft, and a send goes out on its own
  const plain = { ...d, subject: "Gone", inReplyTo: null, refs: [], files: [] };
  const g1 = await api.saveDraft(plain);
  mock.drafts.splice(mock.drafts.findIndex(x => x.id === g1.message.csid), 1);
  const g2 = await api.saveDraft({ ...plain, csid: g1.message.csid });
  ok(g2.message.csid !== g1.message.csid && mock.drafts.some(x => x.id === g2.message.csid) && mock.uploads.at(-1).path === "/upload/drafts", "a save of a draft gone elsewhere creates a new one: " + JSON.stringify([g1.message.csid, g2.message.csid]));
  mock.drafts.splice(mock.drafts.findIndex(x => x.id === g2.message.csid), 1);
  const g3 = await api.send({ ...plain, csid: g2.message.csid }, "SENT");
  ok(/^sent\d+$/.test(g3.message.id) && mock.uploads.at(-1).path === "/upload/messages/send", "a send of a draft gone elsewhere is sent on its own: " + mock.uploads.at(-1).path);
}
// background work (the address-book build): small batches, one request every few seconds, out of
// the way of the user's own calls; Gmail refusing it for quota holds it alone
{
  for (let i = 1; i <= 15; i++) mock.deliver(`bg${i}`, `Background ${i}`);
  const from = fetched.length, batchesFrom = mock.batches.length;
  // the last batch (the oldest rows) has one row refused for a quota minute that ends seconds later
  mock.failItems = { status: 429, times: 1, match: /\/messages\/bg1\?/, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }],
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "6000", window_start_time: String(Math.floor(Date.now() / 1000) - 45) } }] } } };
  const bg = outcome(api.list("INBOX", 15, 0, { background: true }));
  for (let i = 0; i < 400 && mock.failItems.times > 0; i++) await new Promise(r => setTimeout(r, 50));
  const refusedAt = Date.now();
  const f0 = Date.now(), fg = await outcome(api.body("bg15")), fgMs = Date.now() - f0;
  const r = await bg;
  mock.failItems = null;
  const own = fetched.slice(from).filter(x => !/\/messages\/bg15\?/.test(x.url));
  const gaps = own.slice(1).map((x, i) => x.at - own[i].at);
  const sizes = mock.batches.slice(batchesFrom).map(b => b.length);
  const retryAt = own.at(-1).at;
  ok(r.value?.messages.length === 15 && fg.value?.message && fgMs < 1500 && retryAt - refusedAt >= 900,
    "a quota refusal of background work holds it alone; the user's call goes at once: " + JSON.stringify({ rows: r.value?.messages.length, e: r.e?.message || fg.e?.message, fgMs, retryAfter: retryAt - refusedAt }));
  ok(sizes.length >= 3 && sizes.every(n => n <= 10) && sizes.reduce((a, b) => a + b, 0) === 16 && gaps.every(g => g >= 3900),
    "background work goes in batches of at most 10, one request every 4 seconds: " + JSON.stringify({ sizes, gaps }));
}
// tokens: a 401 renews once silently; a second one means signed out; rate limits are retried
{
  silentOk = true;
  mock.calls.length = 0;
  mock.fail = { status: 401, times: 1 };
  const r = await api.folders();
  const hint = new URL(flows.at(-1).url).searchParams;
  ok(r.folders.length > 0 && store.gmToken.access_token === "tok2" && mock.calls.some(c => c.auth === "Bearer tok2") && !flows.at(-1).interactive && hint.get("prompt") === "none" && hint.get("login_hint") === "me@gmail.com" && hint.get("client_id") === CID, "a 401 gets one silent renewal for the same account and client, and the call is repeated: " + JSON.stringify({ token: store.gmToken?.access_token, url: flows.at(-1).url }));
  // a renewal Google answers for another account is refused, and the account is kept
  mock.profile.emailAddress = "other@gmail.com";
  mock.fail = { status: 401, times: 1 };
  const rx = await outcome(api.folders());
  mock.profile.emailAddress = "me@gmail.com";
  ok(rx.e instanceof api.NotSignedIn && /other@gmail\.com/.test(rx.e.message) && !store.gmToken && local.gmAccount === "me@gmail.com", "a token for another account is refused: " + JSON.stringify({ e: rx.e?.message, token: store.gmToken, local }));
  await api.bootstrap();
  silentOk = false;
  mock.fail = { status: 401, times: 2 };
  const r2 = await outcome(api.folders());
  ok(r2.e instanceof api.NotSignedIn, "a 401 that renewal cannot fix means signed out: " + r2.e?.name);
  // a renewal that never reached Google is not a lost session but the connection's failure, the
  // account kept (told at once here, as at the client's start, rather than after a minute's asking)
  silentOk = true; await api.bootstrap();
  silentDown = "Authorization page could not be loaded.";
  mock.fail = { status: 401, times: 1 };
  api.link.waits = false;
  const rd = await outcome(api.folders());
  api.link.waits = true;
  silentDown = "";
  ok(rd.e instanceof api.Offline && local.gmAccount === "me@gmail.com", "a renewal Google never answered is the connection's failure: " + JSON.stringify({ name: rd.e?.name, message: rd.e?.message, local }));
  const rd2 = await outcome(api.folders());
  ok(rd2.value?.folders.length > 0 && store.gmToken?.access_token, "the next call renews again and succeeds: " + (rd2.e?.message || store.gmToken?.access_token));
  // Google's refusal of a silent renewal is a lost session
  silentRefusal = "login_required";
  mock.fail = { status: 401, times: 1 };
  const rr = await outcome(api.folders());
  silentRefusal = "";
  ok(rr.e instanceof api.NotSignedIn && !store.gmToken?.access_token, "a renewal Google refuses means signed out: " + JSON.stringify({ name: rr.e?.name, token: store.gmToken }));
  await api.bootstrap();
  mock.fail = { status: 429, times: 2 };
  const t0 = Date.now();
  const r3 = await outcome(api.folders());
  ok(r3.value?.folders.length > 0 && Date.now() - t0 >= 500, "429 is retried after a pause: " + (r3.e?.message || `${Date.now() - t0} ms`));
  mock.fail = { status: 403, times: 1, body: { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }], message: "slow down" } } };
  ok((await outcome(api.folders())).value?.folders.length > 0, "a 403 rate limit is retried too");
  // a quota refusal names Gmail's minute: every call waits until it is over, then asks again
  const windowStart = Math.floor(Date.now() / 1000) - 58;
  mock.fail = { status: 403, times: 1, body: { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }], status: "PERMISSION_DENIED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "6000", window_start_time: String(windowStart) } }] } } };
  const tq = Date.now();
  const rq = await outcome(api.list("INBOX", 3, 0));
  ok(rq.value?.messages.length === 3 && Date.now() >= (windowStart + 60) * 1000, "a quota refusal waits for Gmail's minute to end: " + (rq.e?.message || `${Date.now() - tq} ms`));
  // a token without the mail scope, as Google answers it: the status is PERMISSION_DENIED, and the
  // scope is named among the errors and in the details, either of which is enough
  const errors = [{ message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" }];
  const details = [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com", metadata: { service: "gmail.googleapis.com" } }];
  const scope = { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" };
  for (const error of [{ ...scope, errors, details }, { ...scope, errors }, { ...scope, details }]) {
    mock.fail = { status: 403, times: 1, body: { error } };
    const r4 = await outcome(api.folders());
    ok(r4.e instanceof api.NotSignedIn && /permission/.test(r4.e.message) && !store.gmToken?.access_token, "a missing scope asks for a new sign-in: " + JSON.stringify([Object.keys(error), r4.e?.name, r4.e?.message]));
    await api.bootstrap();
  }
  mock.fail = { status: 403, times: 1, body: { error: { code: 403, message: "Delegation denied", status: "PERMISSION_DENIED", errors: [{ reason: "forbidden" }] } } };
  const r4b = await outcome(api.folders());
  ok(r4b.e instanceof api.ApiError && !(r4b.e instanceof api.NotSignedIn) && store.gmToken?.access_token, "any other refusal is an error, with the sign-in kept: " + JSON.stringify([r4b.e?.name, r4b.e?.message]));
  const held = store.gmToken.access_token;
  mock.failRevoke = 1;
  const so1 = await outcome(api.signOut());
  ok(/still signed in/.test(so1.e?.message) && store.gmToken?.access_token === held && local.gmAccount === "me@gmail.com", "a sign-out Google does not confirm leaves the user signed in: " + so1.e?.message);
  mock.calls.length = 0;
  await api.signOut();
  const rv = mock.calls.find(c => c.path === "/revoke");
  ok(!store.gmToken && !local.gmAccount && mock.revoked.includes(held) && rv && !rv.q.token, "sign-out revokes the token, sent in the body, and forgets the token and the account: " + JSON.stringify({ rv, local }));
  const n = flows.length;
  const r5 = await outcome(api.bootstrap());
  ok(r5.e instanceof api.NotSignedIn && flows.length === n, "after sign-out nothing signs in again until the button is pressed: " + JSON.stringify({ e: r5.e?.name, flows: flows.length - n }));
  const after = await api.setup.view();
  ok(local.gmClientId === CID && after.kind === "ready" && after.own && /Sign in with your Google™ account/.test(after.text), "sign-out keeps the Client ID, so the page is one button: " + JSON.stringify({ kind: after.kind, client: local.gmClientId }));
}
// the button's failures, each with its code and its words; a token whose account could not be
// confirmed is held, and the next press confirms it without a window
{
  const press = async answer => { pressed = answer; const r = await outcome(api.signIn()); pressed = null; return r; };
  const n0 = flows.length;
  const closed = await press({ reject: "The user did not approve access." });
  const unloaded = await press({ reject: "Authorization page could not be loaded." });
  const denied = await press({ fragment: "error=access_denied" });
  const refused = await press({ fragment: "error=redirect_uri_mismatch" });
  const odd = await press({ fragment: "error=%3Cb%3Ex" });
  ok([closed, unloaded, denied, refused, odd].map(r => r.e?.code).join() === "closed,unreachable,denied,refused,refused" && refused.e.google === "redirect_uri_mismatch" && odd.e.google === "" && flows.length === n0 + 5 && !store.gmToken && !local.gmAccount,
    "each way the button's sign-in fails has its code: " + JSON.stringify([closed, unloaded, denied, refused, odd].map(r => [r.e?.code, r.e?.google, r.e?.message])));
  const [aClosed, aUnloaded, aDenied, aRefused] = await Promise.all([closed, unloaded, denied, refused].map(r => api.setup.explain(r.e)));
  ok(aClosed.help && !aClosed.held && /closed before/.test(aClosed.text) && /could not be loaded/.test(aUnloaded.text) && !aUnloaded.help && /cancelled/.test(aDenied.text) && aRefused.help && aRefused.pick === "redirect_uri_mismatch",
    "each failure has its own words, and help where Google's window may have said more: " + JSON.stringify([aClosed, aUnloaded, aDenied, aRefused]));
  // Google gives a token, but the Gmail API is off in the client's project
  mock.fail = { status: 403, times: 1, body: { error: { code: 403, message: "Gmail API has not been used in project 123456789012 before or it is disabled.", status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }], details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com" }] } } };
  const off = await press(null);
  const aOff = await api.setup.explain(off.e);
  ok(off.e?.code === "api-off" && off.e.held && !store.gmToken && aOff.held && aOff.button === "Continue" && aOff.open.href.endsWith("?project=123456789012"), "a sign-in into a project without the Gmail API says so, holds the token, and links to the API: " + JSON.stringify({ code: off.e?.code, aOff }));
  const n1 = flows.length, heldToken = `tok${tokens}`;
  const on = await outcome(api.signIn());
  ok(on.value?.email === "me@gmail.com" && flows.length === n1 && store.gmToken?.access_token === heldToken, "the next press confirms the held token, with no window: " + JSON.stringify({ e: on.e?.message, flows: flows.length - n1, token: store.gmToken?.access_token }));
  // the account check cannot be made: the token is held too
  mock.fail = { status: 503, times: 1 };
  const down = await press(null);
  const n2 = flows.length;
  const again = await outcome(api.signIn());
  ok(down.e?.code === "unconfirmed" && down.e.held && /HTTP 503/.test(down.e.message) && (await api.setup.explain(down.e)).button === "Continue" && again.value && flows.length === n2, "a check that could not be made holds the token for the next press: " + JSON.stringify({ code: down.e?.code, message: down.e?.message, flows: flows.length - n2 }));
  // the user's own client wins over one the build carries; Use a different Client ID goes back to the build's
  manifest.oauth2 = { client_id: "999999999999-builtin000000.apps.googleusercontent.com", scopes: ["https://mail.google.com/"] };
  await press(null);
  const ownFlow = new URL(flows.at(-1).url).searchParams.get("client_id");
  await api.setup.reset();
  const reset = await api.setup.view();
  await press(null);
  const builtFlow = new URL(flows.at(-1).url).searchParams.get("client_id");
  ok(ownFlow === CID && !local.gmClientId && reset.kind === "guide" && reset.step === "paste" && !reset.own && builtFlow === "999999999999-builtin000000.apps.googleusercontent.com", "the user's own Client ID wins over the build's, and without it the build's is used: " + JSON.stringify({ ownFlow, builtFlow, reset: [reset.kind, reset.step] }));
  // a remembered account whose sign-in ended is named
  delete manifest.oauth2; await api.setup.paste(CID); delete local.gmSetup; local.gmAccount = "me@gmail.com";
  const ended = await api.setup.view();
  ok(ended.kind === "ended" && /me@gmail\.com/.test(ended.text), "a sign-in that ended names its account: " + JSON.stringify([ended.kind, ended.text]));
}
// Renewal: in its last ten minutes the token is renewed beside the requests, and none of them
// waits; a request waits only for a token that has all but run out, and the client is told; a
// silent flow that never answers is given up.
{
  const soon = () => new Promise(r => setTimeout(r, 20));
  const leave = ms => { skew += store.gmToken.expires - Date.now() - ms; };      // the token has ms left
  const said = [], unwatch = api.activity.watch(() => { const w = api.activity.waiting(); if (w) said.push(w.text); });
  silentOk = true;
  await api.bootstrap();
  const old = store.gmToken.access_token;
  said.length = 0;
  leave(9 * 60e3);
  let open;
  silentGate = new Promise(r => { open = r; });
  const n = flows.length;
  mock.calls.length = 0;
  const t0 = realNow(), r = await outcome(api.folders()), took = realNow() - t0;
  ok(r.value?.folders.length > 0 && took < 1000 && flows.length === n + 1 && !flows.at(-1).interactive && store.gmToken.access_token === old && mock.calls.every(c => c.auth === `Bearer ${old}`) && !said.includes("renewing the Google sign-in"),
    "a token in its last ten minutes is renewed beside the request, which does not wait: " + JSON.stringify({ e: r.e?.message, took, flows: flows.length - n, said }));
  open(); silentGate = null;
  for (let i = 0; i < 100 && store.gmToken.access_token === old; i++) await soon();
  mock.calls.length = 0;
  await api.folders();
  const fresh = store.gmToken.access_token;
  ok(fresh !== old && flows.length === n + 1 && mock.calls.length > 0 && mock.calls.every(c => c.auth === `Bearer ${fresh}`), "the renewed token takes its place, with no second flow: " + JSON.stringify({ fresh, flows: flows.length - n }));
  // a renewal ahead of time that fails says nothing, changes nothing, and is tried again a minute on
  leave(9 * 60e3);
  silentDown = "Authorization page could not be loaded.";
  const n2 = flows.length;
  const a1 = await outcome(api.folders());
  await soon();
  const a2 = await outcome(api.folders());
  const tried = flows.length - n2;
  skew += 61e3;
  const a3 = await outcome(api.folders());
  await soon();
  silentDown = "";
  ok(a1.value && a2.value && a3.value && tried === 1 && flows.length === n2 + 2 && store.gmToken.access_token === fresh, "a failed renewal ahead of time is silent, and tried again after a minute: " + JSON.stringify({ e: (a1.e || a2.e || a3.e)?.message, tried, flows: flows.length - n2 }));
  // under a minute left: the token is not used, the request waits for the renewal, and says so
  leave(30e3);
  silentGate = new Promise(r => { open = r; });
  const waited = outcome(api.folders());
  await soon();
  const w = api.activity.waiting();
  open(); silentGate = null;
  const rw = await waited;
  ok(w?.text === "renewing the Google sign-in" && rw.value?.folders.length > 0 && store.gmToken.access_token !== fresh && !api.activity.waiting(), "a request waits for the renewal of a token that has run out, and the wait is told: " + JSON.stringify({ w, e: rw.e?.message }));
  // a silent flow that never answers
  const whole = api.TIMEOUTS.renew;
  api.TIMEOUTS.renew = 150;
  silentGate = new Promise(() => {});
  mock.fail = { status: 401, times: 1 };
  api.link.waits = false;
  const th = realNow(), rh = await outcome(api.folders()), hung = realNow() - th;
  api.link.waits = true;
  silentGate = null; api.TIMEOUTS.renew = whole;
  ok(rh.e instanceof api.Offline && hung < 3000 && local.gmAccount === "me@gmail.com", "a silent flow with no answer is given up as a renewal that never reached Google: " + JSON.stringify({ name: rh.e?.name, message: rh.e?.message, hung }));
  const rh2 = await outcome(api.folders());
  ok(rh2.value?.folders.length > 0 && store.gmToken?.access_token, "and the next call renews: " + (rh2.e?.message || store.gmToken?.access_token));
  unwatch();
}
// What a request waits for is told and kept for the report; a read, or a change of labels, with no
// answer is asked a second time, and a send never is.
{
  const windowStart = Math.floor(Date.now() / 1000) - 58;
  mock.fail = { status: 403, times: 1, body: { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }], status: "PERMISSION_DENIED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "6000", window_start_time: String(windowStart) } }] } } };
  const seen = [], unwatch = api.activity.watch(() => { const w = api.activity.waiting(); if (w) seen.push({ ...w }); });
  const rq = await outcome(api.list("INBOX", 3, 0));
  unwatch();
  const limit = seen.find(x => x.text === "Gmail's request limit is reached");
  ok(rq.value?.messages.length === 3 && limit && Math.abs(limit.until - (windowStart + 60) * 1000) < 1500 && !api.activity.waiting() && /waited +Gmail's request limit is reached/.test(api.activity.report()),
    "a call held for Gmail's minute is a wait with its end, kept for the report: " + JSON.stringify({ e: rq.e?.message, seen }));
  const first = api.TIMEOUTS.first, slow = api.TIMEOUTS.slow, batchMs = api.TIMEOUTS.batch, perMB = api.TIMEOUTS.perMB;
  const once = re => { let n = 0; hang = (method, url) => re.test(url) && n++ === 0; };
  const asked = (from, re) => fetched.slice(from).filter(x => re.test(x.url)).length;
  // a list whose first request gets no answer
  api.TIMEOUTS.first = 300; api.TIMEOUTS.slow = 50;
  once(/\/messages\?/);
  let from = fetched.length;
  const listing = outcome(api.list("INBOX", 3, 0));
  await new Promise(r => setTimeout(r, 150));
  const late = api.activity.waiting();
  const rl = await listing;
  ok(rl.value?.messages.length === 3 && asked(from, /\/messages\?/) === 2 && late?.text === "no answer from Gmail yet" && !late.until && !api.activity.waiting(), "a read with no answer is told as late, given up early and asked again: " + JSON.stringify({ e: rl.e?.message, asked: asked(from, /\/messages\?/), late }));
  // a star, which goes in a batch of label changes
  api.TIMEOUTS.slow = slow;
  const starred = mock.messages.get("m1").labelIds.includes("STARRED");
  once(/\/batch\//);
  from = fetched.length;
  const rs = await outcome(api.setStarred(["m1"], !starred));
  hang = null;
  ok(rs.value?.ok.join() === "m1" && asked(from, /\/batch\//) === 2 && mock.messages.get("m1").labelIds.includes("STARRED") === !starred, "a change of labels with no answer is asked again: " + JSON.stringify({ e: rs.e?.message, asked: asked(from, /\/batch\//) }));
  await api.setStarred(["m1"], starred);
  // a send has the one deadline, and one request
  api.TIMEOUTS.batch = 300; api.TIMEOUTS.perMB = 0;
  once(/\/upload\//);
  from = fetched.length;
  const sent = await outcome(api.send({ csid: "c-hang", from: { name: "Me", email: "me@gmail.com" }, to: [{ name: "", email: "ann@x.com" }], cc: [], bcc: [], subject: "No answer", html: "<p>hi</p>", files: [], refs: [], inline: [] }));
  hang = null;
  Object.assign(api.TIMEOUTS, { first, slow, batch: batchMs, perMB });
  ok(sent.e instanceof api.Timeout && /may still have been sent/.test(sent.e.message) && asked(from, /\/upload\//) === 1, "a send with no answer is not asked again: " + JSON.stringify({ e: sent.e?.message, asked: asked(from, /\/upload\//) }));
  // the report: a line that sums it up, then a line a request, its ids left out
  api.activity.note("GET /messages/1a212c40a0245247/attachments/ANGjdJ8w_x-y0", 7, 200);
  const lines = api.activity.report().split("\n");
  ok(/^\d+ requests, the slowest \d+ ms; \d+ waits, \d+ s in all, the longest \d+ ms$/.test(lines[0]) && /^\d\d:\d\d:\d\d +7 ms  200 +GET \/messages\/\*\/attachments\/\*$/.test(lines.at(-1)) && lines.some(l => /no answer +GET \/messages$/.test(l)) && lines.length <= 301,
    "the report sums up, and names no id: " + JSON.stringify([lines[0], lines.at(-1), lines.length]));
}
// Paging to the exact end of a list, a search in All Mail, and a send that Gmail answers with a
// server error after it was sent.
{
  for (const id of ["pg1", "pg2", "pg3", "pg4"]) mock.addMessage({ id, labels: ["Label_pg"], subject: id, from: "p <p@x.com>", cc: "", html: "<p>p</p>" });
  const page = async off => (await api.list("Label_pg", 2, off)).messages.map(x => x.id).join();
  const pages = [await page(0), await page(2), await page(4)];
  ok(pages[0].split(",").length === 2 && pages[1].split(",").length === 2 && pages[2] === "", "a page past the exact end of a list is empty: " + JSON.stringify(pages));
  for (const id of ["pg1", "pg2", "pg3", "pg4"]) mock.messages.delete(id);
  const elsewhere = await api.searchScoped("Subject", { exclude: { ids: ["ALL"] } }, 50, 0);
  ok(elsewhere.messages.length === 0, "nothing is outside All Mail: " + elsewhere.messages.length);
  const sentCopies = subject => [...mock.messages.values()].filter(m => m.labelIds.includes("SENT") && JSON.stringify(m).includes(subject)).length;
  for (const via of ["messages", "drafts"]) {
    const subject = `Once via ${via}`;
    const d = { csid: `c-${via}`, from: { name: "Me", email: "me@gmail.com" }, to: [{ name: "", email: "ann@x.com" }], cc: [], bcc: [], subject, html: "<p>hi</p>", files: [], refs: [], inline: [] };
    if (via === "drafts") d.csid = (await api.saveDraft(d)).message.csid;
    let first = true;
    before = (method, url, body, headers) => {
      if (!first || !url.includes(`/upload/gmail/v1/users/me/${via}/send`)) return null;
      first = false;
      gm.respond(method, url, body, headers);           // Gmail sends it, and its answer is lost
      return { status: 503, json: { error: { code: 503, message: "The service is currently unavailable.", errors: [{ reason: "backendError" }] } } };
    };
    const got = await outcome(api.send(d));
    before = null;
    ok(/may still have been sent/.test(got.e?.message || "") && sentCopies(subject) === 1, `a send answered 503 (${via}.send) is not sent again: ` + JSON.stringify({ error: got.e?.message, copies: sentCopies(subject) }));
  }
}
// A change of more than a thousand messages goes a thousand at a time; when a later thousand
// fails, those done before it are reported as done.
{
  const ids = Array.from({ length: 1500 }, (_, i) => `bk${i}`);
  for (const id of ids) mock.addMessage({ id, labels: ["Label_bk", "UNREAD"], subject: id, from: "b <b@x.com>", cc: "", html: "<p>b</p>" });
  let n = 0;
  before = (method, url) => url.includes("/messages/batchModify") && ++n === 2 ? { status: 400, json: { error: { code: 400, message: "Invalid ids" } } } : null;
  const r = await outcome(api.setRead(ids, true));
  before = null;
  ok(r.value?.ok.length === 1000 && r.value.failed.length === 500 && r.value.failed[0] === "bk1000", "a later thousand that fails leaves the first reported done: " + JSON.stringify({ ok: r.value?.ok.length, failed: r.value?.failed.length, e: r.e?.message }));
  for (const id of ids) mock.messages.delete(id);
}
// A full row cache: a list keeps the rows it already had when fetching its new ones makes room.
// Last, as it runs on a clock of its own, so that filling the cache waits on no quota.
{
  let now = Date.now();
  const realTimeout = globalThis.setTimeout;
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms = 0, ...a) => { now += Math.max(0, ms || 0); return realTimeout(fn, 0, ...a); };
  const t = Math.floor(now / 1000);
  for (let i = 0; i < 5000; i++) mock.addMessage({ id: `k${i}`, labels: ["Label_keep"], subject: `keep ${i}`, from: "k <k@x.com>", cc: "", date: t - i, html: "<p>k</p>" });
  const all = await api.list("Label_keep", 5000, 0);       // the cache now holds these rows only, k0 the oldest
  mock.addMessage({ id: "knew", labels: ["Label_keep"], subject: "keep new", from: "k <k@x.com>", cc: "", date: t + 60, html: "<p>k</p>" });
  const top = await api.list("Label_keep", 20, 0);
  ok(all.messages.length === 5000 && top.messages.map(x => x.id).join() === ["knew", ...Array.from({ length: 19 }, (_, i) => `k${i}`)].join(),
    "a list with one new row keeps its kept rows: " + top.messages.map(x => x.id).slice(0, 4).join() + ` (${top.messages.length})`);
  for (let i = 0; i < 5000; i++) mock.messages.delete(`k${i}`);
  mock.messages.delete("knew");
  // A refusal that names a lower limit than the pace was set for lowers the pace to it: what went
  // without a wait before then takes its minute. (The timers every request sets would move this
  // clock on by themselves, so they are set to nothing.)
  const { slow, first } = api.TIMEOUTS;
  api.TIMEOUTS.slow = 0; api.TIMEOUTS.first = 0;
  const any = [...mock.messages.keys()].find(id => !mock.messages.get(id).labelIds.includes("DRAFT"));
  const spend = async () => { const t = now; for (let i = 0; i < 130; i++) await api.body(any); return now - t; };
  now += 61e3;
  const free = await spend();
  mock.fail = { status: 429, times: 1, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }],
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "600", window_start_time: String(Math.floor(now / 1000) - 59) } }] } } };
  await api.body(any);
  const paced = await spend();
  Object.assign(api.TIMEOUTS, { slow, first });
  ok(free < 5000 && paced >= 55e3, "a lower limit named in a refusal lowers the pace: " + JSON.stringify({ free, paced }));
  globalThis.setTimeout = realTimeout;
}
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
