// Browser tests for review findings: each scenario runs on a fresh profile against the mocked
// Yahoo in harness.js, so no scenario depends on another's state. node tools/review.js [filter]
const { launch } = require("./harness");

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
  await h.page.click("#c-quote-toggle"); await h.page.waitForTimeout(800);
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
    const t0 = performance.now();
    darkenHtml(`<div style="${"background:".repeat(90000)}">x</div><style>p{color:${"rgb(".repeat(250000)}}</style>`);
    return { out, ms: performance.now() - t0 };
  });
  const want = '<div style="color:#b1b1b1;background-color:#1f1f1f">a</div><font color="#e4e4e4">b</font><table bgcolor="#1f1f1f"><tbody><tr><td>c</td></tr></tbody></table>' +
    '<div style="background:url(x.png);color:#000">d</div><div style="background-image:url(y.png);color:#111111"><span style="color:#000">e</span></div><style>p{color:#e4e4e4}</style>';
  expect(r.out === want, "darkened HTML: " + r.out);
  expect(r.ms < 1500, "crafted style text darkens in linear time: " + Math.round(r.ms) + " ms");
});

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

// ---------- compose ----------
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
  await page.click("#c-quote-toggle"); await page.waitForTimeout(300);
  const text = await page.frameLocator("#c-quote iframe").locator("pre").textContent();
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
