// Google sign-in for the Gmail adapter: OAuth 2.0 implicit grant through chrome.identity's web
// auth flow, which works in Chrome and in Edge alike. The access token lasts an hour; it is renewed
// silently (prompt=none, which succeeds while the browser holds a Google session) and kept in
// session storage, so a reload does not ask again. Only signIn() may open Google's window.
//
// No request waits for a renewal while the token it has still works. In its last RENEW_AHEAD the
// token is renewed beside the requests, which go on using it, and the new one takes its place
// when Google has answered; a renewal ahead of time that fails says nothing, and is tried again
// after AHEAD_GAP, unless Google refused it. Requests wait for a renewal only once the token has
// less than SPARE left, or after a 401, and the client is told that they do (activity.wait). The
// browser's silent flow has no deadline of its own, so one that has not answered within
// TIMEOUTS.renew is given up as a renewal that never reached Google.
//
// The flow goes through an OAuth client registered with Google: the user's own, whose Client ID
// the sign-in page keeps in local storage until it is replaced, else the one the build carries in
// the manifest's oauth2 block (a release carries none). Without either, no window opens.
//
// A silent renewal is only ever for the account the user signed in with: Google is told which
// one (login_hint), and a token for any other account is refused, so the client never shows one
// mailbox while acting on another. The account is kept in local storage until Sign out; without
// it nothing is renewed, and the sign-in panel asks.
//
// A silent renewal fails in two ways that must not look alike. When Google answers it with a
// refusal (login_required and the like, or a page that needs the user), the session is gone and
// NotSignedIn sends the user to the sign-in panel. When Google was never reached (the page could
// not be loaded, or no answer came in time), the renewal is asked again while the connection is
// lost, as a request is, and past that fails as the connection's (Offline), which the client tells
// as the network's doing and tries again; one that fails while other requests get through is an
// ordinary Error carrying the browser's reason. A profile check the server failed is one too.
//
// A sign-in that fails carries a code (NotSignedIn.code), which the sign-in page turns into a
// sentence and a fix (setup.js, explain). When Google gave a token but the account could not be
// confirmed with it (the Gmail API is off in the client's project, or the check could not be
// made), the token is held in memory, and the next press of the button confirms it without
// opening Google's window again.

import { TIMEOUTS, activity, deadlined, untilThrough, Unsent, Offline } from "./adapter.js";

const SCOPE = "https://mail.google.com/";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const KEY = "gmToken", ACCOUNT = "gmAccount", CLIENT = "gmClientId";
const RENEW_AHEAD = 10 * 60e3, SPARE = 60e3, AHEAD_GAP = 60e3, HELD_AHEAD = 60e3;

// why: the reason, when there is more to say than that nobody is signed in; code: what went
// wrong, for the sign-in page; google: the error Google's answer named, if any; held: a token is
// held that the next press confirms.
export class NotSignedIn extends Error {
  constructor(why, code = "", google = "") { super(why || "Not signed in to Google"); this.name = "NotSignedIn"; this.why = why || ""; this.code = code; this.google = google; }
}

let token = null;       // { access_token, expires, email }, or { email } once the token is forgotten
let held = null;        // { access_token, expires }: a token from Google whose account is not confirmed yet
let pending = null, pendingInteractive = false;
let epoch = 0;          // counts sign-outs: a flow begun before one does not sign back in
let aheadAt = 0;        // when a renewal ahead of time last began
let aheadRefused = "";  // the token Google refused to renew ahead of time, which is not tried again

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// p, or a failure when it has not settled within ms.
const answered = (p, ms) => new Promise((ok, no) => {
  const t = setTimeout(() => no(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms);
  p.then(v => { clearTimeout(t); ok(v); }, e => { clearTimeout(t); no(e); });
});

// The OAuth client a sign-in goes through: { id, own }, own when it is the user's, set up on the
// sign-in page; id is "" when there is none.
export async function client() {
  const mine = (await chrome.storage.local.get(CLIENT))[CLIENT];
  if (mine) return { id: mine, own: true };
  return { id: chrome.runtime.getManifest().oauth2?.client_id || "", own: false };
}
// Keeps the user's own Client ID, or with "" forgets it, which leaves the build's. A token belongs
// to the client that gave it, so the token goes too; the account is kept.
export async function setClient(id) {
  if (pending) await pending.catch(() => {});
  if (id) await chrome.storage.local.set({ [CLIENT]: id });
  else await chrome.storage.local.remove(CLIENT);
  held = null;
  await forget();
}
// The address Google sends the sign-in's answer to; the client must list it.
export const redirectAddress = () => chrome.identity.getRedirectURL();

// Why Google refused a call with 403: "api-off" when the Gmail API is off in the client's
// project, "scope" when the token lacks the mail permission (left unticked on Google's consent
// page, or withdrawn since), else "". Each shows among the errors' reasons or the details'.
export function refusal(doc) {
  const e = doc?.error, reasons = [...(e?.errors || []), ...(e?.details || [])].map(x => x?.reason);
  if (reasons.some(r => r === "accessNotConfigured" || r === "SERVICE_DISABLED")) return "api-off";
  if (reasons.some(r => r === "insufficientPermissions" || r === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return "scope";
  return "";
}

function authUrl(clientId, interactive, email) {
  const state = crypto.randomUUID();
  const p = new URLSearchParams({ client_id: clientId, redirect_uri: redirectAddress(), response_type: "token", scope: SCOPE, state, include_granted_scopes: "true" });
  if (interactive) p.set("prompt", "select_account consent");
  else { p.set("prompt", "none"); p.set("login_hint", email); }
  return { url: `${AUTH}?${p}`, state };
}

// Runs the flow and reads the token out of the redirect's fragment. ahead: a renewal beside
// requests that still have a token, which does not wait for a lost connection.
async function flow(interactive, email, ahead = false) {
  const { id } = await client();
  if (!id) throw new NotSignedIn("no Google client is set up for this copy", "setup");
  const { url, state } = authUrl(id, interactive, email);
  let redirect;
  if (interactive) {
    try { redirect = await chrome.identity.launchWebAuthFlow({ url, interactive }); }
    catch (e) {
      const why = String(e?.message || e);
      // the browser's words for a window closed by the user, and for a page that would not load
      if (/did not approve/i.test(why)) throw new NotSignedIn(`Google's window was closed before the sign-in finished (${why})`, "closed");
      if (/could not be loaded|timed? ?out/i.test(why)) throw new NotSignedIn(`Google's sign-in page could not be loaded (${why})`, "unreachable");
      throw new NotSignedIn(`Google sign-in did not complete (${why})`, "window");
    }
  } else {
    // a silent renewal that never reached Google is asked again while the connection is lost, as
    // a request is (untilThrough), and past that is the connection's failure
    redirect = await untilThrough("Gmail", async () => {
      try { return await answered(chrome.identity.launchWebAuthFlow({ url, interactive }), TIMEOUTS.renew); }
      catch (e) {
        const why = String(e?.message || e);
        if (/interaction|approve|not signed in/i.test(why)) throw new NotSignedIn(undefined, "session");
        throw new Unsent(new Error(`Google's sign-in could not be reached (${why})`));
      }
    }, !ahead);
  }
  const q = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (q.get("state") !== state) throw new NotSignedIn("the sign-in answer did not match the request", "answer");
  const err = q.get("error");
  if (err) {
    const google = /^[\w.-]{1,60}$/.test(err) ? err : "";
    if (!interactive) throw new NotSignedIn(undefined, "session", google);
    if (err === "access_denied") throw new NotSignedIn("the permission was not given at Google", "denied", google);
    throw new NotSignedIn(`Google answered: ${google || "an error"}`, "refused", google);
  }
  const access = q.get("access_token");
  if (!access) throw new NotSignedIn("no token in the sign-in answer", "answer");
  return { access_token: access, expires: Date.now() + (Number(q.get("expires_in")) || 3600) * 1000 };
}

// The account a token is for, asked as any read is (see deadlined).
const fetchTimed = deadlined("Gmail");
async function profileEmail(access) {
  const { resp, body } = await fetchTimed("account check", PROFILE, { headers: { Authorization: `Bearer ${access}` } }, 30000, r => r.text(), { again: true, first: TIMEOUTS.first });
  let doc = null;
  try { doc = JSON.parse(body); } catch { /* no body to read */ }
  if (resp.ok) return doc?.emailAddress || "";
  const why = resp.status === 403 ? refusal(doc) : "";
  if (why === "api-off") throw new NotSignedIn("Google signed you in, but the Gmail API is off in the project of this client", "api-off");
  if (why === "scope") throw new NotSignedIn("Google gave no permission to use Gmail", "scope");
  // a rate limit is a moment's wait, not a refusal of the account
  if (resp.status === 429 || (resp.status === 403 && /rateLimit/i.test(doc?.error?.errors?.[0]?.reason || ""))) throw new Error(`Google is limiting requests just now (HTTP ${resp.status}); try again in a moment`);
  if (resp.status === 401 || resp.status === 403) throw new NotSignedIn(`Google did not confirm the account (HTTP ${resp.status})`);
  throw new Error(`Google could not confirm the account (HTTP ${resp.status})`);
}

// The account the user signed in with, or "" when nobody is.
export async function account() {
  return (await chrome.storage.local.get(ACCOUNT))[ACCOUNT] || token?.email || "";
}

// The token to use now. interactive: ask the user (the sign-in button only). force: renew even
// if the stored one has time left (after a 401). The stored token is answered at once while it
// works, and renewed beside the caller in its last RENEW_AHEAD; a caller that has to wait for a
// silent renewal is a wait the client can tell of.
export async function getToken({ interactive = false, force = false } = {}) {
  if (!interactive && !force) {
    const t = await usable();
    if (t) { renewAhead(t); return t; }
  }
  const done = interactive ? null : activity.wait("renewing the Google sign-in");
  try { return await renewed({ interactive, force }); } finally { done?.(); }
}

// The stored token, while it is the signed-in account's and has more than SPARE left.
const works = (t, want) => !!want && !!t?.access_token && same(t.email, want) && t.expires - Date.now() > SPARE;
async function usable() {
  if (!token) token = (await chrome.storage.session.get(KEY))[KEY] || null;
  return works(token, await account()) ? token : null;
}
// Renews a token in its last RENEW_AHEAD while the requests go on using it. A failure changes
// nothing: the token is used until SPARE, and the renewal a request then waits for reports it.
function renewAhead(t) {
  if (t.expires - Date.now() > RENEW_AHEAD || pending || aheadRefused === t.access_token || Date.now() - aheadAt < AHEAD_GAP) return;
  aheadAt = Date.now();
  renewed({ force: true, ahead: true }).catch(e => { if (e instanceof NotSignedIn) aheadRefused = t.access_token; });
}

// A token from Google's flow, or the stored one when it works and none is forced. Callers that
// ask at the same time share one flow, except that an interactive request waits for a silent one
// to settle, then runs its own.
async function renewed({ interactive = false, force = false, ahead = false } = {}) {
  if (pending && (pendingInteractive || !interactive)) return pending;
  if (pending) await pending.catch(() => {});
  const began = epoch;
  const p = (async () => {
    if (!token) token = (await chrome.storage.session.get(KEY))[KEY] || null;
    let want = "";
    if (!interactive) {
      want = await account();
      if (!want) throw new NotSignedIn();
      if (!force && works(token, want)) return token;
    }
    const t = interactive && held?.expires - Date.now() > HELD_AHEAD ? held : await flow(interactive, want, ahead);
    const email = await confirmed(t, interactive);
    if (epoch !== began) throw new NotSignedIn();
    if (want && !same(email, want)) throw new NotSignedIn(`Google renewed the sign-in for ${email}, not ${want}; sign in again`, "account");
    token = { ...t, email };
    await chrome.storage.session.set({ [KEY]: token });
    await chrome.storage.local.set({ [ACCOUNT]: email });
    return token;
  })().finally(() => { if (pending === p) pending = null; });
  pending = p; pendingInteractive = interactive;
  return p;
}

// The address of the account a token is for. A token whose account cannot be confirmed because
// the Gmail API is off is held, and so, after the button, is one whose check could not be made;
// any other failure lets the token go.
async function confirmed(t, interactive) {
  try {
    const email = await profileEmail(t.access_token);
    held = null;
    return email;
  } catch (e) {
    if (e instanceof NotSignedIn && e.code === "api-off") { held = t; e.held = true; throw e; }
    if (interactive && !(e instanceof NotSignedIn)) {
      held = t;
      const why = e instanceof TypeError || e instanceof Offline ? `Google could not confirm the account (${e.message})` : e.message;
      throw Object.assign(new NotSignedIn(why, "unconfirmed"), { held: true });
    }
    if (t === held) held = null;
    throw e;
  }
}

// Forgets the token here and in session storage, keeping the account; the next call renews the
// token silently for that account.
export async function forget() {
  token = token?.email ? { email: token.email } : null;
  await chrome.storage.session.remove(KEY);
}

// Tells Google the token is no longer wanted, which withdraws the permission, then forgets the
// token and the account, so nothing signs in again until the sign-in button is pressed. Throws,
// still signed in, when Google cannot confirm it; a token Google no longer knows (400) counts as
// ended. The Client ID stays, so signing in again is one press.
export async function signOut() {
  if (pending) await pending.catch(() => {});
  const t = token?.access_token || (await chrome.storage.session.get(KEY))[KEY]?.access_token;
  if (t) {
    let resp;
    try {
      resp = await fetch(REVOKE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t }).toString(), signal: AbortSignal.timeout(15000) });
    } catch (e) { throw new Error(`Google could not be reached to end the sign-in (${e.message}); you are still signed in`); }
    if (!resp.ok && resp.status !== 400) throw new Error(`Google did not end the sign-in (HTTP ${resp.status}); you are still signed in`);
  }
  epoch++;
  token = null;
  held = null;
  await chrome.storage.session.remove(KEY);
  await chrome.storage.local.remove(ACCOUNT);
}
