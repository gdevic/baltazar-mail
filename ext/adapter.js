// What the two adapters (yahoo/api.js and gmail/api.js) share: the errors they throw, the deadline
// every request keeps, the shape of the folder list they give, the check on the message ids they
// are handed, and the reading of the Message-IDs a message names. Each adapter exports these as
// its own.

export class ApiError extends Error {
  constructor(msg, detail) { super(msg); this.name = "ApiError"; this.detail = detail; }
}

// Every request has a deadline, so a stalled connection ends in an error instead of waiting
// forever. Uploads get extra time per megabyte sent.
export const TIMEOUTS = { page: 30000, batch: 60000, perMB: 10000, raw: 120000 };
export class Timeout extends Error {
  constructor(provider, what, ms) { super(`${provider} did not answer within ${Math.round(ms / 1000)} s (${what})`); this.name = "Timeout"; }
}
// The provider's fetch: fetch plus reading the body, both inside the deadline. read(resp) returns
// the body; a deadline that passes is a Timeout naming the provider.
export const deadlined = provider => async (what, url, init, ms, read) => {
  const signal = AbortSignal.timeout(ms);
  try {
    const resp = await fetch(url, { ...init, signal });
    return { resp, body: await read(resp) };
  } catch (e) { throw signal.aborted && e.name === "TimeoutError" ? new Timeout(provider, what, ms) : e; }
};

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
