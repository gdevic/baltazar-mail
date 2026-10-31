// Dark reading pane: the colours an email declares are remapped, the way Outlook and Apple Mail
// darken mail. Light backgrounds and borders become dark and dark text becomes light; each keeps
// its hue and saturation and only its lightness (OKLab L) is flipped, so a brand-orange button
// stays orange. Dark backgrounds and light text are left alone, which keeps white text on a
// coloured button readable and leaves mail already designed for dark mode as it is. Images are
// never touched; anything with a background image keeps its original text colours.

// Lightness after the flip. Backgrounds lighter than L 0.5 land between 0.24 (white paper, near
// the app's own dark grey) and 0.42; text darker than L 0.5 lands between 0.67 and 0.92 (black ink).
const BG_FROM = 0.5, TEXT_UNTIL = 0.5;
const flip = (L, role) => role === "bg" ? 0.6 - 0.36 * L : 0.92 - 0.5 * L;

const NAMED = {
  white: "#ffffff", black: "#000000", silver: "#c0c0c0", gray: "#808080", grey: "#808080", red: "#ff0000",
  maroon: "#800000", yellow: "#ffff00", olive: "#808000", lime: "#00ff00", green: "#008000", aqua: "#00ffff",
  cyan: "#00ffff", teal: "#008080", blue: "#0000ff", navy: "#000080", fuchsia: "#ff00ff", magenta: "#ff00ff",
  purple: "#800080", orange: "#ffa500", whitesmoke: "#f5f5f5", gainsboro: "#dcdcdc", lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3", darkgray: "#a9a9a9", darkgrey: "#a9a9a9", dimgray: "#696969", dimgrey: "#696969",
  ghostwhite: "#f8f8ff", snow: "#fffafa", ivory: "#fffff0", linen: "#faf0e6", beige: "#f5f5dc", aliceblue: "#f0f8ff",
};

// "#abc", "#aabbcc", "#aabbccdd", "rgb(1,2,3)", "rgba(1 2 3 / .5)", a common colour name -> [r, g, b, a]
export function parseColor(s) {
  s = String(s).trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  let m = s.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map(c => c + c).join("");
    const n = i => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = s.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const ch = v => Math.max(0, Math.min(255, v.endsWith("%") ? parseFloat(v) * 2.55 : parseFloat(v)));
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [ch(m[1]), ch(m[2]), ch(m[3]), Math.max(0, Math.min(1, a))];
  }
  return null;
}

const toLin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = c => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toOklab([r, g, b]) {
  [r, g, b] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
// The new lightness with the same hue; saturation is reduced only as far as sRGB requires.
function relight(lab, L) {
  for (let k = 1; k >= 0; k -= 0.05) {
    const lin = fromOklab([L, lab[1] * k, lab[2] * k]);
    if (lin.every(c => c >= -1e-4 && c <= 1 + 1e-4)) return lin.map(c => Math.round(toSrgb(Math.max(0, Math.min(1, c)))));
  }
  const g = Math.round(toSrgb(Math.max(0, Math.min(1, L ** 3))));
  return [g, g, g];
}
const hex = n => n.toString(16).padStart(2, "0");
const format = ([r, g, b], a) => a < 1 ? `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})` : `#${hex(r)}${hex(g)}${hex(b)}`;

// role "bg" (backgrounds, borders) or "text"; returns the new colour, or null to keep it.
export function remap(color, role) {
  const c = parseColor(color);
  if (!c || c[3] === 0) return null;
  const lab = toOklab(c), L = lab[0];
  if (role === "bg" ? L <= BG_FROM : L >= TEXT_UNTIL) return null;
  return format(relight(lab, flip(L, role)), c[3]);
}

const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b/gi;
const remapValue = (value, role) => value.replace(COLOR_TOKEN, t => remap(t, role) || t);

// Colour declarations in a style sheet or a style attribute. Declarations with an image are kept.
const DECL = /(^|[{;\s])(background-color|background|color|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?)(\s*:\s*)([^;{}]*)/gi;
export function darkenCss(css) {
  return css.replace(DECL, (all, pre, prop, colon, value) =>
    /url\(/i.test(value) ? all : pre + prop + colon + remapValue(value, prop.toLowerCase() === "color" ? "text" : "bg"));
}

const ownTextColor = el => (el.getAttribute("style") || "").match(/(?:^|;)\s*color\s*:\s*([^;!]+)/i)?.[1].trim() || el.getAttribute("color") || null;
const hasBgImage = el => el.hasAttribute("background") || /background(?:-image)?\s*:[^;]*url\(/i.test(el.getAttribute("style") || "");

// The message HTML with its declared colours darkened. Uses an inert template: nothing loads.
export function darkenHtml(html, doc = document) {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  const walk = (el, inherited, keepText) => {
    const own = ownTextColor(el), bgImage = hasBgImage(el);
    if (el.tagName === "STYLE") el.textContent = darkenCss(el.textContent);
    if (!keepText && !bgImage) {
      for (const attr of ["bgcolor"]) if (el.hasAttribute(attr)) { const v = remap(el.getAttribute(attr), "bg"); if (v) el.setAttribute(attr, v); }
      for (const attr of ["color", "text", "link", "vlink", "alink"]) if (el.hasAttribute(attr)) { const v = remap(el.getAttribute(attr), "text"); if (v) el.setAttribute(attr, v); }
      if (el.hasAttribute("style")) el.setAttribute("style", darkenCss(el.getAttribute("style")));
    } else if (bgImage && !own) el.setAttribute("style", `${el.getAttribute("style") || ""};color:${inherited}`);
    for (const child of el.children) walk(child, own || inherited, keepText || bgImage);
  };
  for (const child of tpl.content.children) walk(child, "#111111", false);
  return tpl.innerHTML;
}

// Page colours for the darkened reader: what white paper and black ink become.
export const PAGE = { bg: remap("#ffffff", "bg"), fg: remap("#111111", "text"), link: "#8ab4f8", quote: remap("#444444", "text"), rule: remap("#cccccc", "bg") };
