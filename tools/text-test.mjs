// Golden values for display text from mail in ext/text.js.
import assert from "node:assert/strict";
import { esc, noBidi } from "../ext/text.js";

assert.equal(noBidi("inv‮fdp.exe"), "invfdp.exe");
assert.equal(noBidi("‪‫‬‭‮⁦⁧⁨⁩"), "");
assert.equal(noBidi("שלום ‏abc"), "שלום ‏abc");      // letters and marks stay
assert.equal(noBidi(null), "");
assert.equal(esc(`<a href="x">&'‮</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
console.log("text: PASS");
