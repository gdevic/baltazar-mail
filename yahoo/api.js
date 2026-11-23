// Protocol adapter for Yahoo Mail's ws/v3 batch API. Every endpoint string and payload shape
// lives here; nothing else in the client knows the wire format. See docs/yahoo-api.md.
// The Gmail extension's adapter (gmail/api.js) has the same exports.

import { listParts, extract } from "./mime.js";
import { sniffImage, dataUrl } from "./bytes.js";
import { remember, failure, freshFailure, recent, RETRY_FAILED } from "./cache.js";
import { clean, fieldAtom } from "./query.js";
import { ApiError, TIMEOUTS, Timeout, deadlined, normalizeFolders, isMessageId, checkIds, refsFrom } from "./adapter.js";

export { ApiError, TIMEOUTS, Timeout, normalizeFolders, isMessageId };

const ORIGIN = "https://mail.yahoo.com";
const BATCH = ORIGIN + "/c/ws/v3/batch";
const JWS = "https://apis.mail.yahoo.com";
const LIST_FILTER = "-folderType:(SYNC)-folderType:(INVISIBLE)";
// Searches not limited to chosen folders skip Spam and Trash; searching inside those folders still reaches them.
const ALL_MAIL = "-folderType:(TRASH)-folderType:(BULK)";

// What the shared client shows and limits for this provider. title is the name the page shows,
// since the extension's own name stays plain Baltazar Mail (Yahoo's brand rules keep its marks out
// of an app name); name is used in sentences ("Yahoo could not be reached"); signIn fills the
// sign-in panel; trademark is the attribution Settings shows under the version.
export const PROVIDER = {
  id: "yahoo", name: "Yahoo", title: "Baltazar Mail for Yahoo™",
  signIn: { text: "No Yahoo Mail™ session found in this browser.", link: { href: "https://mail.yahoo.com/", label: "Sign in at mail.yahoo.com" }, button: "retry" },
  trademark: "Yahoo™ and Yahoo Mail™ are trademarks of Yahoo Inc. Baltazar Mail is not created by, affiliated with, or endorsed by Yahoo Inc.",
};
// Where the reader and the print page may load message images from: Yahoo's image proxy.
export const IMAGE_SRC = "https://*.yusercontent.com";
// The address a picture in a message comes from, as its sender wrote it, so that the client can
// tell a tracking picture by it (ext/pixels.js). Yahoo serves every remote picture through its
// image proxy, which carries that address in its url parameter: <host>.yusercontent.com/mail?url=.
// Any other address is its own.
export function imageOrigin(src) {
  try {
    const u = new URL(src), v = u.searchParams.get("url");
    if (u.protocol === "https:" && /\.yusercontent\.com$/.test(u.hostname) && u.pathname === "/mail" && /^https?:\/\//i.test(v || "")) return v;
  } catch { /* not an address */ }
  return src;
}
// messageBytes: attachments per message; scanMax: rows per folder a full address-book scan reads;
// scanGap: the pause (ms) between its steps. The first build reads the whole mailbox, a few
// hundred requests one after another, and Yahoo names no limit for them: the pause keeps the
// build to less than a request a second, the pace of someone paging through folders.
// fetchGap: the pause (ms) between the messages whose attachments go into one ZIP file, each a
// fetch of the message's whole source.
export const LIMITS = { messageBytes: 25 * 1048576, scanMax: Infinity, scanGap: 1000, fetchGap: 100 };

// An image still addressed to Yahoo's mail hosts (a part that could not be inlined) would show
// recipients the mailbox id and could not load for them anyway; outgoing mail and print drop it.
export function isStrayImage(src) {
  let host = ""; try { host = new URL(src).hostname; } catch { return false; }
  return /(^|\.)mail\.yahoo\.com$/i.test(host);
}

// Only address characters reach a query: quotes, parentheses and backslashes would end the term.
const bareAddress = email => String(email).replace(/["()\\\s]/g, "");
// Queries the client runs by name, as opaque strings for query(), search() and searchScoped().
// Starred spans every folder; search() adds the Spam and Trash exclusion.
export const queries = {
  starred: (unreadOnly = false) => `is:flagged ${LIST_FILTER}${unreadOnly ? " is:unread" : ""}`,
  unreadIn: folderId => `folderId:${folderId} is:unread`,
  // to: finds the address in To only and cc: in Cc; nothing finds it in a Bcc (verified 2026-11-20)
  person: email => { const e = bareAddress(email); return `(from:("${e}") OR to:("${e}") OR cc:("${e}"))`; },
  // mail with attachments, for a folder's list of attachments (searchScoped); its rows carry
  // each file's partId, size, type, links and objectId (verified 2026-11-20)
  files: () => "has:attachment",
};

// ---------- search terms ----------
// Yahoo atom for a term, or for its negation when Yahoo can negate it; null when it cannot.
// query.js compiles the user's search with this dialect (see there for the language).
const WORDS = { starred: "is:flagged", day: (op, d) => `${op}:${d}` };
function atom(term, neg = false) {
  const v = clean(term.value);
  switch (term.field) {
    case null: return neg ? null : (/[\s:]/.test(v) ? `keyword:"${v}"` : `keyword:${v}`);
    case "from": return neg ? null : `from:("${v}")`;
    case "to": return neg ? null : `to:("${v}")`;
    case "subject": return neg ? null : `subject:"${v}"`;
  }
  return fieldAtom(term, neg, WORDS);
}
export const dialect = { atom };

export class NotSignedIn extends Error {
  constructor() { super("Not signed in to Yahoo Mail"); this.name = "NotSignedIn"; }
}

// Every request has a deadline (TIMEOUTS), past which it fails as a Timeout.
const timed = deadlined("Yahoo");

let session = null;
async function forgetSession() { session = null; await chrome.storage.session.remove("ymSession"); }

// The JSON object literal that starts at the first "{" after marker, or null.
function objectAfter(text, marker) {
  const at = text.indexOf(marker); if (at < 0) return null;
  const start = text.indexOf("{", at); if (start < 0) return null;
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; }
    else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

// Session values from the mail.yahoo.com page: the top-level keys of its inline AppBootstrapData
// object, or, if that object does not parse as JSON, the first matches of each key in the page.
// null when the page has none (signed out: Yahoo's landing page).
export function parseBootstrap(html) {
  const data = objectAfter(html, "AppBootstrapData");
  let wssid = data?.mailWssid, appId = data?.appId, mailboxId = data?.primaryMailbox?.id, email = data?.primaryMailbox?.email;
  if (typeof wssid !== "string" || typeof appId !== "string" || typeof mailboxId !== "string") {
    wssid = html.match(/"mailWssid"\s*:\s*"([^"]+)"/)?.[1];
    appId = html.match(/"appId"\s*:\s*"([^"]+)"/)?.[1];
    mailboxId = html.match(/"primaryMailbox"\s*:\s*\{[^}]*?"id"\s*:\s*"([^"]+)"/)?.[1];
    email = html.match(/"primaryMailbox"\s*:\s*\{[^}]*?"email"\s*:\s*"([^"]+)"/)?.[1];
  }
  if (!wssid || !appId || !mailboxId) return null;
  return { wssid, appId, mailboxId, email: typeof email === "string" ? email : "" };
}

// Callers that ask at the same time share one fetch of the page (about 1.5 MB).
// A forced sign-in shares only a forced one, which reads no stored session.
let signingIn = null, signingInForced = false;
export async function bootstrap(force = false) {
  if (!force && session) return session;
  if (signingIn && (signingInForced || !force)) return signingIn;
  if (signingIn) await signingIn.catch(() => {});
  const p = readSession(force).finally(() => { if (signingIn === p) signingIn = null; });
  signingIn = p; signingInForced = force;
  return p;
}
// The sign-in panel's button: a fresh read of the session page.
export const signIn = () => bootstrap(true);
async function readSession(force) {
  if (!force) {
    const stored = (await chrome.storage.session.get("ymSession")).ymSession;
    if (stored && Date.now() - stored.at < 6 * 3600e3) return (session = stored);
  }
  const { body } = await timed("sign-in page", ORIGIN + "/", { credentials: "include", cache: "no-store" }, TIMEOUTS.page, r => r.text());
  const values = parseBootstrap(body);
  if (!values) throw new NotSignedIn();
  session = { ...values, at: Date.now() };
  await chrome.storage.session.set({ ymSession: session });
  return session;
}

const uuid = () => crypto.randomUUID();

// One batch envelope, one HTTP round trip. Returns the inner responses array. retry allows one
// fresh sign-in after a 401/403 or a session Yahoo refuses (EC-4008, EC-4003) and, separately,
// one retry after EP-4010 (header rule not ready).
async function batch(name, requests, retry = true, files = [], headers = {}) {
  return attempt(name, requests, files, headers, { auth: retry, rules: retry });
}
async function attempt(name, requests, files, headers, tries) {
  const s = await bootstrap();
  const fill = r => ({ payloadType: "embedded", ...r, uri: r.uri.replaceAll("<mb>", s.mailboxId), ...(r.requests ? { requests: r.requests.map(fill) } : {}) });
  const reqs = requests.map(fill);
  const fd = new FormData();
  fd.append("batchJson", JSON.stringify({ requests: reqs, responseType: "json" }));
  for (const f of files || []) fd.append(encodeURIComponent(f.name), f, f.name);
  const qs = new URLSearchParams({ name, appId: s.appId, wssid: s.wssid, ymreqid: uuid(), nonblocking: "true" });
  const t0 = performance.now();
  const bytes = (files || []).reduce((n, f) => n + (f.size || 0), 0);
  const { resp, body: text } = await timed(name, `${BATCH}?${qs}`, { method: "POST", body: fd, credentials: "include", headers },
    TIMEOUTS.batch + Math.ceil(bytes / 1048576) * TIMEOUTS.perMB, r => r.text());
  const ms = Math.round(performance.now() - t0);
  if ((resp.status === 401 || resp.status === 403) && tries.auth) {
    await forgetSession();
    await bootstrap(true);
    return attempt(name, requests, files, headers, { ...tries, auth: false });
  }
  let doc;
  try { doc = JSON.parse(text); } catch { throw new ApiError(`${name}: HTTP ${resp.status}, non-JSON response`, text.slice(0, 300)); }
  if (doc.error) {
    const code = doc.error.code || "";
    if (code === "EP-4010" && tries.rules) {
      // Origin rewrite rule not installed yet (worker still starting); ask it and retry once.
      await chrome.runtime.sendMessage({ type: "ensureRules" }).catch(() => {});
      return attempt(name, requests, files, headers, { ...tries, rules: false });
    }
    if (code === "EC-4008" || code === "EC-4003") {
      // The session went stale (EC-4008) or its wssid expired (EC-4003, a tab left open for
      // hours); one fresh sign-in. A second EC-4008 means signed out, a second EC-4003 is reported.
      await forgetSession();
      if (tries.auth) { await bootstrap(true); return attempt(name, requests, files, headers, { ...tries, auth: false }); }
      if (code === "EC-4008") throw new NotSignedIn();
    }
    throw new ApiError(`${name}: HTTP ${resp.status} ${JSON.stringify(doc.error).slice(0, 160)}`, doc.error);
  }
  const responses = doc.result?.responses || [];
  responses.ms = ms;
  return responses;
}

const q = s => `/ws/v3/mailboxes/@.id==<mb>/messages/@.select==q?q=${encodeURIComponent(s)}`;
function first(r) {
  const x = r[0];
  const code = x?.httpCode ?? 0;
  if (!x || code < 200 || code >= 300 || !x.response?.result) throw new ApiError(`inner request failed (HTTP ${code || "?"})`, x);
  return x.response.result;
}

// Yahoo's answer for a message that no longer exists (removed elsewhere, or already deleted).
export const isGone = e => e instanceof ApiError && (e.detail?.httpCode === 404 || e.detail?.response?.error?.code === "EC-4007");

// The folder list is the first call after start-up; an inner sign-in refusal (a session that
// went stale for this mailbox) gets one fresh sign-in.
export async function folders(retry = true) {
  const r = await batch("mailbox.sync", [{ id: "GetFolders", uri: "/ws/v3/mailboxes/@.id==<mb>/folders", method: "GET" }]);
  const code = r[0]?.httpCode ?? 0;
  if (retry && (code === 401 || code === 403)) { await forgetSession(); await bootstrap(true); return folders(false); }
  const res = first(r);
  return { folders: normalizeFolders(res.folders), ms: r.ms };
}

export async function list(folderId, count = 100, offset = 0) {
  const r = await batch("messageGroups.getList", [{
    id: "GetMessageGroupList", method: "GET",
    uri: q(`folderId:${folderId} ${LIST_FILTER} count:${count} offset:${offset} -sort:date`),
  }]);
  return { messages: first(r).messages || [], ms: r.ms };
}

// Every message outside Spam and Trash, newest first, whatever folder it is in, but for the
// folders named in exclude: what the address book's first build reads after Sent and Inbox. It
// pages to the end of 8,526 messages in 203 folders, 100 rows in about 400 ms, and the folders'
// totals add up to exactly that many rows (verified 2026-11-20).
const LISTED_NOWHERE = ["TRASH", "BULK", "SYNC", "INVISIBLE"];
export async function listAll(count = 100, offset = 0, { exclude = [] } = {}) {
  exclude.forEach(checkFolder);
  const r = await batch("messageGroups.getList", [{
    id: "GetMessageGroupList", method: "GET",
    uri: q(`${[ALL_MAIL, LIST_FILTER, ...exclude.map(id => `-folderId:${id}`)].join(" ")} count:${count} offset:${offset} -sort:date`),
  }]);
  return { messages: first(r).messages || [], ms: r.ms };
}
// How many messages listAll has to list, told from the folder list.
export const countAll = (folders, exclude = []) => folders.filter(f => !f.types.some(t => LISTED_NOWHERE.includes(t)) && !exclude.map(String).includes(String(f.id))).reduce((n, f) => n + (f.total || 0), 0);

// A query in Yahoo's search language (queries.*, or one query.js wrote), over all mail outside
// Spam and Trash.
export async function search(qs, count = 100, offset = 0) {
  const r = await batch("messageGroups.getList", [{ id: "GetMessageGroupList", method: "GET", uri: q(`${ALL_MAIL} count:${count} offset:${offset} -sort:date ${qs}`) }]);
  return { messages: first(r).messages || [], ms: r.ms };
}

// The conversation of a message: every message Yahoo gives the same conversation id, in every
// folder but Spam and Trash and the hidden ones, the newest CONVERSATION_MAX of them in one search
// (verified 2026-11-22: all 19 messages of a conversation in one request, about 200 ms). The id
// goes into the query, so it must be the digits Yahoo writes; a message without one names no
// conversation.
const CONVERSATION_ID = /^[0-9]{1,32}$/, CONVERSATION_MAX = 300;
export async function conversation(m) {
  const id = m?.conversationId;
  if (id == null || id === "") return { messages: [], ms: 0, complete: true };
  if (!CONVERSATION_ID.test(String(id))) throw new ApiError(`refusing malformed conversation id ${JSON.stringify(String(id).slice(0, 40))}`);
  const r = await search(`conversationId:${id} ${LIST_FILTER}`, CONVERSATION_MAX);
  return { messages: r.messages, ms: r.ms, complete: true };
}
// What a message names of its conversation (see refsFrom), from the headers Yahoo gives every row.
export const refsOf = m => refsFrom(m?.headers?.messageIdRfc822, m?.headers?.inReplyTo, m?.headers?.referenceList);

export async function body(msgId) {
  checkIds([msgId]);
  const r = await batch("messages.getBody", [{
    id: "GetSimpleBody_0", method: "GET",
    uri: `/ws/v3/mailboxes/@.id==<mb>/messages/@.id==${msgId}/content/simplebody/full`,
  }]);
  const res = first(r);
  if (!res?.message) throw new ApiError("body: message not returned", r[0]);
  // Attachment metadata lives on the message; simpleBody carries it only for some messages.
  const attachments = res.message.attachments?.length ? res.message.attachments : (res.simpleBody?.attachments || []);
  return { message: res.message, html: res.simpleBody?.html || "", text: typeof res.simpleBody?.text === "string" ? res.simpleBody.text : "", attachments, ms: r.ms };
}

// Full RFC 822 source. Yahoo's attachment download links cannot be fetched, so attachment
// bytes are cut out of this (see mime.js).
export async function rawMessage(msgId, retry = true) {
  checkIds([msgId]);
  const s = await bootstrap();
  const qs = new URLSearchParams({ appId: s.appId, wssid: s.wssid, ymreqid: uuid() });
  const { resp, body } = await timed("message source", `${JWS}/ws/v3/mailboxes/@.id==${s.mailboxId}/messages/@.id==${msgId}/content/rawplaintext?${qs}`,
    { credentials: "include" }, TIMEOUTS.raw, r => r.arrayBuffer());
  if ((resp.status === 401 || resp.status === 403) && retry) {
    await forgetSession();
    await bootstrap(true);
    return rawMessage(msgId, false);
  }
  if (!resp.ok) throw new ApiError(`rawMessage: HTTP ${resp.status}`, new TextDecoder().decode(new Uint8Array(body).slice(0, 300)));
  return new Uint8Array(body);
}

// ---------- attachment bytes, thumbnails, inline images ----------
// Attachment bytes are cut out of the message's raw source: one fetch per message, shared by its
// attachments and by the inline images Yahoo cannot render. The three newest sources stay parsed.
const rawCache = new Map();      // msgId -> Promise<parsed MIME>
function parsedMessage(id) {
  if (!rawCache.has(id)) {
    rawCache.set(id, rawMessage(id).then(listParts));
    while (rawCache.size > 3) rawCache.delete(rawCache.keys().next().value);
  }
  const p = rawCache.get(id);
  p.catch(() => rawCache.delete(id));
  return p;
}
// { bytes, type, filename } of one attachment of a message, by its part id and name.
export async function partBytes(msgId, a) {
  return extract(await parsedMessage(msgId), a.partId, a.filename);
}

// Yahoo's download link, for the browser to follow when the bytes could not be fetched here.
export const originalUrl = a => /^https:\/\//i.test(a?.downloadUrl || "") ? a.downloadUrl.replace(/&amp;/g, "&") : null;
// The strip lists the attachments that have that link: without it, one whose bytes are not in
// the message source could be neither previewed nor downloaded.
export const isListed = a => !!originalUrl(a);

// Yahoo's text extraction of an attachment, for formats with no renderer and no converter page.
export async function extractText(a) {
  if (!a.textExtractionUrl) throw new Error("no text extraction available");
  const resp = await fetch(a.textExtractionUrl.replace(/&amp;/g, "&"), { credentials: "include", signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const j = await resp.json();
  const t = j?.result?.textExtractResult;
  if (typeof t !== "string") throw new Error("no text in response");
  return t;
}

// A thumbnail of an image attachment as a data: URL, or null. Yahoo renders them server-side
// behind the session cookies, so the page fetches them; a failure is tried again after a minute.
const thumbCache = new Map();
export async function thumbnail(msgId, a) {
  const key = a.thumbnailUrl;
  if (!key) return null;
  if (thumbCache.has(key)) return thumbCache.get(key);
  let url = key.replace(/&amp;/g, "&");
  if (!/[?&]size=/.test(url)) url += (url.includes("?") ? "&" : "?") + "size=240w";
  const p = (async () => {
    try {
      const resp = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(30000) });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (!/^image\//.test(blob.type)) return null;
      return await dataUrl(blob);
    } catch { return null; }
  })();
  remember(thumbCache, key, p);
  p.then(v => { if (v === null) setTimeout(() => { if (thumbCache.get(key) === p) thumbCache.delete(key); }, RETRY_FAILED); });
  return p;
}

// Inline images (cid parts) are thumbnails of message parts in this mailbox, served by
// cloud-apis.mail.yahoo.com with the session cookies, which the sandboxed frame cannot send. They
// are fetched here and handed to the frame as data: URLs. Only real <img> sources with exactly that
// address shape in the user's own mailbox are fetched, and only image responses are kept, so a
// message cannot make the extension request any other Yahoo address with the user's session.
// Image caches keep the newest entries up to a limit, so a long session does not hold every image
// it ever showed, and a failure is remembered for a minute, then tried again.
const PART_PATH = /^\/ws\/v3\/mailboxes\/@\.id==([A-Za-z0-9_-]+)\/messages\/@\.id==([A-Za-z0-9_-]+)\/content\/parts\/@\.id==([0-9.]+)\/thumbnail(?:&[A-Za-z0-9_.~%=-]+)*$/;
function partUrl(u) {
  try {
    const url = new URL(u);
    const m = url.pathname.match(PART_PATH);
    if (!(url.protocol === "https:" && url.host === "cloud-apis.mail.yahoo.com" && !url.username && !url.password && m && /^(\?[A-Za-z0-9_.~%=&-]*)?$/.test(url.search) && !url.hash)) return null;
    return { mailboxId: m[1], msgId: m[2], partId: m[3] };
  } catch { return null; }
}
const ownIds = body => [body?.message?.id, body?.message?.immutableid].filter(Boolean).map(String);
// Whether an image source is an inline part reference of the message of a body() result (the
// client asks inlineSource only for these, and counts only these towards its limit per message).
export const isInlineRef = (src, body) => { const ref = partUrl(src); return !!ref && ownIds(body).includes(ref.msgId); };

const partCache = new Map();       // url -> data: URL, or failure()
const fromSource = new Map();      // url -> time it was last tried from the source
const RAW_FALLBACK_MAX = 10 << 20;
// One inline image of a body() result as a data: URL, or null when it is not a part of that
// message or could not be fetched. Yahoo cannot render some parts (a malformed type such as
// "image/jpeg;base64" gives EP-5001); those are cut out of the message's own source, as
// attachments are, and the format comes from the bytes, so anything that is not an image is dropped.
export async function inlineSource(src, body) {
  const message = body?.message;
  const ref = partUrl(src);
  if (!ref || ref.mailboxId !== (await bootstrap()).mailboxId || !ownIds(body).includes(ref.msgId)) return null;
  const c = partCache.get(src);
  if (typeof c === "string") return c;
  if (!freshFailure(c)) {
    try {
      const resp = await fetch(src, { credentials: "include", signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error(resp.status);
      const blob = await resp.blob();
      if (!/^image\/(png|jpeg|gif|webp|bmp|avif)$/i.test(blob.type)) throw new Error(blob.type || "untyped");
      const d = await dataUrl(blob);
      remember(partCache, src, d);
      return d;
    } catch { remember(partCache, src, failure()); }
  }
  if (recent(fromSource.get(src))) return null;
  remember(fromSource, src, Date.now());
  const size = message?.size || 0;
  if (!size || size > RAW_FALLBACK_MAX) return null;
  try {
    const { bytes } = extract(await parsedMessage(ref.msgId), ref.partId), type = sniffImage(bytes);
    if (!type) return null;
    const d = await dataUrl(new Blob([bytes], { type }));
    remember(partCache, src, d);
    return d;
  } catch { return null; }
}

// Yahoo's document converter, for formats with no renderer here. PDF pages come back as JPEG
// images, Office documents as HTML plus CSS, spreadsheets one sheet per page. Pages are 1-based.
// code 800 is success; a page with statuscode 700 is ready. A file the converter does not take
// is refused with code 813, or with HTTP 400 to the request (a winmail.dat, seen 2026-11-22),
// which is answered as 813 too.
export async function docPages(documentId, start, end, retryCount = 0) {
  const r = await batch("document.fetch", [{
    id: "FetchDocument", method: "POST", uri: "/ws/docpreview/v2/fetch",
    payload: { start_page: start, end_page: end, retryCount },
  }], true, [], { "docs-document-id": documentId });
  const x = r[0];
  if (x?.httpCode === 400) return { code: 813, total: 0, width: 0, height: 0, pages: [] };
  if (!x || x.httpCode < 200 || x.httpCode >= 300 || !x.response) throw new ApiError(`document.fetch: HTTP ${x?.httpCode ?? "?"}`, x);
  const res = x.response;
  const pages = Object.entries(res.pages || {})
    .map(([k, p]) => ({ n: Number(k.replace(/\D/g, "")), html: p.html || "", css: p.css || "", ok: p.statuscode === 700 }))
    .sort((p, q) => p.n - q.n);
  return { code: res.code, total: res.info?.num_pages || 0, width: res.info?.dimension?.w || 0, height: res.info?.dimension?.h || 0, pages };
}

// ---------- mutations ----------
// Each id gets its own inner request, as the web client does; one HTTP round trip for all of them.
// Returns the ids that succeeded and those that failed; throws only if nothing succeeded.
async function perMessage(name, ids, make) {
  checkIds(ids);
  const reqs = ids.map((id, i) => make(id, i));
  const r = await batch(name, reqs);
  const byReqId = new Map(r.map(x => [x.id, x]));
  const ok = [], failed = [];
  reqs.forEach((req, i) => { const code = byReqId.get(req.id)?.httpCode ?? 0; (code >= 200 && code < 300 ? ok : failed).push(ids[i]); });
  if (!ok.length) throw new ApiError(`${name}: all ${ids.length} failed (HTTP ${r[0]?.httpCode ?? "?"})`, r);
  return { ms: r.ms, ok, failed };
}

const update = (name, ids, payload) => perMessage(name, ids, (id, i) => ({
  id: `UnifiedUpdateMessage_${i}`, method: "POST", uri: q(`id:(${id})`), payload,
}));

export function setRead(ids, read) { return update("messages.readFlagUpdate", ids, { message: { flags: { read } } }); }
export function setStarred(ids, flagged) { return update("messages.starFlagUpdate", ids, { message: { flags: { flagged } } }); }
// The scope of a search, as Yahoo's search language writes it: within include or outside exclude,
// each { ids: [folderId...] } for a folder and its subfolders, or { starred: true }. Yahoo accepts
// folderId:(a OR b) for a set; for exclusion only one -folderId: term per folder works.
export function scopeFilter({ include = null, exclude = null } = {}) {
  const parts = include?.ids?.length ? [] : [ALL_MAIL];
  if (include?.starred) parts.push("is:flagged");
  else if (include?.ids?.length) parts.push(include.ids.length === 1 ? `folderId:${include.ids[0]}` : `folderId:(${include.ids.join(" OR ")})`);
  if (exclude?.starred) parts.push("-is:flagged");
  else if (exclude?.ids?.length) parts.push(exclude.ids.map(id => `-folderId:${id}`).join(" "));
  return parts.join(" ");
}

// A query as for search(), within a scope or outside it (see scopeFilter).
export function searchScoped(qs, { include = null, exclude = null } = {}, count = 100, offset = 0) {
  return query(`${scopeFilter({ include, exclude })} ${qs}`, count, offset);
}

// One Yahoo query in its own search language (see query.js for what it can express).
export async function query(qs, count = 100, offset = 0) {
  const r = await batch("messageGroups.getList", [{ id: "GetMessageGroupList", method: "GET", uri: q(`count:${count} offset:${offset} -sort:date ${qs}`) }]);
  return { messages: first(r).messages || [], ms: r.ms };
}


export function move(ids, folderId) { return update("messages.move", ids, { message: { folder: { id: String(folderId) } } }); }

// Permanent removal: messages already in Trash, and the saved copy of a draft being discarded.
export function deleteForever(ids) {
  return perMessage("messages.delete", ids, (id, i) => ({ id: `UnifiedDeleteMessage_${i}`, method: "DELETE", uri: q(`id:(${id})`) }));
}

// ---------- folders ----------
// A folder's name is its whole path ("Projects/FPGA", "Inbox/Receipts"); creating, renaming and
// moving all set it (verified 2026-11-02, as are deleting and emptying).
const FOLDER_ID = /^[0-9]{1,12}$/, ACCT_ID = /^[0-9]{1,6}$/, TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
function checkFolder(id) { if (!FOLDER_ID.test(String(id))) throw new ApiError(`refusing malformed folder id ${JSON.stringify(String(id).slice(0, 20))}`); }
async function one(name, req) {
  const r = await batch(name, [req]);
  const x = r.find(y => y.id === req.id) || r[0], code = x?.httpCode ?? 0;
  if (code < 200 || code >= 300) throw new ApiError(`${name}: HTTP ${code} ${JSON.stringify(x?.response?.error || "").slice(0, 120)}`, x);
  return { result: x.response?.result, ms: r.ms };
}
const FOLDERS = "/ws/v3/mailboxes/@.id==<mb>/folders";
export function createFolder(name, acctId = "1") {
  if (!ACCT_ID.test(String(acctId))) throw new ApiError("refusing malformed account id");
  return one("folders.create", { id: "CreateFolders", method: "PUT", uri: FOLDERS, payloadType: "embedded", payload: { folder: { types: ["USER"], acctId: String(acctId), name } } });
}
// Renaming and moving are one call: the folder gets its new path.
export function renameFolder(id, name) {
  checkFolder(id);
  return one("folders.rename", { id: `RenameFolders00_${id}`, method: "POST", uri: `${FOLDERS}/${id}`, payloadType: "embedded", payload: { folder: { name } } });
}
// Deleting a folder that is already gone answers EC-4001; the caller checks the folder list.
export function deleteFolder(id) {
  checkFolder(id);
  return one("folders.delete", { id: "DeleteFolders", method: "DELETE", uri: `${FOLDERS}/@.id==${id}` });
}
// Every message in a folder, permanently deleted: a background task, like marking a folder read.
export async function emptyFolder(id, total, acctId = "1") {
  checkFolder(id);
  if (!ACCT_ID.test(String(acctId))) throw new ApiError("refusing malformed account id");
  const n = Math.max(1, Math.min(1000000, Number(total) || 0));
  const r = await one("messages.delete", { id: "UnifiedDeleteMessage_0", method: "DELETE", uri: `${q(`folderId:${id} count:${n} acctId:${acctId}`)}&async=true` });
  await follow(r.result?.task, "emptying the folder");
  return r;
}
// Follows a background task until Yahoo reports it done.
// Returns the finished task, whose completed field counts the messages it changed.
async function follow(task, what) {
  if (!task || task.status === "COMPLETED") return task || null;
  if (!TASK_ID.test(String(task.id))) throw new ApiError("unexpected task id");
  for (let i = 0; i < 60; i++) {
    await new Promise(ok => setTimeout(ok, i < 5 ? 1000 : 3000));
    const s = (await one("task.status", { id: "TaskStatus", method: "GET", uri: `/ws/v3/mailboxes/@.id==<mb>/tasks/@.id==${task.id}` })).result?.task;
    if (s?.status === "COMPLETED") return s;
    if (s?.status === "FAILED") throw new ApiError(`Yahoo could not finish ${what}`);
  }
  throw new ApiError(`${what} is taking too long; Yahoo is still working on it`);
}
// Marking a folder read is a background task on Yahoo's side (HTTP 202 and a task id), followed
// until it completes, as Yahoo's client does. changed: how many messages the task reports having
// changed, or null when there was no task to follow.
export async function markFolderRead(id, unread, acctId = "1") {
  checkFolder(id);
  if (!ACCT_ID.test(String(acctId))) throw new ApiError("refusing malformed account id");
  const n = Math.max(1, Math.min(100000, Number(unread) || 0));
  const r = await one("messages.readFlagUpdate", { id: "UnifiedUpdateMessage_0", method: "POST", uri: `${q(`folderId:${id} count:${n} offset:0 is:unread acctId:${acctId}`)}&async=true`, payloadType: "embedded", payload: { message: { flags: { read: true } } } });
  const task = await follow(r.result?.task, "marking the folder read");
  return { ...r, changed: task ? (Number(task.completed) || 0) : null };
}

// ---------- accounts, drafts, send ----------
export async function accounts() {
  const r = await batch("accounts.get", [{ id: "GetAccounts", uri: "/ws/v3/mailboxes/@.id==<mb>/accounts", method: "GET" }]);
  return { accounts: first(r).accounts || [], ms: r.ms };
}

// Build the SaveMessage inner request. draft: { csid, from, replyTo, to, cc, bcc, subject, html, text,
// inReplyTo: { id, replied, forwarded } | null, files: File[], draftFolderId }.
// d.files: File[] (plain attachments) and d.inline: [{ file, contentId }] for images referenced as cid: in the HTML.
export function saveRequest(d) {
  checkIds([...(d.inReplyTo ? [d.inReplyTo.id] : []), ...(d.refs || []).map(r => r.messageId)]);
  const inline = d.inline || [];
  const files = (d.files || []).concat(inline.map(i => i.file));
  // d.refs: attachments of another message, copied server-side: [{ messageId, partId, contentId }]
  const attachments = (d.files || []).map(f => ({ disposition: "attachment", multipartName: `multipart://${encodeURIComponent(f.name)}` }))
    .concat(inline.map(i => ({ disposition: "inline", contentId: i.contentId, multipartName: `multipart://${encodeURIComponent(i.file.name)}` })))
    .concat((d.refs || []).map(r => ({ disposition: "attachment", ...(r.contentId ? { contentId: r.contentId } : {}), messageReference: { id: r.messageId, pid: r.partId } })));
  const message = {
    csid: d.csid, newMessage: !d.inReplyTo,
    headers: { subject: d.subject || "", from: [d.from], replyTo: [d.replyTo || d.from], to: d.to || [], cc: d.cc || [], bcc: d.bcc || [] },
    folder: { id: String(d.draftFolderId) }, flags: { spam: "false", read: "true" }, attachments,
  };
  if (d.inReplyTo) message.inReplyTo = { messageReference: { id: d.inReplyTo.id }, replied: !!d.inReplyTo.replied, forwarded: !!d.inReplyTo.forwarded };
  const simpleBody = d.html != null ? { html: d.html } : { text: d.text || "" };
  return {
    id: "SaveMessage", method: "POST", payloadType: "multipart",
    uri: `/ws/v3/mailboxes/@.id==<mb>/messages?uploadCount=${files.length}&totalAttachments=${attachments.length}`,
    payloadParts: [
      { partName: "jsonString", contentType: "application/json", payload: { actions: { responseMessage: true }, message, simpleBody } },
      ...files.map(f => ({ contentType: f.type || "application/octet-stream", partName: encodeURIComponent(f.name), payloadReference: `multipart://${encodeURIComponent(f.name)}` })),
    ],
  };
}

function saveResult(r) {
  const x = r.find(x => x.id === "SaveMessage");
  const code = x?.httpCode ?? 0;
  if (code < 200 || code >= 300) throw new ApiError(`save: HTTP ${code} ${JSON.stringify(x?.response?.error || "").slice(0, 120)}`, x);
  // 206: saved, but some parts referenced from other messages were dropped
  return { message: x.response?.result?.message || null, partial: code === 206 };
}

const allFiles = d => (d.files || []).concat((d.inline || []).map(i => i.file));

export async function saveDraft(d) {
  const r = await batch("messages.saveV3", [saveRequest(d)], true, allFiles(d));
  return { ...saveResult(r), ms: r.ms };
}

export async function send(d, sentFolderId) {
  const req = saveRequest(d);
  req.filters = { select: { messageId: "$..message.immutableid", csid: "$..message.csid", cid: "$..message.conversationId" } };
  const sendReq = {
    id: "SendMessage", method: "POST", uri: "/ws/v3/mailboxes/@.id==<mb>/messages/@.id==$(messageId)/send",
    payload: { csid: "$(csid)", destinationFolder: { id: String(sentFolderId) } }, requests: [],
  };
  if (d.inReplyTo && (d.inReplyTo.replied || d.inReplyTo.forwarded)) sendReq.requests.push({
    id: "UpdateMessages", method: "POST", uri: q(`id:(${d.inReplyTo.id})`),
    payload: { message: { flags: { answered: !!d.inReplyTo.replied, forwarded: !!d.inReplyTo.forwarded } } },
  });
  req.requests = [
    { id: "GetSimpleBody", method: "GET", uri: "/ws/v3/mailboxes/@.id==<mb>/messages/@.id==$(messageId)/content/simplebody/full" },
    sendReq,
  ];
  let r;
  try { r = await batch("messages.saveAndSend", [req], true, allFiles(d)); }
  catch (e) { if (e instanceof Timeout) e.message += "; it may still have been sent, so check Sent before sending it again"; throw e; }
  const { message } = saveResult(r);
  const sent = r.find(x => x.id === "SendMessage");
  const code = sent?.httpCode ?? 0;
  if (code < 200 || code >= 300) {
    // The message was saved to Drafts before the send failed; the composer keeps track of that copy.
    const e = new ApiError(`send: HTTP ${code} ${JSON.stringify(sent?.response?.error || "").slice(0, 120)}`, sent);
    e.savedId = message?.id || null;
    throw e;
  }
  return { message, ms: r.ms };
}
