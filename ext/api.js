// Protocol adapter for Yahoo Mail's ws/v3 batch API. Every endpoint string and payload shape
// lives here; nothing else in the client knows the wire format. See yahoo-v3.md.

const ORIGIN = "https://mail.yahoo.com";
const BATCH = ORIGIN + "/c/ws/v3/batch";
const JWS = "https://apis.mail.yahoo.com";
const LIST_FILTER = "-folderType:(SYNC)-folderType:(INVISIBLE)";

export class NotSignedIn extends Error {
  constructor() { super("Not signed in to Yahoo Mail"); this.name = "NotSignedIn"; }
}

export class ApiError extends Error {
  constructor(msg, detail) { super(msg); this.name = "ApiError"; this.detail = detail; }
}

let session = null;

// Session values come from the inline AppBootstrapData object in the mail.yahoo.com page.
export async function bootstrap(force = false) {
  if (!force && session) return session;
  if (!force) {
    const stored = (await chrome.storage.session.get("ymSession")).ymSession;
    if (stored && Date.now() - stored.at < 6 * 3600e3) return (session = stored);
  }
  const resp = await fetch(ORIGIN + "/", { credentials: "include", cache: "no-store" });
  const html = await resp.text();
  const wssid = html.match(/"mailWssid"\s*:\s*"([^"]+)"/);
  const appId = html.match(/"appId"\s*:\s*"([^"]+)"/);
  const mailbox = html.match(/"primaryMailbox"\s*:\s*\{[^}]*?"id"\s*:\s*"([^"]+)"/);
  const email = html.match(/"primaryMailbox"\s*:\s*\{[^}]*?"email"\s*:\s*"([^"]+)"/);
  if (!wssid || !appId || !mailbox) throw new NotSignedIn();
  session = { wssid: wssid[1], appId: appId[1], mailboxId: mailbox[1], email: email ? email[1] : "", at: Date.now() };
  await chrome.storage.session.set({ ymSession: session });
  return session;
}

const uuid = () => crypto.randomUUID();

// One batch envelope, one HTTP round trip. Returns the inner responses array.
export async function batch(name, requests, retry = true, files = [], headers = {}) {
  const s = await bootstrap();
  const fill = r => ({ payloadType: "embedded", ...r, uri: r.uri.replaceAll("<mb>", s.mailboxId), ...(r.requests ? { requests: r.requests.map(fill) } : {}) });
  const reqs = requests.map(fill);
  const fd = new FormData();
  fd.append("batchJson", JSON.stringify({ requests: reqs, responseType: "json" }));
  for (const f of files || []) fd.append(encodeURIComponent(f.name), f, f.name);
  const qs = new URLSearchParams({ name, appId: s.appId, wssid: s.wssid, ymreqid: uuid(), nonblocking: "true" });
  const t0 = performance.now();
  const resp = await fetch(`${BATCH}?${qs}`, { method: "POST", body: fd, credentials: "include", headers });
  const ms = Math.round(performance.now() - t0);
  if ((resp.status === 401 || resp.status === 403) && retry) {
    session = null;
    await chrome.storage.session.remove("ymSession");
    await bootstrap(true);
    return batch(name, requests, false, files, headers);
  }
  const text = await resp.text();
  let doc;
  try { doc = JSON.parse(text); } catch { throw new ApiError(`${name}: HTTP ${resp.status}, non-JSON response`, text.slice(0, 300)); }
  if (doc.error) {
    const code = doc.error.code || "";
    if (code === "EP-4010" && retry) {
      // Origin rewrite rule not installed yet (worker still starting); ask it and retry once.
      await chrome.runtime.sendMessage({ type: "ensureRules" }).catch(() => {});
      return batch(name, requests, false, files, headers);
    }
    if (code === "EC-4008") { session = null; throw new NotSignedIn(); }
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

export async function folders() {
  const r = await batch("mailbox.sync", [{ id: "GetFolders", uri: "/ws/v3/mailboxes/@.id==<mb>/folders", method: "GET" }]);
  const res = first(r);
  return { folders: res.folders || [], accounts: res.accounts || [], ms: r.ms };
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
  const scope = folderId ? `folderId:${folderId} ` : "";
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
  const resp = await fetch(`${JWS}/ws/v3/mailboxes/@.id==${s.mailboxId}/messages/@.id==${msgId}/content/rawplaintext?${qs}`, { credentials: "include" });
  if ((resp.status === 401 || resp.status === 403) && retry) {
    session = null;
    await chrome.storage.session.remove("ymSession");
    await bootstrap(true);
    return rawMessage(msgId, false);
  }
  if (!resp.ok) throw new ApiError(`rawMessage: HTTP ${resp.status}`, (await resp.text()).slice(0, 300));
  return new Uint8Array(await resp.arrayBuffer());
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
function checkIds(ids) {
  const bad = ids.find(id => !MSG_ID.test(String(id)));
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
  const parts = [];
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

export async function searchQuery(q, count = 20) {
  const r = await batch("messageGroups.getList", [{ id: "GetMessageGroupList", method: "GET", uri: q2(`count:${count} offset:0 -sort:date ${q}`) }]);
  return { messages: first(r).messages || [], ms: r.ms };
}
const q2 = s => `/ws/v3/mailboxes/@.id==<mb>/messages/@.select==q?q=${encodeURIComponent(s)}`;

export function move(ids, folderId) { return update("messages.move", ids, { message: { folder: { id: String(folderId) } } }); }

// Permanent removal; the client only calls this for messages already in Trash.
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
function saveRequest(d) {
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
  return x.response?.result?.message || null;
}

const allFiles = d => (d.files || []).concat((d.inline || []).map(i => i.file));

export async function saveDraft(d) {
  const r = await batch("messages.saveV3", [saveRequest(d)], true, allFiles(d));
  return { message: saveResult(r), ms: r.ms };
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
  const r = await batch("messages.saveAndSend", [req], true, allFiles(d));
  const message = saveResult(r);
  const sent = r.find(x => x.id === "SendMessage");
  const code = sent?.httpCode ?? 0;
  if (code < 200 || code >= 300) throw new ApiError(`send: HTTP ${code} ${JSON.stringify(sent?.response?.error || "").slice(0, 120)}`, sent);
  return { message, ms: r.ms };
}
