// Contacts ("people" in the code): the address book in one list, shown in the message list's
// place (the sidebar's Contacts row, or g c) until another view is opened, with the reader's
// place taken by the page of whoever is selected: what can be done with the person, and the last
// messages exchanged with them.
// Every address the book holds (contacts.js) is in exactly one of three piles, a tab each: People
// (written to, or pinned), Others (never written to) and Hidden (never suggested: what the user
// hid, and automated senders). The text typed above the list filters all three, and each tab
// counts what it has of the matches. A pile is listed latest first, by its date (when the user
// last wrote, for People; the last mail, for the other two); the people the user pinned come
// first in People, in the order they were pinned, under a heading of their own. The pin and the
// eye on a row pin and hide it, or everyone selected when the row is one of them; a pinned address
// cannot be hidden, nor a hidden one pinned. The trash bin that floats before a row's date, as on
// a message row, deletes for good, in any pile (as do Delete on a page, and Del): the contact
// leaves every list and stays out whatever mail names it later. A pinned contact has no bin and
// cannot be deleted.
// Contacts mirrors the mail that is kept: a person whose page finds no mail left is forgotten
// there and then (see forgetIfGone), which undo takes back; someone mail was copied to (Cc or Bcc)
// stays, since a search cannot be relied on for all such mail. And a person whose page shows a
// message the user wrote, which the book had not learned of, is listed under People from then on
// (see learnWrote).
// All mail, Mail from and Mail to are greyed out for a person once it is known that there is no
// such mail (see ways): never on a guess, so a button that works is never greyed.
// While the book's first build is under way, a notice above the list says so (hooks.note).
// The recent messages have a zoom of their own, which mail.js sets on #person as --p-fu
// (Ctrl+wheel over them, or + - 0); the heading above them does not zoom.
// What is selected is the marked people (Ctrl-click, Shift-click, x, Ctrl+A), or the row under the
// cursor when none is marked. Marks are kept by address, so they stay while the filter changes.
// Rename (F2) changes the name a person is shown under: it is typed in place of the one on their
// page, and is shown before any name the mail gives. Nothing else about a contact can be edited,
// the address being what the contact is.
// Hiding, unhiding, pinning, unpinning, renaming and deleting can be undone (hooks.undoable).
// The view is left and come back to as it was: its tab, filter, cursor, selection and place in
// the list last for the session.

import * as contacts from "./contacts.js";
import { esc, noBidi } from "./text.js";

const $ = id => document.getElementById(id);
const CHUNK = 300;               // rows listed at first, and added by Show more
const RECENT = 10;               // messages on a person's page
const FIND_MAX = 20;             // addresses one search can name
const WRITE_MAX = 100;           // people one message can be started to
const FRESH = 3600;              // seconds a contact's last mail must be old before a search finding none is believed
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : (/(s|ch)$/.test(w) ? "es" : "s")}`;

const PIN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.6 1.8 14.2 6.4 12.9 7.1 10.6 6.9 8.3 9.2 8.5 12 7.4 13.1 2.9 8.6 4 7.5 6.8 7.7 9.1 5.4 8.9 3.1z M5.1 10.9 2 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const EYE = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.8A6.4 6.4 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.6 2.1M10.1 10.6A2 2 0 0 1 7 8.4M4.2 5A11 11 0 0 0 1.5 8S3.9 12.5 8 12.5c1 0 1.9-.3 2.7-.7M2 2l12 12"/></svg>`;

// Which way a message went: to the person (out), or from them. Used by the contact card too.
export const dirIcon = out => `<span class="dir ${out ? "out" : "in"}" title="${out ? "To this address" : "From this address"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${out ? "M2.5 8h10.5M8.5 3.5 13 8l-4.5 4.5" : "M13.5 8H3M7.5 3.5 3 8l4.5 4.5"}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

// The piles: what each tab says under it, what its date is (and the row field it comes from, which
// also orders it), and what its list says when it is empty.
const PILES = {
  people: { name: "People", rule: "Most recent first. The date is when you last wrote.", date: "You last wrote", by: "wrote", field: "lastSent",
    none: "Nobody yet.", sub: "The people you write to are listed here, and anyone you pin." },
  others: { name: "Others", rule: "Addresses in your mail that you have not written to, most recent first.", date: "Last mail", by: "last", field: "last",
    none: "No other addresses.", sub: "" },
  hidden: { name: "Hidden", rule: "Kept out of People and Others, and never suggested when you write or search. Automated senders start here.", date: "Last mail", by: "last", field: "last",
    none: "No hidden addresses.", sub: "Hide an address with the eye on its row, or with × beside a suggestion while writing." },
};
const HIDE_TIP = "Hide: move this address to Hidden, where it is never suggested";
const UNHIDE_TIP = "Unhide: list this address with the others again, and suggest it";
const DELETE_TIP = "Delete: take this address out of Contacts for good, whatever mail names it later";
const NO_DELETE = "Unpin it first: a pinned address cannot be deleted";
const PIN_TIP = "Pin: list this address first in People";
const UNPIN_TIP = "Unpin: stop listing this address first";
const RENAME_TIP = "Rename: change the name this contact is shown under";
const NO_HIDE = "Unpin it first: a pinned address cannot be hidden";
const NO_PIN = "Unhide it first: a hidden address cannot be pinned";

// hooks: { write(list of { name, email }), mailWith(email, openId) -> all mail with the
//   person (openId: the message to open there), find(emails, "from" | "to"), recent(email, count)
//   -> { messages }, draft(row) -> whether it is a draft, trash: the trash bin a message row
//   shows, as markup, subject(row) -> its subject as text,
//   date(epoch), menu(x, y, items, onPick), status(msg), leave() -> back to the view Contacts was
//   opened from, undoable({ label, count, undo(), redo() }) -> a change the app's undo can take
//   back, note() -> what to say above the list while the book is still being built, or "" }
let hooks = null;
// match: the pile shown, filtered and in order, the pinned people first (band: how many of them);
// rows: as much of it as is listed; counts: what each pile has of the filter's matches; cur: the
// address under the cursor, so the cursor is found again when the list changes; top: how far the
// list was scrolled when the view was left; opened: whether the view has been shown before;
// inList: whether the list, not the filter box, had the keyboard last; at: the place of a row that
// was forgotten under the cursor, where the arrow keys carry on; said: what the reader's place
// says about it until someone is selected.
const st = { shown: false, all: [], byEmail: new Map(), rows: [], band: 0, match: [], counts: { people: 0, others: 0, hidden: 0 },
  cursor: -1, anchor: -1, cur: null, marked: new Set(), pile: "people", limit: CHUNK, token: 0, top: 0, opened: false, inList: false, at: -1, said: "" };

export function init(h) {
  hooks = h;
  $("p-filter").oninput = () => { st.limit = CHUNK; st.cur = null; render(); if (st.rows.length && $("p-filter").value.trim()) select(0); };
  $("p-show").onclick = e => { const b = e.target.closest("button[data-pile]"); if (b) { openPile(b.dataset.pile); $("p-filter").focus(); } };
  $("p-more-btn").onclick = () => { st.limit += CHUNK; render(); };
  // which of the two had the keyboard, for when the view is come back to
  $("p-filter").addEventListener("focus", () => { st.inList = false; });
  $("list").addEventListener("focus", () => { if (st.shown) st.inList = true; });
  const rows = $("p-rows");
  const at = e => { const el = e.target.closest(".prow"); return el ? Number(el.dataset.i) : -1; };
  rows.onclick = e => {
    const other = e.target.closest("a[data-pile]");
    if (other) { e.preventDefault(); openPile(other.dataset.pile); return; }
    const i = at(e); if (i < 0) return;
    // the eye hides or unhides and the pin pins or unpins: everyone selected when the row is one
    // of them, and otherwise the row's own contact, the selection left as it is
    // The trash bin, as a message row's, deletes for good in the same way.
    const eye = e.target.closest(".pe:not(.none)"), pin = !eye && e.target.closest(".pk:not(.none)"), bin = e.target.closest(".tr");
    if (eye || pin || bin) {
      const r = st.rows[i], whom = st.marked.has(r.email) ? targets() : [r];
      if (bin) remove(whom, i);
      else change(eye ? (r.hidden ? "unhide" : "hide") : (r.pinned ? "unpin" : "pin"), whom, i);
      return;
    }
    if (e.shiftKey) { markRange(st.anchor < 0 ? i : st.anchor, i); select(i, false); return; }
    // Ctrl/⌘-click adds a row to the selection, which starts with the row under the cursor
    if (e.ctrlKey || e.metaKey) {
      if (!st.marked.size && st.cursor >= 0 && st.cursor !== i) mark(st.rows[st.cursor].email, true);
      mark(st.rows[i].email); select(i); return;
    }
    clearMarks(); select(i);
  };
  rows.ondblclick = e => { const i = at(e); if (i >= 0 && !e.target.closest(".pe, .pk")) { select(i); act("mail"); } };
  rows.oncontextmenu = e => {
    const i = at(e); if (i < 0) return;
    e.preventDefault();
    if (!st.marked.has(st.rows[i].email)) clearMarks();
    select(i, false); rowMenu(e.clientX, e.clientY);
  };
  $("person").onclick = e => {
    const un = e.target.closest("[data-unmark]"), also = e.target.closest("[data-also]"), msg = e.target.closest("[data-id]"), b = e.target.closest("[data-p]");
    if (un) mark(un.dataset.unmark, false);
    else if (also) { e.preventDefault(); reveal(also.dataset.also); }
    else if (msg) hooks.mailWith(msg.dataset.email, msg.dataset.id);
    else if (b && !b.disabled) { e.preventDefault(); act(b.dataset.p, b); }
  };
}

export const isShown = () => st.shown;

// Shown as it was left: the same tab, filter, cursor, selection and place in the list. select: an
// address to put the cursor on instead, in whichever pile it is. filter: text for the filter box
// instead, shown in the first pile that has a match.
export async function show({ select: email, filter } = {}) {
  const back = !st.shown;          // come back to, not already on screen
  st.shown = true;
  const first = !st.opened;
  st.opened = true;
  if (filter !== undefined) { $("p-filter").value = filter; st.limit = CHUNK; st.pile = "people"; st.top = 0; }
  await load();
  if (email) { reveal(email); return; }
  // People is empty until something was sent, and a filter may match only in another pile
  if ((first || filter !== undefined) && !st.counts[st.pile]) { const p = Object.keys(PILES).find(k => st.counts[k]); if (p) openPile(p); }
  if (filter && st.rows.length) select(0);
  else if (back) $("p-rows").scrollTop = st.top;
}
// Called while the list is still laid out, so its place can be noted.
export function hide() { if (st.shown) st.top = $("p-rows").scrollTop; st.shown = false; ++st.token; clearTimeout(recentTimer); }
export function resume() { st.shown = true; render(); $("p-rows").scrollTop = st.top; }
// The book read again (it has learned from new mail, or a change to it was undone), the cursor
// and the selection kept. refresh keeps the mail already shown for people too (the book is only
// growing, as during its first build).
export function reload() { if (!st.shown) return; recent.clear(); ways.clear(); return load(); }
export function refresh() { if (st.shown) return load(); }

async function load() {
  const token = ++st.token;
  const [all, note] = await Promise.all([contacts.all(), Promise.resolve(hooks.note()).catch(() => "")]);
  if (token !== st.token || !st.shown) return;
  st.all = all;
  $("p-note").textContent = note || "";
  $("p-note").classList.toggle("hidden", !note);
  st.byEmail = new Map(all.map(r => [r.email, r]));
  for (const e of [...st.marked]) if (!st.byEmail.has(e)) st.marked.delete(e);
  render();
}

function openPile(pile) {
  if (!PILES[pile]) return;
  st.pile = pile; st.limit = CHUNK;
  render();
  $("p-rows").scrollTop = 0;
}

// ---------- the list ----------
function build() {
  const q = $("p-filter").value.trim().toLowerCase();
  const hits = st.all.filter(r => contacts.matchOf(r, q));
  st.counts = { people: 0, others: 0, hidden: 0 };
  for (const r of hits) st.counts[contacts.pileOf(r)]++;
  const mine = hits.filter(r => contacts.pileOf(r) === st.pile);
  const pinned = st.pile === "people" ? contacts.pinnedFirst(mine) : [];
  const rest = contacts.sortRows(pinned.length ? mine.filter(r => !r.pinned) : mine, PILES[st.pile].by);
  st.band = pinned.length;
  st.match = [...pinned, ...rest];
  st.rows = st.match.slice(0, st.limit);
  st.cursor = st.cur ? st.rows.findIndex(r => r.email === st.cur) : -1;
  if (st.anchor >= st.rows.length) st.anchor = -1;
  return q;
}

function render() {
  const q = build(), pile = PILES[st.pile];
  $("p-count").textContent = q ? `${plural(st.match.length, "match")} of ${st.all.length.toLocaleString()}` : "";
  for (const b of $("p-show").querySelectorAll("button")) {
    const on = b.dataset.pile === st.pile;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    b.querySelector("i").textContent = st.counts[b.dataset.pile].toLocaleString();
  }
  $("p-rule").textContent = pile.rule;
  const box = $("p-rows"), top = box.scrollTop;
  // the pinned people have a heading of their own, and so have the rest under them
  if (st.rows.length) {
    const head = t => `<div class="day" aria-hidden="true">${t}</div>`;
    box.innerHTML = st.rows.map((r, i) => (st.band && i === 0 ? head("Pinned") : st.band && i === st.band ? head("Written to") : "") + rowHtml(r, i)).join("");
  } else box.innerHTML = `<div class="list-empty">${emptyHtml(q)}</div>`;
  box.scrollTop = top;
  box.setAttribute("aria-label", `Contacts: ${pile.name}`);
  const more = st.match.length - Math.min(st.match.length, st.limit);
  $("p-more").classList.toggle("hidden", !more);
  $("p-more-btn").textContent = `Show more (${more.toLocaleString()} not shown)`;
  syncAria();
  page();
}

// An empty pile says where the filter's matches are.
function emptyHtml(q) {
  const pile = PILES[st.pile];
  if (!q) return `<div>${st.all.length ? pile.none : "No contacts yet."}</div>${st.all.length ? (pile.sub ? `<div class="sub">${pile.sub}</div>` : "") : `<div class="sub">They are learned from the addresses in your mail.</div>`}`;
  const there = Object.keys(PILES).filter(k => k !== st.pile && st.counts[k]).map(k => `<a href="#" data-pile="${k}">${st.counts[k].toLocaleString()} in ${PILES[k].name}</a>`);
  return `<div>Nothing in ${pile.name} matches “${esc(q)}”.</div>${there.length ? `<div class="sub">${there.join(", ")}</div>` : ""}`;
}

const fullDate = t => t ? new Date(t * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "";
// What the pin and the eye of a row say they do: to its own contact, or to everyone selected when
// the row is one of several (many: how many are selected with it).
const iconTips = (r, many) => ({
  pin: many > 1 ? `${r.pinned ? "Unpin" : "Pin"} the ${many} selected contacts` : r.pinned ? UNPIN_TIP : PIN_TIP,
  eye: many > 1 ? `${r.hidden ? "Unhide" : "Hide"} the ${many} selected contacts` : r.hidden ? UNHIDE_TIP : HIDE_TIP,
  bin: `${many > 1 ? `Delete the ${many} selected contacts for good` : DELETE_TIP} (Del)`,
});
function rowHtml(r, i) {
  const marked = st.marked.has(r.email), when = r[PILES[st.pile].field], tip = iconTips(r, marked ? st.marked.size : 1);
  const label = [r.name, r.email, r.pinned ? "pinned" : "", r.hidden ? "hidden" : "", when ? `${PILES[st.pile].date.toLowerCase()} ${fullDate(when)}` : ""].filter(Boolean).map(noBidi).join(", ");
  return `<div class="prow${i === st.cursor ? " sel" : ""}${marked ? " marked" : ""}${r.hidden ? " off" : ""}" id="prow-${i}" data-i="${i}" data-email="${esc(r.email)}" role="option" aria-selected="${st.marked.size ? marked : i === st.cursor}" aria-label="${esc(label)}">` +
    (r.hidden ? `<span class="pk none"></span>` : `<span class="pk${r.pinned ? " on" : ""}" role="button" title="${tip.pin}" aria-label="${r.pinned ? "Unpin" : "Pin"}">${PIN}</span>`) +
    // a column each for the name and the address: with no name known, the name's is left empty
    `<span class="pn">${esc(r.name)}</span>` +
    `<span class="pm">${esc(r.email)}</span>` +
    // the trash bin floats before the date, as on a message row; a pinned contact, which cannot be deleted, has none
    `<span class="dt">${r.pinned ? "" : `<span class="tr" role="button" title="${tip.bin}" aria-label="Delete">${hooks.trash}</span>`}<span${when ? ` title="${PILES[st.pile].date} ${esc(fullDate(when))}"` : ""}>${when ? esc(hooks.date(when)) : ""}</span></span>` +
    (r.pinned ? `<span class="pe none"></span>` : `<span class="pe" role="button" title="${tip.eye}" aria-label="${r.hidden ? "Unhide" : "Hide"}">${r.hidden ? EYE_OFF : EYE}</span>`) + "</div>";
}

function syncAria() {
  const id = st.cursor >= 0 && $(`prow-${st.cursor}`) ? `prow-${st.cursor}` : null;
  for (const el of [$("list"), $("p-filter")]) if (id) el.setAttribute("aria-activedescendant", id); else el.removeAttribute("aria-activedescendant");
}

// ---------- cursor and selection ----------
function select(i, resetAnchor = true) {
  if (i < 0 || i >= st.rows.length) return;
  $(`prow-${st.cursor}`)?.classList.remove("sel");
  st.cursor = i;
  if (resetAnchor) st.anchor = i;
  st.cur = st.rows[i].email;
  st.at = -1; st.said = "";
  const el = $(`prow-${i}`);
  if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }); }
  paint();
  page();
}

// The rows as the selection has them.
function paint() {
  for (const el of $("p-rows").querySelectorAll(".prow")) {
    const on = st.marked.has(el.dataset.email);
    el.classList.toggle("marked", on);
    el.setAttribute("aria-selected", String(st.marked.size ? on : Number(el.dataset.i) === st.cursor));
    const r = st.rows[Number(el.dataset.i)], tip = r && iconTips(r, on ? st.marked.size : 1);
    if (tip) { el.querySelector(".pk:not(.none)")?.setAttribute("title", tip.pin); el.querySelector(".pe:not(.none)")?.setAttribute("title", tip.eye); el.querySelector(".tr")?.setAttribute("title", tip.bin); }
  }
  syncAria();
}
function mark(email, on = !st.marked.has(email)) {
  if (on) st.marked.add(email); else st.marked.delete(email);
  paint(); page();
}
function markRange(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = Math.max(0, lo); i <= Math.min(st.rows.length - 1, hi); i++) st.marked.add(st.rows[i].email);
  paint(); page();
}
function clearMarks() {
  if (!st.marked.size) return;
  st.marked.clear();
  paint(); page();
}
// Ctrl+A: everyone the pile has of the filter's matches, listed yet or not.
export function markAll() {
  for (const r of st.match) st.marked.add(r.email);
  paint(); page();
  hooks.status(`${plural(st.marked.size, "contact")} selected`);
}

// The people an action applies to: the marked ones, in the order of the list, or the cursor's.
function targets() {
  if (!st.marked.size) return st.cursor >= 0 ? [st.rows[st.cursor]] : [];
  const listed = st.match.filter(r => st.marked.has(r.email)), seen = new Set(listed.map(r => r.email));
  return [...listed, ...[...st.marked].filter(e => !seen.has(e)).map(e => st.byEmail.get(e)).filter(Boolean)];
}

// The cursor on a person in whichever pile they are: the filter is cleared if it keeps them out.
function reveal(email) {
  email = String(email).toLowerCase();
  const r = st.byEmail.get(email);
  if (!r) { hooks.status(`${email} is not in Contacts`); return; }
  st.pile = contacts.pileOf(r);
  build();
  if (!st.match.some(x => x.email === email)) { $("p-filter").value = ""; build(); }
  const at = st.match.findIndex(x => x.email === email);
  if (at >= st.limit) st.limit = Math.ceil((at + 1) / CHUNK) * CHUNK;
  st.cur = email;
  render();
  if (st.cursor >= 0) select(st.cursor);
}

// ---------- what can be done ----------
const named = r => ({ name: r.name, email: r.email });
const showName = r => r.name || r.email;
async function act(what, button) {
  const t = targets(); if (!t.length) return;
  const emails = t.map(r => r.email), n = t.length;
  switch (what) {
    case "write": if (n <= WRITE_MAX) hooks.write(t.map(named)); else hooks.status(`a message can be started to ${WRITE_MAX} people at most`); break;
    case "mail": if (n > 1) act("from"); else if (noMail(emails[0], "mail")) hooks.status(noMail(emails[0], "mail").toLowerCase()); else hooks.mailWith(emails[0]); break;
    case "from": case "to":
      if (n === 1 && noMail(emails[0], what)) hooks.status(noMail(emails[0], what).toLowerCase());
      else if (n <= FIND_MAX) hooks.find(emails, what); else hooks.status(`a search can name ${FIND_MAX} addresses at most`);
      break;
    case "copy": {
      const text = n === 1 ? emails[0] : t.map(r => r.name ? `${noBidi(r.name).replace(/[",<>]/g, " ").trim()} <${r.email}>` : r.email).join(", ");
      try { await navigator.clipboard.writeText(text); hooks.status(n === 1 ? `copied ${emails[0]}` : `copied ${plural(n, "address")}`); if (button?.tagName === "BUTTON") button.textContent = "Copied"; }
      catch { hooks.status("could not copy"); }
      break;
    }
    case "pin": case "unpin": case "hide": case "unhide": await change(what, t, st.cursor); break;
    case "delete": await remove(t, st.cursor); break;
    case "rename": if (n === 1) startRename(t[0]); else hooks.status("one contact is renamed at a time"); break;
    case "clear": clearMarks(); break;
  }
}

// The name on a person's page becomes a box to type their name in. Enter, or leaving the box,
// keeps what it says; Esc leaves the name as it was. An empty box takes the user's name back, so
// that the name the mail gives shows again. The keys typed there are the box's alone.
let renaming = null;             // the address whose name is being typed
function startRename(r) {
  const el = $("person").querySelector("div.p-name");
  if (!el || pageFor !== r.email) return;
  const box = Object.assign(document.createElement("input"), { className: "p-name", value: r.name, placeholder: r.given ? "Name (empty: the one from the mail)" : "Name", maxLength: 100, spellcheck: false, autocomplete: "off" });
  box.setAttribute("aria-label", `Name for ${r.email}`);
  const end = async (keep, key) => {
    if (renaming !== r.email) return;
    renaming = null;
    const name = box.value.trim();
    // nothing to do where the name is the one shown, or is emptied with no name of the user's to take back
    if (keep && name !== r.name && (name || r.given)) await rename(r, name); else page();
    if (key) $("list").focus();
  };
  box.onkeydown = e => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); end(true, true); }
    else if (e.key === "Escape") { e.preventDefault(); end(false, true); }
  };
  box.onblur = () => end(true, false);
  renaming = r.email;
  el.replaceWith(box);
  box.focus(); box.select();
}
// The user's own name for a person, in a way the app's undo takes back.
async function rename(r, name) {
  const was = await contacts.choices([r.email]);
  const apply = () => contacts.rename(r.email, name);
  await apply();
  hooks.undoable({ label: `rename ${name || r.email}`, count: 1, undo: () => contacts.restoreChoices(was), redo: apply });
  await load();
  const now = st.byEmail.get(r.email);
  hooks.status(name ? `renamed ${r.name || r.email} to ${name}` : `${r.email} has the name the mail gives it${now?.name ? `, ${now.name}` : " (none)"}`);
}

// Hide, unhide, pin or unpin people, in a way the app's undo takes back: each address gets back
// exactly what the user had chosen for it. at: where the cursor goes when its row leaves the pile.
async function change(what, t, at = -1) {
  const words = { hide: ["hide", "hid"], unhide: ["unhide", "unhid"], pin: ["pin", "pinned"], unpin: ["unpin", "unpinned"] }[what];
  // only the ones the change is news for: hiding leaves the hidden alone, and so on; a pinned
  // address is not hidden, nor a hidden one pinned
  const asked = t;
  t = t.filter(r => what === "hide" ? !r.hidden && !r.pinned : what === "unhide" ? r.hidden : what === "pin" ? !r.pinned && !r.hidden : r.pinned);
  if (!t.length) {
    if (what === "hide" && asked.some(r => r.pinned)) hooks.status(NO_HIDE.toLowerCase());
    else if (what === "pin" && asked.some(r => r.hidden)) hooks.status(NO_PIN.toLowerCase());
    return;
  }
  const emails = t.map(r => r.email), n = t.length, who = n === 1 ? showName(t[0]) : plural(n, "contact");
  // the ones asked for that the rule kept out, which the status line owns up to
  const barred = what === "hide" ? asked.filter(r => r.pinned).length : what === "pin" ? asked.filter(r => r.hidden).length : 0;
  const mine = !!st.cur && emails.includes(st.cur);      // the cursor's own row is one of them
  const was = await contacts.choices(emails);
  const apply = () => what === "hide" || what === "unhide" ? contacts.hideMany(emails, what === "hide") : contacts.pinMany(emails, what === "pin");
  await apply();
  hooks.undoable({ label: `${words[0]} ${who}`, count: n, undo: () => contacts.restoreChoices(was), redo: apply });
  hooks.status(`${words[1]} ${who}${what === "hide" ? `; Hidden has ${n === 1 ? "it" : "them"}` : ""}${barred ? `; ${barred} ${what === "hide" ? "pinned" : "hidden"} left as ${barred === 1 ? "it was" : "they were"}` : ""}`);
  // people who left the pile are no longer selected; the cursor takes the row that moved up
  for (const e of emails) if (contacts.pileOf({ ...st.byEmail.get(e), ...after(what) }) !== st.pile) st.marked.delete(e);
  await load();
  if (mine && st.cursor < 0 && at >= 0 && st.rows.length) select(Math.min(at, st.rows.length - 1));
}
// Contacts deleted for good (the trash bin on a row, Delete on a page, or Del): they leave every
// list, and stay out whatever mail names them later (contacts.deleteMany). A pinned one cannot be
// deleted: it is left, as it is by hiding, and the status line says so. Undo brings them back as they were. at: where the cursor goes when
// its own row is one of them.
async function remove(t, at = -1) {
  const barred = t.filter(r => r.pinned).length;
  t = t.filter(r => !r.pinned);
  if (!t.length) { hooks.status(NO_DELETE.toLowerCase()); return; }
  const emails = t.map(r => r.email), n = t.length, who = n === 1 ? showName(t[0]) : plural(n, "contact");
  const mine = !!st.cur && emails.includes(st.cur);
  const was = await contacts.choices(emails);
  const apply = () => contacts.deleteMany(emails);
  await apply();
  hooks.undoable({ label: `delete ${who}`, count: n, undo: () => contacts.restoreChoices(was), redo: apply });
  hooks.status(`deleted ${who} for good${barred ? `; ${barred} pinned left as ${barred === 1 ? "it was" : "they were"}` : ""}`);
  for (const e of emails) { st.marked.delete(e); recent.delete(e); ways.delete(e); }
  await load();
  if (mine && st.cursor < 0 && at >= 0 && st.rows.length) select(Math.min(at, st.rows.length - 1));
}
// What a change makes of a row, as the piles see it.
const after = what => what === "hide" ? { hidden: true } : what === "unhide" ? { hidden: false } : what === "pin" ? { pinned: 1 } : { pinned: 0 };

function rowMenu(x, y) {
  const t = targets(); if (!t.length) return;
  const n = t.length, one = n === 1, k = one ? "" : ` (${n})`;
  const anyHidden = t.some(r => r.hidden), anyPinned = t.some(r => r.pinned), canHide = t.some(r => !r.hidden && !r.pinned), canPin = t.some(r => !r.pinned && !r.hidden);
  const tooMany = n > FIND_MAX ? `A search can name ${FIND_MAX} addresses at most` : "";
  const none = what => one ? noMail(t[0].email, what) : "";      // why one person's search would find nothing, if that is known
  hooks.menu(x, y, [
    ["write", one ? "Write" : `Write to all${k}`, "c", n > WRITE_MAX ? `A message can be started to ${WRITE_MAX} people at most` : "", n > WRITE_MAX],
    ...(one ? [["mail", "All mail", "Enter", none("mail"), !!none("mail")]] : []),
    ["from", one ? "Mail from" : `Mail from any${k}`, "", tooMany || none("from"), !!(tooMany || none("from"))], ["to", one ? "Mail to" : `Mail to any${k}`, "", tooMany || none("to"), !!(tooMany || none("to"))], null,
    ["copy", one ? "Copy address" : `Copy addresses${k}`], null,
    ...(one ? [["rename", "Rename", "F2", RENAME_TIP]] : []),
    ["delete", `Delete${k}`, "Del", t.some(r => !r.pinned) ? DELETE_TIP : NO_DELETE, t.every(r => r.pinned)],
    ...(anyPinned && !canPin ? [] : [["pin", `Pin${k}`, "s", canPin ? PIN_TIP : NO_PIN, !canPin]]), ...(anyPinned ? [["unpin", `Unpin${k}`, canPin ? "" : "s", UNPIN_TIP]] : []),
    ...(anyHidden && !canHide ? [] : [["hide", `Hide${k}`, "h", canHide ? HIDE_TIP : NO_HIDE, !canHide]]), ...(anyHidden ? [["unhide", `Unhide${k}`, canHide ? "" : "h", UNHIDE_TIP]] : []),
  ], a => act(a));
}

// ---------- the page of whoever is selected ----------
const recent = new Map();        // address -> its last messages, until the book learns from new mail
const asking = new Set();        // addresses whose messages are on their way
let recentTimer = null, pageFor = null;

function page() {
  const t = targets(), box = $("person");
  clearTimeout(recentTimer);
  if (!t.length) {
    pageFor = null;
    box.innerHTML = `<div class="p-none">${st.said ? esc(st.said) : st.all.length ? "Select a contact to see its mail and what can be done with it. Type to filter; ↓ and ↑ move, Enter shows all mail with the person." : "No contacts yet."}</div>`;
    return;
  }
  if (t.length > 1) { pageFor = null; box.innerHTML = groupHtml(t); return; }
  const r = t[0];
  if (renaming === r.email && box.querySelector("input.p-name")) return;      // a name being typed is not drawn over
  pageFor = r.email;
  const also = r.name ? st.all.filter(x => x.email !== r.email && x.name.toLowerCase() === r.name.toLowerCase()).slice(0, 6) : [];
  const who = esc(showName(r));
  box.innerHTML = `<div class="p-card"><div class="p-name">${who}</div>
    <div class="p-mail">${esc(r.email)}</div>
    <div class="p-stats">${r.last ? `Last mail ${fullDate(r.last)}` : "No mail yet"} · ${r.lastSent ? `you last wrote ${fullDate(r.lastSent)}` : "you have not written to this address"}</div>
    <div class="p-actions"><button data-p="write" title="New message to ${who} (c)">Write</button><button data-p="mail">All mail</button><button data-p="from">Mail from</button><button data-p="to">Mail to</button><button data-p="copy">Copy address</button><span class="sep"></span><button data-p="rename" title="${RENAME_TIP} (F2)">Rename</button><button data-p="${r.pinned ? "unpin" : "pin"}"${r.hidden ? ` disabled title="${NO_PIN}"` : ` title="${r.pinned ? UNPIN_TIP : PIN_TIP} (s)"`}>${r.pinned ? "Unpin" : "Pin"}</button><button data-p="${r.hidden ? "unhide" : "hide"}"${r.pinned ? ` disabled title="${NO_HIDE}"` : ` title="${r.hidden ? UNHIDE_TIP : HIDE_TIP} (h)"`}>${r.hidden ? "Unhide" : "Hide"}</button><button data-p="delete"${r.pinned ? ` disabled title="${NO_DELETE}"` : ` title="${DELETE_TIP} (Del)"`}>Delete</button></div>
    ${also.length ? `<div class="p-also">Same name: ${also.map(x => `<a href="#" data-also="${esc(x.email)}">${esc(x.email)}</a>`).join(", ")}</div>` : ""}</div>
    <div class="p-recent"><i>loading recent messages...</i></div>`;
  const got = recent.get(r.email);
  paintWays(r.email);
  if (got) recentHtml(r.email, got);
  else if (!asking.has(r.email)) recentTimer = setTimeout(() => loadRecent(r.email), 250);
}

// A person's last messages are asked for once the cursor has rested on them, so walking the list
// asks the provider for nothing.
async function loadRecent(email) {
  let messages = null;
  asking.add(email);
  try { messages = (await hooks.recent(email, RECENT)).messages || []; } catch {}
  asking.delete(email);
  if (messages) { recent.set(email, messages); if (recent.size > 40) { const old = recent.keys().next().value; recent.delete(old); ways.delete(old); } }
  if (messages && !messages.length && await forgetIfGone(email)) return;
  if (messages?.length) await learnWrote(email, messages);
  if (pageFor === email && st.shown) recentHtml(email, messages);
  if (messages) learnWays(email, messages);
}

// The messages on a person's page are the proof of whom the user wrote to, wherever they are kept.
// When one of them is the user's own and the book knew of none that late (a reply kept in a folder
// no scan reads), the book takes its date (contacts.wrote); a draft was not sent, so it is no such
// proof. A person that moves to another pile by it is shown there, still selected, if the cursor
// is still theirs by then, and the status line says where.
async function learnWrote(email, messages) {
  const was = st.byEmail.get(email);
  if (!was || !(await contacts.wrote(email, messages.filter(m => !hooks.draft(m))).catch(() => false))) return;
  await load();
  const now = st.byEmail.get(email);
  if (!now || contacts.pileOf(now) === contacts.pileOf(was)) return;
  hooks.status(`${email} is under ${PILES[contacts.pileOf(now)].name}: you wrote to it`);
  if (st.shown && st.cur === email && !st.marked.size) reveal(email);
}

// Which mail there is with a person: any at all, any from them, any to them. true and false are
// known; null is not known, and counts as there being some. The recent messages say it when they
// are every message there is (fewer than were asked for), or when one of them went that way;
// nothing more is asked of the provider, so with more mail than that a way none of them went
// stays unknown.
const ways = new Map();          // address -> { mail, from, to }, until the book learns from new mail
const NO_MAIL = { mail: "No mail with this address is left", from: "No mail from this address", to: "No mail to this address" };
// Why a search for one person's mail (all of it, from them, to them) would find nothing; "" when
// it would find some, or that is not known.
const noMail = (email, what) => ways.get(email)?.[what] === false ? NO_MAIL[what] : "";
function learnWays(email, messages) {
  const all = messages.length < RECENT;
  const from = messages.some(m => (m.headers?.from?.[0]?.email || "").toLowerCase() === email), to = messages.some(m => (m.headers?.from?.[0]?.email || "").toLowerCase() !== email);
  ways.set(email, { mail: messages.length > 0, from: from || (all ? false : null), to: to || (all ? false : null) });
  paintWays(email);
}
// The page's All mail, Mail from and Mail to as what is known lets them be.
const WAY_TIPS = { mail: "All mail from or to this address (Enter)", from: "Mail this address sent", to: "Mail sent to this address" };
function paintWays(email) {
  if (pageFor !== email) return;
  for (const what of ["mail", "from", "to"]) {
    const b = $("person").querySelector(`.p-actions button[data-p="${what}"]`); if (!b) continue;
    const why = noMail(email, what);
    b.disabled = !!why; b.title = why || WAY_TIPS[what];
  }
}

// Contacts mirrors the mail that is kept: a person whose page found no mail is forgotten, unless
// the user pinned or hid them or mail was copied to them (contacts.forget leaves those, and says
// why), their last mail is too new for the provider's search to be believed about it, or the user
// has just undone their forgetting. The row goes, nobody is selected, and the arrow keys carry on
// from its place. True when forgotten.
const spared = new Set();        // addresses whose forgetting was undone, left alone for the session
async function forgetIfGone(email) {
  const r = st.byEmail.get(email);
  if (!r || r.pinned || r.copied || r.given || r.added || spared.has(email) || Date.now() / 1000 - Math.max(r.last, r.lastSent) < FRESH) return false;
  const rows = await contacts.forget([email]);
  // kept after all: what the list knew of the entry was out of date (another tab changed it), so it is read again
  if (!rows.length) { if (!r.hidden) await load(); return false; }
  recent.delete(email); ways.delete(email);
  hooks.undoable({ label: `forget ${showName(r)}`, count: 1, undo: () => { spared.add(email); return contacts.putBack(rows); }, redo: () => contacts.forget([email]) });
  const here = st.shown && st.cur === email;
  if (!here) hooks.status(`forgot ${r.email}: no mail with it is left`);
  if (!st.shown) return true;
  st.marked.delete(email);
  if (here) { st.at = st.cursor; st.cur = null; st.said = `${showName(r)} was forgotten: no mail with ${r.name ? r.email : "this address"} is left outside Spam and Trash. Press z to bring it back; pin it to keep it.`; }
  await load();
  return true;
}
// What the page says of someone mail was copied to when it finds none: the search is no proof
// that none is left, so nothing is said to be gone.
const COPIED_NONE = "No mail with this address was found. It stays in Contacts because mail was copied to it (Cc or Bcc).";
// Why someone with no mail left is still listed.
function keptWhy(r) {
  if (r.pinned) return " It stays in Contacts because you pinned it.";
  if (r.given) return " It stays in Contacts because you named it.";
  if (r.added) return " It stays in Contacts because you added it.";
  if (spared.has(r.email)) return " It was brought back; pin it to keep it after today.";
  if (r.hidden) return " It stays hidden, so that it is not suggested if it writes again.";
  return "";
}
function recentHtml(email, messages) {
  const box = $("person").querySelector(".p-recent"); if (!box) return;
  if (!messages) { box.innerHTML = "<i>Could not load the recent messages.</i>"; return; }
  if (!messages.length) { const r = st.byEmail.get(email) || {}; box.innerHTML = `<i>${r.copied ? COPIED_NONE : `No mail with this address is left outside Spam and Trash.${keptWhy(r)}`}</i>`; return; }
  box.innerHTML = `<div class="p-head">Recent messages</div>` + messages.map(m => {
    const out = (m.headers?.from?.[0]?.email || "").toLowerCase() !== email;
    const subject = hooks.subject(m);
    return `<div class="p-msg" data-id="${esc(m.id)}" data-email="${esc(email)}" title="${esc(subject)}">${dirIcon(out)}<span class="subj">${esc(subject)}</span><span class="fo">${esc(m.folder?.name || "")}</span><span class="dt">${esc(hooks.date(m.headers?.date))}</span></div>`;
  }).join("") + (messages.length >= RECENT ? `<div class="p-msg p-all" data-id="" data-email="${esc(email)}"><span class="dir"></span><span class="subj">All mail with ${esc(showName(st.byEmail.get(email) || { email }))}...</span></div>` : "");
}

const SHOWN_MAX = 60;            // names listed on the page of a large selection
function groupHtml(t) {
  const n = t.length;
  const anyShown = t.some(r => !r.hidden && !r.pinned), anyHidden = t.some(r => r.hidden), anyLoose = t.some(r => !r.pinned && !r.hidden), anyPinned = t.some(r => r.pinned);
  const off = (max, why) => n > max ? ` disabled title="${why}"` : "";
  const find = off(FIND_MAX, `A search can name ${FIND_MAX} addresses at most`);
  return `<div class="p-card"><div class="p-name">${plural(n, "contact")} selected</div>
    <div class="p-actions"><button data-p="write"${off(WRITE_MAX, `A message can be started to ${WRITE_MAX} people at most`) || ' title="New message to all of them (c)"'}>Write to all</button><button data-p="from"${find || ' title="Mail any of these addresses sent (Enter)"'}>Mail from any</button><button data-p="to"${find || ' title="Mail sent to any of these addresses"'}>Mail to any</button><button data-p="copy">Copy addresses</button></div>
    <div class="p-actions">${anyLoose ? `<button data-p="pin" title="List these addresses first in People (s)">Pin</button>` : ""}${anyPinned ? `<button data-p="unpin" title="Stop listing these addresses first in People">Unpin</button>` : ""}${anyShown ? `<button data-p="hide" title="${HIDE_TIP.replace("this address", "these addresses").replace("it is", "they are")} (h)">Hide</button>` : ""}${anyHidden ? `<button data-p="unhide" title="${UNHIDE_TIP.replace("this address", "these addresses").replace("suggest it", "suggest them")}">Unhide</button>` : ""}${t.some(r => !r.pinned) ? `<button data-p="delete" title="Delete these addresses from Contacts for good, whatever mail names them later (Del)">Delete</button>` : ""}<span class="sep"></span><button data-p="clear" title="Select nobody (Esc)">Clear selection</button></div>
    <div class="p-chips">${t.slice(0, SHOWN_MAX).map(r => `<span class="chip" title="${esc(r.name ? `${r.name} <${r.email}>` : r.email)}"><span>${r.name ? `<b>${esc(r.name)}</b>` : esc(r.email)}</span><a data-unmark="${esc(r.email)}" title="Take out of the selection">×</a></span>`).join("")}${n > SHOWN_MAX ? `<span class="p-rest">and ${(n - SHOWN_MAX).toLocaleString()} more</span>` : ""}</div></div>`;
}

// ---------- keys ----------
// The cursor a row down or up; from the place of a row forgotten under it, to the row that took
// that place or the one above it; with no cursor at all, to the first or the last row.
const move = d => {
  const n = st.rows.length; if (!n) return;
  if (st.cursor >= 0) select(Math.max(0, Math.min(n - 1, st.cursor + d)));
  else if (st.at >= 0) select(Math.max(0, Math.min(n - 1, d > 0 ? st.at : st.at - 1)));
  else select(d > 0 ? 0 : n - 1);
};
// Esc, a step at a time: the filter's text, then the selection, then Contacts itself.
export function escape() {
  if ($("p-filter").value) { $("p-filter").value = ""; st.limit = CHUNK; render(); }
  else if (st.marked.size) clearMarks();
  else hooks.leave();
}
// Keys typed in the filter box: the arrows move the cursor and Enter acts on it, everything else types.
export function onFilterKey(e) {
  switch (e.key) {
    case "ArrowDown": e.preventDefault(); move(1); return;
    case "ArrowUp": e.preventDefault(); move(-1); return;
    case "Enter": if (e.isComposing || e.keyCode === 229) return; if (st.cursor < 0 && !st.marked.size) select(0); act("mail"); return;
  }
}
export function focusFilter() { $("p-filter").focus(); $("p-filter").select(); }
// The keyboard back where it was when the view was left: the list, or the filter box (as at first).
export function focus() { if (st.inList) $("list").focus(); else $("p-filter").focus(); }
// Keys for the list while it is shown; true when the key was the list's.
export function onKey(e) {
  if (!st.shown) return false;
  switch (e.key) {
    case "j": case "ArrowDown": e.preventDefault(); move(1); return true;
    case "k": case "ArrowUp": e.preventDefault(); move(-1); return true;
    case "Home": e.preventDefault(); select(0); return true;
    case "End": e.preventDefault(); select(st.rows.length - 1); return true;
    case "Enter": case "o": if (!targets().length) return false; act("mail"); return true;
    case "c": if (!targets().length) return false; e.preventDefault(); act("write"); return true;
    case "x": if (st.cursor >= 0) mark(st.rows[st.cursor].email); return true;
    case "F2": if (!targets().length) return false; e.preventDefault(); act("rename"); return true;
    case "#": case "Delete": if (!targets().length) return false; e.preventDefault(); act("delete"); return true;
    case "s": { const t = targets(); if (t.length) act(t.some(r => !r.pinned && !r.hidden) || !t.some(r => r.pinned) ? "pin" : "unpin"); return true; }
    case "h": { const t = targets(); if (t.length) act(t.some(r => !r.hidden) ? "hide" : "unhide"); return true; }
  }
  return false;
}
