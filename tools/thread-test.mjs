// Golden values for a conversation's tree, ext/thread.js: a chain, branches with replies oldest
// first, a reply whose parent is not listed, References alone, the depth cap, a message listed
// twice, a circle of parents, and rows with no ids. node tools/thread-test.mjs
import { arrange, DEPTH_MAX } from "../ext/thread.js";

let fail = 0;
const eq = (got, want, what) => { if (got !== want) { fail++; console.log("FAIL", what, "got", got, "want", want); } };
// A message: its name, its date (seconds), its own id, the id it answers, and its References.
const msg = (name, date, id = "", parent = "", ...refs) => ({ name, headers: { date: String(date) }, ids: { id, parent, refs } });
const refsOf = m => m.ids;
// The tree as name:depth, in order.
const tree = rows => arrange(rows, refsOf).map(x => `${x.row.name}:${x.depth}`).join(" ");

eq(DEPTH_MAX, 8, "indentation stops growing at 8 levels");

// a chain, given newest first as a search lists it
{
  const a = msg("A", 1, "a"), b = msg("B", 2, "b", "a", "a"), c = msg("C", 3, "c", "b", "a", "b"), d = msg("D", 4, "d", "c", "a", "b", "c");
  eq(tree([d, c, b, a]), "A:0 B:1 C:2 D:3", "each reply one step further in than what it answers");
}

// branches: replies to the same message oldest first, each with its own replies right after it
{
  const rows = [msg("C", 5, "c", "a"), msg("F", 6, "f", "d"), msg("A", 1, "a"), msg("E", 4, "e", "b"), msg("B", 2, "b", "a"), msg("D", 3, "d", "b")];
  eq(tree(rows), "A:0 B:1 D:2 F:3 E:2 C:1", "a branch is followed to its end before the next reply");
}

// a parent not listed: the nearest listed one of the References, the last first; none: the top
{
  const rows = [msg("A", 1, "a"), msg("B", 2, "b", "a", "a"), msg("W", 3, "w"), msg("Y", 4, "y", "x", "a", "b", "x"), msg("Z", 5, "z", "q", "q")];
  eq(tree(rows), "A:0 B:1 Y:2 W:0 Z:0", "Y hangs from B, the nearest it names; W and Z stand at the top, oldest first");
}

// References alone place a reply; In-Reply-To, when listed, goes before them
{
  const rows = [msg("A", 1, "a"), msg("B", 2, "b", "a", "a"), msg("R", 3, "r", "", "a", "b"), msg("S", 4, "s", "a", "a", "b")];
  eq(tree(rows), "A:0 B:1 R:2 S:1", "R from its last reference, S from the message it answers");
}

// the depth cap: a long exchange stays at DEPTH_MAX from there on
{
  const rows = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, i + 1, `m${i}`, i ? `m${i - 1}` : ""));
  eq(tree(rows.slice().reverse()), "m0:0 m1:1 m2:2 m3:3 m4:4 m5:5 m6:6 m7:7 m8:8 m9:8 m10:8 m11:8", "no deeper than 8");
}

// a message listed twice (the user's own, in Sent and come back to Inbox): the copies stand side by
// side, and a reply to it hangs from the older one
{
  const rows = [msg("A", 1, "a"), msg("S", 2, "s", "a"), msg("S2", 3, "s", "a"), msg("R", 4, "r", "s")];
  eq(tree(rows), "A:0 S:1 R:2 S2:1", "copies are siblings, the reply under the first");
}

// parents named in a circle: the circle's oldest message goes to the top, and no row is lost,
// also one that leads into the circle from outside
{
  const rows = [msg("T", 0, "t", "q"), msg("P", 1, "p", "q"), msg("Q", 2, "q", "p")];
  eq(tree(rows), "P:0 Q:1 T:2", "P, the oldest of the circle, on top");
  eq(tree([msg("M", 1, "m", "m", "m")]), "M:0", "a message that names itself is not its own reply");
}

// rows with no ids: all at the top, oldest first; at the same time, in the order given
{
  eq(tree([msg("N1", 3), msg("N2", 1), msg("N3", 2)]), "N2:0 N3:0 N1:0", "oldest first");
  eq(tree([msg("X", 5), msg("Y", 5)]) + " | " + tree([msg("Y", 5), msg("X", 5)]), "X:0 Y:0 | Y:0 X:0", "ties keep the order given");
  eq(tree([{ name: "U", headers: {}, ids: {} }, msg("V", 1, "v")]), "U:0 V:0", "a row without a date or ids is placed all the same");
}

// every row once, the rows themselves and their References as they were
{
  const rows = [msg("D", 4, "d", "c", "a", "b", "c"), msg("B", 2, "b", "a", "a"), msg("C", 3, "c", "b", "a", "b"), msg("A", 1, "a"), msg("Z", 5, "z", "gone", "gone")];
  const before = JSON.stringify(rows), out = arrange(rows, refsOf);
  eq(out.length === rows.length && new Set(out.map(x => x.row)).size === rows.length && out.every(x => rows.includes(x.row)), true, "each row once, the same objects");
  eq(JSON.stringify(rows), before, "rows and their References untouched");
}

console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
