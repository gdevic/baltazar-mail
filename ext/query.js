// Search query language. Words are ANDed; AND, OR, NOT (or a leading -), parentheses and
// "quoted phrases" combine them; field terms narrow: from: to: subject: has:attachment
// is:starred is:unread is:read after:YYYY-MM-DD before:YYYY-MM-DD.
//
// Yahoo's search ORs keyword terms, ANDs field filters with one keyword group, rejects negated
// keywords and senders, and ANDs an id:(...) list with any term. So a query is compiled to
// disjunctive normal form; each conjunction runs one native query (field filters plus its
// first keyword) and the remaining terms are applied exactly by asking which of those ids also
// (or do not) match them. Queries Yahoo can answer in one request go out unchanged and page.

const FIELDS = new Set(["from", "to", "subject", "has", "is", "after", "before"]);
export const CAP = 500;          // messages fetched per native query of a compound search
const MAX_CONJ = 16;

// ---------- parsing ----------
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")") { out.push({ k: c }); i++; continue; }
    let neg = false;
    if (c === "-" && i + 1 < s.length && !/\s/.test(s[i + 1])) { neg = true; i++; }
    let field = null, value = "", phrase = false;
    const m = s.slice(i).match(/^([a-z]+):(?=\S)/i);
    if (m && FIELDS.has(m[1].toLowerCase())) { field = m[1].toLowerCase(); i += m[0].length; }
    if (s[i] === "(") {          // -( ... ) negates a group, field:( ... ) applies to its terms
      if (neg) out.push({ k: "NOT" });
      out.push({ k: "(", field });
      i++;
      continue;
    }
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      value = s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
      phrase = /\s/.test(value.trim());
    } else {
      const m2 = s.slice(i).match(/^[^\s()"]+/);
      value = m2 ? m2[0] : "";
      i += value.length;
    }
    value = value.trim();
    if (!field && !neg && !phrase && /^(AND|OR|NOT)$/.test(value)) { out.push({ k: value }); continue; }
    if (!value) continue;
    const term = { t: "term", field, value, phrase };
    out.push({ k: "term", node: neg ? { t: "not", kid: term } : term });
  }
  return out;
}

// Gives every term without its own field the group's field.
function withField(n, field) {
  if (!n) return;
  if (n.t === "term") { if (!n.field) n.field = field; return; }
  if (n.t === "not") return withField(n.kid, field);
  for (const k of n.kids) withField(k, field);
}

export function parse(input) {
  const toks = tokenize(String(input || ""));
  let p = 0;
  const peek = () => toks[p]?.k;
  function orExpr() {
    const kids = [andExpr()].filter(Boolean);
    while (peek() === "OR") { p++; const k = andExpr(); if (k) kids.push(k); }
    return kids.length > 1 ? { t: "or", kids } : kids[0] || null;
  }
  function andExpr() {
    const kids = [];
    for (;;) {
      const k = peek();
      if (k === undefined || k === ")" || k === "OR") break;
      if (k === "AND") { p++; continue; }
      const u = unary();
      if (u) kids.push(u);
    }
    return kids.length > 1 ? { t: "and", kids } : kids[0] || null;
  }
  function unary() {
    if (peek() === "NOT") { p++; const u = unary(); return u ? { t: "not", kid: u } : null; }
    if (peek() === "(") {
      const field = toks[p++].field;
      const e = orExpr();
      if (peek() === ")") p++;
      if (field) withField(e, field);
      return e;
    }
    if (peek() === "term") return toks[p++].node;
    p++;            // stray ")"
    return null;
  }
  let ast = orExpr();
  while (p < toks.length) {   // text after an unmatched ")": AND it on
    p++;
    const more = orExpr();
    if (more) ast = ast ? { t: "and", kids: [ast, more] } : more;
  }
  return ast;
}

// ---------- terms to Yahoo atoms ----------
const clean = v => v.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
function isoDate(v) {
  const m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

// Yahoo atom for a term, or for its negation when Yahoo can negate it; null when it cannot.
export function atom(term, neg = false) {
  const v = clean(term.value), lv = v.toLowerCase();
  switch (term.field) {
    case null: return neg ? null : (/[\s:]/.test(v) ? `keyword:"${v}"` : `keyword:${v}`);
    case "from": return neg ? null : `from:("${v}")`;
    case "to": return neg ? null : `to:("${v}")`;
    case "subject": return neg ? null : `subject:"${v}"`;
    case "has": return /^attachments?$/.test(lv) ? `${neg ? "-" : ""}has:attachment` : null;
    case "is":
      if (lv === "starred" || lv === "flagged") return `${neg ? "-" : ""}is:flagged`;
      if (lv === "unread") return neg ? "is:read" : "is:unread";
      if (lv === "read") return neg ? "is:unread" : "is:read";
      return null;
    case "after": case "before": {
      const d = isoDate(v);
      if (!d) return null;
      const f = (term.field === "after") !== neg ? "after" : "before";
      return `${f}:${d}`;
    }
  }
  return null;
}
const isKeyword = t => t.field === null;
const known = t => t.field === null || atom(t) !== null;

// ---------- normal form ----------
// Returns an array of conjunctions; each is an array of { term, neg }.
function dnf(node, neg = false) {
  if (!node) return [[]];
  if (node.t === "term") return [[{ term: node, neg }]];
  if (node.t === "not") return dnf(node.kid, !neg);
  const asAnd = (node.t === "and") !== neg;
  const parts = node.kids.map(k => dnf(k, neg));
  if (!asAnd) return parts.flat();
  let acc = [[]];
  for (const p of parts) {
    const next = [];
    for (const a of acc) for (const b of p) next.push(a.concat(b));
    if (next.length > MAX_CONJ) throw new Error("query is too complex (too many OR combinations)");
    acc = next;
  }
  return acc;
}

// Splits a conjunction into what one native query can carry and what must be applied after.
function plan(conj) {
  const native = [], seenField = new Set(), verify = [], exclude = [];
  let keyword = null;
  for (const { term, neg } of conj) {
    if (!known(term)) { if (!neg) verify.push(term); else exclude.push(term); continue; }
    const a = atom(term, neg);
    if (neg) { if (a) native.push(a); else exclude.push(term); continue; }
    if (isKeyword(term)) { if (!keyword) keyword = term; else verify.push(term); continue; }
    const key = term.field === "is" || term.field === "has" ? a : term.field;
    if (seenField.has(key)) verify.push(term); else { seenField.add(key); native.push(a); }
  }
  return { native, keyword, verify, exclude };
}

// A query that is one native request: no AND among keywords, no negations Yahoo cannot do.
// Returns the Yahoo query string, or null when it needs evaluation.
export function nativeQuery(ast) {
  if (!ast) return null;
  // OR of plain keywords: Yahoo's own keyword semantics.
  if (ast.t === "or" && ast.kids.every(k => k.t === "term" && isKeyword(k))) return ast.kids.map(k => atom(k)).join(" ");
  const conjs = dnf(ast);
  if (conjs.length !== 1) return null;
  const p = plan(conjs[0]);
  if (p.verify.length || p.exclude.length) return null;
  return [...p.native, p.keyword ? atom(p.keyword) : null].filter(Boolean).join(" ") || null;
}

// ---------- evaluation ----------
// run(query, count) -> Promise<message[]> runs a Yahoo query (scope already applied by the
// caller for base queries; id-filter queries need none). Returns { messages, truncated }.
export async function evaluate(ast, run, scope = "") {
  const conjs = dnf(ast);
  let truncated = false;
  const byId = new Map();
  await Promise.all(conjs.map(async conj => {
    const p = plan(conj);
    const fixed = [scope, ...p.native].filter(Boolean).join(" ");
    let base;
    if (p.keyword && p.verify.some(isKeyword)) {
      // Several keywords: fetch each, keep the smallest list as the base (complete if under CAP).
      const kws = [p.keyword, ...p.verify.filter(isKeyword)];
      const lists = await Promise.all(kws.map(k => run(`${fixed} ${atom(k)}`, CAP).then(m => ({ k, m }))));
      lists.sort((a, b) => a.m.length - b.m.length);
      base = lists[0].m;
      p.verify = p.verify.filter(t => t !== lists[0].k).concat(lists[0].k === p.keyword ? [] : [p.keyword]);
    } else {
      base = await run([fixed, p.keyword ? atom(p.keyword) : ""].filter(Boolean).join(" "), CAP);
    }
    if (base.length >= CAP) truncated = true;
    let ids = base.map(m => m.id);
    const idq = () => `id:(${ids.join(" OR ")})`;
    for (const t of p.verify) {
      if (!ids.length) break;
      const a = atom(t) || `keyword:"${clean(t.value)}"`;
      const hit = new Set((await run(`${idq()} ${a}`, ids.length)).map(m => m.id));
      ids = ids.filter(id => hit.has(id));
    }
    for (const t of p.exclude) {
      if (!ids.length) break;
      const a = atom(t) || `keyword:"${clean(t.value)}"`;
      const hit = new Set((await run(`${idq()} ${a}`, ids.length)).map(m => m.id));
      ids = ids.filter(id => !hit.has(id));
    }
    const keep = new Set(ids);
    for (const m of base) if (keep.has(m.id)) byId.set(m.id, m);
  }));
  const messages = [...byId.values()].sort((a, b) => Number(b.headers?.date || 0) - Number(a.headers?.date || 0));
  return { messages, truncated };
}

// Human-readable form of the parsed query, for the list title and tooltips.
export function describe(ast) {
  if (!ast) return "";
  const term = t => (t.field ? `${t.field}:` : "") + (t.phrase || /\s/.test(t.value) ? `"${t.value}"` : t.value);
  const walk = (n, top) => {
    if (n.t === "term") return term(n);
    if (n.t === "not") return `NOT ${walk(n.kid)}`;
    const s = n.kids.map(k => walk(k)).join(n.t === "and" ? " AND " : " OR ");
    return top ? s : `(${s})`;
  };
  return walk(ast, true);
}
