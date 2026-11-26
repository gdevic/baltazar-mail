// Golden values for the composer's symbol picker in ext/symbols.js. node tools/symbols-test.mjs
import assert from "node:assert/strict";
import { FIXED, admit, harvest, single, textStyle } from "../ext/symbols.js";

const got = text => [...harvest(text)].join(" ");
assert.equal(FIXED.length, 16);
// text symbols: fractions, superscripts, maths, arrows, marks, currencies, and the marks counted as punctuation
assert.equal(got("½ ≈ ™ ✔ ₹ № ² ← § ‰ ⚠"), "½ ≈ ™ ✔ ₹ № ² ← § ‰ ⚠");
assert.equal(got("✔︎ ok"), "✔", "the text-style selector is dropped");
// colour emoji, whole or in parts, are never taken
assert.equal(got("🔥 😂 🙏 🎉 👍🏽 ❤️ ✔️ 🇺🇸 🏃‍♀️ 1️⃣"), "");
// lines and pictures drawn with characters
assert.equal(got("━━━ ─── ▀▄ ⠿"), "");
// ASCII, letters and the fixed symbols are not learned
assert.equal(got("$ + < = > ^ ~ | é ß µ ☑ € → ° ☐ Ω"), "");
assert.equal(harvest("✔✔✔ and ✔").size, 1, "a message counts each symbol once");
assert.equal(got(""), "");
assert.equal(got(null), "");

// a paste is kept when it is one symbol alone
assert.equal(single("№"), "№");
assert.equal(single(" ½\n"), "½");
assert.equal(single("✔︎"), "✔");
for (const t of ["½≈", "½ ≈", "a½", "é", "Ω", "€", "🔥", "❤️", "", null]) assert.equal(single(t), null, `not one symbol to keep: ${t}`);

assert.equal(textStyle("⚠"), "⚠︎");
assert.equal(textStyle("☑"), "☑︎");
assert.equal(textStyle("✔"), "✔︎");
assert.equal(textStyle("☐"), "☐");
assert.equal(textStyle("✓"), "✓");
assert.equal(textStyle("Ω"), "Ω");
assert.equal(textStyle("👍"), "👍");

// newest first, nothing twice, and the oldest goes once the list is full
assert.deepEqual(admit([], new Set(["½", "≈"])), ["≈", "½"]);
assert.deepEqual(admit(["≈", "½"], new Set(["½"])), ["≈", "½"]);
assert.deepEqual(admit(["≈", "½", "™"], new Set(["№"]), 3), ["№", "≈", "½"]);
assert.deepEqual(admit(["≈", "½", "™"], new Set(["№", "²"]), 3), ["²", "№", "≈"]);
console.log("symbols: PASS");
