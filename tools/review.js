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
