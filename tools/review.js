// Browser tests for review findings: each scenario runs on a fresh profile against the mocked
// Yahoo in harness.js, so no scenario depends on another's state, and several processes can each
// run a share of them at once (--shard=k/n: every nth scenario from the kth; tools/check.js).
// node tools/review.js [filter] [--shard=k/n]
const fs = require("fs"), path = require("path");
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
// The status bar's Undo and Redo say in their tooltips what they would take.
const undoTip = page => page.locator('#st-acts [data-act="undo"]').getAttribute("title");
const undoTips = page => page.locator("#st-acts").evaluate(s => [...s.querySelectorAll("button[data-act]")].map(b => b.title).join("   "));
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

// The print dialog blocks the mail tab too, so the mail tab says why for as long as the print tab is open.
scenario("the mail tab says it is paused while the print tab is open", async (h, expect) => {
  await h.page.locator("#rows .row").nth(1).click(); await h.page.waitForTimeout(600);
  const p = await printOpen(h);
  const up = await h.page.locator("#printbox").isVisible();
  await h.page.keyboard.press("?"); await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(200);
  const held = await h.page.locator("#printbox").isVisible(), help = await h.page.locator("#help").isVisible();
  await p.close();
  const gone = await h.page.waitForSelector("#printbox", { state: "hidden", timeout: 3000 }).then(() => true, () => false);
  expect(up && held && !help && gone, "the notice is up with the print tab, takes no keys, and goes with the tab: " + JSON.stringify({ up, held, help, gone }));
});

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

// ---------- tracking pictures ----------
// Each picture is named by its alt and its address: pix- ones are trackers, keep- ones are not.
scenario("tracking pictures leave the message and its forward, and nothing else does", async ({ page, mock }, expect) => {
  const proxied = u => `https://ecp.yusercontent.com/mail?url=${encodeURIComponent(u)}&amp;t=1`;
  const own = "https://cloud-apis.mail.yahoo.com/ws/v3/mailboxes/@.id==MB1/messages/@.id==MSG1_2/content/parts/@.id==2/thumbnail&amp;appid=x&amp;pid=2";
  const pics = [
    ["pix-attr", proxied("https://track.example/pix-attr.gif?r=1"), 'width="1" height="1" border="0"'],
    ["pix-style", proxied("https://track.example/pix-style.gif"), 'style="height:1px !important;width:1px !important;border-width:0 !important"'],
    ["pix-open", proxied("https://u1.ct.sendgrid.net/wf/open?upn=pix-open"), 'width="20" height="20"'],
    ["keep-real", proxied("https://news.example/keep-real.png"), 'width="600" height="300"'],
    ["keep-spacer", proxied("https://news.example/keep-spacer.gif"), 'width="640" height="1"'],
    ["keep-hidden", proxied("https://news.example/keep-hidden.png"), 'height="200" style="display:none;max-height:0;width:0;overflow:hidden"'],
    ["keep-resized", proxied("https://news.example/keep-resized.png"), 'width="1" height="1" style="width:300px;height:100px"'],
    ["keep-own", own, 'width="1" height="1"'],
    ["keep-data", "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", 'width="1" height="1"'],
  ];
  mock.patchBody = (id, m, body) => { if (id === "MSG1_2") body.html += pics.map(([alt, src, rest]) => `<img alt="${alt}" src="${src}" ${rest}>`).join(""); };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(900);
  const shown = await page.frameLocator("#r-body").locator("img").evaluateAll(imgs => imgs.map(i => i.alt).filter(a => /^(pix|keep)-/.test(a)));
  expect(JSON.stringify(shown) === JSON.stringify(pics.map(p => p[0]).filter(a => a.startsWith("keep-"))), "the reader shows every picture but the trackers: " + JSON.stringify(shown));
  const asked = mock.images.map(i => i.url);
  expect(!asked.some(u => /pix-/.test(u)) && asked.some(u => u.includes("keep-real")), "no tracker is asked for, the real picture is: " + JSON.stringify(asked));
  await page.locator("#list").focus(); await page.keyboard.press("f"); await page.waitForSelector("#compose:not(.hidden)");
  await page.waitForTimeout(800);
  const quote = await page.locator("#c-editor").innerHTML();
  expect(!/pix-/.test(quote) && quote.includes("keep-real") && quote.includes("keep-spacer"), "the forward's quote carries no tracker: " + quote.replace(/\s+/g, " ").slice(-900));
});

// ---------- style sheets ----------
// Sheets that begin with @import rules (a web font's address holds semicolons of its own) are read
// without them, so the browser has nothing to refuse and say in the console, and the reader nothing
// to block. The rest stays: a sheet written back for a rule that reads the message, as written otherwise.
scenario("a message's style sheets lose the @import rules they begin with, quietly, and keep the rest", async ({ page, mock }, expect) => {
  const said = [];
  page.on("console", m => { if (/@import/.test(m.text())) said.push(m.text().slice(0, 80)); });
  const font = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');";
  mock.patchBody = (id, m, body) => {
    if (id === "MSG1_2") body.html = `<style>@charset "utf-8"; /* fonts; and more */ ${font} @import "https://x.example/a;b.css" screen and (min-width: 600px);\n.lead { color: rgb(255, 0, 0) } a[href^="https://bank"] { color: blue }</style>` +
      `<style>${font}\n.tail { color: rgb(0, 128, 0) }</style><p class="lead">Lead</p><p class="tail">Tail</p><a href="https://bank.example/">bank</a>` + body.html;
  };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(900);
  const frame = page.frameLocator("#r-body");
  const sheets = await frame.locator("style").evaluateAll(s => s.map(x => x.textContent).join("\n"));
  const colours = { lead: await frame.locator("p.lead").evaluate(e => getComputedStyle(e).color), tail: await frame.locator("p.tail").evaluate(e => getComputedStyle(e).color) };
  expect(!said.length, "nothing about @import in the console: " + JSON.stringify(said));
  expect(!/@import/i.test(sheets) && /\.lead/.test(sheets) && /\.tail/.test(sheets) && !/href\^=/.test(sheets) && colours.lead === "rgb(255, 0, 0)" && colours.tail === "rgb(0, 128, 0)",
    "the imports are gone, the rest kept but for the rule that reads the message: " + JSON.stringify({ colours, sheets: sheets.slice(0, 600) }));
});

// ---------- attachments ----------
// Each picture the viewer steps past lets go of its bytes; only the file on screen holds any.
scenario("the viewer lets go of a picture's bytes when it moves on", async ({ page }, expect) => {
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  await page.evaluate(() => { window.revoked = []; const was = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = u => { window.revoked.push(u); was(u); }; });
  await page.locator("#r-attach .att-card").nth(3).click();
  await page.waitForSelector("#v-body img.v-img", { timeout: 10000 });
  const src = await page.locator("#v-body img.v-img").getAttribute("src");
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await page.waitForTimeout(600);
  const r = { blob: src?.startsWith("blob:"), let: (await page.evaluate(() => window.revoked)).includes(src) };
  expect(r.blob && r.let, "the picture's object URL is revoked when the next file shows: " + JSON.stringify(r));
});

// A file's kind comes from its name; the sender's type decides only where the name says nothing.
scenario("a file's kind follows its name before the type its sender gave", async ({ page }, expect) => {
  const kinds = await page.evaluate(async () => {
    const { kindOf } = await import("./viewer.js");
    return [["contract.docx", "application", "zip"], ["budget.xlsx", "application", "x-zip-compressed"], ["notes.txt", "text", "html"], ["photo", "image", "jpeg"], ["blob", "application", "zip"]]
      .map(([filename, type, subtype]) => kindOf({ filename, type, subtype }));
  });
  expect(JSON.stringify(kinds) === JSON.stringify(["doc", "sheet", "text", "image", "zip"]), "kinds: " + JSON.stringify(kinds));
});

// Esc in an address field with no suggestions open closes the composer, as anywhere in it.
scenario("Esc in To closes the composer", async ({ page }, expect) => {
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  const inTo = await page.evaluate(() => document.activeElement === document.querySelector("#c-to input"));
  await page.keyboard.press("Escape");
  await composerHidden(page);
  expect(inTo && await page.locator("#compose").evaluate(c => c.classList.contains("hidden")), "the composer closed from To: " + inTo);
});

// A folder whose attachments cannot be listed says so, and not that it has none.
scenario("the Files view says when a folder's attachments could not be loaded", async (h, expect) => {
  const { page } = h, prev = h.mock.handler;
  h.mock.handler = a => /has:attachment/.test(decodeURIComponent(a.top?.uri || "")) ? { error: { code: "EC-5000", description: "down" } } : prev?.(a);
  await menuOf(page, folderRow(page, "Projects")); await pickMenu(page, "Show attachments");
  await page.waitForFunction(() => /could not|No attachments/.test(document.getElementById("f-rows")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  const r = { rows: await page.locator("#f-rows").textContent(), count: await page.locator("#f-count").textContent() };
  expect(/could not be loaded/.test(r.rows) && !/No attachments/.test(r.rows) && !r.count, "a failure, not an empty folder: " + JSON.stringify(r));
}, { allow: /EC-5000|status of 5/ });

// Attachments download in one ZIP file: right-click under a message offers all of them, and the
// selected ones (Ctrl-click) once some but not all are selected; a folder's attachments offer the
// same, with Ctrl+A, x and Esc as in the message list. Each file keeps its bytes and its name, is
// dated with its message, a name that repeats is numbered, a file that cannot be fetched is left
// out and named, more than the cap is refused, and one file alone is saved as itself.
scenario("attachments download in one ZIP file, all of them or the selected ones", async (h, expect) => {
  const { page, mock } = h, JSZip = require("../ext/vendor/jszip.min.js");
  // deck.pptx is missing from the message source, so it cannot be fetched
  mock.patchRaw = raw => raw.replace(/--BOUND\r\nContent-Type: application\/octet-stream; name="deck\.pptx"[\s\S]*?(?=--BOUND--)/, "");
  const saved = async pick => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), pick()]);
    return { name: dl.suggestedFilename(), bytes: fs.readFileSync(await dl.path()) };
  };
  const zipOf = async pick => {
    const { name, bytes } = await saved(pick), z = await JSZip.loadAsync(bytes, { checkCRC32: true });
    return { name, files: Object.keys(z.files), z };
  };
  const stamp = d => [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()].join("-");
  const utc = d => [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()].join("-");   // JSZip reads the MS-DOS date as UTC
  const card = i => page.locator("#r-attach .att-card").nth(i);
  await page.locator("#rows .row").nth(1).click();
  await page.waitForSelector("#r-attach .att-card");
  // under a message: Download all alone, then Download selected for two of the seven
  const plain = await menuOf(page, card(0));
  expect(JSON.stringify(plain) === JSON.stringify(["Download all"]), "with nothing selected the menu has Download all alone: " + JSON.stringify(plain));
  await page.keyboard.press("Escape");
  await card(1).click({ modifiers: ["Control"] }); await card(3).click({ modifiers: ["Control"] });
  const picked = { marked: await page.locator("#r-attach .att-card.marked").count(), viewer: await page.locator("#viewer").isVisible() };
  expect(picked.marked === 2 && !picked.viewer, "Ctrl-click selects a file and does not preview it: " + JSON.stringify(picked));
  const some = await menuOf(page, card(0));
  expect(JSON.stringify(some) === JSON.stringify(["Download all", "Download selected (2)"]), "with some selected the menu offers them too: " + JSON.stringify(some));
  const sel = await zipOf(() => pickMenu(page, "Download selected"));
  const csv = await sel.z.file("data.csv")?.async("string"), when = new Date(Number(msg(2, "1").headers.date) * 1000);
  expect(sel.name === "Subject 1-2.zip" && sel.files.join("|") === "data.csv|photo.png" && csv === "name,qty\nZ80,2\n6502,1\n",
    "the selected files, in a ZIP named after the subject: " + JSON.stringify({ name: sel.name, files: sel.files, csv }));
  const dated = sel.files.map(f => utc(sel.z.files[f].date));
  expect(dated.every(d => d === stamp(when)), "each file is dated with its message: " + JSON.stringify({ dated, want: stamp(when) }));
  await page.keyboard.press("Escape");
  expect(!(await page.locator("#r-attach .att-card.marked").count()), "Esc deselects the files");
  // all of them: the one missing from the source is left out and named
  const all = await zipOf(async () => { await menuOf(page, card(0)); await pickMenu(page, "Download all"); });
  const pdf = (await all.z.file("report.pdf")?.async("nodebuffer"))?.equals(fs.readFileSync(path.join(h.FX, "report.pdf")));
  const left = await notice(page);
  expect(all.files.join("|") === "report.pdf|data.csv|src.zip|photo.png|cv.docx|budget.xlsx" && pdf, "every file that could be fetched, byte for byte: " + JSON.stringify({ files: all.files, pdf }));
  expect(/^Left out of Subject 1-2\.zip, as it could not be fetched: "deck\.pptx"\.$/.test(left), "the file left out is named: " + left);
  // more than the cap is refused
  await page.evaluate(async () => { (await import("./viewer.js")).ZIP_MAX.files = 3; });
  const refused = page.waitForEvent("download", { timeout: 1500 }).then(() => true, () => false);
  await menuOf(page, card(0)); await pickMenu(page, "Download all");
  const capped = { downloaded: await refused, said: await notice(page) };
  expect(!capped.downloaded && /^Too much for one ZIP file: 7 attachments, .+\. Select at most 3 attachments and 100 MB\.$/.test(capped.said), "more than the cap is refused: " + JSON.stringify(capped));
  await page.evaluate(async () => { (await import("./viewer.js")).ZIP_MAX.files = 100; });
  // a folder's attachments: f.pdf of two messages
  await menuOf(page, folderRow(page, "Inbox")); await pickMenu(page, "Show attachments");
  await page.waitForSelector("#f-rows .frow", { timeout: 8000 });
  const row = i => page.locator("#f-rows .frow").nth(i);
  const rowMenu = await menuOf(page, row(0));
  expect(rowMenu.includes("Download all") && !rowMenu.some(t => t.startsWith("Download selected")), "a folder's list offers Download all: " + JSON.stringify(rowMenu));
  await page.keyboard.press("Escape");
  await row(0).click({ modifiers: ["Control"] });
  const one = await menuOf(page, row(0));
  expect(one.includes("Download selected (1)"), "one of two selected: " + JSON.stringify(one));
  const single = await saved(() => pickMenu(page, "Download selected"));
  expect(single.name === "f.pdf" && single.bytes.equals(fs.readFileSync(path.join(h.FX, "report.pdf"))), "one file is saved as itself: " + single.name);
  await page.locator("#list").focus(); await page.keyboard.press("Control+a");
  const every = { marked: await page.locator("#f-rows .frow.marked").count(), count: await page.locator("#f-count").textContent(), menu: await menuOf(page, row(1)) };
  expect(every.marked === 2 && every.count === "2 attachments · 2 selected" && !every.menu.some(t => t.startsWith("Download selected")), "Ctrl+A selects every file listed, and all are no longer some: " + JSON.stringify(every));
  const folderZip = await zipOf(() => pickMenu(page, "Download all"));
  expect(folderZip.name === "Inbox attachments.zip" && folderZip.files.join("|") === "f.pdf|f (2).pdf", "a folder's ZIP is named after it, a repeated name numbered: " + JSON.stringify({ name: folderZip.name, files: folderZip.files }));
  await page.locator("#list").focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  const esc = { marked: await page.locator("#f-rows .frow.marked").count(), pane: await page.locator("#files-pane").isVisible() };
  await page.keyboard.press("x");
  esc.x = await page.locator("#f-count").textContent();
  expect(!esc.marked && esc.pane && esc.x === "2 attachments · 1 selected", "Esc deselects and stays in the list, x selects the cursor's file: " + JSON.stringify(esc));
});

// The name dialog keeps Tab inside itself however many times it opens.
scenario("the folder name dialog keeps Tab inside itself", async ({ page }, expect) => {
  const where = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  const r = [];
  for (let n = 0; n < 3; n++) {
    await menuOf(page, page.locator(".folders-head")); await pickMenu(page, "New folder...");
    await page.waitForSelector("#promptbox:not(.hidden)");
    const steps = [await where()];
    for (const key of ["Tab", "Tab", "Tab", "Shift+Tab"]) { await page.keyboard.press(key); steps.push(await where()); }
    r.push(steps.join(">"));
    await page.locator("#prompt-cancel").click(); await page.waitForTimeout(150);
  }
  expect(r.every(x => x === r[0]) && r[0].split(">").every(id => /^prompt-/.test(id)), "the same Tab order each time, always in the dialog: " + JSON.stringify(r));
});

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

// The preview frame (the sandboxed render.html) once it has drawn.
async function previewFrame(page) {
  await page.waitForFunction(() => { const f = document.querySelector("#v-body .v-box"); return f && f.style.visibility === "" && !document.querySelector("#v-body .v-center"); }, null, { timeout: 15000 });
  return page.frames().find(f => f.url().endsWith("/render.html") && !f.isDetached());
}
const partBytes = (raw, name, bytes) => raw.replace(new RegExp(`(filename="${name.replace(".", "\\.")}"\\r\\n\\r\\n)[\\s\\S]*?(\\r\\n--BOUND)`), (all, head, tail) => head + bytes.toString("base64") + tail);

scenario("a picture opens whole on a checkerboard; the wheel zooms it under the pointer and a drag moves it, no further than its edge", async ({ page, mock }, expect) => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="#246"/><circle cx="600" cy="400" r="200" fill="#fc0"/></svg>');
  mock.patchBody = (id, m) => { if (id.startsWith("MSG1_")) { m.attachments[3].filename = "plan.svg"; m.attachments[3].subtype = "svg+xml"; } };
  mock.patchRaw = raw => partBytes(raw, "photo.png", svg);
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  await page.locator("#r-attach .att-card").nth(3).click();
  await page.waitForSelector("#v-body img.v-img.placed", { timeout: 10000 });
  const look = () => page.evaluate(() => {
    const canvas = document.querySelector("#v-body .v-canvas"), c = canvas.getBoundingClientRect(), i = canvas.firstChild.getBoundingClientRect(), css = getComputedStyle(canvas);
    return { cx: c.left, cy: c.top, cw: c.width, ch: c.height, x: i.left - c.left, y: i.top - c.top, w: i.width, h: i.height, pan: canvas.classList.contains("pan"), cursor: css.cursor,
      checks: css.backgroundImage.includes("conic-gradient"), meta: document.getElementById("v-meta").textContent, bar: !document.getElementById("v-zoom").classList.contains("hidden"),
      open: !document.getElementById("viewer").classList.contains("hidden") };
  });
  const near = (a, b, by = 1) => Math.abs(a - b) <= by;
  const whole = await look();
  expect(whole.checks && whole.bar && !whole.pan && whole.cursor !== "grab" && whole.w <= whole.cw + 1 && whole.h <= whole.ch + 1 && near(whole.w / whole.h, 1.5, 0.01) &&
    near(whole.x, (whole.cw - whole.w) / 2) && near(whole.y, (whole.ch - whole.h) / 2) && /2400 × 1600 · \d+%/.test(whole.meta),
    "it opens whole and centred on the checkerboard, its size and zoom said: " + JSON.stringify(whole));
  // the wheel zooms in; once the picture is larger than the pane both ways (until then it is kept
  // centred), the point of the picture under the pointer stays under it
  const px = whole.cx + whole.cw * 0.3, py = whole.cy + whole.ch * 0.3;
  const under = g => [(px - g.cx - g.x) / g.w, (py - g.cy - g.y) / g.h];
  await page.mouse.move(px, py);
  for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(200);
  const larger = await look();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(200);
  const zoomed = await look();
  expect(larger.w > larger.cw && larger.h > larger.ch && zoomed.w > whole.w * 1.6 && zoomed.pan && zoomed.cursor === "grab" && near(under(zoomed)[0], under(larger)[0], 0.005) && near(under(zoomed)[1], under(larger)[1], 0.005),
    "the wheel zooms in about the pointer, and the picture can then be moved: " + JSON.stringify({ larger: under(larger), zoomed: under(zoomed), w: [whole.w, larger.w, zoomed.w], pane: [larger.cw, larger.ch], cursor: zoomed.cursor }));
  // a drag moves it by as much as the pointer moves
  await page.mouse.down(); await page.mouse.move(px + 40, py + 30, { steps: 4 });
  const held = await look();
  await page.mouse.up();
  const moved = await look();
  expect(held.cursor === "grabbing" && moved.cursor === "grab" && near(moved.x, zoomed.x + 40) && near(moved.y, zoomed.y + 30) && near(moved.w, zoomed.w),
    "a drag moves it with the pointer: " + JSON.stringify({ from: [zoomed.x, zoomed.y], to: [moved.x, moved.y], held: held.cursor }));
  // past its edge it stops, and letting go over the backdrop does not close the viewer
  const [vw, vh] = await page.evaluate(() => [innerWidth, innerHeight]);
  await page.mouse.move(px, py); await page.mouse.down(); await page.mouse.move(vw - 4, vh - 4, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(200);
  const edge = await look();
  expect(edge.open && near(edge.x, 0) && near(edge.y, 0), "a drag stops at the picture's edge, and ending over the backdrop keeps the viewer open: " + JSON.stringify(edge));
  // 0 shows it whole again; zooming in stops at its own size on the way, and zooming out ends at whole
  await page.mouse.move(px, py);
  await page.keyboard.press("0"); await page.waitForTimeout(100);
  const again = await look();
  expect(near(again.w, whole.w) && near(again.x, whole.x) && near(again.y, whole.y) && !again.pan, "0 shows it whole again: " + JSON.stringify(again));
  for (let i = 0; i < 12 && !/ · 100%/.test((await look()).meta); i++) await page.mouse.wheel(0, -100);
  const own = await look();
  expect(near(own.w, 2400) && / · 100%/.test(own.meta), "zooming in stops at the picture's own size: " + JSON.stringify({ w: own.w, meta: own.meta }));
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 100);
  await page.waitForTimeout(100);
  const out = await look();
  expect(near(out.w, whole.w) && near(out.x, whole.x) && !out.pan, "zooming out ends at whole: " + JSON.stringify(out));
  // + zooms about the middle of the pane
  await page.click("#v-zin"); await page.waitForTimeout(100);
  const plus = await look();
  expect(near(plus.w, whole.w * 1.25) && near(plus.x + plus.w / 2, plus.cw / 2), "+ zooms about the middle: " + JSON.stringify(plus));
  // a light theme: what the sandbox draws is on white paper
  await page.click("#v-prev");
  const f = await previewFrame(page);
  const paper = await f.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, dark: document.documentElement.classList.contains("dark") }));
  expect(paper.bg === "rgb(255, 255, 255)" && !paper.dark && await page.locator("#v-zoom").isHidden(), "in a light theme a listing is on white, and has no zoom buttons: " + JSON.stringify(paper));
});

scenario("in a dark theme the viewers take the app's colours, a document's pages stay paper and an HTML attachment is darkened as a message is", async ({ page, mock }, expect) => {
  mock.patchBody = (id, m) => { if (id.startsWith("MSG1_")) Object.assign(m.attachments[1], { filename: "page.html", subtype: "html" }); };
  mock.patchRaw = raw => partBytes(raw, "data.csv", Buffer.from('<div style="background-color:#ffffff;color:#000000">Hello</div>'));
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  const app = await page.evaluate(() => {
    const rgb = v => { const i = document.body.appendChild(document.createElement("i")); i.style.color = v; const out = getComputedStyle(i).color; i.remove(); return out; };
    const css = getComputedStyle(document.documentElement);
    return { bg: rgb(css.getPropertyValue("--bg")), fg: rgb(css.getPropertyValue("--fg")), bg2: rgb(css.getPropertyValue("--bg2")) };
  });
  // the ZIP listing: the app's page and text colours, its heading the panel colour
  await page.locator("#r-attach .att-card").nth(2).click();
  let f = await previewFrame(page);
  const zip = await f.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.querySelector("td")).color, head: getComputedStyle(document.querySelector("th")).backgroundColor,
    scheme: getComputedStyle(document.documentElement).colorScheme }));
  const outer = await page.evaluate(() => ({ body: getComputedStyle(document.getElementById("v-body")).backgroundColor, frame: getComputedStyle(document.querySelector("#v-body .v-box")).backgroundColor }));
  expect(zip.bg === app.bg && zip.fg === app.fg && zip.head === app.bg2 && zip.scheme === "dark" && outer.body === app.bg && outer.frame === app.bg,
    "a listing has the app's colours, inside the frame and around it: " + JSON.stringify({ app, zip, outer }));
  // the picture: darker checks
  await page.click("#v-next");
  await page.waitForSelector("#v-body img.v-img.placed", { timeout: 10000 });
  const checks = await page.evaluate(() => getComputedStyle(document.querySelector("#v-body .v-canvas")).backgroundImage);
  expect(/conic-gradient\(rgb\(43, 43, 43\)/.test(checks), "the checkerboard under a picture is dark: " + checks);
  // the Word document: its pages white, what they lie on the app's
  await page.click("#v-next");
  f = await previewFrame(page);
  await f.waitForSelector("section.docx", { timeout: 10000 });
  const doc = await f.evaluate(() => ({ desk: getComputedStyle(document.querySelector(".docx-wrapper")).backgroundColor, page: getComputedStyle(document.querySelector("section.docx")).backgroundColor,
    scheme: getComputedStyle(document.querySelector("section.docx")).colorScheme }));
  expect(doc.desk === app.bg && doc.page === "rgb(255, 255, 255)" && doc.scheme === "light", "a Word document's pages stay white on the app's background: " + JSON.stringify(doc));
  await page.click("#v-close");
  // the HTML attachment: darkened as the reader darkens a message, and as written when messages are
  const html = async () => { await page.locator("#r-attach .att-card").nth(1).click(); await page.waitForSelector("#v-body iframe[sandbox='']", { timeout: 10000 }); const s = await page.locator("#v-body iframe").getAttribute("srcdoc"); await page.click("#v-close"); return s; };
  const dark = await html();
  expect(/color-scheme:dark/.test(dark) && !/#ffffff/i.test(dark) && !/color:\s*#000000/i.test(dark) && /Hello/.test(dark), "an HTML attachment is darkened: " + dark.slice(-260));
  await page.click("#r-dark"); await page.waitForTimeout(300);
  const asWritten = await html();
  expect(!/color-scheme:dark/.test(asWritten) && /#ffffff/i.test(asWritten), "and shown as written once messages are: " + asWritten.slice(-200));
}, { settings: { theme: "dark" } });

scenario("a PDF the viewer has to repair is shown without a warning in the console", async ({ page, mock, FX }, expect) => {
  // its startxref points nowhere, so PDF.js indexes the file and would warn that it did
  const pdf = Buffer.from(fs.readFileSync(path.join(FX, "report.pdf")).toString("latin1").replace(/startxref\n\d+/, "startxref\n12"), "latin1");
  mock.patchRaw = raw => partBytes(raw, "report.pdf", pdf);
  const warnings = [];
  page.on("console", m => { if (/Warning:/.test(m.text())) warnings.push(m.text().slice(0, 120)); });
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  await page.locator("#r-attach .att-card").nth(0).click();
  const f = await previewFrame(page);
  await page.waitForTimeout(800);
  const pages = await f.evaluate(() => document.querySelectorAll(".pdfViewer .page").length);
  expect(pages === 2 && !warnings.length, "the repaired PDF shows, and nothing is logged: " + JSON.stringify({ pages, warnings }));
});

// The browser lets the sandboxed preview take focus only once it has it (the harness asks for that),
// so what scrolls gets the keys when the viewer focuses the frame, with no click in it first.
scenario("a preview has the keys as soon as it opens: PageDown scrolls a PDF, and a spreadsheet's grid has them", async ({ page }, expect) => {
  const keys = f => f.evaluate(() => ({ has: document.hasFocus(), at: document.activeElement?.id || document.activeElement?.className || document.activeElement?.localName, top: Math.round(document.getElementById("root").scrollTop) }));
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  await page.locator("#r-attach .att-card", { hasText: "report.pdf" }).click();
  let f = await previewFrame(page);
  await f.waitForFunction(() => document.querySelector(".pdfViewer .page canvas"), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const pdf = await keys(f);
  await page.keyboard.press("PageDown"); await page.waitForTimeout(400);
  pdf.paged = (await keys(f)).top;
  await page.click("#v-close");
  await page.locator("#r-attach .att-card", { hasText: "budget.xlsx" }).click();
  f = await previewFrame(page);
  await page.waitForTimeout(300);
  const sheet = await keys(f);
  expect(pdf.has && pdf.at === "root" && pdf.paged > pdf.top, "the PDF's pages scroll with PageDown at once: " + JSON.stringify(pdf));
  expect(sheet.has && sheet.at === "grid", "a spreadsheet's grid has the keys at once: " + JSON.stringify(sheet));
});

// Yahoo's converter refuses a file it does not take, also with HTTP 400 to the request (as for a
// winmail.dat): the notice says only that there is no preview. A password-protected file says so.
scenario("a file the converter refuses has no preview, with no reason given unless it is password protected", async ({ page, mock }, expect) => {
  let answer = null;
  mock.handler = async ({ name, top }) => name === "document.fetch" && answer ? { responses: [answer(top)] } : undefined;
  const notice = async refusal => {
    answer = refusal;
    await page.locator("#r-attach .att-card", { hasText: "deck.pptx" }).click();
    await page.waitForSelector("#v-body .v-center #v-dl2", { timeout: 15000 });
    const text = await page.locator("#v-body .v-center").textContent();
    await page.click("#v-close");
    return text;
  };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  const refused = await notice(top => ({ id: top.id, httpCode: 400, response: { error: { code: "EC-4001" } } }));
  const locked = await notice(top => ({ id: top.id, httpCode: 200, response: { code: 816, statuscode: 600, pages: {} } }));
  expect(/^No preview available for this file\. View as text/.test(refused), "a refusal says only that there is no preview: " + refused);
  expect(/^No preview available for this file \(it is password protected\)\. View as text/.test(locked), "a password-protected file says so: " + locked);
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
  // hid, one the user pinned, one the user named, one the user deleted, and a sender under an old
  // name and a writing to them that the mail does not show.
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
          { email: "s2@x.com", name: "Two Given", nameBy: {}, last: 1500000000, lastSent: 0, given: "Two Given" },
          { email: "s3@x.com", name: "Sender 3", nameBy: {}, last: 1500000000, lastSent: 0, deleted: true },
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
    return { gone: await c.lookup("gone@old.example"), hid: await c.lookup("hid@old.example"), pin: await c.lookup("pin@old.example"), s1: await c.lookup("s1@x.com"), s2: (await c.lookup("s2@x.com"))?.name, s3: await c.lookup("s3@x.com"), ...kept, now: c.DB_VERSION };
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
  expect(first.now >= 2 && first.version === first.now && first.gone === null && first.hid?.hidden && first.hid.name === "" && first.pin?.pinned === 1600000000 && first.s1?.name === "Sender 1" && first.s1.lastSent === 0 && first.s2 === "Two Given" && first.s3 === null && first.builtAt > 1600000000000,
    "a book of a lower version is built anew from the mail: what no mail names is gone, what the user hid, pinned, named and deleted stays, and the rest is as the mail has it: " + JSON.stringify(first));
  expect(again.builtAt === first.builtAt && JSON.stringify(again) === JSON.stringify(first), "once: opened again, the book is kept as built: " + JSON.stringify([first.builtAt, again.builtAt]));
  expect(newer.version === newer.now && newer.gone === null && newer.hid === null && newer.pin === null && newer.s1?.name === "Sender 1" && newer.s2 === "Sender 2" && newer.s3?.name === "Sender 3" && newer.builtAt > 1600000000000,
    "a book of a higher version is dropped whole and a new one built under this version: " + JSON.stringify(newer));
}, { settings: { pollSec: 600 } });

// The upgrade keeps whose book it is: one kept for another account starts afresh for this one,
// and the account's own keeps what the user chose.
scenario("an address book of an older version kept for another account is not handed to this one", async (h, expect) => {
  const { page } = h;
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the app's own build has finished
  const r = {};
  for (const account of ["other@yahoo.com", "me@yahoo.com"]) {
    await page.goto(`chrome-extension://${h.extId}/mail.css`);
    await page.evaluate(account => new Promise((ok, no) => {
      const del = indexedDB.deleteDatabase("baltazar-mail");
      del.onerror = () => no(del.error);
      del.onsuccess = () => {
        const req = indexedDB.open("baltazar-mail", 1);
        req.onupgradeneeded = () => { req.result.createObjectStore("contacts", { keyPath: "email" }); req.result.createObjectStore("meta", { keyPath: "key" }); };
        req.onerror = () => no(req.error);
        req.onsuccess = () => {
          const d = req.result, t = d.transaction(["contacts", "meta"], "readwrite");
          t.objectStore("contacts").put({ email: "pin@old.example", name: "Pin Ned", nameBy: {}, last: 1500000000, lastSent: 0, pinned: 1600000000 });
          for (const m of [{ key: "built", value: 1600000000000 }, { key: "account", value: account }]) t.objectStore("meta").put(m);
          t.oncomplete = () => { d.close(); ok(); }; t.onerror = () => no(t.error);
        };
      };
    }), account);
    await h.open();
    await page.waitForSelector("#rows .row", { timeout: 15000 });
    await page.waitForFunction(() => /^Contacts: [\d,.\s]+ addresses/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
    r[account] = await page.evaluate(async () => {
      const pin = await (await import("./contacts.js")).lookup("pin@old.example");
      const owner = await new Promise(ok => { const req = indexedDB.open("baltazar-mail"); req.onsuccess = () => { const d = req.result, g = d.transaction("meta").objectStore("meta").get("account"); g.onsuccess = () => { d.close(); ok(g.result?.value); }; }; });
      return { pinned: pin?.pinned || 0, owner };
    });
  }
  expect(r["other@yahoo.com"].pinned === 0 && r["other@yahoo.com"].owner === "me@yahoo.com", "another account's book is not kept: " + JSON.stringify(r["other@yahoo.com"]));
  expect(r["me@yahoo.com"].pinned === 1600000000 && r["me@yahoo.com"].owner === "me@yahoo.com", "the account's own book keeps its pin: " + JSON.stringify(r["me@yahoo.com"]));
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

// An address holding a bidi control is shown without it, and acted on as itself: the reader's
// card, the Same name link and the selection find that address, not the look-alike shown.
scenario("an address with a bidi control is acted on as itself", async ({ page, mock }, expect) => {
  const odd = "eve\u202e@x.com", r = {}, text = sel => page.locator(sel).first().textContent().catch(() => "");
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(async odd => (await import("./contacts.js")).learn([odd, "eve2@x.com"].map((email, i) => ({ id: `EVE${i}`, folder: { id: "1" },
    headers: { from: [{ name: "Eve", email }], to: [{ name: "Me", email: "me@yahoo.com" }], date: String(Math.floor(Date.now() / 1000) - i) } }))), odd);
  mock.patchBody = (id, m) => { if (id === "MSG1_2") m.headers = { ...m.headers, from: [{ name: "Eve", email: odd }] }; };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  await page.locator("#r-from .who").first().hover(); await page.waitForTimeout(900);
  r.card = await text("#card .card-stats");
  await page.mouse.move(0, 0); await page.waitForTimeout(400);
  await contactsOpen(page); await contactsTab(page, "others");
  await page.locator("#p-filter").fill("eve"); await page.waitForTimeout(300);
  await contactRow(page, "eve2@x.com").click(); await page.waitForTimeout(300);
  await page.locator("#person .p-also a").first().click(); await page.waitForTimeout(300);
  r.also = await text("#person .p-mail");
  await contactRow(page, "eve2@x.com").click({ modifiers: ["Control"] }); await page.waitForTimeout(300);
  r.marked = await page.locator("#p-rows .prow.marked").count();
  await page.locator('#person .chip[title="Eve <eve@x.com>"] a').click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(300);
  r.after = await text("#person .p-name");
  expect(/^Last exchange/.test(r.card) && r.also === "eve@x.com" && r.marked === 2 && r.after === "Eve", "the card, the link and the selection find the address: " + JSON.stringify(r));
});

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
  // the row shows selected first, and the keyboard goes back to the filter a moment after
  await page.waitForFunction(() => document.activeElement?.id === "p-filter", null, { timeout: 3000 }).catch(() => {});
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
  r.pinned = { first: await page.locator("#p-rows .prow").first().getAttribute("data-email"), heads: (await page.locator("#p-rows .day").allTextContents()).join(), undo: await undoTip(page) };
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
// A draft was never sent: deleting one and taking the delete back tells Contacts nothing of whom
// the user writes to.
scenario("a draft whose delete is undone is not taken for mail the user wrote", async (h, expect) => {
  const { page } = h, NEW = "never.sent@x.example";
  h.mock.handler = ({ top, uri }) => {
    const q = decodeURIComponent(uri.split("q=")[1] || "");
    if (!/folderId:3\b/.test(q) || /is:unread|has:attachment/.test(q)) return null;
    const m = msg(1, "3");
    return { responses: [{ id: top.id, httpCode: 200, response: { result: { messages: [{ ...m, headers: { ...m.headers, from: [{ name: "Me Myself", email: "me@yahoo.com" }], to: [{ name: "Never Sent", email: NEW }], cc: [] } }], query: {} } } }] };
  };
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  await folder(page, "Draft");
  await page.locator("#rows .row").first().click({ modifiers: ["Control"] });
  await page.locator("#list").focus(); await page.keyboard.press("Delete");
  await page.waitForFunction(() => /^deleted 1 message/.test(document.getElementById("st-msg").textContent), null, { timeout: 8000 }).catch(() => {});
  await page.keyboard.press("z");
  await page.waitForFunction(() => /^undone/.test(document.getElementById("st-msg").textContent), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  const r = { status: await page.locator("#st-msg").textContent(), known: await inBook(page, NEW) };
  expect(/^undone/.test(r.status) && !r.known, "the draft's recipient is not learned: " + JSON.stringify(r));
});

// The bin of a row deletes; a double-click on it does not also open the person's mail.
scenario("a double-click on a contact's bin stays in Contacts", async ({ page }, expect) => {
  await contactsOpen(page);
  await contactsTab(page, "others");
  await contactRow(page, "s5@x.com").hover(); await contactRow(page, "s5@x.com").locator(".tr").dblclick();
  await page.waitForTimeout(800);
  const r = { contacts: await page.evaluate(() => document.getElementById("app").classList.contains("contacts-view")), title: await page.locator("#list-title").textContent() };
  expect(r.contacts, "still in Contacts: " + JSON.stringify(r));
});

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
  // s5 hidden and the hide undone: it waits to be redone, through the forgetting below, which Contacts does by itself
  await page.locator("#list").focus(); await page.keyboard.press("h");
  await page.waitForFunction(() => !document.querySelector('#p-rows .prow[data-email="s5@x.com"]'), null, { timeout: 5000 }).catch(() => {});
  await page.keyboard.press("z");
  await page.waitForSelector('#p-rows .prow[data-email="s5@x.com"]', { timeout: 5000 }).catch(() => {});
  // s7 has no mail left: opening it forgets it, nobody is selected, and the arrows carry on from its place
  await contactRow(page, "s7@x.com").click();
  await page.waitForFunction(() => !document.querySelector('#p-rows .prow[data-email="s7@x.com"]'), null, { timeout: 5000 }).catch(() => {});
  r.forgot = { listed: await contactRow(page, "s7@x.com").count(), inBook: await inBook(page, "s7@x.com"), said: await text("#person .p-none"), undo: await undoTip(page), redo: await page.locator('#st-acts [data-act="redo"]').getAttribute("title"), sel: await page.locator("#p-rows .prow.sel").count() };
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
  await page.waitForFunction(() => document.querySelector('#st-acts [data-act="undo"]').title.startsWith("Undo: delete"), null, { timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 30 && await inBook(page, "s3@x.com"); i++) await page.waitForTimeout(250);
  r.deleted = { s3: await inBook(page, "s3@x.com"), o: await inBook(page, "o@x.com") };
  await page.locator("#list").focus(); await page.keyboard.press("z");
  for (let i = 0; i < 30 && !(await inBook(page, "s3@x.com")); i++) await page.waitForTimeout(250);
  r.undone = await inBook(page, "s3@x.com");
  // o@x.com is copied on that message: it is kept without a search being asked about it
  r.asked = { s3: h.asked.includes("s3@x.com"), o: h.asked.includes("o@x.com") };
  expect(r.asked.s3 && !r.asked.o, "the delete asks about the sender's mail, and not about the address the message was copied to: " + JSON.stringify(r.asked));
  expect(!r.grey.mail.off && !r.grey.from.off && r.grey.to.off && r.grey.to.why === "No mail to this address", "Mail to is greyed out for someone who only ever wrote, and nothing else is: " + JSON.stringify(r.grey));
  expect(r.forgot.listed === 0 && !r.forgot.inBook && /^Sender 7 was forgotten: no mail with s7@x\.com is left/.test(r.forgot.said) && r.forgot.undo === "Undo: forget Sender 7 (z)" && r.forgot.redo === "Redo: hide Sender 5 (Shift+Z)" && r.forgot.sel === 0 && r.next === "s8@x.com",
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
  r.kept = { asked: h.asked.includes(COPIED), said: await text("#person .p-recent"), row: await contactRow(page, COPIED).count(), inBook: await inBook(page, COPIED), undo: await undoTip(page),
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
  r.hid = { left: await rows.count(), hidden: await count("hidden"), status: await text("#st-msg"), undo: await undoTip(page), marked: await page.locator("#p-rows .prow.marked").count() };
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
  expect(n >= 6 && r.tips[0] === "Hide the 3 selected contacts" && /^Hide: /.test(r.tips[1]) && r.hid.left === n - 3 && r.hid.hidden === before.hidden + 3 && r.hid.status === "hid 3 contacts; Hidden has them" && r.hid.undo.startsWith("Undo: hide 3 contacts: ") && r.hid.undo.endsWith(", ... (z)") && r.hid.marked === 0,
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
  r.renamed = { row: await text('#p-rows .prow[data-email="s4@x.com"] .pn'), page: await text("#person .p-name"), status: await text("#st-msg"), undo: await undoTip(page), book: await book("s4@x.com"), focus: await page.evaluate(() => document.activeElement.id) };
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
  expect(r.box.value === "Sender 4" && r.box.focused === "p-name" && r.renamed.row === "Sam Four" && r.renamed.page === "Sam Four" && r.renamed.status === "renamed Sender 4 to Sam Four" && r.renamed.undo === "Undo: rename Sender 4 to Sam Four (z)" && r.renamed.book.given === "Sam Four" && r.renamed.focus === "list",
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
  r.merged = { status: await text("#st-msg"), undo: await undoTip(page), book: await book() };
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

scenario("Settings counts the contacts and rebuilds them when asked, keeping only the user's pins and names", async (h, expect) => {
  const { page } = h, r = {};
  const text = sel => page.locator(sel).first().textContent().catch(() => "");
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  // a hide, a name, a pin and a deletion of the user's, an address no mail names, and one the user added
  r.before = await page.evaluate(async () => {
    const c = await import("./contacts.js");
    await c.hide("s2@x.com"); await c.rename("s3@x.com", "Three"); await c.pinMany(["s5@x.com"]); await c.deleteMany(["s4@x.com"]);
    await c.learn([{ headers: { date: "1500000000", from: [{ name: "Long Gone", email: "gone@old.example" }], to: [] } }]);
    await c.importList([{ email: "new@y.example", name: "", pinned: false, hidden: false }]);
    return (await c.all()).length;
  });
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
    book: await page.evaluate(async () => { const c = await import("./contacts.js"); const one = async e => { const x = await c.lookup(e); return x && [x.name, x.hidden, !!x.pinned].join("/"); }; return { s2: await one("s2@x.com"), s3: await one("s3@x.com"), s4: await one("s4@x.com"), s5: await one("s5@x.com"), gone: await one("gone@old.example"), added: await one("new@y.example"), n: (await c.all()).length, built: await c.isBuilt() }; }) };
  expect(r.shown.count === `${r.before} contacts, learned from your message headers.` && !r.shown.off, "Settings says how many contacts there are: " + JSON.stringify([r.before, r.shown]));
  expect(/^Rebuild Contacts\? The headers of all your mail are read again, which takes about a minute\. /.test(r.after.asked) && r.after.count === `${r.before - 1} contacts, learned from your message headers.` && !r.after.off && r.after.book.built &&
    r.after.book.s2 === "Sender 2/false/false" && r.after.book.s3 === "Three/false/false" && r.after.book.s4 === "Sender 4/false/false" && r.after.book.s5 === "Sender 5/false/true" &&
    r.after.book.gone === null && r.after.book.added === null && r.after.book.n === r.before - 1,
    "Rebuild asks first, reads the mail again, drops what no mail names, keeps what the user pinned and named, and lets the mail decide what they hid, added and deleted: " + JSON.stringify(r.after));
}, { settings: { pollSec: 600 } });

scenario("the trash bin on a row deletes contacts, in any pile but not a pinned one; they stay out whatever mail names them, an export leaves them out, and an import brings one back", async (h, expect) => {
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
  r.others = { left: await rows.count(), hidden: await count("hidden"), status: await text("#st-msg"), undo: await undoTip(page), book: await book() };
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
  // mail that names a deleted address again, and a full build that keeps the user's choices (an
  // update's, see DB_VERSION), leave it out; undo brings the last one back
  r.later = await page.evaluate(async () => { const c = await import("./contacts.js");
    await c.learn([{ headers: { date: String(Math.floor(Date.now() / 1000)), from: [{ name: "Sender 1", email: "s1@x.com" }], to: [{ name: "Me", email: "me@yahoo.com" }] } }]);
    await c.sync({ inbox: "1", sent: "2", drafts: "3", full: true });
    return { n: await c.count(), s1: !!(await c.lookup("s1@x.com")), s6: !!(await c.lookup("s6@x.com")) }; });
  await page.locator("#list").focus(); await page.keyboard.press("z");
  await page.waitForSelector('#p-rows .prow[data-email="s3@x.com"]', { timeout: 5000 }).catch(() => {});
  r.undone = await book();
  // an export leaves the deleted ones out; a file that names one brings it back
  await page.locator("#contacts-link").click({ button: "right" });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('#ctx [data-act="export"]').click()]);
  const file = require("fs").readFileSync(await dl.path(), "utf8").replace(/\r\n/g, "\n");
  r.exported = { status: await text("#st-msg"), deleted: /deleted|<s[1246]@x\.com>/i.test(file), s3: file.includes("<s3@x.com>") };
  await page.locator("#contacts-link").click({ button: "right" });
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.locator('#ctx [data-act="merge"]').click()]);
  await fc.setFiles({ name: "back.txt", mimeType: "text/plain", buffer: Buffer.from(`${file}Sender 1 <s1@x.com>\n`, "utf8") });
  await page.waitForFunction(() => /^merged back\.txt/.test(document.getElementById("st-msg").textContent), null, { timeout: 5000 }).catch(() => {});
  r.restored = { status: await text("#st-msg"), book: await book() };
  expect(new RegExp(`^exported ${r.undone.n} contacts to baltazar-contacts-`).test(r.exported.status) && !r.exported.deleted && r.exported.s3,
    "an export lists the contacts there are, and says nothing of the deleted ones: " + JSON.stringify(r.exported));
  expect(r.restored.status === "merged back.txt: 1 restored" && r.restored.book.s1 && !r.restored.book.s2 && r.restored.book.n === r.undone.n + 1, "importing a file that names a deleted contact brings it back, and no other: " + JSON.stringify(r.restored));
  expect(r.pinned.bin === 0 && r.pinned.off && /^Unpin it first/.test(r.pinned.why) && r.pinned.said === "unpin it first: a pinned address cannot be deleted" && r.pinned.still === 1, "a pinned contact has no bin and is not deleted: " + JSON.stringify(r.pinned));
  expect(r.tip === "Delete the 2 selected contacts (Del)" && r.others.left === n - 2 && r.others.status === "deleted 2 contacts" && ["Undo: delete 2 contacts: Sender 1, Sender 2 (z)", "Undo: delete 2 contacts: Sender 2, Sender 1 (z)"].includes(r.others.undo) && !r.others.book.s1 && !r.others.book.s2 && r.others.book.n === had - 2 && !/s[12]@/.test(r.others.book.suggested),
    "the bin of a selected row deletes everyone selected, out of the list, the count and the suggestions: " + JSON.stringify([n, had, r.tip, r.others]));
  expect(r.hidden.left === hid - 1 && r.hidden.others === n - 2 && r.hidden.status === "deleted Sender 6" && !r.hidden.book.s6, "in Hidden it deletes too: " + JSON.stringify([hid, r.hidden]));
  expect(r.key === "deleted Sender 4" && r.page.status === "deleted Sender 3" && !r.page.book.s3 && r.page.book.n === had - 5, "Del and Delete on a person's page delete them: " + JSON.stringify([r.key, r.page]));
  expect(!r.later.s1 && !r.later.s6 && r.later.n === had - 5 && r.undone.s3 && !r.undone.s1, "a deleted address stays out when mail names it again and through an update's build, and undo brings the last one back: " + JSON.stringify([r.later, r.undone]));
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
  await menuOf(page, folderRow(page, "Lag")); await pickMenu(page, "Delete");
  // the list is redrawn once the second try is answered, which a slow runner takes seconds for
  const gone = await folderRow(page, "Lag").waitFor({ state: "detached", timeout: 8000 }).then(() => true, () => false);
  const notice = await page.locator("#notice").isVisible();
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
  const before = h.calls.length, unread = () => page.locator("#rows .row.unread").count(), shown = await unread();
  await menuOf(page, folderRow(page, "Starred")); await pickMenu(page, "Mark all read"); await page.waitForTimeout(1500);
  const marked = h.calls.slice(before).filter(c => c.name === "messages.readFlagUpdate").flatMap(c => c.envelope.requests.map(r => decodeURIComponent(r.uri).match(/id:\(([^)]+)\)/)?.[1]));
  expect(asked >= 2 && JSON.stringify(marked.sort()) === JSON.stringify(["MSG31_1", "MSG31_2"]), "only the starred unread messages are marked: " + JSON.stringify({ asked, marked }));
  // the Inbox shown meanwhile has none of them: its rows stay as they were
  const after = await unread();
  expect(shown > 0 && after === shown, "the open list is not shown read: " + JSON.stringify({ shown, after }));
}, { settings: { pollSec: 600 } });

// A refresh that lands while the open message waits to be marked read replaces its row: the
// folder's count still goes down by one.
scenario("a message marked read during a refresh lowers the unread count once", async ({ page }, expect) => {
  const count = () => folderRow(page, "Inbox").locator(".ct").textContent();
  const was = await count();
  await page.locator("#rows .row.unread").first().click();
  await page.locator("#list").focus(); await page.keyboard.press("Shift+R");
  await page.waitForTimeout(3000);
  const r = { was, now: await count() };
  expect(Number(r.now) === Number(r.was) - 1, "one less unread: " + JSON.stringify(r));
}, { settings: { pollSec: 600, markReadSec: 2 } });

// A search that answers late leaves the keyboard where the user went meanwhile.
scenario("a slow search does not take the keyboard from the composer", async (h, expect) => {
  const { page } = h;
  h.mock.listDelay = 1500;
  await page.locator("#search").fill("Subject"); await page.locator("#search").press("Enter");
  await page.locator("#compose-btn").click(); await page.waitForSelector("#compose:not(.hidden)");
  await page.waitForTimeout(2500);
  h.mock.listDelay = 0;
  const r = { title: await page.locator("#list-title").textContent(), focus: await page.evaluate(() => !!document.activeElement?.closest("#compose")) };
  expect(/Subject/.test(r.title) && r.focus, "the search is shown and the composer keeps the keyboard: " + JSON.stringify(r));
});

// A search that does not find the open message leaves it in the reader, where Delete still works.
scenario("the reader's Delete works on a message a search has left out of the list", async (h, expect) => {
  const { page } = h, prev = h.mock.handler;
  h.mock.handler = a => /nomatch/.test(decodeURIComponent(a.top?.uri || "")) ? { responses: [{ id: a.top.id, httpCode: 200, response: { result: { messages: [], query: {} } } }] } : prev?.(a);
  await page.locator("#rows .row").first().click(); await page.waitForTimeout(800);
  await page.locator("#search").fill("nomatch"); await page.locator("#search").press("Enter");
  await page.waitForFunction(() => !document.querySelector("#rows .row"), null, { timeout: 5000 }).catch(() => {});
  const shown = await page.locator("#r-subject").textContent();
  const before = h.calls.length;
  await page.locator("#r-delete").click(); await page.waitForTimeout(1200);
  const r = { shown, moved: h.calls.slice(before).some(c => c.name === "messages.moveV3" || /move/i.test(c.name || "")), status: await page.locator("#st-msg").textContent(), empty: await page.locator("#reader-empty").isVisible() };
  expect(r.shown === "Subject 1-1" && r.moved && /^deleted 1 message/.test(r.status) && r.empty, "the open message is deleted and leaves the reader: " + JSON.stringify(r));
});

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
    // legacy attributes without their #, and the colour forms of CSS Color 4
    const bare = darkenHtml('<table bgcolor="ffffff"><tr><td><font color="000000">f</font></td></tr></table><div style="background:oklch(0.98 0 0);color:hwb(0 20% 80%)">g</div>');
    const t0 = performance.now();
    darkenHtml(`<div style="${"background:".repeat(90000)}">x</div><style>p{color:${"rgb(".repeat(250000)}}</style>`);
    return { out, named, bare, ms: performance.now() - t0 };
  });
  const want = '<div style="color:#b1b1b1;background-color:#1f1f1f">a</div><font color="#e4e4e4">b</font><table bgcolor="#1f1f1f"><tbody><tr><td>c</td></tr></tbody></table>' +
    '<div style="background:url(x.png);color:#000">d</div><div style="background-image:url(y.png);color:#111111"><span style="color:#000">e</span></div><style>p{color:#e4e4e4}</style>';
  expect(r.out === want, "darkened HTML: " + r.out);
  expect(r.ms < 1500, "crafted style text darkens in linear time: " + Math.round(r.ms) + " ms");
  expect(!/lightyellow|darkblue/.test(r.named) && /currentcolor/.test(r.named), "every named colour darkens, keywords stay: " + r.named);
  expect(r.bare === '<table bgcolor="#1f1f1f"><tbody><tr><td><font color="#e4e4e4">f</font></td></tr></tbody></table><div style="background:#212121;color:#b1b1b1">g</div>', "bare hex attributes and CSS Color 4 colours darken: " + r.bare);
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
    return { over: Math.min(z("settings"), z("help"), z("movebox")), pop: Math.max(z("search-help"), z("card"), z("ctx"), z("c-suggest"), z("c-palette"), z("c-symbols")) }; });
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
// With nothing on screen yet, the start page says at once that it is the connection, not the app,
// and counts down to the next try, with no report to copy.
scenario("starting offline says why and recovers by itself", async ({ page, mock }, expect) => {
  const shown = { panel: await page.locator("#signin-fail").isVisible(), app: await page.locator("#app").isVisible(), text: await page.locator("#fail-text").textContent(),
    note: await page.locator("#fail-note").textContent(), copy: await page.locator("#fail-copy").isVisible() };
  expect(shown.panel && !shown.app && /Could not load your mailbox\. No connection to Yahoo: the network or Yahoo is not answering\./.test(shown.text) &&
    /^Nothing is wrong with the app or your mail\. Trying again in 1[0-5] s\.$/.test(shown.note) && !shown.copy, "an offline start shows the reason: " + JSON.stringify(shown));
  mock.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForSelector("#rows .row", { timeout: 10000 }).catch(() => {});
  expect(await page.locator("#app").isVisible() && await page.locator("#rows .row").count() > 0 && await page.locator("#signin").isHidden(), "coming online loads the mailbox");
}, { mock: { offline: true }, noWait: true, allow: /start|ERR_INTERNET_DISCONNECTED|Failed to fetch/ });

// A connection lost for a moment (a computer back from sleep, a network that changed) holds a read
// up, with the status bar saying why and nothing told as an error: the message opens once a
// request gets through.
scenario("a message opened while the connection is lost opens once it is back, with no error", async ({ page, mock }, expect) => {
  const before = await page.locator("#r-subject").textContent();
  mock.offline = true;
  await page.locator("#rows .row").nth(1).click();
  await page.waitForTimeout(1800);
  const during = { wait: await page.locator("#st-wait").textContent(), shown: await page.locator("#st-wait").isVisible(), notice: await notice(page) };
  mock.offline = false;
  await page.waitForFunction(b => !document.getElementById("reader-head").classList.contains("hidden") && document.getElementById("r-subject").textContent !== b, before, { timeout: 8000 }).catch(() => {});
  const after = { subject: await page.locator("#r-subject").textContent(), wait: await page.locator("#st-wait").isVisible(), notice: await notice(page) };
  expect(during.shown && /^no connection to Yahoo, asking again \(\d+ s\)$/.test(during.wait) && !during.notice, "the status bar says the connection is lost, and nothing is an error: " + JSON.stringify(during));
  expect(after.subject !== before && !after.wait && !after.notice, "the message opens by itself once the connection is back: " + JSON.stringify(after));
}, { allow: /ERR_INTERNET_DISCONNECTED/ });

// Past a minute without a connection, one notice says it is the network's doing and not the app's,
// counts down to a try every 15 seconds, and once a try gets through it goes, and the message that
// could not be opened opens.
scenario("a connection lost for a minute is told as the network's, tried every 15 seconds, and what failed loads once it is back", async ({ page, mock }, expect) => {
  await page.clock.install();
  await page.reload(); await page.waitForSelector("#rows .row", { timeout: 15000 });
  const before = await page.locator("#r-subject").textContent();
  mock.offline = true;
  await page.locator("#rows .row").nth(1).click();
  await page.waitForTimeout(1000);
  await page.clock.fastForward(61000); await page.waitForTimeout(800);
  const down = { notice: await notice(page), info: await page.locator("#notice").evaluate(n => n.classList.contains("info")), copy: await page.locator("#notice-copy").isVisible(),
    reader: await page.locator("#reader-empty").textContent() };
  await page.clock.fastForward(5000); await page.waitForTimeout(300);
  const counted = await notice(page);
  mock.offline = false;
  await page.clock.fastForward(10500);
  await page.waitForFunction(b => !document.getElementById("reader-head").classList.contains("hidden") && document.getElementById("r-subject").textContent !== b, before, { timeout: 8000 }).catch(() => {});
  const back = { notice: await notice(page), subject: await page.locator("#r-subject").textContent() };
  expect(/^No connection to Yahoo: the network or Yahoo is not answering\. Nothing is wrong with the app or your mail\. Trying again in 1[45] s\. Try now$/.test(down.notice) && down.info && !down.copy,
    "a minute on, one calm notice says it is the connection, and when it tries again: " + JSON.stringify(down));
  expect(down.reader === "No connection to Yahoo: the network or Yahoo is not answering. The message opens by itself once the connection is back.", "the reader says so too: " + down.reader);
  expect(/Trying again in (9|10) s\./.test(counted), "the notice counts down: " + counted);
  expect(!back.notice && back.subject !== before, "the try that gets through clears the notice and opens the message: " + JSON.stringify(back));
}, { allow: /ERR_INTERNET_DISCONNECTED|Blocked script execution in 'about:blank'/ });

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
  const n = await notice(page), label = await undoTip(page);
  mock.failMoves = 0;
  await page.keyboard.press("z"); await page.waitForTimeout(800);
  const after = await undoTips(page);
  expect(/removed from the undo list/.test(n) && /Undo: archive "Subject 1-1" from Sender 1 \(z\)/.test(label), "the failing entry is dropped after a second failure: " + JSON.stringify({ n, label }));
  expect(!/Undo:/.test(after) && /Redo: archive "Subject 1-1" from Sender 1/.test(after) && (await subjects(page)).includes(before[0]), "the older entry then undoes: " + JSON.stringify({ after }));
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

// ---------- the undo history ----------
const historyRows = page => page.locator("#history .h-row").evaluateAll(rs => rs.map(r => ({ what: r.querySelector(".h-what").textContent, act: r.querySelector(".h-act").textContent, off: r.classList.contains("off"), undone: r.classList.contains("undone"), send: r.classList.contains("send"), tip: r.title })));
const flagCalls = (calls, name) => calls.filter(c => c.name === name).map(c => c.envelope.requests.map(q => [decodeURIComponent(q.uri || "").match(/id:\(([^)]+)\)/)?.[1], q.payload?.message?.flags]));

scenario("the undo history takes an old star back alone, leaving the delete after it", async ({ page, calls }, expect) => {
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(300);
  await page.locator("#list").focus(); await page.keyboard.press("s"); await page.waitForTimeout(500);
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(300);
  await page.locator("#list").focus(); await page.keyboard.press("#"); await page.waitForTimeout(600);
  const moves = calls.filter(c => c.name === "messages.move").length, stars = flagCalls(calls, "messages.starFlagUpdate").length;
  await page.keyboard.press("y"); await page.waitForSelector("#history:not(.hidden)", { timeout: 2000 }).catch(() => {});
  const listed = await historyRows(page);
  // the star is the second entry
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#history .h-row.undone:not(.working)"), null, { timeout: 5000 }).catch(() => {});
  const after = await historyRows(page), lines = await page.locator("#history hr").count(), bar = await undoTips(page), unstar = flagCalls(calls, "messages.starFlagUpdate").slice(stars);
  await page.keyboard.press("Escape");
  expect(listed.length === 2 && listed[0].what === 'delete "Subject 1-2" from Sender 2' && listed[1].what === 'star "Subject 1-1" from Sender 1' && listed.every(r => r.act === "Undo" && !r.off && !r.undone),
    "the list names each entry, newest first, both free: " + JSON.stringify(listed));
  expect(JSON.stringify(unstar) === JSON.stringify([[["MSG1_1", { flagged: false }]]]) && calls.filter(c => c.name === "messages.move").length === moves,
    "the star alone is taken back, and the delete stays: " + JSON.stringify({ unstar, moves }));
  expect(after.length === 2 && after[0].what.startsWith("delete") && after[0].act === "Undo" && !after[0].undone && after[1].what.startsWith("star") && after[1].undone && after[1].act === "Redo" && !after[1].off && !lines &&
    bar === 'Undo: delete "Subject 1-2" from Sender 2 (z)   Redo: star "Subject 1-1" from Sender 1 (Shift+Z)' && await page.locator("#history").isHidden(),
    "the star stays in its place, undone, offering Redo, and Esc closes the list: " + JSON.stringify({ after, lines, bar }));
});

scenario("a click on an entry of the undo history undoes it in its place, and a double click acts once", async ({ page, calls }, expect) => {
  const reads = () => flagCalls(calls, "messages.readFlagUpdate");
  for (const i of [0, 2]) { await page.locator("#rows .row").nth(i).click(); await page.waitForTimeout(300); await page.locator("#list").focus(); await page.keyboard.press("u"); await page.waitForTimeout(500); }
  const marked = reads().length;
  await page.locator("#st-hist").click(); await page.waitForSelector("#history:not(.hidden)", { timeout: 2000 }).catch(() => {});
  const listed = await historyRows(page);
  await page.locator("#history .h-row").nth(0).click();
  await page.waitForFunction(() => document.querySelector("#history .h-row.undone:not(.working)"), null, { timeout: 5000 }).catch(() => {});
  const one = await historyRows(page);
  await page.locator("#history .h-row").nth(1).dblclick();
  await page.waitForFunction(() => document.querySelectorAll("#history .h-row.undone:not(.working)").length === 2, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  const two = await historyRows(page), lines = await page.locator("#history hr").count(), open = await page.locator("#history").isVisible();
  expect(listed.length === 2 && listed[0].what === 'mark "Subject 1-3" from Sender 3 read' && listed[1].what === 'mark "Subject 1-1" from Sender 1 read' && listed.every(r => r.act === "Undo"),
    "two marks, newest first, each with Undo: " + JSON.stringify(listed));
  expect(one.length === 2 && one[0].what === listed[0].what && one[0].undone && one[0].act === "Redo" && one[1].what === listed[1].what && !one[1].undone && one[1].act === "Undo",
    "the clicked row is undone where it was, and the other is as it was: " + JSON.stringify(one));
  expect(two.every(r => r.undone && r.act === "Redo") && two.map(r => r.what).join() === listed.map(r => r.what).join() && !lines && open && reads().length === marked + 2,
    "a double click undoes once, nothing moves, no line, the list stays open: " + JSON.stringify({ two, lines, open, reads: reads().slice(marked) }));
}, { settings: { markReadSec: null } });

scenario("the undo history greys out a move a later move of the same message replaced, naming that one", async ({ page, calls }, expect) => {
  // in a search the moved message stays listed, so it can be moved again
  await page.locator("#search").click(); await page.keyboard.type("Subject"); await page.keyboard.press("Shift+Enter"); await page.waitForTimeout(800);
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(300);
  const subject = await page.locator("#rows .row .sb").first().evaluate(e => e.firstChild.textContent), rows = await page.locator("#rows .row").count();
  await page.locator("#list").focus(); await page.keyboard.press("v"); await page.keyboard.type("Projects"); await page.keyboard.press("Enter"); await page.waitForTimeout(600);
  await page.keyboard.press("e"); await page.waitForTimeout(600);
  const moves = calls.filter(c => c.name === "messages.move").map(c => c.envelope.requests.length);
  await page.keyboard.press("y"); await page.waitForSelector("#history:not(.hidden)", { timeout: 2000 }).catch(() => {});
  const listed = await historyRows(page);
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await page.waitForTimeout(500);
  const refused = { said: await page.locator("#st-msg").textContent(), moves: calls.filter(c => c.name === "messages.move").length - moves.length };
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#history .h-row.undone:not(.working)"), null, { timeout: 5000 }).catch(() => {});
  const freed = await historyRows(page);
  const archive = listed[0]?.what || "", who = archive.slice(`archive "${subject}" `.length);
  expect(rows > 1 && moves.join() === "1,1" && listed.length === 2 && archive.startsWith(`archive "${subject}" from `) && !listed[0].off && listed[1].what === `move "${subject}" ${who} to Projects` && listed[1].off && listed[1].act === "Undo" &&
    listed[1].tip === `Undo “${archive}” first`, "the first move is greyed out, its tooltip naming the second: " + JSON.stringify({ subject, rows, moves, listed }));
  expect(refused.said === `undo “${archive}” first` && refused.moves === 0, "Enter on it says why, and moves nothing: " + JSON.stringify(refused));
  expect(freed.length === 2 && freed[0].what === archive && freed[0].undone && freed[0].act === "Redo" && freed[1].what.startsWith("move") && !freed[1].off && !freed[1].undone, "once the second move is undone, in its place, the first is free: " + JSON.stringify(freed));
});

scenario("the undo history cancels the older of two sends waiting, and the newer goes out", async ({ page, calls }, expect) => {
  await newMessage(page, { subject: "First", text: "one" });
  await page.keyboard.press("Control+Enter"); await composerHidden(page);
  await newMessage(page, { subject: "Second", text: "two" });
  await page.keyboard.press("Control+Enter"); await composerHidden(page);
  await page.locator("#st-hist").click(); await page.waitForSelector("#history:not(.hidden)", { timeout: 2000 }).catch(() => {});
  const listed = await historyRows(page);
  await page.locator("#history .h-row").nth(1).click(); await page.waitForTimeout(800);
  const reopened = { shown: await page.locator("#compose").isVisible(), subject: await page.inputValue("#c-subject"), list: await page.locator("#history").isVisible(), bar: await page.locator("#st-undo").textContent() };
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 12000 }).catch(() => {});
  const sent = calls.filter(c => c.name === "messages.saveAndSend").map(c => msgOf(c)?.message?.headers?.subject);
  expect(listed.length === 2 && listed.every(r => r.send && r.act === "Cancel") && listed[0].what === 'send "Second" to q@example.com' && listed[1].what === 'send "First" to q@example.com', "both sends are listed, newest first: " + JSON.stringify(listed));
  expect(reopened.shown && reopened.subject === "First" && !reopened.list && /^Sending in \d+ s: send "Second"/.test(reopened.bar), "the older send is back in the composer, and the newer still waits: " + JSON.stringify(reopened));
  expect(sent.length === 1 && sent[0] === "Second", "only the newer one is sent: " + JSON.stringify(sent));
}, { settings: { undoSendSec: 8 } });

// An action shows its counts at once; undone before the next mail check, it leaves the server's
// answer as the one last drawn, and the counts go back all the same.
scenario("an action undone before the next mail check leaves the folder counts as they were", async ({ page }, expect) => {
  const counts = () => page.locator("#folder-list .folder").evaluateAll(fs => Object.fromEntries(fs.map(f => [f.querySelector(".nm").textContent, f.querySelector(".ct").textContent]).filter(([n]) => n === "Inbox" || n === "Archive")));
  const before = await counts();
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(300);
  await page.locator("#list").focus(); await page.keyboard.press("e"); await page.waitForTimeout(600);
  const archived = await counts();
  await page.keyboard.press("z");
  await page.waitForFunction(() => document.querySelector('#st-acts [data-act="redo"]').title.startsWith("Redo:"), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  const undone = await counts();
  expect(archived.Archive === "1" && archived.Inbox !== before.Inbox && JSON.stringify(undone) === JSON.stringify(before), "the counts follow the archive and its undo: " + JSON.stringify({ before, archived, undone }));
}, { settings: { markReadSec: null } });

// ---------- conversation ----------
// Yahoo's answer to the search for a conversation id: rows() as it lists them, newest first.
const conversationAnswer = (id, rows) => async ({ name, uri }) => name === "messageGroups.getList" && new RegExp(`conversationId%3A${id}(%20|$)`).test(uri)
  ? { responses: [{ id: "GetMessageGroupList", httpCode: 200, response: { result: { messages: rows(), query: {} } } }] } : undefined;
// A message of conversation 4002 (that of MSG1_2) in a folder, from a person, days old, with its
// Message-ID, In-Reply-To and References.
const ofConversation = (i, folder, name, from, subject, days, [own, parent = "", ...refs]) => {
  const m = msg(i, folder);
  return { ...m, conversationId: "4002", folder: { id: folder, name }, headers: { ...m.headers, subject, from: [from], date: String(Math.floor(Date.now() / 1000) - days * 86400), messageIdRfc822: own, inReplyTo: parent, referenceList: refs } };
};
// Each row's sender, folder, depth (in steps of the first indentation) and whether it is highlighted.
const conversationRows = page => page.locator("#rows .row").evaluateAll(rs => {
  const pad = rs.map(r => parseFloat(getComputedStyle(r).paddingLeft)), step = pad.find(p => p > pad[0]) - pad[0];
  return rs.map((r, k) => ({ who: r.querySelector(".fr").textContent, folder: r.querySelector(".sb em")?.textContent ?? null, depth: Math.round((pad[k] - pad[0]) / step) || 0, sel: r.classList.contains("sel") }));
});
const conversationShown = page => page.waitForFunction(() => document.getElementById("list-title").textContent.startsWith("Conversation"), null, { timeout: 5000 }).catch(() => {});

scenario("Show conversation lists a message's conversation as a tree, keeps the message open, follows a mail check, and Esc goes back", async ({ page, calls, mock, folders }, expect) => {
  const alex = { name: "Alex", email: "alex@x.com" }, me = { name: "Me Myself", email: "me@yahoo.com" }, bob = { name: "Bob", email: "bob@x.com" }, cy = { name: "Cy", email: "cy@x.com" };
  let answered = false;
  // the original in Projects; the user's reply in Sent; Bob's answer to it (MSG1_2, in Inbox); a
  // second reply to the original; and one whose parent is gone, which hangs from the original it
  // also names. Once answered, the user's answer to Bob comes after a mail check.
  mock.handler = conversationAnswer("4002", () => [
    ...(answered ? [ofConversation(3, "2", "Sent", me, "Re: Plan", 0, ["<f@x>", "<c@x>", "<a@x>", "<b@x>", "<c@x>"])] : []),
    ofConversation(1, "62", "Archive", cy, "Re: Plan", 1, ["<e@x>", "<gone@x>", "<a@x>", "<gone@x>"]),
    ofConversation(5, "1", "Inbox", alex, "Re: Plan", 2, ["<d@x>", "<a@x>", "<a@x>"]),
    ofConversation(2, "1", "Inbox", bob, "Re: Plan", 3, ["<c@x>", "<b@x>", "<a@x>", "<b@x>"]),
    ofConversation(1, "2", "Sent", me, "Re: Plan", 4, ["<b@x>", "<a@x>", "<a@x>"]),
    ofConversation(1, "31", "Projects", alex, "Plan", 5, ["<a@x>"]),
  ]);
  const bodies = () => calls.filter(c => c.name === "messages.getBody").length;
  const asked = () => calls.filter(c => c.name === "messageGroups.getList").map(c => decodeURIComponent(c.envelope.requests[0].uri.split("q=")[1] || "")).filter(q => q.includes("conversationId"));
  // the address book's first build says when it is done, which would cover what the list says
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(700);
  const subject = await page.locator("#r-subject").textContent(), opened = bodies();
  await page.locator("#rows .row").nth(1).click({ button: "right" }); await page.waitForTimeout(150);
  const item = await page.locator('#ctx [data-act="conversation"]').evaluate(e => [e.querySelector("span").textContent, e.querySelector("kbd")?.textContent]).catch(() => null);
  await page.locator('#ctx [data-act="conversation"]').click();
  await conversationShown(page); await page.waitForTimeout(300);
  const shown = { title: await page.locator("#list-title").textContent(), rows: await conversationRows(page), days: await page.locator("#rows .day").count(), reader: await page.locator("#r-subject").textContent(), fetched: bodies() - opened, said: await page.locator("#st-msg").textContent(), asked: asked() };
  expect(JSON.stringify(item) === '["Show conversation","w"]', "the menu offers Show conversation, with its key: " + JSON.stringify(item));
  expect(shown.title === "Conversation: Plan" && !shown.days && shown.said === "5 messages in the conversation" && shown.asked.length === 1 && /(^| )conversationId:4002( |$)/.test(shown.asked[0]) && /(^| )count:300( |$)/.test(shown.asked[0]) && shown.asked[0].includes("-folderType:(TRASH)-folderType:(BULK)"),
    "one search by conversation id, the list named after it, no days: " + JSON.stringify(shown));
  expect(shown.rows.map(r => `${r.who}/${r.folder}/${r.depth}`).join() === "Alex/Projects/0,Me Myself/Sent/1,Bob/Inbox/2,Alex/Inbox/1,Cy/Archive/1",
    "the original on top, each reply beneath what it answers, oldest first, each with its folder: " + JSON.stringify(shown.rows));
  expect(shown.rows.findIndex(r => r.sel) === 2 && shown.rows.filter(r => r.sel).length === 1 && shown.reader === subject && !shown.fetched, "the message stays highlighted and open, not fetched again: " + JSON.stringify({ rows: shown.rows, reader: shown.reader, subject, fetched: shown.fetched }));
  // A mail check sees Sent change before Yahoo's search has the user's new answer; the next check,
  // which sees no change, looks again and finds it, under Bob's; the one after asks nothing.
  const check = async () => { await sleep(3100); await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); };   // a check comes 3 s after the last at the soonest
  const looked = asked().length;
  folders.find(f => f.id === "2").highestModSeq++;
  await check();
  for (let i = 0; i < 50 && asked().length === looked; i++) await sleep(100);
  await page.waitForTimeout(300);
  const lagging = await page.locator("#rows .row").count();
  answered = true;
  await check();
  await page.waitForFunction(() => document.querySelectorAll("#rows .row").length === 6, null, { timeout: 6000 }).catch(() => {});
  const polled = { rows: await conversationRows(page), reader: await page.locator("#r-subject").textContent() };
  await check(); await page.waitForTimeout(800);
  const looks = asked().length - looked;
  expect(lagging === 5 && looks === 2 && polled.rows.map(r => `${r.who}/${r.depth}`).join() === "Alex/0,Me Myself/1,Bob/2,Me Myself/3,Alex/1,Cy/1" && polled.rows.findIndex(r => r.sel) === 2 && polled.reader === subject,
    "a mail check refreshes the conversation, and the next looks once more, the highlight and the reader where they were: " + JSON.stringify({ lagging, looks, polled }));
  await page.locator("#rows .row").nth(0).click({ button: "right" }); await page.waitForTimeout(150);
  const inside = await page.locator('#ctx [data-act="conversation"]').count();
  await page.keyboard.press("Escape");
  const stays = await page.locator("#list-title").textContent();
  await page.locator("#list").focus(); await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("list-title").textContent === "Inbox", null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  const back = { title: await page.locator("#list-title").textContent(), sel: await page.evaluate(() => [...document.querySelectorAll("#rows .row")].findIndex(x => x.classList.contains("sel"))), reader: await page.locator("#r-subject").textContent() };
  expect(!inside && stays === "Conversation: Plan", "a conversation does not offer itself again, and Esc closes the menu first: " + JSON.stringify({ inside, stays }));
  expect(back.title === "Inbox" && back.sel === 1 && back.reader === subject, "Esc goes back to Inbox, the message highlighted and open: " + JSON.stringify(back));
  await page.locator("#list").focus(); await page.keyboard.press("w");
  await conversationShown(page); await page.waitForTimeout(300);
  const byKey = { title: await page.locator("#list-title").textContent(), rows: await conversationRows(page) };
  expect(byKey.title === "Conversation: Plan" && byKey.rows[2]?.who === "Bob" && byKey.rows[2].sel, "w shows it too: " + JSON.stringify(byKey));
}, { settings: { markReadSec: null } });

scenario("a conversation shown from a search goes back to the search as it was, and one shown from Trash keeps its message", async ({ page, mock }, expect) => {
  // the search leaves out a message in Trash, so the conversation of MSG4_1 answers another alone
  mock.handler = conversationAnswer("4001", () => [{ ...msg(7, "1"), conversationId: "4001" }]);
  // a search's rows name their folder after the subject
  const selected = () => page.locator("#rows .row.sel .sb").evaluate(e => e.firstChild.textContent).catch(() => "");
  await page.locator("#search").click(); await page.keyboard.type("Subject"); await page.keyboard.press("Shift+Enter"); await page.waitForTimeout(800);
  const title = await page.locator("#list-title").textContent();
  await page.locator("#rows .row").nth(2).click(); await page.waitForTimeout(500);
  const picked = await selected();
  await page.locator("#list").focus(); await page.keyboard.press("w");
  await conversationShown(page); await page.waitForTimeout(300);
  await page.locator("#list").focus(); await page.keyboard.press("Escape");
  await page.waitForFunction(t => document.getElementById("list-title").textContent === t, title, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  const back = { title: await page.locator("#list-title").textContent(), sel: await selected(), reader: await page.locator("#r-subject").textContent(), box: await page.inputValue("#search") };
  expect(back.title === title && title.startsWith("“Subject”") && back.sel === picked && back.reader === picked && back.box === "Subject", "Esc goes back to the search, the message highlighted and open: " + JSON.stringify({ title, picked, back }));
  await folder(page, "Trash");
  await page.locator("#rows .row").first().click(); await page.waitForTimeout(500);
  await page.locator("#list").focus(); await page.keyboard.press("w");
  await conversationShown(page); await page.waitForTimeout(300);
  const trash = await conversationRows(page);
  expect(trash.length === 2 && trash.filter(r => r.sel).map(r => r.who).join() === "Sender 1", "the message from Trash is listed with its conversation, highlighted: " + JSON.stringify(trash));
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
  const label = await undoTips(page);
  expect(moves === 1, "a held e archives once: " + moves);
  expect(/Redo: archive/.test(label) && !/Undo:/.test(label), "Z with Caps Lock undoes: " + label);
});

scenario("the Undo button can cancel a pending send", async ({ page }, expect) => {
  await newMessage(page, { subject: "Wait", text: "x" });
  await page.keyboard.press("Control+Enter"); await page.waitForTimeout(400);
  const disabled = await page.locator('#st-acts button[data-act="undo"]').isDisabled();
  await page.locator('#st-acts button[data-act="undo"]').click({ timeout: 2000 }).catch(() => {});
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
  // also the addresses a picture loads from besides its src: a srcset, a picture's source, and SVG
  // painting and clipping attributes; a part that could not be inlined (cid:) cannot be shown, so
  // it gives way to its alt text
  const T = n => `https://ecp.yusercontent.com/t-q${n}.png`;
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  mock.patchBody = (id, m, body) => { if (id.startsWith("MSG6_")) body.html = `<p>Spam text</p><img src="${T("uote")}" width="5" height="5"><div style="width:9px;height:9px;background:url(${T("bg")})">b</div>` +
    `<img alt="" src="${PNG}" srcset="${T("set0")} 0.25x, ${T("set")} 1x"><picture><source srcset="${T("source0")} 0.25x, ${T("source")} 1x"><img alt="" src="${PNG}"></picture><img alt="lost-logo" src="cid:logo@spam">` +
    `<svg width="20" height="20"><rect width="10" height="10" fill="url(${T("fill")}#p)" mask="url(${T("mask")}#m)" clip-path="url(${T("clip")}#c)"/></svg>`; };
  await folder(page, "Spam");
  await page.locator("#rows .row").first().click(); await page.waitForTimeout(600);
  await page.locator("#list").focus(); await page.keyboard.press("r"); await page.waitForSelector("#compose:not(.hidden)");
  await page.waitForTimeout(800);
  const loaded = mock.images.filter(i => /t-q/.test(i.url)).map(i => i.url.split("/").pop());
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 }).catch(() => {});
  const html = msgOf(calls.filter(c => c.name === "messages.saveAndSend").pop())?.simpleBody?.html || "";
  expect(!loaded.length, "no image of the Spam quote loads while writing: " + JSON.stringify(loaded));
  expect(/src="https:\/\/ecp\.yusercontent\.com\/t-quote\.png"/.test(html) && /url\(https:\/\/ecp\.yusercontent\.com\/t-qbg\.png\)/.test(html) && /srcset="https:\/\/ecp\.yusercontent\.com\/t-qset0\.png 0\.25x, https:\/\/ecp\.yusercontent\.com\/t-qset\.png 1x"/.test(html) &&
    /fill="url\(https:\/\/ecp\.yusercontent\.com\/t-qfill\.png#p\)"/.test(html) && !/data-held/.test(html), "the sent quote has them back: " + html.slice(0, 900));
  expect(html.includes("lost-logo") && !html.includes("cid:logo@spam"), "a part that could not be inlined is its alt text: " + html.slice(0, 900));
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

// Enter takes a suggestion only when it is the typed address or completes what was typed: an
// address that merely contains the text, however recent, never stands in for it.
scenario("a typed address is never replaced by a suggestion that only contains it", async ({ page }, expect) => {
  await page.waitForFunction(() => /^Contacts:/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});   // the build has finished
  await page.evaluate(async when => {
    const c = await import("./contacts.js");
    await c.learn([{ headers: { date: String(when), from: [{ name: "Ann Old", email: "ann@corp.example" }], to: [{ name: "Me", email: "me@yahoo.com" }] } }]);
    await c.noteSent([{ name: "Joann New", email: "joann@corp.example" }, { name: "Jordan", email: "jordan@gmail.com" }]);
  }, Math.floor(Date.now() / 1000) - 200 * 86400);
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  const offered = {};
  for (const text of ["ann@corp.example", "dan@gmail.com", "jor"]) {
    await page.locator("#c-to input").type(text);
    // the list is up before the key, so the key meets it
    await page.waitForSelector("#c-suggest:not(.hidden)", { timeout: 5000 }).catch(() => {});
    offered[text] = (await page.locator("#c-suggest div span").allTextContents()).join(" | ");
    await page.keyboard.press("Enter");
  }
  const chips = await page.$$eval("#c-to .chip", els => els.map(e => e.title));
  expect(/joann@corp\.example/.test(offered["ann@corp.example"]) && /jordan@gmail\.com/.test(offered["dan@gmail.com"]) && /jordan@gmail\.com/.test(offered.jor),
    "the longer addresses are offered: " + JSON.stringify(offered));
  expect(JSON.stringify(chips) === JSON.stringify(["Ann Old <ann@corp.example>", "dan@gmail.com", "Jordan <jordan@gmail.com>"]),
    "Enter keeps the typed address or its exact contact, and completes a partial one: " + JSON.stringify(chips));
});

// a new message without a signature, holding only a pasted picture
scenario("a message holding only a picture is saved when it is closed", async ({ page, calls }, expect) => {
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  await page.evaluate(png => {
    const ed = document.getElementById("c-editor");
    ed.innerHTML = `<img src="data:image/png;base64,${png}" width="2" height="2">`;
    ed.focus(); ed.dispatchEvent(new Event("input", { bubbles: true }));
  }, "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==");
  await page.keyboard.press("Escape");
  await composerHidden(page);
  const saved = msgOf(saves(calls).pop())?.message;
  expect(saved && (saved.attachments || []).some(a => a.disposition === "inline"), "the picture is saved to Drafts: " + JSON.stringify(saved?.attachments || null));
});

// z brings a held message back while a draft is still loading: when the draft opens, the message
// brought back is saved to Drafts first, not overwritten.
scenario("a message brought back by undo-send is saved when a loading draft opens over it", async ({ page, ctx, calls }, expect) => {
  await newMessage(page, { subject: "Alpha", text: "hello" });
  await page.keyboard.press("Control+Enter");
  await composerHidden(page);
  // the draft's attachments come from its source, which is slow to come
  await ctx.route(u => u.href.includes("/content/rawplaintext"), async route => { await sleep(3000); await route.fallback(); });
  await folder(page, "Draft");
  await page.locator("#rows .row").first().click();
  await page.waitForTimeout(600);
  await page.keyboard.press("z");
  await page.waitForFunction(() => document.getElementById("c-subject").value === "Alpha", null, { timeout: 5000 }).catch(() => {});
  const back = await page.inputValue("#c-subject");
  await page.waitForFunction(() => document.getElementById("c-subject").value === "Subject 3-1", null, { timeout: 15000 }).catch(() => {});
  const r = { back, now: await page.inputValue("#c-subject"), saved: saves(calls).map(c => msgOf(c)?.message?.headers?.subject), reader: await page.locator("#reader").isHidden() };
  expect(r.back === "Alpha" && r.now === "Subject 3-1" && r.saved.includes("Alpha") && r.reader, "the message brought back is in Drafts, and the draft is open: " + JSON.stringify(r));
}, { settings: { undoSendSec: 10 } });

// The autosave takes the recipients already made chips, and leaves an address being typed as it
// is: no chip of half an address, no complaint about it.
scenario("the autosave leaves an address being typed alone", async ({ page, calls }, expect) => {
  await page.clock.install();
  await page.reload(); await page.waitForSelector("#rows .row", { timeout: 15000 });
  await newMessage(page, { subject: "Half typed", text: "body" });
  const r = {};
  for (const half of ["john.smith@company.c", "john.smith@comp"]) {
    // still in To, as when the tick lands while the address is typed
    await page.locator("#c-to input").fill(""); await page.locator("#c-to input").type(half);
    const before = saves(calls).length;
    await page.clock.fastForward(31000);
    await page.waitForTimeout(800);
    r[half] = { saved: saves(calls).length - before, to: msgOf(saves(calls).pop())?.message?.headers?.to?.map(a => a.email), typed: await page.inputValue("#c-to input"),
      chips: await page.$$eval("#c-to .chip", els => els.map(e => e.title)), notice: await notice(page) };
  }
  const ok = v => v.saved === 1 && JSON.stringify(v.to) === '["q@example.com"]' && JSON.stringify(v.chips) === '["q@example.com"]' && !v.notice;
  expect(ok(r["john.smith@company.c"]) && r["john.smith@company.c"].typed === "john.smith@company.c" && ok(r["john.smith@comp"]) && r["john.smith@comp"].typed === "john.smith@comp",
    "the draft is saved with the chips, and the address being typed stays as typed: " + JSON.stringify(r));
}, { allow: /Blocked script execution in 'about:blank'/ });   // the test clock is refused by the sandboxed frames

// The limit on what a message carries counts the pictures in its text with its files (the limit
// is made small here, so a picture and a file of a few kilobytes reach it).
scenario("the size limit counts pictures in the text with the files", async ({ page }, expect) => {
  await newMessage(page, { subject: "Heavy", text: "see" });
  await page.evaluate(async () => { (await import("./api.js")).LIMITS.messageBytes = 3000; });
  await page.setInputFiles("#c-imgfile", { name: "dot.png", mimeType: "image/png", buffer: Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"), Buffer.alloc(1500)]) });
  await page.waitForTimeout(400);
  await page.setInputFiles("#c-files", { name: "notes.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(2000, 1) });
  await page.waitForTimeout(400);
  const r = { pictures: await page.locator("#c-editor img").count(), attached: await page.locator("#c-filelist .c-file").count(), notice: await notice(page) };
  await page.evaluate(async () => { (await import("./api.js")).LIMITS.messageBytes = 25 * 1048576; });
  expect(r.pictures === 1 && r.attached === 0 && /^Not attached: notes\.bin/.test(r.notice), "the file does not fit beside the picture: " + JSON.stringify(r));
});

// A picture mail cannot show in the text (SVG here) is attached instead of being lost on sending.
scenario("a picture of a kind the text cannot carry is attached", async ({ page }, expect) => {
  // the first build of Contacts ends with a word in the status line, which is where the composer says what it attached: the build is let end first
  await page.waitForFunction(() => /^Contacts: [\d,.\s]+ addresses \(/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
  await newMessage(page, { subject: "Pictures", text: "see" });
  await page.setInputFiles("#c-imgfile", [{ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>') },
    { name: "dot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64") }]);
  await page.waitForTimeout(600);
  const r = { inText: await page.$$eval("#c-editor img", els => els.map(e => e.dataset.name)), attached: await page.$$eval("#c-filelist .c-file", els => els.map(e => e.firstChild.textContent.trim())),
    status: await page.locator("#st-msg").textContent() };
  expect(JSON.stringify(r.inText) === '["dot.png"]' && JSON.stringify(r.attached) === '["logo.svg"]' && /^attached logo\.svg: /.test(r.status), "the PNG is in the text and the SVG attached: " + JSON.stringify(r));
});

scenario("Write in Contacts leaves alone a message that cannot be put away", async ({ page }, expect) => {
  await newMessage(page, { subject: "Keep" });
  await page.locator("#c-to input").type("car");          // unfinished, so the message cannot be saved
  await contactsOpen(page);
  await contactRow(page, "o@x.com").click();
  await page.keyboard.press("c");                         // Write, as the composer covers the person's page
  await page.waitForTimeout(800);
  const r = { open: await page.locator("#compose:not(.hidden)").count(), subject: await page.inputValue("#c-subject"), typed: await page.inputValue("#c-to input"),
    to: await page.$$eval("#c-to .chip", els => els.map(e => e.title)), notice: await notice(page) };
  expect(r.open === 1 && r.subject === "Keep" && r.typed === "car" && JSON.stringify(r.to) === JSON.stringify(["q@example.com"]) && /kept open/.test(r.notice),
    "the message stays as it was, without the person Write was for: " + JSON.stringify(r));
});

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

// A reply switched to plain text keeps its quote marked, each line of it, as plain-text mail does.
scenario("a reply switched to plain text quotes with > before each line", async ({ page, mock }, expect) => {
  mock.patchBody = (id, m, body) => { if (id === "MSG1_2") body.html = "<div>First line of the original,\n    written across\n    source lines.</div><blockquote><div>Older words</div></blockquote>"; };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  await page.locator("#list").focus(); await page.keyboard.press("r"); await page.waitForSelector("#compose:not(.hidden)");
  page.once("dialog", d => d.accept());
  await page.selectOption("#c-mode", "text");
  await page.waitForTimeout(300);
  const lines = (await page.inputValue("#c-text")).split("\n");
  const r = { first: lines.find(l => /First line/.test(l)), older: lines.find(l => /Older words/.test(l)) };
  expect(r.first === "> First line of the original, written across source lines." && r.older === "> > Older words", "the quote's lines are marked, and nested quotes nested: " + JSON.stringify(r));
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

// The picker keeps text symbols from the user's own mail and from people the user writes to (the
// Inbox's senders here were never written to, so what they use is not kept), and a symbol pasted
// on its own, newest first.
scenario("the symbol picker inserts at the caret, and keeps text symbols from mail the user exchanges and from pastes", async ({ page, mock }, expect) => {
  mock.patchBody = (id, m, body) => { if (id.startsWith("MSG2_")) body.html += "<p>Costs ½ ≈ 🔥 ━━</p>"; else if (id.startsWith("MSG1_")) body.html += "<p>Brand™</p>"; };
  await folder(page, "Sent"); await page.locator("#rows .row").first().click(); await page.waitForTimeout(800);
  await folder(page, "Inbox"); await page.locator("#rows .row").first().click(); await page.waitForTimeout(800);
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  await page.locator("#c-editor").focus(); await page.keyboard.press("Control+Home"); await page.keyboard.type("Done ");
  // pastes: one symbol alone is kept; a letter, or a symbol among other text, is not
  for (const t of ["№", "é", "x ‰"]) await page.locator("#c-editor").evaluate((e, t) => { const d = new DataTransfer(); d.setData("text/plain", t); e.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })); }, t);
  await page.click('[data-cmd="symbol"]'); await page.waitForSelector("#c-symbols:not(.hidden)");
  const pop = await page.evaluate(async () => {
    const p = document.getElementById("c-symbols"), own = [...p.querySelectorAll(".sym-line ~ [data-s]")].map(b => b.dataset.s);
    return { fixed: p.querySelectorAll("[data-s]").length - own.length, own, stored: (await chrome.storage.local.get("symbols")).symbols };
  });
  await page.locator('#c-symbols [data-s="☑"]').click();
  const put = { text: await page.locator("#c-editor").evaluate(e => e.textContent.includes("Done ☑︎")), closed: await page.locator("#c-symbols").isHidden() };
  await page.keyboard.press("Control+z");
  const undone = await page.locator("#c-editor").evaluate(e => !e.textContent.includes("☑"));
  await page.click('[data-cmd="symbol"]'); await page.waitForSelector("#c-symbols:not(.hidden)");
  await page.keyboard.press("Escape");
  const esc = { pop: await page.locator("#c-symbols").isHidden(), compose: await page.locator("#compose").isVisible() };
  const want = ["№", "≈", "½"].join();
  expect(pop.fixed === 16 && pop.own.join() === want && pop.stored?.join() === want, "16 fixed symbols, then the paste and the text symbols of the user's own mail, newest first and stored: " + JSON.stringify(pop));
  expect(put.text && put.closed && undone, "a symbol goes in at the caret in text style, and Ctrl+Z takes it back: " + JSON.stringify({ ...put, undone }));
  expect(esc.pop && esc.compose, "Esc closes the picker, not the composer: " + JSON.stringify(esc));
});

// Formatted text from another app is cleaned as the editor's other HTML is, and keeps only the
// pictures the page can show: a chat app's emoji picture gives way to its character, and nothing
// loads from an address the page's policy refuses.
scenario("formatted text pasted or dropped keeps only the pictures the composer can show", async ({ page, cspViolations, mock }, expect) => {
  await newMessage(page);
  await page.locator("#c-editor").focus(); await page.keyboard.press("Control+Home"); await page.keyboard.type("Hi ");
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const chat = `<html><body><!--StartFragment--><span class="selectable-text" style="position:fixed;top:0;color:rgb(1, 2, 3)">Bok <img alt="🇭🇷" class="emoji" src="https://web.whatsapp.com/emoji/v1/16/0/2/single/w/40/01f1ed_01f1f7.png" style="background-image:url(https://web.whatsapp.com/sprite.png)"></span>` +
    `<img src="https://example.com/track.gif" width="1" height="1"><img src="https://ecp.yusercontent.com/t-paste.png" srcset="https://example.com/big.png 2x" width="5" height="5"><img src="${PNG}" alt="dot">` +
    `<div style="background:url(https://example.com/bg.png) red">box</div><!--EndFragment--></body></html>`;
  const send = (type, html) => page.locator("#c-editor").evaluate((e, [type, html]) => {
    const d = new DataTransfer(); d.setData("text/html", html); d.setData("text/plain", "plain");
    const r = e.getBoundingClientRect();
    e.dispatchEvent(type === "paste" ? new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })
      : new DragEvent("drop", { dataTransfer: d, bubbles: true, cancelable: true, clientX: r.right - 4, clientY: r.bottom - 4 }));
  }, [type, html]);
  await send("paste", chat); await page.waitForTimeout(300);
  const pasted = await page.locator("#c-editor").evaluate(e => ({ text: e.textContent, html: e.innerHTML, imgs: [...e.querySelectorAll("img")].map(i => i.getAttribute("src").slice(0, 30)) }));
  await page.keyboard.press("Control+z");
  const undone = await page.locator("#c-editor").evaluate(e => !e.textContent.includes("Bok") && e.textContent.includes("Hi"));
  await send("drop", '<p>star <img alt="★" src="https://example.com/star.png"></p>'); await page.waitForTimeout(300);
  const dropped = await page.locator("#c-editor").evaluate(e => ({ text: e.textContent, imgs: e.querySelectorAll("img").length }));
  const refused = cspViolations.filter(v => /whatsapp|example\.com/.test(v));
  expect(/Hi\sBok 🇭🇷/.test(pasted.text) && !pasted.text.includes("plain"), "the emoji picture is its character, and the formatted text is what goes in: " + JSON.stringify(pasted.text));
  expect(pasted.imgs.join() === ["https://ecp.yusercontent.com/t", PNG.slice(0, 30)].join() && !/srcset|example\.com|whatsapp/.test(pasted.html), "only the pictures the page can show stay, without addresses it cannot: " + pasted.html);
  expect(!/position|selectable-text|class="emoji"|initial/.test(pasted.html) && /color: rgb\(1, 2, 3\)/.test(pasted.html) && /background: (none )?red/.test(pasted.html), "the cleaning of the editor's HTML applies, and the formatting stays: " + pasted.html);
  expect(undone, "Ctrl+Z takes the paste back");
  expect(dropped.text.includes("star ★") && !dropped.imgs, "a drop is cleaned as a paste is: " + JSON.stringify(dropped));
  expect(!refused.length && !mock.images.some(i => /example|whatsapp/.test(i.url)), "nothing is loaded from where the page may not: " + JSON.stringify(refused));
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

// A draft is saved whole each time, so one whose picture cannot be fetched is kept closed rather
// than saved without it, unless the user gives the picture up.
scenario("a draft whose picture cannot be loaded stays closed until opened anyway", async ({ page, ctx, mock }, expect) => {
  const LOST = "/parts/@.id==9/thumbnail";       // a part the message source does not hold either
  mock.patchBody = (id, m, body) => { if (id.startsWith("MSG3_")) body.html += `<img src="https://cloud-apis.mail.yahoo.com/ws/v3/mailboxes/@.id==MB1/messages/@.id==${id}/content${LOST}&amp;appid=x&amp;pid=9">`; };
  await ctx.route(u => u.href.includes(LOST), route => route.fulfill({ status: 500, body: "" }));
  await folder(page, "Draft");
  await page.locator("#rows .row").first().click();
  await page.waitForFunction(() => /Could not load/.test(document.getElementById("notice-text").textContent), null, { timeout: 15000 }).catch(() => {});
  const r = { open: await page.locator("#compose:not(.hidden)").count(), said: await notice(page) };
  await page.locator("#notice-text button.link").click();
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 }).catch(() => {});
  r.anyway = await page.locator("#compose:not(.hidden)").count();
  expect(r.open === 0 && /^Could not load 1 picture of the draft, so it was not opened: saving it would leave that picture out\. Open anyway$/.test(r.said) && r.anyway === 1,
    "the draft opens only when its picture is given up: " + JSON.stringify(r));
}, { allow: /status of 500/ });

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

// ---------- a quote's formatting ----------
// A message laid out by its style sheet alone, as a shop's receipt is: a reset on every element,
// classes and an id for the rest, and rules for narrow and dark screens.
const RECEIPT = `<style>
* { border: none; margin: 0; padding: 0; font-family: "Courier New", monospace; text-decoration: none; }
table { border-collapse: collapse; }
body { background-color: #f1f3f4; }
.wrap { width: 560px; margin: 0 auto; background: #ffffff; }
.pad { padding: 24px 32px; }
.h2 { font-weight: 700; font-size: 28px; line-height: 36px; color: #202124; }
.body { color: #202124; font-weight: 400; font-size: 14px; line-height: 1.5; letter-spacing: 0.2px; }
.col { width: 50%; vertical-align: top; }
.price { text-align: right; font-weight: 700; }
.btn { display: inline-block; background: #1a73e8; color: #ffffff !important; border-radius: 4px; padding: 10px 24px; }
.muted { color: #5f6368; font-size: 12px; }
#sum td { border-top: 1px solid #dadce0; padding-top: 12px; }
@media screen and (max-width: 720px) { .wrap { width: 100% !important; } .col { display: block !important; } .h2 { font-size: 20px !important; } }
@media (prefers-color-scheme: dark) { .wrap { background: #000000 !important; } }
</style>
<table width="100%"><tr><td align="center"><table class="wrap"><tr><td class="pad">
<h2 class="h2">Thanks for your purchase</h2>
<p class="body">Your order is confirmed.</p>
<table width="100%"><tr><td class="col"><p class="body">Pixel Stand</p><p class="muted">Qty 1</p></td><td class="col price"><p class="body">$79.00</p></td></tr>
<tr id="sum"><td class="col"><p class="body">Total</p></td><td class="col price"><p class="body">$85.32</p></td></tr></table>
<p><a class="btn" href="https://example.com/order">View order</a></p>
</td></tr></table></td></tr></table>`;
// What the sheet gives six of its elements, as computed where the message is shown: the reader's
// frame, or the quote in the editor.
const receiptLook = where => {
  const root = where === "reader" ? document.getElementById("r-body").contentDocument.body : document.querySelector("#c-editor .ymq");
  const cell = text => [...root.querySelectorAll("td")].findLast(td => td.textContent.trim() === text);
  const text = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "margin-top", "margin-bottom"];
  const look = { title: [root.querySelector("h2"), text], para: [root.querySelector("h2 + p"), text], wrap: [root.querySelectorAll("table")[1], ["width", "background-color", "border-collapse"]],
    price: [cell("$79.00"), ["text-align", "font-weight", "vertical-align", "padding-left", "padding-top"]], sum: [cell("Total"), ["border-top-width", "border-top-style", "border-top-color", "padding-top"]],
    button: [root.querySelector("a"), ["display", "background-color", "color", "border-top-left-radius", "padding-left", "padding-top", "text-decoration-line", "font-family"]] };
  return Object.fromEntries(Object.entries(look).map(([k, [el, props]]) => [k, el ? props.map(p => getComputedStyle(el).getPropertyValue(p)).join("|") : "missing"]));
};

scenario("a forward and a reply keep the formatting a message's style sheet gives it", async ({ page, calls, mock }, expect) => {
  mock.patchBody = (id, m, body) => { if (id === "MSG1_2") body.html = RECEIPT; };
  await page.setViewportSize({ width: 1500, height: 900 });      // a reader wider than the sheet's narrow screen
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  const reader = await page.evaluate(receiptLook, "reader");
  expect(/^"Courier New", monospace\|28px\|700\|36px/.test(reader.title) && /^560px\|rgb\(255, 255, 255\)/.test(reader.wrap), "the reader shows the wide, light layout: " + JSON.stringify(reader));
  for (const [key, what] of [["f", "forward"], ["r", "reply"]]) {
    await page.locator("#list").focus(); await page.keyboard.press(key); await page.waitForSelector("#compose:not(.hidden)");
    await page.waitForTimeout(300);
    const quote = await page.evaluate(receiptLook, "editor");
    expect(JSON.stringify(quote) === JSON.stringify(reader), `the ${what}'s quote looks as the message does in the reader: ` + JSON.stringify({ quote, reader }));
    const r = await page.evaluate(() => { const q = document.querySelector("#c-editor .ymq"), mine = getComputedStyle(document.querySelector("#c-editor > div"));
      return { sheets: q.querySelectorAll("style").length, named: q.querySelectorAll("[class], [id]").length, mine: mine.fontFamily, frames: document.querySelectorAll("iframe").length }; });
    expect(!r.sheets && !r.named && !/Courier/.test(r.mine) && r.frames === 1, `the ${what} holds no sheet, class or id of the sender's, and the user's own text keeps the composer's font: ` + JSON.stringify(r));
    if (key === "r") break;
    await page.locator("#c-to input").type("q@example.com"); await page.keyboard.press("Enter");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 }).catch(() => {});
    const html = msgOf(calls.filter(c => c.name === "messages.saveAndSend").pop())?.simpleBody?.html || "";
    expect(/<h2 style="[^"]*font-size: 28px/.test(html) && !/<style|class="(h2|wrap|btn)"/.test(html), "the sent forward carries the formatting in its elements: " + html.slice(0, 600));
    expect(html.length < 2 * RECEIPT.length, `a reset on every element does not swell the quote: ${html.length} characters for a message of ${RECEIPT.length}`);
    await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(800);
  }
});

scenario("inlineStyles golden values: the cascade, the screens a rule is for, what is left out, and nothing loaded", async ({ page, mock, cspViolations }, expect) => {
  const cases = {
    cascade: ['<style>p{color:red;margin:0}.a{color:blue}#x{color:green}.b{color:orange!important}</style><p class="a b" id="x" style="color:black">t</p><p class="a">u</p><p id="y" style="color:black">v</p><p style="color:black!important" class="b">w</p>',
      '<p class="a b" id="x" style="color: orange; margin-top: 0px; margin-bottom: 0px;">t</p><p class="a" style="color: blue; margin-top: 0px; margin-bottom: 0px;">u</p><p id="y" style="color: black; margin-top: 0px; margin-bottom: 0px;">v</p><p style="color: black; margin-top: 0px; margin-bottom: 0px;" class="b">w</p>'],
    order: ['<style>div p{color:red}p{color:blue}:is(.q,#z) p{margin:1px}div p{margin:2px}:where(#z) p{padding:3px}p{padding:4px}</style><div class="q"><p>t</p></div>',
      '<div class="q"><p style="color: red; padding: 4px; margin: 1px;">t</p></div>'],
    screens: ['<style>.w{width:600px}@media (max-width:720px){.w{width:100%!important}}@media screen{.w{color:red}}@media (prefers-color-scheme:dark){.w{background:#000}}@media print{.w{display:none}}</style><style media="print">.w{float:left}</style><div class="w">x</div>',
      '<div class="w" style="color: red; width: 600px;">x</div>'],
    // the body's styles go to a div around the message; a declaration that changes nothing is left out
    reset: ['<style>*{margin:0;padding:0;font-family:Georgia}body{background:#eee;height:100%}table{border-collapse:collapse}</style><table><tr><td><p>a</p><span>b</span></td></tr></table>',
      '<div style="font-family: Georgia; background-color: rgb(238, 238, 238);"><table style="border-collapse: collapse;"><tbody><tr><td style="padding: 0px;"><p style="margin-top: 0px; margin-bottom: 0px;">a</p><span>b</span></td></tr></tbody></table></div>'],
    // an inherited property is left out only under an element of the quote that keeps it
    inherited: ['<style>p{font-size:16px;color:#000;text-align:left}b{font-size:16px;text-align:left}</style><p>a<b>c</b></p><b>d</b>',
      '<p style="font-size: 16px; color: rgb(0, 0, 0); text-align: left;">a<b>c</b></p><b style="font-size: 16px; text-align: left;">d</b>'],
    // an address is kept and not asked for; a cell whose picture is an attribute keeps its style as it is
    address: ['<style>.h{background:url(https://ecp.yusercontent.com/t-bg.png) no-repeat;color:red;margin:0}td{background-image:none}</style><div class="h">x</div><img src="https://ecp.yusercontent.com/t-img.png" width="5" height="5" class="h"><table><tr><td background="https://ecp.yusercontent.com/t-td.png">y</td></tr></table>',
      '<div class="h" style="color: red; background-repeat: no-repeat; background-image: url(&quot;https://ecp.yusercontent.com/t-bg.png&quot;);">x</div><img src="https://ecp.yusercontent.com/t-img.png" width="5" height="5" class="h" style="color: red; background-repeat: no-repeat; background-image: url(&quot;https://ecp.yusercontent.com/t-bg.png&quot;);"><table><tbody><tr><td background="https://ecp.yusercontent.com/t-td.png" style="background-image: none;">y</td></tr></tbody></table>'],
    unstyled: ['<p class="k">x</p><link rel="stylesheet" href="x.css">', '<p class="k">x</p>'],
  };
  const r = await page.evaluate(async cases => {
    const { inlineStyles } = await import("./quotestyle.js");
    const got = {};
    for (const [k, [html]] of Object.entries(cases)) got[k] = await inlineStyles(html);
    const t0 = performance.now();
    const many = await inlineStyles(`<style>${"*{color:red}".repeat(120)}</style>${"<i>x</i>".repeat(2000)}`);
    return { got, many: many.slice(0, 16), ms: performance.now() - t0, frames: document.querySelectorAll("iframe").length };
  }, cases);
  for (const [k, [, want]] of Object.entries(cases)) expect(r.got[k] === want, `${k}: ${r.got[k]}`);
  expect(r.many === "<i>x</i><i>x</i>" && r.ms < 1500, "a message with too many matches is quoted without its sheets, quickly: " + JSON.stringify([r.many, Math.round(r.ms)]));
  await page.waitForTimeout(300);
  expect(!mock.images.length && !cspViolations.length && r.frames === 1, "inlining asks for no picture and leaves no frame behind: " + JSON.stringify([mock.images, cspViolations, r.frames]));
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
