// Runtime test: loads the real extension into Chromium with a mocked Yahoo backend and
// drives reading, folder switching, and compose/send. node tools/runtime.js
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXT = path.join(__dirname, "..", "ext");
const now = Math.floor(Date.now() / 1000);
const goneElsewhere = new Set();   // messages another device removed; list queries leave them out
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
  { id: "32", name: "Projects/FPGA", types: ["USER"], unread: 0, total: 3, highestModSeq: 14 },
  { id: "40", name: "Travel", types: ["USER"], unread: 0, total: 0, highestModSeq: 18 },
  { id: "41", name: "Travel/2025", types: ["USER"], unread: 0, total: 12, highestModSeq: 19 },
];
const accounts = [{ id: "1", email: "me@yahoo.com", sendingName: "Me Myself", isPrimary: true, isSending: true, type: "FREE", signature: "<i>sig</i>", signatureActive: true }];

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "baltazar-mail-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const calls = [], docCalls = [];
  let hiddenFetched = false;
  await ctx.route("https://ecp.yusercontent.com/**", route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64") }));
  await ctx.route("https://mail.yahoo.com/**", async route => {
    const req = route.request();
    if (req.url().includes("hidden-in-alt")) hiddenFetched = true;
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
      // One inline image in Yahoo's real part-thumbnail shape, which must be inlined, and one address
      // hidden in an alt attribute, which must never be requested.
      const inline = `<img src="https://cloud-apis.mail.yahoo.com/ws/v3/mailboxes/@.id==MB1/messages/@.id==${id}/content/parts/@.id==2/thumbnail&amp;appid=x&amp;pid=2">` +
        `<img alt="x src='https://mail.yahoo.com/ws/v3/hidden-in-alt'" src="https://ecp.yusercontent.com/p.png">`;
      responses = [{ id: top.id, httpCode: 200, response: { result: { message, simpleBody: { html: `<p>Body of <b>${id}</b></p>${inline}` } } } }];
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
    else { const q = decodeURIComponent(uri.split("q=")[1] || ""); const folder = (q.match(/folderId:(\d+)/) || [])[1] || "1"; const empty = /(^|[^-])folderId:(62|40)\b/.test(q); responses = [{ id: top.id, httpCode: 200, response: { result: { messages: empty ? [] : Array.from({ length: 8 }, (_, i) => msg(i + 1, folder)).filter(m => !goneElsewhere.has(m.id)), query: {} } } }]; }
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
  const cspViolations = [];
  const onConsole = m => {
    const t = m.text();
    // The sandboxed reader frame's request for Yahoo's image proxy cannot be intercepted by
    // Playwright, and this test machine has no internet; that one load failing is expected.
    if (/^https:\/\/ecp\.yusercontent\.com\//.test(m.location()?.url || "") && /ERR_TUNNEL|ERR_NAME|ERR_PROXY/.test(t)) return;
    if (/Content Security Policy|violates the following/.test(t)) cspViolations.push(t.slice(0, 220));
    else if (m.type() === "error" && !t.includes("net::ERR_FAILED")) errors.push("console: " + t.slice(0, 200));
  };
  page.on("console", onConsole);
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
  const frameImgs = await page.frameLocator("#r-body").locator("img").evaluateAll(els => els.map(e => e.getAttribute("src") || ""));
  results.inlineParts = { partInlined: /^data:image\/png/.test(frameImgs[0] || ""), proxyKept: frameImgs[1] === "https://ecp.yusercontent.com/p.png", hiddenFetched };
  results.originHeader = calls.find(c => c.name === "messages.getBody")?.origin;

  // Starred view: a cross-folder search for flagged mail, listed after Inbox
  await page.locator("#folder-list .folder", { hasText: "Starred" }).click(); await page.waitForTimeout(400);
  const starCall = calls.filter(c => c.name === "messageGroups.getList").pop();
  results.starredView = { q: decodeURIComponent(starCall?.envelope?.requests?.[0]?.uri.split("q=")[1] || ""), title: await page.locator("#list-title").textContent(),
    count: await page.locator("#folder-list .folder.view .ct").textContent(),
    countQuery: calls.some(c => /count%3A500|count:500/.test(c.envelope?.requests?.[0]?.uri || "") && /is%3Aflagged|is:flagged/.test(c.envelope?.requests?.[0]?.uri || "")),
    active: await page.locator("#folder-list .folder.active").textContent(), order: (await page.locator("#folder-list .folder .nm").allTextContents()).slice(0, 3).join(",") };
  await page.locator("#folder-list .folder", { hasText: "Projects" }).click(); await page.waitForTimeout(400);

  // search from a folder covers it and its subfolders; other folders are searched alongside
  const searchFrom = calls.length;
  await page.locator("#search").click(); await page.keyboard.type("Z80");
  results.search = { chip: await page.locator("#search-scope").textContent() };
  await page.keyboard.press("Enter");
  await page.waitForSelector("#rows .elsewhere", { timeout: 5000 });
  const qs = calls.slice(searchFrom).filter(c => c.name === "messageGroups.getList").map(c => decodeURIComponent(c.envelope.requests[0].uri.split("q=")[1]));
  // Spam and Trash are skipped everywhere except when they are the chosen folder
  results.search.inQ = qs.find(q => q.includes("folderId:(31 OR 32)") && q.includes("keyword:Z80") && !q.includes("folderType:(TRASH)")) || qs;
  results.search.outQ = !!qs.find(q => q.includes("-folderId:31 -folderId:32") && q.includes("keyword:Z80") && q.includes("-folderType:(TRASH)-folderType:(BULK)"));
  results.search.title = await page.locator("#list-title").textContent();
  results.search.divider = await page.locator("#rows .elsewhere span").textContent();
  results.search.elseRows = await page.locator("#rows .row.else").count();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "search-scope.png"), clip: { x: 0, y: 0, width: 760, height: 720 } }).catch(() => {});
  // the chip toggles to all mail; Escape returns to the folder
  await page.locator("#search-scope").click();
  results.search.offChip = await page.locator("#search-scope").textContent();
  const allFrom = calls.length;
  await page.keyboard.press("Enter"); await page.waitForTimeout(400);
  results.search.allQ = calls.slice(allFrom).filter(c => c.name === "messageGroups.getList").map(c => decodeURIComponent(c.envelope.requests[0].uri.split("q=")[1])).some(q => q.includes("keyword:Z80") && q.includes("-folderType:(TRASH)-folderType:(BULK)"));
  results.search.allTitle = await page.locator("#list-title").textContent();
  results.search.allDivider = await page.locator("#rows .elsewhere").count();
  // deleting from all-mail results drops the row, since those searches skip Trash
  const allRows = await page.locator("#rows .row").count();
  await page.locator("#rows .row").first().click(); await page.waitForTimeout(400);
  const delSubj = await page.locator("#r-subject").textContent();
  await page.locator('button[data-act="delete"]').click();
  await page.waitForFunction(n => document.querySelectorAll("#rows .row").length === n - 1, allRows, { timeout: 4000 }).catch(() => {});
  await page.waitForFunction(s => document.getElementById("r-subject").textContent !== s, delSubj, { timeout: 4000 }).catch(() => {});
  results.search.del = { rows: allRows - await page.locator("#rows .row").count(), reader: await page.locator("#r-subject").textContent(), was: delSubj, empty: await page.locator("#reader-empty").isVisible() };
  await page.locator("#search").focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  results.search.backTitle = await page.locator("#list-title").textContent();
  // search help: plain placeholder, ? opens a popover whose examples fill the box, Esc closes
  results.searchHelp = { placeholder: await page.locator("#search").getAttribute("placeholder"), tip: await page.locator("#search").getAttribute("title") };
  await page.locator("#search-help-btn").click();
  results.searchHelp.open = await page.locator("#search-help").isVisible();
  const popBox = await page.locator("#search-help").boundingBox(), sBox = await page.locator("#search-box").boundingBox();
  results.searchHelp.below = popBox.y >= sBox.y + sBox.height && popBox.x + popBox.width <= sBox.x + sBox.width + 1;
  await page.screenshot({ path: path.join(__dirname, "..", "out", "search-help.png"), clip: { x: 0, y: 0, width: 760, height: 440 } }).catch(() => {});
  await page.locator("#search-help code", { hasText: "invoice OR receipt" }).click();
  results.searchHelp.filled = await page.locator("#search").inputValue();
  results.searchHelp.focused = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.press("Escape");
  results.searchHelp.closed = await page.locator("#search-help").isHidden();
  results.searchHelp.keptText = await page.locator("#search").inputValue();
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);

  // compound query: words are ANDed through an id-filter request, NOT through a second one
  const andFrom = calls.length;
  await page.locator("#search").click(); await page.keyboard.type('"Budget" AND report -draft'); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("list-title").textContent.startsWith("“\"Budget\" AND report -draft”"), null, { timeout: 5000 });
  const aq = calls.slice(andFrom).filter(c => c.name === "messageGroups.getList").map(c => decodeURIComponent(c.envelope.requests[0].uri.split("q=")[1]));
  results.search.and = { tip: await page.locator("#list-title").getAttribute("title"), idVerify: aq.some(q => /id:\(MSG/.test(q) && /keyword:(report|Budget)/.test(q)),
    idExclude: aq.some(q => /id:\(MSG/.test(q) && q.includes("keyword:draft")), noNegKw: !aq.some(q => /-keyword/.test(q)), more: await page.locator("#more").isHidden() };
  await page.locator("#search").focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(400);

  // empty folders say so in the list; a parent that only groups subfolders says where the mail is
  await page.locator("#folder-list .folder", { hasText: "Archive" }).click();
  await page.waitForSelector("#rows .list-empty", { timeout: 5000 });
  results.empty = { archive: await page.locator("#rows .list-empty").innerText() };
  await page.locator("#folder-list .folder .nm", { hasText: /^Travel$/ }).click();
  await page.waitForFunction(() => /Travel\./.test(document.querySelector("#rows .list-empty")?.textContent || ""), null, { timeout: 5000 });
  results.empty.parent = await page.locator("#rows .list-empty").innerText();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "empty-folder.png"), clip: { x: 0, y: 0, width: 760, height: 400 } }).catch(() => {});
  await page.locator("#folder-list .folder", { hasText: "Projects" }).click(); await page.waitForTimeout(400);
  results.empty.gone = await page.locator("#rows .list-empty").count();

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
  const view = async i => { await page.locator("#r-attach .att-card").nth(i).click(); await page.waitForSelector("#viewer:not(.hidden)"); await page.waitForFunction(() => !document.getElementById("v-body").textContent.startsWith("Loading"), null, { timeout: 15000 }); };
  // Playwright's key press waits for the key-up to land in the focused frame, which a preview frame
  // replaced by that key never acknowledges; move with the › button, and test keys separately.
  const next = async name => { await page.locator("#v-next").click(); await page.waitForFunction(n => document.getElementById("v-name").textContent === n && !document.getElementById("v-body").textContent.startsWith("Loading"), name, { timeout: 15000 }); };
  // Previews render in the sandboxed render.html frame; find the live one.
  const box = async () => {
    for (let i = 0; i < 100; i++) { const f = page.frames().find(f => f.url().endsWith("/render.html") && !f.isDetached()); if (f) return f; await page.waitForTimeout(100); }
    throw new Error("no render frame");
  };
  const inBox = async fn => (await box()).evaluate(fn);
  await page.screenshot({ path: path.join(__dirname, "..", "out", "strip.png"), clip: { x: 700, y: 560, width: 580, height: 160 } }).catch(() => {});
  // PDF: PDF.js in the sandbox renders canvas pages with a selectable text layer; zoom buttons appear
  await view(0);
  let f = await box();
  await f.waitForFunction(() => document.querySelector(".pdfViewer .page canvas") && /Quarterly/.test(document.querySelector(".textLayer")?.textContent || ""), null, { timeout: 15000 });
  results.vSandbox = await f.evaluate(() => ({ origin: self.origin, cookies: (() => { try { return document.cookie; } catch { return "blocked"; } })(), chrome: typeof chrome !== "undefined" && !!chrome.runtime?.id }));
  results.vSandbox.fetch = await f.evaluate(async () => { try { await fetch("https://mail.yahoo.com/"); return "allowed"; } catch { return "blocked"; } });
  const scale0 = await f.evaluate(() => document.querySelector(".pdfViewer .page").getBoundingClientRect().width);
  await page.keyboard.press("+"); await page.waitForTimeout(400);
  const scale1 = await f.evaluate(() => document.querySelector(".pdfViewer .page").getBoundingClientRect().width);
  results.vPdf = { pages: await f.evaluate(() => document.querySelectorAll(".pdfViewer .page").length), zoomed: scale1 > scale0 * 1.1, zoomBar: await page.locator("#v-zoom").isVisible(), meta: await page.locator("#v-meta").textContent() };
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-pdf.png") }).catch(() => {});
  const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.locator("#v-dl").click();
  const d = await dl;
  results.vDownload = d ? d.suggestedFilename() + ":" + (fs.statSync(await d.path()).size === fs.statSync(path.join(FX, "report.pdf")).size) : "none";
  // keys pressed inside a preview are forwarded to the viewer
  await f.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await page.waitForFunction(() => document.getElementById("v-name").textContent === "data.csv" && !document.getElementById("v-body").textContent.startsWith("Loading"), null, { timeout: 15000 });
  results.vKeyForward = true; results.vCsv = await inBox(() => [...document.querySelectorAll("td")].map(t => t.textContent));
  results.vZoomHidden = await page.locator("#v-zoom").isHidden();
  await next("src.zip"); results.vZip = await inBox(() => [...document.querySelectorAll("td:first-child")].map(t => t.textContent));
  await next("photo.png"); results.vImg = await page.locator("#v-body img.v-img").count();
  await next("cv.docx");
  f = await box();
  await f.waitForFunction(() => /Jorge Ruiz/.test(document.body.textContent), null, { timeout: 8000 });
  results.vDoc = await f.evaluate(() => document.body.textContent);
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-docx.png") }).catch(() => {});
  await next("budget.xlsx");
  f = await box();
  results.vSheet = await f.evaluate(() => ({ cells: [...document.querySelectorAll(".grid td")].map(t => t.textContent), tabs: document.querySelectorAll(".tabs button").length }));
  await f.locator(".tabs button", { hasText: "Q2" }).click();
  results.vSheet2 = await f.evaluate(() => [...document.querySelectorAll(".grid td")].map(t => t.textContent));
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-xlsx.png") }).catch(() => {});
  await next("deck.pptx");
  f = await box();
  await f.waitForFunction(() => document.querySelectorAll(".page").length >= 3, null, { timeout: 8000 });
  await f.evaluate(() => document.querySelector(".more")?.scrollIntoView());
  await f.waitForFunction(() => document.querySelectorAll(".page").length === 5, null, { timeout: 8000 }).catch(() => {});
  const ppt = await f.evaluate(() => { const pages = [...document.querySelectorAll(".page")]; return { n: pages.length, html: pages.map(h => h.shadowRoot.innerHTML).join(""), text: pages.map(h => h.shadowRoot.textContent).join("|") }; });
  results.vSlides = { pages: ppt.n, text: ppt.text, clean: !/<script|javascript:/i.test(ppt.html), retried: docCalls.some(c => c.retryCount > 0), docId: docCalls[0]?.docId };
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-pptx.png") }).catch(() => {});
  results.rawFetches = rawCalls.filter(c => c.url.includes("rawplaintext")).length;
  results.rawOrigin = rawCalls[0]?.origin;
  await f.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitForSelector("#viewer.hidden", { state: "attached", timeout: 5000 }).catch(() => {});
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
  const before = calls.length, spamWas = await page.locator("#r-subject").textContent();
  await page.keyboard.press("!");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.includes("as spam"), null, { timeout: 4000 });
  const spamCall = calls.slice(before).find(c => c.name === "messages.move");
  results.spam = { was: spamWas, dest: spamCall?.envelope?.requests?.[0]?.payload?.message?.folder?.id, undo: await page.locator("#st-undo").textContent() };
  // the reader moves on to the row now under the cursor instead of going blank
  await page.waitForFunction(() => !document.getElementById("reader-head").classList.contains("hidden") &&
    (document.querySelector("#rows .row.sel .sb")?.textContent || "").startsWith(document.getElementById("r-subject").textContent), null, { timeout: 4000 }).catch(() => {});
  results.spam.next = { empty: await page.locator("#reader-empty").isVisible(), subject: await page.locator("#r-subject").textContent(), sel: await page.locator("#rows .row.sel .sb").textContent() };
  await page.keyboard.press("z");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.includes("Redo: mark"), null, { timeout: 4000 });
  // undo brings the spammed message back into the reader
  await page.waitForFunction(s => document.getElementById("r-subject").textContent === s, spamWas, { timeout: 4000 }).catch(() => {});
  results.spam.undone = { subject: await page.locator("#r-subject").textContent(), sel: await page.locator("#rows .row.sel .sb").textContent() };
  // another device deletes the open message: the next refresh shows its neighbour
  goneElsewhere.add(spamWas.replace(/^Subject (\d+)-(\d+)$/, "MSG$1_$2"));
  await page.locator("#list").focus(); await page.keyboard.press("R");
  await page.waitForFunction(s => document.getElementById("r-subject").textContent !== s && !document.getElementById("reader-head").classList.contains("hidden"), spamWas, { timeout: 4000 }).catch(() => {});
  results.spam.elsewhere = { empty: await page.locator("#reader-empty").isVisible(), subject: await page.locator("#r-subject").textContent(), sel: await page.locator("#rows .row.sel .sb").textContent() };
  goneElsewhere.clear();
  await page.locator("#list").focus(); await page.keyboard.press("R");
  await page.waitForFunction(() => document.querySelectorAll("#rows .row").length === 8, null, { timeout: 4000 });
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

  // address book: one summary line in Settings, the list on its own page
  await page.locator("#list").focus(); await page.keyboard.press(",");
  await page.waitForFunction(() => /addresses learned/.test(document.getElementById("ab-summary").textContent), null, { timeout: 5000 });
  const ab = { summary: await page.locator("#ab-summary").textContent(), mainHeight: (await page.locator("#settings-box").boundingBox()).height };
  const sb = await page.locator("#settings-box").boundingBox();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "settings.png"), clip: { x: sb.x, y: sb.y, width: sb.width, height: Math.min(sb.height, 330) } }).catch(() => {});
  const rowOf = async sel => { const s = await page.locator(sel).boundingBox(); return s; };
  const dk = await rowOf("#darkTheme"), dr = await rowOf('input[name=theme][value=dark]'), fontSel = await rowOf("#composeFont");
  ab.paletteInline = Math.abs((dk.y + dk.height / 2) - (dr.y + dr.height / 2)) < 4 && Math.abs((dk.x + dk.width) - (fontSel.x + fontSel.width)) < 2;
  await page.locator("#ab-open").click();
  await page.waitForSelector("#settings-ab:not(.hidden) .ab-item");
  ab.mainHidden = await page.locator("#settings-main").isHidden();
  ab.rows = await page.locator("#ab-list .ab-item").count();
  ab.focus = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.type("x.com");
  ab.filtered = await page.locator("#ab-list .ab-item").count();
  ab.bulkText = await page.locator("#ab-bulk").textContent();
  await page.locator("#ab-bulk").click();
  ab.hiddenCount = await page.locator("#ab-n-hidden").textContent();
  ab.offRows = await page.locator("#ab-list .ab-item.off").count();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "addressbook.png"), clip: { x: 340, y: 60, width: 600, height: 600 } }).catch(() => {});
  await page.locator(".ab-seg button[data-tab=hidden]").click();
  ab.hiddenTabBulk = await page.locator("#ab-bulk").textContent();
  await page.locator("#ab-list .ab-item .ab-eye").first().click();
  ab.afterEye = await page.locator("#ab-n-hidden").textContent();
  await page.keyboard.press("Escape");
  ab.filterCleared = await page.locator("#ab-filter").inputValue();
  await page.keyboard.press("Escape");
  ab.backOnMain = await page.locator("#settings-main").isVisible();
  ab.summaryAfter = await page.locator("#ab-summary").textContent();
  await page.keyboard.press("Escape");
  ab.closed = await page.locator("#settings").isHidden();
  results.ab = ab;
  results.cspViolations = cspViolations;
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
  expect(results.starCol.call.split(",")[0] === "messages.starFlagUpdate" && !results.starCol.call.includes("getBody") && results.starCol.on === 1, "star column toggles: " + JSON.stringify(results.starCol));
  expect(results.starredView.q.includes("is:flagged") && results.starredView.q.includes("-folderType:(TRASH)") && results.starredView.title === "Starred" && results.starredView.count === "8" && results.starredView.countQuery && results.starredView.active.includes("Starred") && results.starredView.order === "Inbox,Starred,Draft", "starred view: " + JSON.stringify(results.starredView));
  expect(results.search.chip === "in Projects" && typeof results.search.inQ === "string" && results.search.outQ && results.search.title === "“Z80” in Projects" && /8 matches in other folders/.test(results.search.divider) && results.search.elseRows === 8 &&
    results.search.offChip === "All mail" && results.search.allQ && results.search.allTitle === "“Z80” in all mail" && results.search.allDivider === 0 && results.search.del.rows === 1 && !results.search.del.empty && results.search.del.reader !== results.search.del.was && results.search.backTitle === "Projects" &&
    results.search.and.tip === "Searched for: Budget AND report AND NOT draft" && results.search.and.idVerify && results.search.and.idExclude && results.search.and.noNegKw && results.search.and.more, "scoped search: " + JSON.stringify(results.search));
  expect(results.searchHelp.placeholder === "Search" && results.searchHelp.tip === null && results.searchHelp.open && results.searchHelp.below && results.searchHelp.filled === "invoice OR receipt" &&
    results.searchHelp.focused === "search" && results.searchHelp.closed && results.searchHelp.keptText === "invoice OR receipt", "search help: " + JSON.stringify(results.searchHelp));
  expect(results.empty.archive === "No messages in Archive." && results.empty.parent === "No messages in Travel.\nIts 1 subfolder holds 12 messages." && results.empty.gone === 0, "empty folder: " + JSON.stringify(results.empty));
  {
    const ab = results.ab, hidN = Number(ab.hiddenCount);
    expect(/^\d+ addresses learned from Inbox and Sent/.test(ab.summary) && ab.mainHidden && ab.rows >= 5 && ab.focus === "ab-filter" && ab.paletteInline && ab.filtered >= 2 && ab.bulkText.startsWith("Hide ") &&
      hidN >= ab.filtered - 1 && ab.offRows === ab.filtered && /^Show (all )?\d+ again$/.test(ab.hiddenTabBulk) && Number(ab.afterEye) === hidN - 1 && ab.filterCleared === "" && ab.backOnMain &&
      new RegExp(`· ${hidN - 1} hidden from suggestions`).test(ab.summaryAfter) && ab.closed, "address book: " + JSON.stringify(ab));
  }
  expect(results.inlineParts.partInlined && results.inlineParts.proxyKept && !results.inlineParts.hiddenFetched, "inline images: " + JSON.stringify(results.inlineParts));
  expect(results.attach.cards === 7 && results.attach.thumbs === 1 && results.attach.stripBelowBody && results.attach.labels.join(",") === "PDF,CSV,ZIP,,DOC,XLS,PPT", "attachment strip: " + JSON.stringify(results.attach));
  expect(results.vCsv.join(",") === "Z80,2,6502,1" && results.vZip.includes("src/main.c") && results.vImg === 1 && results.vDoc.includes("Jorge Ruiz") && results.vPdf.pages === 2 && results.vPdf.zoomed && results.vPdf.zoomBar && /page 1 of 2/.test(results.vPdf.meta) && results.vZoomHidden && results.vClosed, "viewer: " + JSON.stringify([results.vCsv, results.vZip, results.vImg, results.vDoc, results.vPdf, results.vZoomHidden, results.vClosed]));
  expect(results.vSheet.cells.join(",") === "Item,Cost,Z80,2.5,6502,1.25" && results.vSheet.tabs === 2 && results.vSheet2.join(",") === "Item,Cost,68000,9", "spreadsheet: " + JSON.stringify([results.vSheet, results.vSheet2]));
  expect(results.vSlides.pages === 5 && results.vSlides.text.includes("Slide one") && results.vSlides.clean && results.vSlides.retried && results.vSlides.docId === "DOC8" && results.vKeyForward, "converter: " + JSON.stringify(results.vSlides));
  {
    const unexpected = (results.cspViolations || []).filter(v => !/https:\/\/mail\.yahoo\.com\//.test(v));
    expect(unexpected.length === 0, "content security policy blocked something the app needs: " + JSON.stringify(unexpected.slice(0, 5)));
  }
  expect(results.vSandbox.origin === "null" && results.vSandbox.cookies === "blocked" && results.vSandbox.chrome === false && results.vSandbox.fetch === "blocked", "sandbox isolation: " + JSON.stringify(results.vSandbox));
  expect(results.vDownload === "report.pdf:true" && results.rawFetches === 1 && !/^chrome-extension/.test(results.rawOrigin || ""), "bytes: " + JSON.stringify([results.vDownload, results.rawFetches, results.rawOrigin]));
  expect(results.card.head.includes("s2@x.com") && results.card.recent >= 1 && results.cardClosed, "contact card: " + JSON.stringify(results.card));
  expect(results.spam.dest === "6" && results.spam.undo.includes("as spam") && !results.spam.next.empty && results.spam.next.subject && results.spam.next.sel.startsWith(results.spam.next.subject) &&
    results.spam.undone.subject === results.spam.was && results.spam.undone.sel.startsWith(results.spam.was) &&
    !results.spam.elsewhere.empty && results.spam.elsewhere.subject === results.spam.next.subject && results.spam.elsewhere.sel.startsWith(results.spam.next.subject), "spam moves to Bulk: " + JSON.stringify(results.spam));
  // The original's 7 attachments go by reference; its inline image travels as an uploaded inline part.
  const refs = results.fwd.atts.filter(x => x.messageReference), inl = results.fwd.atts.filter(x => x.disposition === "inline");
  expect(results.fwdChips.length === 7 && refs.length === 7 && refs[0].messageReference?.pid === "2" && inl.length === 1 && results.fwd.uri.includes("uploadCount=1&totalAttachments=8") && results.fwd.inReplyTo.forwarded, "forward with attachments: " + JSON.stringify(results.fwd));
  expect(results.palette === 16, "16 text colours");
  expect(results.fontInitial[0] === "Helvetica" && results.fontInitial[1] === "13" && results.fontAfter[0] === "Georgia" && results.fontAfter[1] === "18", "font controls track caret: " + JSON.stringify([results.fontInitial, results.fontAfter]));
  expect(results.noListOnOpen && results.listOnClick && results.noListAfterPick, "address list only on click: " + JSON.stringify([results.noListOnOpen, results.listOnClick, results.noListAfterPick]));
  expect(results.print.url === "print.html" && results.print.body.startsWith("Body of"), "print page: " + JSON.stringify(results.print));
  expect(results.clickAway.composerHidden && results.clickAway.readerText.startsWith("Body of") && results.clickAway.draftSaved, "click-away saves draft and shows message: " + JSON.stringify(results.clickAway));
  if (errors.length) { console.error("FAILED:", errors); process.exit(1); }
  console.log("PASS");
})().catch(e => { console.error(e); process.exit(1); });
