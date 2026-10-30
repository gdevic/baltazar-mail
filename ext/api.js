// Protocol adapter for Yahoo Mail's ws/v3 batch API. Every endpoint string and payload shape
// lives here; nothing else in the client knows the wire format. See yahoo-v3.md.

const ORIGIN = "https://mail.yahoo.com";
const BATCH = ORIGIN + "/c/ws/v3/batch";
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
export async function batch(name, requests, retry = true, files = []) {
  const s = await bootstrap();
  const fill = r => ({ payloadType: "embedded", ...r, uri: r.uri.replaceAll("<mb>", s.mailboxId), ...(r.requests ? { requests: r.requests.map(fill) } : {}) });
  const reqs = requests.map(fill);
  const fd = new FormData();
  fd.append("batchJson", JSON.stringify({ requests: reqs, responseType: "json" }));
  for (const f of files || []) fd.append(encodeURIComponent(f.name), f, f.name);
  const qs = new URLSearchParams({ name, appId: s.appId, wssid: s.wssid, ymreqid: uuid(), nonblocking: "true" });
  const t0 = performance.now();
  const resp = await fetch(`${BATCH}?${qs}`, { method: "POST", body: fd, credentials: "include" });
  const ms = Math.round(performance.now() - t0);
  if ((resp.status === 401 || resp.status === 403) && retry) {
    session = null;
    await chrome.storage.session.remove("ymSession");
    await bootstrap(true);
    return batch(name, requests, false, files);
  }
  const text = await resp.text();
  let doc;
  try { doc = JSON.parse(text); } catch { throw new ApiError(`${name}: HTTP ${resp.status}, non-JSON response`, text.slice(0, 300)); }
  if (doc.error) {
    const code = doc.error.code || "";
    if (code === "EP-4010" && retry) {
      // Origin rewrite rule not installed yet (worker still starting); ask it and retry once.
      await chrome.runtime.sendMessage({ type: "ensureRules" }).catch(() => {});
      return batch(name, requests, false, files);
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

export async function search(term, folderId = null, count = 100, offset = 0) {
  const scope = folderId ? `folderId:${folderId} ` : "";
  const r = await batch("messageGroups.getList", [{
    id: "GetMessageGroupList", method: "GET",
    uri: q(`${scope}count:${count} offset:${offset} -sort:date keyword:${term}`),
  }]);
  const res = first(r);
  return { messages: res.messages || [], query: res.query, ms: r.ms };
}

export async function body(msgId) {
  const r = await batch("messages.getBody", [{
    id: "GetSimpleBody_0", method: "GET",
    uri: `/ws/v3/mailboxes/@.id==<mb>/messages/@.id==${msgId}/content/simplebody/full`,
  }]);
  const res = first(r);
  if (!res?.message) throw new ApiError("body: message not returned", r[0]);
  return { message: res.message, html: res.simpleBody?.html || "", attachments: res.simpleBody?.attachments || [], ms: r.ms };
}

// ---------- mutations ----------
// Each id gets its own inner request, as the web client does; one HTTP round trip for all of them.
// Returns the ids that succeeded and those that failed; throws only if nothing succeeded.
async function perMessage(name, ids, make) {
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
function saveRequest(d) {
  const files = d.files || [];
  const attachments = files.map(f => ({ disposition: "attachment", multipartName: `multipart://${encodeURIComponent(f.name)}` }));
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

export async function saveDraft(d) {
  const r = await batch("messages.saveV3", [saveRequest(d)], true, d.files);
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
  const r = await batch("messages.saveAndSend", [req], true, d.files);
  const message = saveResult(r);
  const sent = r.find(x => x.id === "SendMessage");
  const code = sent?.httpCode ?? 0;
  if (code < 200 || code >= 300) throw new ApiError(`send: HTTP ${code} ${JSON.stringify(sent?.response?.error || "").slice(0, 120)}`, sent);
  return { message, ms: r.ms };
}
