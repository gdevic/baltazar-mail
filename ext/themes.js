// Palettes mapped onto the UI's colour roles. Sources: Solarized (ethanschoonover.com/solarized),
// Gruvbox (github.com/morhetz/gruvbox), Catppuccin (catppuccin.com/palette), Nord (nordtheme.com).
// Roles: bg page, bg2 chrome, bg3 hover, fg text, fg2 secondary, fg3 hints, line borders,
// sel selected row, selLine focus ring, accent stars/brand, unread bold text, link links.

export const THEMES = {
  dark: { name: "Graphite (default)", dark: true,
    bg: "#15181c", bg2: "#1c2026", bg3: "#242a31", fg: "#d8d4c8", fg2: "#9a968c", fg3: "#6c6962",
    line: "#2c333b", sel: "#2f3a48", selLine: "#4f6a8a", accent: "#d9a441", unread: "#f0ece0", link: "#7fb3e0" },
  light: { name: "Paper (default)", dark: false,
    bg: "#f4f1ea", bg2: "#ebe7de", bg3: "#e1dcd1", fg: "#23211d", fg2: "#5c594f", fg3: "#8a877d",
    line: "#d6d1c5", sel: "#d9e2ee", selLine: "#7f9bbd", accent: "#a8691a", unread: "#000000", link: "#1c5b9c" },
  solarizedDark: { name: "Solarized Dark", dark: true,
    bg: "#002b36", bg2: "#073642", bg3: "#0b4150", fg: "#93a1a1", fg2: "#839496", fg3: "#586e75",
    line: "#0b3d49", sel: "#0e4b5c", selLine: "#268bd2", accent: "#b58900", unread: "#eee8d5", link: "#268bd2" },
  solarizedLight: { name: "Solarized Light", dark: false,
    bg: "#fdf6e3", bg2: "#eee8d5", bg3: "#e6dec6", fg: "#586e75", fg2: "#657b83", fg3: "#93a1a1",
    line: "#e0d8c0", sel: "#d8e4e6", selLine: "#268bd2", accent: "#b58900", unread: "#073642", link: "#268bd2" },
  gruvboxDark: { name: "Gruvbox Dark", dark: true,
    bg: "#282828", bg2: "#32302f", bg3: "#3c3836", fg: "#ebdbb2", fg2: "#a89984", fg3: "#7c6f64",
    line: "#3c3836", sel: "#504945", selLine: "#83a598", accent: "#fabd2f", unread: "#fbf1c7", link: "#83a598" },
  gruvboxLight: { name: "Gruvbox Light", dark: false,
    bg: "#fbf1c7", bg2: "#f2e5bc", bg3: "#ebdbb2", fg: "#3c3836", fg2: "#665c54", fg3: "#928374",
    line: "#d5c4a1", sel: "#d5c4a1", selLine: "#458588", accent: "#b57614", unread: "#282828", link: "#076678" },
  catppuccinMocha: { name: "Catppuccin Mocha", dark: true,
    bg: "#1e1e2e", bg2: "#181825", bg3: "#313244", fg: "#cdd6f4", fg2: "#a6adc8", fg3: "#6c7086",
    line: "#313244", sel: "#45475a", selLine: "#89b4fa", accent: "#f9e2af", unread: "#e8ecff", link: "#89b4fa" },
  catppuccinLatte: { name: "Catppuccin Latte", dark: false,
    bg: "#eff1f5", bg2: "#e6e9ef", bg3: "#dce0e8", fg: "#4c4f69", fg2: "#6c6f85", fg3: "#9ca0b0",
    line: "#ccd0da", sel: "#ccd0da", selLine: "#1e66f5", accent: "#df8e1d", unread: "#2a2d45", link: "#1e66f5" },
  nord: { name: "Nord", dark: true,
    bg: "#2e3440", bg2: "#3b4252", bg3: "#434c5e", fg: "#d8dee9", fg2: "#9aa5b8", fg3: "#7b88a1",
    line: "#3b4252", sel: "#434c5e", selLine: "#88c0d0", accent: "#ebcb8b", unread: "#eceff4", link: "#88c0d0" },
  nordLight: { name: "Nord Light", dark: false,
    bg: "#eceff4", bg2: "#e5e9f0", bg3: "#d8dee9", fg: "#2e3440", fg2: "#4c566a", fg3: "#7b88a1",
    line: "#d8dee9", sel: "#d8dee9", selLine: "#5e81ac", accent: "#d08770", unread: "#242933", link: "#5e81ac" },
  // White everywhere and black text, including secondary text, stars and links; only the selected
  // row and the hover highlight are grey, so the cursor stays visible.
  mono: { name: "Monochrome", dark: false,
    bg: "#ffffff", bg2: "#ffffff", bg3: "#f2f2f2", fg: "#000000", fg2: "#000000", fg3: "#000000",
    line: "#cfcfcf", sel: "#e4e4e4", selLine: "#000000", accent: "#000000", unread: "#000000", link: "#000000" },
};

const VARS = { bg: "--bg", bg2: "--bg2", bg3: "--bg3", fg: "--fg", fg2: "--fg2", fg3: "--fg3", line: "--line",
  sel: "--sel", selLine: "--sel-line", accent: "--accent", unread: "--unread", link: "--link" };

export function applyTheme(id) {
  const t = THEMES[id] || THEMES.dark;
  const style = document.documentElement.style;
  for (const [k, v] of Object.entries(VARS)) style.setProperty(v, t[k]);
  document.documentElement.dataset.theme = t.dark ? "dark" : "light";
  return t;
}
