// The composer's symbol picker: 16 fixed symbols, and up to 16 of the user's own, kept in
// chrome.storage.local: the text symbols found in mail the user exchanges with people (mail.js,
// learnSymbols), and any one pasted on its own in the composer (compose.js).

// Restrained ones only: the faces are the slight ones, and the rest are drawn like text.
export const FIXED = [
  ["👍", "Thumbs up"], ["👎", "Thumbs down"], ["🙂", "Slightly smiling face"], ["🙁", "Slightly frowning face"],
  ["☐", "Empty box"], ["☑", "Checked box"], ["☒", "Crossed box"], ["✓", "Check mark"],
  ["$", "Dollar"], ["€", "Euro"], ["£", "Pound"], ["¥", "Yen and yuan"],
  ["→", "Arrow"], ["°", "Degree"], ["×", "Times, as in 3 × 4"], ["Ω", "Omega"],
];
const FIXED_SET = new Set(FIXED.map(([c]) => c));

// A symbol that also has an emoji form (☑, ⚠, ✔, ™) goes in with the text-style selector, so the
// recipient's phone draws it like ☐ rather than as a coloured emoji.
export const textStyle = ch => /\p{Emoji}/u.test(ch) && !/\p{Emoji_Presentation}/u.test(ch) ? `${ch}︎` : ch;

// One code point that is a symbol (currency, maths, arrows, marks), a fraction or superscript, or
// one of the marks that Unicode counts as punctuation. Colour emoji are left out, and so are the
// characters that rule lines and draw pictures in signatures (box drawing, blocks, Braille).
const SYMBOL = /^[\p{Sm}\p{Sc}\p{So}\p{No}§¶†‡‰]$/u;
const COLOUR = /\p{Emoji_Presentation}/u;
const LINES = /^[─-▟⠀-⣿]$/u;
const SEG = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The distinct symbols in text, beyond the fixed ones. A grapheme is taken whole, so an emoji with
// a skin tone, a flag or a joined emoji (or one marked for emoji style) is never taken in parts.
export function harvest(text) {
  const found = new Set();
  text = String(text || "");
  if (!/[^\x00-\x7f]/.test(text)) return found;
  for (const { segment } of SEG.segment(text)) {
    if (segment.charCodeAt(0) < 0x80) continue;
    const ch = segment.replace(/︎$/, "");
    if (SYMBOL.test(ch) && !COLOUR.test(ch) && !LINES.test(ch) && !FIXED_SET.has(ch)) found.add(ch);
  }
  return found;
}
// The symbol a paste is, when it is one symbol alone (spaces around it aside), or null.
export function single(text) {
  const t = String(text || "").trim().replace(/︎$/, "");
  const [ch] = harvest(t);
  return ch === t ? ch : null;
}

// Puts each symbol found that list lacks at its front, newest first, and keeps the kept newest:
// first in, first out.
const KEPT = 16;
export function admit(list, found, kept = KEPT) {
  for (const ch of found) if (!list.includes(ch)) list.unshift(ch);
  list.length = Math.min(list.length, kept);
  return list;
}

const KEY = "symbols";
let loaded = null;
const load = () => loaded ||= chrome.storage.local.get(KEY).then(r => Array.isArray(r[KEY]) ? r[KEY] : []).catch(() => []);
async function add(found) {
  if (!found.size) return;
  const list = await load(), before = list.join(" ");
  if (admit(list, found).join(" ") === before) return;
  try { await chrome.storage.local.set({ [KEY]: list }); } catch { /* kept for this session */ }
}

// A message is read once a session, however often it is opened.
const noted = new Set();
export function note(id, text) {
  if (noted.has(id)) return;
  noted.add(id);
  return add(harvest(text));
}
export function pasted(text) { const ch = single(text); if (ch) return add(new Set([ch])); }
export async function custom() { return [...await load()]; }
// What was learned from an account's mail goes with its sign-in.
export async function forget() {
  loaded = Promise.resolve([]); noted.clear();
  await chrome.storage.local.remove(KEY).catch(() => {});
}
