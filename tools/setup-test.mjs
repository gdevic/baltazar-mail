// The Gmail extension's setup guide (gmail/setup.js): what it takes for a Client ID, the steps of
// both routes and every page they open, what it says about each failed sign-in, and that
// docs/google-setup.md names every label the guide does. node tools/setup-test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { read, guide, help, explain, notes, projectOf, PAGES, ROUTES, INTRO } from "../gmail/setup.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };

const CID = "123456789012-abc123def456ghi789jkl012mno345pq.apps.googleusercontent.com";
const REDIRECT = "https://enejfhgeailmbkfpdgfdlajlfhnnbafd.chromiumapp.org/";

// ---------- read ----------
{
  const said = (text, re) => { const r = read(text, REDIRECT); ok(!r.id && re.test(r.error || ""), `${JSON.stringify(text).slice(0, 60)} is refused with ${re}: ${JSON.stringify(r)}`); };
  ok(JSON.stringify(read("", REDIRECT)) === "{}" && JSON.stringify(read("   \n", REDIRECT)) === "{}", "nothing pasted is neither right nor wrong");
  for (const text of [CID, `  ${CID}\n`, `"${CID}"`, CID.toUpperCase(), `Client ID ${CID}`, `${CID}, ${CID}`])
    ok(read(text, REDIRECT).id === CID, `a Client ID is taken from ${JSON.stringify(text).slice(0, 50)}: ${JSON.stringify(read(text, REDIRECT))}`);
  said("GOCSPX-1a2b3c4d5e6f", /client secret/);
  said(REDIRECT, /redirect address/);
  said("https://other.chromiumapp.org/", /redirect address/);
  said("AIzaSyA-1234567890abcdef", /API key/);
  said("123456789012", /project number/);
  said("me@gmail.com", /email address/);
  said("123456789012-abc123def456.apps.googleuser", /missing/);
  said(".apps.googleusercontent.com", /missing/);
  said(`${CID} 999999999999-zzz111222333.apps.googleusercontent.com`, /more than one/);
  said("hello", /not a Client ID/);
  // Google's JSON file of the client
  const file = web => JSON.stringify({ web: { client_id: CID, project_id: "personal-mode-app", ...web } });
  ok(read(file({ redirect_uris: [REDIRECT] }), REDIRECT).id === CID && !read(file({ redirect_uris: [REDIRECT] }), REDIRECT).warn, "a client's JSON file gives its Client ID");
  const missing = read(file({ redirect_uris: ["https://x.chromiumapp.org/"] }), REDIRECT);
  ok(missing.id === CID && /redirect address/.test(missing.warn), "a file whose client lacks this copy's address is taken, with a warning: " + JSON.stringify(missing));
  said(JSON.stringify({ installed: { client_id: CID } }), /Desktop app/);
  said(JSON.stringify({ web: { client_secret: "GOCSPX-x" } }), /no Client ID/);
  said('{"web": {"client_id": "12', /part of Google's JSON file/);
  ok(projectOf(CID) === "123456789012" && projectOf("") === "" && projectOf("abc") === "", "the project number is the start of a Client ID");
}

// ---------- the routes ----------
{
  const quick = guide({ route: "quick", redirect: REDIRECT, project: "42" }), classic = guide({ route: "classic", redirect: REDIRECT, project: "42" });
  ok(quick.steps.map(s => s.id).join() === "create,paste,api,signin" && classic.steps.map(s => s.id).join() === "project,api,describe,publish,client,paste,signin", "the steps of both routes: " + [quick, classic].map(g => g.steps.map(s => s.id).join()).join(" / "));
  ok(ROUTES.join() === "quick,classic" && guide().route === "quick" && guide({ route: "nope" }).route === "quick", "the quick route is the default");
  for (const g of [quick, classic]) {
    ok(new Set(g.steps.map(s => s.id)).size === g.steps.length, `${g.route}: step ids are unique`);
    ok(g.steps.at(-1).signIn && g.steps.filter(s => s.signIn).length === 1 && g.steps.filter(s => s.paste).length === 1, `${g.route}: one paste step, and the sign-in last`);
    ok(g.steps.slice(0, -1).every(s => s.next || s.paste), `${g.route}: every step but the last can be left forwards`);
    ok(g.steps.filter(s => s.copy?.label === "This copy's redirect address").every(s => s.copy.value === REDIRECT) && g.steps.some(s => s.copy?.value === REDIRECT), `${g.route}: the step that makes the client shows this copy's address`);
    ok(g.other && ROUTES.includes(g.other.route) && g.other.route !== g.route && g.jump?.step === "paste", `${g.route}: the other route, and a jump to the paste step`);
    for (const s of g.steps) if (s.open) ok(/^https:\/\/console\.cloud\.google\.com\//.test(s.open.href), `${g.route}/${s.id}: opens a page of Google's console: ${s.open.href}`);
  }
  ok(quick.steps[0].open.href === "https://console.cloud.google.com/auth/overview/personal", "the quick route opens Personal mode");
  ok(quick.steps.find(s => s.id === "api").open.href === "https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=42", "the quick route's Gmail API page is the client's project's");
  ok(classic.steps.find(s => s.id === "api").open.href === "https://console.cloud.google.com/apis/library/gmail.googleapis.com", "the classic route switches the API on before there is a client, in the project selected");
  ok(classic.steps.at(-1).lines.some(l => /hasn't verified this app/.test(l)) && !quick.steps.at(-1).lines.some(l => /hasn't verified/.test(l)), "only the classic route warns of Google's unverified-app screen");
  ok(notes(true).length === notes(false).length + 1 && /same|made the client with/.test(notes(true)[0]), "an own client asks for the account it was made with");
  ok(/Gmail™/.test(INTRO) && /Google™/.test(INTRO) && (INTRO.match(/™/g) || []).length === 2, "the welcome marks Gmail and Google once each");
}

// ---------- failures ----------
{
  const entries = help({ redirect: REDIRECT, project: "42" });
  ok(new Set(entries.map(h => h.id)).size === entries.length && entries.every(h => h.says && h.fix.length), "help entries are unique, each with what Google said and a fix");
  for (const h of entries) if (h.open) ok(h.open.href.endsWith("?project=42"), `help ${h.id} opens the client's project: ${h.open.href}`);
  ok(entries.find(h => h.id === "redirect_uri_mismatch").copy.value === REDIRECT, "the redirect mismatch shows this copy's address");
  const e = (code, why = "something", google = "") => Object.assign(new Error(why), { code, why, google });
  for (const code of ["setup", "closed", "unreachable", "window", "denied", "refused", "answer", "api-off", "unconfirmed", "scope", "account"]) {
    const a = explain(e(code), { project: "42" });
    ok(a && /^[A-Z].*[.!?]$/.test(a.text.trim()), `${code} is explained in a sentence: ${JSON.stringify(a)}`);
  }
  ok(explain(null) === null && explain(e("session")) === null && explain(Object.assign(new Error("Not signed in to Google"), { code: "", why: "" })) === null, "nothing to explain where the page says enough itself");
  ok(explain(e("refused", "x", "org_internal")).pick === "org_internal" && explain(e("refused", "x", "made_up")).pick === "", "a refusal Google named opens its help entry");
  const off = explain(e("api-off"), { project: "42" });
  ok(off.held && off.button === "Continue" && off.open.href.endsWith("gmail.googleapis.com?project=42"), "the Gmail API being off links to it: " + JSON.stringify(off));
}

// ---------- text ----------
{
  const all = JSON.stringify([guide({ route: "quick", redirect: REDIRECT }), guide({ route: "classic", redirect: REDIRECT }), help({ redirect: REDIRECT }), INTRO, notes(true)]);
  const banned = String.fromCharCode(0x2014, 0x2026);      // the em-dash and the single-character ellipsis
  ok(![...banned].some(c => all.includes(c)), "no em-dash or single-character ellipsis in the guide's text");
  ok(!/\*\*|`/.test(all.replace(/\*\*[^*]+\*\*|`[^`]+`/g, "")), "every bold label and value is closed");
  // the guide on GitHub names every label the steps do, and every page they open
  const doc = fs.readFileSync(path.join(ROOT, "docs", "google-setup.md"), "utf8");
  const steps = ROUTES.flatMap(route => guide({ route, redirect: REDIRECT }).steps);
  const labels = [...new Set(steps.flatMap(s => [s.lead, ...(s.lines || [])]).join("\n").match(/\*\*[^*]+\*\*/g).map(b => b.slice(2, -2)))];
  const absent = labels.filter(l => !doc.includes(l));
  ok(!absent.length, "docs/google-setup.md names every label of the guide; missing: " + absent.join(", "));
  const pages = Object.values(PAGES).map(p => p("").replace(/\?.*/, ""));
  const unnamed = pages.filter(p => !doc.includes(p));
  ok(!unnamed.length, "docs/google-setup.md links every page the guide opens; missing: " + unnamed.join(", "));
}

console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
