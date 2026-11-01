// Golden values for the dark reader's colour remapping in ext/darken.js. node tools/darken-test.mjs
import { parseColor, remap, darkenCss, PAGE } from "../ext/darken.js";
const lum = c => { const [r, g, b] = parseColor(c).map(v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrastOnPage = c => { const [x, y] = [lum(c), lum(PAGE.bg)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

let fail = 0;
const eq = (got, want, what) => { if (got !== want) { fail++; console.log("FAIL", what, "got", got, "want", want); } };
eq(JSON.stringify(parseColor("#abc")), "[170,187,204,1]", "short hex");
eq(JSON.stringify(parseColor("rgba(255, 0, 0, 0.5)")), "[255,0,0,0.5]", "rgba with commas");
eq(JSON.stringify(parseColor("rgb(0 128 255 / 50%)")), "[0,128,255,0.5]", "rgb with spaces and slash");
eq(JSON.stringify(parseColor("White")), "[255,255,255,1]", "colour name");
eq(parseColor("inherit"), null, "keyword is not a colour");
eq(JSON.stringify(parseColor("hsl(0, 100%, 50%)")), "[255,0,0,1]", "hsl");
eq(JSON.stringify(parseColor("hsla(120deg 100% 25% / 0.5)")), "[0,128,0,0.5]", "hsla with spaces");
eq(darkenCss("color:hsl(0,0%,20%)"), "color:#b1b1b1", "hsl text darkens like its hex");
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
// text kept as it is only when it reads on the dark page (4.5:1); dimmer text is lifted, keeping its hue
eq(remap("#ff6666", "text"), null, "light red kept");
eq(contrastOnPage(remap("#cc0000", "text")) >= 4.5, true, "dark red lifted to 4.5:1");
eq(contrastOnPage(remap("#0066cc", "text")) >= 4.5, true, "mid blue lifted to 4.5:1 (was 2.96:1)");
eq(contrastOnPage(remap("#808080", "text")) >= 4.5, true, "mid grey lifted");
eq(remap("transparent", "bg"), null, "transparent kept");
// style sheets and style attributes
eq(darkenCss("color:#333;background-color:#fff"), "color:#b1b1b1;background-color:#1f1f1f", "declarations");
eq(darkenCss("td{border:1px solid #ddd}"), "td{border:1px solid #282828}", "border shorthand");
eq(darkenCss("background:#fff url(hero.jpg) no-repeat"), "background:#fff url(hero.jpg) no-repeat", "image background untouched");
eq(darkenCss("background-color: white !important"), "background-color: #1f1f1f !important", "important kept");
eq(darkenCss(".x{width:100px;font-weight:bold}"), ".x{width:100px;font-weight:bold}", "non-colour properties untouched");
// crafted style text stays linear: about 1 MB of unclosed rgb( and long words
{
  const t0 = Date.now();
  darkenCss("color:" + "rgb(".repeat(250000));
  darkenCss("background:" + "rgba(1,".repeat(120000));
  darkenCss("border:" + "a".repeat(1 << 20));
  const ms = Date.now() - t0;
  if (ms > 1500) { fail++; console.log("FAIL crafted style text took", ms, "ms"); }
}
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
