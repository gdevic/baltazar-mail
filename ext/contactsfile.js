// The file Contacts are exported to and imported from: plain text, a contact a line, written as
// mail writes an address, so that it can be read, edited by hand and pasted into a message's To:
//   Name <address> pinned        the word after the address is optional: pinned or hidden
//   address                      a contact no name is known for
// A name with a comma, a quote, a backslash or an angle bracket, or one that starts with #, is put
// in double quotes, with \" and \\ inside them. Lines that start with # are notes and empty lines
// are skipped. The file is UTF-8; reading takes either line ending and a byte order mark.
// This file names no mail service and stores nothing.

import { noBidi } from "./text.js";

const NAME_MAX = 100;
const ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+$/;
const WORDS = ["pinned", "hidden"];
const quoted = name => /[",<>\\]|^#/.test(name) ? `"${name.replace(/[\\"]/g, "\\$&")}"` : name;
// A name is one line's worth: a line break or another control character in it is written as a space.
const oneLine = name => String(name || "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").trim();
const lineOf = r => { const name = oneLine(r.name); return `${name ? `${quoted(name)} <${r.email}>` : r.email}${r.hidden ? " hidden" : r.pinned ? " pinned" : ""}`; };

// The file for rows as Contacts lists them ({ name, email, pinned: when or 0, hidden, lastSent }):
// the pinned ones first, in the order they were pinned, then the people written to, the others and
// the hidden ones, each by address. The headings between them are notes, for the reader alone.
export function format(rows, { account = "", date = "", eol = "\n" } = {}) {
  const by = (a, b) => a.email.localeCompare(b.email);
  const hidden = rows.filter(r => r.hidden).sort(by), shown = rows.filter(r => !r.hidden);
  const pinned = shown.filter(r => r.pinned).sort((a, b) => a.pinned - b.pinned || by(a, b)), rest = shown.filter(r => !r.pinned);
  const out = [`# Baltazar Mail contacts${account ? ` of ${account}` : ""}${date ? `, ${date}` : ""}`,
    "# One contact per line: Name <address>, or the address alone.",
    "# After the address: pinned or hidden. Lines that start with # are notes.",
    "# Import and merge takes the names, pins and hides written here, and adds the addresses that are new.",
    "# Import and replace makes the list what this file says: a contact that is not in it is removed."];
  for (const [title, list] of [["Pinned", pinned], ["People", rest.filter(r => r.lastSent).sort(by)], ["Others", rest.filter(r => !r.lastSent).sort(by)], ["Hidden", hidden]])
    if (list.length) out.push("", `# ${title}`, ...list.map(lineOf));
  return out.join(eol) + eol;
}

// The contacts a file names, each address once (its last line counts), and the lines that are not
// a contact: { entries: [{ email, name, pinned, hidden, line }], errors: [{ line, text, why }] }.
export function parse(text) {
  const entries = new Map(), errors = [];
  String(text).replace(/^\uFEFF/, "").split(/\r\n|\r|\n/).forEach((raw, i) => {
    const s = raw.trim();
    if (!s || s.startsWith("#")) return;
    const bad = why => { errors.push({ line: i + 1, text: s.length > 60 ? `${s.slice(0, 60)}...` : s, why }); };
    // the address is in the last pair of angle brackets, or is the first word
    const m = s.match(/^(.*)<([^<>]*)>(.*)$/s), bare = m ? null : s.split(/\s+/);
    let name = m ? m[1].trim() : "";
    const email = (m ? m[2] : bare[0]).trim().toLowerCase(), rest = m ? m[3] : bare.slice(1).join(" ");
    if (!ADDRESS.test(email)) return bad(m ? "the address between < and > is not one" : /@.*[,;\s].*@/.test(s) ? "several addresses: a line is one contact" : "no address: write Name <address>, or the address alone");
    if (/^".*"$/s.test(name)) name = name.slice(1, -1).replace(/\\(.)/gs, "$1");
    name = noBidi(name).trim().slice(0, NAME_MAX);
    const words = rest.toLowerCase().split(/[\s,;]+/).filter(Boolean), other = words.find(w => !WORDS.includes(w));
    if (other) return bad(`"${other.slice(0, 20)}" after the address is not pinned or hidden`);
    if (new Set(words).size > 1) return bad(`${[...new Set(words)].join(" and ")} at once`);
    entries.delete(email);
    entries.set(email, { email, name, pinned: words.includes("pinned"), hidden: words.includes("hidden"), line: i + 1 });
  });
  return { entries: [...entries.values()], errors };
}
