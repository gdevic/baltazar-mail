// Browser tests for review findings: each scenario runs on a fresh profile against the mocked
// Yahoo in harness.js, so no scenario depends on another's state. node tools/review.js [filter]
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
  const counts = () => page.evaluate(async () => { const c = await import("./contacts.js"); return (await c.all()).reduce((n, e) => n + e.sent + e.received, 0); });
  await page.waitForFunction(() => /^address book:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  const first = await counts();
  // a full build again (as after an interrupted first build) must not count the same mail twice
  await page.evaluate(async () => { const c = await import("./contacts.js"); await c.sync({ inbox: "1", sent: "2", full: true }); });
  const again = await counts();
  expect(first > 0 && again === first, "a second full build counts each message once: " + JSON.stringify({ first, again }));
  // another tab hides an address; this tab then records mail to it
  const other = await h.ctx.newPage(); await other.goto(`chrome-extension://${h.extId}/mail.html`); await other.waitForSelector("#rows .row", { timeout: 15000 });
  await other.evaluate(async () => { const c = await import("./contacts.js"); await c.hide("s2@x.com"); });
  await page.evaluate(async () => { const c = await import("./contacts.js"); await c.noteSent([{ email: "s2@x.com" }]); });
  const seen = await other.evaluate(async () => { const c = await import("./contacts.js"); return c.lookup("s2@x.com"); });
  const here = await page.evaluate(async () => { const c = await import("./contacts.js"); return c.lookup("s2@x.com"); });
  expect(seen?.hidden && here?.hidden, "a hide in one tab survives a write in another: " + JSON.stringify({ other: seen?.hidden, here: here?.hidden }));
  await other.close();
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
  await page.waitForFunction(() => /^address book:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
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
  await page.waitForFunction(() => /^address book:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
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
  await page.waitForFunction(() => /^address book:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // its status would cover ours
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
  const only = process.argv[2];
  const failed = [];
  for (const s of scenarios) {
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
