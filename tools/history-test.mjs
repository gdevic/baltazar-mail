// Golden values for the undo history, ext/history.js: entries undone and redone out of order, the
// entry named as the one to take first, the order z and Shift+Z take them, and the cap.
// node tools/history-test.mjs
import * as history from "../ext/history.js";

let fail = 0;
const eq = (got, want, what) => { if (got !== want) { fail++; console.log("FAIL", what, "got", got, "want", want); } };
const names = list => list.map(e => e.label).join(",");
const make = (...entries) => { const h = history.create(); for (const [label, ...touches] of entries) history.push(h, { label, touches }); return h; };
const at = (h, label) => h.entries.find(e => e.label === label);
const blockerOf = (h, label) => history.blocker(h, at(h, label))?.label ?? null;
const undo = (h, label) => { const e = at(h, label); if (!history.canUndo(h, e)) throw new Error(`${label} cannot be undone`); history.undone(h, e); };
const redo = (h, label) => { const e = at(h, label); if (!history.canRedo(h, e)) throw new Error(`${label} cannot be redone`); history.redone(h, e); };

// independent entries: each can be undone alone, and redone alone
{
  const h = make(["star", "m:1:star"], ["delete", "m:2:folder"], ["archive", "m:3:folder"]);
  eq(names(history.doneList(h)), "archive,delete,star", "newest first, the order z takes them");
  for (const e of h.entries) eq(history.canUndo(h, e), true, `${e.label} can be undone alone`);
  for (const e of h.entries) eq(history.canRedo(h, e), false, `${e.label}, done, cannot be redone`);
  undo(h, "star");
  eq(names(history.doneList(h)), "archive,delete", "the star leaves the done side");
  eq(names(history.undoneList(h)), "star", "and is ready to redo");
  eq(history.nextUndo(h).label, "archive", "z still takes the newest done entry");
  eq(history.nextRedo(h).label, "star", "Shift+Z takes the star");
  undo(h, "archive");
  eq(names(history.undoneList(h)), "archive,star", "the entry undone last is first to redo");
  redo(h, "star");
  eq(names(history.undoneList(h)), "archive", "an older undo redone alone");
  eq(names(history.doneList(h)), "delete,star", "and back on the done side in the order it was made");
}

// collisions: a later change to the same property comes first
{
  const h = make(["move to Work", "m:1:folder"], ["star", "m:1:star"], ["move to Home", "m:1:folder"]);
  eq(history.canUndo(h, at(h, "move to Work")), false, "the first move waits for the second");
  eq(blockerOf(h, "move to Work"), "move to Home", "and names it");
  eq(history.canUndo(h, at(h, "star")), true, "another property of the same message is free");
  eq(blockerOf(h, "star"), null, "nothing named for a free entry");
  undo(h, "move to Home");
  eq(history.canUndo(h, at(h, "move to Work")), true, "free once the later move is undone");
  undo(h, "move to Work");
  eq(history.canRedo(h, at(h, "move to Home")), false, "redo mirrors it: the later move waits for the earlier");
  eq(blockerOf(h, "move to Home"), "move to Work", "and names it");
  eq(history.nextRedo(h).label, "move to Work", "Shift+Z takes the earlier move first");
  redo(h, "move to Work");
  eq(history.canRedo(h, at(h, "move to Home")), true, "then the later one");
}

// the entry named is one that can be taken now: a chain is followed to its end
{
  const h = make(["A", "k1"], ["B", "k1", "k2"], ["C", "k2"], ["D", "k3"]);
  eq(blockerOf(h, "A"), "C", "A waits for B, which waits for C");
  eq(blockerOf(h, "B"), "C", "B waits for C");
  eq(history.canUndo(h, at(h, "C")), true, "C is free");
  undo(h, "C");
  eq(blockerOf(h, "A"), "B", "then A waits for B alone");
  undo(h, "D"); undo(h, "B"); undo(h, "A");
  eq(names(history.undoneList(h)), "A,B,D,C", "undone order, latest first");
  eq(blockerOf(h, "B"), "A", "B's redo waits for A");
  eq(blockerOf(h, "C"), "A", "C's for B, which waits for A: A is to be redone first");
  eq(history.canRedo(h, at(h, "D")), true, "D's for nothing");
}

// the latest of several in the way is named
{
  const h = make(["A", "k1", "k2"], ["B", "k1"], ["C", "k2"]);
  eq(blockerOf(h, "A"), "C", "two in the way: the later");
}

// z and Shift+Z are always allowed
{
  const h = make(["A", "k"], ["B", "k"], ["C", "j"], ["D", "k", "j"]);
  for (let i = 0; i < 4; i++) { const e = history.nextUndo(h); eq(history.canUndo(h, e), true, `z ${i + 1} (${e.label}) is allowed`); history.undone(h, e); }
  eq(history.nextUndo(h), null, "nothing left to undo");
  eq(names(history.undoneList(h)), "A,B,C,D", "all undone, A last");
  for (let i = 0; i < 4; i++) { const e = history.nextRedo(h); eq(history.canRedo(h, e), true, `Shift+Z ${i + 1} (${e.label}) is allowed`); history.redone(h, e); }
  eq(history.nextRedo(h), null, "nothing left to redo");
  eq(names(history.doneList(h)), "D,C,B,A", "all done again, in their first order");
}

// a contact is one property: two changes to it collide, changes to two contacts do not
{
  const h = make(["pin Alex", "c:alex@x.com"], ["hide Sam", "c:sam@x.com"], ["rename Alex", "c:alex@x.com"]);
  eq(blockerOf(h, "pin Alex"), "rename Alex", "the pin waits for the rename");
  eq(history.canUndo(h, at(h, "hide Sam")), true, "another contact is free");
}

// a large entry against a small one, either way round
{
  const many = Array.from({ length: 2000 }, (_, i) => `c:p${i}@x.com`);
  const h = make(["replace Contacts", ...many], ["pin p7", "c:p7@x.com"], ["pin q", "c:q@x.com"]);
  eq(blockerOf(h, "replace Contacts"), "pin p7", "an import waits for a later pin of one of its contacts");
  eq(history.canUndo(h, at(h, "pin q")), true, "not for a contact it did not touch");
}

// an entry with no touches collides with nothing
{
  const h = make(["A"], ["B"]);
  eq(history.canUndo(h, at(h, "A")), true, "no touches, no collision");
}

// a new entry drops the undone ones
{
  const h = make(["A", "k"], ["B", "j"]);
  undo(h, "B");
  history.push(h, { label: "C", touches: ["k"] });
  eq(names(h.entries), "A,C", "B is gone");
  eq(history.nextRedo(h), null, "nothing to redo");
  eq(blockerOf(h, "A"), "C", "the new entry is later than the old ones");
}

// an entry the app made by itself keeps the undone ones
{
  const h = make(["hide Sam", "c:sam@x.com"], ["star", "m:1:star"]);
  undo(h, "star"); undo(h, "hide Sam");
  history.push(h, { label: "forget Alex", touches: ["c:alex@x.com"], auto: true });
  eq(names(h.entries), "hide Sam,star,forget Alex", "nothing dropped");
  eq(names(history.undoneList(h)), "hide Sam,star", "both still to redo, in their order");
  eq(history.canRedo(h, at(h, "hide Sam")) && history.canRedo(h, at(h, "star")), true, "and free: the forget touches neither");
  eq(history.nextUndo(h).label, "forget Alex", "z takes the forget");
  history.push(h, { label: "archive", touches: ["m:2:folder"] });
  eq(names(h.entries), "forget Alex,archive", "an entry the user made drops them, as before");
}

// an entry the app made by itself drops the undone ones that touch what it touches, and those alone
{
  const h = make(["delete Alex", "c:alex@x.com"], ["star", "m:1:star"], ["pin Alex and Sam", "c:alex@x.com", "c:sam@x.com"]);
  undo(h, "pin Alex and Sam"); undo(h, "star"); undo(h, "delete Alex");
  history.push(h, { label: "forget Alex", touches: ["c:alex@x.com"], auto: true });
  eq(names(h.entries), "star,forget Alex", "the delete and the pin, which touch Alex, go; the star stays");
  eq(history.nextRedo(h).label, "star", "Shift+Z takes the star");
  eq(history.canRedo(h, at(h, "star")), true, "which is free");
}

// with entries the app made among them, z and Shift+Z are still always allowed
{
  const h = make(["A", "k"], ["B", "j"]);
  undo(h, "B");
  history.push(h, { label: "F", touches: ["k"], auto: true });
  undo(h, "F"); undo(h, "A");
  history.push(h, { label: "G", touches: ["j", "k"], auto: true });
  eq(names(h.entries), "G", "G drops every undone entry, as each touches j or k");
  const h2 = make(["A", "k"], ["B", "j"]);
  undo(h2, "B");
  history.push(h2, { label: "F", touches: ["i"], auto: true });
  for (let i = 0; i < 3; i++) { const e = history.nextUndo(h2); if (!e) break; eq(history.canUndo(h2, e), true, `z (${e.label}) is allowed`); history.undone(h2, e); }
  for (let i = 0; i < 3; i++) { const e = history.nextRedo(h2); if (!e) break; eq(history.canRedo(h2, e), true, `Shift+Z (${e.label}) is allowed`); history.redone(h2, e); }
  eq(names(history.doneList(h2)), "F,B,A", "all done again");
}

// an entry taken out frees the ones it was in the way of; steps on an entry no longer listed change nothing
{
  const h = make(["A", "k"], ["B", "k"]);
  const b = at(h, "B");
  history.remove(h, b);
  eq(history.canUndo(h, at(h, "A")), true, "A is free once B is gone");
  history.undone(h, b);
  eq(b.done, true, "a step on an entry taken out leaves it");
  eq(history.canUndo(h, b) || history.canRedo(h, b), false, "and it can be neither undone nor redone");
}

// the cap: the oldest go
{
  const h = history.create();
  for (let i = 1; i <= 60; i++) history.push(h, { label: `e${i}`, touches: [`m:${i}:star`] });
  eq(h.entries.length, history.MAX, "50 entries at most");
  eq(h.entries[0].label, "e11", "the oldest went");
  eq(history.nextUndo(h).label, "e60", "the newest stays");
}

// an entry given a new touches array is read by it
{
  const h = make(["A", "k"], ["B", "j"]);
  eq(history.canUndo(h, at(h, "A")), true, "A free before");
  at(h, "B").touches = ["j", "k"];
  eq(blockerOf(h, "A"), "B", "B in the way once it touches k");
}

if (fail) { console.log(`FAIL: ${fail}`); process.exit(1); }
console.log("PASS");
