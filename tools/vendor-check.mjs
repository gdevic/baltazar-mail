// Integrity and vulnerability check for the third-party libraries in ext/vendor/.
//
//   node tools/vendor-check.mjs            every file matches the SHA-256 recorded in vendor.json,
//                                          and nothing unrecorded is present
//   node tools/vendor-check.mjs --upstream every file is byte-identical to its published source
//                                          (npm tarball or URL), after removing source-map comments
//   node tools/vendor-check.mjs --osv      no known vulnerability in the OSV database for any
//                                          library version, except advisories listed under "ignore"
//   node tools/vendor-check.mjs --update   rewrite the recorded hashes (after a deliberate update)
//
// Exits non-zero on any mismatch or unexcused advisory.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "ext", "vendor");
const MANIFEST = join(VENDOR, "vendor.json");
const OWN = new Set(["vendor.json", "README.md"]);
const OSV = process.env.OSV_URL || "https://api.osv.dev/v1/querybatch";
const args = new Set(process.argv.slice(2));

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const sha = buf => createHash("sha256").update(buf).digest("hex");
// The only change made when vendoring: source-map comments are removed.
const normalize = buf => Buffer.from(buf.toString("latin1").replace(/\/\/# sourceMappingURL=\S*/g, ""), "latin1");

// Files under dir, as "/"-separated paths relative to base.
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base)); else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

let failures = 0;
const fail = msg => { failures++; console.log(`FAIL ${msg}`); };

// ---------- recorded hashes ----------
const present = walk(VENDOR).filter(f => !OWN.has(f)).sort();
if (args.has("--update")) {
  manifest.files = Object.fromEntries(present.map(f => [f, sha(readFileSync(join(VENDOR, f)))]));
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`recorded ${present.length} files`);
  process.exit(0);
}
for (const f of present) {
  const want = manifest.files[f];
  if (!want) fail(`${f}: not recorded in vendor.json`);
  else if (sha(readFileSync(join(VENDOR, f))) !== want) fail(`${f}: hash differs from vendor.json`);
}
for (const f of Object.keys(manifest.files)) if (!present.includes(f)) fail(`${f}: recorded but missing`);
console.log(`hashes: ${present.length} files checked`);

// ---------- upstream sources ----------
async function download(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function upstream() {
  const covered = new Set();
  for (const lib of manifest.libraries) {
    const tmp = mkdtempSync(join(tmpdir(), "vendor-"));
    try {
      let root = null;
      if (lib.npm) {
        const base = lib.npm.split("/").pop();
        const tgz = await download(`https://registry.npmjs.org/${lib.npm}/-/${base}-${lib.version}.tgz`);
        writeFileSync(join(tmp, "p.tgz"), tgz);
        execFileSync("tar", ["-xzf", join(tmp, "p.tgz"), "-C", tmp]);
        root = join(tmp, "package");
      }
      for (const [from, to] of Object.entries(lib.files)) {
        // "dir/" maps a whole directory; a URL maps a single file fetched directly.
        const pairs = [];
        if (/^https:\/\//.test(from)) pairs.push([from, to]);
        else if (from.endsWith("/")) {
          for (const f of walk(join(root, from))) pairs.push([from + f, to + f]);
        } else pairs.push([from, to]);
        for (const [src, dst] of pairs) {
          covered.add(dst);
          const theirs = /^https:\/\//.test(src) ? await download(src) : readFileSync(join(root, src));
          const local = join(VENDOR, dst);
          if (!existsSync(local)) { fail(`${dst}: missing (from ${lib.name} ${src})`); continue; }
          if (!normalize(theirs).equals(normalize(readFileSync(local)))) fail(`${dst}: differs from ${lib.name} ${lib.version} ${src}`);
        }
      }
    } catch (e) {
      fail(`${lib.name}: ${e.message}`);
      for (const to of Object.values(lib.files)) for (const f of present) if (f === to || (to.endsWith("/") && f.startsWith(to))) covered.add(f);
    }
    finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  for (const f of present) if (!covered.has(f)) fail(`${f}: no upstream source in vendor.json`);
  console.log(`upstream: ${covered.size} files compared with their published sources`);
}

// ---------- known vulnerabilities ----------
async function osv() {
  const libs = manifest.libraries.filter(l => l.osv);
  const resp = await fetch(OSV, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: libs.map(l => ({ package: { ecosystem: "npm", name: l.osv }, version: l.version })) }) });
  if (!resp.ok) throw new Error(`OSV: HTTP ${resp.status}`);
  const { results = [] } = await resp.json();
  // Batch results carry only advisory ids; aliases (CVE numbers) come from the advisory itself.
  const ignore = manifest.ignore || [];
  for (const [i, r] of results.entries()) {
    for (const v of r.vulns || []) {
      let names = [v.id];
      const one = await fetch(OSV.replace(/querybatch$/, `vulns/${encodeURIComponent(v.id)}`));
      if (one.ok) names = names.concat((await one.json()).aliases || []);
      const ign = ignore.find(x => x.package === libs[i].osv && names.includes(x.id));
      if (ign) console.log(`ok   ${libs[i].osv} ${libs[i].version}: ${names.join(" / ")} excused: ${ign.reason}`);
      else fail(`${libs[i].osv} ${libs[i].version}: known vulnerability ${names.join(" / ")}`);
    }
  }
  console.log(`osv: ${libs.length} libraries checked`);
}

try {
  if (args.has("--upstream")) await upstream();
  if (args.has("--osv")) await osv();
} catch (e) { fail(e.message); }
console.log(failures ? `FAILED (${failures})` : "PASS");
process.exit(failures ? 1 : 0);
