// Protocol adapter for the Gmail REST API, with the same exports as the Yahoo adapter
// (yahoo/api.js). Every endpoint and payload shape lives here; nothing else in the client knows
// the wire format. See docs/gmail-api.md.
//
// Gmail has labels where the client has folders: the system labels become the system folders, a
// user label is a folder named by its path, and "All Mail" stands in for the archive. A message
// moves by losing the label of the folder it is shown in (and Inbox, Spam or Trash) and gaining
// the target's; its other labels stay. Drafts keep a draft id across saves while their message id
// changes, so the client's csid is the draft id.

import { getToken, forget, signOut as revoke, NotSignedIn, client, setClient, redirectAddress, refusal, account } from "./auth.js";
import { build, parseAddresses, messageIdOf, replyHeaders } from "./rfc822.js";
import { read, guide, help, explain, notes, projectOf, INTRO, ROUTES } from "./setup.js";
import { sniffImage, dataUrl } from "./bytes.js";
import { remember, rememberUntil } from "./cache.js";
import { clean, fieldAtom } from "./query.js";
import { esc } from "./text.js";
import { ApiError, TIMEOUTS, Timeout, deadlined, normalizeFolders, isMessageId, checkIds } from "./adapter.js";

export { NotSignedIn, ApiError, TIMEOUTS, Timeout, normalizeFolders, isMessageId };

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
const ALL = "ALL";                       // the All Mail pseudo folder: every message without a label filter
const SYSTEM = { INBOX: ["INBOX", "Inbox"], DRAFT: ["DRAFT", "Drafts"], SENT: ["SENT", "Sent"], SPAM: ["BULK", "Spam"], TRASH: ["TRASH", "Trash"] };
const FOLDER_LABELS = new Set(["INBOX", "SPAM", "TRASH"]);   // system labels that act as a message's folder
const PAGE_MAX = 500;

// The button keeps the exact text Google's sign-in branding prescribes, without a trademark sign.
// waiting: what the page says while Google's window is open.
export const PROVIDER = {
  id: "gmail", name: "Gmail",
  signIn: { text: "Sign in with your Google™ account to read and write your Gmail here. The permission can be withdrawn at any time in your Google account's security settings.", link: null, button: "Sign in with Google",
    waiting: "Waiting for Google's window... If you do not see it, it may be behind this one." },
  trademark: "Gmail™ and Google™ are trademarks of Google LLC. Baltazar Mail for Gmail is not created by, affiliated with, or endorsed by Google LLC.",
};
// Gmail's API returns the sender's own HTML, so remote images load straight from their hosts.
export const IMAGE_SRC = "https:";
// messageBytes: Gmail's send limit for attachments. The address book's first build reads every row
// at a quota cost, so it is kept out of the user's way: scanMax rows per folder, scanPage rows a
// step, the first step no sooner than scanAfter (ms) from when the mailbox was first opened, and
// each step only once the user has left the app alone for scanIdle (ms).
export const LIMITS = { messageBytes: 25 * 1048576, scanMax: 2000, scanPage: 20, scanAfter: 2 * 60e3, scanIdle: 60e3 };

// An image still addressed as cid: (a part that could not be inlined) could not load for anyone.
export const isStrayImage = src => /^cid:/i.test(String(src || "").trim());

export const isGone = e => e instanceof ApiError && e.detail?.status === 404;

// ---------- queries ----------
// An address as a search value: only the characters addresses are written with reach the query,
// so none of it can end the term or work as an operator of Gmail's search (quotes, brackets,
// braces, a colon, a bar, white space).
const bareAddress = email => String(email).replace(/[^\p{L}\p{N}.!#$%&'*+\/=?^_`~@-]/gu, "");
// A query() string that names labels as well as a search: query() reads it back.
const OPAQUE = "\u0000";
const opaque = o => OPAQUE + JSON.stringify(o);
export const queries = {
  starred: (unreadOnly = false) => `is:starred${unreadOnly ? " is:unread" : ""}`,
  unreadIn: folderId => opaque({ labelIds: folderId === ALL ? [] : [String(folderId)], q: "is:unread" }),
  person: email => { const e = bareAddress(email); return `(from:${e} OR to:${e} OR cc:${e})`; },
  // mail with attachments, for a folder's list of attachments (searchScoped)
  files: () => "has:attachment",
};

// ---------- search terms ----------
// Gmail's search takes any boolean query, so the whole parsed search is written out (compile);
// atom writes one term, and refuses a value its field does not know.
// A value is quoted where Gmail would read it as more than a word: with white space, a colon or a
// bracket in it, a leading - or +, braces, or the operators OR and AND.
const quoted = v => /[\s:(){}]|^[-+]|^(OR|AND)$/.test(v) ? `"${v}"` : v;
// Gmail reads a written date as midnight Pacific time, so a day goes as the seconds of the user's
// own midnight.
const WORDS = { starred: "is:starred", day: (op, d) => { const [y, mo, day] = d.split("-").map(Number); return `${op}:${Math.floor(new Date(y, mo - 1, day).getTime() / 1000)}`; } };
function atom(term, neg = false) {
  const v = clean(term.value), n = neg ? "-" : "";
  switch (term.field) {
    case null: return `${n}${quoted(v)}`;
    case "from": case "to": case "subject": return `${n}${term.field}:${quoted(v)}`;
  }
  return fieldAtom(term, neg, WORDS);
}
// within: the operator of the group around this node ("and", "or" or null at the top); a group
// is bracketed only where its own operator differs from that.
function compile(node, neg = false, within = null) {
  if (!node) return "";
  if (node.t === "term") return atom(node, neg);
  if (node.t === "not") return compile(node.kid, !neg, within);
  const op = (node.t === "and") !== neg ? "and" : "or";
  const parts = node.kids.map(k => compile(k, neg, op)).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const s = parts.join(op === "and" ? " " : " OR ");
  return within && within !== op ? `(${s})` : s;
}
export const dialect = { atom, compile: ast => compile(ast) };

// ---------- sign-in ----------
export async function bootstrap(force = false) {
  const t = await getToken({ force });
  return { email: t.email, at: Date.now() };
}
// The sign-in button. A sign-in that succeeds ends the setup guide.
export async function signIn() {
  const t = await getToken({ interactive: true });
  const session = { email: t.email, at: Date.now() };
  await chrome.storage.local.remove(SETUP);
  return session;
}

// The sign-in page's setup of the user's own Google client (the guide's text is in setup.js).
// The guide shows while there is no Client ID, and from a change of Client ID until a sign-in
// succeeds; where it stands is kept in local storage, so a closed tab carries on at the same step.
const SETUP = "gmSetup";   // { route, step }
const progress = async () => (await chrome.storage.local.get(SETUP))[SETUP] || null;
export const setup = {
  // What the page shows: { kind: "guide" | "ready" | "ended", own, account, text, route, step,
  // steps, other, jump, notes, help }. ready: a Client ID and nobody signed in; ended: the
  // sign-in of account ended (Google's session, or the permission withdrawn).
  async view() {
    const [{ id, own }, was, at] = await Promise.all([client(), account(), progress()]);
    const redirect = redirectAddress(), project = projectOf(id);
    const kind = !id || at ? "guide" : was ? "ended" : "ready";
    const route = ROUTES.includes(at?.route) ? at.route : "quick";
    const g = guide({ route, redirect, project });
    const step = g.steps.some(s => s.id === at?.step) ? at.step : g.steps[0].id;
    const text = kind === "guide" ? INTRO : kind === "ended" ? `Your Google™ sign-in as ${was} has ended. Sign in again to carry on.` : PROVIDER.signIn.text;
    return { kind, own, clientId: own ? id : "", account: was, text, ...g, step, notes: notes(own), help: help({ redirect, project }),
      reset: own ? "Use a different Client ID" : "Use a Client ID of your own", trouble: "Trouble signing in?" };
  },
  // A pasted Client ID: { id } or { id, warn } when it is one, { error } when not, {} for nothing.
  check: text => read(text, redirectAddress()),
  // Keeps a pasted Client ID and moves the guide past the paste step; answers as check does.
  async paste(text, route = "quick") {
    const r = read(text, redirectAddress());
    if (!r.id) return r;
    await setClient(r.id);
    const steps = guide({ route }).steps, i = steps.findIndex(s => s.id === "paste");
    await chrome.storage.local.set({ [SETUP]: { route, step: steps[i + 1].id } });
    return r;
  },
  // Where the guide stands.
  at: (route, step) => chrome.storage.local.set({ [SETUP]: { route, step } }),
  // Forgets the user's Client ID and opens the guide at the paste step.
  async reset() {
    await setClient("");
    await chrome.storage.local.set({ [SETUP]: { route: "quick", step: "paste" } });
  },
  // A failed sign-in in words (setup.js, explain).
  async explain(e) { return explain(e, { project: projectOf((await client()).id) }); },
};
// Ends the sign-in at Google, then forgets everything learnt about the mailbox.
export async function signOut() {
  await revoke();
  historyId = null; labelList = []; draftsLoadedAt = 0;
  for (const m of [modseq, lastCounts, knownCounts, labelName, labelsOf, rowCache, draftOf, knownDrafts, cursors, partRefs, bytesCache, thumbCache, inlineCache, originals]) m.clear();
}

// ---------- transport ----------
// cap: the pace the request keeps; the user's own requests are counted while they run, so
// background work can stand aside (see quota).
// Every request has a deadline (TIMEOUTS), past which it fails as a Timeout.
const fetchTimed = deadlined("Gmail");
async function timed(what, url, init, ms, read, cap = FOREGROUND) {
  const mine = cap !== BACKGROUND;
  if (mine) { foregroundBusy++; lastForeground = Date.now(); }
  try { return await fetchTimed(what, url, init, ms, read); }
  finally { if (mine) { foregroundBusy--; lastForeground = Date.now(); } }
}

// Quota: a Google Cloud project gives each user 6,000 units a minute by default (Gmail's documents
// say 15,000; a project gets what its quota page shows), and Gmail also refuses a user's requests
// that come too fast or too many at once. Every call is paced under a sliding minute: what the user
// does, and all calls together, may use up to FOREGROUND. Background work (the address-book build)
// keeps far below that and out of the way: at most BACKGROUND a minute of its own,
// BACKGROUND_BATCH rows to a batch, one request every BACKGROUND_GAP, and none while a request of
// the user's runs or for YIELD after one, so it never comes in bursts and nothing the user does
// waits behind it.
const FOREGROUND = 5500, BACKGROUND = 750;
const BACKGROUND_BATCH = 10, BACKGROUND_GAP = 4000, YIELD = 2000;
const spent = [];            // [time, units, background] of the calls of the last minute, oldest first
let blockedUntil = 0;        // Gmail refused one of the user's calls for quota: nothing goes before its minute is over
let backgroundUntil = 0;     // Gmail refused background work for quota: only background work waits
let foregroundBusy = 0, lastForeground = 0, lastBackground = 0;
async function quota(units, cap = FOREGROUND) {
  const background = cap === BACKGROUND;
  for (;;) {
    const now = Date.now();
    const until = background ? Math.max(blockedUntil, backgroundUntil, lastBackground + BACKGROUND_GAP, lastForeground + YIELD) : blockedUntil;
    if (now < until) { await sleep(until - now); continue; }
    if (background && foregroundBusy) { await sleep(250); continue; }
    while (spent.length && now - spent[0][0] >= 60000) spent.shift();
    // how long until enough of this spending is a minute old for the call to fit under limit
    const wait = (list, limit) => {
      let over = list.reduce((n, s) => n + s[1], 0) + units - limit, at = now;
      if (over <= 0 || !list.length) return 0;
      for (const [t, u] of list) { at = t; over -= u; if (over <= 0) break; }
      return at + 60000 - now + 50;
    };
    const ms = Math.max(wait(spent, FOREGROUND), background ? wait(spent.filter(s => s[2]), BACKGROUND) : 0);
    if (!ms) { spent.push([now, units, background]); if (background) lastBackground = now; return; }
    await sleep(ms);
  }
}
// A refusal for quota names the minute it counted in (ErrorInfo window_start_time, in seconds):
// how long until that minute is over, or 0 for a refusal that does not say.
function quotaWait(doc) {
  const info = (doc?.error?.details || []).find(d => d?.metadata?.window_start_time);
  if (!info) return 0;
  return Math.min(61000, Math.max(1000, (Number(info.metadata.window_start_time) + 60) * 1000 - Date.now() + 500));
}
// The pause before asking again after a refusal. A quota refusal of background work holds
// background work alone until Gmail's minute is over, and one of the user's calls holds every
// call (quota() waits for either); anything else waits Retry-After or a growing backoff.
function pauseFor(resp, doc, left, background = false) {
  const w = quotaWait(doc);
  if (w && background) { backgroundUntil = Math.max(backgroundUntil, Date.now() + w); return 0; }
  if (w) { blockedUntil = Math.max(blockedUntil, Date.now() + w); spent.length = 0; return 0; }
  return Number(resp?.headers.get("retry-after")) * 1000 || backoff(left);
}

const RETRIABLE = new Set([429, 500, 502, 503, 504]);
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const reasonOf = doc => doc?.error?.errors?.[0]?.reason || doc?.error?.status || "";
// Rate limits (429, or a 403 that says so) and server errors pass; they are asked again.
const retriable = (status, doc) => RETRIABLE.has(status) || (status === 403 && /rateLimit|userRateLimit/i.test(reasonOf(doc)));
const backoff = left => Math.min(8000, 500 * 2 ** (3 - left)) + Math.random() * 300;
// URL parameters; a list (labelIds) is repeated, as Gmail reads it; null and undefined are left out.
function addQuery(url, query) {
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else if (v != null) url.searchParams.set(k, v);
  }
}
// One call to Gmail. json: a JSON body; body: raw bytes with their content type; query: URL
// parameters (null and undefined left out). A 401 gets one silent token renewal; rate limits and
// server errors a few retries. units: its quota cost; cap: the pace it keeps (BACKGROUND for
// background work). Returns the parsed JSON (null for an empty answer).
async function call(method, path, opts = {}, tries = { auth: true, again: 3 }) {
  // once: a request that may have taken effect though it failed (a send) is asked again only when
  // Gmail refused it before doing anything (a rate limit), never after a server error
  const { query = null, json = null, body = null, type = null, base = API, timeout = TIMEOUTS.batch, units = 1, cap = FOREGROUND, once = false } = opts;
  await quota(units, cap);
  const t = await getToken();
  const url = new URL(base + path);
  addQuery(url, query);
  const headers = { Authorization: `Bearer ${t.access_token}` };
  let payload;
  if (json != null) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(json); }
  else if (body != null) { headers["Content-Type"] = type; payload = body; }
  const what = `${method} ${path}`;
  const { resp, body: text } = await timed(what, url, { method, headers, body: payload }, timeout, r => r.text(), cap);
  if (resp.status === 401 && tries.auth) { await forget(); await getToken({ force: true }); return call(method, path, opts, { ...tries, auth: false }); }
  if (resp.status === 401) { await forget(); throw new NotSignedIn(); }
  let doc = null;
  if (text) { try { doc = JSON.parse(text); } catch { doc = null; } }
  if (retriable(resp.status, doc) && tries.again > 0 && !(once && resp.status >= 500)) {
    await sleep(pauseFor(resp, doc, tries.again, cap === BACKGROUND));
    return call(method, path, opts, { ...tries, again: tries.again - 1 });
  }
  // a token without the mail permission (left unticked on Google's consent page, or withdrawn since)
  if (resp.status === 403 && refusal(doc) === "scope") { await forget(); throw new NotSignedIn("the sign-in lacks the needed permission; sign in again", "scope"); }
  if (!resp.ok) throw new ApiError(`${what}: HTTP ${resp.status} ${String(doc?.error?.message || text).slice(0, 160)}`, { status: resp.status, error: doc?.error || text.slice(0, 300) });
  // Gmail leaves empty fields out, so an answer with nothing to say (a list with no entries under
  // a fields mask, a 204) has no body at all: an empty object, read like any other answer.
  return doc ?? {};
}

// Several calls in one HTTP round trip (multipart/mixed). reqs: [{ method, path, query, json }];
// returns [{ status, json }] in the same order. Gmail caps a batch at 100 and rate-limits big
// ones, so 50 go at a time, and background work's BACKGROUND_BATCH. Gmail may refuse single items
// of a batch that itself succeeds (rate limits, server errors): those are asked again, after a
// pause, in a batch of their own.
const BATCH_SIZE = 50, ITEM_TRIES = 3;
async function batch(reqs, units = 5, cap = FOREGROUND) {
  const out = new Array(reqs.length), background = cap === BACKGROUND, size = background ? BACKGROUND_BATCH : BATCH_SIZE;
  let todo = reqs.map((r, i) => i);
  for (let left = ITEM_TRIES; ; left--) {
    for (let i = 0; i < todo.length; i += size) {
      const idx = todo.slice(i, i + size);
      const got = await batchOnce(idx.map(k => reqs[k]), units, cap);
      idx.forEach((k, j) => { out[k] = got[j]; });
    }
    todo = todo.filter(k => out[k].status === 0 || retriable(out[k].status, out[k].json));
    if (!todo.length || left === 0) return out;
    await sleep(Math.max(...todo.map(k => pauseFor(null, out[k].json, left, background))));
  }
}
async function batchOnce(reqs, units, cap, tries = { auth: true, again: 3 }) {
  if (!reqs.length) return [];
  await quota(units * reqs.length, cap);
  const t = await getToken();
  const boundary = `batch_${crypto.randomUUID()}`;
  const body = encodeBatch(reqs, boundary);
  const { resp, body: text } = await timed("batch", BATCH_URL, { method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": `multipart/mixed; boundary=${boundary}` }, body }, TIMEOUTS.batch, r => r.text(), cap);
  if (resp.status === 401 && tries.auth) { await forget(); await getToken({ force: true }); return batchOnce(reqs, units, cap, { ...tries, auth: false }); }
  if (resp.status === 401) { await forget(); throw new NotSignedIn(); }
  if (!resp.ok && tries.again > 0) {
    let doc = null; try { doc = JSON.parse(text); } catch { doc = null; }
    if (retriable(resp.status, doc)) { await sleep(pauseFor(resp, doc, tries.again, cap === BACKGROUND)); return batchOnce(reqs, units, cap, { ...tries, again: tries.again - 1 }); }
  }
  if (!resp.ok) throw new ApiError(`batch: HTTP ${resp.status} ${text.slice(0, 160)}`, { status: resp.status, error: text.slice(0, 300) });
  const m = (resp.headers.get("content-type") || "").match(/boundary="?([^";]+)"?/);
  if (!m) throw new ApiError("batch: no boundary in the answer", text.slice(0, 300));
  return decodeBatch(text, m[1], reqs.length);
}
export function encodeBatch(reqs, boundary) {
  return reqs.map((r, i) => {
    const url = new URL(API + r.path);
    addQuery(url, r.query);
    const head = `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\n${r.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
    return r.json != null ? `${head}Content-Type: application/json\r\n\r\n${JSON.stringify(r.json)}\r\n` : `${head}\r\n`;
  }).join("") + `--${boundary}--\r\n`;
}
// The answers come back as parts in request order, each naming its item in Content-ID.
export function decodeBatch(text, boundary, n) {
  const out = Array.from({ length: n }, () => ({ status: 0, json: null }));
  const parts = text.split(`--${boundary}`).slice(1, -1);
  parts.forEach((p, i) => {
    const id = Number((p.match(/Content-ID:\s*<response-item(\d+)>/i) || [])[1] ?? i);
    const http = p.slice(p.search(/\r?\n\r?\n/)).replace(/^\r?\n\r?\n/, "");
    const status = Number((http.match(/^HTTP\/[\d.]+ (\d+)/) || [])[1] || 0);
    const bodyAt = http.search(/\r?\n\r?\n/);
    const body = bodyAt < 0 ? "" : http.slice(bodyAt).trim();
    let json = null; if (body) { try { json = JSON.parse(body); } catch { json = null; } }
    if (id >= 0 && id < n) out[id] = { status, json };
  });
  return out;
}

// ---------- folders (labels) ----------
const labelName = new Map();       // label id -> name shown as the folder's path
const labelsOf = new Map();        // message id -> its labelIds, from every row and body seen
let labelList = [];                // the last labels.list answer

const profile = () => call("GET", "/profile");

// Changes since the last look, as Gmail's history reports them: each label named in a record
// gets a new stamp, which the client compares as a folder's highestModSeq. A history Gmail no
// longer has (404) stamps every folder once.
let historyId = null;
const modseq = new Map();
const lastCounts = new Map();       // label id -> "total/unread" last reported, to notice a change
const knownCounts = new Map();      // label id -> the last counts Gmail answered
async function noteHistory(ids, current) {
  const stampAll = h => { for (const id of ids) modseq.set(id, `${h}:all`); };
  if (!historyId) { historyId = current; stampAll(historyId); return; }
  try {
    const dirty = new Set();
    let token = null, latest = historyId;
    do {
      const r = await call("GET", "/history", { query: { startHistoryId: historyId, maxResults: PAGE_MAX, pageToken: token }, units: 2 });
      for (const h of r.history || []) {
        for (const k of ["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) for (const x of h[k] || []) {
          for (const l of x.message?.labelIds || []) dirty.add(l);
          for (const l of x.labelIds || []) dirty.add(l);
          if (x.message?.id && x.message.labelIds) labelsOf.set(x.message.id, x.message.labelIds);
          if (k === "messagesDeleted" && x.message?.id) { rowCache.delete(x.message.id); labelsOf.delete(x.message.id); }
        }
        dirty.add(ALL);
      }
      if (r.historyId) latest = r.historyId;
      token = r.nextPageToken || null;
    } while (token);
    for (const l of dirty) modseq.set(l, latest);
    historyId = latest;
  } catch (e) {
    if (!isGone(e)) throw e;
    // what changed meanwhile is not known, so no kept labels or rows are trusted
    historyId = current;
    stampAll(historyId);
    rowCache.clear(); labelsOf.clear();
  }
}

export async function folders() {
  const t0 = performance.now();
  const [r, p] = await Promise.all([call("GET", "/labels"), profile()]);
  labelList = r.labels || [];
  labelName.clear();
  const shown = [];
  for (const l of labelList) {
    if (l.type === "system") { if (SYSTEM[l.id]) { labelName.set(l.id, SYSTEM[l.id][1]); shown.push(l); } continue; }
    labelName.set(l.id, l.name);
    shown.push(l);
  }
  const counts = await batch(shown.map(l => ({ method: "GET", path: `/labels/${l.id}`, query: { fields: "id,messagesTotal,messagesUnread" } })), 1);
  const ids = [...shown.map(l => l.id), ALL];
  await noteHistory(ids, p.historyId);
  const list = shown.map((l, i) => {
    // a label whose counts did not come keeps the ones it had, which is no change
    const got = counts[i].status === 200 && counts[i].json;
    if (got) knownCounts.set(l.id, got);
    const c = knownCounts.get(l.id) || {};
    const key = `${c.messagesTotal}/${c.messagesUnread}`;
    if (got && lastCounts.get(l.id) !== key) { lastCounts.set(l.id, key); modseq.set(l.id, `${modseq.get(l.id) || 0}+${key}`); }
    const types = l.type === "system" ? [SYSTEM[l.id][0]] : l.labelListVisibility === "labelHide" ? ["USER", "INVISIBLE"] : ["USER"];
    return { id: l.id, name: labelName.get(l.id), types, unread: c.messagesUnread || 0, total: c.messagesTotal || 0, highestModSeq: modseq.get(l.id) || 0, acctId: "1" };
  });
  labelName.set(ALL, "All Mail");
  list.push({ id: ALL, name: "All Mail", types: ["ARCHIVE"], unread: 0, total: p.messagesTotal || 0, highestModSeq: modseq.get(ALL) || 0, acctId: "1" });
  return { folders: normalizeFolders(list), ms: Math.round(performance.now() - t0) };
}

// How many messages are starred: the count Gmail keeps for its STARRED label, one unit, where a
// search would fetch every starred message.
export async function starredCount() {
  const r = await call("GET", "/labels/STARRED", { query: { fields: "messagesTotal" } });
  return r?.messagesTotal || 0;
}

const LABEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
function checkLabel(id) { if (!LABEL_ID.test(String(id)) || id === ALL) throw new ApiError(`refusing malformed folder id ${JSON.stringify(String(id).slice(0, 20))}`); }

// Whether any of these labels is on mail outside Spam and Trash. A label's own counts take in the
// mail moved to Trash, for the 30 days it is kept there, so they cannot say whether a label is
// empty; one listing of a single message answers instead.
export async function holdsMail(ids) {
  ids = ids.map(String);
  for (const id of ids) checkLabel(id);
  const query = ids.length === 1 ? { labelIds: ids, maxResults: 1 } : { q: `(${ids.map(labelTerm).join(" OR ")})`, maxResults: 1 };
  const r = await call("GET", "/messages", { query, units: 5 });
  return !!(r.messages || []).length;
}
const isSpamOrTrash = id => id === "SPAM" || id === "TRASH";

export async function createFolder(name) {
  const t0 = performance.now();
  const result = await call("POST", "/labels", { json: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
  return { result, ms: Math.round(performance.now() - t0) };
}
// A rename sets the folder's whole path, so it also moves it. Gmail does not rename the labels
// nested under it, so each of them is renamed as well.
export async function renameFolder(id, name) {
  checkLabel(id);
  const t0 = performance.now();
  const old = labelName.get(id) || labelList.find(l => l.id === id)?.name || "";
  const result = await call("PATCH", `/labels/${id}`, { json: { name } });
  if (old) for (const l of labelList) if (l.type !== "system" && l.name.startsWith(old + "/")) await call("PATCH", `/labels/${l.id}`, { json: { name: name + l.name.slice(old.length) } });
  return { result, ms: Math.round(performance.now() - t0) };
}
export async function deleteFolder(id) {
  checkLabel(id);
  const t0 = performance.now();
  await call("DELETE", `/labels/${id}`);
  return { result: null, ms: Math.round(performance.now() - t0) };
}
// Every id a list names, a page of 500 at a time; fn takes the messages out of the list (it deletes
// them, or marks them read), so each page is asked for afresh. It stops after PAGES_MAX pages,
// 100,000 messages, and says so: a list that still names messages then is longer than that, or
// one fn does not empty, and what was done is not all of it.
const PAGES_MAX = 200;
async function eachPage(params, fn) {
  let n = 0;
  for (let i = 0; i < PAGES_MAX; i++) {
    const r = await call("GET", "/messages", { query: { ...params, maxResults: PAGE_MAX }, units: 5 });
    const ids = (r.messages || []).map(m => m.id);
    if (!ids.length) return n;
    await fn(ids);
    n += ids.length;
    if (!r.nextPageToken) return n;
  }
  throw new ApiError(`only the first ${n.toLocaleString("en-US")} messages were done; do it again for the rest`);
}
// Every message in a folder, permanently deleted.
export async function emptyFolder(id) {
  checkLabel(id);
  const t0 = performance.now();
  // the kept rows and labels of the folder go even when only part of it was emptied
  const forgetRows = () => { for (const [m, l] of labelsOf) if (l.includes(id)) { labelsOf.delete(m); rowCache.delete(m); } };
  const n = await eachPage({ labelIds: id, includeSpamTrash: true }, ids => call("POST", "/messages/batchDelete", { json: { ids }, units: 50 })).finally(forgetRows);
  return { result: null, changed: n, ms: Math.round(performance.now() - t0) };
}
export async function markFolderRead(id) {
  const t0 = performance.now();
  const params = id === ALL ? { q: "is:unread" } : { labelIds: [id, "UNREAD"], ...(isSpamOrTrash(id) ? { includeSpamTrash: true } : {}) };
  const n = await eachPage(params, ids => call("POST", "/messages/batchModify", { json: { ids, removeLabelIds: ["UNREAD"] }, units: 50 }));
  return { result: null, changed: n, ms: Math.round(performance.now() - t0) };
}

// ---------- rows ----------
const headerMap = list => { const h = {}; for (const x of list || []) { const k = String(x.name || "").toLowerCase(); if (!(k in h)) h[k] = x.value || ""; } return h; };
const partHeader = (p, name) => (p.headers || []).find(h => String(h.name).toLowerCase() === name)?.value || "";
const contentIdOf = p => partHeader(p, "content-id").replace(/^\s*<|>\s*$/g, "").trim();
// The leaves of a payload tree, depth first, each with Gmail's own partId.
function leaves(payload, out = []) {
  if (!payload) return out;
  if (payload.parts?.length) { for (const p of payload.parts) leaves(p, out); return out; }
  out.push(payload);
  return out;
}
const isFile = p => !!(p.filename || contentIdOf(p));
// A part is inline only when the text shows it: its Content-ID is a cid: source in the HTML.
// Content-Disposition does not decide it, since some mailers mark every attachment inline.
const dispositionOf = (p, html) => contentIdOf(p) && html.toLowerCase().includes(`cid:${contentIdOf(p).toLowerCase()}`) ? "inline" : "attachment";
// A row has no HTML to look in; there a Content-ID part inside multipart/related (the text's own
// images) counts as inline. Each file is named as body() names it, so a file listed from a row
// (a folder's list of attachments) can be fetched and shown without the message's body.
function rowFiles(node, related = false, out = []) {
  if (!node) return out;
  if (node.parts?.length) {
    const r = related || /^multipart\/related$/i.test(node.mimeType || "");
    for (const p of node.parts) rowFiles(p, r, out);
  } else if (isFile(node)) {
    const [type, subtype] = String(node.mimeType || "application/octet-stream").split("/");
    out.push({ partId: String(node.partId ?? ""), filename: node.filename || "", size: node.body?.size || 0, type, subtype: subtype || "", disposition: related && contentIdOf(node) ? "inline" : "attachment" });
  }
  return out;
}

// The folder a message is shown in: the listed label, else Trash, Spam, Drafts, Inbox, its first
// user label, Sent, and All Mail for a message with none of those. All Mail lists every message,
// so a row listed there is placed by its labels as well: archiving it then takes it out of Inbox.
function folderOf(labelIds = [], listed = null) {
  const has = l => labelIds.includes(l);
  const id = listed && listed !== ALL && has(listed) ? listed
    : has("TRASH") ? "TRASH" : has("SPAM") ? "SPAM" : has("DRAFT") ? "DRAFT" : has("INBOX") ? "INBOX"
    : labelIds.find(l => labelName.has(l) && !SYSTEM[l]) || (has("SENT") ? "SENT" : ALL);
  return { id, name: labelName.get(id) || id };
}

const ROW_FIELDS = "id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload(partId,mimeType,filename,headers,body/size,parts(partId,mimeType,filename,headers,body/size,parts(partId,mimeType,filename,headers,body/size,parts(partId,mimeType,filename,headers,body/size))))";
function toRow(m, listed = null) {
  const h = headerMap(m.payload?.headers);
  const labels = m.labelIds || [];
  labelsOf.set(m.id, labels);
  const files = rowFiles(m.payload);
  return {
    id: m.id, immutableid: m.id, threadId: m.threadId, size: m.sizeEstimate || 0, labelIds: labels, snippet: m.snippet || "",
    flags: { read: !labels.includes("UNREAD"), flagged: labels.includes("STARRED") },
    attachments: files, attachmentCount: files.filter(a => a.disposition !== "inline").length,
    folder: folderOf(labels, listed),
    headers: {
      subject: h.subject || "", from: parseAddresses(h.from), to: parseAddresses(h.to), cc: parseAddresses(h.cc), bcc: parseAddresses(h.bcc), replyTo: parseAddresses(h["reply-to"]),
      date: String(Math.floor(Number(m.internalDate || 0) / 1000)), mimeType: m.payload?.mimeType || "",
      messageId: messageIdOf(h["message-id"]), inReplyTo: messageIdOf(h["in-reply-to"]), references: h.references || "",
    },
  };
}

// Rows for ids, in the order given; a message gone meanwhile (404) is left out. Any other failure
// fails the list, since a row left out would end the paging early.
// A message's headers and parts never change (a draft saved again is a new message), so each row
// is fetched once and kept; its labels, which do change, come from labelsOf, which every change
// made here and every change Gmail's history reports keeps current. A refresh, or a folder opened
// again, then fetches only the messages it has not seen.
// The rows already kept are taken first and made the newest, so the room the fetched rows take in
// the cache never costs this answer a row. A message deleted or forgotten meanwhile has lost its
// labels and is left out.
const rowCache = new Map();        // message id -> the message as Gmail answered it for a row
const ROW_CACHE = 5000;
async function rows(ids, listed = null, cap = FOREGROUND) {
  const found = new Map();
  for (const id of ids) if (rowCache.has(id)) { const m = rowCache.get(id); found.set(id, m); remember(rowCache, id, m, ROW_CACHE); }
  const need = ids.filter(id => !found.has(id));
  const got = need.length ? await batch(need.map(id => ({ method: "GET", path: `/messages/${id}`, query: { format: "full", fields: ROW_FIELDS } })), 5, cap) : [];
  const bad = got.findIndex(r => r.status !== 404 && !(r.status === 200 && r.json));
  if (bad >= 0) throw new ApiError(`GET /messages/${need[bad]}: HTTP ${got[bad].status} ${String(got[bad].json?.error?.message || "").slice(0, 160)}`, { status: got[bad].status, error: got[bad].json?.error || null });
  got.forEach((r, i) => { if (r.status === 200) { found.set(need[i], r.json); remember(rowCache, need[i], r.json, ROW_CACHE); labelsOf.set(need[i], r.json.labelIds || []); } });
  const out = ids.filter(id => found.has(id) && labelsOf.has(id)).map(id => toRow({ ...found.get(id), labelIds: labelsOf.get(id) }, listed));
  if (out.some(m => m.labelIds.includes("DRAFT"))) { await loadDrafts(false); for (const m of out) if (m.labelIds.includes("DRAFT")) m.csid = draftOf.get(m.id) || undefined; }
  return out;
}

// Listing pages with tokens; the client asks by offset in order, so each query keeps the token of
// where its last page ended, and any other offset is walked to from the start (ids only).
const cursors = new Map();
// Background work keeps cursors of its own, so it does not move the ones the user pages with.
async function listIds(params, count, offset, cap = FOREGROUND) {
  const key = JSON.stringify([params, cap]);
  let cur = cursors.get(key);
  if (offset === 0 || !cur || cur.nextOffset !== offset) {
    cur = { nextOffset: 0, token: null };
    while (cur.nextOffset < offset) {
      const r = await call("GET", "/messages", { query: { ...params, maxResults: Math.min(PAGE_MAX, offset - cur.nextOffset), pageToken: cur.token }, units: 5, cap });
      cur.nextOffset += (r.messages || []).length;
      cur.token = r.nextPageToken || null;
      if (!r.nextPageToken) break;
    }
    if (cur.nextOffset < offset) { cursors.set(key, cur); return { ids: [], estimate: 0 }; }
  }
  // a list whose page came without a token ends there: asked past it, it answers nothing (asked
  // without a token, Gmail would answer its first page again)
  if (offset > 0 && !cur.token) { cursors.set(key, cur); return { ids: [], estimate: 0 }; }
  // Gmail answers at most 500 ids a page; a longer list (a refresh of many loaded rows) takes several
  const want = Math.max(1, count), ids = [];
  let token = cur.token, estimate = 0;
  do {
    const r = await call("GET", "/messages", { query: { ...params, maxResults: Math.min(PAGE_MAX, want - ids.length), pageToken: token }, units: 5, cap });
    ids.push(...(r.messages || []).map(m => m.id));
    token = r.nextPageToken || null;
    estimate = r.resultSizeEstimate || estimate;
  } while (token && ids.length < want);
  cursors.set(key, { nextOffset: offset + ids.length, token });
  return { ids, estimate };
}
const listParams = ({ labelIds = [], q = "", includeSpamTrash = false }) => ({ ...(labelIds.length ? { labelIds } : {}), ...(q ? { q } : {}), ...(includeSpamTrash || labelIds.some(isSpamOrTrash) ? { includeSpamTrash: true } : {}) });

async function listRows(spec, count, offset, listed = null, cap = FOREGROUND) {
  const t0 = performance.now();
  const { ids } = await listIds(listParams(spec), count, offset, cap);
  const messages = await rows(ids, listed, cap);
  return { messages, ms: Math.round(performance.now() - t0) };
}

// background: work the user is not waiting for (the address-book build), paced to leave room.
export function list(folderId, count = 100, offset = 0, { background = false } = {}) {
  const id = String(folderId);
  return listRows({ labelIds: id === ALL ? [] : [id] }, count, offset, id, background ? BACKGROUND : FOREGROUND);
}

// Every message outside Spam and Trash, newest first, whatever its labels: All Mail. It lists the
// mail of every label, so the caller passes over the rows it has read elsewhere.
export const listAll = (count = 100, offset = 0, opts = {}) => list(ALL, count, offset, opts);
// How many messages listAll has to list, told from the folder list.
export const countAll = folders => folders.find(f => f.id === ALL)?.total || 0;

// A query in Gmail's search language (queries.*, or one the dialect wrote), over all mail outside
// Spam and Trash.
export const search = (qs, count = 100, offset = 0) => listRows({ labelIds: [], q: qs }, count, offset, null);

// A label named in a query, as Gmail's search writes it: in quotes, spaces as hyphens.
const labelTerm = id => `label:"${(labelName.get(id) || id).replace(/"/g, "").replace(/ /g, "-")}"`;
// A query as for search(), within a scope or outside it: include or exclude, each { ids:
// [folderId...] } for a folder and its subfolders, or { starred: true }.
export async function searchScoped(qs, { include = null, exclude = null } = {}, count = 100, offset = 0) {
  let q = qs;
  if (include?.starred) return listRows({ q: `is:starred ${q}` }, count, offset);
  if (include?.ids?.length) {
    const ids = include.ids.map(String);
    if (ids.length === 1) return listRows({ labelIds: ids[0] === ALL ? [] : ids, q }, count, offset, ids[0]);
    // a folder with its subfolders: any of their labels, through the search itself
    return listRows({ q: `(${ids.map(labelTerm).join(" OR ")}) ${q}`, includeSpamTrash: ids.some(isSpamOrTrash) }, count, offset);
  }
  // nothing is outside All Mail, so a search there has no matches elsewhere
  if (exclude?.ids?.map(String).includes(ALL)) return { messages: [], ms: 0 };
  if (exclude?.starred) q = `-is:starred ${q}`;
  const ids = (exclude?.ids || []).map(String);
  if (ids.length) q = `${ids.map(id => `-${labelTerm(id)}`).join(" ")} ${q}`;
  const r = await listRows({ q }, count, offset);
  // what the search still answered with one of those labels stays out
  r.messages = r.messages.filter(m => !ids.some(id => m.labelIds.includes(id)));
  return r;
}

// One query in Gmail's search language, or an opaque label query from queries.*.
export function query(qs, count = 100, offset = 0) {
  if (String(qs).startsWith(OPAQUE)) { const o = JSON.parse(qs.slice(1)); return listRows({ labelIds: o.labelIds || [], q: o.q || "" }, count, offset, o.labelIds?.[0] || null); }
  return listRows({ q: qs }, count, offset);
}

// ---------- body, parts ----------
const fromB64url = s => { const b = atob(String(s || "").replace(/-/g, "+").replace(/_/g, "/")); const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; };
const charsetOf = p => (partHeader(p, "content-type").match(/charset="?([^";\s]+)"?/i) || [])[1] || "utf-8";
function decodeText(p, bytes) {
  let dec; try { dec = new TextDecoder(charsetOf(p)); } catch { dec = new TextDecoder(); }
  return dec.decode(bytes);
}
// Plain text as HTML: escaped, links made clickable, line breaks kept.
const textAsHtml = t => `<div style="white-space:pre-wrap">${esc(t).replace(/\bhttps?:\/\/[^\s<>"']+/g, u => `<a href="${u}">${u}</a>`)}</div>`;
const partKey = (msgId, partId) => `${msgId}/${partId}`;
// msgId/partId -> { attachmentId, data, type, filename }: where each part's bytes are. A part's own
// data is kept only for a named part (an attachment) that came with the message, as the text that
// body() decodes is not asked for again; a part known without either is fetched afresh.
const partRefs = new Map(), PART_REFS = 5000;
const notePart = (msgId, p, keep) => remember(partRefs, partKey(msgId, p.partId), { attachmentId: p.body?.attachmentId, data: keep ? p.body?.data : undefined, type: p.mimeType, filename: p.filename || "" }, PART_REFS);
const BODY_FIELDS = "id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload";

// The parts that make up the text a reader shows, in order: an alternative gives its preferred
// branch (HTML when html, else plain text), related its root, and any other multipart every text
// part it holds, so text after an attachment is shown too. Named parts and attachments are files.
function textParts(node, html) {
  if (!node || node.filename) return [];
  const type = String(node.mimeType || "").toLowerCase();
  if (node.parts?.length) {
    if (type === "multipart/alternative") {
      const kind = html ? "text/html" : "text/plain";
      const branches = node.parts.map(k => textParts(k, html)).filter(b => b.length).reverse();
      return branches.find(b => b.some(p => p.mimeType === kind)) || branches[0] || [];
    }
    if (type === "multipart/related") return textParts(node.parts[0], html);
    return node.parts.flatMap(k => textParts(k, html));
  }
  if ((type !== "text/plain" && type !== "text/html") || /^\s*attachment/i.test(partHeader(node, "content-disposition"))) return [];
  return [node];
}
async function partData(msgId, p) {
  if (p.body?.data != null) return fromB64url(p.body.data);
  if (!p.body?.attachmentId) return new Uint8Array(0);
  return fromB64url((await call("GET", `/messages/${msgId}/attachments/${p.body.attachmentId}`, { timeout: TIMEOUTS.raw, units: 5 })).data);
}

export async function body(msgId) {
  checkIds([msgId]);
  const t0 = performance.now();
  const m = await call("GET", `/messages/${msgId}`, { query: { format: "full", fields: BODY_FIELDS }, units: 5 });
  const parts = leaves(m.payload);
  for (const p of parts) if (p.partId != null) notePart(msgId, p, !!p.filename && p.body?.size <= 1 << 20);
  const forHtml = textParts(m.payload, true), forText = textParts(m.payload, false);
  const decoded = new Map();
  for (const p of new Set([...forHtml, ...forText])) decoded.set(p, decodeText(p, await partData(msgId, p)));
  const text = forText.filter(p => p.mimeType === "text/plain").map(p => decoded.get(p)).join("\n");
  const html = forHtml.map(p => p.mimeType === "text/html" ? decoded.get(p) : textAsHtml(decoded.get(p))).join("\n");
  const attachments = parts.filter(p => !decoded.has(p) && (isFile(p) || p.body?.attachmentId)).map(p => {
    const [type, subtype] = String(p.mimeType || "application/octet-stream").split("/");
    return { partId: String(p.partId), filename: p.filename || "", size: p.body?.size || 0, type, subtype: subtype || "", contentId: contentIdOf(p) || undefined, disposition: dispositionOf(p, html) };
  });
  const message = toRow({ ...m, payload: { ...m.payload } });
  message.attachments = attachments.map(a => ({ disposition: a.disposition, filename: a.filename }));
  if (message.labelIds.includes("DRAFT")) {
    await loadDrafts(!draftOf.has(msgId));
    message.csid = draftOf.get(msgId) || undefined;
    const ref = message.headers.inReplyTo;
    if (ref) {
      const r = await call("GET", "/messages", { query: { q: `rfc822msgid:${ref}`, maxResults: 1, includeSpamTrash: true }, units: 5 }).catch(() => null);
      const orig = r?.messages?.[0]?.id;
      const fwd = /^\s*fwd?:/i.test(message.headers.subject);
      if (orig) message.inReplyTo = { messageReference: { id: orig }, replied: !fwd, forwarded: fwd };
    }
  }
  // hasHtml: whether the message has an HTML part of its own (html is made from text otherwise)
  return { message, html, text, hasHtml: forHtml.some(p => p.mimeType === "text/html"), attachments, ms: Math.round(performance.now() - t0) };
}

// { bytes, type, filename } of one attachment: Gmail's attachments.get by the part's attachment
// id, which body() noted; a part not seen yet is looked up first. The newest parts stay cached.
// What the caches of parts may hold, whatever the number of entries: attachments' bytes, and
// pictures as data: URLs (a character a byte), since a picture in mail can be several megabytes.
const BYTES_KEPT = 48 << 20, PICTURES_KEPT = 32 << 20;
const urlSize = u => typeof u === "string" ? u.length : 0;
const bytesCache = new Map();
export async function partBytes(msgId, a) {
  checkIds([msgId]);
  const key = partKey(msgId, a.partId);
  if (bytesCache.has(key)) return bytesCache.get(key);
  let ref = partRefs.get(key);
  if (!ref || (ref.data == null && !ref.attachmentId)) {
    const m = await call("GET", `/messages/${msgId}`, { query: { format: "full", fields: "payload" }, units: 5 });
    for (const p of leaves(m.payload)) if (p.partId != null) notePart(msgId, p, true);
    ref = partRefs.get(key) || [...partRefs.entries()].find(([k, v]) => k.startsWith(msgId + "/") && a.filename && v.filename === a.filename)?.[1];
    if (!ref) throw new ApiError("attachment not found in the message");
  }
  const bytes = ref.data != null ? fromB64url(ref.data) : await partData(msgId, { body: { attachmentId: ref.attachmentId } });
  const out = { bytes, type: ref.type, filename: ref.filename };
  rememberUntil(bytesCache, key, Promise.resolve(out), { max: 20, maxBytes: BYTES_KEPT, sizeOf: x => x.bytes.byteLength });
  return out;
}

// Gmail has no download link of its own; the viewer saves the fetched bytes instead.
export const originalUrl = () => null;
// Every attachment Gmail names can be fetched by its attachment id, so the strip lists them all.
export const isListed = () => true;


// A thumbnail of an image attachment: the image itself, when it is small enough to fetch for that.
const THUMB_MAX = 2 * 1048576;
const thumbCache = new Map();
export async function thumbnail(msgId, a) {
  if (!/^image$/i.test(a.type || "") || (a.size || 0) > THUMB_MAX) return null;
  const key = partKey(msgId, a.partId);
  if (thumbCache.has(key)) return thumbCache.get(key);
  const p = partBytes(msgId, a).then(({ bytes }) => { const t = sniffImage(bytes); return t ? dataUrl(new Blob([bytes], { type: t })) : null; }).catch(() => null);
  return rememberUntil(thumbCache, key, p, { max: 100, maxBytes: PICTURES_KEPT, sizeOf: urlSize });
}

// Inline images are cid: references to the message's own parts: the part of a body() result
// that an image source names, or null.
function inlinePart(src, body) {
  const s = String(src || "").trim();
  if (!/^cid:/i.test(s)) return null;
  let cid = s.slice(4); try { cid = decodeURIComponent(cid); } catch { /* as written */ }
  return (body?.attachments || []).find(x => x.contentId && x.contentId.toLowerCase() === cid.toLowerCase()) || null;
}
// Whether an image source names a part of that message (the client asks inlineSource only for
// these, and counts only these towards its limit per message).
export const isInlineRef = (src, body) => !!inlinePart(src, body);
const inlineCache = new Map();
export async function inlineSource(src, body) {
  const message = body?.message, a = inlinePart(src, body);
  if (!message?.id || !a) return null;
  const key = partKey(message.id, a.partId);
  if (inlineCache.has(key)) return inlineCache.get(key);
  const p = partBytes(message.id, a).then(({ bytes }) => { const t = sniffImage(bytes); return t ? dataUrl(new Blob([bytes], { type: t })) : null; }).catch(() => null);
  return rememberUntil(inlineCache, key, p, { max: 200, maxBytes: PICTURES_KEPT, sizeOf: urlSize });
}

// ---------- mutations ----------
// Label changes. A few ids go one message each (messages.modify, 5 units, together in one batch),
// each answered on its own, with its labels; more go through batchModify, 50 units for up to a
// thousand, which answers for all of them or for none.
const FEW = 10;
async function modify(ids, add, remove) {
  checkIds(ids);
  const t0 = performance.now();
  if (ids.length <= FEW) {
    const got = await batch(ids.map(id => ({ method: "POST", path: `/messages/${id}/modify`, json: { addLabelIds: add, removeLabelIds: remove } })), 5);
    const ok = ids.filter((id, i) => got[i].status === 200), failed = ids.filter((id, i) => got[i].status !== 200);
    if (!ok.length) { const g = got[0]; throw new ApiError(`modify: HTTP ${g.status} ${String(g.json?.error?.message || "").slice(0, 160)}`, { status: g.status, error: g.json?.error || null }); }
    ids.forEach((id, i) => { if (got[i].status === 200 && got[i].json?.labelIds) labelsOf.set(id, got[i].json.labelIds); });
    return { ms: Math.round(performance.now() - t0), ok, failed };
  }
  // each thousand is answered as a whole; those done before one fails are reported as done
  const ok = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const part = ids.slice(i, i + 1000);
    try { await call("POST", "/messages/batchModify", { json: { ids: part, addLabelIds: add, removeLabelIds: remove }, units: 50 }); }
    catch (e) { if (!ok.length) throw e; return { ms: Math.round(performance.now() - t0), ok, failed: ids.slice(i) }; }
    for (const id of part) { const l = labelsOf.get(id); if (l) labelsOf.set(id, [...new Set([...l.filter(x => !remove.includes(x)), ...add])]); }
    ok.push(...part);
  }
  return { ms: Math.round(performance.now() - t0), ok, failed: [] };
}
export function setRead(ids, read) { return modify(ids, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []); }
export function setStarred(ids, flagged) { return modify(ids, flagged ? ["STARRED"] : [], flagged ? [] : ["STARRED"]); }

// Label changes for ids, grouped so ids with the same change share one call. changes: id ->
// { add, remove }. Returns the ids changed and the ids that failed.
async function relabel(ids, changes) {
  const groups = new Map();
  for (const id of ids) {
    const c = changes.get(id), key = `${c.add.join(",")}|${c.remove.join(",")}`;
    if (!groups.has(key)) groups.set(key, { ...c, ids: [] });
    groups.get(key).ids.push(id);
  }
  const ok = [], failed = [];
  let error = null;
  for (const g of groups.values()) {
    if (!g.add.length && !g.remove.length) { ok.push(...g.ids); continue; }
    try { const r = await modify(g.ids, g.add, g.remove); ok.push(...r.ok); failed.push(...r.failed); }
    catch (e) { error = e; failed.push(...g.ids); }
  }
  return { ok, failed, error };
}

// A move takes away Inbox, Spam and Trash, and the user label of the folder the message is shown
// in (from: id -> folder id, as the client shows it), and adds the target's label; All Mail adds
// nothing, which is Gmail's archive. Its other user labels stay, as Gmail keeps them, also in
// Trash and Spam, whose messages no label's list shows. The answer's undo() takes back exactly
// what the move changed.
export async function move(ids, folderId, { from = {} } = {}) {
  checkIds(ids);
  const to = String(folderId);
  if (to !== ALL) checkLabel(to);
  const t0 = performance.now();
  const missing = ids.filter(id => !labelsOf.has(id));
  if (missing.length) {
    const got = await batch(missing.map(id => ({ method: "GET", path: `/messages/${id}`, query: { format: "minimal", fields: "id,labelIds" } })));
    got.forEach((r, i) => { if (r.status === 200 && r.json) labelsOf.set(missing[i], r.json.labelIds || []); });
  }
  const isUser = l => labelName.has(l) && !SYSTEM[l] && l !== ALL;
  const keepUser = isSpamOrTrash(to);
  const changes = new Map();
  for (const id of ids) {
    const labels = labelsOf.get(id);
    if (!labels) continue;
    const origin = String(from[id] ?? "");
    const remove = labels.filter(l => l !== to && (FOLDER_LABELS.has(l) || (!keepUser && l === origin && isUser(l)))).sort();
    const add = to !== ALL && !labels.includes(to) ? [to] : [];
    changes.set(id, { add, remove });
  }
  const r = await relabel(ids.filter(id => changes.has(id)), changes);
  const failed = [...ids.filter(id => !changes.has(id)), ...r.failed];
  if (!r.ok.length) throw r.error || new ApiError(`move: all ${ids.length} failed`);
  const back = new Map(r.ok.map(id => [id, { add: changes.get(id).remove, remove: changes.get(id).add }]));
  const undo = async () => {
    const t1 = performance.now();
    const u = await relabel(r.ok, back);
    if (!u.ok.length) throw u.error || new ApiError(`undo: all ${r.ok.length} failed`);
    return { ms: Math.round(performance.now() - t1), ok: u.ok, failed: u.failed };
  };
  return { ms: Math.round(performance.now() - t0), ok: r.ok, failed, undo };
}

// Permanent removal: messages in Trash, and the saved copy of a draft being discarded.
export async function deleteForever(ids) {
  checkIds(ids);
  const t0 = performance.now();
  await loadDrafts(ids.some(id => !draftOf.has(id)));
  const drafts = ids.filter(id => draftOf.has(id)), others = ids.filter(id => !draftOf.has(id));
  const ok = [], failed = [];
  for (const id of drafts) {
    try { await call("DELETE", `/drafts/${draftOf.get(id)}`, { units: 10 }); ok.push(id); knownDrafts.delete(draftOf.get(id)); draftOf.delete(id); }
    catch (e) { if (isGone(e)) ok.push(id); else failed.push(id); }
  }
  if (others.length) {
    for (let i = 0; i < others.length; i += 1000) {
      const part = others.slice(i, i + 1000);
      try { await call("POST", "/messages/batchDelete", { json: { ids: part }, units: 50 }); ok.push(...part); }
      catch (e) { if (!ok.length) throw e; failed.push(...others.slice(i)); break; }
    }
  }
  for (const id of ok) { labelsOf.delete(id); rowCache.delete(id); }
  if (!ok.length) throw new ApiError(`delete: all ${ids.length} failed`);
  return { ms: Math.round(performance.now() - t0), ok, failed };
}

// ---------- accounts ----------
export async function accounts() {
  const t0 = performance.now();
  const [p, s] = await Promise.all([profile(), call("GET", "/settings/sendAs").catch(() => ({ sendAs: [] }))]);
  let list = (s.sendAs || []).map(a => ({
    email: a.sendAsEmail, sendingName: a.displayName || "", isPrimary: !!a.isPrimary, isSending: a.verificationStatus !== "pending",
    type: a.isPrimary ? "PRIMARY" : "ALIAS", signature: a.signature || "", signatureActive: !!a.signature, replyToAddress: a.replyToAddress || "",
  }));
  if (!list.length) list = [{ email: p.emailAddress, sendingName: "", isPrimary: true, isSending: true, type: "PRIMARY", signature: "", signatureActive: false, replyToAddress: "" }];
  return { accounts: list, ms: Math.round(performance.now() - t0) };
}

// ---------- drafts, send ----------
const draftOf = new Map();         // message id -> draft id
const knownDrafts = new Set();     // draft ids seen, created or listed
let draftsLoadedAt = 0;
async function loadDrafts(force) {
  if (!force && Date.now() - draftsLoadedAt < 10000) return;
  draftsLoadedAt = Date.now();
  let token = null;
  const seen = new Map();
  do {
    const r = await call("GET", "/drafts", { query: { maxResults: PAGE_MAX, pageToken: token, fields: "drafts(id,message/id),nextPageToken" }, units: 5 });
    for (const d of r.drafts || []) if (d.message?.id) { seen.set(d.message.id, d.id); knownDrafts.add(d.id); }
    token = r.nextPageToken || null;
  } while (token);
  draftOf.clear();
  for (const [m, d] of seen) draftOf.set(m, d);
}

// What a reply needs from the original: its thread, and the headers that chain the reply to it.
const originals = new Map();
async function original(id) {
  if (originals.has(id)) return originals.get(id);
  const m = await call("GET", `/messages/${id}`, { query: { format: "metadata", metadataHeaders: ["Message-ID", "References", "Subject"], fields: "id,threadId,payload/headers" }, units: 5 });
  const h = headerMap(m.payload?.headers);
  const o = { threadId: m.threadId, messageId: messageIdOf(h["message-id"]), references: h.references || "", subject: h.subject || "" };
  originals.set(id, o);
  return o;
}
const bareSubject = s => String(s || "").replace(/^(\s*(re|fwd?|fw)\s*:)+/i, "").trim().toLowerCase();

// The raw message for d (see compose.js collect()), with forwarded attachments fetched and
// embedded, and the threading headers of the message it answers.
async function rawFor(d) {
  checkIds([...(d.inReplyTo ? [d.inReplyTo.id] : []), ...(d.refs || []).map(r => r.messageId)]);
  const orig = d.inReplyTo ? await original(d.inReplyTo.id) : null;
  const extra = await Promise.all((d.refs || []).map(async r => { const b = await partBytes(r.messageId, { partId: r.partId, filename: r.filename }); return { name: r.filename || b.filename || "attachment", type: b.type, bytes: b.bytes }; }));
  const raw = await build({
    from: d.from, replyTo: d.replyTo, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, html: d.html, text: d.text, inline: d.inline, files: d.files, extra,
    ...(orig ? replyHeaders(orig.messageId, orig.references) : {}),
  });
  const threadId = orig && bareSubject(orig.subject) === bareSubject(d.subject) ? orig.threadId : null;
  return { raw, threadId };
}

// The JSON of a draft names the thread inside its message; the JSON of messages.send is the
// message itself.
const threadOf = meta => meta.threadId ?? meta.message?.threadId;
function withoutThread({ threadId, ...meta }) { return meta.message ? { ...meta, message: withoutThread(meta.message) } : meta; }

// Uploads a draft or a send as multipart: the JSON part names the draft and thread, the second
// part is the message itself. A thread Gmail refuses (400) is tried once without.
async function upload(method, path, meta, raw, what) {
  const boundary = `rel_${crypto.randomUUID()}`;
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`;
  const body = new Blob([head, raw, `\r\n--${boundary}--\r\n`]);
  const timeout = TIMEOUTS.batch + Math.ceil(raw.length / 1048576) * TIMEOUTS.perMB;
  try {
    return await call(method, path, { query: { uploadType: "multipart" }, body, type: `multipart/related; boundary=${boundary}`, base: UPLOAD, timeout, units: 10, once: what === "send" });
  } catch (e) {
    if (e instanceof ApiError && e.detail?.status === 400 && threadOf(meta)) return upload(method, path, withoutThread(meta), raw, what);
    if (what === "send" && (e instanceof Timeout || e.detail?.status >= 500)) { e.mayHaveSent = true; e.message += "; it may still have been sent, so check Sent before sending it again"; }
    throw e;
  }
}

// Saves the message to Drafts: a new draft the first time, then the same draft again (its draft
// id is the csid the client keeps). The answer names no stored parts, so the client uploads the
// files again with every save, which keeps the draft whole.
export async function saveDraft(d) {
  const t0 = performance.now();
  const { raw, threadId } = await rawFor(d);
  const meta = { message: threadId ? { threadId } : {} };
  const id = knownDrafts.has(d.csid) ? d.csid : null;
  // a draft deleted or sent elsewhere (404) is saved as a new one
  const r = (id ? await upload("PUT", `/drafts/${id}`, { id, ...meta }, raw, "save").catch(e => { if (!isGone(e)) throw e; dropDraft(id); return null; }) : null)
    || await upload("POST", "/drafts", meta, raw, "save");
  knownDrafts.add(r.id);
  for (const [m, dr] of draftOf) if (dr === r.id) draftOf.delete(m);
  draftOf.set(r.message.id, r.id);
  labelsOf.set(r.message.id, r.message.labelIds || ["DRAFT"]);
  return { message: { id: r.message.id, csid: r.id, attachments: [] }, partial: false, ms: Math.round(performance.now() - t0) };
}

// Sends the message: the draft it was saved as, updated with what is sent now, or a message of
// its own. Gmail files the copy in Sent and removes the draft. The folder for sent mail is Gmail's
// own, so sentFolderId is not needed.
export async function send(d) {
  const t0 = performance.now();
  const { raw, threadId } = await rawFor(d);
  const meta = { message: threadId ? { threadId } : {} };
  const id = knownDrafts.has(d.csid) ? d.csid : null;
  // a draft deleted or sent elsewhere (404) leaves the message to be sent on its own; a send that
  // may have gone out is never sent again
  const r = (id ? await upload("POST", "/drafts/send", { id, ...meta }, raw, "send").catch(e => { if (!isGone(e) || e.mayHaveSent) throw e; return null; }) : null)
    || await upload("POST", "/messages/send", meta.message, raw, "send");
  if (id) dropDraft(id);
  return { message: { id: r.id, csid: d.csid }, ms: Math.round(performance.now() - t0) };
}
function dropDraft(id) {
  knownDrafts.delete(id);
  for (const [m, dr] of draftOf) if (dr === id) draftOf.delete(m);
}
