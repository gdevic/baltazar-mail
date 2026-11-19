// Builds the two extensions: ext/ (the shared client) with an edition's folder laid over it, yahoo/
// into dist/baltazar-mail-yahoo/ and gmail/ into dist/baltazar-mail-gmail/. Each edition gives its
// manifest, its icons (so the two tell apart when both are pinned), its adapter (api.js) and its
// request rules (rules.js); the version comes from VERSION.
// The Gmail manifest carries the key that pins the extension id of every unpacked copy. An
// edition's local.json (not in git) may give a key of its own and, for Gmail, an OAuth client id,
// which then becomes the manifest's oauth2 block; a build without one signs in with the client id
// the user sets up on the sign-in page. node tools/build.js [yahoo|gmail] [--store]; with no
// edition named, both are built. --store leaves the key out, for the package a browser store
// takes, since a store assigns the id itself and refuses a key.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHARED = path.join(ROOT, "ext");
// What every edition must give, and the files it may add besides; each edition's own hosts, which
// no other edition's code may name outside a comment; the folder it is built into, which is also
// the folder inside its release ZIP.
const SLOTS = ["manifest.json", "icons", "api.js", "rules.js"];
const EDITIONS = {
  yahoo: { added: [], hosts: /yahoo|yusercontent/i, folder: "baltazar-mail-yahoo" },
  gmail: { added: ["auth.js", "rfc822.js", "setup.js"], hosts: /googleapis|accounts\.google|google\.com/i, folder: "baltazar-mail-gmail", scopes: ["https://mail.google.com/"] },
};
const NOT_COPIED = new Set(["local.json"]);
// A Google OAuth client id: the project number, a dash and a hash.
const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const outOf = edition => path.join(ROOT, "dist", EDITIONS[edition].folder);
const version = () => fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();

// The extension is put together in a folder of its own beside its target, checked there, and only
// then brought over (see sync), so the target is never empty or half built while a browser has it
// loaded or another suite runs from it, and a build that fails leaves it as it was.
// local: what to use in place of the edition's local.json ({} for none), so a test suite builds
// the same extension on every machine; to: the folder to build into in place of dist/<folder>,
// so such a build leaves the copy a browser has loaded from dist/ alone.
function build(edition, { store = false, local, to } = {}) {
  const ed = EDITIONS[edition];
  if (!ed) throw new Error(`unknown edition ${edition}`);
  const over = path.join(ROOT, edition), out = to || outOf(edition), stage = `${out}.${process.pid}.tmp`;
  const shared = new Set(fs.readdirSync(SHARED));
  for (const name of SLOTS) if (shared.has(name)) throw new Error(`ext/${name} belongs in an edition's folder`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    fs.cpSync(SHARED, stage, { recursive: true });
    for (const name of fs.readdirSync(over)) {
      if (NOT_COPIED.has(name)) continue;
      if (!SLOTS.includes(name) && !ed.added.includes(name)) throw new Error(`${edition}/${name} is neither an edition file nor listed as added`);
      if (shared.has(name)) throw new Error(`${edition}/${name} would replace the shared ext/${name}`);
      fs.cpSync(path.join(over, name), path.join(stage, name), { recursive: true });
    }
    const given = JSON.parse(fs.readFileSync(path.join(over, "manifest.json"), "utf8"));
    if ("version" in given) throw new Error(`${edition}/manifest.json must not name a version; VERSION does`);
    const { manifest_version, name, ...rest } = given;
    const manifest = { manifest_version, name, version: version(), ...rest };
    if ("oauth2" in manifest) throw new Error(`${edition}/manifest.json must not carry oauth2; local.json gives the client id`);
    const localPath = path.join(over, "local.json");
    const own = local ?? (fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, "utf8")) : {});
    if (own.client_id) {
      if (!ed.scopes) throw new Error(`${edition} signs in without an OAuth client; its local.json names one`);
      if (!CLIENT_ID.test(own.client_id)) throw new Error(`the client_id in ${edition}/local.json is not a Google OAuth client id`);
      manifest.oauth2 = { client_id: own.client_id, scopes: ed.scopes };
    }
    if (own.key) manifest.key = own.key;
    if (store) delete manifest.key;
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    check(edition, stage, manifest);
    sync(stage, out);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return out;
}

// Makes the folder `to` hold what `from` holds. A file whose content is already the same is left
// alone, so a build that changes nothing touches nothing; any other is replaced in one step, and
// what `from` does not have is removed. The folder itself stays: Windows refuses to remove a
// folder that a browser has loaded or a window shows, and the browser keeps the extension loaded
// from the same path.
function sync(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const wanted = fs.readdirSync(from, { withFileTypes: true });
  const names = new Set(wanted.map(e => e.name));
  for (const name of fs.readdirSync(to)) if (!names.has(name)) fs.rmSync(path.join(to, name), { recursive: true, force: true });
  for (const e of wanted) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    let there = fs.statSync(b, { throwIfNoEntry: false });
    if (there && there.isDirectory() !== e.isDirectory()) { fs.rmSync(b, { recursive: true, force: true }); there = undefined; }
    if (e.isDirectory()) sync(a, b);
    else if (!(there && fs.readFileSync(a).equals(fs.readFileSync(b)))) replace(a, b);
  }
}
// A rename puts the whole file in place at once; where the target is held open and cannot be
// renamed over (Windows), it is written over instead.
function replace(a, b) {
  try { fs.renameSync(a, b); } catch { fs.copyFileSync(a, b); }
}

// The text of a file without its comments. Strings, template literals and regular expressions
// are stepped over whole, so a comment marker inside one neither starts a comment nor hides the
// code after it. type: "js", "css", "html" or "json" (which has no comments).
const REGEX_NEXT = /(^|[(,=:[!&|?{};+\-*%<>~^]|(^|[^\w$.])(return|typeof|case|in|of|delete|void|throw|new|yield|await|else|do))$/;
function withoutComments(text, type) {
  if (type === "json") return text;
  if (type === "html") return text.replace(/<!--[\s\S]*?-->/g, " ");
  const js = type === "js", n = text.length;
  let out = "", tail = "";      // tail: the end of the code so far, which decides what a "/" is
  const note = c => { tail = /\s/.test(c) ? tail.trimEnd() + " " : (tail + c).slice(-12); };
  const quoted = (i, q) => { for (let j = i + 1; j < n; j++) { if (text[j] === "\\") j++; else if (text[j] === q) return j + 1; else if (text[j] === "\n") return j; } return n; };
  const regex = i => {
    for (let j = i + 1, set = false; j < n; j++) {
      const c = text[j];
      if (c === "\\") j++; else if (c === "\n") return j; else if (c === "[") set = true; else if (c === "]") set = false; else if (c === "/" && !set) return j + 1;
    }
    return n;
  };
  // A template literal's text is kept as it is; each ${...} in it is code again.
  const template = i => {
    out += "`";
    for (i++; i < n; i++) {
      const c = text[i];
      if (c === "\\") { out += text.slice(i, i + 2); i++; }
      else if (c === "`") { out += c; return i + 1; }
      else if (c === "$" && text[i + 1] === "{") { out += "${"; tail = ""; i = code(i + 2, true); out += "}"; }
      else out += c;
    }
    return n;
  };
  // Code from i on; inside a template's ${...} it ends at the brace that closes it, whose index it returns.
  function code(i, inTemplate) {
    for (let depth = 0; i < n;) {
      const c = text[i], d = text[i + 1];
      if (c === "/" && d === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; out += " "; note(" "); continue; }
      if (js && c === "/" && d === "/") { const e = text.indexOf("\n", i); i = e < 0 ? n : e; continue; }
      if (c === '"' || c === "'") { const e = quoted(i, c); out += text.slice(i, e); tail = "0"; i = e; continue; }
      if (js && c === "`") { i = template(i); tail = "0"; continue; }
      if (js && c === "/" && REGEX_NEXT.test(tail.trimEnd())) { const e = regex(i); out += text.slice(i, e); tail = "0"; i = e; continue; }
      if (inTemplate && c === "{") depth++;
      if (inTemplate && c === "}" && depth-- === 0) return i;
      out += c; note(c); i++;
    }
    return n;
  }
  code(0, false);
  return out;
}

// Whether the code of a file names one of the hosts: its text without the comments, with string
// literals that are added together read as one. It reads what is written, which is what a
// mistake looks like; a name put together at run time is beyond it, and there the manifest's own
// host permissions and connect-src, which this reads too, are what stop the request.
function names(text, type, hosts) {
  return hosts.test(withoutComments(text, type).replace(/["'`]\s*\+\s*["'`]/g, ""));
}

// No edition's code names another edition's hosts outside a comment, and only Yahoo asks for
// request rules.
function check(edition, out, manifest) {
  const files = walk(out).filter(f => !f.includes(`${path.sep}vendor${path.sep}`) && /\.(js|html|css|json)$/.test(f));
  for (const [other, { hosts }] of Object.entries(EDITIONS)) {
    if (other === edition) continue;
    const hits = files.filter(f => names(fs.readFileSync(f, "utf8"), path.extname(f).slice(1), hosts));
    if (hits.length) throw new Error(`${other} addresses in the ${edition} build: ${hits.map(f => path.relative(out, f)).join(", ")}`);
  }
  for (const name of [...SLOTS, ...EDITIONS[edition].added]) if (!fs.existsSync(path.join(out, name))) throw new Error(`missing ${name}`);
  if ((edition === "yahoo") !== manifest.permissions.includes("declarativeNetRequest")) throw new Error(`the ${edition} manifest's declarativeNetRequest permission is wrong`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

if (require.main === module) {
  const named = process.argv.slice(2).filter(a => !a.startsWith("--"));
  for (const edition of named.length ? named : Object.keys(EDITIONS)) {
    const out = build(edition, { store: process.argv.includes("--store") });
    console.log(`built ${path.relative(ROOT, out)} (version ${version()})`);
  }
}

module.exports = { build, outOf, EDITIONS, ROOT, withoutComments, names, sync };
