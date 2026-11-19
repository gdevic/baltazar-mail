// The setup of the Google OAuth client this extension signs in with, as data for the sign-in page,
// which ext/guide.js draws: the steps of the guide, the reading of a pasted Client ID, and what to
// do about each way a sign-in can fail. Every address of Google's console is here, so the shared
// client names none. No DOM and no chrome: the Node tests read this file as it is.
//
// In the text, **bold** is a label as Google's page shows it and `code` a value to type or copy;
// the guide draws nothing else.
//
// Two routes lead to a client. The quick one is Google's Personal mode, which makes the project
// and the client on one page, needs no review by Google and shows no warning, but lets only the
// Google account that made the client sign in with it. The classic one makes an app that any
// account (External) or any account of one organization (Internal) can sign in to.

const CONSOLE = "https://console.cloud.google.com";
const inProject = (path, project) => `${CONSOLE}${path}${project ? `?project=${project}` : ""}`;
// project: the number of the client's project, which the console's pages are opened in.
export const PAGES = {
  personal: () => `${CONSOLE}/auth/overview/personal`,
  newProject: () => `${CONSOLE}/projectcreate`,
  gmailApi: project => inProject("/apis/library/gmail.googleapis.com", project),
  overview: project => inProject("/auth/overview", project),
  audience: project => inProject("/auth/audience", project),
  clients: project => inProject("/auth/clients", project),
};
export const ROUTES = ["quick", "classic"];
export const APP_NAME = "Baltazar Mail";

// ---------- the Client ID ----------
// A Google OAuth client id: the project number, a dash, a hash, and Google's domain for clients.
const CLIENT_ID = /\d{4,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com/i;
const ENDS = "A Client ID ends in `.apps.googleusercontent.com`.";
export const projectOf = id => String(id || "").match(/^(\d+)-/)?.[1] || "";

// What was pasted into the guide's box: { id } for a Client ID, { id, warn } for one that may not
// work yet, { error } for anything else, {} for nothing. Google's JSON file of the client counts
// as its Client ID. redirect: this copy's redirect address.
export function read(text, redirect = "") {
  const s = String(text ?? "").trim();
  if (!s) return {};
  if (s.startsWith("{")) return fromFile(s, redirect);
  if (/^GOCSPX-/i.test(s)) return { error: "That is the client secret, which Baltazar Mail does not need. Paste the **Client ID**, shown just above it." };
  if (/chromiumapp\.org/i.test(s)) return { error: "That is a redirect address, which goes into Google's form. Paste the **Client ID** that Google shows once the client is created." };
  if (/^AIza/.test(s)) return { error: `That is an API key, which Baltazar Mail does not need. ${ENDS}` };
  if (/^\d+$/.test(s)) return { error: `That is a project number. The Client ID starts with it. ${ENDS}` };
  const found = [...new Set((s.match(new RegExp(CLIENT_ID.source, "gi")) || []).map(x => x.toLowerCase()))];
  if (found.length === 1) return { id: found[0] };
  if (found.length > 1) return { error: "That holds more than one Client ID. Paste only the one of this copy's client." };
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { error: `That is an email address. ${ENDS}` };
  if (/apps\.google|googleusercontent/i.test(s)) return { error: "Part of the Client ID seems to be missing. Copy it again with the copy button beside it on Google's page." };
  return { error: `That is not a Client ID. ${ENDS}` };
}
function fromFile(s, redirect) {
  let doc;
  try { doc = JSON.parse(s); } catch { return { error: "That is only part of Google's JSON file. Paste the whole file, or only the **Client ID**." }; }
  if (doc?.installed) return { error: "That file is of a client for a **Desktop app**, which cannot sign in from a browser. Create one of type **Web application**." };
  const id = String(doc?.web?.client_id || "");
  if (!CLIENT_ID.test(id)) return { error: "That file holds no Client ID. Paste the **Client ID** itself." };
  const uris = Array.isArray(doc.web.redirect_uris) ? doc.web.redirect_uris : [];
  const out = { id: id.match(CLIENT_ID)[0].toLowerCase() };
  if (redirect && !uris.includes(redirect)) out.warn = "This client does not list this copy's redirect address, so Google will refuse the sign-in until it does. Add the address to the client (step 1) and save it.";
  return out;
}

// ---------- the guide ----------
// The welcome above the guide; it introduces the product, so the marks carry their signs.
export const INTRO = "Welcome! Baltazar Mail reads your Gmail™ directly from Google™, with no server of its own in between. Google lets an app reach your mail only with a Client ID, a pass that Google issues for that app, so you get one of your own: it is free, takes about two minutes, and is needed only once.";

const PERMISSION = "Google asks to let Baltazar Mail **Read, compose, send, and permanently delete all your email from Gmail**. Allow it: deleting for good is what Empty Trash and Delete in Trash do.";
const PRIVATE = "Your mail goes only between this browser and Google. You can withdraw the permission at any time in your Google account.";
const UNVERIFIED = `Google says it **hasn't verified this app**, since the app is your own and nobody else uses it: click **Advanced**, then **Go to ${APP_NAME} (unsafe)**.`;

// What Google asks at the sign-in. own: the client is the user's, made with one account.
export function notes(own = true) {
  return own ? ["Choose the Google account you made the client with.", PERMISSION, PRIVATE] : [PERMISSION, PRIVATE];
}

const PASTE = {
  id: "paste", title: "Paste the Client ID",
  lead: `${ENDS} The text of the JSON file that Google lets you download works as well.`,
  paste: { label: "Client ID", placeholder: "123456789012-abc123def456.apps.googleusercontent.com", button: "Use this Client ID" },
};
const apiStep = (project, check) => ({
  id: "api", title: "Switch on the Gmail API",
  lead: "Google keeps the Gmail API off in a new project; one click turns it on.",
  open: { label: "Open the Gmail API page", href: PAGES.gmailApi(project) },
  lines: [...check, "Click **Enable**. If the page shows **Manage** instead, it is on already."],
  next: "It is on",
});

// The steps of a route, in order, as { id, title, lead?, copy?: { label, value }, open?: { label,
// href }, lines?: [], paste?, next?: label of the button that moves on, signIn?: true }.
// redirect: this copy's redirect address; project: the number of the client's project, once
// there is a Client ID.
export function guide({ route = "quick", redirect = "", project = "" } = {}) {
  const copy = { label: "This copy's redirect address", value: redirect };
  if (route === "classic") return {
    route,
    steps: [
      { id: "project", title: "Create a Google Cloud project", open: { label: "Open Google's page", href: PAGES.newProject() },
        lines: ["Give it any name, such as `Baltazar Mail`, and click **Create**.", "Wait until Google shows the new project as selected, at the top of the page."], next: "Done" },
      apiStep("", ["Check that the new project is the one selected at the top of the page."]),
      { id: "describe", title: "Describe the app to Google", open: { label: "Open Google's page", href: PAGES.overview(project) }, copy: { label: "App name", value: APP_NAME },
        lines: [
          "Click **Get started**.",
          "Under **App Information**, give the **App name** above and choose your address as **User support email**, then click **Next**.",
          "Under **Audience**, choose **External** to sign in with any Google account, or **Internal** if every account is in your work or school organization, then click **Next**.",
          "Under **Contact Information**, give your address and click **Next**.",
          "Under **Finish**, agree to the **Google API Services: User Data Policy**, then click **Continue** and **Create**.",
        ], next: "Done" },
      { id: "publish", title: "Let your accounts in", open: { label: "Open Audience", href: PAGES.audience(project) },
        lines: [
          "With **External**: click **Publish app** and confirm. Until then, only the accounts listed under **Test users** can sign in, and Google asks them again every week.",
          "With **Internal**, there is nothing to do here.",
        ], next: "Done" },
      { id: "client", title: "Create the client", copy, open: { label: "Open your clients", href: PAGES.clients(project) },
        lines: [
          "Click **Create client**.",
          "Under **Application type**, choose **Web application**. Any **Name** will do.",
          "The page has two **Add URI** buttons: click the one under **Authorized redirect URIs** and paste the redirect address above. Leave **Authorized JavaScript origins** empty; it refuses the address with \"Invalid Origin\".",
          "Click **Create**, then copy the **Client ID**. The client secret is not needed.",
        ], next: "I have the Client ID" },
      PASTE,
      { id: "signin", title: "Sign in with Google", signIn: true, lines: [...notes(false), UNVERIFIED] },
    ],
    other: { route: "quick", label: "Back to the quick way" },
    jump: { step: "paste", label: "I already have a Client ID" },
  };
  return {
    route: "quick",
    steps: [
      { id: "create", title: "Create your Google client", lead: "Google's page makes a project and a client for you in one go, free and without any review.",
        copy, open: { label: "Open Google's page", href: PAGES.personal() },
        lines: [
          "Check the picture at the top right of Google's page: it must be the Google account whose mail you want to read here.",
          "Leave the project as Google suggests it.",
          "Under **Application type**, choose **Web application**.",
          "The page has two **Add URI** buttons: click the one under **Authorized redirect URIs** and paste the redirect address above. Leave **Authorized JavaScript origins** empty; it refuses the address with \"Invalid Origin\".",
          "Tick the box that accepts the Terms of Service, then click **Continue**.",
          "Google shows **OAuth client created**: copy the **Client ID**. The client secret is not needed.",
        ], next: "I have the Client ID" },
      PASTE,
      apiStep(project, []),
      { id: "signin", title: "Sign in with Google", signIn: true, lines: notes(true) },
    ],
    other: { route: "classic", label: "Several Google accounts, or a work or school account? Set up the client the classic way" },
    jump: { step: "paste", label: "I already have a Client ID" },
  };
}

// ---------- when a sign-in fails ----------
// What Google's window may have said, with what to do about it: { id, says, fix: [], copy?,
// open? }. The extension never sees these pages; the user picks the one they saw.
export function help({ redirect = "", project = "" } = {}) {
  const audience = { label: "Open Audience", href: PAGES.audience(project) };
  const clients = { label: "Open your clients", href: PAGES.clients(project) };
  return [
    { id: "redirect_uri_mismatch", says: "Error 400: redirect_uri_mismatch", copy: { label: "This copy's redirect address", value: redirect }, open: clients, fix: [
      "The client does not list this copy's redirect address. Open the client, add the address below under **Authorized redirect URIs**, and click **Save**.",
      "Google can take from five minutes to a few hours to apply a change to a client, so if the address is there already, try again later.",
      "No **Authorized redirect URIs** on the client? Then it is not of type **Web application**: create one that is.",
    ] },
    { id: "client_user_mismatch", says: "Error 400: client_user_mismatch", fix: [
      "The client was made in Personal mode by another Google account, and only that account can sign in with it.",
      "Choose that account in Google's window, or make a client of your own while Google's page shows this account at the top right.",
    ] },
    { id: "invalid_client", says: "Error 401: invalid_client, or deleted_client", open: clients, fix: [
      "Google does not know this Client ID: part of it is missing, or the client was deleted.",
      "Copy the Client ID again from your clients and paste it with **Use a different Client ID**. A client deleted in the last 30 days can be restored on Google's page of deleted credentials.",
    ] },
    { id: "access_denied", says: "Error 403: access_denied, or the app has not completed the Google verification process", open: audience, fix: [
      "The app is still in testing, which lets in only the accounts listed as test users.",
      "Open **Audience** and click **Publish app**, or add this account under **Test users**.",
    ] },
    { id: "unverified", says: "Google hasn't verified this app", fix: [
      "Expected for a client of your own made the classic way: Google has not reviewed the app, since only you use it.",
      `Click **Advanced**, then **Go to ${APP_NAME} (unsafe)**.`,
    ] },
    { id: "org_internal", says: "Error 403: org_internal", open: audience, fix: [
      "The app lets in only the accounts of its own organization (**Internal**).",
      "Sign in with such an account, or make the audience **External** under **Audience** and publish the app.",
    ] },
    { id: "admin_policy_enforced", says: "Error 400: admin_policy_enforced, or access blocked by your administrator", fix: [
      "Your organization does not let this account use apps it has not approved.",
      "Ask its administrator to allow the app for your account, or use another account.",
    ] },
    { id: "blocked", says: "This app is blocked", fix: [
      "Google keeps apps it has not verified away from the mail of accounts in its Advanced Protection Program, and of accounts that a parent supervises.",
      "Such an account cannot be used here.",
    ] },
    { id: "weekly", says: "Google asks me to sign in again every week", open: audience, fix: [
      "The app is still in testing, where Google's permission lasts seven days.",
      "Open **Audience** and click **Publish app**.",
    ] },
    { id: "hidden", says: "No window of Google's appeared", fix: [
      "Google's sign-in opens in a window of its own, which may be behind this one: look for it in the taskbar or the list of windows.",
    ] },
  ];
}

// A failed sign-in in words: { text, held?, button?, open?, help?, pick? }, or null when the
// sign-in page says enough by itself. held: Google gave a token that the next press confirms
// without a window, and button is then the label of that press; help: the list of what Google's
// window may have said is worth showing, with the entry pick open.
export function explain(e, { project = "" } = {}) {
  const code = e?.code || "", google = e?.google || "";
  switch (code) {
    case "": return e?.why ? { text: sentence(e.why) } : null;
    case "session": return null;
    case "setup": return { text: "Set up the Google client first: the steps are above." };
    case "closed": return { text: "Google's window closed before the sign-in finished. If it showed an error, find its words below.", help: true };
    case "unreachable": return { text: "Google's sign-in page could not be loaded. Check the connection, then try again." };
    case "denied": return { text: "The sign-in was cancelled at Google, so nothing was allowed. Try again, and allow it when Google asks." };
    case "refused": return { text: `Google refused the sign-in (${google || "no reason given"}).`, help: true, pick: help().some(h => h.id === google) ? google : "" };
    case "api-off": return { text: "Google signed you in, but the Gmail API is still off in the project of this client. Switch it on, wait a minute, then press **Continue**.", held: true, button: "Continue", open: { label: "Open the Gmail API page", href: PAGES.gmailApi(project) } };
    case "unconfirmed": return { text: `${sentence(e.message)} Press **Continue** to try again; Google's window is not needed.`, held: true, button: "Continue" };
    case "scope": return { text: "Google gave no permission to use Gmail. Sign in again, and when Google lists what Baltazar Mail may do, leave the box for Gmail ticked." };
    default: return { text: sentence(e.message), help: code === "window" };
  }
}
const sentence = s => { const t = String(s || "The sign-in did not finish").trim(); return t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : "."); };
