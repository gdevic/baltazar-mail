// Browser tests for review findings: each scenario runs on a fresh profile against the mocked
// Yahoo in harness.js, so no scenario depends on another's state, and several processes can each
// run a share of them at once (--shard=k/n: every nth scenario from the kth; tools/check.js).
// node tools/review.js [filter] [--shard=k/n]
const { launch, msg } = require("./harness");

const scenarios = [];
const scenario = (name, fn, opts = {}) => scenarios.push({ name, fn, opts });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Settings for every scenario unless it sets its own: no undo-send hold, slow polling.
const BASE = { pollSec: 600, undoSendSec: 0 };
async function start(h, { settings = {}, noWait = false } = {}) {
  const offline = h.mock.offline;
  h.mock.offline = false;
  await h.open();
  await h.page.evaluate(s => chrome.storage.local.set({ settings: s }), { ...BASE, ...settings });
  h.mock.offline = offline;
  await h.page.reload();
  if (noWait) await h.page.waitForTimeout(1500); else await h.page.waitForSelector("#rows .row", { timeout: 15000 });
}
const folder = async (page, name) => { await page.locator("#folder-list .folder", { hasText: name }).first().click(); await page.waitForTimeout(500); };
const saves = calls => calls.filter(c => c.name === "messages.saveV3");
const msgOf = c => c?.envelope?.requests?.[0]?.payloadParts?.[0]?.payload;
const notice = async page => (await page.locator("#notice").isVisible()) ? await page.locator("#notice-text").textContent() : "";
const composerHidden = page => page.waitForFunction(() => document.getElementById("compose").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});

// A save answered the way Yahoo answers it: the stored draft lists its parts with part ids, and a
// part copied from the previous save keeps that part's filename.
let lastParts = new Map();
function savedDraft(top, extra = {}) {
  const m = top.payloadParts[0].payload.message;
  let n = 1;
  const attachments = (m.attachments || []).map(a => ({ partId: String(++n), disposition: a.disposition, contentId: a.contentId,
    filename: a.multipartName ? decodeURIComponent(a.multipartName.slice("multipart://".length)) : lastParts.get(a.messageReference?.pid) || "copied" }));
  lastParts = new Map(attachments.map(a => [a.partId, a.filename]));
  return { id: "MSGDRAFT_99", immutableid: "IMM99", csid: m.csid, headers: m.headers, attachments, ...extra };
}
const saveAnswer = (top, code = 200) => ({ responses: [{ id: "SaveMessage", httpCode: code, response: { result: { message: savedDraft(top) } } },
  ...(top.requests || []).map(r => ({ id: r.id, httpCode: 200, response: { result: { message: savedDraft(top) } } }))] });

async function newMessage(page, { to = "q@example.com", subject = "Test", text = "" } = {}) {
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  await page.locator("#c-to input").type(to); await page.keyboard.press("Enter");
  await page.fill("#c-subject", subject);
  await page.locator("#c-editor").focus();
  if (text) await page.keyboard.type(text);
}

// ---------- images that must not load ----------
// Every way a message can ask for an image: probes on Yahoo's own hosts (they would carry the
// user's cookies) and trackers behind Yahoo's image proxy.
const LEAKY = `<svg width="10" height="10"><image href="https://cloud-apis.mail.yahoo.com/probe-svg" width="10" height="10"/></svg>` +
  `<img src="https://cloud-apis.mail.yahoo.com/probe-img" width="5" height="5">` +
  `<div style="width:9px;height:9px;background:url(https://cloud-apis.mail.yahoo.com/probe-bg)"></div>` +
  `<picture><source srcset="https://ecp.yusercontent.com/t-source.png"><img src="https://ecp.yusercontent.com/t-img.png"></picture>` +
  `<video poster="https://ecp.yusercontent.com/t-poster.png" width="9" height="9"></video>` +
  `<svg width="10" height="10"><image href="https://ecp.yusercontent.com/t-svg.png" width="10" height="10"/></svg>` +
  `<div style="width:9px;height:9px;background-image:image-set('https://ecp.yusercontent.com/t-set.png' 1x)"></div>` +
  `<style>.esc{background:\\75 rl(https://ecp.yusercontent.com/t-esc.png)}</style><div class="esc" style="width:9px;height:9px"></div>`;
const leakyIn = prefix => (id, message, body) => { if (id.startsWith(prefix)) body.html += LEAKY; };
const trackers = (mock, from) => mock.images.filter(i => /\/t-/.test(i.url) && i.from.includes(from)).map(i => i.url.split("/").pop());
async function printOpen(h) {
  const [p] = await Promise.all([h.ctx.waitForEvent("page"), h.page.keyboard.press("p")]);
  await p.waitForSelector(".msg .body", { timeout: 8000 });
  await p.waitForTimeout(1200);
  return p;
}

scenario("a message fetches only its own inline parts", async ({ page, mock }, expect) => {
  mock.patchBody = (id, m, body) => { if (id === "MSG1_2") body.html += '<img src="https://cloud-apis.mail.yahoo.com/ws/v3/mailboxes/@.id==MB1/messages/@.id==MSG1_7/content/parts/@.id==3/thumbnail&amp;appid=x">'; };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(900);
  const own = mock.parts.filter(u => u.includes("@.id==MSG1_2/")).length, other = mock.parts.filter(u => u.includes("@.id==MSG1_7/"));
  expect(own > 0 && !other.length, "only the open message's parts are fetched: " + JSON.stringify({ own, other }));
});

scenario("printing loads no Yahoo-host image", async (h, expect) => {
  h.mock.patchBody = leakyIn("MSG1_");
  await h.page.locator("#rows .row").nth(1).click(); await h.page.waitForTimeout(600);
  const p = await printOpen(h);
  expect(!h.mock.probes.length, "no request for a Yahoo host from the print page: " + JSON.stringify(h.mock.probes));
  expect(trackers(h.mock, "print.html").length > 0, "images through Yahoo's proxy still print when allowed: " + JSON.stringify(trackers(h.mock, "print.html")));
  await p.close();
}, { allow: /Content Security Policy|probe-|ERR_NAME_NOT_RESOLVED|status of 404/ });

scenario("printing from Spam loads no remote image", async (h, expect) => {
  h.mock.patchBody = leakyIn("MSG6_");
  await folder(h.page, "Spam");
  await h.page.locator("#rows .row").first().click(); await h.page.waitForTimeout(600);
  const p = await printOpen(h);
  expect(!trackers(h.mock, "print.html").length && !h.mock.probes.length, "a Spam message prints without remote images: " + JSON.stringify({ trackers: trackers(h.mock, "print.html"), probes: h.mock.probes }));
  await p.close();
}, { allow: /Content Security Policy|probe-|ERR_NAME_NOT_RESOLVED|status of 404/ });

scenario("a reply's quoted original loads no Yahoo-host image", async (h, expect) => {
  h.mock.patchBody = leakyIn("MSG1_");
  await h.page.locator("#rows .row").nth(1).click(); await h.page.waitForTimeout(600);
  await h.page.locator("#list").focus(); await h.page.keyboard.press("r"); await h.page.waitForSelector("#compose:not(.hidden)");
  await h.page.waitForTimeout(800);
  expect(!h.mock.probes.length, "the quote frame requests no Yahoo host: " + JSON.stringify(h.mock.probes));
}, { allow: /Content Security Policy|probe-|ERR_NAME_NOT_RESOLVED|status of 404/ });

scenario("a reopened draft loads no Yahoo-host image", async (h, expect) => {
  h.mock.patchBody = leakyIn("MSG3_");
  await folder(h.page, "Draft");
  await h.page.locator("#rows .row").first().click();
  await h.page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 });
  await h.page.waitForTimeout(800);
  expect(!h.mock.probes.length, "the draft editor requests no Yahoo host: " + JSON.stringify(h.mock.probes));
}, { allow: /Content Security Policy|probe-|ERR_NAME_NOT_RESOLVED|status of 404/ });

// ---------- links ----------
scenario("relative links cannot open extension pages", async (h, expect) => {
  const { page } = h;
  h.mock.patchBody = (id, m, body) => { if (id.startsWith("MSG1_")) body.html += '<a id="l-rel" href="print.html?job=ymSession">rel</a> <a id="l-proto" href="//evil.example/x">proto</a>' +
    ' <a id="l-anc" href="#sec">anchor</a> <a id="l-web" href="https://example.com/">web</a> <a id="l-mail" href="mailto:a@b.c">mail</a><div style="height:3000px"></div><h2 id="sec">Section</h2>'; };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(700);
  const links = await page.frameLocator("#r-body").locator("a[id^=l-]").evaluateAll(as => Object.fromEntries(as.map(a => [a.id, { href: a.getAttribute("href"), target: a.getAttribute("target") }])));
  expect(links["l-rel"]?.href == null && links["l-proto"]?.href == null, "relative and scheme-relative links lose their target: " + JSON.stringify(links));
  expect(links["l-web"]?.target === "_blank" && links["l-mail"]?.href === "mailto:a@b.c", "web and mail links stay: " + JSON.stringify(links));
  const pages = h.ctx.pages().length;
  await page.frameLocator("#r-body").locator("#l-anc").evaluate(a => a.click()); await page.waitForTimeout(500);   // the harness overlay covers it
  const scrolled = await page.frameLocator("#r-body").locator("#sec").evaluate(e => ({ hash: e.ownerDocument.location.hash, top: Math.round(e.getBoundingClientRect().top), sy: e.ownerDocument.defaultView.scrollY }));
  expect(h.ctx.pages().length === pages && scrolled.sy > 1000, "an anchor link scrolls the message, no new tab: " + JSON.stringify({ tabs: h.ctx.pages().length - pages, scrolled }));
  // the print page ignores a job name that is not a print job
  const had = await page.evaluate(async () => !!(await chrome.storage.session.get("ymSession")).ymSession);
  const p = await h.ctx.newPage(); await p.goto(`chrome-extension://${h.extId}/print.html?job=ymSession`); await p.waitForTimeout(500);
  const still = await page.evaluate(async () => !!(await chrome.storage.session.get("ymSession")).ymSession);
  expect(had && still, "print.html?job=ymSession leaves the session alone: " + JSON.stringify({ had, still }));
  await p.close();
}, { allow: /Blocked script execution in 'about:srcdoc'/ });   // Playwright's own click in the frame

scenario("links lose their tracking only when the setting asks, and the open message follows", async (h, expect) => {
  const { page } = h;
  const tracked = "https://example.com/story?id=7&utm_source=news&fbclid=x", plain = "https://example.com/story?id=7";
  const wrapped = "https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fp%3Futm_medium%3Demail&sa=D";
  const share = "https://www.facebook.com/sharer.php?u=https%3A%2F%2Fexample.com%2F";
  const attr = s => s.replace(/&/g, "&amp;");
  h.mock.patchBody = (id, m, body) => { if (id.startsWith("MSG1_")) body.html += `<a id="t-utm" href="${attr(tracked)}">${attr(tracked)}</a> <a id="t-wrap" href="${attr(wrapped)}">wrapped</a> <a id="t-share" href="${attr(share)}">share</a>`; };
  const read = () => page.frameLocator("#r-body").locator("a[id^=t-]").evaluateAll(as => Object.fromEntries(as.map(a => [a.id, { href: a.getAttribute("href"), text: a.textContent }])));
  const choose = async value => { await page.click("#gear"); await page.click(`input[name=links][value=${value}]`); await page.waitForTimeout(700); await page.click("#settings-close"); };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(700);
  const before = await read();
  expect(before["t-utm"]?.href === tracked && before["t-wrap"]?.href === wrapped && before["t-utm"]?.text === tracked, "by default links stay as written: " + JSON.stringify(before));
  await choose("clean");
  const after = await read();
  expect(after["t-utm"]?.href === plain && after["t-utm"]?.text === plain, "a tracked link and its written-out text are cleaned in the open message: " + JSON.stringify(after["t-utm"]));
  expect(after["t-wrap"]?.href === "https://example.org/p" && after["t-wrap"]?.text === "wrapped", "a Google redirect is unwrapped and cleaned, its text kept: " + JSON.stringify(after["t-wrap"]));
  expect(after["t-share"]?.href === share, "a share link keeps its destination parameter: " + JSON.stringify(after["t-share"]));
  const stored = await page.evaluate(async () => (await chrome.storage.local.get("settings")).settings.links);
  expect(stored === "clean", "the choice is saved: " + stored);
  await choose("asis");
  const again = await read();
  expect(again["t-utm"]?.href === tracked && again["t-wrap"]?.href === wrapped, "back to as written, again in place: " + JSON.stringify(again));
});

// ---------- attachments ----------
scenario("a previewed file's type comes from its name, not the sender", async ({ page, mock }, expect) => {
  mock.patchBody = (id, m) => { if (id.startsWith("MSG1_")) { m.attachments[3].filename = "pic.avif"; m.attachments[3].subtype = "avif"; } };
  mock.patchRaw = raw => raw.replace('Content-Type: image/png; name="photo.png"', 'Content-Type: text/html; name="pic.avif"');
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  await page.locator("#r-attach .att-card").nth(3).click();
  await page.waitForSelector("#v-body img.v-img", { timeout: 10000 });
  const type = await page.locator("#v-body img.v-img").evaluate(async i => (await (await fetch(i.src)).blob()).type);
  expect(type === "image/avif", "the preview blob is typed by the file name: " + type);
  const thumb = await page.evaluate(() => [...document.querySelectorAll("#r-attach .att-thumb img")].every(i => i.getAttribute("alt") === "" && i.src.startsWith("data:")));
  expect(thumb, "thumbnails are image elements with data: sources");
});

// ---------- address book ----------
scenario("the address book survives a repeated full build and a second tab", async (h, expect) => {
  const { page } = h;
  const counts = () => page.evaluate(async () => { const c = await import("./contacts.js"); return JSON.stringify((await c.all()).sort((a, b) => a.email.localeCompare(b.email))); });
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  const first = await counts();
  // a full build again (as after an interrupted first build) leaves the same entries
  await page.evaluate(async () => { const c = await import("./contacts.js"); await c.sync({ inbox: "1", sent: "2", full: true }); });
  const again = await counts();
  expect(first.length > 2 && again === first && !/"(sent|received)"/.test(again), "a second full build leaves the same entries, without counts: " + JSON.stringify({ first, again }).slice(0, 400));
  // another tab hides an address; this tab then records mail to it
  const other = await h.ctx.newPage(); await other.goto(`chrome-extension://${h.extId}/mail.html`); await other.waitForSelector("#rows .row", { timeout: 15000 });
  await other.evaluate(async () => { const c = await import("./contacts.js"); await c.hide("s2@x.com"); });
  await page.evaluate(async () => { const c = await import("./contacts.js"); await c.noteSent([{ email: "s2@x.com" }]); });
  const seen = await other.evaluate(async () => { const c = await import("./contacts.js"); return c.lookup("s2@x.com"); });
  const here = await page.evaluate(async () => { const c = await import("./contacts.js"); return c.lookup("s2@x.com"); });
  expect(seen?.hidden && here?.hidden, "a hide in one tab survives a write in another: " + JSON.stringify({ other: seen?.hidden, here: here?.hidden }));
  await other.close();
}, { settings: { pollSec: 600 } });

scenario("the address book's build reads the mail filed in other folders, and passes over what Sent, Inbox and Drafts hold", async (h, expect) => {
  const { page } = h;
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the app's own build has finished
  // all mail, as the build asks for it (no folder, no search term): a row of Inbox and one of Sent,
  // a draft to s9, and a message filed in Projects, from someone nothing else names
  const asked = [];
  h.mock.handler = ({ top, uri }) => {
    const q = decodeURIComponent(uri.split("q=")[1] || "");
    if (!uri.includes("@.select==q") || /(^|[^-])folderId:|from:|keyword:|subject:|is:|has:|(^|\s)id:/.test(q)) return null;
    asked.push(q);
    const filed = { ...msg(1, "31"), id: "MSG31_filed", folder: { id: "31", name: "Projects", types: ["USER"] },
      headers: { ...msg(1, "31").headers, from: [{ name: "Filed Away", email: "filed@y.example" }], cc: [{ name: "", email: "copied@email.y.example" }] } };
    const messages = / offset:0 /.test(q) ? [msg(1, "1"), msg(1, "2"), fromMe(9, "3", "Draft", ["DRAFT"]), filed] : [];
    return { responses: [{ id: top.id, httpCode: 200, response: { result: { messages, query: {} } } }] };
  };
  const r = await page.evaluate(async () => {
    const c = await import("./contacts.js");
    const n = await c.sync({ inbox: "1", sent: "2", drafts: "3", full: true });
    const copied = await c.lookup("copied@email.y.example");
    return { n, filed: await c.lookup("filed@y.example"), copied, pile: copied && c.pileOf(copied), draft: await c.lookup("s9@x.com") };
  });
  expect(asked.length === 1 && asked[0] === "-folderType:(TRASH)-folderType:(BULK) -folderType:(SYNC)-folderType:(INVISIBLE) -folderId:2 -folderId:1 -folderId:3 count:100 offset:0 -sort:date", "after Sent and Inbox the build asks for the mail of every other folder but Drafts, once while a page comes back short: " + JSON.stringify(asked));
  expect(r.n === 17 && r.filed?.name === "Filed Away" && !r.filed.lastSent && r.copied?.copied && r.pile === "others" && r.draft === null,
    "it learns from the filed message alone: the rows of Sent and Inbox were read there, and a draft is no writing to anyone: " + JSON.stringify(r));
}, { settings: { pollSec: 600 } });

scenario("an address book of another database version is invalidated once: a lower one is built anew keeping what the user chose, a higher one is dropped", async (h, expect) => {
  const { page } = h;
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the app's own build has finished
  // From a page of the extension that does not open the book: a book kept under the given version,
  // marked as built and with its scans' bookmarks, holding an address no mail names, one the user
  // hid, one the user pinned, and a sender under an old name and a writing to them that the mail does not show.
  const seed = async version => { await page.goto(`chrome-extension://${h.extId}/mail.css`); await page.evaluate(version => new Promise((ok, no) => {
    const del = indexedDB.deleteDatabase("baltazar-mail");
    del.onerror = () => no(del.error);
    del.onsuccess = () => {
      const req = indexedDB.open("baltazar-mail", version);
      req.onupgradeneeded = () => { req.result.createObjectStore("contacts", { keyPath: "email" }); req.result.createObjectStore("meta", { keyPath: "key" }); };
      req.onerror = () => no(req.error);
      req.onsuccess = () => {
        const d = req.result, t = d.transaction(["contacts", "meta"], "readwrite");
        for (const row of [{ email: "gone@old.example", name: "Long Gone", nameBy: { self: { "Long Gone": 1 } }, last: 1500000000, lastSent: 0 },
          { email: "hid@old.example", name: "Hid Den", nameBy: { self: { "Hid Den": 1 } }, last: 1500000000, lastSent: 0, hidden: true },
          { email: "pin@old.example", name: "Pin Ned", nameBy: { self: { "Pin Ned": 1 } }, last: 1500000000, lastSent: 0, pinned: 1600000000 },
          { email: "s1@x.com", name: "Old Name", nameBy: { self: { "Old Name": 9 } }, last: 1500000000, lastSent: 1500000000 }]) t.objectStore("contacts").put(row);
        for (const m of [{ key: "built", value: 1600000000000 }, { key: "scan:1", value: { newest: 9999999999, at: 1 } }, { key: "scan:2", value: { newest: 9999999999, at: 1 } }]) t.objectStore("meta").put(m);
        t.oncomplete = () => { d.close(); ok(); }; t.onerror = () => no(t.error);
      };
    };
  }), version); };
  // the book as the app has it, with the version the database is kept under and when it was built
  const read = () => page.evaluate(async () => {
    const c = await import("./contacts.js");
    const kept = await new Promise(ok => { const req = indexedDB.open("baltazar-mail"); req.onsuccess = () => { const d = req.result, g = d.transaction("meta").objectStore("meta").get("built"); g.onsuccess = () => { d.close(); ok({ version: d.version, builtAt: g.result?.value || 0 }); }; }; });
    return { gone: await c.lookup("gone@old.example"), hid: await c.lookup("hid@old.example"), pin: await c.lookup("pin@old.example"), s1: await c.lookup("s1@x.com"), ...kept, now: c.DB_VERSION };
  });
  const built = async () => { await page.waitForSelector("#rows .row", { timeout: 15000 }); await page.waitForFunction(() => /^Contacts: [\d,.\s]+ addresses/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {}); };
  await seed(1); await h.open(); await built();
  const first = await read();
  // opened again: the book is as it was, and nothing is built again
  await page.reload(); await page.waitForSelector("#rows .row", { timeout: 15000 }); await page.waitForTimeout(1500);
  const again = await read();
  // a book of a version this copy does not know yet
  await seed(first.now + 7); await h.open(); await built();
  const newer = await read();
  expect(first.now >= 2 && first.version === first.now && first.gone === null && first.hid?.hidden && first.hid.name === "" && first.pin?.pinned === 1600000000 && first.s1?.name === "Sender 1" && first.s1.lastSent === 0 && first.builtAt > 1600000000000,
    "a book of a lower version is built anew from the mail: what no mail names is gone, what the user hid and pinned stays, and the rest is as the mail has it: " + JSON.stringify(first));
  expect(again.builtAt === first.builtAt && JSON.stringify(again) === JSON.stringify(first), "once: opened again, the book is kept as built: " + JSON.stringify([first.builtAt, again.builtAt]));
  expect(newer.version === newer.now && newer.gone === null && newer.hid === null && newer.pin === null && newer.s1?.name === "Sender 1" && newer.builtAt > 1600000000000,
    "a book of a higher version is dropped whole and a new one built under this version: " + JSON.stringify(newer));
}, { settings: { pollSec: 600 } });

// ---------- Contacts ----------
// In the mocked mailbox o@x.com is the one person written to (it is copied on the mail in Sent);
// s1 to s8 only wrote, so they are among the others.
const contactsOpen = async page => {
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  await page.locator("#list").focus(); await page.keyboard.press("g"); await page.keyboard.press("c");
  await page.waitForSelector("#app.contacts-view #p-rows .prow", { timeout: 5000 }).catch(() => {});
};
const inContacts = (page, on = true) => page.waitForFunction(want => document.getElementById("app").classList.contains("contacts-view") === want, on, { timeout: 5000 }).catch(() => {});
const contactsTab = async (page, pile) => { await page.locator(`#p-show button[data-pile="${pile}"]`).click(); await page.waitForTimeout(250); };
const contactRow = (page, email) => page.locator(`#p-rows .prow[data-email="${email}"]`);
const inBook = (page, email) => page.evaluate(async e => !!(await (await import("./contacts.js")).lookup(e)), email);

scenario("Contacts shows a person's mail and comes back, keeps a pin across tabs, and writes to several people", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  const active = () => page.evaluate(() => document.activeElement.id);
  await folder(page, "Projects");
  await contactsOpen(page);
  r.open = { focus: await active(), on: await page.locator("#p-show button.on").getAttribute("data-pile"), first: await page.locator("#p-rows .prow").first().getAttribute("data-email") };
  // a filter that matches among the others leads there; Enter shows all mail with the person, and Esc comes back as it was left
  await page.keyboard.type("s4"); await page.waitForTimeout(250);
  await page.locator('#p-rows a[data-pile="others"]').click(); await page.waitForTimeout(250);
  await page.locator("#p-filter").focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await inContacts(page, false); await page.waitForSelector("#rows .row", { timeout: 5000 }).catch(() => {});
  r.mail = { title: await text("#list-title"), term: await page.inputValue("#search") };
  await page.keyboard.press("Escape"); await inContacts(page);
  await page.waitForSelector("#p-rows .prow.sel", { timeout: 5000 }).catch(() => {});
  r.back = { on: await page.locator("#p-show button.on").getAttribute("data-pile"), filter: await page.inputValue("#p-filter"), sel: await text("#p-rows .prow.sel .pm"), focus: await active() };
  // a message on the person's page opens in their mail
  await page.waitForSelector("#person .p-msg", { timeout: 5000 }).catch(() => {});
  await page.locator("#person .p-msg").nth(2).click();
  await inContacts(page, false); await page.waitForSelector("#rows .row.sel", { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById("r-subject").textContent, null, { timeout: 5000 }).catch(() => {});
  r.opened = { at: await page.evaluate(() => [...document.querySelectorAll("#rows .row")].findIndex(x => x.classList.contains("sel"))), subject: await text("#r-subject") };
  await page.keyboard.press("Escape"); await inContacts(page);
  await page.keyboard.press("Escape"); await page.waitForTimeout(250);      // the filter's text
  r.cleared = await page.inputValue("#p-filter");
  // s pins the person under the cursor: first in People, here and in a tab opened afterwards
  await contactRow(page, "s4@x.com").click(); await page.keyboard.press("s");
  await page.waitForFunction(() => /^pinned/.test(document.getElementById("st-msg").textContent), null, { timeout: 5000 }).catch(() => {});
  await contactsTab(page, "people");
  r.pinned = { first: await page.locator("#p-rows .prow").first().getAttribute("data-email"), heads: (await page.locator("#p-rows .day").allTextContents()).join(), undo: await text("#st-undo") };
  const other = await h.ctx.newPage(); await other.goto(`chrome-extension://${h.extId}/mail.html`); await other.waitForSelector("#rows .row", { timeout: 15000 });
  await other.locator("#contacts-link").click(); await other.waitForSelector("#p-rows .prow", { timeout: 5000 }).catch(() => {});
  r.otherTab = await other.locator("#p-rows .prow").first().getAttribute("data-email").catch(() => "");
  await other.close();
  // the last three of the others, marked as a range, get one message
  await contactsTab(page, "others");
  const rows = page.locator("#p-rows .prow"), n = await rows.count();
  await rows.nth(n - 1).click(); await rows.nth(n - 3).click({ modifiers: ["Shift"] });
  r.marked = { rows: await page.locator("#p-rows .prow.marked").count(), title: await text("#person .p-name") };
  await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)", { timeout: 5000 }).catch(() => {});
  r.to = await page.locator("#c-to .chip").allTextContents();
  // Esc closes the composer, then the selection, then Contacts: back in the folder it was opened from
  await page.locator("#c-subject").focus(); await page.keyboard.press("Escape"); await composerHidden(page);
  await page.locator("#list").focus();
  await page.keyboard.press("Escape");
  r.unmarked = await page.locator("#p-rows .prow.marked").count();
  await page.keyboard.press("Escape"); await inContacts(page, false); await page.waitForSelector("#rows .row", { timeout: 5000 }).catch(() => {});
  r.left = await text("#list-title");
  expect(r.open.focus === "p-filter" && r.open.on === "people" && r.open.first === "o@x.com", "Contacts opens on the people written to, the filter ready: " + JSON.stringify(r.open));
  expect(r.mail.title === "“s4@x.com” in all mail" && r.mail.term === "s4@x.com" && r.back.on === "others" && r.back.filter === "s4" && r.back.sel === "s4@x.com" && r.back.focus === "p-filter",
    "Enter shows all mail with the person, and Esc comes back to Contacts as it was left: " + JSON.stringify(r));
  expect(r.opened.at === 2 && r.opened.subject === "Subject 1-3" && r.cleared === "", "a message on the person's page is opened in their mail: " + JSON.stringify(r.opened));
  expect(r.pinned.first === "s4@x.com" && r.pinned.heads === "Pinned,Written to" && r.pinned.undo === "Undo: pin Sender 4 (z)" && r.otherTab === "s4@x.com", "a pinned person is listed first in People, in another tab too: " + JSON.stringify([r.pinned, r.otherTab]));
  expect(r.marked.rows === 3 && r.marked.title === "3 contacts selected" && r.to.length === 3 && r.to.every(t => /^Sender [678] /.test(t)), "c writes one message to everyone selected: " + JSON.stringify([r.marked, r.to]));
  expect(r.unmarked === 0 && r.left === "Projects", "Esc clears the selection, then leaves for the folder Contacts was opened from: " + JSON.stringify([r.unmarked, r.left]));
}, { settings: { pollSec: 600 } });

// A person's search answered as the test says: empty for s7, s3 and the copied address (no mail
// from or to them is found), for s5 the one message they sent, and for s6 a reply of the user's
// kept in Projects, with a draft to s8 that was never sent. h.asked lists whose mail was asked for.
const COPIED = "kim@email.isp.example";
const fromMe = (i, folderId, name, types) => { const m = msg(i, folderId); return { ...m, id: `${m.id}_mine`, folder: { id: folderId, name, types }, headers: { ...m.headers, from: [{ name: "Me Myself", email: "me@yahoo.com" }], to: [{ name: `Sender ${i}`, email: `s${i}@x.com` }], cc: [] } }; };
const mailWith = h => {
  h.asked = [];
  h.mock.handler = ({ top, uri }) => {
    const q = decodeURIComponent(uri.split("q=")[1] || "");
    const who = (q.match(/from:\("([^"]+)"\) OR to:/) || [])[1];
    if (who) h.asked.push(who);
    const messages = who === "s7@x.com" || who === "s3@x.com" || who === COPIED ? [] : who === "s5@x.com" ? [msg(5, "1")]
      : who === "s6@x.com" ? [fromMe(6, "31", "Projects", ["USER"]), msg(6, "1")] : who === "s8@x.com" ? [fromMe(8, "3", "Draft", ["DRAFT"]), msg(8, "1")] : null;
    return messages ? { responses: [{ id: top.id, httpCode: 200, response: { result: { messages, query: {} } } }] } : null;
  };
};
scenario("Contacts forgets an address with no mail left, on its page and when its mail is deleted, and undo brings it back", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  mailWith(h);
  await contactsOpen(page);
  await contactsTab(page, "others");
  // the buttons that would find nothing are greyed out, with the reason: s5 only ever wrote
  await contactRow(page, "s5@x.com").click();
  await page.waitForSelector("#person .p-msg", { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#person button[data-p="to"]')?.disabled, null, { timeout: 3000 }).catch(() => {});
  const button = async p => ({ off: await page.locator(`#person button[data-p="${p}"]`).isDisabled(), why: await page.locator(`#person button[data-p="${p}"]`).getAttribute("title") });
  r.grey = { mail: await button("mail"), from: await button("from"), to: await button("to") };
  // s7 has no mail left: opening it forgets it, nobody is selected, and the arrows carry on from its place
  await contactRow(page, "s7@x.com").click();
  await page.waitForFunction(() => !document.querySelector('#p-rows .prow[data-email="s7@x.com"]'), null, { timeout: 5000 }).catch(() => {});
  r.forgot = { listed: await contactRow(page, "s7@x.com").count(), inBook: await inBook(page, "s7@x.com"), said: await text("#person .p-none"), undo: await text("#st-undo"), sel: await page.locator("#p-rows .prow.sel").count() };
  await page.keyboard.press("ArrowDown");
  r.next = await page.locator("#p-rows .prow.sel").getAttribute("data-email").catch(() => "");
  // z brings it back, and it is then left alone
  await page.keyboard.press("z");
  await page.waitForSelector('#p-rows .prow[data-email="s7@x.com"]', { timeout: 5000 }).catch(() => {});
  await contactRow(page, "s7@x.com").click();
  await page.waitForFunction(() => /brought back/.test(document.querySelector("#person .p-recent")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  r.spared = { listed: await contactRow(page, "s7@x.com").count(), inBook: await inBook(page, "s7@x.com"), said: await text("#person .p-recent"), mailOff: await page.locator('#person button[data-p="mail"]').isDisabled() };
  // deleting the only mail with s3 forgets s3, a little later; undoing the delete brings s3 back
  await page.keyboard.press("Escape"); await inContacts(page, false);
  await page.waitForSelector("#rows .row", { timeout: 5000 }).catch(() => {});
  r.before = await inBook(page, "s3@x.com");
  await page.locator('#rows .row:has(.fr[data-email="s3@x.com"])').first().click(); await page.waitForTimeout(300);
  await page.locator("#list").focus(); await page.keyboard.press("#");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Undo: delete"), null, { timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 30 && await inBook(page, "s3@x.com"); i++) await page.waitForTimeout(250);
  r.deleted = { s3: await inBook(page, "s3@x.com"), o: await inBook(page, "o@x.com") };
  await page.locator("#list").focus(); await page.keyboard.press("z");
  for (let i = 0; i < 30 && !(await inBook(page, "s3@x.com")); i++) await page.waitForTimeout(250);
  r.undone = await inBook(page, "s3@x.com");
  // o@x.com is copied on that message: it is kept without a search being asked about it
  r.asked = { s3: h.asked.includes("s3@x.com"), o: h.asked.includes("o@x.com") };
  expect(r.asked.s3 && !r.asked.o, "the delete asks about the sender's mail, and not about the address the message was copied to: " + JSON.stringify(r.asked));
  expect(!r.grey.mail.off && !r.grey.from.off && r.grey.to.off && r.grey.to.why === "No mail to this address", "Mail to is greyed out for someone who only ever wrote, and nothing else is: " + JSON.stringify(r.grey));
  expect(r.forgot.listed === 0 && !r.forgot.inBook && /^Sender 7 was forgotten: no mail with s7@x\.com is left/.test(r.forgot.said) && r.forgot.undo === "Undo: forget Sender 7 (z)" && r.forgot.sel === 0 && r.next === "s8@x.com",
    "a person whose page finds no mail is forgotten, and the arrows carry on from their place: " + JSON.stringify([r.forgot, r.next]));
  expect(r.spared.listed === 1 && r.spared.inBook && /No mail with this address is left outside Spam and Trash\. It was brought back/.test(r.spared.said) && r.spared.mailOff, "z brings the person back, and they are left alone after that: " + JSON.stringify(r.spared));
  expect(r.before && !r.deleted.s3 && r.deleted.o && r.undone, "deleting the last mail with an address forgets it, and undoing the delete brings it back: " + JSON.stringify([r.before, r.deleted, r.undone]));
}, { settings: { pollSec: 600 } });

scenario("Contacts keeps an address mail was copied to, and lists under People whoever a message of the user's own is found for", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  const on = () => page.locator("#p-show button.on").getAttribute("data-pile");
  mailWith(h);
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  // an address known only from the Cc of a message two days old, at a bulk-mail subdomain
  await page.evaluate(async ([email, when]) => { const c = await import("./contacts.js"); await c.learn([{ headers: { date: String(when), from: [{ name: "Sender 1", email: "s1@x.com" }], to: [{ name: "Me", email: "me@yahoo.com" }], cc: [{ name: "Kim Novak", email }] } }]); },
    [COPIED, Math.floor(Date.now() / 1000) - 2 * 86400]);
  await contactsOpen(page);
  await contactsTab(page, "others");
  r.listed = await contactRow(page, COPIED).count();
  // its page finds no mail from or to it: it stays, and the page says why
  await contactRow(page, COPIED).click();
  await page.waitForFunction(() => /No mail with this address was found/.test(document.querySelector("#person .p-recent")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  r.kept = { asked: h.asked.includes(COPIED), said: await text("#person .p-recent"), row: await contactRow(page, COPIED).count(), inBook: await inBook(page, COPIED), undo: await text("#st-undo"),
    forgot: await page.evaluate(async e => (await (await import("./contacts.js")).forget([e])).length, COPIED) };
  // s8's page finds a draft to them, which is no writing to them: s8 stays among the others
  await contactRow(page, "s8@x.com").click();
  await page.waitForSelector("#person .p-msg", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  r.draft = { on: await on(), stats: await text("#person .p-stats"), msgs: await page.locator("#person .p-msg").count() };
  // s6's page finds a reply of the user's kept in Projects: s6 is shown under People, still selected
  await contactRow(page, "s6@x.com").click();
  await page.waitForFunction(() => document.querySelector("#p-show button.on")?.dataset.pile === "people", null, { timeout: 5000 }).catch(() => {});
  await page.waitForSelector("#person .p-msg", { timeout: 5000 }).catch(() => {});
  r.wrote = { on: await on(), sel: await page.locator("#p-rows .prow.sel").getAttribute("data-email").catch(() => ""), stats: await text("#person .p-stats"), status: await text("#st-msg"), msgs: await page.locator("#person .p-msg").count(),
    off: await page.locator('#person button[data-p="to"]').isDisabled() };
  await contactsTab(page, "others");
  r.left = await contactRow(page, "s6@x.com").count();
  expect(r.listed === 1 && r.kept.asked && r.kept.said === "No mail with this address was found. It stays in Contacts because mail was copied to it (Cc or Bcc)." && r.kept.row === 1 && r.kept.inBook && !/forget/.test(r.kept.undo) && r.kept.forgot === 0,
    "an address mail was copied to is one of the others, and stays when no mail from or to it is found: " + JSON.stringify([r.listed, r.kept]));
  expect(r.draft.on === "others" && /you have not written to this address/.test(r.draft.stats) && r.draft.msgs === 2, "a draft to someone is no writing to them: " + JSON.stringify(r.draft));
  expect(r.wrote.on === "people" && r.wrote.sel === "s6@x.com" && /you last wrote/.test(r.wrote.stats) && r.wrote.status === "s6@x.com is under People: you wrote to it" && r.wrote.msgs === 2 && !r.wrote.off && r.left === 0,
    "a person whose page shows a message the user wrote is listed under People, still selected: " + JSON.stringify([r.wrote, r.left]));
}, { settings: { pollSec: 600 } });

scenario("the eye and the pin of a selected row act on everyone selected, and of another row on that row alone", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  const count = async pile => Number((await page.locator(`#p-show button[data-pile="${pile}"] i`).textContent()).replace(/\D/g, ""));
  await contactsOpen(page);
  await contactsTab(page, "others");
  const rows = page.locator("#p-rows .prow"), n = await rows.count(), before = { hidden: await count("hidden"), people: await count("people") };
  // three rows selected as a range: the eye of the middle one says so, and hides all three
  await rows.nth(0).click(); await rows.nth(2).click({ modifiers: ["Shift"] });
  r.tips = [await rows.nth(1).locator(".pe").getAttribute("title"), await rows.nth(3).locator(".pe").getAttribute("title")];
  await rows.nth(1).hover(); await rows.nth(1).locator(".pe").click();
  await page.waitForFunction(want => document.querySelectorAll("#p-rows .prow").length === want, n - 3, { timeout: 5000 }).catch(() => {});
  r.hid = { left: await rows.count(), hidden: await count("hidden"), status: await text("#st-msg"), undo: await text("#st-undo"), marked: await page.locator("#p-rows .prow.marked").count() };
  // two rows selected: the pin of a row outside the selection pins that row alone, and the selection stays
  await rows.nth(0).click(); await rows.nth(1).click({ modifiers: ["Control"] });
  const other = await rows.nth(3).getAttribute("data-email");
  await rows.nth(3).hover(); await rows.nth(3).locator(".pk").click();
  await page.waitForFunction(e => !document.querySelector(`#p-rows .prow[data-email="${e}"]`), other, { timeout: 5000 }).catch(() => {});
  r.one = { status: await text("#st-msg"), marked: await page.locator("#p-rows .prow.marked").count(), people: await count("people") };
  // the pin of a selected row pins both
  await rows.nth(0).hover(); await rows.nth(0).locator(".pk").click();
  await page.waitForFunction(() => /^pinned 2 contacts/.test(document.getElementById("st-msg").textContent), null, { timeout: 5000 }).catch(() => {});
  r.both = { status: await text("#st-msg"), people: await count("people"), left: await rows.count() };
  // one pinned and two others selected in People are hidden but for the pinned one, which the status line says
  await contactsTab(page, "people");
  await page.locator("#list").focus(); await page.keyboard.press("Control+a");
  r.all = await page.locator("#p-rows .prow.marked").count();
  await page.keyboard.press("h");
  await page.waitForFunction(() => /^hid /.test(document.getElementById("st-msg").textContent), null, { timeout: 5000 }).catch(() => {});
  r.mixed = { status: await text("#st-msg"), people: await count("people") };
  expect(n >= 6 && r.tips[0] === "Hide the 3 selected contacts" && /^Hide: /.test(r.tips[1]) && r.hid.left === n - 3 && r.hid.hidden === before.hidden + 3 && r.hid.status === "hid 3 contacts; Hidden has them" && r.hid.undo === "Undo: hide 3 contacts (z)" && r.hid.marked === 0,
    "the eye of a selected row hides everyone selected: " + JSON.stringify([n, r.tips, r.hid]));
  expect(/^pinned Sender \d$/.test(r.one.status) && r.one.marked === 2 && r.one.people === before.people + 1, "the pin of a row outside the selection pins that row alone, and the selection stays: " + JSON.stringify(r.one));
  expect(r.both.status === "pinned 2 contacts" && r.both.people === before.people + 3 && r.both.left === n - 6, "the pin of a selected row pins everyone selected: " + JSON.stringify(r.both));
  expect(r.all === before.people + 3 && r.mixed.status === `hid ${before.people === 1 ? "Other" : `${before.people} contacts`}; Hidden has ${before.people === 1 ? "it" : "them"}; 3 pinned left as they were` && r.mixed.people === 3,
    "hiding a selection leaves the pinned ones, and says how many: " + JSON.stringify([r.all, r.mixed]));
}, { settings: { pollSec: 600 } });

scenario("Rename gives a contact a name of the user's own, which undo and an empty name take back, and which keeps the contact", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  const named = (email, name) => page.waitForFunction(([e, n]) => document.querySelector(`#p-rows .prow[data-email="${e}"] .pn`)?.textContent === n, [email, name], { timeout: 5000 }).catch(() => {});
  const book = email => page.evaluate(async e => { const c = await (await import("./contacts.js")).lookup(e); return c && { name: c.name, given: c.given }; }, email);
  mailWith(h);
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  // s7 named by the user, and an address no name is known for
  await page.evaluate(async now => { const c = await import("./contacts.js"); await c.rename("s7@x.com", "Seven");
    await c.learn([{ headers: { date: String(now), from: [{ name: "Sender 1", email: "s1@x.com" }], to: [{ name: "", email: "don.violi2@y.example" }] } }]); }, Math.floor(Date.now() / 1000) - 60);
  await contactsOpen(page);
  await contactsTab(page, "others");
  // for an address with no name the box is empty, and nothing is read off the address
  await contactRow(page, "don.violi2@y.example").click(); await page.keyboard.press("F2");
  await page.waitForSelector("#person input.p-name", { timeout: 5000 }).catch(() => {});
  r.nameless = { value: await page.inputValue("#person input.p-name"), hint: await page.locator("#person input.p-name").getAttribute("placeholder") };
  await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  r.nameless.book = await book("don.violi2@y.example");
  // the page's button turns the name into a box; Enter keeps what is typed
  await contactRow(page, "s4@x.com").click();
  await page.waitForSelector("#person .p-msg", { timeout: 5000 }).catch(() => {});
  await page.locator('#person button[data-p="rename"]').click();
  r.box = { value: await page.inputValue("#person input.p-name"), focused: await page.evaluate(() => document.activeElement?.className) };
  await page.keyboard.type("Sam Four"); await page.keyboard.press("Enter");
  await named("s4@x.com", "Sam Four");
  r.renamed = { row: await text('#p-rows .prow[data-email="s4@x.com"] .pn'), page: await text("#person .p-name"), status: await text("#st-msg"), undo: await text("#st-undo"), book: await book("s4@x.com"), focus: await page.evaluate(() => document.activeElement.id) };
  // F2 opens the box again; Esc leaves the name, and Contacts, as they are
  await page.keyboard.press("F2");
  await page.waitForSelector("#person input.p-name", { timeout: 5000 }).catch(() => {});
  await page.keyboard.type("zzz"); await page.keyboard.press("Escape");
  r.esc = { row: await text('#p-rows .prow[data-email="s4@x.com"] .pn'), box: await page.locator("#person input.p-name").count(), shown: await page.locator("#app.contacts-view").count() };
  // an empty name takes the user's name back, and z brings it again
  await page.keyboard.press("F2");
  await page.waitForSelector("#person input.p-name", { timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Backspace"); await page.keyboard.press("Enter");
  await named("s4@x.com", "Sender 4");
  r.cleared = { row: await text('#p-rows .prow[data-email="s4@x.com"] .pn'), status: await text("#st-msg"), book: await book("s4@x.com") };
  await page.keyboard.press("z");
  await named("s4@x.com", "Sam Four");
  r.undone = await book("s4@x.com");
  // s7 has no mail left, but a contact the user named is not forgotten
  await contactRow(page, "s7@x.com").click();
  await page.waitForFunction(() => /No mail with this address/.test(document.querySelector("#person .p-recent")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  r.kept = { row: await contactRow(page, "s7@x.com").count(), said: await text("#person .p-recent") };
  expect(r.box.value === "Sender 4" && r.box.focused === "p-name" && r.renamed.row === "Sam Four" && r.renamed.page === "Sam Four" && r.renamed.status === "renamed Sender 4 to Sam Four" && r.renamed.undo === "Undo: rename Sam Four (z)" && r.renamed.book.given === "Sam Four" && r.renamed.focus === "list",
    "Rename types the user's own name over the one on the page: " + JSON.stringify([r.box, r.renamed]));
  expect(r.nameless.value === "" && r.nameless.hint === "Name" && r.nameless.book.name === "" && r.nameless.book.given === "", "for an address with no name the box is empty, and Enter on it names nobody: " + JSON.stringify(r.nameless));
  expect(r.esc.row === "Sam Four" && r.esc.box === 0 && r.esc.shown === 1, "Esc leaves the name as it was, and Contacts open: " + JSON.stringify(r.esc));
  expect(r.cleared.row === "Sender 4" && r.cleared.book.given === "" && r.cleared.status === "s4@x.com has the name the mail gives it, Sender 4" && r.undone.given === "Sam Four", "an empty name takes the user's name back, and undo brings it again: " + JSON.stringify([r.cleared, r.undone]));
  expect(r.kept.row === 1 && r.kept.said === "No mail with this address is left outside Spam and Trash. It stays in Contacts because you named it.", "a contact the user named is kept though no mail with it is left: " + JSON.stringify(r.kept));
}, { settings: { pollSec: 600 } });

scenario("Contacts are exported to a text file, and a file is merged into them or replaces them, each import one undo", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  const book = () => page.evaluate(async () => { const c = await import("./contacts.js"); return Object.fromEntries((await c.all()).map(x => [x.email, [x.name, c.pileOf(x), x.pinned ? "pinned" : "", x.added ? "added" : ""].filter(Boolean).join("/")])); });
  const menu = async act => { await page.locator("#contacts-link").click({ button: "right" }); return page.locator(`#ctx [data-act="${act}"]`); };
  const pick = async (act, name, body) => { const item = await menu(act); const [fc] = await Promise.all([page.waitForEvent("filechooser"), item.click()]); await fc.setFiles({ name, mimeType: "text/plain", buffer: Buffer.from(body, "utf8") }); };
  const said = re => page.waitForFunction(s => new RegExp(s).test(document.getElementById("st-msg").textContent), re.source, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  // Export writes a contact a line, in a file named for the day
  r.items = (await page.locator("#contacts-link").click({ button: "right" }), await page.locator("#ctx [data-act]").allTextContents());
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('#ctx [data-act="export"]').click()]);
  const file = require("fs").readFileSync(await dl.path(), "utf8");
  r.exported = { name: dl.suggestedFilename(), status: await text("#st-msg"), head: file.split(/\r?\n/)[0], people: /\n# People\r?\nOther <o@x\.com>\r?\n/.test(file), others: (file.match(/^Sender \d <s\d@x\.com>$/gm) || []).length };
  const before = await book();
  // merging: a name, a new address pinned, a hide, and a line that is not a contact, which is said and skipped
  await pick("merge", "mine.txt", "Sender One <s1@x.com>\nnew.person@y.example pinned\nSender 2 <s2@x.com> hidden\nthis line is wrong\n");
  await said(/^Merged mine\.txt/);
  r.merged = { status: await text("#st-msg"), undo: await text("#st-undo"), book: await book() };
  await page.locator("#list").focus(); await page.keyboard.press("z");
  await said(/^undone: merge/);
  r.unmerged = JSON.stringify(await book()) === JSON.stringify(before);
  // replacing with the exported file less one line takes that contact out, once asked; undo brings it back
  let asked = "";
  page.once("dialog", d => { asked = d.message(); d.accept(); });
  await pick("replace", "list.txt", file.replace(/^Sender 8 <s8@x\.com>\r?\n/m, ""));
  await said(/^replaced Contacts with list\.txt/);
  r.replaced = { asked, status: await text("#st-msg"), s8: (await book())["s8@x.com"] || null, count: Object.keys(await book()).length };
  await page.locator("#list").focus(); await page.keyboard.press("z");
  await said(/^undone: replace/);
  r.unreplaced = JSON.stringify(await book()) === JSON.stringify(before);
  // a file with a line that cannot be read replaces nothing
  await pick("replace", "bad.txt", "Other <o@x.com>\nnot a contact\n");
  await page.waitForFunction(() => /^Contacts were not replaced/.test(document.getElementById("notice-text").textContent), null, { timeout: 5000 }).catch(() => {});
  r.refused = { notice: await text("#notice-text"), same: JSON.stringify(await book()) === JSON.stringify(before) };
  expect(r.items.join("|") === "Export...|Import and merge...|Import and replace..." && /^baltazar-contacts-\d{4}-\d\d-\d\d\.txt$/.test(r.exported.name) && r.exported.status === `exported ${Object.keys(before).length} contacts to ${r.exported.name}` &&
    /^# Baltazar Mail contacts of me@yahoo\.com, \d{4}-\d\d-\d\d$/.test(r.exported.head) && r.exported.people && r.exported.others === 8, "the Contacts row's menu exports every contact, a line each: " + JSON.stringify([r.items, r.exported]));
  expect(/^Merged mine\.txt: 1 added, 1 renamed, 1 hidden\. 1 line could not be read: line 4, /.test(r.merged.status) && r.merged.undo === "Undo: merge mine.txt (z)" && r.merged.book["s1@x.com"] === "Sender One/others" && r.merged.book["new.person@y.example"] === "people/pinned/added" && r.merged.book["s2@x.com"] === "Sender 2/hidden" && r.merged.book["s3@x.com"] === before["s3@x.com"] && r.unmerged,
    "merging takes what the file says, says what it could not read, and is one undo: " + JSON.stringify([r.merged, r.unmerged]));
  expect(/^Replace Contacts with the 8 contacts in list\.txt\?/.test(r.replaced.asked) && r.replaced.status === "replaced Contacts with list.txt: 1 removed" && r.replaced.s8 === null && r.replaced.count === Object.keys(before).length - 1 && r.unreplaced,
    "replacing asks first, takes out who is not in the file, and is one undo: " + JSON.stringify([r.replaced, r.unreplaced]));
  expect(/^Contacts were not replaced/.test(r.refused.notice) && /line 2/.test(r.refused.notice) && r.refused.same, "a file with a line that cannot be read replaces nothing: " + JSON.stringify(r.refused));
}, { settings: { pollSec: 600 } });

scenario("Settings counts the contacts and rebuilds them when asked, keeping what the user chose", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  // a hide, a name and a pin of the user's, and an address no mail names
  r.before = await page.evaluate(async () => { const c = await import("./contacts.js"); await c.hide("s2@x.com"); await c.rename("s3@x.com", "Three"); await c.pinMany(["s5@x.com"]); await c.learn([{ headers: { date: "1500000000", from: [{ name: "Long Gone", email: "gone@old.example" }], to: [] } }]); return (await c.all()).length; });
  await page.locator("#list").focus(); await page.keyboard.press(",");
  await page.waitForSelector("#settings:not(.hidden)", { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById("ct-count").textContent, null, { timeout: 5000 }).catch(() => {});
  r.shown = { count: await text("#ct-count"), off: await page.locator("#ct-rebuild").isDisabled() };
  let asked = "";
  page.once("dialog", d => { asked = d.message(); d.accept(); });
  await page.evaluate(() => { document.getElementById("st-msg").textContent = ""; });      // the first build's own last word
  await page.locator("#ct-rebuild").click();
  await page.waitForFunction(() => /^Contacts: [\d,.\s]+ addresses \(/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => /learned from/.test(document.getElementById("ct-count").textContent), null, { timeout: 5000 }).catch(() => {});
  r.after = { asked, count: await text("#ct-count"), off: await page.locator("#ct-rebuild").isDisabled(),
    book: await page.evaluate(async () => { const c = await import("./contacts.js"); const one = async e => { const x = await c.lookup(e); return x && [x.name, x.hidden, !!x.pinned].join("/"); }; return { s2: await one("s2@x.com"), s3: await one("s3@x.com"), s5: await one("s5@x.com"), gone: await one("gone@old.example"), n: (await c.all()).length, built: await c.isBuilt() }; }) };
  expect(r.shown.count === `${r.before} contacts, learned from your message headers.` && !r.shown.off, "Settings says how many contacts there are: " + JSON.stringify([r.before, r.shown]));
  expect(/^Rebuild Contacts\? The headers of all your mail are read again, which takes about a minute\. /.test(r.after.asked) && r.after.count === `${r.before - 1} contacts, learned from your message headers.` && !r.after.off && r.after.book.built &&
    r.after.book.s2 === "Sender 2/true/false" && r.after.book.s3 === "Three/false/false" && r.after.book.s5 === "Sender 5/false/true" && r.after.book.gone === null && r.after.book.n === r.before - 1,
    "Rebuild asks first, reads the mail again, drops what no mail names and keeps what the user hid, named and pinned: " + JSON.stringify(r.after));
}, { settings: { pollSec: 600 } });

scenario("the trash bin on a row deletes contacts, in any pile but not a pinned one; they stay out whatever mail names them, and an export lists them to be brought back", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  const count = async pile => Number((await page.locator(`#p-show button[data-pile="${pile}"] i`).textContent()).replace(/\D/g, ""));
  const book = () => page.evaluate(async () => { const c = await import("./contacts.js"); return { n: await c.count(), s1: !!(await c.lookup("s1@x.com")), s2: !!(await c.lookup("s2@x.com")), s3: !!(await c.lookup("s3@x.com")), s6: !!(await c.lookup("s6@x.com")), suggested: (await c.suggest("s", 20)).map(x => x.email).sort().join() }; });
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  await page.evaluate(async () => { const c = await import("./contacts.js"); await c.hide("s6@x.com"); await c.pinMany(["s5@x.com"]); });
  await contactsOpen(page);
  // a pinned contact has no bin, its page's Delete is greyed out, and Del says why
  await contactRow(page, "s5@x.com").click();
  await page.waitForSelector('#person button[data-p="delete"]', { timeout: 5000 }).catch(() => {});
  r.pinned = { bin: await contactRow(page, "s5@x.com").locator(".tr").count(), off: await page.locator('#person button[data-p="delete"]').isDisabled(), why: await page.locator('#person button[data-p="delete"]').getAttribute("title") };
  await page.keyboard.press("Delete");
  r.pinned.said = await text("#st-msg"); r.pinned.still = await contactRow(page, "s5@x.com").count();
  await contactsTab(page, "others");
  const rows = page.locator("#p-rows .prow"), n = await rows.count(), had = (await book()).n;
  // two rows selected in Others: the bin of one says so, and deletes both
  await contactRow(page, "s1@x.com").click(); await contactRow(page, "s2@x.com").click({ modifiers: ["Control"] });
  r.tip = await contactRow(page, "s2@x.com").locator(".tr").getAttribute("title");
  await contactRow(page, "s2@x.com").hover(); await contactRow(page, "s2@x.com").locator(".tr").click();
  await page.waitForFunction(want => document.querySelectorAll("#p-rows .prow").length === want, n - 2, { timeout: 5000 }).catch(() => {});
  r.others = { left: await rows.count(), hidden: await count("hidden"), status: await text("#st-msg"), undo: await text("#st-undo"), book: await book() };
  // in Hidden too
  await contactsTab(page, "hidden");
  const hid = await count("hidden");
  await contactRow(page, "s6@x.com").hover(); await contactRow(page, "s6@x.com").locator(".tr").click();
  await page.waitForFunction(() => !document.querySelector('#p-rows .prow[data-email="s6@x.com"]'), null, { timeout: 5000 }).catch(() => {});
  r.hidden = { left: await count("hidden"), others: await count("others"), status: await text("#st-msg"), book: await book() };
  // Delete on a person's page does the same, and so does Del
  await contactsTab(page, "others");
  await contactRow(page, "s4@x.com").click(); await page.keyboard.press("Delete");
  await page.waitForFunction(() => !document.querySelector('#p-rows .prow[data-email="s4@x.com"]'), null, { timeout: 5000 }).catch(() => {});
  r.key = await text("#st-msg");
  await contactRow(page, "s3@x.com").click();
  await page.waitForSelector('#person button[data-p="delete"]', { timeout: 5000 }).catch(() => {});
  await page.locator('#person button[data-p="delete"]').click();
  await page.waitForFunction(() => !document.querySelector('#p-rows .prow[data-email="s3@x.com"]'), null, { timeout: 5000 }).catch(() => {});
  r.page = { status: await text("#st-msg"), book: await book() };
  // mail that names a deleted address again, and a rebuild, leave it out; undo brings the last one back
  r.later = await page.evaluate(async () => { const c = await import("./contacts.js");
    await c.learn([{ headers: { date: String(Math.floor(Date.now() / 1000)), from: [{ name: "Sender 1", email: "s1@x.com" }], to: [{ name: "Me", email: "me@yahoo.com" }] } }]);
    await c.sync({ inbox: "1", sent: "2", drafts: "3", full: true });
    return { n: await c.count(), s1: !!(await c.lookup("s1@x.com")), s6: !!(await c.lookup("s6@x.com")) }; });
  await page.locator("#list").focus(); await page.keyboard.press("z");
  await page.waitForSelector('#p-rows .prow[data-email="s3@x.com"]', { timeout: 5000 }).catch(() => {});
  r.undone = await book();
  // an export lists the deleted ones last, marked so; a file that names one without the mark brings it back
  await page.locator("#contacts-link").click({ button: "right" });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('#ctx [data-act="export"]').click()]);
  const file = require("fs").readFileSync(await dl.path(), "utf8").replace(/\r\n/g, "\n");
  r.exported = { status: await text("#st-msg"), tail: file.slice(file.indexOf("\n# Deleted\n")) };
  await page.locator("#contacts-link").click({ button: "right" });
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.locator('#ctx [data-act="merge"]').click()]);
  await fc.setFiles({ name: "back.txt", mimeType: "text/plain", buffer: Buffer.from(file.replace("Sender 1 <s1@x.com> deleted", "Sender 1 <s1@x.com>"), "utf8") });
  await page.waitForFunction(() => /^merged back\.txt/.test(document.getElementById("st-msg").textContent), null, { timeout: 5000 }).catch(() => {});
  r.restored = { status: await text("#st-msg"), book: await book() };
  expect(/^exported \d+ contacts and 4 deleted to baltazar-contacts-/.test(r.exported.status) && r.exported.tail === "\n# Deleted\nSender 1 <s1@x.com> deleted\nSender 2 <s2@x.com> deleted\nSender 4 <s4@x.com> deleted\nSender 6 <s6@x.com> deleted\n",
    "an export lists the deleted contacts last, each marked so: " + JSON.stringify(r.exported));
  expect(r.restored.status === "merged back.txt: 1 restored" && r.restored.book.s1 && !r.restored.book.s2 && r.restored.book.n === r.undone.n + 1, "importing the file with the mark taken off a line brings that contact back, and no other: " + JSON.stringify(r.restored));
  expect(r.pinned.bin === 0 && r.pinned.off && /^Unpin it first/.test(r.pinned.why) && r.pinned.said === "unpin it first: a pinned address cannot be deleted" && r.pinned.still === 1, "a pinned contact has no bin and is not deleted: " + JSON.stringify(r.pinned));
  expect(r.tip === "Delete the 2 selected contacts (Del)" && r.others.left === n - 2 && r.others.status === "deleted 2 contacts; an export lists them under Deleted" && r.others.undo === "Undo: delete 2 contacts (z)" && !r.others.book.s1 && !r.others.book.s2 && r.others.book.n === had - 2 && !/s[12]@/.test(r.others.book.suggested),
    "the bin of a selected row deletes everyone selected, out of the list, the count and the suggestions: " + JSON.stringify([n, had, r.tip, r.others]));
  expect(r.hidden.left === hid - 1 && r.hidden.others === n - 2 && r.hidden.status === "deleted Sender 6; an export lists it under Deleted" && !r.hidden.book.s6, "in Hidden it deletes too: " + JSON.stringify([hid, r.hidden]));
  expect(r.key === "deleted Sender 4; an export lists it under Deleted" && r.page.status === "deleted Sender 3; an export lists it under Deleted" && !r.page.book.s3 && r.page.book.n === had - 5, "Del and Delete on a person's page delete them: " + JSON.stringify([r.key, r.page]));
  expect(!r.later.s1 && !r.later.s6 && r.later.n === had - 5 && r.undone.s3 && !r.undone.s1, "a deleted address stays out when mail names it again and through a rebuild, and undo brings the last one back: " + JSON.stringify([r.later, r.undone]));
}, { settings: { pollSec: 600 } });

scenario("a pinned address cannot be hidden, nor a hidden one pinned", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  await contactsOpen(page);
  await contactsTab(page, "others");
  // pinned by its pin: the row has no eye, the page's Hide is greyed out, and h says why
  await contactRow(page, "s2@x.com").hover(); await contactRow(page, "s2@x.com").locator(".pk").click();
  await contactsTab(page, "people");
  await contactRow(page, "s2@x.com").click();
  r.pinned = { eye: await contactRow(page, "s2@x.com").locator(".pe:not(.none)").count(), hideOff: await page.locator('#person button[data-p="hide"]').isDisabled() };
  await page.keyboard.press("h");
  r.pinned.said = await text("#st-msg"); r.pinned.still = await contactRow(page, "s2@x.com").count();
  // the composer's × leaves a pinned address alone too
  r.pinned.store = await page.evaluate(async () => { const c = await import("./contacts.js"); await c.hide("s2@x.com"); const e = await c.lookup("s2@x.com"); return { hidden: e.hidden, pinned: !!e.pinned }; });
  // hidden by its eye: the row has no pin, the page's Pin is greyed out, and the store refuses a pin
  await contactsTab(page, "others");
  await contactRow(page, "s6@x.com").hover(); await contactRow(page, "s6@x.com").locator(".pe").click();
  await contactsTab(page, "hidden");
  await contactRow(page, "s6@x.com").click();
  r.hidden = { pin: await contactRow(page, "s6@x.com").locator(".pk:not(.none)").count(), pinOff: await page.locator('#person button[data-p="pin"]').isDisabled(), why: await page.locator('#person button[data-p="pin"]').getAttribute("title") };
  r.hidden.store = await page.evaluate(async () => { const c = await import("./contacts.js"); await c.pinMany(["s6@x.com"]); const e = await c.lookup("s6@x.com"); return { hidden: e.hidden, pinned: !!e.pinned }; });
  expect(r.pinned.eye === 0 && r.pinned.hideOff && /a pinned address cannot be hidden/.test(r.pinned.said) && r.pinned.still === 1 && r.pinned.store.pinned && !r.pinned.store.hidden, "a pinned address is not hidden by the eye, the button, h or the composer's ×: " + JSON.stringify(r.pinned));
  expect(r.hidden.pin === 0 && r.hidden.pinOff && /^Unhide it first/.test(r.hidden.why) && r.hidden.store.hidden && !r.hidden.store.pinned, "a hidden address is not pinned: " + JSON.stringify(r.hidden));
}, { settings: { pollSec: 600 } });

// ---------- folder management ----------
// Folder calls are answered here and change the mock's folder list, as Yahoo would.
function folderServer(h) {
  const ops = [];
  let next = 90;
  h.mock.handler = ({ name, top }) => {
    const ok = (result = {}) => ({ responses: [{ id: top.id, httpCode: 200, response: { result } }] });
    const id = (top.uri.match(/folders\/(?:@\.id==)?(\d+)/) || [])[1];
    if (name === "folders.create") { if (top.method !== "PUT" || !top.payload.folder.acctId) return { error: { code: "EC-4000", message: "bad create" } }; const f = { id: String(next++), name: top.payload.folder.name, types: ["USER"], unread: 0, total: 0, highestModSeq: 1, acctId: top.payload.folder.acctId }; h.folders.push(f); ops.push(["create", f.name]); return { responses: [{ id: top.id, httpCode: 201, response: { result: f } }] }; }
    if (name === "folders.rename") { const f = h.folders.find(x => x.id === id); const from = f.name; for (const x of h.folders) if (x.name === from || x.name.startsWith(from + "/")) x.name = top.payload.folder.name + x.name.slice(from.length); ops.push(["rename", id, top.payload.folder.name]); return ok(); }
    if (name === "folders.delete") {
      const at = h.folders.findIndex(x => x.id === id);
      // Yahoo answers EC-4001 for a folder it no longer has; staleDelete makes it also refuse once
      // while still listing the folder, as its list can lag
      if (at < 0 || h.mock.staleDelete?.has(id)) { h.mock.staleDelete?.delete(id); ops.push(["refused", id]); return { responses: [{ id: top.id, httpCode: 400, response: { error: { code: "EC-4001", validationErrors: ["ID"] } } }] }; }
      h.folders.splice(at, 1); ops.push(["delete", id]); return { responses: [{ id: top.id, httpCode: 204, response: {} }] };
    }
    if (name === "messages.delete" && /async=true/.test(top.uri)) { const qs = decodeURIComponent(top.uri); const fid = qs.match(/folderId:(\d+)/)[1]; h.folders.find(x => x.id === fid).total = 0; ops.push(["empty", fid, /count:\d+/.test(qs) && /acctId:\d/.test(qs)]); return { responses: [{ id: top.id, httpCode: 202, response: { result: { task: { id: "t8", status: "PENDING" } } } }] }; }
    // as Yahoo does: 202 with a task, then the task completes on the second status check
    if (name === "messages.readFlagUpdate" && /async=true/.test(top.uri)) { const qs = decodeURIComponent(top.uri); const fid = qs.match(/folderId:(\d+)/)[1]; h.folders.find(x => x.id === fid).unread = 0; ops.push(["read", fid, /is:unread/.test(qs) && /acctId:\d/.test(qs)]); return { responses: [{ id: top.id, httpCode: 202, response: { result: { task: { id: "t9", status: "PENDING" } } } }] }; }
    if (name === "task.status") { ops.push(["task"]); const done = ops.filter(o => o[0] === "task").length % 2 === 0; return ok({ task: { id: "t9", status: done ? "COMPLETED" : "PENDING", ...(done ? { completed: h.mock.markNone ? 0 : 3 } : {}) } }); }
  };
  return ops;
}
const menuOf = async (page, target) => { await target.click({ button: "right" }); await page.waitForTimeout(150); const items = await page.locator("#ctx").evaluate(c => c.classList.contains("hidden") ? [] : [...c.children].map(e => e.tagName === "HR" ? "---" : e.textContent)); return items; };
const pickMenu = async (page, label) => { await page.locator("#ctx div", { hasText: label }).first().click(); await page.waitForTimeout(150); };
const folderRow = (page, name) => page.locator("#folder-list .folder").filter({ has: page.locator(".nm", { hasText: new RegExp(`^${name}$`) }) });
const answer = async (page, text) => { await page.locator("#prompt-input").fill(text); await page.keyboard.press("Enter"); await page.waitForTimeout(700); };

scenario("folder menus offer what fits each folder", async ({ page }, expect) => {
  const menus = {};
  menus.user = await menuOf(page, folderRow(page, "Projects")); await page.keyboard.press("Escape");
  menus.inbox = await menuOf(page, folderRow(page, "Inbox")); await page.keyboard.press("Escape");
  menus.trash = await menuOf(page, folderRow(page, "Trash")); await page.keyboard.press("Escape");
  menus.spam = await menuOf(page, folderRow(page, "Spam")); await page.keyboard.press("Escape");
  menus.draft = await menuOf(page, folderRow(page, "Draft")); await page.keyboard.press("Escape");
  menus.starred = await menuOf(page, folderRow(page, "Starred")); await page.keyboard.press("Escape");
  menus.pane = await menuOf(page, page.locator(".folders-head")); await page.keyboard.press("Escape");
  menus.draggable = await page.locator("#folder-list .folder").evaluateAll(fs => fs.some(f => f.draggable));
  // greyed out, and a click on it leaves the menu open: Trash has nothing unread, Inbox has 3
  const greyed = async name => {
    await menuOf(page, folderRow(page, name));
    const item = page.locator('#ctx [data-act="mark-read"]'), off = await item.evaluate(e => e.classList.contains("off"));
    if (off) await item.click();
    const open = await page.locator("#ctx").isVisible();
    await page.keyboard.press("Escape");
    return off && open;
  };
  menus.greyed = { trash: await greyed("Trash"), inbox: await greyed("Inbox") };
  expect(menus.user.join("|") === "Show attachments|---|Mark all read|---|Move...|Rename...|Create subfolder...|---|Delete", "a user folder's menu: " + menus.user.join("|"));
  expect(menus.inbox.join("|") === "Show attachments|---|Mark all read|---|Create subfolder..." && menus.starred.join("|") === "Mark all read" && menus.draft.join("|") === "Show attachments", "system folders: " + JSON.stringify([menus.inbox, menus.starred, menus.draft]));
  expect(menus.trash.join("|") === "Show attachments|---|Mark all read|---|Empty Trash..." && menus.spam.join("|") === "Show attachments|---|Mark all read|---|Empty Spam...", "Trash and Spam: " + JSON.stringify([menus.trash, menus.spam]));
  expect(JSON.stringify(menus.greyed) === JSON.stringify({ trash: true, inbox: false }), "Mark all read is greyed out, and does nothing, in a folder with nothing unread: " + JSON.stringify(menus.greyed));
  expect(menus.pane.join("|") === "New folder...|---|Expand all|Collapse all", "the Folders heading: " + menus.pane.join("|"));
  expect(!menus.draggable, "folders cannot be dragged");
});

scenario("the Folders heading opens and closes only the first level", async (h, expect) => {
  const { page } = h, r = {};
  h.folders.push({ id: "96", name: "Projects/FPGA/Boards", types: ["USER"], unread: 0, total: 1, highestModSeq: 1 });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await page.waitForTimeout(900);
  const names = () => page.locator("#folder-list .folder .nm").allTextContents();
  const head = page.locator(".folders-head");
  r.before = await names(); r.twBefore = await head.locator(".tw").getAttribute("data-tw");
  await head.click(); await page.waitForTimeout(200);
  r.open = await names(); r.twOpen = await head.locator(".tw").getAttribute("data-tw");
  await folderRow(page, "FPGA").locator(".tw").click(); await page.waitForTimeout(200);
  r.deeper = await names();
  await head.click(); await page.waitForTimeout(200);
  r.closed = await names();
  await head.click(); await page.waitForTimeout(200);
  r.reopened = await names();
  r.kbItems = await page.locator("#folder-list .folder").evaluateAll(fs => fs.some(f => f.classList.contains("folders-head")));
  const has = (l, n) => l.includes(n);
  expect(r.twBefore === "closed" && has(r.before, "Projects") && !has(r.before, "FPGA"), "first-level folders always show: " + JSON.stringify(r.before));
  expect(r.twOpen === "open" && has(r.open, "FPGA") && has(r.open, "2025") && !has(r.open, "Boards"), "opening shows one level, not deeper: " + JSON.stringify(r.open));
  expect(has(r.deeper, "Boards") && !has(r.closed, "FPGA") && has(r.closed, "Projects") && has(r.reopened, "FPGA") && !has(r.reopened, "Boards"), "closing and reopening returns to one level: " + JSON.stringify(r));
  expect(!r.kbItems, "the heading is not a folder");
}, { settings: { pollSec: 600 } });

scenario("create, rename, move and delete folders", async (h, expect) => {
  const { page } = h, ops = folderServer(h), r = {};
  await menuOf(page, page.locator(".folders-head")); await pickMenu(page, "New folder...");
  await answer(page, "Hobbies");
  r.created = await folderRow(page, "Hobbies").count();
  await menuOf(page, folderRow(page, "Hobbies")); await pickMenu(page, "Create subfolder...");
  await answer(page, "Ideas");
  await menuOf(page, folderRow(page, "Hobbies")); await pickMenu(page, "Create subfolder...");
  await page.locator("#prompt-input").fill("ideas"); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  r.duplicate = await page.locator("#prompt-err").textContent();
  await page.locator("#prompt-input").fill("A/B"); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  r.slash = await page.locator("#prompt-err").textContent();
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  r.dialogClosed = await page.locator("#promptbox").isHidden();
  r.sub = await folderRow(page, "Ideas").count();
  await menuOf(page, folderRow(page, "Ideas")); await pickMenu(page, "Rename...");
  r.renameValue = await page.inputValue("#prompt-input");
  await answer(page, "Plans");
  await menuOf(page, folderRow(page, "Plans")); await pickMenu(page, "Move...");
  r.targets = await page.locator("#move-list div").allTextContents();
  await page.locator("#move-list div", { hasText: /^Folders$/ }).click(); await page.waitForTimeout(700);
  await menuOf(page, folderRow(page, "Plans")); await pickMenu(page, "Move...");
  await page.locator("#move-filter").fill("Hobb"); await page.keyboard.press("Enter"); await page.waitForTimeout(700);
  r.tree = await page.locator("#folder-list .folder .nm").allTextContents();
  // not empty: Delete is greyed out with the reason, and a click on it deletes nothing
  await menuOf(page, folderRow(page, "Projects"));
  const del = page.locator('#ctx [data-act="delete"]');
  r.notEmpty = { off: await del.evaluate(e => e.classList.contains("off")), title: await del.getAttribute("title") };
  await del.click(); await page.waitForTimeout(500);
  r.notEmpty.open = await page.locator("#ctx").isVisible();
  await page.keyboard.press("Escape");
  // empty with an empty subfolder: both go, innermost first
  let asked = ""; page.once("dialog", d => { asked = d.message(); d.accept(); });
  await menuOf(page, folderRow(page, "Hobbies")); await pickMenu(page, "Delete"); await page.waitForTimeout(900);
  r.asked = asked; r.gone = await folderRow(page, "Hobbies").count() + await folderRow(page, "Plans").count();
  r.ops = ops;
  const ids = Object.fromEntries(ops.filter(o => o[0] === "create").map((o, i) => [o[1], String(90 + i)]));
  expect(r.created === 1 && r.sub === 1 && r.dialogClosed, "a new folder and a subfolder appear: " + JSON.stringify(r));
  expect(/already exists/.test(r.duplicate) && /cannot contain \//.test(r.slash), "names are checked in the dialog: " + JSON.stringify([r.duplicate, r.slash]));
  expect(r.renameValue === "Ideas" && r.targets[0] === "Folders" && !r.targets.includes("Hobbies") && !r.targets.some(t => /Plans/.test(t)), "rename starts from the name; Move offers the top level, not the current parent or the folder itself: " + JSON.stringify(r.targets));
  expect(JSON.stringify(ops.slice(0, 5)) === JSON.stringify([["create", "Hobbies"], ["create", "Hobbies/Ideas"], ["rename", ids["Hobbies/Ideas"], "Hobbies/Plans"], ["rename", ids["Hobbies/Ideas"], "Plans"], ["rename", ids["Hobbies/Ideas"], "Hobbies/Plans"]]), "the calls: " + JSON.stringify(ops));
  expect(r.notEmpty.off && r.notEmpty.open && r.notEmpty.title === "Only an empty folder can be deleted: it and its subfolders hold 8 messages" && !ops.some(o => o[0] === "delete" && o[1] === "31"), "a folder with mail cannot be deleted: " + JSON.stringify(r.notEmpty));
  expect(/Hobbies.*1 empty subfolder/.test(r.asked) && JSON.stringify(ops.filter(o => o[0] === "delete")) === JSON.stringify([["delete", ids["Hobbies/Ideas"]], ["delete", ids.Hobbies]]) && r.gone === 0, "an empty folder goes with its empty subfolder: " + JSON.stringify(r));
}, { settings: { pollSec: 600 } });

scenario("folders under Inbox nest there and can be chosen as a parent", async (h, expect) => {
  const { page } = h, ops = folderServer(h), r = {};
  await menuOf(page, folderRow(page, "Inbox")); await pickMenu(page, "Create subfolder...");
  await answer(page, "Receipts");
  r.tree = await page.locator("#folder-list .folder").evaluateAll(fs => fs.slice(0, 4).map(f => `${({ open: "▾", closed: "▸" })[f.querySelector(".tw").dataset.tw] || ""}${f.querySelector(".nm").textContent}@${parseInt(f.style.paddingLeft)}`));
  await menuOf(page, folderRow(page, "Travel")); await pickMenu(page, "Move...");
  r.targets = await page.locator("#move-list div").allTextContents();
  await page.keyboard.press("Escape");
  expect(ops[0]?.[1] === "Inbox/Receipts" && r.tree.join() === "▾Inbox@8,Receipts@20,Starred@8,Draft@8", "a subfolder of Inbox sits under it: " + JSON.stringify([ops, r.tree]));
  // Travel is already at the top level, so that choice is left out
  expect(r.targets[0] === "Inbox" && !r.targets.includes("Folders") && !r.targets.some(t => /^Travel/.test(t)), "Inbox is offered as a parent: " + JSON.stringify(r.targets));
}, { settings: { pollSec: 600 } });

scenario("a folder delete Yahoo refuses while its list lags is tried again", async (h, expect) => {
  const { page } = h, ops = folderServer(h);
  h.folders.push({ id: "95", name: "Lag", types: ["USER"], unread: 0, total: 0, highestModSeq: 1 });
  h.mock.staleDelete = new Set(["95"]);
  await page.locator("#folder-list .folder").first().click(); await page.waitForTimeout(400);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await page.waitForTimeout(800);
  page.once("dialog", d => d.accept());
  await menuOf(page, folderRow(page, "Lag")); await pickMenu(page, "Delete"); await page.waitForTimeout(3500);
  const gone = !(await folderRow(page, "Lag").count()), notice = await page.locator("#notice").isVisible();
  expect(JSON.stringify(ops) === JSON.stringify([["refused", "95"], ["delete", "95"]]) && gone && !notice, "the second try deletes it, with no error shown: " + JSON.stringify({ ops, gone, notice }));
}, { settings: { pollSec: 600 } });

scenario("Mark all read on Spam falls back when Yahoo's task changes nothing, and shows at once", async (h, expect) => {
  const { page } = h, ops = folderServer(h);
  h.folders.find(f => f.id === "6").unread = 2;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await page.waitForTimeout(900);
  h.mock.markNone = true;
  // Yahoo's counts trail the change: the folder list keeps saying 2 unread
  const keep = h.folders.find(f => f.id === "6");
  Object.defineProperty(keep, "unread", { get: () => 2, set: () => {}, configurable: true });
  const before = h.calls.length;
  await menuOf(page, folderRow(page, "Spam")); await pickMenu(page, "Mark all read"); await page.waitForTimeout(3500);
  const perMessage = h.calls.slice(before).filter(c => c.name === "messages.readFlagUpdate" && !/async=true/.test(JSON.stringify(c.envelope))).length;
  const bold = await folderRow(page, "Spam").evaluate(e => e.classList.contains("unread"));
  expect(perMessage > 0, "the unread messages are marked one by one: " + JSON.stringify(ops));
  expect(!bold, "Spam shows read at once");
}, { settings: { pollSec: 600 } });

scenario("double-clicking a folder opens and closes its subfolders", async ({ page }, expect) => {
  const names = () => page.locator("#folder-list .folder .nm").allTextContents();
  const before = await names();
  await folderRow(page, "Projects").locator(".nm").dblclick(); await page.waitForTimeout(400);
  const open = await names(), title = await page.locator("#list-title").textContent();
  await folderRow(page, "Projects").locator(".nm").dblclick(); await page.waitForTimeout(400);
  const closed = await names();
  expect(!before.includes("FPGA") && open.includes("FPGA") && !closed.includes("FPGA") && /Projects/.test(title), "double-click toggles and the folder is open: " + JSON.stringify({ before, open, closed, title }));
});

scenario("Mark all read on Starred marks the starred unread mail, not the open list", async (h, expect) => {
  const { page } = h; folderServer(h);
  let asked = 0;
  const prev = h.mock.handler;
  h.mock.handler = a => {
    const qs = decodeURIComponent(a.top.uri || "");
    if (a.name === "messageGroups.getList" && /is:flagged/.test(qs) && /is:unread/.test(qs)) {
      asked++;
      const left = ["MSG31_1", "MSG31_2"].filter(id => !h.mock.flags.get(id)?.read);
      return { responses: [{ id: a.top.id, httpCode: 200, response: { result: { messages: left.map(id => ({ id, flags: { read: false, flagged: true }, headers: {}, folder: { id: "31" } })), query: {} } } }] };
    }
    return prev(a);
  };
  const before = h.calls.length;
  await menuOf(page, folderRow(page, "Starred")); await pickMenu(page, "Mark all read"); await page.waitForTimeout(1500);
  const marked = h.calls.slice(before).filter(c => c.name === "messages.readFlagUpdate").flatMap(c => c.envelope.requests.map(r => decodeURIComponent(r.uri).match(/id:\(([^)]+)\)/)?.[1]));
  expect(asked >= 2 && JSON.stringify(marked.sort()) === JSON.stringify(["MSG31_1", "MSG31_2"]), "only the starred unread messages are marked: " + JSON.stringify({ asked, marked }));
}, { settings: { pollSec: 600 } });

scenario("Mark all read stops and says so when Yahoo keeps messages unread", async (h, expect) => {
  const { page } = h; const ops = folderServer(h);
  h.folders.find(f => f.id === "6").unread = 2;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await page.waitForTimeout(900);
  h.mock.markNone = true;
  const prev = h.mock.handler;
  h.mock.handler = a => {
    const qs = decodeURIComponent(a.top.uri || "");
    if (a.name === "messageGroups.getList" && /folderId:6 is:unread/.test(qs)) return { responses: [{ id: a.top.id, httpCode: 200, response: { result: { messages: [{ id: "MSG6_1", flags: { read: false }, headers: {}, folder: { id: "6" } }], query: {} } } }] };
    return prev(a);
  };
  const before = h.calls.length;
  await menuOf(page, folderRow(page, "Spam")); await pickMenu(page, "Mark all read"); await page.waitForTimeout(4000);
  const tries = h.calls.slice(before).filter(c => c.name === "messages.readFlagUpdate" && !/async=true/.test(JSON.stringify(c.envelope))).length;
  const notice = await page.locator("#notice").textContent();
  expect(tries === 1 && /kept 1 message unread/.test(notice), "one try, then a notice: " + JSON.stringify({ tries, notice, ops }));
}, { settings: { pollSec: 600 }, allow: /mark all read/ });

scenario("folder actions use fresh records after a poll", async (h, expect) => {
  const { page } = h, ops = folderServer(h);
  h.folders.find(f => f.id === "1").highestModSeq++;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await page.waitForTimeout(1200);
  const inbox = await menuOf(page, folderRow(page, "Inbox")); await page.keyboard.press("Escape");
  await menuOf(page, folderRow(page, "Travel")); await pickMenu(page, "Rename...");
  await answer(page, "travel");
  const err = await page.locator("#promptbox").isHidden() ? "" : await page.locator("#prompt-err").textContent();
  await page.keyboard.press("Escape");
  expect(inbox.includes("Create subfolder..."), "Inbox keeps Create subfolder after a poll: " + JSON.stringify(inbox));
  expect(!err && ops.some(o => o[0] === "rename" && o[2] === "travel"), "a case-only rename is allowed: " + JSON.stringify({ err, ops }));
}, { settings: { pollSec: 600 } });

scenario("folders of a linked account stay apart, and an orphan can move to the top level", async (h, expect) => {
  const { page } = h; folderServer(h);
  h.folders.push({ id: "70", acctId: "2", name: "Inbox", types: ["INBOX"], unread: 0, total: 1, highestModSeq: 1 },
    { id: "71", acctId: "1", name: "Inbox/Receipts", types: ["USER"], unread: 0, total: 1, highestModSeq: 1 },
    { id: "72", acctId: "1", name: "Ghost/Child", types: ["USER"], unread: 0, total: 1, highestModSeq: 1 });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await page.waitForTimeout(1200);
  await page.locator(".folders-head").click({ button: "right" }); await pickMenu(page, "Expand all"); await page.waitForTimeout(300);
  const receipts = await folderRow(page, "Receipts").count();
  await menuOf(page, folderRow(page, "Ghost/Child")); await pickMenu(page, "Move...");
  const targets = await page.locator("#move-list div").allTextContents(); await page.keyboard.press("Escape");
  expect(receipts === 1, "an Inbox subfolder shows once, under its own account's Inbox: " + receipts);
  expect(targets[0] === "Folders", "a folder whose parent does not exist can move to the top level: " + JSON.stringify(targets));
}, { settings: { pollSec: 600 } });

scenario("the name dialog: input-method Enter, focus kept inside, backdrop drags", async ({ page }, expect) => {
  const r = {};
  await page.locator(".folders-head").click({ button: "right" }); await pickMenu(page, "New folder...");
  await page.locator("#prompt-input").fill("Half");
  await page.locator("#prompt-input").evaluate(i => i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  r.afterIme = await page.locator("#promptbox").isVisible();
  const focusOrder = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); focusOrder.push(await page.evaluate(() => document.activeElement.id)); }
  await page.keyboard.press("Shift+Tab"); focusOrder.push(await page.evaluate(() => document.activeElement.id));
  const box = await page.locator("#prompt-input").boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down(); await page.mouse.move(5, 5); await page.mouse.up();
  r.afterDrag = await page.locator("#promptbox").isVisible();
  await page.mouse.click(5, 5);
  r.afterBackdrop = await page.locator("#promptbox").isHidden();
  expect(r.afterIme, "Enter while composing does not submit");
  expect(focusOrder.every(id => ["prompt-input", "prompt-cancel", "prompt-ok"].includes(id)), "Tab stays in the dialog: " + focusOrder.join());
  expect(r.afterDrag && r.afterBackdrop, "a drag out of the input keeps it open; a click on the backdrop closes it: " + JSON.stringify(r));
});

scenario("the contact card finds mail from the person and opens a recent message in its folder", async (h, expect) => {
  const { page } = h, r = {};
  await folder(page, "Sent");
  await page.locator("#rows .row").first().click({ button: "right" }); await pickMenu(page, "About recipient...");
  await page.waitForSelector("#card .card-recent [data-id]", { timeout: 5000 }).catch(() => {});
  const items = page.locator("#card .card-recent [data-id]");
  r.n = await items.count();
  r.want = await items.nth(2).getAttribute("data-id");
  await items.nth(2).click(); await page.waitForTimeout(1500);
  r.title = await page.locator("#list-title").textContent();
  r.sel = await page.locator("#rows .row.sel").evaluate(e => e.id).catch(() => "");
  r.selIndex = await page.evaluate(() => [...document.querySelectorAll("#rows .row")].findIndex(x => x.classList.contains("sel")));
  r.subject = await page.locator("#r-subject").textContent();
  await page.locator("#rows .row").first().click({ button: "right" }); await pickMenu(page, "About sender...");
  await page.waitForSelector("#card:not(.hidden)", { timeout: 4000 }).catch(() => {});
  await page.locator('#card [data-c="search"]').click(); await page.waitForTimeout(800);
  r.search = await page.inputValue("#search");
  expect(r.n >= 3 && r.title === "Inbox" && r.selIndex === 2 && r.subject === "Subject 1-3", "the message is highlighted and open in its folder: " + JSON.stringify(r));
  expect(/^from:s1@x\.com$/.test(r.search), "the card's Find all from searches mail from the person: " + r.search);
}, { settings: { pollSec: 600 } });

scenario("Empty Trash and Mark all read", async (h, expect) => {
  const { page } = h, ops = folderServer(h), r = {};
  let asked = ""; page.once("dialog", d => { asked = d.message(); d.accept(); });
  await menuOf(page, folderRow(page, "Trash")); await pickMenu(page, "Empty Trash..."); await page.waitForTimeout(3000);
  r.asked = asked;
  await menuOf(page, folderRow(page, "Inbox")); await pickMenu(page, "Mark all read"); await page.waitForTimeout(3500);
  r.unreadRows = await page.locator("#rows .row.unread").count();
  r.inboxCount = await folderRow(page, "Inbox").locator(".ct").textContent();
  expect(/Permanently delete all 1 message in Trash/.test(r.asked) && ops.some(o => o[0] === "empty" && o[1] === "4" && o[2]), "Trash is emptied after a confirmation: " + JSON.stringify([r.asked, ops]));
  expect(ops.some(o => o[0] === "read" && o[1] === "1" && o[2]) && ops.filter(o => o[0] === "task").length === 4 && r.unreadRows === 0, "Inbox is marked read through Yahoo's task, rows included: " + JSON.stringify([ops, r]));
}, { settings: { pollSec: 600 } });

// ---------- dark reader ----------
scenario("darkenHtml golden values, and crafted styles stay fast", async ({ page }, expect) => {
  const r = await page.evaluate(async () => {
    const { darkenHtml } = await import("./darken.js");
    const out = darkenHtml('<div style="color:#333;background-color:#fff">a</div><font color="#000">b</font><table bgcolor="#ffffff"><tr><td>c</td></tr></table>' +
      '<div style="background:url(x.png);color:#000">d</div><div style="background-image:url(y.png)"><span style="color:#000">e</span></div><style>p{color:#000}</style>');
    const named = darkenHtml('<div style="background-color:lightyellow;color:darkblue;border-color:currentcolor">n</div>');
    const t0 = performance.now();
    darkenHtml(`<div style="${"background:".repeat(90000)}">x</div><style>p{color:${"rgb(".repeat(250000)}}</style>`);
    return { out, named, ms: performance.now() - t0 };
  });
  const want = '<div style="color:#b1b1b1;background-color:#1f1f1f">a</div><font color="#e4e4e4">b</font><table bgcolor="#1f1f1f"><tbody><tr><td>c</td></tr></tbody></table>' +
    '<div style="background:url(x.png);color:#000">d</div><div style="background-image:url(y.png);color:#111111"><span style="color:#000">e</span></div><style>p{color:#e4e4e4}</style>';
  expect(r.out === want, "darkened HTML: " + r.out);
  expect(r.ms < 1500, "crafted style text darkens in linear time: " + Math.round(r.ms) + " ms");
  expect(!/lightyellow|darkblue/.test(r.named) && /currentcolor/.test(r.named), "every named colour darkens, keywords stay: " + r.named);
});

// ---------- layout and look ----------
const LONG = "Quarterly" + "x".repeat(300);
scenario("a narrow window keeps the reader on screen", async ({ page, mock }, expect) => {
  mock.patchBody = (id, m) => { if (id === "MSG1_2") m.headers.subject = LONG; };
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  const r = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, w: innerWidth,
    print: document.getElementById("r-print").getBoundingClientRect().right, reader: document.getElementById("reader").getBoundingClientRect().width }));
  expect(r.scroll <= r.w && r.print <= r.w && r.reader >= 250, "no sideways scroll, buttons and reader on screen: " + JSON.stringify(r));
}, { settings: { folderW: 400, listW: 600 } });

scenario("the list toolbar fits at 150% text", async ({ page }, expect) => {
  const r = await page.evaluate(() => { const l = document.getElementById("list").getBoundingClientRect(); return { list: Math.round(l.right), buttons: Math.round(Math.max(...[...document.querySelectorAll("#toolbar button")].map(b => b.getBoundingClientRect().right))) }; });
  expect(r.buttons <= r.list, "every toolbar button inside the list: " + JSON.stringify(r));
}, { settings: { textPct: 150 } });

scenario("overlays sit above popovers, and help fits a short window", async ({ page }, expect) => {
  await page.setViewportSize({ width: 1200, height: 420 });
  const z = await page.evaluate(() => { const z = id => Number(getComputedStyle(document.getElementById(id)).zIndex) || 0;
    return { over: Math.min(z("settings"), z("help"), z("movebox")), pop: Math.max(z("search-help"), z("card"), z("ctx"), z("c-suggest"), z("c-palette")) }; });
  await page.locator("#list").focus(); await page.keyboard.press("?"); await page.waitForTimeout(200);
  const h = await page.evaluate(() => { const b = document.getElementById("help-box"), r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, scrolls: b.scrollHeight > b.clientHeight }; });
  expect(z.over > z.pop, "Settings, Help and Move cover popovers: " + JSON.stringify(z));
  expect(h.top >= 0 && h.bottom <= h.h && h.scrolls, "help scrolls inside the window: " + JSON.stringify(h));
});

scenario("Load images goes away once images load, and counts CSS backgrounds", async ({ page, mock }, expect) => {
  mock.patchBody = (id, m, body) => { if (id === "MSG1_4") body.html = '<div style="width:9px;height:9px;background:url(https://ecp.yusercontent.com/bg.png)">x</div>'; };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  const before = await page.locator("#r-images").isVisible();
  await page.click("#r-images"); await page.waitForTimeout(600);
  const after = await page.locator("#r-images").isVisible();
  await page.locator("#rows .row").nth(3).click(); await page.waitForTimeout(600);
  const bg = await page.locator("#r-images").isVisible();
  expect(before && !after && bg, "shown, gone after loading, shown for a CSS background: " + JSON.stringify({ before, after, bg }));
}, { settings: { images: "never" }, allow: /ERR_NAME_NOT_RESOLVED|Content Security Policy/ });

scenario("an error in the reader does not stay after leaving", async ({ page, mock }, expect) => {
  mock.handler = async ({ name, uri }) => name === "messages.getBody" && uri.includes("MSG1_2/") ? { error: { code: "EC-5003", message: "Internal error" } } : undefined;
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  const err = await page.locator("#reader-empty").textContent();
  await folder(page, "Sent");
  const after = await page.locator("#reader-empty").textContent();
  expect(/^Error/.test(err) && !/Error/.test(after), "the empty reader says what it normally says: " + JSON.stringify({ err, after }));
}, { allow: /EC-5003|fetching/ });

scenario("selected rows look different from the cursor row", async ({ page }, expect) => {
  await page.locator("#rows .row").nth(0).click();
  await page.locator("#rows .row").nth(2).click({ modifiers: ["Control"] }); await page.waitForTimeout(200);
  const bg = await page.evaluate(() => [...document.querySelectorAll("#rows .row")].slice(0, 3).map(r => getComputedStyle(r).backgroundColor));
  expect(bg[0] !== bg[2], "marked and cursor rows differ: " + JSON.stringify(bg));
});

scenario("t says when it turns off Follow system", async ({ page }, expect) => {
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
  await page.locator("#list").focus(); await page.keyboard.press("t"); await page.waitForTimeout(300);
  expect(/Follow system/.test(await page.locator("#st-msg").textContent()), "the status says so: " + await page.locator("#st-msg").textContent());
}, { settings: { theme: "system" } });

scenario("names keep their own direction", async ({ page }, expect) => {
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);
  const b = await page.evaluate(() => [".row .fr", ".row .sb", "#r-from .who", "#r-subject"].map(s => getComputedStyle(document.querySelector(s)).unicodeBidi));
  expect(b.every(x => x === "isolate" || x === "plaintext" || x === "isolate-override"), "bidi isolation: " + JSON.stringify(b));
});

scenario("the dark reader does not flash white between messages", async ({ page }, expect) => {
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);
  const bg = await page.locator("#r-body").evaluate(f => getComputedStyle(f).backgroundColor);
  expect(bg !== "rgb(255, 255, 255)", "the frame's own background is dark: " + bg);
}, { settings: { theme: "dark" } });

// ---------- start-up ----------
scenario("starting offline says why and recovers by itself", async ({ page, mock }, expect) => {
  const shown = { panel: await page.locator("#signin-fail").isVisible(), app: await page.locator("#app").isVisible(), text: await page.locator("#fail-text").textContent() };
  expect(shown.panel && !shown.app && /Could not load your mailbox\. Yahoo could not be reached/.test(shown.text), "an offline start shows the reason: " + JSON.stringify(shown));
  mock.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForSelector("#rows .row", { timeout: 10000 }).catch(() => {});
  expect(await page.locator("#app").isVisible() && await page.locator("#rows .row").count() > 0 && await page.locator("#signin").isHidden(), "coming online loads the mailbox");
}, { mock: { offline: true }, noWait: true, allow: /start|ERR_INTERNET_DISCONNECTED|Failed to fetch/ });

scenario("folders failing after sign-in can be retried, and polling starts", async ({ page, calls, mock }, expect) => {
  const shown = { panel: await page.locator("#signin-fail").isVisible(), text: await page.locator("#fail-text").textContent() };
  expect(shown.panel && /Could not load your mailbox/.test(shown.text), "a folder failure at start shows the reason: " + JSON.stringify(shown));
  mock.handler = null;
  await page.click("#fail-retry");
  await page.waitForSelector("#rows .row", { timeout: 10000 }).catch(() => {});
  const syncs = () => calls.filter(c => c.name === "mailbox.sync").length;
  const before = syncs();
  await page.waitForTimeout(6500);
  expect(await page.locator("#rows .row").count() > 0, "Try again loads the mailbox");
  expect(syncs() > before, "polling runs after a retried start: " + JSON.stringify({ before, after: syncs() }));
}, { mock: { handler: async ({ name }) => name === "mailbox.sync" ? { error: { code: "EC-5003", message: "Internal error" } } : undefined }, noWait: true, settings: { pollSec: 5 }, allow: /start|EC-5003/ });

// ---------- list ----------
const subjects = page => page.locator("#rows .row .sb").allTextContents();
const selSubject = async page => (await page.locator("#rows .row.sel .sb").count()) ? page.locator("#rows .row.sel .sb").textContent() : "";

scenario("removing a selection moves to the row after it", async ({ page }, expect) => {
  const before = await subjects(page);
  await page.locator("#rows .row").nth(0).click();
  await page.locator("#rows .row").nth(4).click({ modifiers: ["Shift"] });
  await page.waitForTimeout(300);
  await page.locator("#list").focus(); await page.keyboard.press("e");
  await page.waitForFunction(n => document.querySelectorAll("#rows .row").length === n - 5, before.length, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(600);
  const sel = await selSubject(page), reader = await page.locator("#r-subject").textContent();
  expect(sel === before[5] && reader === before[5], "the cursor lands on the first row after the removed ones: " + JSON.stringify({ sel, reader, want: before[5] }));
});

scenario("returning to a folder keeps the composer open", async ({ page }, expect) => {
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);
  await folder(page, "Sent");
  await newMessage(page, { subject: "Stay", text: "half written" });
  await folder(page, "Inbox");
  await page.waitForTimeout(500);
  const open = await page.locator("#compose").isVisible(), text = await page.locator("#c-editor").innerText().catch(() => "");
  expect(open && text.includes("half written"), "the composer stays open with its text: " + JSON.stringify({ open, text }));
});

scenario("a slow folder load does not take focus from the search box", async ({ page, mock }, expect) => {
  mock.listDelay = 900;
  await page.locator("#folder-list .folder", { hasText: "Sent" }).first().click();
  await page.locator("#search").focus(); await page.keyboard.type("budg");
  await page.waitForTimeout(1500);
  await page.keyboard.type("et");
  const focus = await page.evaluate(() => document.activeElement.id), value = await page.locator("#search").inputValue();
  expect(focus === "search" && value === "budget", "typing continues in the search box: " + JSON.stringify({ focus, value }));
});

scenario("the message list speaks to screen readers", async ({ page }, expect) => {
  await page.locator("#list").focus(); await page.keyboard.press("j"); await page.waitForTimeout(200);
  const a = await page.evaluate(() => {
    const rows = document.getElementById("rows"), list = document.getElementById("list");
    const opts = [...rows.querySelectorAll(".row")];
    const active = document.getElementById(list.getAttribute("aria-activedescendant") || "-");
    return { role: rows.getAttribute("role"), multi: rows.getAttribute("aria-multiselectable"), label: rows.getAttribute("aria-label"),
      optRoles: [...new Set(opts.map(o => o.getAttribute("role")))], selected: opts.filter(o => o.getAttribute("aria-selected") === "true").length,
      activeIsSel: !!active && active.classList.contains("sel"), name: active?.getAttribute("aria-label") || "", dayHidden: [...rows.querySelectorAll(".day")].every(d => d.getAttribute("aria-hidden") === "true") };
  });
  expect(a.role === "listbox" && a.multi === "true" && a.label && a.optRoles.join() === "option" && a.selected === 1 && a.activeIsSel && a.dayHidden,
    "listbox, options, one selected, active row named: " + JSON.stringify(a));
  expect(/^(Unread, )?Sender \d+, Subject 1-\d+, /.test(a.name), "a row's name says who, what and when: " + a.name);
  await page.keyboard.press("x"); await page.keyboard.press("j"); await page.keyboard.press("x");
  const marked = await page.locator('#rows .row[aria-selected="true"]').count();
  expect(marked === 2, "selected rows are marked selected: " + marked);
});

scenario("a search term with an unknown value says so", async ({ page }, expect) => {
  const title = await page.locator("#list-title").textContent();
  await page.locator("#search").click(); await page.keyboard.type("is:important"); await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const n = await notice(page);
  expect(/is:important is not a search term/.test(n) && await page.locator("#list-title").textContent() === title, "the reason is shown and the list stays: " + n);
});

scenario("an undo that keeps failing stops blocking the older ones", async ({ page, mock }, expect) => {
  const before = await subjects(page);
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(400);
  await page.locator("#list").focus(); await page.keyboard.press("e"); await page.waitForTimeout(500);
  await page.keyboard.press("e"); await page.waitForTimeout(500);
  mock.failMoves = 99;
  await page.keyboard.press("z"); await page.waitForTimeout(500);
  await page.keyboard.press("z"); await page.waitForTimeout(500);
  const n = await notice(page), label = await page.locator("#st-undo").textContent();
  mock.failMoves = 0;
  await page.keyboard.press("z"); await page.waitForTimeout(800);
  const after = await page.locator("#st-undo").textContent();
  expect(/removed from the undo list/.test(n) && /Undo: archive 1 message/.test(label), "the failing entry is dropped after a second failure: " + JSON.stringify({ n, label }));
  expect(!/Undo:/.test(after) && /Redo: archive 1 message/.test(after) && (await subjects(page)).includes(before[0]), "the older entry then undoes: " + JSON.stringify({ after }));
}, { allow: /EC-5003|undo/ });

scenario("an undo where some messages fail says so", async ({ page, mock }, expect) => {
  await page.locator("#rows .row").nth(0).click();
  await page.locator("#rows .row").nth(1).click({ modifiers: ["Shift"] }); await page.waitForTimeout(300);
  await page.locator("#list").focus(); await page.keyboard.press("e"); await page.waitForTimeout(600);
  mock.handler = async ({ name, post }) => {
    if (name !== "messages.move") return;
    const ids = [...post.matchAll(/"id":"(UnifiedUpdateMessage_\d+)"/g)].map(m => m[1]);
    return { responses: ids.map((id, i) => ({ id, httpCode: i === 0 ? 204 : 500 })) };
  };
  await page.keyboard.press("z"); await page.waitForTimeout(800);
  const n = await notice(page);
  expect(/1 of 2 messages could not be/.test(n), "a partial undo is reported as partial: " + JSON.stringify({ n }));
});

scenario("a failed folder load keeps the list that was shown", async ({ page, mock }, expect) => {
  const before = await subjects(page);
  mock.handler = async ({ name, uri }) => name === "messageGroups.getList" && /folderId%3A62\b/.test(uri) ? { error: { code: "EC-5003", message: "Internal error" } } : undefined;
  await page.locator("#folder-list .folder", { hasText: "Archive" }).first().click(); await page.waitForTimeout(800);
  const after = await subjects(page), title = await page.locator("#list-title").textContent();
  expect(after.length === before.length && after[0] === before[0] && title === "Inbox", "the Inbox list stays: " + JSON.stringify({ n: after.length, title }));
}, { allow: /EC-5003|list/ });

scenario("an action during a refresh does not lose new mail", async ({ page, calls, mock, folders }, expect) => {
  let slow = false; const seenUris = [];
  mock.handler = async ({ name, uri }) => {
    if (name === "messageGroups.getList" && /folderId%3A1\b/.test(uri)) seenUris.push("slow=" + slow);
    if (name !== "messageGroups.getList" || !/folderId%3A1\b/.test(uri) || !slow) return;
    await sleep(1500);
    const fresh = { ...msg(1, "1"), id: "MSG1_NEW", headers: { ...msg(1, "1").headers, subject: "Brand new", date: String(Math.floor(Date.now() / 1000)) } };
    return { responses: [{ id: "GetMessageGroupList", httpCode: 200, response: { result: { messages: [fresh, ...Array.from({ length: 8 }, (_, i) => msg(i + 1, "1"))], query: {} } } }] };
  };
  // the address book's first build also lists Inbox; once it is done, the next Inbox list after a
  // folder change is the poll's refresh
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
  slow = true; folders[0].highestModSeq++;
  const inbox = () => seenUris.filter(u => /slow=true/.test(u)).length;
  for (let i = 0; i < 80 && !inbox(); i++) await sleep(100);   // the poll's refresh is in flight
  await page.locator("#list").focus(); await page.keyboard.press("Shift+Z");   // nothing to redo: a no-op action
  await page.waitForTimeout(3500);
  slow = false;
  const s = await subjects(page);
  expect(s.includes("Brand new"), "new mail shows after the action: " + JSON.stringify(s.slice(0, 2)) );
}, { settings: { pollSec: 5 } });

const readCalls = calls => calls.filter(c => c.name === "messages.readFlagUpdate" && c.envelope.requests.some(q => q.payload?.message?.flags?.read === true));
scenario("returning to a message you marked unread keeps it unread", async ({ page, calls }, expect) => {
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);
  await page.locator("#list").focus(); await page.keyboard.press("u"); await page.waitForTimeout(500);
  const n0 = readCalls(calls).length;
  await folder(page, "Sent"); await folder(page, "Inbox");
  await page.waitForTimeout(2000);
  const shown = await page.locator("#r-subject").textContent();
  expect(shown === "Subject 1-2" && readCalls(calls).length === n0, "the reopened message stays unread: " + JSON.stringify({ shown, marks: readCalls(calls).length - n0 }));
}, { settings: { markReadSec: 1 } });

scenario("a message opened in a hidden tab is marked read only once seen", async ({ page, calls, goneElsewhere }, expect) => {
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);
  const n0 = readCalls(calls).length;
  goneElsewhere.add("MSG1_2");
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }) || Object.defineProperty(document, "hidden", { value: true, configurable: true }));
  await page.evaluate(() => Object.defineProperty(document, "hidden", { value: true, configurable: true }));
  await page.locator("#list").focus(); await page.keyboard.press("R");
  await page.waitForTimeout(2500);
  const shown = await page.locator("#r-subject").textContent(), hidden = readCalls(calls).length - n0;
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(2000);
  const seen = readCalls(calls).length - n0;
  expect(shown === "Subject 1-3" && hidden === 0 && seen === 1, "marked read after the tab is seen, not before: " + JSON.stringify({ shown, hidden, seen }));
}, { settings: { markReadSec: 1 } });

scenario("reply answers the open message wherever the cursor is", async ({ page }, expect) => {
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);
  await page.locator("#list").focus(); await page.keyboard.press("j"); await page.keyboard.press("j");
  await page.keyboard.press("r"); await page.waitForTimeout(600);
  const open = await page.locator("#compose").isVisible(), subject = open ? await page.inputValue("#c-subject") : "";
  expect(open && subject === "Re: Subject 1-2", "the reply is to the message in the reader: " + JSON.stringify({ open, subject }));
});

scenario("opening another draft quickly edits the last one clicked", async ({ page, mock }, expect) => {
  mock.handler = async ({ name, uri }) => { if (name === "messages.getBody" && uri.includes("MSG3_1/")) await sleep(900); };
  await folder(page, "Draft");
  await page.locator("#rows .row").nth(0).click();
  await page.waitForTimeout(100);
  await page.locator("#rows .row").nth(1).click();
  await page.waitForTimeout(2500);
  const subject = await page.inputValue("#c-subject");
  expect(subject === "Subject 3-2", "the composer holds the draft clicked last: " + subject);
});

// ---------- keyboard and small state ----------
const key = (page, init) => page.evaluate(i => (document.activeElement || document).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i })), init);

scenario("Esc from a search in Starred goes back to Starred", async ({ page }, expect) => {
  await page.locator("#folder-list .folder", { hasText: "Starred" }).first().click(); await page.waitForTimeout(500);
  await page.locator("#search").click(); await page.keyboard.type("alex"); await page.keyboard.press("Enter"); await page.waitForTimeout(500);
  await page.locator("#search").focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(500);
  expect(await page.locator("#list-title").textContent() === "Starred", "back in Starred: " + await page.locator("#list-title").textContent());
});

scenario("Enter that ends an IME composition does not search", async ({ page }, expect) => {
  await page.locator("#search").click(); await page.keyboard.type("kanji");
  await key(page, { key: "Enter", isComposing: true });
  await page.waitForTimeout(400);
  expect(await page.locator("#list-title").textContent() === "Inbox", "no search: " + await page.locator("#list-title").textContent());
});

scenario("Caps Lock does not turn undo into redo, and a held key acts once", async ({ page, calls }, expect) => {
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(400);
  await page.locator("#list").focus(); await page.keyboard.press("e"); await page.waitForTimeout(500);
  await key(page, { key: "e", repeat: true }); await key(page, { key: "e", repeat: true }); await page.waitForTimeout(500);
  const moves = calls.filter(c => c.name === "messages.move").length;
  await key(page, { key: "Z", modifierCapsLock: true }); await page.waitForTimeout(700);
  const label = await page.locator("#st-undo").textContent();
  expect(moves === 1, "a held e archives once: " + moves);
  expect(/Redo: archive/.test(label) && !/Undo:/.test(label), "Z with Caps Lock undoes: " + label);
});

scenario("the Undo button can cancel a pending send", async ({ page }, expect) => {
  await newMessage(page, { subject: "Wait", text: "x" });
  await page.keyboard.press("Control+Enter"); await page.waitForTimeout(400);
  const disabled = await page.locator('button[data-act="undo"]').isDisabled();
  await page.locator('button[data-act="undo"]').click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(500);
  expect(!disabled && await page.locator("#compose").isVisible(), "Undo is enabled and cancels the send: " + JSON.stringify({ disabled }));
}, { settings: { undoSendSec: 5 } });

scenario("a refreshed list of more than a page offers no phantom Load more", async ({ page, mock }, expect) => {
  const TOTAL = 120;
  mock.handler = async ({ name, uri }) => {
    if (name !== "messageGroups.getList" || !/folderId%3A41\b/.test(uri)) return;
    const q = decodeURIComponent(uri), count = Number(q.match(/count:(\d+)/)[1]), offset = Number(q.match(/offset:(\d+)/)[1]);
    const all = Array.from({ length: TOTAL }, (_, i) => msg(i + 1, "41"));
    return { responses: [{ id: "GetMessageGroupList", httpCode: 200, response: { result: { messages: all.slice(offset, offset + count), query: {} } } }] };
  };
  await page.locator("#folder-list .folder .tw").first().click().catch(() => {});
  await page.locator("#folder-list .folder", { hasText: "Travel" }).locator(".tw").click().catch(() => {});
  await page.locator("#folder-list .folder", { hasText: "2025" }).click(); await page.waitForTimeout(600);
  const first = await page.locator("#more").isVisible();
  await page.click("#more-btn"); await page.waitForTimeout(600);
  const loaded = await page.locator("#rows .row").count(), afterMore = await page.locator("#more").isVisible();
  await page.locator("#list").focus(); await page.keyboard.press("R"); await page.waitForTimeout(800);
  const afterRefresh = await page.locator("#more").isVisible();
  expect(first && loaded === TOTAL && !afterMore && !afterRefresh, "Load more only while more exist: " + JSON.stringify({ first, loaded, afterMore, afterRefresh }));
});

scenario("a message that failed to open does not come back or print", async (h, expect) => {
  const { page, mock } = h;
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);
  mock.handler = async ({ name, uri }) => name === "messages.getBody" && uri.includes("MSG1_3/") ? { error: { code: "EC-5003", message: "Internal error" } } : undefined;
  await page.locator("#rows .row").nth(2).click(); await page.waitForTimeout(600);
  const pages = h.ctx.pages().length;
  await page.locator("#list").focus(); await page.keyboard.press("p"); await page.waitForTimeout(800);
  const st = await page.locator("#st-msg").textContent();
  expect(h.ctx.pages().length === pages && /open or select a message/.test(st) && await page.locator("#reader-head").isHidden(), "nothing prints: " + st);
}, { allow: /EC-5003|fetching/ });

scenario("Delete in a search of Trash deletes for good", async ({ page, calls }, expect) => {
  await folder(page, "Trash");
  await page.locator("#search").click(); await page.keyboard.type("x"); await page.keyboard.press("Enter"); await page.waitForTimeout(700);
  const chip = await page.locator("#search-scope").textContent();
  await page.locator("#rows .row").first().click(); await page.waitForTimeout(300);
  let asked = "";
  page.once("dialog", d => { asked = d.message(); d.accept(); });
  await page.locator("#list").focus(); await page.keyboard.press("#"); await page.waitForTimeout(700);
  expect(chip === "in Trash" && /Permanently delete/.test(asked) && calls.some(c => c.name === "messages.delete"), "permanent delete from a Trash search: " + JSON.stringify({ chip, asked }));
});

scenario("polling does not redraw folders or recount Starred for every change", async ({ page, calls, folders }, expect) => {
  await page.waitForTimeout(1500);
  const starredQ = () => calls.filter(c => c.name === "messageGroups.getList" && /is%3Aflagged/.test(c.envelope.requests[0].uri) && /count%3A500/.test(c.envelope.requests[0].uri)).length;
  await page.evaluate(() => { window.__redraws = 0; new MutationObserver(() => window.__redraws++).observe(document.getElementById("folder-list"), { childList: true }); });
  const s0 = starredQ();
  for (let i = 0; i < 3; i++) { folders.find(f => f.id === "41").highestModSeq++; await page.waitForTimeout(5200); }
  const redraws = await page.evaluate(() => window.__redraws), recounts = starredQ() - s0;
  expect(redraws === 0 && recounts <= 1, "folder changes that show nothing new: " + JSON.stringify({ redraws, recounts }));
}, { settings: { pollSec: 5 } });

// ---------- compose ----------
scenario("a discarded draft leaves the Drafts list", async ({ page, calls }, expect) => {
  await folder(page, "Draft");
  await page.locator("#rows .row").first().click();
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 });
  page.once("dialog", d => d.accept());
  await page.click("#c-discard");
  await page.waitForTimeout(1500);
  const rows = await subjects(page), del = calls.filter(c => c.name === "messages.delete").length;
  expect(del === 1 && !rows.includes("Subject 3-1"), "the draft is deleted and gone from the list: " + JSON.stringify({ del, rows: rows.slice(0, 3) }));
});

scenario("opening a message that no longer exists drops its row quietly", async ({ page, goneElsewhere }, expect) => {
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // its status would cover ours
  goneElsewhere.add("MSG1_2");     // removed elsewhere after the list loaded
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(1000);
  const rows = await subjects(page), n = await notice(page), st = await page.locator("#st-msg").textContent();
  expect(!rows.includes("Subject 1-2") && !n && /no longer exists/.test(st), "row dropped, said in the status line: " + JSON.stringify({ n, st }));
  await folder(page, "Draft");
  goneElsewhere.add("MSG3_2");
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(1000);
  const drafts = await subjects(page), n2 = await notice(page);
  expect(!drafts.includes("Subject 3-2") && !n2, "the same for a draft: " + JSON.stringify({ n2, drafts: drafts.slice(0, 3) }));
}, { allow: /EC-4007|status of 404/ });

scenario("the quoted original is part of the reply and can be answered inline", async ({ page, calls, mock }, expect) => {
  mock.patchBody = (id, m, body) => { if (id === "MSG1_2") body.html = "<p>First question?</p><p>Second question?</p>"; };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  await page.locator("#list").focus(); await page.keyboard.press("r"); await page.waitForSelector("#compose:not(.hidden)");
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ inEditor: !!document.querySelector("#c-editor .ymq blockquote"), frame: !!document.querySelector("#c-quote iframe"),
    caretAtTop: getSelection().anchorNode && document.getElementById("c-editor").firstChild?.contains(getSelection().anchorNode) }));
  expect(r.inEditor && !r.frame && r.caretAtTop, "the quote is in the editor, the caret above it: " + JSON.stringify(r));
  await page.keyboard.type("Top note.");
  // answer between the quoted paragraphs
  await page.locator("#c-editor blockquote p", { hasText: "First question?" }).click(); await page.keyboard.press("End");
  await page.keyboard.press("Enter"); await page.keyboard.type("Inline answer.");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 }).catch(() => {});
  const html = msgOf(calls.filter(c => c.name === "messages.saveAndSend").pop())?.simpleBody?.html || "";
  const at = s => html.indexOf(s);
  expect(at("Top note.") >= 0 && at("Top note.") < at("First question?") && at("First question?") < at("Inline answer.") && at("Inline answer.") < at("Second question?") &&
    (html.match(/First question\?/g) || []).length === 1, "the sent message has the answer between the questions, quoted once: " + html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  const outside = await page.evaluate(h => { const d = new DOMParser().parseFromString(h, "text/html"); const t = [...d.querySelectorAll("*")].find(e => e.childElementCount === 0 && e.textContent.includes("Inline answer.")) || null;
    return { found: !!t, quoted: !!t?.closest("blockquote"), second: !!d.evaluate("//blockquote[contains(., 'Second question?')]", d, null, 9, null).singleNodeValue }; }, html);
  expect(outside.found && !outside.quoted && outside.second, "Enter inside the quote splits it: the answer is not quoted, the rest still is: " + JSON.stringify(outside));
});

scenario("a quote from Spam keeps its images out of the app but sends them", async ({ page, calls, mock }, expect) => {
  mock.patchBody = (id, m, body) => { if (id.startsWith("MSG6_")) body.html = '<p>Spam text</p><img src="https://ecp.yusercontent.com/t-quote.png" width="5" height="5"><div style="width:9px;height:9px;background:url(https://ecp.yusercontent.com/t-qbg.png)">b</div>'; };
  await folder(page, "Spam");
  await page.locator("#rows .row").first().click(); await page.waitForTimeout(600);
  await page.locator("#list").focus(); await page.keyboard.press("r"); await page.waitForSelector("#compose:not(.hidden)");
  await page.waitForTimeout(800);
  const loaded = mock.images.filter(i => /t-q/.test(i.url)).map(i => i.url.split("/").pop());
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 }).catch(() => {});
  const html = msgOf(calls.filter(c => c.name === "messages.saveAndSend").pop())?.simpleBody?.html || "";
  expect(!loaded.length, "no image of the Spam quote loads while writing: " + JSON.stringify(loaded));
  expect(/src="https:\/\/ecp\.yusercontent\.com\/t-quote\.png"/.test(html) && /url\(https:\/\/ecp\.yusercontent\.com\/t-qbg\.png\)/.test(html) && !/data-held/.test(html), "the sent quote has them back: " + html.slice(0, 400));
});

scenario("the font size box sets the size it shows", async ({ page }, expect) => {
  await newMessage(page);
  const px = () => page.evaluate(() => { const n = getSelection().anchorNode; return getComputedStyle(n.nodeType === 1 ? n : n.parentElement).fontSize; });
  // a caret alone: the text typed next takes the size picked
  await page.keyboard.press("Control+Home");
  await page.locator("#c-size").selectOption("18"); await page.keyboard.type("typed at 18");
  const a = { px: await px(), box: await page.inputValue("#c-size") };
  expect(a.px === "18px" && a.box === "18", "a size picked at the caret applies to what is typed: " + JSON.stringify(a));
  // big text already in the message is left alone when another line is resized
  await page.evaluate(() => document.getElementById("c-editor").insertAdjacentHTML("beforeend", '<div id="big"><font size="7">big quoted</font></div>'));
  await page.keyboard.press("Enter"); await page.keyboard.type("second line"); await page.keyboard.press("Shift+Home");
  await page.locator("#c-size").selectOption("24");
  const b = await page.evaluate(() => ({ big: document.querySelector("#big font[size='7']") !== null, first: getComputedStyle([...document.querySelectorAll("#c-editor span")].find(e => e.textContent.replace(/\u200B/g, "") === "typed at 18")).fontSize }));
  expect(b.big && b.first === "18px", "only the selection changes size: " + JSON.stringify(b));
  // arrow keys step through sizes while the box keeps focus
  await page.locator("#c-size").focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
  const e = { box: await page.inputValue("#c-size"), focus: await page.evaluate(() => document.activeElement.id) };
  expect(e.box === "32" && e.focus === "c-size", "two steps down from 24 is 32, focus stays: " + JSON.stringify(e));
  // a size not in the list is shown in its place, not at the top
  await page.evaluate(() => document.getElementById("c-editor").insertAdjacentHTML("afterbegin", '<div><span style="font-size:15px">fifteen</span></div>'));
  await page.locator("#c-editor span", { hasText: "fifteen" }).click(); await page.waitForTimeout(100);
  const opts = await page.locator("#c-size option").evaluateAll(os => os.map(o => o.value).join(","));
  expect(opts.startsWith("8,9,10,11,12,13,14,15,16"), "15 sits between 14 and 16: " + opts);
});

scenario("a draft opens in the format it was saved in, whatever the default", async ({ page, calls, mock }, expect) => {
  mock.patchBody = (id, m, body) => {
    if (id === "MSG3_3") { m.headers.mimeType = "text/plain"; body.html = ""; body.text = "plain words\nsecond line"; }
  };
  const mode = () => page.inputValue("#c-mode");
  const openDraft = async i => { await page.locator("#rows .row").nth(i).click(); await page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 }); await page.waitForTimeout(300); };
  const closeIt = async () => { await page.click("#c-discard").catch(() => {}); };
  await folder(page, "Draft");
  // an HTML draft with the default set to plain text
  await openDraft(0);
  const a = { mode: await mode(), html: await page.locator("#c-editor").innerHTML() };
  page.once("dialog", d => d.dismiss()); await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  // a draft another client saved as plain text
  await openDraft(2);
  const b = { mode: await mode(), text: await page.inputValue("#c-text") };
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  // a draft this app saved as plain text, recorded by its csid
  await page.evaluate(() => chrome.storage.local.set({ draftFormats: { csid2: "text" } }));
  await openDraft(1);
  const c = { mode: await mode() };
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  const setting = await page.evaluate(async () => (await chrome.storage.local.get("settings")).settings.composeHtml);
  expect(a.mode === "html" && /<p>Body of/.test(a.html), "an HTML draft opens as HTML: " + JSON.stringify(a).slice(0, 200));
  expect(b.mode === "text" && b.text.startsWith("plain words\nsecond line"), "a plain-text draft opens as text with its own text: " + JSON.stringify(b));
  expect(c.mode === "text", "the recorded format wins: " + JSON.stringify(c));
  expect(setting === false, "opening drafts leaves the default alone: " + setting);
  // saving records the draft's format under its csid
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  await page.locator("#c-to input").type("q@example.com"); await page.keyboard.press("Enter");
  await page.locator("#c-text").focus(); await page.keyboard.type("text body");
  await page.keyboard.press("Control+s"); await page.waitForTimeout(500);
  const csid = msgOf(saves(calls).pop())?.message?.csid;
  const rec = await page.evaluate(k => chrome.storage.local.get("draftFormats").then(x => x.draftFormats?.[k]), csid);
  expect(rec === "text", "a save records the format: " + JSON.stringify({ csid, rec }));
}, { settings: { composeHtml: false } });

scenario("Tab from the subject goes to the message, past the toolbar", async ({ page }, expect) => {
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  await page.locator("#c-subject").focus(); await page.keyboard.type("Hello");
  await page.keyboard.press("Tab");
  const html = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.type("typed after Tab");
  const typed = await page.locator("#c-editor").innerText();
  // the same in plain text
  page.once("dialog", d => d.accept());
  await page.selectOption("#c-mode", "text");
  await page.waitForTimeout(200);
  await page.locator("#c-subject").focus(); await page.keyboard.press("Tab");
  const text = await page.evaluate(() => document.activeElement.id);
  expect(html === "c-editor" && typed.includes("typed after Tab") && text === "c-text", "Tab lands in the editor: " + JSON.stringify({ html, text }));
});

scenario("Insert link takes what people type, and edits or removes a link", async ({ page }, expect) => {
  const fresh = async () => { await page.evaluate(() => document.getElementById("compose").classList.add("hidden")); await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)"); await page.locator("#c-editor").focus(); await page.keyboard.press("Control+Home"); };
  const link = async answer => { let asked = null; page.once("dialog", d => { asked = d.defaultValue(); d.accept(answer); }); await page.click('[data-cmd="link"]'); await page.waitForTimeout(250); return asked; };
  const hrefs = () => page.locator("#c-editor a").evaluateAll(as => as.map(a => a.getAttribute("href")));
  await fresh(); await page.keyboard.type("site"); await page.keyboard.press("Shift+Home");
  await link("example.com");
  const a = await hrefs();
  await fresh(); await page.keyboard.type("mail me"); await page.keyboard.press("Shift+Home");
  await link("me@example.com");
  const b = await hrefs();
  await fresh(); await page.keyboard.type("nope"); await page.keyboard.press("Shift+Home");
  await link("not a link");
  const c = { hrefs: await hrefs(), st: await page.locator("#st-msg").textContent() };
  expect(a[0] === "https://example.com" && b[0] === "mailto:me@example.com", "bare domain and address become links: " + JSON.stringify({ a, b }));
  expect(!c.hrefs.length && /not a web or mail address/.test(c.st), "anything else says why: " + JSON.stringify(c));
  // the caret in a link: the dialog shows its address; a new one replaces it; nothing removes it
  await fresh(); await page.keyboard.type("docs"); await page.keyboard.press("Shift+Home");
  await link("https://example.com/old");
  await page.locator("#c-editor a").click(); await page.keyboard.press("ArrowLeft");
  const shown = await link("https://example.com/new");
  const d = await hrefs();
  await page.locator("#c-editor a").click(); await page.keyboard.press("ArrowLeft");
  await link("");
  const e = { hrefs: await hrefs(), text: await page.locator("#c-editor").innerText() };
  expect(shown === "https://example.com/old" && d.join() === "https://example.com/new", "an existing link is shown and replaced: " + JSON.stringify({ shown, d }));
  expect(!e.hrefs.length && e.text.startsWith("docs"), "an empty address removes the link, keeping its text: " + JSON.stringify(e));
});

scenario("every formatting tool does what it says, and can be undone", async ({ page }, expect) => {
  const fresh = async () => { await page.evaluate(() => document.getElementById("compose").classList.add("hidden")); await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)"); await page.locator("#c-editor").focus(); await page.keyboard.press("Control+Home"); await page.keyboard.type("alpha beta gamma"); };
  const body = () => page.evaluate(() => document.getElementById("c-editor").innerHTML.split('<div class="ymsig">')[0]);
  const selWord = async () => { await page.keyboard.press("Home"); for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight"); await page.keyboard.press("Control+Shift+ArrowRight"); };
  const tool = cmd => page.click(`[data-cmd="${cmd}"]`);
  // a horizontal line carries no stray id
  await fresh(); await page.keyboard.press("End"); await tool("insertHorizontalRule");
  const hr = await body();
  // the preformatted block toggles off again
  await fresh(); await tool("code"); await tool("code");
  const pre = await body();
  // clear formatting removes bold and size
  await fresh(); await selWord(); await tool("bold"); await page.locator("#c-size").selectOption("24"); await tool("removeFormat");
  const clear = await body();
  // the default text colour removes the colour
  await fresh(); await selWord(); await page.click('[data-pal="fore"]'); await page.locator("#c-palette .sw").nth(3).click();
  await page.click('[data-pal="fore"]'); await page.locator("#c-palette .pal-default").click();
  const colour = await body();
  // Enter in an indented paragraph keeps it indented: only quotes split
  await fresh(); await tool("indent"); await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.type("next");
  const indent = await page.evaluate(() => { const n = [...document.querySelectorAll("#c-editor div")].find(d => d.textContent === "next"); return !!n?.closest("blockquote"); });
  // buttons show what applies at the caret
  await fresh(); await selWord(); await tool("bold"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(150);
  const on = await page.locator('[data-cmd="bold"]').evaluate(b => b.classList.contains("on") && b.getAttribute("aria-pressed") === "true");
  await page.keyboard.press("Home"); await page.waitForTimeout(150);
  const off = await page.locator('[data-cmd="bold"]').evaluate(b => !b.classList.contains("on"));
  expect(/<hr>/.test(hr) && !/id=/.test(hr), "a plain <hr>: " + hr);
  expect(!/<pre/.test(pre), "the preformatted block goes off again: " + pre);
  expect(!/bold|font-size/.test(clear), "clear formatting clears: " + clear);
  expect(!/color/.test(colour), "the default colour removes the colour: " + colour);
  expect(indent, "Enter in an indent stays indented");
  expect(on && off, "the bold button shows bold at the caret: " + JSON.stringify({ on, off }));
});

scenario("font choices show one name and carry a fallback", async ({ page, calls }, expect) => {
  const s = await page.evaluate(() => [...document.querySelectorAll("#composeFont option")].map(o => [o.textContent, o.value]));
  const labels = s.map(x => x[0]);
  expect(labels[0] === "Helvetica" && labels.every(l => !l.includes(",") && !l.includes("default")), "short names in Settings: " + JSON.stringify(labels));
  expect(s.every(([, v]) => /,\s*(sans-serif|serif|monospace|cursive)$/.test(v)), "every choice ends in a generic family: " + JSON.stringify(s.map(x => x[1])));
  // a font saved earlier as a bare name is shown as its entry
  expect(await page.inputValue("#composeFont") === s.find(x => x[0] === "Georgia")[1], "a saved bare name maps to its entry: " + await page.inputValue("#composeFont"));
  // the composer's box: short names, and a pick applies the whole list
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  const shown = await page.locator("#c-font").evaluate(sel => sel.selectedOptions[0].textContent);
  await page.locator("#c-to input").type("q@example.com"); await page.keyboard.press("Enter");
  await page.fill("#c-subject", "Fonts");
  await page.locator("#c-editor").focus(); await page.keyboard.type("word"); await page.keyboard.press("Shift+Home");
  await page.locator("#c-font").selectOption({ label: "Consolas" });
  const picked = await page.locator("#c-font").evaluate(sel => sel.selectedOptions[0].textContent);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 }).catch(() => {});
  const html = msgOf(calls.filter(c => c.name === "messages.saveAndSend").pop())?.simpleBody?.html || "";
  expect(shown === "Georgia" && picked === "Consolas", "the composer shows short names: " + JSON.stringify({ shown, picked }));
  expect(/font-family:\s*Georgia, Times New Roman, Times, serif/.test(html) && /font-family:\s*"?Consolas"?, Menlo/.test(html), "the message carries the fallbacks: " + html.slice(0, 300));
}, { settings: { composeFont: "Georgia" } });

scenario("reopened draft keeps its Bcc", async ({ page, calls, mock }, expect) => {
  mock.patchBody = (id, message) => { if (id.startsWith("MSG3_")) message.headers.bcc = [{ name: "Hidden", email: "secret@x.com" }]; };
  await folder(page, "Draft");
  await page.locator("#rows .row").first().click();
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 });
  const chips = await page.locator("#c-bcc .chip").allTextContents();
  const shown = await page.locator("#c-bcc-row").isVisible();
  await page.locator("#c-editor").focus(); await page.keyboard.type("edited ");
  await page.keyboard.press("Escape"); await composerHidden(page);
  const bcc = msgOf(saves(calls).pop())?.message?.headers?.bcc || [];
  expect(chips.join().includes("secret@x.com") && shown, "the draft's Bcc is shown: " + JSON.stringify({ chips, shown }));
  expect(bcc.some(a => a.email === "secret@x.com"), "saving the draft keeps its Bcc: " + JSON.stringify(bcc));
});

scenario("text typed during a save is saved", async ({ page, calls, mock }, expect) => {
  mock.handler = async ({ name }) => { if (name === "messages.saveV3") await sleep(800); };
  await newMessage(page, { text: "first" });
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(100);
  await page.keyboard.type(" second");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Escape"); await composerHidden(page);
  const html = msgOf(saves(calls).pop())?.simpleBody?.html || "";
  expect(saves(calls).length === 2 && html.includes("first second"), "the text typed while saving reaches Drafts: " + JSON.stringify({ n: saves(calls).length, html }));
});

scenario("closing during a save that fails keeps the message", async ({ page, mock }, expect) => {
  let fail = 1;
  mock.handler = async ({ name }) => { if (name === "messages.saveV3") { await sleep(600); if (fail-- > 0) return { error: { code: "ES-5000", message: "save failed" } }; } };
  await newMessage(page, { subject: "Fragile", text: "keep me" });
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(100);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  // the failed save marks the message changed again, so closing saves it once more
  const open = await page.locator("#compose").isVisible();
  const st = await page.locator("#st-msg").textContent();
  expect(!open && st === "message saved to Drafts", "closing waits for the save and saves again when it failed: " + JSON.stringify({ open, st }));
});

scenario("a save still running when the message is sent", async ({ page, calls, mock }, expect) => {
  const done = [];
  mock.handler = async ({ name }) => { if (name === "messages.saveV3") { await sleep(800); done.push(calls.length); } };
  await newMessage(page, { subject: "Race", text: "body" });
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const sendAt = calls.findIndex(c => c.name === "messages.saveAndSend");
  const n = await notice(page);
  expect(!/could not be saved/.test(n), "no false save error after a send: " + n);
  expect(sendAt >= 0 && done.length === 1 && sendAt >= done[0], "the send waits for the save in flight: " + JSON.stringify({ sendAt, done }));
});

scenario("discard while the first save is running", async ({ page, calls, mock }, expect) => {
  mock.handler = async ({ name }) => { if (name === "messages.saveV3") await sleep(800); };
  await newMessage(page, { subject: "Gone", text: "body" });
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(100);
  page.once("dialog", d => d.accept());
  await page.click("#c-discard");
  await page.waitForTimeout(1500);
  const del = calls.filter(c => c.name === "messages.delete").map(c => c.envelope.requests[0].uri);
  expect(del.some(u => u.includes("MSGDRAFT_99")), "the draft saved after Discard is deleted: " + JSON.stringify(del));
  expect(!/could not/.test(await notice(page)), "no error notice: " + await notice(page));
});

scenario("outgoing mail carries no sender style sheet and no Yahoo address", async ({ page, calls, mock }, expect) => {
  mock.patchBody = (id, m, body) => { if (id.startsWith("MSG1_")) body.html += '<img src="https://cloud-apis.mail.yahoo.com/ws/v3/mailboxes/@.id==MB1/messages/@.id==X/content/parts/@.id==9/other">'; };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  const out = [];
  for (const key of ["f", "r"]) {
    await page.locator("#list").focus(); await page.keyboard.press(key); await page.waitForSelector("#compose:not(.hidden)");
    await page.locator("#c-to input").type("q@example.com"); await page.keyboard.press("Enter");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(n => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
    const html = msgOf(calls.filter(c => c.name === "messages.saveAndSend").pop())?.simpleBody?.html || "";
    out.push({ key, style: /<style/i.test(html), yahoo: /(src|href|srcset)="[^"]*mail\.yahoo\.com/i.test(html) });
    await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  }
  expect(out.every(o => !o.style && !o.yahoo), "forward and reply carry neither: " + JSON.stringify(out));
});

scenario("a plain-text reply quotes names and structure as text", async ({ page, mock }, expect) => {
  mock.patchBody = (id, m, body) => { if (id === "MSG1_2") { m.headers.from = [{ name: `O'Brien "AT&T"`, email: "ob@x.ie" }];
    body.html = '<p>See <a href="https://example.com/doc">the doc</a> and <a href="https://example.com/">https://example.com/</a></p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><table><tr><td>a</td><td>b</td></tr></table>'; } };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  await page.locator("#list").focus(); await page.keyboard.press("r"); await page.waitForSelector("#compose:not(.hidden)");
  await page.waitForTimeout(300);
  const text = await page.inputValue("#c-text");
  expect(/O'Brien "AT&T" <ob@x\.ie> wrote:/.test(text) && !/&#39;|&quot;|&amp;/.test(text), "the header reads as text: " + JSON.stringify(text.split("\n")[0]));
  expect(text.includes("the doc <https://example.com/doc>") && !text.includes("https://example.com/ <https://example.com/>"), "links keep their address once: " + JSON.stringify(text));
  expect(/> • one\n> • two/.test(text) && /> 1\. first/.test(text) && /> a\tb/.test(text), "bullets, numbers and cells survive: " + JSON.stringify(text));
}, { settings: { composeHtml: false } });

scenario("a send that fails after saving reopens with its Drafts copy", async ({ page, calls, mock }, expect) => {
  let fail = 1;
  mock.handler = async ({ name, top }) => {
    if (name !== "messages.saveAndSend" || fail-- <= 0) return;
    const ans = saveAnswer(top); ans.responses.find(x => x.id === "SendMessage").httpCode = 500; return ans;
  };
  await newMessage(page, { subject: "Bounce", text: "body" });
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 8000 });
  await page.waitForTimeout(300);
  page.once("dialog", d => d.accept());
  await page.click("#c-discard"); await page.waitForTimeout(600);
  const del = calls.filter(c => c.name === "messages.delete").map(c => c.envelope.requests[0].uri);
  expect(del.some(u => u.includes("MSGDRAFT_99")), "discarding it deletes the copy the failed send saved: " + JSON.stringify(del));
}, { allow: /send|HTTP 500/ });

scenario("saving again does not upload attachments again", async ({ page, calls, mock }, expect) => {
  let partial = 0;
  mock.handler = async ({ name, top }) => {
    if (name !== "messages.saveV3" && name !== "messages.saveAndSend") return;
    const refs = (top.payloadParts[0].payload.message.attachments || []).filter(a => a.messageReference);
    if (refs.length && partial > 0) { partial--; return saveAnswer(top, 206); }
    return saveAnswer(top);
  };
  await newMessage(page, { subject: "Big", text: "one" });
  await page.setInputFiles("#c-files", { name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(4096, 1) });
  await page.keyboard.press("Control+s"); await page.waitForTimeout(400);
  await page.locator("#c-editor").focus(); await page.keyboard.type(" two");
  await page.keyboard.press("Control+s"); await page.waitForTimeout(400);
  const [first, second] = saves(calls);
  const ref = msgOf(second)?.message?.attachments?.find(a => a.messageReference);
  expect(first?.fileParts.some(p => p[1] === "big.bin"), "the first save uploads the file");
  expect(second && !second.fileParts.length && ref?.messageReference.id === "MSGDRAFT_99" && ref.messageReference.pid === "2", "the next save refers to the saved part: " + JSON.stringify({ files: second?.fileParts, atts: msgOf(second)?.message?.attachments }));
  // Yahoo dropping a referenced part (HTTP 206): the save is repeated with the file uploaded
  partial = 1;
  await page.locator("#c-editor").focus(); await page.keyboard.type(" three");
  await page.keyboard.press("Control+s"); await page.waitForTimeout(600);
  const after = saves(calls).slice(2);
  expect(after.length === 2 && after[1].fileParts.some(p => p[1] === "big.bin"), "a dropped reference falls back to uploading: " + JSON.stringify(after.map(c => c.fileParts)));
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 }).catch(() => {});
  const sent = calls.filter(c => c.name === "messages.saveAndSend").pop();
  expect(sent?.fileParts.some(p => p[1] === "big.bin"), "a send always uploads its files: " + JSON.stringify(sent?.fileParts));
});

// ---------- runner ----------
(async () => {
  const args = process.argv.slice(2);
  const only = args.find(a => !a.startsWith("--"));
  const [k, n] = (args.find(a => /^--shard=\d+\/\d+$/.test(a))?.slice(8) || "1/1").split("/").map(Number);
  const failed = [];
  for (const [i, s] of scenarios.entries()) {
    if (i % n !== k - 1) continue;
    if (only && !s.name.includes(only)) continue;
    const h = await launch(s.opts);
    const local = [];
    const expect = (ok, what) => { if (!ok) local.push(what); };
    try {
      await start(h, s.opts);
      await s.fn(h, expect);
    } catch (e) { local.push("threw: " + (e.stack || e.message)); }
    if (h.unexpectedHosts.size) local.push("requests left for the real network: " + [...h.unexpectedHosts].join(", "));
    local.push(...h.errors.filter(e => !s.opts.allow?.test(e)));
    await h.close();
    console.log(`${local.length ? "FAIL" : "ok  "} ${s.name}`);
    for (const f of local) console.log("     " + f);
    if (local.length) failed.push(s.name);
  }
  if (failed.length) { console.error("FAILED:", failed); process.exit(1); }
  console.log("PASS");
})().catch(e => { console.error(e); process.exit(1); });
