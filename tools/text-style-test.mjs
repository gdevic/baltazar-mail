// The app and its docs write an ellipsis as three dots, never as the single character U+2026.
// Scans every tracked text file outside ext/vendor/. node tools/text-style-test.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n")
  .filter(f => f && !f.startsWith("ext/vendor/") && /\.(js|mjs|html|css|md|json|yml|py|sh|txt)$/.test(f));
const hits = files.flatMap(f => fs.readFileSync(f, "utf8").split("\n").flatMap((l, i) => l.includes("\u2026") ? [`${f}:${i + 1}`] : []));
if (hits.length) { console.log("FAIL: single-character ellipsis in", hits.join(", ")); process.exit(1); }
console.log(`PASS (${files.length} files)`);
