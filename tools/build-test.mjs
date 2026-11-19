// The build's own machinery: reading a file's code without its comments, which the check that no
// edition names another edition's hosts rests on, bringing a finished build into its folder, and
// the manifest it writes.
// node tools/build-test.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { build, EDITIONS, withoutComments, names, sync } = createRequire(import.meta.url)("./build.js");
let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
const named = (text, type = "js") => names(text, type, EDITIONS.yahoo.hosts);

// ---------- comments ----------
ok(withoutComments("a /* b */ c // d\ne", "js") === "a   c \ne", "block and line comments go, the rest stays: " + JSON.stringify(withoutComments("a /* b */ c // d\ne", "js")));
ok(!named("// talks to Yahoo\nconst a = 1; /* yahoo.com */\n") && named('fetch("https://mail.yahoo.com/");'), "a host counts in code, not in a comment");
// comment markers inside strings neither start a comment nor hide the code between them
ok(named('const open = "/*"; fetch(host("yahoo")); const close = "*/";'), "code between \"/*\" and \"*/\" strings is read");
ok(named("const u = 'a//b'; const h = \"yahoo\";") && named('const u = "https://x.example/"; const h = "yahoo";'), "a // inside a string does not end the line's code");
ok(!named("const u = 'it\\'s // fine'; // yahoo"), "an escaped quote does not end the string");
// literals added together read as one
ok(named('const h = "ya" + "hoo";') && named("const h = 'ya' +\n  'hoo.com';") && named('const h = `ya` + "hoo";') && named('const h = "ya" /* split */ + "hoo";'), "a name split over added literals is read whole");
// regular expressions are stepped over, so a quote in one opens no string
ok(!named("const s = t.replace(/'/g, \"\"); // yahoo") && !named("if (/[/\"]/.test(s)) n++; // yahoo") && named("const re = /\"/; const h = \"yahoo\";"), "a quote in a regular expression opens no string");
ok(!named("const half = total / 2, rest = total / 3; // yahoo") && named("const mean = total / count + ' yahoo ' + n / 2;"), "a division is not a regular expression");
// template literals: the text is text, each ${...} is code again
ok(named("const s = `see http://x.example`; const h = \"yahoo\";") && named("const s = `a ${b /* gone */} // yahoo`;"), "a template's text is kept, comment markers and all");
ok(!named("const s = `${x ? `//` : \"\"}` + 1; // yahoo") && !named("const s = `${f({ a: `}` })}`; // yahoo") && named("const s = `${\"ya\" + \"hoo\"}`;"), "the code inside ${...} is read as code, nested templates too");
// other file types
ok(!named("<!-- as Yahoo does -->\n<p>hi</p>", "html") && named('<a href="https://mail.yahoo.com/">x</a>', "html"), "HTML comments do not count");
ok(!named("/* yahoo */ a { background: url(http://x.example/a.png) }", "css") && named('a::after { content: "/*" } .yahoo { color: red } b::after { content: "*/" }', "css") && named("a { background: url(http://x.example/a.png) } .yahoo { color: red }", "css"), "CSS has block comments only, outside strings");
ok(named('{ "a": "/* x", "host": "yahoo", "b": "*/" }', "json") && named('{ "hosts": ["https://mail.yahoo.com/*"] }', "json"), "JSON is read whole");

// ---------- sync ----------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baltazar-mail-build-"));
  const put = (rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
  const has = rel => fs.existsSync(path.join(root, rel));
  try {
    for (const [rel, content] of [["from/same.txt", "1"], ["from/sub/changed.txt", "new"], ["from/sub/added.txt", "3"], ["from/file-now", "4"], ["from/dir-now/x.txt", "5"]]) put(rel, content);
    for (const [rel, content] of [["to/same.txt", "1"], ["to/sub/changed.txt", "old"], ["to/gone.txt", "x"], ["to/gone-dir/y.txt", "x"], ["to/file-now/was-a-folder.txt", "x"], ["to/dir-now", "was a file"]]) put(rel, content);
    const before = fs.statSync(path.join(root, "to/same.txt"));
    sync(path.join(root, "from"), path.join(root, "to"));
    const after = fs.statSync(path.join(root, "to/same.txt"));
    ok(read("to/same.txt") === "1" && after.mtimeMs === before.mtimeMs && after.ino === before.ino, "a file with the same content is left alone");
    ok(read("to/sub/changed.txt") === "new" && read("to/sub/added.txt") === "3", "changed and new files are brought over");
    ok(!has("to/gone.txt") && !has("to/gone-dir"), "what the build no longer has is removed");
    ok(read("to/file-now") === "4" && read("to/dir-now/x.txt") === "5", "a folder turned file and a file turned folder are replaced");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ---------- a build ----------
{
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const stamps = dir => JSON.stringify(walk(dir).sort().map(f => [path.relative(dir, f), fs.statSync(f).mtimeMs]));
  for (const edition of Object.keys(EDITIONS)) {
    const out = build(edition), first = stamps(out);
    ok(build(edition) === out && stamps(out) === first, `a ${edition} build that changes nothing touches no file`);
    ok(!fs.readdirSync(path.dirname(out)).some(n => n.endsWith(`.${process.pid}.tmp`)), `the ${edition} build leaves no staging folder`);
  }
  let err = ""; try { build("nope"); } catch (e) { err = e.message; }
  ok(/unknown edition/.test(err), "an unknown edition is refused: " + err);
}

// ---------- the manifest: the key that pins the id, and the OAuth client ----------
{
  // Chrome's extension id: the SHA-256 of the key's bytes, its first 16 bytes written as letters a to p.
  const idOf = key => [...crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join("");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baltazar-mail-manifest-"));
  const manifestOf = (opts, n) => JSON.parse(fs.readFileSync(path.join(build("gmail", { ...opts, to: path.join(root, String(n)) }), "manifest.json"), "utf8"));
  const refusal = local => { try { manifestOf({ local }, "bad"); return ""; } catch (e) { return e.message; } };
  try {
    const plain = manifestOf({ local: {} }, 1);
    ok(idOf(plain.key) === "enejfhgeailmbkfpdgfdlajlfhnnbafd" && !("oauth2" in plain), "a Gmail build carries the key of the golden id and, without a client id, no oauth2 block: " + JSON.stringify({ id: plain.key && idOf(plain.key), oauth2: plain.oauth2 }));
    const client = manifestOf({ local: { client_id: "123456789012-abc123.apps.googleusercontent.com" } }, 2);
    ok(client.oauth2?.client_id === "123456789012-abc123.apps.googleusercontent.com" && client.oauth2.scopes.join() === "https://mail.google.com/", "a client id in local.json becomes the oauth2 block: " + JSON.stringify(client.oauth2));
    ok(!("key" in manifestOf({ local: {}, store: true }, 3)), "a store build leaves the key out");
    ok(/not a Google OAuth client id/.test(refusal({ client_id: "CLIENT_ID.apps.googleusercontent.com" })) && /not a Google OAuth client id/.test(refusal({ client_id: "GOCSPX-secret" })), "a client id that is not one is refused");
    ok(!fs.readdirSync(root).some(n => n.endsWith(".tmp")), "a refused build leaves no staging folder");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // Yahoo's copies keep the ids they have: its key, where there is one, comes only from local.json.
  ok(!("key" in JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "yahoo", "manifest.json"), "utf8"))), "the Yahoo manifest carries no key");
}
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
