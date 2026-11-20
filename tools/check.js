// The tests at once: the unit tests, the bundled-library hashes and the browser suites run side by
// side, each in a process of its own, with review.js split into shards (--shards=n, 6 by default).
// The long Yahoo runtime suite is left to CI and to a run of its own (node tools/yahoo-runtime.js).
// Both editions are built for the tests first, so the suites, which each build what they test,
// find them done and none of them writes a file another one's browser has loaded. Each check's
// output goes to out/check/<name>.log; a line is printed as each one ends, and the end of the
// output of any that failed. node tools/check.js [--shards=n]
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { buildForTest } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const LOGS = path.join(ROOT, "out", "check");
const shards = Math.max(1, Number(process.argv.find(a => a.startsWith("--shards="))?.slice(9)) || 6);

function run(name, args) {
  return new Promise(resolve => {
    const t0 = Date.now(), log = path.join(LOGS, `${name}.log`), fd = fs.openSync(log, "w");
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", fd, fd] });
    const end = code => {
      fs.closeSync(fd);
      const r = { name, ok: code === 0, s: (Date.now() - t0) / 1000, log };
      console.log(`${r.ok ? "ok  " : "FAIL"} ${name.padEnd(22)} ${r.s.toFixed(0).padStart(4)} s`);
      resolve(r);
    };
    child.on("error", e => { fs.writeSync(fd, String(e.stack || e)); end(1); });
    child.on("close", end);
  });
}

(async () => {
  const t0 = Date.now();
  fs.mkdirSync(LOGS, { recursive: true });
  for (const f of fs.readdirSync(LOGS)) if (f.endsWith(".log")) fs.rmSync(path.join(LOGS, f));
  buildForTest("yahoo"); buildForTest("gmail");
  const units = fs.readdirSync(path.join(ROOT, "tools")).filter(f => f.endsWith("-test.mjs")).sort();
  const results = await Promise.all([
    ...units.map(f => run(f.replace(/\.mjs$/, ""), [path.join("tools", f)])),
    run("vendor-check", [path.join("tools", "vendor-check.mjs")]),
    run("smoke", [path.join("tools", "smoke.js")]),
    run("gmail-runtime", [path.join("tools", "gmail-runtime.js")]),
    ...Array.from({ length: shards }, (_, i) => run(`review-${i + 1}-of-${shards}`, [path.join("tools", "review.js"), `--shard=${i + 1}/${shards}`])),
  ]);
  const failed = results.filter(r => !r.ok);
  for (const r of failed) {
    const tail = fs.readFileSync(r.log, "utf8").trimEnd().split("\n").slice(-20).join("\n");
    console.log(`\n--- ${r.name} (${path.relative(ROOT, r.log)}):\n${tail}`);
  }
  console.log(`\n${failed.length ? `FAILED: ${failed.map(r => r.name).join(", ")}` : "PASS"}: ${results.length} checks in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
