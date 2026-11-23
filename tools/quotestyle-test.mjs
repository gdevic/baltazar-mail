// Golden values for reading selectors in ext/quotestyle.js: a list's selectors and the specificity
// of each, by which a quoted message's style rules are put in order. What the rules then give a
// message is tested in the browser (tools/review.js). node tools/quotestyle-test.mjs
import assert from "node:assert/strict";
import { selectorList, specificity } from "../ext/quotestyle.js";

assert.deepEqual(selectorList("h1, h2 ,.a>b"), ["h1", "h2", ".a>b"]);
assert.deepEqual(selectorList(':is(a, b) c, [title="x,y"], d\\,e'), [":is(a, b) c", '[title="x,y"]', "d\\,e"]);
assert.deepEqual(selectorList(" p "), ["p"]);

// ids, classes, element names: 1000000, 1000 and 1 each
for (const [selector, want] of [
  ["*", 0], ["p", 1], ["div p", 2], ["ul > li + li", 3], [".a", 1000], ["td.a.b", 2001], ["#x", 1000000], ["#x p.a", 1001001],
  ["a:hover", 1001], ["a:link:not(.b)", 2001], ["[lang]", 1000], ['a[href^="http://x.org/#top"]', 1001], ["li:nth-child(2n+1)", 1001],
  ["p::before", 2], ["p:first-line", 2], ["::selection", 1],
  [":is(.a, #b) > li", 1000001], [":not(#b, .a.c)", 1000000], [":where(#b .a) i", 1], [":is(:not(#b), .a)", 1000000],
  [".a\\:b", 1000], ["#a\\.b", 1000000], ["h\\31", 1], ["svg|rect", 1], ["*|*", 0], [".müller", 1000], ["über", 1],
]) assert.equal(specificity(selector), want, selector);
console.log("quotestyle: PASS");
