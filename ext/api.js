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

export function sessionInfo() { return session; }

const uuid = () => crypto.randomUUID();

// One batch envelope, one HTTP round trip. Returns the inner responses array.
export async function batch(name, requests, retry = true) {
  const s = await bootstrap();
  const reqs = requests.map(r => ({
    payloadType: "embedded",
    ...r,
    uri: r.uri.replaceAll("<mb>", s.mailboxId),
  }));
  const fd = new FormData();
  fd.append("batchJson", JSON.stringify({ requests: reqs, responseType: "json" }));
  const qs = new URLSearchParams({ name, appId: s.appId, wssid: s.wssid, ymreqid: uuid(), nonblocking: "true" });
  const t0 = performance.now();
  const resp = await fetch(`${BATCH}?${qs}`, { method: "POST", body: fd, credentials: "include" });
  const ms = Math.round(performance.now() - t0);
  if ((resp.status === 401 || resp.status === 403) && retry) {
    await bootstrap(true);
    return batch(name, requests, false);
  }
  const text = await resp.text();
  let doc;
  try { doc = JSON.parse(text); } catch { throw new ApiError(`${name}: HTTP ${resp.status}, non-JSON response`, text.slice(0, 300)); }
  if (doc.error) {
    const code = doc.error.code || "";
    const hint = code === "EP-4010" ? " (proxy rejected the request origin; reload the extension so its header rules install)" : "";
    throw new ApiError(`${name}: HTTP ${resp.status} ${JSON.stringify(doc.error).slice(0, 160)}${hint}`, doc.error);
  }
  const responses = doc.result?.responses || [];
  responses.ms = ms;
  return responses;
}

const q = s => `/ws/v3/mailboxes/@.id==<mb>/messages/@.select==q?q=${encodeURIComponent(s)}`;
const first = r => r[0]?.response?.result ?? r[0];

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
async function perMessage(name, ids, make) {
  const r = await batch(name, ids.map((id, i) => make(id, i)));
  const failed = r.filter(x => x.httpCode && x.httpCode >= 300);
  if (failed.length) throw new ApiError(`${name}: ${failed.length} of ${ids.length} failed (HTTP ${failed[0].httpCode})`, failed);
  return { ms: r.ms, count: ids.length };
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
