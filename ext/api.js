// Protocol adapter for Yahoo Mail's ws/v3 batch API. Every endpoint string and payload shape
// lives here; nothing else in the client knows the wire format. See yahoo-v3.md.

const ORIGIN = "https://mail.yahoo.com";
const BATCH = ORIGIN + "/c/ws/v3/batch";
const JWS = "https://apis.mail.yahoo.com";
const LIST_FILTER = "-folderType:(SYNC)-folderType:(INVISIBLE)";
// Searches not limited to chosen folders skip Spam and Trash; searching inside those folders still reaches them.
const ALL_MAIL = "-folderType:(TRASH)-folderType:(BULK)";

export class NotSignedIn extends Error {
  constructor() { super("Not signed in to Yahoo Mail"); this.name = "NotSignedIn"; }
}

export class ApiError extends Error {
  constructor(msg, detail) { super(msg); this.name = "ApiError"; this.detail = detail; }
}

// Every request has a deadline, so a stalled connection ends in an error instead of waiting
// forever. Uploads get extra time per megabyte sent.
export const TIMEOUTS = { page: 30000, batch: 60000, perMB: 10000, raw: 120000 };
export class Timeout extends Error {
  constructor(what, ms) { super(`Yahoo did not answer within ${Math.round(ms / 1000)} s (${what})`); this.name = "Timeout"; }
}
// fetch plus reading the body, both inside the deadline. read(resp) returns the body.
async function timed(what, url, init, ms, read) {
  const signal = AbortSignal.timeout(ms);
  try {
    const resp = await fetch(url, { ...init, signal });
    return { resp, body: await read(resp) };
  } catch (e) { throw signal.aborted && e.name === "TimeoutError" ? new Timeout(what, ms) : e; }
}

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
  const p = signIn(force).finally(() => { if (signingIn === p) signingIn = null; });
  signingIn = p; signingInForced = force;
  return p;
}
async function signIn(force) {
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
// fresh sign-in after a 401/403 and, separately, one retry after EP-4010 (header rule not ready).
export async function batch(name, requests, retry = true, files = [], headers = {}) {
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
    if (code === "EC-4008") {
      // The session went stale; one fresh sign-in, and only a second refusal means signed out.
      await forgetSession();
      if (tries.auth) { await bootstrap(true); return attempt(name, requests, files, headers, { ...tries, auth: false }); }
      throw new NotSignedIn();
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

// Every folder with a string id, a name and a types list, whatever shape Yahoo sent.
export function normalizeFolders(list) {
  return (Array.isArray(list) ? list : []).filter(f => f && f.id != null).map(f => ({
    ...f, id: String(f.id), name: typeof f.name === "string" && f.name ? f.name : `Folder ${f.id}`,
    types: Array.isArray(f.types) ? f.types.filter(t => typeof t === "string") : [],
  }));
}

// The folder list is the first call after start-up; an inner sign-in refusal (a session that
// went stale for this mailbox) gets one fresh sign-in.
export async function folders(retry = true) {
  const r = await batch("mailbox.sync", [{ id: "GetFolders", uri: "/ws/v3/mailboxes/@.id==<mb>/folders", method: "GET" }]);
  const code = r[0]?.httpCode ?? 0;
  if (retry && (code === 401 || code === 403)) { await forgetSession(); await bootstrap(true); return folders(false); }
  const res = first(r);
  return { folders: normalizeFolders(res.folders), accounts: res.accounts || [], ms: r.ms };
}

export async function list(folderId, count = 100, offset = 0) {
  const r = await batch("messageGroups.getList", [{
    id: "GetMessageGroupList", method: "GET",
    uri: q(`folderId:${folderId} ${LIST_FILTER} count:${count} offset:${offset} -sort:date`),
  }]);
  const res = first(r);
  return { messages: res.messages || [], query: res.query, ms: r.ms };
}

// raw: term is already in Yahoo's query language (from:(..) OR to:(..)); otherwise a keyword search.
export async function search(term, folderId = null, count = 100, offset = 0, raw = false) {
  const scope = folderId ? `folderId:${folderId} ` : `${ALL_MAIL} `;
  if (raw) {
    const r = await batch("messageGroups.getList", [{ id: "GetMessageGroupList", method: "GET", uri: q(`${scope}count:${count} offset:${offset} -sort:date ${term}`) }]);
    const res = first(r);
    return { messages: res.messages || [], query: res.query, ms: r.ms };
  }
  const r = await batch("messageGroups.getList", [{
    id: "GetMessageGroupList", method: "GET",
    uri: q(`${scope}count:${count} offset:${offset} -sort:date keyword:${term}`),
  }]);
  const res = first(r);
  return { messages: res.messages || [], query: res.query, ms: r.ms };
}

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
  return { message: res.message, html: res.simpleBody?.html || "", attachments, ms: r.ms };
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

// Yahoo's document converter, for formats with no renderer here. PDF pages come back as JPEG
// images, Office documents as HTML plus CSS, spreadsheets one sheet per page. Pages are 1-based.
// code 800 is success; a page with statuscode 700 is ready.
export async function docPages(documentId, start, end, retryCount = 0) {
  const r = await batch("document.fetch", [{
    id: "FetchDocument", method: "POST", uri: "/ws/docpreview/v2/fetch",
    payload: { start_page: start, end_page: end, retryCount },
  }], true, [], { "docs-document-id": documentId });
  const x = r[0];
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
// Message ids end up inside Yahoo query strings and URIs; anything but Yahoo's id alphabet is refused.
const MSG_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isMessageId = id => (typeof id === "string" || typeof id === "number") && MSG_ID.test(String(id));
function checkIds(ids) {
  const bad = ids.find(id => !isMessageId(id));
  if (bad !== undefined) throw new ApiError(`refusing malformed message id ${JSON.stringify(String(bad).slice(0, 40))}`);
}

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
// Search limited to a scope or to everything outside it. scope: { ids: [folderId...] } for a
// folder and its subfolders, or { starred: true }. Yahoo accepts folderId:(a OR b) for a set;
// for exclusion only one -folderId: term per folder works.
export function scopeFilter({ include = null, exclude = null } = {}) {
  const parts = include?.ids?.length ? [] : [ALL_MAIL];
  if (include?.starred) parts.push("is:flagged");
  else if (include?.ids?.length) parts.push(include.ids.length === 1 ? `folderId:${include.ids[0]}` : `folderId:(${include.ids.join(" OR ")})`);
  if (exclude?.starred) parts.push("-is:flagged");
  else if (exclude?.ids?.length) parts.push(exclude.ids.map(id => `-folderId:${id}`).join(" "));
  return parts.join(" ");
}

export async function searchScoped(term, { raw = null, include = null, exclude = null } = {}, count = 100, offset = 0) {
  return query([scopeFilter({ include, exclude }), raw || `keyword:${term}`].filter(Boolean).join(" "), count, offset);
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
