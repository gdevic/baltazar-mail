// Runtime test: loads the real extension into Chromium with a mocked Yahoo backend and
// drives reading, folder switching, and compose/send. node tools/runtime.js
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXT = path.join(__dirname, "..", "ext");
const now = Math.floor(Date.now() / 1000);
const msg = (i, folder) => ({ id: `MSG${folder}_${i}`, conversationId: `C${i}`, modSeq: i, size: 1000, attachmentCount: 0, csid: `csid${i}`,
  flags: { read: i % 2 === 0, flagged: false },
  headers: { subject: `Subject ${folder}-${i}`, from: [{ name: `Sender ${i}`, email: `s${i}@x.com` }], to: [{ name: "Me", email: "me@yahoo.com" }], cc: [{ name: "Other", email: "o@x.com" }], date: String(now - i * 40000) },
  folder: { id: folder, name: folder === "1" ? "Inbox" : "Other" }, snippet: "snip" });
const folders = [
  { id: "1", name: "Inbox", types: ["INBOX"], unread: 3, total: 10, highestModSeq: 10 },
  { id: "3", name: "Draft", types: ["DRAFT"], unread: 0, total: 1, highestModSeq: 11 },
  { id: "2", name: "Sent", types: ["SENT"], unread: 0, total: 8, highestModSeq: 11 },
  { id: "4", name: "Trash", types: ["TRASH"], unread: 0, total: 1, highestModSeq: 12 },
  { id: "62", name: "Archive", types: ["ARCHIVE"], unread: 0, total: 0, highestModSeq: 16 },
  { id: "31", name: "Projects", types: ["USER"], unread: 0, total: 5, highestModSeq: 13 },
];
const accounts = [{ id: "1", email: "me@yahoo.com", sendingName: "Me Myself", isPrimary: true, isSending: true, type: "FREE", signature: "<i>sig</i>", signatureActive: true }];

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ymail-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const calls = [];
  await ctx.route("https://mail.yahoo.com/**", async route => {
    const req = route.request();
    if (req.url() === "https://mail.yahoo.com/") return route.fulfill({ contentType: "text/html", body: '<html><script>window.AppBootstrapData={"appId":"YMailCLDNovation","mailWssid":"w1","primaryMailbox":{"email":"me@yahoo.com","id":"MB1"}}</script></html>' });
    const name = new URL(req.url()).searchParams.get("name");
    const post = req.postData() || "";
    const headers = req.headers();
    const jsonM = post.match(/name="batchJson"\r\n\r\n([\s\S]*?)\r\n--/);
    const envelope = jsonM ? JSON.parse(jsonM[1]) : null;
    const fileParts = [...post.matchAll(/name="([^"]+)"; filename="([^"]+)"/g)].map(m => [m[1], m[2]]);
    calls.push({ name, origin: headers.origin, envelope, fileParts });
    const top = envelope?.requests?.[0] || {};
    const uri = top.uri || "";
    let responses;
    if (uri.endsWith("/folders")) responses = [{ id: top.id, httpCode: 200, response: { result: { folders, accounts: [] } } }];
    else if (uri.endsWith("/accounts")) responses = [{ id: top.id, httpCode: 200, response: { result: { accounts } } }];
    else if (uri.includes("/content/simplebody/full")) { const id = uri.match(/@\.id==(MSG[^/]+)/)[1]; responses = [{ id: top.id, httpCode: 200, response: { result: { message: msg(Number(id.split("_")[1]), id.split("_")[0].slice(3)), simpleBody: { html: `<p>Body of <b>${id}</b></p>`, attachments: [] } } } }]; }
    else if (top.id === "SaveMessage") {
      const saved = { ...msg(99, "3"), id: "MSGDRAFT_99", immutableid: "IMM99", csid: top.payloadParts[0].payload.message.csid };
      responses = [{ id: "SaveMessage", httpCode: 200, response: { result: { message: saved, simpleBody: {} } } }];
      for (const r of top.requests || []) responses.push({ id: r.id, httpCode: 200, response: { result: { message: saved } } });
    }
    else if (/"method":"(POST|DELETE)"/.test(post)) responses = [...post.matchAll(/"id":"((?:UnifiedUpdateMessage|UnifiedDeleteMessage)_\d+)"/g)].map(m => ({ id: m[1], httpCode: 204 }));
    else { const q = decodeURIComponent(uri.split("q=")[1] || ""); const folder = (q.match(/folderId:(\d+)/) || [])[1] || "1"; responses = [{ id: top.id, httpCode: 200, response: { result: { messages: Array.from({ length: 8 }, (_, i) => msg(i + 1, folder)), query: {} } } }]; }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses, status: {} }, error: null }) });
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Content Security Policy")) errors.push("console: " + m.text().slice(0, 200)); });
  await page.goto(`chrome-extension://${extId}/mail.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { pollSec: 5, undoSendSec: 2 } }));
  await page.reload();
  await page.waitForSelector("#rows .row", { timeout: 15000 });
  const frameText = async () => page.frameLocator("#r-body").locator("body").innerText({ timeout: 3000 }).catch(e => "FRAME-ERR");
  const results = {};

  // reading across folders
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(600);
  await page.locator("#folder-list .folder", { hasText: "Projects" }).click(); await page.waitForTimeout(400);
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  results.readAfterSwitch = (await frameText()).slice(0, 30);
  results.originHeader = calls.find(c => c.name === "messages.getBody")?.origin;

  // reply: quote present, recipients right
  await page.keyboard.press("a"); await page.waitForSelector("#compose:not(.hidden)");
  const chips = async id => (await page.locator(`#${id} .chip`).allTextContents()).join(" | ");
  results.replyAll = { title: await page.locator("#c-title").textContent(), to: await chips("c-to"), cc: await chips("c-cc"), subject: await page.inputValue("#c-subject"), quoteHidden: await page.locator("#c-quote").isHidden() };
  await page.locator("#c-discard").click(); await page.waitForTimeout(200);
  if (await page.locator("#compose").isVisible()) { page.once("dialog", d => d.accept()); await page.locator("#c-discard").click(); }

  // new message with attachment, send with 2 s hold, cancel, then send again
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("address book:"), null, { timeout: 15000 }).catch(() => {});
  results.addressBook = await page.locator("#st-msg").textContent();
  await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  await page.locator("#c-to input").type("Sen");
  await page.waitForSelector("#c-suggest:not(.hidden)", { timeout: 5000 });
  results.suggestions = await page.locator("#c-suggest div").allTextContents();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await page.locator("#c-to input").type("Alice <alice@example.com>, bob@example.com");
  await page.keyboard.press("Tab");
  results.toChips = await chips("c-to");
  await page.fill("#c-subject", "Runtime test");
  await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.type("Hello from the runtime test.");
  await page.setInputFiles("#c-files", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("attached text") });
  results.fileChip = await page.locator("#c-filelist").textContent();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "compose.png") }).catch(() => {});
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Sending in"));
  results.pending = await page.locator("#st-undo").textContent();
  await page.keyboard.press("z");
  await page.waitForSelector("#compose:not(.hidden)");
  results.afterCancel = { title: await page.locator("#c-title").textContent(), to: await chips("c-to"), body: (await page.locator("#c-editor").innerText()).trim(), files: await page.locator("#c-filelist").textContent() };
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 });
  const sendCall = calls.find(c => c.name === "messages.saveAndSend");
  const save = sendCall.envelope.requests[0];
  const payload = save.payloadParts[0].payload;
  results.sent = {
    uri: save.uri, parts: save.payloadParts.map(p => p.partName), fileParts: sendCall.fileParts,
    to: payload.message.headers.to, from: payload.message.headers.from, subject: payload.message.headers.subject, html: payload.simpleBody.html,
    attachments: payload.message.attachments, filters: save.filters, chain: (save.requests || []).map(r => [r.id, r.uri.replace(/@\.id==MB1/, "@.id==<mb>"), r.payload]),
    flags: payload.message.flags, newMessage: payload.message.newMessage,
  };
  results.composeHiddenAfterSend = await page.locator("#compose").isHidden();
  results.readerBack = await page.locator("#reader").isVisible();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "runtime.png") }).catch(() => {});
  console.log(JSON.stringify(results, null, 1));
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  const expect = (c, w) => { if (!c) errors.push("assert: " + w); };
  expect(results.readAfterSwitch.startsWith("Body of"), "reader after folder switch");
  expect(results.replyAll.to.includes("s2@x.com") && results.replyAll.cc.includes("o@x.com") && results.replyAll.subject.startsWith("Re:"), "reply-all recipients");
  expect(results.afterCancel.to.includes("alice@example.com") && results.afterCancel.body.includes("Hello"), "undo-send restores draft");
  expect(results.sent.to.length === 3 && results.sent.to.some(a => a.name === "Alice") && results.sent.to[0].email.startsWith("s"), "recipients: autocomplete chip plus two typed: " + JSON.stringify(results.sent.to));
  expect(results.suggestions.length >= 2 && results.suggestions[0].includes("Sender"), "autocomplete suggestions: " + results.suggestions.join(","));
  expect(/^<div><div>Hello from the runtime test\.<\/div>/.test(results.sent.html) && results.sent.html.includes("ymsig"), "typed text above signature, no stray keys: " + results.sent.html);
  expect(results.sent.fileParts.some(p => p[1] === "note.txt") && results.sent.attachments.length === 1, "attachment sent");
  expect(results.sent.chain.some(c => c[0] === "SendMessage"), "send chained");
  if (errors.length) { console.error("FAILED:", errors); process.exit(1); }
  console.log("PASS");
})().catch(e => { console.error(e); process.exit(1); });
