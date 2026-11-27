// What the two adapters (yahoo/api.js and gmail/api.js) share: the errors they throw, the deadline
// every request keeps, the record of what the requests wait for and how long they took, the shape
// of the folder list they give, the check on the message ids they are handed, and the reading of
// the Message-IDs a message names. Each adapter exports these as its own.

export class ApiError extends Error {
  constructor(msg, detail) { super(msg); this.name = "ApiError"; this.detail = detail; }
}

// Every request has a deadline, so a stalled connection ends in an error instead of waiting
// forever. Uploads get extra time per megabyte sent. slow: how long a request may go unanswered
// before the client is told that it is waited for. first: how long a request an adapter would
// ask twice may go without its answer beginning, the first time. renew: the deadline of a sign-in
// renewed without the user.
export const TIMEOUTS = { page: 30000, batch: 60000, perMB: 10000, raw: 120000, slow: 3000, first: 12000, renew: 20000 };
// early: no answer had begun within the time the caller gave for that (see deadlined).
export class Timeout extends Error {
  constructor(provider, what, ms) { super(`${provider} did not answer within ${Math.round(ms / 1000)} s (${what})`); this.name = "Timeout"; this.early = false; }
}

// ---------- what the requests wait for, and how long they took ----------
// What keeps a request from being answered is a wait: { text, since, until }, where until is when
// it ends if that is known, else 0. An adapter begins one with activity.wait(), which answers the
// function that ends it, and the client watches them (activity.watch) to say in its status bar why
// nothing happens. Every request, and every wait long enough to notice, is also kept when it ends
// (the newest KEPT of them: when, how long, how it ended, what), for the report a user can copy
// when the app seems slow (activity.report). What is kept names no address and no subject, and
// the ids in it are replaced by *.
const KEPT = 300, NOTICED = 250;
const waits = new Set(), watchers = new Set(), kept = [];
const tell = () => { for (const fn of [...watchers]) { try { fn(); } catch { /* a watcher's own trouble */ } } };
const keep = e => { kept.push(e); if (kept.length > KEPT) kept.shift(); };
// An id is a word of ten characters or more with a digit in it.
const noIds = what => String(what).replace(/[A-Za-z0-9_-]{10,}/g, w => /\d/.test(w) ? "*" : w);
const clock = at => new Date(at).toTimeString().slice(0, 8);
export const activity = {
  // logged: whether the wait is kept for the report when it ends (one that a request's own entry
  // tells of is not). since: when it began, where that was before it is told of.
  wait(text, until = 0, { logged = true, since = Date.now() } = {}) {
    const w = { text, since, until };
    waits.add(w); tell();
    return () => {
      if (!waits.delete(w)) return;
      const ms = Date.now() - w.since;
      if (logged && ms >= NOTICED) keep({ at: w.since, ms, how: "waited", what: text });
      tell();
    };
  },
  // The wait to tell of: the one that ends last, or where none names its end, the oldest.
  waiting() {
    const all = [...waits], timed = all.filter(w => w.until);
    return (timed.length ? timed.reduce((a, b) => (b.until > a.until ? b : a)) : all[0]) || null;
  },
  watch(fn) { watchers.add(fn); return () => watchers.delete(fn); },
  // A request that has ended: how is its HTTP status, or the words for a request with no answer.
  note(what, ms, how) { keep({ at: Date.now() - ms, ms, how: String(how), what: noIds(what) }); },
  // The record as text, oldest first, under a line that sums it up.
  report() {
    const asked = kept.filter(e => e.how !== "waited"), waited = kept.filter(e => e.how === "waited");
    const longest = list => list.reduce((n, e) => Math.max(n, e.ms), 0);
    const sum = `${asked.length} requests, the slowest ${longest(asked)} ms; ${waited.length} waits, ${Math.round(waited.reduce((n, e) => n + e.ms, 0) / 1000)} s in all, the longest ${longest(waited)} ms`;
    return [sum, ...kept.map(e => `${clock(e.at)} ${String(e.ms).padStart(6)} ms  ${e.how.padEnd(9)} ${e.what}`)].join("\n");
  },
};

// ---------- the connection ----------
// A request the browser could not make at all (fetch's TypeError before any answer: no network, a
// network that changed, a computer just back from sleep) did not get through. While nothing gets
// through, the connection is lost (link.lost: since when, else 0); any request that gets through
// ends that. A request that may be asked twice is asked again while the connection is lost: as
// soon as the browser says the network is back or another request gets through, else after a
// pause that grows to PAUSE_MAX, for up to LOST_FOR from when the connection was lost; the client
// is told of that wait meanwhile. Past LOST_FOR, or for a request that may not be asked twice, it
// fails as Offline, which the client tells as the network's doing, not an error of its own. One
// that keeps failing while others get through is not the connection's: its own error stands.
// link.waits: false while the client has nothing on screen to tell a wait in (its start), so a
// request that does not get through fails as Offline at once.
export const LOST_FOR = 60000;
const PAUSE_MAX = 5000;
export class Offline extends Error {
  constructor(provider) {
    const offline = globalThis.navigator?.onLine === false;
    super(offline ? "this computer is offline" : `${provider} cannot be reached`);
    this.name = "Offline"; this.offline = offline;
  }
}
let lostSince = 0, lastThrough = 0, asking = 0, lostWait = null;
const linkWatchers = new Set(), wakers = new Set();
const wake = () => { for (const w of [...wakers]) w(); };
globalThis.addEventListener?.("online", wake);
export const link = {
  waits: true,
  get lost() { return lostSince; },
  watch(fn) { linkWatchers.add(fn); return () => linkWatchers.delete(fn); },
};
const linkTell = () => { for (const fn of [...linkWatchers]) { try { fn(); } catch { /* a watcher's own trouble */ } } };
function gotThrough() { lastThrough = Date.now(); if (lostSince) { lostSince = 0; linkTell(); } wake(); }
function notThrough() { if (!lostSince) { lostSince = Date.now(); linkTell(); } }
function pauseFor(ms) {
  return new Promise(ok => { const done = () => { clearTimeout(t); wakers.delete(done); ok(); }; const t = setTimeout(done, ms); wakers.add(done); });
}
// The one wait told of while requests are being asked again.
function askingAgain(provider) { if (!asking++) lostWait = activity.wait(`no connection to ${provider}, asking again`, 0, { since: lostSince }); }
function doneAsking() { if (!--asking) { lostWait?.(); lostWait = null; } }
class Unsent extends Error { constructor(cause) { super(cause.message); this.cause = cause; } }

// The provider's fetch: fetch plus reading the body, both inside the deadline. read(resp) returns
// the body; a deadline that passes is a Timeout naming the provider. A request still unanswered
// after TIMEOUTS.slow is a wait the client can tell of, until its answer begins to come (a large
// attachment being received is no wait for an answer), unless it is quiet (work nobody waits
// for). again: the request may be asked twice (a read), so it is asked again while the connection
// is lost (see above). first, for such a request: it is given up, the first time, when no answer
// has begun within that time, and asked again at once, which leaves a dead connection soon; an
// answer that has begun has the whole deadline to arrive. Every try is noted when it ends.
export const deadlined = provider => async (what, url, init, ms, read, { quiet = false, again = false, first = 0 } = {}) => {
  let failed = 0, told = false;
  try {
    for (let n = 0; ; n++) {
      try { return await ask(provider, what, url, init, ms, read, quiet, again && !n ? first : 0); }
      catch (e) {
        if (e instanceof Timeout && e.early) continue;
        if (!(e instanceof Unsent)) throw e;
        notThrough();
        failed ||= Date.now();
        if (again && lastThrough > failed) throw e.cause;
        const left = lostSince + LOST_FOR - Date.now();
        if (!again || !link.waits || left <= 0) throw new Offline(provider);
        if (!told) { told = true; askingAgain(provider); }
        await pauseFor(Math.min(left, PAUSE_MAX, 500 * 2 ** n));
      }
    }
  } finally { if (told) doneAsking(); }
};
async function ask(provider, what, url, init, ms, read, quiet, first) {
  const whole = AbortSignal.timeout(ms), early = first > 0 && first < ms ? new AbortController() : null;
  const signal = early ? AbortSignal.any([whole, early.signal]) : whole, t0 = Date.now();
  let late = null, how = "failed";
  const slow = quiet ? 0 : setTimeout(() => { late = activity.wait(`no answer from ${provider} yet`, 0, { logged: false, since: t0 }); }, TIMEOUTS.slow);
  const hurry = early ? setTimeout(() => early.abort(), first) : 0;
  const answered = () => { clearTimeout(slow); clearTimeout(hurry); late?.(); late = null; };
  try {
    let resp;
    try { resp = await fetch(url, { ...init, signal }); }
    catch (e) { if (e instanceof TypeError && !signal.aborted) { how = "unsent"; throw new Unsent(e); } throw e; }
    answered(); gotThrough();
    const body = await read(resp);
    how = resp.status;
    return { resp, body };
  } catch (e) {
    if (e instanceof Unsent) throw e;
    const gaveUp = !!early?.signal.aborted, out = gaveUp || (whole.aborted && e.name === "TimeoutError");
    if (out) how = "no answer";
    throw out ? Object.assign(new Timeout(provider, what, gaveUp ? first : ms), { early: gaveUp }) : e;
  } finally { answered(); activity.note(what, Date.now() - t0, how); }
}

// Every folder with a string id, a name and a types list, whatever shape the provider sent.
export function normalizeFolders(list) {
  return (Array.isArray(list) ? list : []).filter(f => f && f.id != null).map(f => ({
    ...f, id: String(f.id), name: typeof f.name === "string" && f.name ? f.name : `Folder ${f.id}`,
    types: Array.isArray(f.types) ? f.types.filter(t => typeof t === "string") : [],
  }));
}

// Message ids end up inside query strings and URIs; anything but the alphabet both providers write
// them in is refused.
export const isMessageId = id => (typeof id === "string" || typeof id === "number") && /^[A-Za-z0-9_-]{1,64}$/.test(String(id));
export function checkIds(ids) {
  const bad = ids.find(id => !isMessageId(id));
  if (bad !== undefined) throw new ApiError(`refusing malformed message id ${JSON.stringify(String(bad).slice(0, 40))}`);
}

// The Message-IDs a header value names, in its order and without their angle brackets: a string
// as the header is written, or a list of them. A value with no brackets counts as one id when it
// is one word holding an @, as a provider may hand an id over bare.
export function messageIds(value) {
  const out = [];
  for (const v of [].concat(value ?? [])) {
    const s = String(v), named = [...s.matchAll(/<([^<>\s]+)>/g)].map(m => m[1]);
    if (named.length) out.push(...named);
    else if (/^\s*[^\s<>@]+@[^\s<>@]+\s*$/.test(s)) out.push(s.trim());
  }
  return out;
}
// What a message names of its conversation, for ext/thread.js: its own id, the one it answers
// (the first of In-Reply-To) and its References, oldest first; "" or [] where it names none.
export const refsFrom = (messageId, inReplyTo, references) => ({ id: messageIds(messageId)[0] || "", parent: messageIds(inReplyTo)[0] || "", refs: messageIds(references) });
