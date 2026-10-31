// Runtime test: loads the real extension into Chromium with a mocked Yahoo backend and
// drives reading, folder switching, and compose/send. node tools/runtime.js
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXT = path.join(__dirname, "..", "ext");
const now = Math.floor(Date.now() / 1000);
const msg = (i, folder) => ({ id: `MSG${folder}_${i}`, conversationId: `C${i}`, modSeq: i, size: 1000, attachmentCount: i % 3 === 0 ? 1 : 0, csid: `csid${i}`,
  flags: { read: i % 2 === 0, flagged: false },
  headers: { subject: `Subject ${folder}-${i}`, from: [{ name: `Sender ${i}`, email: `s${i}@x.com` }], to: [{ name: "Me", email: "me@yahoo.com" }], cc: [{ name: "Other", email: "o@x.com" }], date: String(now - i * 40000) },
  folder: { id: folder, name: folder === "1" ? "Inbox" : "Other" }, snippet: "snip" });
const folders = [
  { id: "1", name: "Inbox", types: ["INBOX"], unread: 3, total: 10, highestModSeq: 10 },
  { id: "3", name: "Draft", types: ["DRAFT"], unread: 0, total: 1, highestModSeq: 11 },
  { id: "2", name: "Sent", types: ["SENT"], unread: 0, total: 8, highestModSeq: 11 },
  { id: "4", name: "Trash", types: ["TRASH"], unread: 0, total: 1, highestModSeq: 12 },
  { id: "62", name: "Archive", types: ["ARCHIVE"], unread: 0, total: 0, highestModSeq: 16 },
  { id: "6", name: "Bulk", types: ["BULK"], unread: 0, total: 2, highestModSeq: 17 },
  { id: "31", name: "Projects", types: ["USER"], unread: 0, total: 5, highestModSeq: 13 },
];
const accounts = [{ id: "1", email: "me@yahoo.com", sendingName: "Me Myself", isPrimary: true, isSending: true, type: "FREE", signature: "<i>sig</i>", signatureActive: true }];

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ymail-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const calls = [], docCalls = [];
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
    else if (uri.includes("/content/simplebody/full")) {
      const id = uri.match(/@\.id==(MSG[^/]+)/)[1];
      const message = msg(Number(id.split("_")[1]), id.split("_")[0].slice(3));
      message.attachments = [
        { partId: "2", filename: "report.pdf", size: 52000, disposition: "attachment", type: "application", subtype: "pdf", contentId: "<rep@x>", downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/pdf", textExtractionUrl: "https://cloud-apis.mail.yahoo.com/text/2?appid=x" },
        { partId: "3", filename: "data.csv", size: 900, disposition: "attachment", type: "text", subtype: "csv", downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/csv", textExtractionUrl: "https://cloud-apis.mail.yahoo.com/text/3?appid=x" },
        { partId: "4", filename: "src.zip", size: 400, disposition: "attachment", type: "application", subtype: "zip", downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/zip" },
        { partId: "5", filename: "photo.png", size: 70, disposition: "attachment", type: "image", subtype: "png", downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/png", thumbnailUrl: "https://cloud-apis.mail.yahoo.com/thumb/5?appid=x" },
        { partId: "6", filename: "cv.docx", size: 33000, disposition: "attachment", type: "application", subtype: "vnd.openxmlformats-officedocument.wordprocessingml.document", downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/docx", textExtractionUrl: "https://cloud-apis.mail.yahoo.com/text/6?appid=x" },
        { partId: "7", filename: "budget.xlsx", size: 17000, disposition: "attachment", type: "application", subtype: "vnd.openxmlformats-officedocument.spreadsheetml.sheet", downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/xlsx" },
        { partId: "8", filename: "deck.pptx", size: 90000, disposition: "attachment", type: "application", subtype: "vnd.openxmlformats-officedocument.presentationml.presentation", downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/pptx", documentId: "DOC8" },
      ];
      responses = [{ id: top.id, httpCode: 200, response: { result: { message, simpleBody: { html: `<p>Body of <b>${id}</b></p>` } } } }];
    }
    else if (uri === "/ws/docpreview/v2/fetch") {
      // Yahoo's converter: first ask is still queued, then pages arrive entity-encoded.
      docCalls.push({ docId: headers["docs-document-id"], ...top.payload });
      const enc = s => s.replace(/[<>"&=#;:/ ]/g, c => `&#${c.charCodeAt(0)};`);
      const pages = {};
      if (top.payload.retryCount > 0) for (let n = top.payload.start_page; n <= Math.min(5, top.payload.end_page); n++)
        pages["page" + n] = { html: enc(`<div class="aps-page"><p class="t">Slide ${n === 1 ? "one" : n}</p><script>bad()</script><a href="javascript:bad()">x</a></div>`), css: ".aps-page .t { font-size: 20pt; }", statuscode: 700, pdfEmbed: false };
      responses = [{ id: top.id, httpCode: 200, response: Object.keys(pages).length ? { code: 800, statuscode: 600, info: { num_pages: 5, dimension: { w: 900, h: 1400 } }, pages } : { code: 814, statuscode: 600, pages: {} } }];
    }
    else if (top.id === "SaveMessage") {
      const saved = { ...msg(99, "3"), id: "MSGDRAFT_99", immutableid: "IMM99", csid: top.payloadParts[0].payload.message.csid };
      responses = [{ id: "SaveMessage", httpCode: 200, response: { result: { message: saved, simpleBody: {} } } }];
      for (const r of top.requests || []) responses.push({ id: r.id, httpCode: 200, response: { result: { message: saved } } });
    }
    else if (/"method":"(POST|DELETE)"/.test(post)) responses = [...post.matchAll(/"id":"((?:UnifiedUpdateMessage|UnifiedDeleteMessage)_\d+)"/g)].map(m => ({ id: m[1], httpCode: 204 }));
    else { const q = decodeURIComponent(uri.split("q=")[1] || ""); const folder = (q.match(/folderId:(\d+)/) || [])[1] || "1"; responses = [{ id: top.id, httpCode: 200, response: { result: { messages: Array.from({ length: 8 }, (_, i) => msg(i + 1, folder)), query: {} } } }]; }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses, status: {} }, error: null }) });
  });

  // Raw message source holding the real attachment bytes, numbered as Yahoo numbers them.
  const FX = path.join(__dirname, "fixtures");
  const b64 = buf => buf.toString("base64").replace(/.{76}/g, "$&\r\n");
  const part = (type, name, buf) => `--BOUND\r\nContent-Type: ${type}; name="${name}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${name}"\r\n\r\n${b64(buf)}\r\n`;
  const rawFor = () => "From: s@x.com\r\nSubject: test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"BOUND\"\r\n\r\npreamble\r\n" +
    "--BOUND\r\nContent-Type: text/plain\r\n\r\nBody\r\n" +
    part("application/pdf", "report.pdf", fs.readFileSync(path.join(FX, "report.pdf"))) +
    part("text/csv", "data.csv", Buffer.from("name,qty\nZ80,2\n6502,1\n")) +
    part("application/zip", "src.zip", zipBytes) +
    part("image/png", "photo.png", thumbPng) +
    part("application/octet-stream", "cv.docx", fs.readFileSync(path.join(FX, "cv.docx"))) +
    part("application/octet-stream", "budget.xlsx", fs.readFileSync(path.join(FX, "budget.xlsx"))) +
    part("application/octet-stream", "deck.pptx", Buffer.from("not really a deck")) + "--BOUND--\r\n";
  const rawCalls = [];
  await ctx.route("https://apis.mail.yahoo.com/**", route => {
    const u = route.request().url();
    rawCalls.push({ url: u, origin: route.request().headers().origin });
    if (u.includes("/content/rawplaintext")) return route.fulfill({ contentType: "text/plain", body: rawFor() });
    return route.fulfill({ status: 404, body: "" });
  });
  let thumbFull = false;
  const thumbPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const zipBytes = Buffer.from("UEsDBBQAAAAAAI8CX12Tpho8uAEAALgBAAAKAAAAc3JjL21haW4uY2ludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KUEsDBBQAAAAAAI8CX10gMDo2BgAAAAYAAAAJAAAAUkVBRE1FLm1kaGVsbG8KUEsBAhQDFAAAAAAAjwJfXZOmGjy4AQAAuAEAAAoAAAAAAAAAAAAAAIABAAAAAHNyYy9tYWluLmNQSwECFAMUAAAAAACPAl9dIDA6NgYAAAAGAAAACQAAAAAAAAAAAAAAgAHgAQAAUkVBRE1FLm1kUEsFBgAAAAACAAIAbwAAAA0CAAAAAA==", "base64");
  await ctx.route("https://cloud-apis.mail.yahoo.com/**", route => {
    const u = route.request().url();
    // Yahoo's download links cannot be fetched (redirect the page cannot follow), as in production.
    if (u.includes("/dl/")) return route.abort("failed");
    if (u.includes("/text/3")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { textExtractResult: "name,qty\nZ80,2\n6502,1\n" } }) });
    if (u.includes("/text/2")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { textExtractResult: "Quarterly report\nPage 1" } }) });
    if (u.includes("/text/")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { textExtractResult: "Jorge Ruiz\nEngineer" } }) });
    if (u.includes("/thumb/") && u.includes("size=2048w")) thumbFull = true;
    return route.fulfill({ contentType: "image/png", body: thumbPng });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Content Security Policy") && !m.text().includes("net::ERR_FAILED")) errors.push("console: " + m.text().slice(0, 200)); });
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

  // Starred view: a cross-folder search for flagged mail, listed after Inbox
  await page.locator("#folder-list .folder", { hasText: "Starred" }).click(); await page.waitForTimeout(400);
  const starCall = calls.filter(c => c.name === "messageGroups.getList").pop();
  results.starredView = { q: decodeURIComponent(starCall?.envelope?.requests?.[0]?.uri.split("q=")[1] || ""), title: await page.locator("#list-title").textContent(),
    active: await page.locator("#folder-list .folder.active").textContent(), order: (await page.locator("#folder-list .folder .nm").allTextContents()).slice(0, 3).join(",") };
  await page.locator("#folder-list .folder", { hasText: "Projects" }).click(); await page.waitForTimeout(400);

  // star column: click toggles star without opening the message
  const starBefore = calls.length;
  await page.locator("#rows .row").nth(4).locator(".st").click();
  await page.waitForTimeout(400);
  await page.locator("#rows .row").nth(2).hover();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "starcol.png"), clip: { x: 235, y: 80, width: 465, height: 180 } }).catch(() => {});
  await page.screenshot({ path: path.join(__dirname, "..", "out", "listcols.png"), clip: { x: 235, y: 80, width: 300, height: 120 } }).catch(() => {});
  results.starCol = { call: calls.slice(starBefore).map(c => c.name).join(","), on: await page.locator("#rows .row").nth(4).locator(".st.on").count() };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);

  // attachment previews: two cards, PDF gets a thumbnail, CSV a type tile
  await page.waitForTimeout(500);
  results.attach = { cards: await page.locator("#r-attach .att-card").count(), thumbs: await page.locator("#r-attach .att-thumb img").count(), labels: await page.locator("#r-attach .att-thumb").allTextContents(),
    stripBelowBody: await page.evaluate(() => document.getElementById("r-attach").getBoundingClientRect().top >= document.getElementById("r-body").getBoundingClientRect().bottom - 1) };
  const view = async i => { await page.locator("#r-attach .att-card").nth(i).click(); await page.waitForSelector("#viewer:not(.hidden)"); await page.waitForFunction(() => !document.getElementById("v-body").textContent.startsWith("Loading"), null, { timeout: 5000 }); };
  const next = async name => { await page.keyboard.press("ArrowRight"); await page.waitForFunction(n => document.getElementById("v-name").textContent === n && !document.getElementById("v-body").textContent.startsWith("Loading"), name, { timeout: 8000 }); };
  const shadowText = sel => page.evaluate(s => [...document.querySelectorAll(s)].map(h => h.shadowRoot?.textContent || "").join("|"), sel);
  await page.screenshot({ path: path.join(__dirname, "..", "out", "strip.png"), clip: { x: 700, y: 560, width: 580, height: 160 } }).catch(() => {});
  // PDF: PDF.js renders canvas pages with a selectable text layer; zoom buttons appear
  await view(0);
  await page.waitForFunction(() => document.querySelector("#v-body .v-pdf .page canvas") && /Quarterly/.test(document.querySelector("#v-body .v-pdf .textLayer")?.textContent || ""), null, { timeout: 15000 });
  const scale0 = await page.evaluate(() => document.querySelector("#v-body .v-pdf .page").getBoundingClientRect().width);
  await page.keyboard.press("+"); await page.waitForTimeout(400);
  const scale1 = await page.evaluate(() => document.querySelector("#v-body .v-pdf .page").getBoundingClientRect().width);
  results.vPdf = { pages: await page.locator("#v-body .v-pdf .page").count(), zoomed: scale1 > scale0 * 1.1, zoomBar: await page.locator("#v-zoom").isVisible(), meta: await page.locator("#v-meta").textContent() };
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-pdf.png") }).catch(() => {});
  const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.locator("#v-dl").click();
  const d = await dl;
  results.vDownload = d ? d.suggestedFilename() + ":" + (fs.statSync(await d.path()).size === fs.statSync(path.join(FX, "report.pdf")).size) : "none";
  await next("data.csv"); results.vCsv = await page.locator("#v-body td").allTextContents();
  results.vZoomHidden = await page.locator("#v-zoom").isHidden();
  await next("src.zip"); results.vZip = await page.locator("#v-body td:first-child").allTextContents();
  await next("photo.png"); results.vImg = await page.locator("#v-body img.v-img").count();
  await next("cv.docx");
  await page.waitForFunction(() => /Jorge Ruiz/.test(document.querySelector("#v-body .v-doc")?.shadowRoot?.textContent || ""), null, { timeout: 8000 });
  results.vDoc = await shadowText("#v-body .v-doc");
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-docx.png") }).catch(() => {});
  await next("budget.xlsx");
  results.vSheet = { cells: await page.locator("#v-body .v-grid td").allTextContents(), tabs: await page.locator("#v-body .v-tabs button").count() };
  await page.locator("#v-body .v-tabs button", { hasText: "Q2" }).click();
  results.vSheet2 = await page.locator("#v-body .v-grid td").allTextContents();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-xlsx.png") }).catch(() => {});
  await next("deck.pptx");
  await page.waitForFunction(() => document.querySelectorAll("#v-body .v-page").length >= 3, null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector("#v-body .v-more")?.scrollIntoView());
  await page.waitForFunction(() => document.querySelectorAll("#v-body .v-page").length === 5, null, { timeout: 8000 }).catch(() => {});
  const pptHtml = await page.evaluate(() => [...document.querySelectorAll("#v-body .v-page")].map(h => h.shadowRoot.innerHTML).join(""));
  results.vSlides = { pages: await page.locator("#v-body .v-page").count(), text: await shadowText("#v-body .v-page"), clean: !/<script|javascript:/i.test(pptHtml), retried: docCalls.some(c => c.retryCount > 0), docId: docCalls[0]?.docId };
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-pptx.png") }).catch(() => {});
  results.rawFetches = rawCalls.filter(c => c.url.includes("rawplaintext")).length;
  results.rawOrigin = rawCalls[0]?.origin;
  await page.keyboard.press("Escape");
  results.vClosed = await page.locator("#viewer").isHidden();

  // contact card on hover over From
  await page.locator("#r-from .who").first().hover();
  await page.waitForSelector("#card:not(.hidden)", { timeout: 4000 });
  await page.waitForSelector("#card .card-recent div", { timeout: 4000 }).catch(() => {});
  await page.screenshot({ path: path.join(__dirname, "..", "out", "card.png") }).catch(() => {});
  results.card = { head: await page.locator("#card .card-head").textContent(), stats: await page.locator("#card .card-stats").textContent(), recent: await page.locator("#card .card-recent div").count() };
  await page.mouse.move(5, 600); await page.waitForTimeout(400);
  results.cardClosed = await page.locator("#card").isHidden();

  // spam: mark the open message as spam, check move to Bulk and undo label
  const before = calls.length;
  await page.keyboard.press("!");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.includes("as spam"), null, { timeout: 4000 });
  const spamCall = calls.slice(before).find(c => c.name === "messages.move");
  results.spam = { dest: spamCall?.envelope?.requests?.[0]?.payload?.message?.folder?.id, undo: await page.locator("#st-undo").textContent() };
  await page.keyboard.press("z");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.includes("Redo: mark"), null, { timeout: 4000 });
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);

  // print: opens print.html in a new tab with the open message
  const [printPage] = await Promise.all([ctx.waitForEvent("page"), page.keyboard.press("p")]);
  printPage.on("pageerror", e => errors.push("print pageerror: " + e.message));
  await printPage.waitForSelector(".msg .body", { timeout: 8000 });
  results.print = { url: printPage.url().split("/").pop().split("?")[0], subject: await printPage.locator(".hdr h1").textContent(), body: (await printPage.locator(".msg .body").innerText()).slice(0, 20), title: await printPage.title() };
  await printPage.close();
  await page.bringToFront();

  // forward: original's attachments carried by reference
  await page.keyboard.press("f"); await page.waitForSelector("#compose:not(.hidden)");
  results.fwdChips = await page.locator("#c-filelist .c-file").allTextContents();
  await page.locator("#c-to input").type("fwd@example.com"); await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 });
  const fwdCall = calls.filter(c => c.name === "messages.saveAndSend").pop();
  const fwdSave = fwdCall.envelope.requests[0];
  results.fwd = { uri: fwdSave.uri, atts: fwdSave.payloadParts[0].payload.message.attachments, inReplyTo: fwdSave.payloadParts[0].payload.message.inReplyTo };

  // reply: quote present, recipients right
  await page.keyboard.press("a"); await page.waitForSelector("#compose:not(.hidden)");
  const chips = async id => (await page.locator(`#${id} .chip`).allTextContents()).join(" | ");
  results.replyAll = { title: await page.locator("#c-title").textContent(), to: await chips("c-to"), cc: await chips("c-cc"), subject: await page.inputValue("#c-subject"), quoteHidden: await page.locator("#c-quote").isHidden() };
  // clicking another message while composing: composer closes (saved only if changed), message shows
  await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.type("partial reply");
  await page.locator("#rows .row").nth(3).click();
  await page.waitForFunction(() => document.getElementById("compose").classList.contains("hidden"));
  await page.waitForTimeout(600);
  results.clickAway = { composerHidden: await page.locator("#compose").isHidden(), readerText: (await frameText()).slice(0, 20), draftSaved: calls.some(c => c.name === "messages.saveV3") };

  // new message with attachment, send with 2 s hold, cancel, then send again
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("address book:"), null, { timeout: 15000 }).catch(() => {});
  results.addressBook = await page.locator("#st-msg").textContent();
  await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  results.noListOnOpen = await page.locator("#c-suggest").isHidden();
  await page.locator("#c-to input").click();
  results.listOnClick = await page.locator("#c-suggest:not(.hidden)").isVisible();
  await page.locator("#c-to input").type("Sen");
  await page.waitForSelector("#c-suggest:not(.hidden)", { timeout: 5000 });
  results.suggestions = await page.locator("#c-suggest div span").allTextContents();
  await page.locator("#c-suggest div").nth(1).hover();
  await page.locator("#c-suggest div").nth(1).locator(".hide").dispatchEvent("mousedown");
  await page.waitForTimeout(300);
  results.afterHide = await page.locator("#c-suggest div span").allTextContents();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  results.noListAfterPick = await page.locator("#c-suggest").isHidden();
  await page.locator("#c-to input").type("Alice <alice@example.com>, bob@example.com");
  await page.keyboard.press("Tab");
  results.toChips = await chips("c-to");
  await page.fill("#c-subject", "Runtime test");
  await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.type("Hello from the runtime test.");
  await page.setInputFiles("#c-files", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("attached text") });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  await page.locator("#c-editor").click({ position: { x: 200, y: 12 } });
  await page.setInputFiles("#c-imgfile", { name: "shot.png", mimeType: "image/png", buffer: png });
  await page.waitForSelector("#c-editor img");
  results.fontInitial = [await page.inputValue("#c-font"), await page.inputValue("#c-size")];
  await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.press("Shift+End");
  await page.selectOption("#c-font", "Georgia");
  await page.selectOption("#c-size", "18");
  await page.locator("#c-editor").click({ position: { x: 30, y: 14 } });
  await page.waitForTimeout(100);
  results.fontAfter = [await page.inputValue("#c-font"), await page.inputValue("#c-size")];
  await page.locator('[data-pal="fore"]').click(); await page.waitForSelector("#c-palette:not(.hidden)");
  results.palette = await page.locator("#c-palette .sw").count();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "palette.png"), clip: { x: 700, y: 150, width: 580, height: 260 } }).catch(() => {});
  await page.locator("#c-palette .sw").nth(3).click();
  results.editorImgs = await page.locator("#c-editor img").count();
  results.fileChip = await page.locator("#c-filelist").textContent();
  await page.locator("#c-editor").click({ position: { x: 60, y: 12 } }); await page.keyboard.press("Shift+Home");
  await page.screenshot({ path: path.join(__dirname, "..", "out", "compose.png") }).catch(() => {});
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Sending in"));
  results.pending = await page.locator("#st-undo").textContent();
  await page.keyboard.press("z");
  await page.waitForSelector("#compose:not(.hidden)");
  results.afterCancel = { title: await page.locator("#c-title").textContent(), to: await chips("c-to"), body: (await page.locator("#c-editor").innerText()).trim(), files: await page.locator("#c-filelist").textContent() };
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 8000 });
  const sendCall = calls.find(c => c.name === "messages.saveAndSend" && c.envelope.requests[0].payloadParts[0].payload.message.headers.subject === "Runtime test");
  const save = sendCall.envelope.requests[0];
  const payload = save.payloadParts[0].payload;
  results.sent = {
    uri: save.uri, parts: save.payloadParts.map(p => p.partName), fileParts: sendCall.fileParts,
    to: payload.message.headers.to, from: payload.message.headers.from, subject: payload.message.headers.subject, html: payload.simpleBody.html,
    attachments: payload.message.attachments, filters: save.filters, chain: (save.requests || []).map(r => [r.id, r.uri.replace(/@\.id==MB1/, "@.id==<mb>"), r.payload]),
    flags: payload.message.flags, newMessage: payload.message.newMessage, inlineFiles: sendCall.fileParts.filter(p => p[1].startsWith("inline-")),
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
  expect(!results.afterHide.some(s => s.includes("s2@x.com")) && results.afterHide.length >= results.suggestions.length - 1, "hidden address gone: " + results.afterHide.join(","));
  expect(/^<div style="font-family:[^"]+;font-size:13px">/.test(results.sent.html) && results.sent.html.replace(/<[^>]+>/g, "").startsWith("Hello from the runtime test.") && results.sent.html.includes("ymsig"), "default font wrapper, typed text above signature: " + results.sent.html);
  expect(results.sent.html.includes('src="cid:') && results.sent.attachments.some(a => a.disposition === "inline" && a.contentId) && results.sent.inlineFiles.length === 1 && results.sent.uri.includes("uploadCount=2&totalAttachments=2"), "inline image as cid attachment: " + results.sent.html + " " + JSON.stringify(results.sent.attachments) + " " + results.sent.uri);
  expect(results.sent.fileParts.some(p => p[1] === "note.txt") && results.sent.attachments.some(a => a.disposition === "attachment"), "attachment sent");
  expect(results.sent.chain.some(c => c[0] === "SendMessage"), "send chained");
  expect(results.starCol.call === "messages.starFlagUpdate" && results.starCol.on === 1, "star column toggles: " + JSON.stringify(results.starCol));
  expect(results.starredView.q.includes("is:flagged") && results.starredView.q.includes("-folderType:(TRASH)") && results.starredView.title === "Starred" && results.starredView.active.includes("Starred") && results.starredView.order === "Inbox,Starred,Draft", "starred view: " + JSON.stringify(results.starredView));
  expect(results.attach.cards === 7 && results.attach.thumbs === 1 && results.attach.stripBelowBody && results.attach.labels.join(",") === "PDF,CSV,ZIP,,DOC,XLS,PPT", "attachment strip: " + JSON.stringify(results.attach));
  expect(results.vCsv.join(",") === "Z80,2,6502,1" && results.vZip.includes("src/main.c") && results.vImg === 1 && results.vDoc.includes("Jorge Ruiz") && results.vPdf.pages === 2 && results.vPdf.zoomed && results.vPdf.zoomBar && /page 1 of 2/.test(results.vPdf.meta) && results.vZoomHidden && results.vClosed, "viewer: " + JSON.stringify([results.vCsv, results.vZip, results.vImg, results.vDoc, results.vPdf, results.vZoomHidden, results.vClosed]));
  expect(results.vSheet.cells.join(",") === "Item,Cost,Z80,2.5,6502,1.25" && results.vSheet.tabs === 2 && results.vSheet2.join(",") === "Item,Cost,68000,9", "spreadsheet: " + JSON.stringify([results.vSheet, results.vSheet2]));
  expect(results.vSlides.pages === 5 && results.vSlides.text.includes("Slide one") && results.vSlides.clean && results.vSlides.retried && results.vSlides.docId === "DOC8", "converter: " + JSON.stringify(results.vSlides));
  expect(results.vDownload === "report.pdf:true" && results.rawFetches === 1 && !/^chrome-extension/.test(results.rawOrigin || ""), "bytes: " + JSON.stringify([results.vDownload, results.rawFetches, results.rawOrigin]));
  expect(results.card.head.includes("s2@x.com") && results.card.recent >= 1 && results.cardClosed, "contact card: " + JSON.stringify(results.card));
  expect(results.spam.dest === "6" && results.spam.undo.includes("as spam"), "spam moves to Bulk: " + JSON.stringify(results.spam));
  expect(results.fwdChips.length === 7 && results.fwd.atts.length === 7 && results.fwd.atts[0].messageReference?.pid === "2" && results.fwd.uri.includes("uploadCount=0&totalAttachments=7") && results.fwd.inReplyTo.forwarded, "forward with attachments: " + JSON.stringify(results.fwd));
  expect(results.palette === 16, "16 text colours");
  expect(results.fontInitial[0] === "Helvetica" && results.fontInitial[1] === "13" && results.fontAfter[0] === "Georgia" && results.fontAfter[1] === "18", "font controls track caret: " + JSON.stringify([results.fontInitial, results.fontAfter]));
  expect(results.noListOnOpen && results.listOnClick && results.noListAfterPick, "address list only on click: " + JSON.stringify([results.noListOnOpen, results.listOnClick, results.noListAfterPick]));
  expect(results.print.url === "print.html" && results.print.body.startsWith("Body of"), "print page: " + JSON.stringify(results.print));
  expect(results.clickAway.composerHidden && results.clickAway.readerText.startsWith("Body of") && results.clickAway.draftSaved, "click-away saves draft and shows message: " + JSON.stringify(results.clickAway));
  if (errors.length) { console.error("FAILED:", errors); process.exit(1); }
  console.log("PASS");
})().catch(e => { console.error(e); process.exit(1); });
