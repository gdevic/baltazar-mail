// Smoke test for the extension UI with mocked chrome APIs and Yahoo endpoints.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "ext");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(ROOT, req.url.split("?")[0]));
  if (!p.startsWith(ROOT + path.sep) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});

const now = Math.floor(Date.now() / 1000);
const msg = (i, folder) => ({
  id: `MSG${i}`, conversationId: `C${i}`, modSeq: i, size: 1000, attachmentCount: i % 3 === 0 ? 1 : 0,
  flags: { read: i % 2 === 0, flagged: i % 5 === 0 },
  headers: { subject: i === 1 ? "Hit ^_Z80^_ here" : `Subject ${i}`, from: [{ name: `Sender ${i}`, email: `s${i}@x.com` }], to: [{ name: "Me", email: "me@yahoo.com" }], date: String(now - i * 40000) },
  folder: { id: folder, name: folder === "1" ? "Inbox" : "Other" }, snippet: "snip",
});
const folders = [
  { id: "1", name: "Inbox", types: ["INBOX"], unread: 3, total: 95, highestModSeq: 10 },
  { id: "2", name: "Sent", types: ["SENT"], unread: 0, total: 8, highestModSeq: 11 },
  { id: "4", name: "Trash", types: ["TRASH"], unread: 0, total: 1, highestModSeq: 12 },
  { id: "62", name: "Archive", types: ["ARCHIVE"], unread: 0, total: 0, highestModSeq: 16 },
  { id: "31", name: "Projects", types: ["USER"], unread: 0, total: 5, highestModSeq: 13 },
  { id: "32", name: "Projects/A-Z80", types: ["USER"], unread: 1, total: 7, highestModSeq: 14 },
  { id: "99", name: "Hidden", types: ["SYNC"], unread: 0, total: 0, highestModSeq: 15 },
];

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [], mutations = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.addInitScript(() => {
    const area = (ns) => ({
      get: async k => { const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) { const v = localStorage.getItem(ns + x); if (v !== null) o[x] = JSON.parse(v); } return o; },
      set: async o => { for (const [k, v] of Object.entries(o)) localStorage.setItem(ns + k, JSON.stringify(v)); } });
    window.chrome = { storage: { session: area("s:"), local: area("l:") }, runtime: { getURL: p => p, getManifest: () => ({ version: "0.14.0" }) } };
  });
  await page.route("https://mail.yahoo.com/**", async route => {
    const url = route.request().url();
    if (url === "https://mail.yahoo.com/") {
      return route.fulfill({ contentType: "text/html", body: '<html><script>window.AppBootstrapData={"appId":"YMailCLDNovation","mailWssid":"w1","primaryMailbox":{"email":"me@yahoo.com","id":"MB1"}}</script></html>' });
    }
    const name = new URL(url).searchParams.get("name");
    const body = route.request().postData() || "";
    const uriM = body.match(/"uri":"([^"]+)"/);
    const uri = uriM ? uriM[1].replace(/\\u0026/g, "&") : "";
    let result;
    if (uri.endsWith("/folders")) result = { folders, accounts: [{ id: "1", highestModSeq: 1 }] };
    else if (uri.includes("/content/simplebody/full")) result = { message: msg(1, "1"), simpleBody: { html: "<p>Hello <b>body</b><img src='https://x/y.png'></p>", attachments: [{ filename: "a.pdf", size: 2048, disposition: "attachment", downloadUrl: "https://cloud-apis.mail.yahoo.com/x" }] } };
    else {
      const q = decodeURIComponent(uri.split("q=")[1] || "");
      const folder = (q.match(/folderId:(\d+)/) || [])[1] || "1";
      const count = Number((q.match(/count:(\d+)/) || [])[1] || 100);
      const offset = Number((q.match(/offset:(\d+)/) || [])[1] || 0);
      const n = q.includes("keyword:") ? 5 : (folder === "1" ? 95 : 8);
      result = { messages: Array.from({ length: Math.max(0, Math.min(count, n - offset)) }, (_, i) => msg(offset + i + 1, folder)), query: { type: q.includes("keyword") ? "S" : "L", nextModSeq: 1 } };
    }
    if (!uri) errors.push("batch without uri: " + name);
    const reqs = (body.match(/"method":"(POST|DELETE)"/g) || []).length;
    const innerIds = [...body.matchAll(/"id":"((?:UnifiedUpdateMessage|UnifiedDeleteMessage)_\d+)"/g)].map(m => m[1]);
  const responses = reqs ? innerIds.map(id => ({ id, httpCode: 204, responseString: "" })).reverse() : [{ id: "x", httpCode: 200, response: { result } }];
    mutations.push(name + ":" + reqs);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses, status: { failedRequests: [], successRequests: [] } }, error: null }) });
  });
  await page.goto(`http://127.0.0.1:${port}/mail.html`);
  await page.waitForSelector("#rows .row");
  const rows = await page.locator("#rows .row").count();
  const foldersShown = await page.locator("#folders .folder").allTextContents();
  await page.keyboard.press("j"); await page.keyboard.press("j"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("r-subject").textContent.length > 0);
  const subject = await page.locator("#r-subject").textContent();
  const frameHtml = await page.frameLocator("#r-body").locator("body").innerHTML();
  await page.keyboard.press("/"); await page.keyboard.type("Z80"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("list-title").textContent.startsWith("“Z80” in Inbox"));
  const hit = await page.locator("#rows .row .sb mark").first().textContent();
  const scoped = { chip: await page.locator("#search-scope").textContent(), divider: await page.locator("#rows .elsewhere").count() };
  await page.keyboard.press("/"); await page.keyboard.press("Shift+Enter");
  await page.waitForFunction(() => document.getElementById("list-title").textContent.startsWith("“Z80” in all mail"));
  scoped.allChip = await page.locator("#search-scope").textContent();
  scoped.allDivider = await page.locator("#rows .elsewhere").count();
  await page.keyboard.press("g"); await page.keyboard.press("s");
  await page.waitForFunction(() => document.getElementById("list-title").textContent === "Sent");
  const sentRows = await page.locator("#rows .row").count();
  await page.keyboard.press("?");
  const helpVisible = await page.locator("#help").isVisible();
  // actions: go to inbox, select two rows with x, archive, undo; context menu; move picker
  await page.keyboard.press("Escape");
  await page.keyboard.press("g"); await page.keyboard.press("i");
  await page.waitForFunction(() => document.getElementById("list-title").textContent === "Inbox");
  await page.keyboard.press("j"); await page.keyboard.press("x"); await page.keyboard.press("j"); await page.keyboard.press("x");
  const selectedText = await page.locator("#list-count").textContent();
  await page.keyboard.press("e");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Undo"));
  const afterArchive = { rows: await page.locator("#rows .row").count(), undo: await page.locator("#st-undo").textContent() };
  await page.keyboard.press("z");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Redo") && document.querySelectorAll("#rows .row").length === 95);
  const afterUndo = { rows: await page.locator("#rows .row").count(), undo: await page.locator("#st-undo").textContent() };
  await page.locator("#rows .row").nth(3).click({ button: "right" });
  const ctxItems = await page.locator("#ctx div").allTextContents();
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  await page.waitForSelector("#movebox:not(.hidden)");
  await page.keyboard.type("Proj");
  const moveChoices = await page.locator("#move-list div").allTextContents();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.includes("Undo: move"));
  const afterMove = await page.locator("#st-undo").textContent();
  await page.keyboard.press("x"); await page.keyboard.press("j"); await page.keyboard.press("x");
  await page.locator("#rows .row").nth(6).click({ button: "right" });
  await page.screenshot({ path: path.join(__dirname, "..", "out", "actions.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("u");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.includes("Undo: mark"));
  const afterRead = await page.locator("#st-undo").textContent();
  console.log("actions", JSON.stringify({ selectedText, afterArchive, afterUndo, ctxItems, moveChoices, afterMove, afterRead, mutations }));
  const expect = (cond, what) => { if (!cond) errors.push("assert: " + what); };
  expect(scoped.chip === "in Inbox" && scoped.divider === 1 && scoped.allChip === "All mail" && scoped.allDivider === 0, "search scope: " + JSON.stringify(scoped));
  expect(selectedText.endsWith("2 selected"), "two selected");
  expect(afterArchive.rows === 93 && afterArchive.undo.startsWith("Undo: archive 2"), "archive removed two rows with undo label");
  expect(afterUndo.rows === 95, "undo restored rows");
  expect(ctxItems.length === 7 && ctxItems.includes("Spam"), "context menu items");
  expect(moveChoices[0] === "Projects", "move picker filter");
  expect(mutations.includes("messages.move:2") && mutations.includes("messages.readFlagUpdate:1"), "mutation calls");
  await page.keyboard.press(",");
  await page.click('input[name=layout][value=horizontal]');
  await page.click('input[name=theme][value=light]');
  await page.selectOption("#lightTheme", "solarizedLight");
  await page.click("#settings-close");
  const box = await page.locator("#split2").boundingBox();
  await page.mouse.move(box.x + 10, box.y + 2); await page.mouse.down(); await page.mouse.move(box.x + 10, box.y + 150, { steps: 5 }); await page.mouse.up();
  const b1 = await page.locator("#split1").boundingBox();
  await page.mouse.move(b1.x + 2, b1.y + 100); await page.mouse.down(); await page.mouse.move(b1.x + 80, b1.y + 100, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, "..", "out", "smoke.png") });
  await page.reload();
  await page.waitForSelector("#rows .row");
  const persisted = await page.evaluate(() => ({ layout: document.getElementById("app").className, theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg"),
    folderW: getComputedStyle(document.documentElement).getPropertyValue("--folder-w"), listH: getComputedStyle(document.documentElement).getPropertyValue("--list-h") }));
  console.log("persisted", JSON.stringify(persisted));
  console.log(JSON.stringify({ rows, foldersShown, subject, frameHtml: frameHtml.slice(0, 80), hit, sentRows, helpVisible, errors }, null, 1));
  await browser.close();
  server.close();
  const real = errors.filter(e => !e.includes("img-src 'none'") && !e.includes("ERR_TUNNEL_CONNECTION_FAILED") && !e.includes("net::ERR_"));
  if (real.length) { console.error("FAILED:", real); process.exit(1); }
  console.log("PASS");
})().catch(e => { console.error(e); process.exit(1); });
