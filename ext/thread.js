// A conversation's messages as a tree, for the conversation view (mail.js): the original on top,
// each reply beneath the message it answers, one step further in, and the replies to one message
// oldest first. A reply hangs from the message its In-Reply-To names when that one is listed;
// failing that, from the nearest of its References that is (References run oldest first, so it is
// looked for from the last); failing both, it stands at the top level, as the original does. The
// messages at the top level are oldest first too. The depth stops growing at DEPTH_MAX, so a long
// exchange keeps room for its subjects. Pure: no DOM, no provider.

export const DEPTH_MAX = 8;

// rows: the messages, in any order, each with headers.date (epoch seconds), as the adapters give
// them. refsOf(row) -> { id, parent, refs }: the ids its Message-ID, In-Reply-To and References
// name, "" or [] where there are none (the adapter's refsOf). Returns [{ row, depth }] in tree
// order, every row once; the rows themselves are left as they are.
export function arrange(rows, refsOf) {
  const info = rows.map(r => refsOf(r) || {});
  // oldest first; of two at the same time, the one given first
  const when = r => Number(r?.headers?.date) || 0;
  const order = rows.map((r, i) => i).sort((a, b) => when(rows[a]) - when(rows[b]) || a - b);
  const rank = [];
  order.forEach((i, k) => { rank[i] = k; });
  // An id names the oldest message listed with it: a copy of the same message (the user's own,
  // filed in Sent and come back to Inbox) stands beside it, and the replies hang from the first.
  const byId = new Map();
  for (const i of order) if (info[i].id && !byId.has(info[i].id)) byId.set(info[i].id, i);
  const parent = rows.map((r, i) => {
    const own = info[i].id;
    for (const ref of [info[i].parent, ...[...(info[i].refs || [])].reverse()]) {
      const p = (ref && ref !== own) ? byId.get(ref) : undefined;
      if (p !== undefined && p !== i) return p;
    }
    return -1;
  });
  // Mail can name its parents in a circle, which no top-level message leads to: the oldest
  // message of such a circle goes to the top level, and the others hang from it.
  for (const i of order) {
    const path = [], on = new Set();
    let p = i;
    while (p >= 0 && !on.has(p)) { on.add(p); path.push(p); p = parent[p]; }
    if (p >= 0) parent[path.slice(path.indexOf(p)).reduce((a, b) => rank[a] < rank[b] ? a : b)] = -1;
  }
  const replies = rows.map(() => []), top = [];
  for (const i of order) (parent[i] < 0 ? top : replies[parent[i]]).push(i);
  // depth first: each message, then its replies
  const out = [], todo = top.map(i => [i, 0]).reverse();
  while (todo.length) {
    const [i, depth] = todo.pop();
    out.push({ row: rows[i], depth });
    for (let k = replies[i].length - 1; k >= 0; k--) todo.push([replies[i][k], Math.min(DEPTH_MAX, depth + 1)]);
  }
  return out;
}
