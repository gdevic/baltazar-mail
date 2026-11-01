// Every palette reaches the contrast minimums in themes.js at contrast 0 and 10, and gets stronger
// at every step between.
// node tools/themes-test.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { THEMES, AT_MIN, AT_MAX, roles, ratio, clampContrast, CONTRAST_MAX } from "../ext/themes.js";

let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
const ids = Object.keys(THEMES);
const worst = (c, s) => Math.min(...s.map(x => ratio(c, x)));

ok(ids.filter(id => THEMES[id].dark).length === 8 && ids.filter(id => !THEMES[id].dark).length === 8, "8 dark and 8 light palettes");
ok(THEMES.light.name === "Paper (default)" && !THEMES.light.dark && THEMES.dark.name === "Graphite (default)" && THEMES.dark.dark, "defaults");

const LEVELS = [...Array(CONTRAST_MAX + 1).keys()];
for (const level of [0, CONTRAST_MAX]) {
  const T = level ? AT_MAX : AT_MIN;
  for (const id of ids) {
    const p = THEMES[id], r = roles(id, level), keep = new Set(p.keep || []), at = `${id}/${level}`;
    const ink = p.dark ? "#ffffff" : "#000000";
    // A role at pure black or white has gone as far as it can.
    const meets = (k, v, min) => keep.has(k) || v >= min - 1e-9 || r[k] === ink;
    for (const k of Object.keys(p)) if (k !== "keep") ok(r[k] !== undefined, `${at}: ${k} present`);
    for (const k of ["bg3", "line"]) ok(/^#[0-9a-f]{6}$/.test(r[k]), `${at}: ${k} derived`);
    ok(meets("bg2", ratio(r.bg2, r.bg), T.panel), `${at}: panels ${ratio(r.bg2, r.bg).toFixed(2)}`);
    ok(meets("bg3", worst(r.bg3, [r.bg, r.bg2]), T.hover), `${at}: hover`);
    ok(meets("line", worst(r.line, [r.bg, r.bg2]), T.border), `${at}: borders ${worst(r.line, [r.bg, r.bg2]).toFixed(2)}`);
    ok(worst(r.sel, [r.bg, r.bg2]) >= T.selection && ratio(r.sel, r.bg3) >= T.selectionVsHover, `${at}: selection stands out from page, panels and hover`);
    ok(meets("selLine", worst(r.selLine, [r.bg, r.bg2]), T.focus), `${at}: focus ring`);
    for (const k of ["fg", "unread", "fg2", "fg3", "accent", "link"])
      ok(meets(k, worst(r[k], [r.bg, r.bg2]), T[k]), `${at}: ${k} ${worst(r[k], [r.bg, r.bg2]).toFixed(2)} < ${T[k]}`);
    for (const k of ["fg", "unread"]) ok(meets(k, ratio(r[k], r.sel), T.onSelection), `${at}: ${k} on the selected row`);
  }
  // At level 0 a colour that already meets its minimum is the palette's own.
  if (!level) ok(roles("light", 0).link === THEMES.light.link && roles("dark", 0).accent === THEMES.dark.accent, "passing colours untouched");
}
// Turning contrast up never weakens anything.
for (const id of ids) for (let i = 1; i < LEVELS.length; i++) {
  const a = roles(id, LEVELS[i - 1]), b = roles(id, LEVELS[i]);
  for (const k of ["fg", "fg2", "fg3", "line", "bg3", "sel"])
    ok(ratio(b[k], b.bg) >= ratio(a[k], a.bg) - 0.02, `${id}: ${k} weaker at ${LEVELS[i]} than at ${LEVELS[i - 1]}`);
}
// Every step moves the default palettes visibly: borders change at each one.
for (const id of ["light", "dark"]) for (let i = 1; i < LEVELS.length; i++)
  ok(roles(id, LEVELS[i]).line !== roles(id, LEVELS[i - 1]).line, `${id}: step ${LEVELS[i]} changes the borders`);
ok(clampContrast(-3) === 0 && clampContrast(42) === CONTRAST_MAX && clampContrast("4.6") === 5 && clampContrast(undefined) === 0, "clamping");
// The CSS starting values are the defaults at contrast 0, so the first frame doesn't flash another palette.
const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ext", "mail.css"), "utf8");
const block = sel => Object.fromEntries([...css.split("\n" + sel + " {")[1].split("}")[0].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]));
const VARS = { bg: "bg", bg2: "bg2", bg3: "bg3", fg: "fg", fg2: "fg2", fg3: "fg3", line: "line", sel: "sel", selLine: "sel-line", accent: "accent", unread: "unread", link: "link" };
for (const [id, sel] of [["dark", ":root"], ["light", ':root[data-theme="light"]']]) {
  const b = block(sel), r = roles(id);
  ok(Object.entries(VARS).every(([k, v]) => b[v] === r[k]), `mail.css ${sel} starts with the ${id} default`);
}
console.log(fail ? `${fail} FAIL` : `PASS (${ids.length} palettes, contrast 0 to ${CONTRAST_MAX})`);
process.exit(fail ? 1 : 0);
