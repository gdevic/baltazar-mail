// Golden values for the dark reader's colour remapping in ext/darken.js. node tools/darken-test.mjs
import { parseColor, remap, darkenCss } from "../ext/darken.js";

let fail = 0;
const eq = (got, want, what) => { if (got !== want) { fail++; console.log("FAIL", what, "got", got, "want", want); } };
eq(JSON.stringify(parseColor("#abc")), "[170,187,204,1]", "short hex");
eq(JSON.stringify(parseColor("rgba(255, 0, 0, 0.5)")), "[255,0,0,0.5]", "rgba with commas");
eq(JSON.stringify(parseColor("rgb(0 128 255 / 50%)")), "[0,128,255,0.5]", "rgb with spaces and slash");
eq(JSON.stringify(parseColor("White")), "[255,255,255,1]", "colour name");
eq(parseColor("inherit"), null, "keyword is not a colour");
// light paper and borders darken; dark ink lightens; hue survives
eq(remap("#ffffff", "bg"), "#1f1f1f", "white paper");
eq(remap("#dddddd", "bg"), "#282828", "light border");
eq(remap("#ff8800", "bg"), "#512b09", "orange button stays orange");
eq(remap("#000000", "text"), "#e4e4e4", "black ink");
eq(remap("#333333", "text"), "#b1b1b1", "dark grey ink");
eq(remap("#1a0dab", "text"), "#8da8fa", "link blue stays blue");
eq(remap("rgba(255,255,255,0.5)", "bg"), "rgba(31, 31, 31, 0.5)", "alpha kept");
// already dark backgrounds, already light text and transparent are kept
eq(remap("#222222", "bg"), null, "dark background kept");
eq(remap("#ffffff", "text"), null, "white text kept");
eq(remap("#cc0000", "text"), null, "readable red kept");
eq(remap("transparent", "bg"), null, "transparent kept");
// style sheets and style attributes
eq(darkenCss("color:#333;background-color:#fff"), "color:#b1b1b1;background-color:#1f1f1f", "declarations");
eq(darkenCss("td{border:1px solid #ddd}"), "td{border:1px solid #282828}", "border shorthand");
eq(darkenCss("background:#fff url(hero.jpg) no-repeat"), "background:#fff url(hero.jpg) no-repeat", "image background untouched");
eq(darkenCss("background-color: white !important"), "background-color: #1f1f1f !important", "important kept");
eq(darkenCss(".x{width:100px;font-weight:bold}"), ".x{width:100px;font-weight:bold}", "non-colour properties untouched");
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
