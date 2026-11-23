// The undo history: one list of what can be taken back, oldest first, at most MAX entries, kept
// in the page's memory until it is reloaded or closed (mail.js holds it and draws it). An entry
// is done (its change stands) or undone (taken back, ready to be redone). Each entry names what it
// changed, its touches: keys such as m:<id>:folder, m:<id>:read and m:<id>:star for a message's
// folder, read flag and star, and c:<address> for a contact as a whole, since a contact's undo
// restores all of its choices together.
//
// An entry can be undone alone, out of order, when no later entry that is still done touches
// anything it touches: taking it back would put back a state that later change has replaced.
// Redo mirrors it: an undone entry can be redone when no entry undone after it, and not redone
// since, touches anything it touches. z takes the newest done entry and Shift+Z the entry undone
// last, which those rules always allow.
//
// A new entry the user made drops the undone ones, since a new action ends what could be redone.
// One the app made by itself (auto: Contacts forgetting an address with no mail left) drops only
// those that touch what it touches, whose redo would land on what it has changed since. So no
// done entry is ever later than an undone one that touches the same, which the rules above rest on.
//
// Entries are the caller's own objects, with touches (an array of keys) and auto; the history sets
// done, seq (the order they were added in) and undoneSeq (the order they were undone in, 0 while
// done) on them. Pure: no DOM, no provider.

export const MAX = 50;

// entries: oldest first; made: entries ever added; undos: undos ever made
export const create = () => ({ entries: [], made: 0, undos: 0 });

// A new entry, done; the undone ones go (when the app made it by itself, only those that touch
// what it touches), and past MAX the oldest.
export function push(h, e) {
  h.entries = h.entries.filter(x => x.done || (e.auto && !meets(e, x)));
  e.done = true; e.seq = ++h.made; e.undoneSeq = 0;
  h.entries.push(e);
  if (h.entries.length > MAX) h.entries.splice(0, h.entries.length - MAX);
  return e;
}

// An entry taken out of the history (its undo failed for good, say), whatever its state.
export function remove(h, e) { h.entries = h.entries.filter(x => x !== e); }

// The step the caller has carried out: e taken back, or done again.
export function undone(h, e) { if (h.entries.includes(e)) { e.done = false; e.undoneSeq = ++h.undos; } }
export function redone(h, e) { if (h.entries.includes(e)) { e.done = true; e.undoneSeq = 0; } }

// An entry's keys as a set, made once for each touches array (a caller may give an entry a new one).
const sets = new WeakMap();
function keysOf(e) {
  const t = e.touches || [];
  let s = sets.get(t);
  if (!s) sets.set(t, s = new Set(t));
  return s;
}
function meets(a, b) {
  let x = keysOf(a), y = keysOf(b);
  if (x.size > y.size) [x, y] = [y, x];
  for (const k of x) if (y.has(k)) return true;
  return false;
}

// Which of two entries in the same state is the later: added later, when done; undone later, when undone.
const later = (a, b) => a.done ? a.seq > b.seq : a.undoneSeq > b.undoneSeq;
// The entries in the way of undoing e (when it is done) or of redoing it (when it is undone).
const inTheWay = (h, e) => h.entries.filter(f => f !== e && f.done === e.done && later(f, e) && meets(e, f));

// The entry to undo (when e is done) or to redo (when e is undone) before e, one that can be
// undone or redone itself now; null when e can be at once. Of the entries in e's way the latest,
// and while that one has others in its way, the latest of those, and so on: each step is to a later
// entry, so it ends, at one with nothing in its way.
export function blocker(h, e) {
  let b = null;
  for (let way = inTheWay(h, e); way.length; way = inTheWay(h, b)) b = way.reduce((x, y) => later(y, x) ? y : x);
  return b;
}

export const canUndo = (h, e) => h.entries.includes(e) && e.done && !inTheWay(h, e).length;
export const canRedo = (h, e) => h.entries.includes(e) && !e.done && !inTheWay(h, e).length;

// The done entries, newest first (the order z takes them), and the undone ones, the one undone
// last first (the order Shift+Z takes them).
export const doneList = h => h.entries.filter(e => e.done).reverse();
export const undoneList = h => h.entries.filter(e => !e.done).sort((a, b) => b.undoneSeq - a.undoneSeq);

// What z and Shift+Z take, or null.
export const nextUndo = h => doneList(h)[0] || null;
export const nextRedo = h => undoneList(h)[0] || null;
