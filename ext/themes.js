// Palettes mapped onto the UI's colour roles, one per hue, mostly in light and dark pairs.
// Solarized Dark (ethanschoonover.com/solarized) and Gruvbox Dark (github.com/morhetz/gruvbox) use
// their published colours, which the contrast minimums below may lift; the others are ours.
// Roles: bg page, bg2 chrome, bg3 hover and buttons, fg text, fg2 secondary, fg3 hints, line
// borders, sel selected row, selLine focus ring, accent stars/brand, unread bold text, link links.
// bg3 and line are optional: without them they are derived from bg2.

export const THEMES = {
  dark: { name: "Graphite (default)", dark: true,
    bg: "#15181c", bg2: "#1c2026", bg3: "#242a31", fg: "#d8d4c8", fg2: "#9a968c", fg3: "#6c6962",
    line: "#2c333b", sel: "#2f3a48", selLine: "#4f6a8a", accent: "#d9a441", unread: "#f0ece0", link: "#7fb3e0" },
  forest: { name: "Forest", dark: true,
    bg: "#101a14", bg2: "#17251c", fg: "#d3e4d7", fg2: "#a0b8a6", fg3: "#7d9584",
    sel: "#224a31", selLine: "#6fd39a", accent: "#e8b45a", unread: "#effaf2", link: "#6fd39a" },
  solarizedDark: { name: "Solarized Dark", dark: true,
    bg: "#002b36", bg2: "#073642", bg3: "#0b4150", fg: "#93a1a1", fg2: "#839496", fg3: "#586e75",
    line: "#0b3d49", sel: "#0e4b5c", selLine: "#268bd2", accent: "#b58900", unread: "#eee8d5", link: "#268bd2" },
  midnight: { name: "Midnight", dark: true,
    bg: "#0b1121", bg2: "#121b33", fg: "#d6e0f7", fg2: "#a1aecb", fg3: "#7e8bab",
    sel: "#1f3568", selLine: "#7aa2ff", accent: "#ff9e64", unread: "#f2f5ff", link: "#7aa2ff" },
  plum: { name: "Plum", dark: true,
    bg: "#1a1123", bg2: "#251831", fg: "#e9dcf3", fg2: "#bba6cc", fg3: "#9883a9",
    sel: "#45275f", selLine: "#c79bff", accent: "#5fd3bc", unread: "#fbf4ff", link: "#c79bff" },
  merlot: { name: "Merlot", dark: true,
    bg: "#1c0e12", bg2: "#29151b", fg: "#f1dce1", fg2: "#c7a3ad", fg3: "#a07f88",
    sel: "#55202f", selLine: "#ff8fab", accent: "#f2c46d", unread: "#fff2f5", link: "#ff8fab" },
  gruvboxDark: { name: "Gruvbox Dark", dark: true,
    bg: "#282828", bg2: "#32302f", bg3: "#3c3836", fg: "#ebdbb2", fg2: "#a89984", fg3: "#7c6f64",
    line: "#3c3836", sel: "#504945", selLine: "#83a598", accent: "#fabd2f", unread: "#fbf1c7", link: "#83a598" },
  // Black everywhere and white text; only the selected row, hover and borders are grey.
  monoDark: { name: "Monochrome Dark", dark: true, keep: ["bg2"],
    bg: "#000000", bg2: "#000000", bg3: "#1c1c1c", fg: "#ffffff", fg2: "#ffffff", fg3: "#ffffff",
    line: "#444444", sel: "#333333", selLine: "#ffffff", accent: "#ffffff", unread: "#ffffff", link: "#ffffff" },
  light: { name: "Paper (default)", dark: false,
    bg: "#f4f1ea", bg2: "#e9e4d8", bg3: "#ddd7c9", fg: "#1c1a17", fg2: "#4f4c44", fg3: "#6f6b62",
    line: "#c9c2b2", sel: "#cfdcee", selLine: "#3f6b9e", accent: "#94570e", unread: "#000000", link: "#1c5b9c" },
  slate: { name: "Slate", dark: false,
    bg: "#f3f5f8", bg2: "#dfe4eb", fg: "#1a1f27", fg2: "#424a57", fg3: "#5d6574",
    sel: "#c6d2e3", selLine: "#2b59c3", accent: "#c4410c", unread: "#080b10", link: "#2b59c3" },
  sage: { name: "Sage", dark: false,
    bg: "#f3f8f1", bg2: "#dceadb", fg: "#1b2a1e", fg2: "#415245", fg3: "#5b6d5f",
    sel: "#bfdcc0", selLine: "#2e7048", accent: "#a3460f", unread: "#09140c", link: "#2e7048" },
  lagoon: { name: "Lagoon", dark: false,
    bg: "#f0f9f9", bg2: "#d4eded", fg: "#11282a", fg2: "#36535a", fg3: "#516e72",
    sel: "#ade0e0", selLine: "#0a6e75", accent: "#c0344f", unread: "#061719", link: "#0a6e75" },
  sky: { name: "Sky", dark: false,
    bg: "#f2f7fe", bg2: "#dae7f8", fg: "#132033", fg2: "#394a63", fg3: "#53637c",
    sel: "#bfd5f4", selLine: "#1f5fbf", accent: "#b65f00", unread: "#07101e", link: "#1f5fbf" },
  lavender: { name: "Lavender", dark: false,
    bg: "#f7f5fe", bg2: "#e6e0f8", fg: "#211a34", fg2: "#4a4065", fg3: "#62597e",
    sel: "#d3c6f3", selLine: "#6a3fc0", accent: "#0f7a6c", unread: "#110c21", link: "#6a3fc0" },
  rose: { name: "Rose", dark: false,
    bg: "#fdf4f6", bg2: "#f5dde3", fg: "#33171e", fg2: "#5e3b44", fg3: "#78565f",
    sel: "#efc3ce", selLine: "#ad2550", accent: "#7a4f00", unread: "#1f0a0f", link: "#ad2550" },
  // White everywhere and black text, including secondary text, stars and links; only the selected
  // row, hover and borders are grey, so the cursor stays visible.
  mono: { name: "Monochrome", dark: false, keep: ["bg2"],
    bg: "#ffffff", bg2: "#ffffff", bg3: "#f2f2f2", fg: "#000000", fg2: "#000000", fg3: "#000000",
    line: "#cfcfcf", sel: "#e4e4e4", selLine: "#000000", accent: "#000000", unread: "#000000", link: "#000000" },
};

// Contrast is a level from 0 to 10. Level 0 and level 10 each have minimum WCAG contrast ratios
// for every role (AT_MIN, AT_MAX): a palette's own colour is kept when it already reaches them;
// otherwise it moves away from the surfaces it sits on, in its own direction, until it does. Text
// is checked on the page and the panels (fg and unread also on the selected row); hover on the
// page and panels; selection on both and against hover, so the cursor never looks like a hover.
// Levels between mix each colour evenly from its level 0 to its level 10 version, so every step
// changes the picture, not only the steps where a minimum overtakes the palette.
export const CONTRAST_MAX = 10;
export const AT_MIN = { panel: 1.12, hover: 1.15, selection: 1.3, selectionVsHover: 1.1, border: 1.5, focus: 3,
  fg: 4.5, unread: 4.5, fg2: 3, fg3: 3, accent: 3, link: 3, onSelection: 4.5 };
export const AT_MAX = { panel: 1.4, hover: 1.6, selection: 2, selectionVsHover: 1.2, border: 4.5, focus: 7,
  fg: 18, unread: 21, fg2: 12, fg3: 9, accent: 6, link: 6, onSelection: 12 };
export const clampContrast = v => Math.min(CONTRAST_MAX, Math.max(0, Math.round(Number(v) || 0)));

const hex2 = (c, i) => parseInt(c.slice(i, i + 2), 16);
const mix = (a, b, t) => "#" + [1, 3, 5].map(i => Math.round(hex2(a, i) * (1 - t) + hex2(b, i) * t).toString(16).padStart(2, "0")).join("");
const lin = c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const luminance = c => 0.2126 * lin(hex2(c, 1)) + 0.7152 * lin(hex2(c, 3)) + 0.0722 * lin(hex2(c, 5));
export const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

// Mix c toward each colour of `path` in turn, in 1% steps, until ok(c) holds; the last colour of
// the path if it never does.
function push(c, path, ok) {
  for (const toward of [].concat(path)) {
    for (let t = 0; t <= 1; t += 0.01) { const m = mix(c, toward, t); if (ok(m)) return m; }
    c = toward;
  }
  return c;
}
const worst = (c, surfaces) => Math.min(...surfaces.map(s => ratio(c, s)));

// The palette's colours with every role meeting the minimums T.
function derive(p, T) {
  const keep = new Set(p.keep || []), r = { ...p };
  const ink = p.dark ? "#ffffff" : "#000000";
  // Surfaces move away from the page toward the text side, or further out on the side they are on.
  const away = c => luminance(c) > luminance(p.bg) === luminance(p.fg) > luminance(p.bg) ? p.fg : p.dark ? "#000000" : "#ffffff";
  const raise = (k, from, toward, surfaces, min) => { if (!keep.has(k)) r[k] = push(from, toward, c => worst(c, surfaces) >= min); };
  raise("bg2", p.bg2, away(p.bg2), [p.bg], T.panel);
  // Hover and borders head for the text colour, then on to black or white if that is not enough.
  raise("bg3", p.bg3 || r.bg2, [p.fg, ink], [p.bg, r.bg2], T.hover);
  raise("line", p.line || r.bg2, [p.fg, ink], [p.bg, r.bg2], T.border);
  if (!keep.has("sel")) r.sel = push(p.sel, p.link === ink ? p.fg : p.link,
    c => worst(c, [p.bg, r.bg2]) >= T.selection && ratio(c, r.bg3) >= T.selectionVsHover);
  raise("selLine", p.selLine, ink, [p.bg, r.bg2], T.focus);
  // Text moves toward black or white; main and unread text also stay readable on the selected row.
  for (const k of ["fg", "unread", "fg2", "fg3", "accent", "link"]) {
    const onSel = k === "fg" || k === "unread";
    if (!keep.has(k)) r[k] = push(p[k], ink, c => worst(c, [p.bg, r.bg2]) >= T[k] && (!onSel || ratio(c, r.sel) >= T.onSelection));
  }
  delete r.keep;
  return r;
}

const VARS = { bg: "--bg", bg2: "--bg2", bg3: "--bg3", fg: "--fg", fg2: "--fg2", fg3: "--fg3", line: "--line",
  sel: "--sel", selLine: "--sel-line", accent: "--accent", unread: "--unread", link: "--link" };

const cache = new Map();
export function roles(id, level = 0) {
  const p = THEMES[id] || THEMES.light, n = clampContrast(level), key = (THEMES[id] ? id : "light") + "/" + n;
  if (!cache.has(key)) {
    const lo = derive(p, AT_MIN), hi = derive(p, AT_MAX), r = { ...lo };
    for (const k of Object.keys(VARS)) r[k] = mix(lo[k], hi[k], n / CONTRAST_MAX);
    cache.set(key, r);
  }
  return cache.get(key);
}

export function applyTheme(id, level = 0) {
  const t = roles(id, level);
  const style = document.documentElement.style;
  for (const [k, v] of Object.entries(VARS)) style.setProperty(v, t[k]);
  document.documentElement.dataset.theme = t.dark ? "dark" : "light";
  // Scrollbars, lists, checkboxes and the slider follow the palette too.
  document.documentElement.style.colorScheme = t.dark ? "dark" : "light";
  return t;
}
