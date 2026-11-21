// Runtime test: loads the real extension into Chromium with a mocked Yahoo backend and
// drives reading, folder switching, and compose/send. node tools/yahoo-runtime.js
const path = require("path");
const fs = require("fs");
const { launch, watchdog, viewerKey } = require("./harness");

(async () => {
  const h = await launch();
  watchdog(h, __filename);
  const { ctx, page, extId, profile, calls, docCalls, rawCalls, ghCalls, mock, folders, goneElsewhere, errors, cspViolations, unexpectedHosts, FX } = h;
  await page.goto(`chrome-extension://${extId}/mail.html`);
  const results0 = {};
  // rowH is the old pixel row height: 18 px (compact) becomes 80%, still 18 px rows
  // Let the first load's release check finish before reloading: cut off, it would count as failed
  // and the next check would wait an hour.
  await page.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.storage.local.get("updateCheck")).updateCheck; i++) await new Promise(r => setTimeout(r, 100)); });
  await page.evaluate(() => chrome.storage.local.set({ settings: { pollSec: 5, undoSendSec: 2, rowH: 18 } }));
  await page.reload();
  await page.waitForSelector("#rows .row", { timeout: 15000 });
  const rowPx = () => page.locator("#rows .row").first().evaluate(e => e.getBoundingClientRect().height);
  results0.rows = { legacy18: await rowPx(), field: await page.locator("#density").inputValue() };
  const frameText = async () => page.frameLocator("#r-body").locator("body").innerText({ timeout: 3000 }).catch(e => "FRAME-ERR");
  const results = { rows: results0.rows };
  // unread mail already there is shown in the title only; the tab icon stays plain
  results.tabIcon = await page.evaluate(() => ({ title: document.title, href: document.querySelector('link[rel="icon"]').href.split("/").slice(-2).join("/") }));

  // an action while a folder's first page is still loading must not leave that folder empty
  // (Shift+Z with nothing to redo goes through the same action path and changes no mail)
  mock.listDelay = 1200;
  await page.locator("#folder-list .folder", { hasText: "Sent" }).click(); await page.waitForTimeout(150);
  await page.locator("#list").focus(); await page.keyboard.press("Shift+Z");
  await page.waitForTimeout(3500);
  mock.listDelay = 0;
  results.slowLoad = { rows: await page.locator("#rows .row").count(), title: await page.locator("#list-title").textContent().catch(() => "") };
  await page.locator("#folder-list .folder", { hasText: "Inbox" }).click(); await page.waitForSelector("#rows .row");
  await page.waitForTimeout(300);

  // reading across folders
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(600);
  await page.locator("#folder-list .folder", { hasText: "Projects" }).click(); await page.waitForTimeout(400);
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  results.readAfterSwitch = (await frameText()).slice(0, 30);
  // the reader's cleaning: no script, forms, frames, objects, refresh or event handlers survive,
  // and links open in a new tab without pings
  results.unsafe = await page.frameLocator("#r-body").locator("body").evaluate(b => {
    const d = b.ownerDocument;
    const handlers = [...d.querySelectorAll("*")].flatMap(e => [...e.attributes].filter(a => /^on/i.test(a.name)).map(a => `${e.tagName}.${a.name}`));
    const link = d.getElementById("h-link");
    return { scripts: d.querySelectorAll("script").length, forms: d.querySelectorAll("form, input, button, textarea, select").length,
      frames: d.querySelectorAll("iframe, object, embed").length, refresh: d.querySelectorAll('meta[http-equiv="refresh" i]').length, csp: d.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length, handlers,
      link: link && { ping: link.hasAttribute("ping"), target: link.target, rel: link.rel }, img: !!d.getElementById("h-img"),
      others: ["h-area", "h-svga"].map(id => d.getElementById(id)?.getAttribute("target") ?? "gone") };
  }).catch(e => ({ error: e.message }));
  results.unsafe.pwned = await page.evaluate(() => window.pwned ?? null);
  const frameImgs = await page.frameLocator("#r-body").locator("img").evaluateAll(els => els.map(e => e.getAttribute("src") || ""));
  results.inlineParts = { partInlined: /^data:image\/png/.test(frameImgs[0] || ""), fromSource: /^data:image\/png/.test(frameImgs[1] || ""), proxyKept: frameImgs[2] === "https://ecp.yusercontent.com/p.png", hiddenFetched: mock.hiddenFetched,
    clips: await page.locator("#rows .row .fl").evaluateAll(els => els.map(e => e.innerHTML ? 1 : 0).join("")),
    spacerHeight: await page.frameLocator("#r-body").locator("#spacer").evaluate(e => e.getBoundingClientRect().height) };
  results.originHeader = calls.find(c => c.name === "messages.getBody")?.origin;
  // keys pressed while the message has focus reach the app; scroll keys stay with the message
  const selIndex = () => page.locator("#rows .row").evaluateAll(rs => rs.findIndex(r => r.classList.contains("sel")));
  await page.frameLocator("#r-body").locator("body").click({ position: { x: 5, y: 5 } });
  const frameKeys = { focus: await page.evaluate(() => document.activeElement.id), before: await selIndex() };
  await page.keyboard.press("PageDown"); await page.waitForTimeout(200); frameKeys.pageDown = await selIndex();
  await page.keyboard.press("k"); await page.waitForTimeout(600); frameKeys.k = await selIndex();
  results.frameKeys = frameKeys;

  // dark theme: the reader darkens declared colours; the sun/moon button shows the original, dimmed
  const paper = () => page.frameLocator("#r-body").locator("#paper").evaluate(e => ({ bg: getComputedStyle(e).backgroundColor, fg: getComputedStyle(e).color, filter: getComputedStyle(e.ownerDocument.documentElement).filter }));
  const theme = async v => { await page.locator("#list").focus(); await page.keyboard.press(","); await page.locator(`input[name="theme"][value="${v}"]`).check(); await page.locator("#settings-close").click(); await page.waitForTimeout(400); };
  results.darkReader = { lightButton: await page.locator("#r-dark").isVisible() };
  await theme("dark");
  results.colorScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  results.keepTab = await page.evaluate(async () => (await chrome.tabs.getCurrent()).autoDiscardable);
  results.darkReader.button = await page.locator("#r-dark").isVisible() ? await page.locator("#r-dark").textContent() : "hidden";
  results.darkReader.dark = await paper();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "reader-dark.png") }).catch(() => {});
  await page.locator("#r-dark").click(); await page.waitForTimeout(300);
  results.darkReader.original = { ...await paper(), button: await page.locator("#r-dark").textContent(), saved: await page.evaluate(async () => (await chrome.storage.local.get("settings")).settings.readerOriginal) };
  await page.locator("#rows .row").nth(2).click(); await page.waitForTimeout(600);
  results.darkReader.nextMessage = await paper();
  await page.locator("#r-dark").click(); await page.waitForTimeout(300);
  results.darkReader.again = await paper();
  await theme("light");
  results.darkReader.light = { ...await paper(), button: await page.locator("#r-dark").isVisible() };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);

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
  results.starCol = { call: calls.slice(starBefore).map(c => c.name).filter(n => n !== "mailbox.sync").join(","), on: await page.locator("#rows .row").nth(4).locator(".st.on").count() };
  // an entry Yahoo lists without a download link stays out of the strip
  let ghosts = 0;
  mock.patchBody = (id, message) => { ghosts++; message.attachments.push({ partId: "9", filename: "ghost.bin", size: 10, disposition: "attachment", type: "application", subtype: "octet-stream" }); };
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);
  mock.patchBody = null;

  // attachment previews: two cards, PDF gets a thumbnail, CSV a type tile
  await page.waitForTimeout(500);
  results.attach = { ghosts, ghostCards: await page.locator("#r-attach .att-card", { hasText: "ghost.bin" }).count(), cards: await page.locator("#r-attach .att-card").count(), thumbs: await page.locator("#r-attach .att-thumb img").count(), labels: await page.locator("#r-attach .att-thumb").allTextContents(),
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
  results.vSandbox.fetch = await f.evaluate(async () => { try { await fetch("https://mail.yahoo.com/probe-sandbox"); return "allowed"; } catch { return "blocked"; } });
  // CORS alone would refuse the answer, so what counts is that the request never left the sandbox
  results.vSandbox.reached = mock.probes.some(p => p.url.includes("/probe-sandbox"));
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
  // tables and text in the sandboxed renderer use the same monospace stack as the app
  results.vMono = await inBox(() => getComputedStyle(document.querySelector("table")).fontFamily);
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
  const ppt = await f.evaluate(() => { const pages = [...document.querySelectorAll(".page")]; return { n: pages.length, html: pages.map(h => h.shadowRoot.innerHTML).join(""), text: pages.map(h => h.shadowRoot.querySelector(".aps-page")?.textContent).join("|"),
    escaped: pages.some(h => h.shadowRoot.querySelector("#css-escape")), styled: getComputedStyle(pages[0].shadowRoot.querySelector(".t")).fontSize }; });
  results.vSlides = { pages: ppt.n, text: ppt.text, escaped: ppt.escaped, styled: ppt.styled, clean: !/<script|javascript:/i.test(ppt.html), retried: docCalls.some(c => c.retryCount > 0), docId: docCalls[0]?.docId };
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-pptx.png") }).catch(() => {});
  // each message's source is fetched once, shared by its attachments and inline images
  const rawIds = rawCalls.filter(c => c.url.includes("rawplaintext")).map(c => c.url.match(/messages\/@\.id==([^/]+)/)[1]);
  results.rawFetches = Math.max(...Object.values(rawIds.reduce((n, id) => (n[id] = (n[id] || 0) + 1, n), {})));
  results.rawOrigin = rawCalls[0]?.origin;

  // a file nothing can preview: offered as text when its bytes look like text, else as a hex dump
  mock.convFail = true;
  await page.locator("#v-prev").click();
  await page.waitForFunction(() => document.getElementById("v-name").textContent === "budget.xlsx" && !document.getElementById("v-body").textContent.startsWith("Loading"), null, { timeout: 15000 });
  await next("deck.pptx");
  await page.waitForSelector("#v-raw", { timeout: 15000 });
  results.vRaw = { textLabel: await page.locator("#v-raw").textContent() };
  await page.locator("#v-raw").click();
  f = await box(); await f.waitForFunction(() => document.querySelector("pre"), null, { timeout: 5000 }).catch(() => {});
  results.vRaw.text = await f.evaluate(() => document.querySelector("pre")?.textContent || "");
  results.vRaw.textMeta = await page.locator("#v-meta").textContent();
  await f.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitForSelector("#viewer.hidden", { state: "attached", timeout: 5000 }).catch(() => {});
  results.vClosed = await page.locator("#viewer").isHidden();
  // another message whose deck is binary: the hex viewer
  mock.deckBinary = true;   // a row no earlier step opened, so its source is fetched fresh
  await page.locator("#rows .row").nth(3).click(); await page.waitForTimeout(600);
  await view(6);
  await page.waitForSelector("#v-raw", { timeout: 15000 });
  results.vRaw.binLabel = await page.locator("#v-raw").textContent();
  await page.locator("#v-raw").click();
  f = await box(); await f.waitForFunction(() => document.querySelector("pre.hex"), null, { timeout: 5000 }).catch(() => {});
  results.vRaw.hex = await f.evaluate(() => ({ dump: document.querySelector("pre.hex")?.textContent || "", note: document.querySelector(".note")?.textContent || "" }));
  await page.screenshot({ path: path.join(__dirname, "..", "out", "viewer-hex.png") }).catch(() => {});
  await f.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitForSelector("#viewer.hidden", { state: "attached", timeout: 5000 }).catch(() => {});
  mock.convFail = mock.deckBinary = false;
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);

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
  // a failed action says so in a notice, in words first, with a report to copy; × dismisses it
  const rowsBefore = await page.locator("#rows .row").count();
  mock.failMoves = 1;
  await page.locator("#list").focus(); await page.keyboard.press("e");
  await page.waitForSelector("#notice:not(.hidden)", { timeout: 4000 }).catch(() => {});
  results.failedMove = { text: await page.locator("#notice-text").textContent(), tech: await page.locator("#notice-text .tech").textContent().catch(() => ""),
    copy: await page.locator("#notice-copy").isVisible(), rowsKept: (await page.locator("#rows .row").count()) === rowsBefore };
  await page.locator("#notice-close").click();
  results.failedMove.dismissed = await page.locator("#notice").isHidden();
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
  results.print = { url: printPage.url().split("/").pop().split("?")[0], subject: await printPage.locator(".hdr h1").textContent(), body: (await printPage.locator(".msg .body p").first().innerText()).slice(0, 20), title: await printPage.title(),
    // the message's style sheet and its fixed box stay inside the body: the header shows, uncovered
    header: await printPage.evaluate(() => { const h = document.querySelector(".hdr h1"), r = h.getBoundingClientRect(); return { visible: r.height > 0, onTop: document.elementFromPoint(r.left + 5, r.top + r.height / 2) === h }; }),
    remote: await printPage.evaluate(() => [...document.querySelector(".msg .body").shadowRoot.querySelectorAll("img")].map(i => i.getAttribute("src").slice(0, 30)).filter(s => !s.startsWith("data:"))) };
  await printPage.close();
  await page.bringToFront();

  // printing more than session storage holds says so instead of hanging at "preparing..."
  await page.evaluate(() => { const s = chrome.storage.session; s.realSet = s.set; s.set = async () => { throw new Error("QUOTA_BYTES quota exceeded"); }; });
  await page.locator("#list").focus(); await page.keyboard.press("p");
  await page.waitForSelector("#notice:not(.hidden)", { timeout: 4000 }).catch(() => {});
  results.printQuota = await page.locator("#notice-text").textContent().catch(() => "");
  await page.evaluate(() => { const s = chrome.storage.session; s.set = s.realSet; delete s.realSet; });
  await page.locator("#notice-close").click().catch(() => {});

  // a message in Spam: printing and replying leave its remote images out, as the reader does
  {
    const back = (await page.locator("#folder-list .folder.active .nm").textContent()).trim();
    await page.locator("#folder-list .folder", { hasText: "Spam" }).first().click(); await page.waitForTimeout(700);
    await page.locator("#rows .row").first().click(); await page.waitForTimeout(700);
    const [spamPrint] = await Promise.all([ctx.waitForEvent("page"), page.keyboard.press("p")]);
    await spamPrint.waitForSelector(".msg .body", { timeout: 8000 });
    const imgs = await spamPrint.evaluate(() => [...document.querySelector(".msg .body").shadowRoot.querySelectorAll("img")].map(i => (i.getAttribute("src") || "").slice(0, 30)));
    await spamPrint.close(); await page.bringToFront();
    await page.locator("#list").focus(); await page.keyboard.press("r"); await page.waitForSelector("#compose:not(.hidden)");
    // the quote is in the editor; any image it has that could load is held back
    const quoteLive = await page.locator("#c-editor").evaluate(ed => [...ed.querySelectorAll("img[src]")].map(i => i.getAttribute("src")).filter(s => !/^(data:|cid:)/.test(s)));
    await page.keyboard.press("Escape"); await page.waitForSelector("#compose", { state: "hidden" }).catch(() => {});
    results.spamImages = { printImgs: imgs, quoteLive };
    await page.locator("#folder-list .folder", { hasText: back }).first().click(); await page.waitForTimeout(700);
    await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(500);
  }

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

  // a message that cannot be saved is never thrown away: Escape and clicking another message
  // leave the composer open with the reason in a notice, until the save succeeds
  const saves = () => calls.filter(c => c.name === "messages.saveV3").length;
  const composerOpen = () => page.locator("#compose").isVisible();
  const stMsg = () => page.locator("#st-msg").textContent();
  const notice = async () => (await page.locator("#notice").isVisible()) ? await page.locator("#notice-text").textContent() : "";
  await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  await page.locator("#c-to input").type("john");
  await page.fill("#c-subject", "Keep me");
  await page.locator("#c-editor").click(); await page.keyboard.type("do not lose this");
  const savesBefore = saves();
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  const badAddress = { open: await composerOpen(), notice: await notice(), saved: saves() > savesBefore };
  await page.locator("#rows .row").nth(2).click(); await page.waitForTimeout(400);
  const clickAwayBad = { open: await composerOpen(), notice: await notice() };
  // the rest needs the composer; with it already gone the assertions below report the loss
  let serverError = {};
  if (clickAwayBad.open) {
    await page.locator("#c-to input").fill("keep@example.com"); await page.locator("#c-to input").press("Enter");
    mock.failSaves = 1;
    await page.locator("#c-editor").click(); await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    serverError = { open: await composerOpen(), notice: await notice(), copy: await page.locator("#notice-copy").isVisible(), body: await page.locator("#c-editor").innerText() };
    await page.locator("#c-editor").click(); await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("compose").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
  }
  const lastSave = calls.filter(c => c.name === "messages.saveV3").pop();
  const savedMsg = lastSave?.envelope?.requests?.[0]?.payloadParts?.[0]?.payload?.message;
  results.keepUnsaved = { badAddress, clickAwayBad, serverError, closed: !(await composerOpen()), status: await stMsg(), noticeAfter: await notice(), savedSubject: savedMsg?.headers?.subject };
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
  // a different file with the same name, and one named like an inline image part
  await page.setInputFiles("#c-files", [{ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("another, longer note") }, { name: "inline-1.png", mimeType: "image/png", buffer: Buffer.from("not really") }]);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  await page.locator("#c-editor").click({ position: { x: 200, y: 12 } });
  await page.setInputFiles("#c-imgfile", { name: "shot.png", mimeType: "image/png", buffer: png });
  await page.waitForSelector("#c-editor img");
  results.fontInitial = [await page.locator("#c-font").evaluate(s => s.selectedOptions[0]?.textContent), await page.inputValue("#c-size")];
  await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.press("Shift+End");
  await page.selectOption("#c-font", "Georgia");
  await page.selectOption("#c-size", "18");
  await page.locator("#c-editor").click({ position: { x: 30, y: 14 } });
  await page.waitForTimeout(100);
  results.fontAfter = [await page.locator("#c-font").evaluate(s => s.selectedOptions[0]?.textContent), await page.inputValue("#c-size")];
  await page.locator('[data-pal="fore"]').click(); await page.waitForSelector("#c-palette:not(.hidden)");
  results.palette = await page.locator("#c-palette .sw").count();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "palette.png"), clip: { x: 700, y: 150, width: 580, height: 300 } }).catch(() => {});
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

  // pictures in the message: a clicked one gets a size bar and a corner handle, Escape lets it go
  // and keeps the composer open, Delete goes through the editor's undo; a picture made smaller is
  // sent whole, or at twice its shown width when Settings › Writing says to send it at that size
  {
    const pictures = {};
    // random pixels, so a smaller copy is also a smaller file
    const noise = Buffer.from(await page.evaluate(() => {
      const c = document.createElement("canvas"); c.width = 800; c.height = 600;
      const g = c.getContext("2d"), d = g.createImageData(800, 600);
      for (let i = 0; i < d.data.length; i++) d.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
      g.putImageData(d, 0, 0);
      return c.toDataURL("image/png").split(",")[1];
    }), "base64");
    const newWithPicture = async () => {
      await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
      await page.locator("#c-editor").focus();
      await page.setInputFiles("#c-imgfile", { name: "noise.png", mimeType: "image/png", buffer: noise });
      await page.waitForFunction(() => document.querySelector("#c-editor img")?.naturalWidth === 800);
    };
    const img = page.locator("#c-editor img");
    await newWithPicture();
    await img.click();
    pictures.shown = { bar: await page.locator("#c-imgbar").isVisible(), handle: await page.locator("#c-imghandle").isVisible(), size: await page.locator("#c-imgsize").textContent(),
      originalOn: await page.locator('#c-imgbar button[data-w="0"]').evaluate(b => b.classList.contains("on")) };
    await page.locator('#c-imgbar button[data-w="400"]').click();
    pictures.medium = [...await img.evaluate(i => [i.getAttribute("width"), i.getAttribute("height"), i.style.width]), await page.locator("#c-imgsize").textContent()];
    const zoom = await page.locator("#c-editor").evaluate(e => Number(e.style.zoom) || 1);
    const h = await page.locator("#c-imghandle").boundingBox(), hx = h.x + h.width / 2, hy = h.y + h.height / 2;
    await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(hx - 100, hy, { steps: 5 }); await page.mouse.up();
    pictures.dragged = { width: Number(await img.getAttribute("width")), want: Math.round(400 - 100 / zoom) };
    const frame = await page.locator("#c-imgframe").boundingBox(), box = await img.boundingBox();
    pictures.frameFollows = Math.abs(frame.width - box.width) < 1.5 && Math.abs(frame.x - box.x) < 1.5 && Math.abs(frame.y - box.y) < 1.5;
    await page.keyboard.press("Escape");
    pictures.escape = { bar: await page.locator("#c-imgbar").isVisible(), composer: await page.locator("#compose").isVisible() };
    await img.click(); await page.locator("#c-imgdel").click();
    pictures.deleted = await img.count();
    await page.keyboard.press("Control+z");
    pictures.undone = await img.count();
    // the signature makes it a message, so discarding it asks first
    page.once("dialog", d => d.accept());
    await page.click("#c-discard"); await page.waitForSelector("#compose", { state: "hidden" }).catch(() => {});
    const sendPicture = async subject => {
      await newWithPicture();
      await page.fill("#c-subject", subject);
      await page.locator("#c-to input").type("q@example.com"); await page.keyboard.press("Enter");
      await img.click(); await page.locator('#c-imgbar button[data-w="200"]').click();
      await page.locator("#c-editor").focus(); await page.keyboard.press("Control+Enter");
      const sent = () => calls.find(c => c.name === "messages.saveAndSend" && c.envelope.requests[0].payloadParts[0].payload.message.headers.subject === subject);
      for (let i = 0; i < 100 && !sent(); i++) await page.waitForTimeout(100);
      const c = sent();
      return c && { widths: Object.entries(c.pngWidths).filter(([n]) => n.startsWith("inline-")).map(([, w]) => w), html: /<img [^>]*width="200"[^>]*>/.test(c.envelope.requests[0].payloadParts[0].payload.simpleBody.html) };
    };
    const setScaled = async v => { await page.locator("#list").focus(); await page.keyboard.press(","); await page.locator(`input[name="scaledImages"][value="${v}"]`).check(); await page.click("#settings-close"); };
    pictures.whole = await sendPicture("Picture whole");
    await setScaled("shrink");
    pictures.smaller = await sendPicture("Picture smaller");
    await setScaled("full");
    results.pictures = pictures;
  }

  // two sends inside the undo window keep their own timers and z takes back only the newest; a
  // send that fails while another message is open saves that one before reopening; leaving the
  // tab with a send pending asks first
  const setUndoSend = async secs => {
    await page.locator("#list").focus(); await page.keyboard.press(",");
    await page.locator("#undosend").fill(String(secs)); await page.locator("#undosend").dispatchEvent("change");
    await page.click("#settings-close");
  };
  const sendOne = async subject => {
    await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
    await page.locator("#c-to input").type("q@example.com"); await page.keyboard.press("Enter");
    await page.fill("#c-subject", subject);
    // focus the editor itself and check the text arrived: a click right after the composer opens
    // can land before the layout settles
    await page.locator("#c-editor").focus(); await page.keyboard.type(`${subject} text`);
    await page.waitForFunction(s => document.getElementById("c-editor").innerText.includes(s), `${subject} text`, { timeout: 3000 }).catch(() => {});
    await page.keyboard.press("Control+Enter");
    // held for undo, or with no hold sent at once
    await page.waitForFunction(s => document.getElementById("st-undo").textContent.includes(s) || document.getElementById("st-msg").textContent.startsWith(`sent: "${s}"`), subject, { timeout: 5000 }).catch(() => {});
  };
  const subjectsSent = () => calls.filter(c => c.name === "messages.saveAndSend").map(c => c.envelope.requests[0].payloadParts[0].payload.message.headers.subject);
  const subjectsSaved = () => calls.filter(c => c.name === "messages.saveV3").map(c => c.envelope.requests[0].payloadParts[0].payload.message.headers.subject);
  await setUndoSend(10);   // room to write the second message before the first goes out
  await sendOne("Queue A"); await sendOne("Queue B");
  const queue = { pending: await page.locator("#st-undo").textContent() };
  queue.leaveAsks = await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  await page.locator("#list").focus(); await page.keyboard.press("z");
  await page.waitForSelector("#compose:not(.hidden)");
  queue.reopened = await page.inputValue("#c-subject");
  queue.stillPending = await page.locator("#st-undo").textContent();
  mock.failSends = 1;
  await page.waitForFunction(() => document.getElementById("c-subject").value === "Queue A", null, { timeout: 15000 }).catch(() => {});
  queue.afterFail = { subject: await page.inputValue("#c-subject"), notice: await notice(), savedB: subjectsSaved().includes("Queue B"), sentB: subjectsSent().includes("Queue B") };
  page.once("dialog", d => d.accept());
  await page.click("#c-discard"); await page.waitForTimeout(300);
  queue.leaveQuiet = await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return !e.defaultPrevented; });
  results.sendQueue = queue;
  // mail that arrives in the folder refresh right after a send still shows: polling is held
  // off (10 minutes) so only the send can notice it
  {
    const setPoll = async secs => { await page.locator("#list").focus(); await page.keyboard.press(","); await page.locator("#poll").fill(String(secs)); await page.locator("#poll").dispatchEvent("change"); await page.click("#settings-close"); };
    await setPoll(600); await setUndoSend(0);
    await page.locator("#folder-list .folder", { hasText: "Inbox" }).first().click(); await page.waitForTimeout(500);
    const inboxLists = () => calls.filter(c => c.name === "messageGroups.getList" && /folderId%3A1\b|folderId:1\b/.test(c.envelope?.requests?.[0]?.uri || "")).length;
    const before = inboxLists();
    folders[0].highestModSeq++;
    await sendOne("Arrival");
    await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    results.afterSend = { refreshed: inboxLists() > before };
    await setPoll(5);
  }
  await setUndoSend(2);

  // Settings: nothing there about the address book, whose list is Contacts
  await page.locator("#list").focus(); await page.keyboard.press(",");
  await page.waitForSelector("#settings:not(.hidden)", { timeout: 5000 });
  // changing the text size scales the app behind Settings, not Settings itself
  {
    const px = sel => page.locator(sel).first().evaluate(e => parseFloat(getComputedStyle(e).fontSize));
    await page.locator("#textpct").fill("125"); await page.locator("#textpct").dispatchEvent("change"); await page.waitForTimeout(200);
    results.textSize = { folder: await px(".folder"), settings: await px("#settings-main label"), title: await px("#app-version") };
    await page.locator("#textpct").fill("100"); await page.locator("#textpct").dispatchEvent("change"); await page.waitForTimeout(200);
    results.textSize.folderBack = await px(".folder");
  }
  results.update = { top: await page.locator("#app-version").textContent(), note: await page.locator("#update-note").innerText(), href: await page.locator("#update-note a").getAttribute("href"),
    dot: await page.locator("#gear.has-update").count(), calls: ghCalls.length, url: ghCalls[0]?.url, cookie: ghCalls.some(c => c.cookie) };
  const ab = { noSection: await page.locator("#ab-summary, #ab-open").count(), mainHeight: (await page.locator("#settings-box").boundingBox()).height };
  const sb = await page.locator("#settings-box").boundingBox();
  await page.screenshot({ path: path.join(__dirname, "..", "out", "settings.png"), clip: { x: sb.x, y: sb.y, width: sb.width, height: Math.min(sb.height, 330) } }).catch(() => {});
  const rowOf = async sel => { const s = await page.locator(sel).boundingBox(); return s; };
  const dk = await rowOf("#darkTheme"), dr = await rowOf('input[name=theme][value=dark]'), fontSel = await rowOf("#composeFont");
  ab.paletteInline = Math.abs((dk.y + dk.height / 2) - (dr.y + dr.height / 2)) < 4 && Math.abs((dk.x + dk.width) - (fontSel.x + fontSel.width)) < 2;
  await page.keyboard.press("Escape");
  ab.closed = await page.locator("#settings").isHidden();

  // Contacts (g c): every address under one of three tabs, with the filter ready to type in
  {
    const text = sel => page.locator(sel).first().textContent().catch(() => "");
    const tabs = () => page.locator("#p-show button").evaluateAll(bs => Object.fromEntries(bs.map(b => [b.dataset.pile, Number(b.querySelector("i").textContent.replace(/\D/g, ""))])));
    const onTab = () => page.locator("#p-show button.on").getAttribute("data-pile");
    const tab = async pile => { await page.locator(`#p-show button[data-pile="${pile}"]`).click(); await page.waitForTimeout(250); };
    const count = (pile, n) => page.waitForFunction(([pile, n]) => document.querySelector(`#p-show button[data-pile="${pile}"] i`).textContent.replace(/\D/g, "") === String(n), [pile, n], { timeout: 5000 }).catch(() => {});
    const inContacts = on => page.waitForFunction(want => document.getElementById("app").classList.contains("contacts-view") === want, on, { timeout: 5000 }).catch(() => {});
    ab.wasTitle = await text("#list-title");
    await page.locator("#list").focus(); await page.keyboard.press("g"); await page.keyboard.press("c");
    await page.waitForSelector("#app.contacts-view #p-rows .prow", { timeout: 5000 });
    const piles = await page.evaluate(async () => { const c = await import("./contacts.js"); const out = { people: [], others: [], hidden: [] }; for (const r of await c.all()) out[c.pileOf(r)].push(r.email); return out; });
    ab.piles = { people: piles.people.length, others: piles.others.length, hidden: piles.hidden.length };
    ab.open = { link: await page.locator("#contacts-link.active").count(), focus: await page.evaluate(() => document.activeElement.id), on: await onTab(), tabs: await tabs(), rule: await text("#p-rule"),
      note: await page.locator("#p-note").isVisible(), count: await text("#p-count"), noCounts: await page.locator("#p-rows").evaluate(l => !/[↑↓]/.test(l.textContent)) };
    // a filter counts its matches on every tab, and a tab with none says where they are
    const someone = piles.others[0];
    await page.keyboard.type(someone); await page.waitForTimeout(250);
    ab.filter = { tabs: await tabs(), empty: (await page.locator("#p-rows .list-empty").innerText().catch(() => "")).replace(/\s+/g, " "), count: await text("#p-count") };
    await page.locator('#p-rows a[data-pile="others"]').click(); await page.waitForTimeout(250);
    ab.filter.on = await onTab(); ab.filter.rows = await page.locator("#p-rows .prow").count();
    // the arrows move the cursor from the filter box, and the person's page follows with their mail
    await page.locator("#p-filter").focus(); await page.keyboard.press("ArrowDown");
    ab.cursor = { row: await text("#p-rows .prow.sel .pm"), page: await text("#person .p-mail"), focus: await page.evaluate(() => document.activeElement.id), someone };
    await page.waitForSelector("#person .p-msg", { timeout: 4000 }).catch(() => {});
    ab.recent = { rows: await page.locator("#person .p-msg").count(), arrows: await page.locator("#person .p-msg .dir svg").count(), head: await text("#person .p-head") };
    // left for a folder and come back to: the same tab, filter and person
    await page.locator("#folder-list .folder", { hasText: "Sent" }).first().click();
    await inContacts(false); await page.waitForSelector("#rows .row", { timeout: 5000 }).catch(() => {});
    await page.locator("#contacts-link").click(); await inContacts(true);
    await page.waitForSelector("#p-rows .prow.sel", { timeout: 5000 }).catch(() => {});
    // the list as it was is on screen at once; the cursor reaches the filter box once Contacts has read the list again
    await page.waitForFunction(() => document.activeElement?.id === "p-filter", null, { timeout: 5000 }).catch(() => {});
    ab.kept = { on: await onTab(), filter: await page.inputValue("#p-filter"), row: await text("#p-rows .prow.sel .pm"), page: await text("#person .p-mail"), focus: await page.evaluate(() => document.activeElement.id) };
    // Esc clears the filter; Ctrl+A in the list selects the whole tab; Hide moves it to Hidden, and z takes that back
    await page.keyboard.press("Escape"); await page.waitForTimeout(250);
    ab.filterCleared = await page.inputValue("#p-filter"); ab.stillOpen = await page.locator("#app.contacts-view").count();
    const was = await tabs();
    await page.locator("#p-rows .prow").first().click(); await page.keyboard.press("Control+a");
    ab.selected = await text("#person .p-name");
    ab.groupButtons = (await page.locator("#person .p-actions button").allTextContents()).join("|");
    await page.locator('#person button[data-p="hide"]').click(); await count("others", 0);
    ab.hid = { tabs: await tabs(), undo: await text("#st-undo"), empty: await page.locator("#p-rows .list-empty").count() };
    await page.screenshot({ path: path.join(__dirname, "..", "out", "contacts.png") }).catch(() => {});
    await page.locator("#list").focus(); await page.keyboard.press("z"); await count("others", was.others);
    ab.undone = await tabs();
    // the eye on a row hides it, and under Hidden unhides it
    const who = await page.locator("#p-rows .prow").first().getAttribute("data-email");
    const rowOf = () => page.locator(`#p-rows .prow[data-email="${who}"]`);
    await rowOf().hover(); await rowOf().locator(".pe").click(); await count("hidden", was.hidden + 1);
    ab.eye = { tabs: await tabs() };
    await tab("hidden");
    ab.eye.listed = await rowOf().count(); ab.eye.noPin = await rowOf().locator(".pk.none").count();
    await rowOf().locator(".pe").click(); await count("hidden", was.hidden);
    ab.eye.back = await tabs();
    // the pin on a row pins it: first in People under a heading of its own, where it cannot be hidden
    await tab("others");
    await rowOf().hover(); await rowOf().locator(".pk").click(); await count("people", was.people + 1);
    await tab("people");
    ab.pin = { heads: (await page.locator("#p-rows .day").allTextContents()).join(), first: await page.locator("#p-rows .prow").first().getAttribute("data-email"), who, noEye: await rowOf().locator(".pe.none").count() };
    await rowOf().click();
    ab.pin.hide = await page.locator('#person button[data-p="hide"]').isDisabled(); ab.pin.why = await page.locator('#person button[data-p="hide"]').getAttribute("title"); ab.pin.button = await text('#person button[data-p="unpin"]');
    await rowOf().locator(".pk").click(); await count("people", was.people);
    ab.pin.after = await tabs();
    // Esc leaves Contacts for what was shown before
    await page.locator("#list").focus(); await page.keyboard.press("Escape"); await inContacts(false);
    await page.waitForSelector("#rows .row", { timeout: 5000 }).catch(() => {});
    ab.left = { open: await page.locator("#app.contacts-view").count(), title: await text("#list-title"), link: await page.locator("#contacts-link.active").count() };
  }
  results.ab = ab;

  // people in the search box: a typed word still searches as text; a picked person shows their mail
  {
    const sg = {};
    const items = () => page.locator("#search-suggest:not(.hidden) div").allTextContents();
    // hidden addresses are not offered: everyone is shown for these steps, and hidden again after them
    const hiddenWas = await page.evaluate(async () => { const c = await import("./contacts.js"); const h = (await c.all()).filter(x => x.hidden).map(x => x.email); await c.hideMany(h, false); return h; });
    await page.locator("#search").click(); await page.locator("#search").fill(""); await page.keyboard.type("sender");
    await page.waitForSelector("#search-suggest:not(.hidden)", { timeout: 4000 }).catch(() => {});
    sg.offered = await items();
    await page.keyboard.press("Enter"); await page.waitForTimeout(800);
    sg.typed = { term: await page.inputValue("#search"), title: await page.locator("#list-title").textContent(), closed: await page.locator("#search-suggest").isHidden() };
    await page.locator("#search").click(); await page.locator("#search").fill(""); await page.keyboard.type("sender 3");
    await page.waitForSelector("#search-suggest:not(.hidden)", { timeout: 4000 }).catch(() => {});
    sg.fullName = await items();
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await page.waitForTimeout(800);
    sg.picked = { term: await page.inputValue("#search"), title: await page.locator("#list-title").textContent() };
    await page.locator("#search").click(); await page.locator("#search").fill(""); await page.keyboard.type("budget from:s3");
    await page.waitForSelector("#search-suggest:not(.hidden)", { timeout: 4000 }).catch(() => {});
    await page.keyboard.press("Tab");
    sg.completed = { term: await page.inputValue("#search"), focus: await page.evaluate(() => document.activeElement.id) };
    await page.locator("#search").fill(""); await page.keyboard.type("has:attachment");
    await page.waitForTimeout(300);
    sg.otherField = await page.locator("#search-suggest").isHidden();
    await page.locator("#search").fill(""); await page.keyboard.type("sender");
    await page.waitForSelector("#search-suggest:not(.hidden)", { timeout: 4000 }).catch(() => {});
    await page.keyboard.press("Escape");
    sg.escCloses = { closed: await page.locator("#search-suggest").isHidden(), kept: await page.inputValue("#search") };
    await page.keyboard.press("Escape"); await page.waitForTimeout(600);
    await page.evaluate(async h => { const c = await import("./contacts.js"); await c.hideMany(h, true); }, hiddenWas);
    results.searchPeople = sg;
  }

  // each folder keeps its selection and open message for the session; an unvisited folder starts empty
  {
    const folder = name => page.locator("#folder-list .folder", { hasText: name }).first().click().then(() => page.waitForTimeout(700));
    const snap = async () => ({ sel: await page.locator("#rows .row.sel .sb").count() ? await page.locator("#rows .row.sel .sb").textContent() : "",
      reader: await page.locator("#reader-empty").isVisible() ? "" : await page.locator("#r-subject").textContent() });
    await folder("Projects");
    await page.locator("#rows .row").nth(2).click(); await page.waitForTimeout(700);
    const before = await snap();
    await folder("Draft");
    const away = await snap();
    await folder("Projects");
    results.folderMemory = { before, away, back: await snap() };

    // editing a draft keeps its attachments and inline images: saving it again refers to its parts
    await folder("Draft");
    await page.locator("#rows .row").first().click();
    await page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 }).catch(() => {});
    const chipsNow = await page.locator("#c-filelist .c-file").allTextContents();
    const overlay = await page.evaluate(() => {
      const box = [...document.querySelectorAll("#c-editor div")].find(d => d.textContent === "Session expired");
      const top = document.elementFromPoint(innerWidth / 2, 20);
      return { present: !!box, position: box ? getComputedStyle(box).position : "", coversApp: !!box && !!top && box.contains(top) };
    });
    const imgSrcs = await page.locator("#c-editor img").evaluateAll(els => els.map(e => (e.getAttribute("src") || "").slice(0, 30)));
    await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.type("edited ");
    const callsBefore = calls.length;
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("compose").classList.contains("hidden"), null, { timeout: 8000 }).catch(() => {});
    const saveCall = calls.slice(callsBefore).find(c => c.name === "messages.saveV3");
    const html = saveCall?.envelope?.requests?.[0]?.payloadParts?.[0]?.payload?.simpleBody?.html || "";
    const savedAtts = saveCall?.envelope?.requests?.[0]?.payloadParts?.[0]?.payload?.message?.attachments || [];
    results.draftEdit = { inReplyTo: saveCall?.envelope?.requests?.[0]?.payloadParts?.[0]?.payload?.message?.inReplyTo ?? null, chips: chipsNow.length, names: chipsNow.join(" "), imgSrcs, uploaded: (saveCall?.fileParts || []).map(p => p[1]),
      refs: savedAtts.filter(a => a.messageReference).map(a => `${a.messageReference.id}:${a.messageReference.pid}`),
      partLinks: /cloud-apis\.mail\.yahoo\.com/.test(html), closed: await page.locator("#compose").isHidden(), overlay };
    await folder("Projects");
  }

  // bidi controls never reach the page: in the list, the reader header and attachment names
  const shown = async () => page.evaluate(() => [...document.querySelectorAll("#rows, #r-subject, #r-from, #r-attach, #list-title")].map(e => e.textContent + " " + [...e.querySelectorAll("[title]")].map(t => t.title).join(" ")).join(" "));
  const projectsTwisty = page.locator("#folder-list .folder", { hasText: "Projects" }).locator(".tw");
  await projectsTwisty.click();
  await page.locator("#folder-list .folder", { hasText: "FPGA" }).click(); await page.waitForTimeout(400);
  await page.locator("#rows .row").nth(1).click(); await page.waitForTimeout(600);
  results.bidi = await shown();
  await projectsTwisty.click();
  await page.locator("#folder-list .folder", { hasText: "Projects" }).click(); await page.waitForTimeout(400);

  // new mail while the tab is in the background: a green dot on the tab icon, gone when looked at
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }));
  folders[0].unread = 4; folders[0].highestModSeq++;
  await page.waitForFunction(() => document.querySelector('link[rel="icon"]').href.startsWith("data:image/png"), null, { timeout: 15000 }).catch(() => {});
  const iconNow = () => page.evaluate(() => document.querySelector('link[rel="icon"]').href);
  const dotted = await iconNow();
  fs.writeFileSync(path.join(__dirname, "..", "out", "tab-icon.png"), Buffer.from(dotted.split(",")[1] || "", "base64"));
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(300);
  results.newMail = { title: await page.title(), dotted: dotted.slice(0, 22), cleared: (await iconNow()).split("/").slice(-2).join("/") };

  // a tab that wakes or comes into view checks at once, not at the next interval (10 minutes here)
  await page.locator("#list").focus(); await page.keyboard.press(",");
  await page.locator("#poll").fill("600"); await page.locator("#poll").dispatchEvent("change");
  await page.keyboard.press("Escape");
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }));
  folders[0].unread = 5; folders[0].highestModSeq++;
  await page.waitForTimeout(3500);
  const woke = Date.now();
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForFunction(() => document.title === "(5) Baltazar Mail for Yahoo™", null, { timeout: 2000 }).catch(() => {});
  results.wake = { title: await page.title(), ms: Date.now() - woke };

  // The tab keeps itself awake with a Web Lock; a sleep the browser forces all the same is
  // recorded, told once in a notice, and Settings then gives the browser's own setting. The page
  // is sent the events a browser sends when it freezes and thaws it, and its clock is moved on in
  // between, so a sleep of three hours takes no time here.
  {
    // the awake locks only: a Contacts sync holds a lock of its own while it runs
    const locks = () => page.evaluate(async () => (await navigator.locks.query()).held.map(l => l.name).filter(n => n.startsWith("awake-")));
    const sleep = () => page.evaluate(() => { document.dispatchEvent(new Event("freeze")); document.dispatchEvent(new Event("resume")); });
    const stored = () => page.evaluate(async () => { const s = await chrome.storage.local.get(["sleeps", "sleepNoted"]); return { sleeps: s.sleeps || [], noted: !!s.sleepNoted }; });
    const a = results.awake = { locks: await locks() };
    await page.locator("#list").focus(); await page.keyboard.press(",");
    a.before = { checked: await page.locator("#awake").isChecked(), status: await page.locator("#awake-status").textContent(), how: await page.locator("#awake-how").textContent(), steps: await page.locator("#awake-steps").isVisible() };
    // the browser's own setting can be looked up at any time, and is folded away when Settings opens again
    await page.locator("#awake-how").click();
    a.before.lead = await page.locator("#awake-steps > p").first().textContent();
    await page.keyboard.press("Escape");
    await page.locator("#list").focus(); await page.keyboard.press(",");
    a.before.refolded = !(await page.locator("#awake-steps").isVisible());
    await page.keyboard.press("Escape");
    await sleep(); await page.waitForTimeout(300);
    a.brief = await stored();
    await page.evaluate(() => { const real = Date.now.bind(Date); let skip = 0; Date.now = () => real() + skip; document.addEventListener("freeze", () => { skip += 3 * 3600e3; }); });
    await sleep();
    await page.waitForSelector("#notice:not(.hidden)", { timeout: 3000 }).catch(() => {});
    a.long = { ...(await stored()), notice: await page.locator("#notice-text").textContent(), info: await page.locator("#notice.info").count() };
    await page.locator("#notice-text button").click();
    await page.waitForSelector("#awake-steps:not(.hidden)", { timeout: 3000 }).catch(() => {});
    a.told = { settings: await page.locator("#settings").isVisible(), notice: await page.locator("#notice").isVisible(), status: await page.locator("#awake-status").textContent(),
      how: await page.locator("#awake-how").textContent(), expanded: await page.locator("#awake-how").getAttribute("aria-expanded"), address: await page.locator("#awake-steps .g-copy-value").textContent(), lines: await page.locator("#awake-steps li").count(), open: await page.locator("#awake-open").count() };
    await page.evaluate(() => { window.copied = []; navigator.clipboard.writeText = async t => { window.copied.push(t); }; });
    await page.locator("#awake-steps .g-copy-btn").click();
    await page.waitForFunction(() => document.querySelector("#awake-steps .g-copy-btn").textContent !== "Copy", null, { timeout: 2000 }).catch(() => {});
    a.told.copied = await page.locator("#awake-steps .g-copy-btn").textContent() + " " + await page.evaluate(() => window.copied.join());
    await page.locator("#awake-how").click();
    a.told.folded = !(await page.locator("#awake-steps").isVisible());
    await sleep(); await page.waitForTimeout(400);
    a.again = { count: (await stored()).sleeps.length, notice: await page.locator("#notice").isVisible(), status: await page.locator("#awake-status").textContent() };
    await page.locator("#awake").uncheck();
    await page.waitForFunction(() => !document.getElementById("awake-status").textContent.includes("still"), null, { timeout: 2000 }).catch(() => {});
    a.off = { locks: await locks(), status: await page.locator("#awake-status").textContent(), how: await page.locator("#awake-how").textContent(), saved: await page.evaluate(async () => { await new Promise(r => setTimeout(r, 300)); return (await chrome.storage.local.get("settings")).settings.awake; }) };
    await page.locator("#awake").check();
    a.on = { locks: (await locks()).length };
    await page.keyboard.press("Escape");
  }

  // Files: asked for from a folder's menu, the files of its mail take the message list's place,
  // listed from the search rows alone and without the nameless logo, while the folder stays
  // highlighted and nothing is added to the tree; a click shows a file's message, Enter previews
  // it and the arrows step on to the next message's file; Esc goes back to the folder's messages;
  // Subfolders widens the search and the folder keeps that choice, across a reload too.
  {
    const f = results.files = {};
    const tree = name => page.locator("#folder-list .folder", { hasText: name }).first();
    const lists = from => calls.slice(from).filter(c => c.name === "messageGroups.getList").map(c => decodeURIComponent(c.envelope?.requests?.[0]?.uri || ""));
    const showFiles = async name => { await tree(name).click({ button: "right" }); await page.locator('#ctx [data-act="files"]').click(); await page.waitForTimeout(800); };
    await tree("Inbox").click(); await page.waitForTimeout(500);
    const folders = await page.locator("#folder-list .folder").count();
    await tree("Inbox").click({ button: "right" });
    f.menu = await page.locator('#ctx [data-act="files"]').textContent();
    const n0 = calls.length;
    await page.locator('#ctx [data-act="files"]').click();
    await page.waitForSelector("#f-rows .frow", { timeout: 5000 }).catch(() => {});
    f.calls = calls.slice(n0).map(c => c.name);
    f.query = lists(n0)[0] || "";
    f.tree = { added: (await page.locator("#folder-list .folder").count()) - folders, active: await page.locator("#folder-list .folder.active").evaluateAll(els => els.map(e => e.dataset.id)) };
    f.list = { rows: await page.locator("#f-rows .frow .fn").allTextContents(), tiles: await page.locator("#f-rows .frow .ft").allTextContents(), count: await page.locator("#f-count").textContent(),
      title: await page.locator("#f-title").textContent(), messages: await page.locator("#rows").isVisible(), toolbar: await page.locator("#toolbar").isVisible(), subs: await page.locator("#f-subs").isVisible() };
    await page.locator("#f-rows .frow").first().click(); await page.waitForTimeout(700);
    f.reader = { subject: await page.locator("#r-subject").textContent(), del: await page.locator("#r-delete").isVisible(), sel: await page.locator("#f-rows .frow.sel").count() };
    await page.keyboard.press("Enter");
    await page.waitForSelector("#viewer:not(.hidden)", { timeout: 3000 }).catch(() => {});
    f.viewer = { name: await page.locator("#v-name").textContent(), meta: await page.locator("#v-meta").textContent() };
    await viewerKey(page, "ArrowRight"); await page.waitForTimeout(300);
    f.viewer.next = await page.locator("#v-meta").textContent();
    await viewerKey(page, "Escape"); await page.waitForTimeout(200);
    await page.keyboard.press("j"); await page.waitForTimeout(100);
    f.keys = { sel: await page.locator("#f-rows .frow.sel").evaluate(e => e.dataset.i).catch(() => null), viewer: await page.locator("#viewer").isVisible() };
    // a row's type badge is outlined under the mouse; clicked, it shows the file's message and opens the file
    await page.mouse.move(0, 0);
    const first = page.locator("#f-rows .frow").first(), second = page.locator("#f-rows .frow").nth(1);
    const outline = loc => loc.locator(".ft").evaluate(e => getComputedStyle(e).outlineStyle);
    f.badge = { idle: await outline(first) };
    await first.hover();
    f.badge.hover = await outline(first);
    await second.locator(".ft").click();
    await page.waitForSelector("#viewer:not(.hidden)", { timeout: 3000 }).catch(() => {});
    await page.waitForFunction(() => document.getElementById("r-subject").textContent === "Subject 1-6", null, { timeout: 5000 }).catch(() => {});
    Object.assign(f.badge, { subject: await page.locator("#r-subject").textContent(), name: await page.locator("#v-name").textContent(), meta: await page.locator("#v-meta").textContent() });
    await viewerKey(page, "Escape"); await page.waitForTimeout(200);
    const listed = async () => ({ pane: await page.locator("#files-pane").isVisible(), rows: await page.locator("#rows .row").count(), title: await page.locator("#list-title").textContent() });
    await page.keyboard.press("Escape"); await page.waitForTimeout(600);
    f.esc = await listed();
    // a folder with a subfolder offers Subfolders, which adds it to the search and is kept
    await showFiles("Projects");
    const box = page.locator("#f-subs-box");
    f.subs = { shown: await page.locator("#f-subs").isVisible(), ticked: await box.isChecked() };
    const n1 = calls.length;
    await box.click(); await page.waitForTimeout(800);
    f.subs.query = lists(n1)[0] || "";
    f.subs.after = await box.isChecked();
    f.saved = await page.evaluate(async () => (await chrome.storage.local.get("folderFiles")).folderFiles);
    // another folder leaves Files; asked for again, Projects lists its subfolders' files at once
    await tree("Inbox").click(); await page.waitForTimeout(600);
    f.left = await listed();
    const n2 = calls.length;
    await showFiles("Projects");
    f.again = { ticked: await box.isChecked(), query: lists(n2)[0] || "" };
    // a reload opens the Inbox's messages, and the choice is still kept; unticked, it is not
    await page.reload(); await page.waitForSelector("#rows .row", { timeout: 15000 });
    f.reloaded = await listed();
    const n3 = calls.length;
    await showFiles("Projects");
    f.reloaded.ticked = await box.isChecked();
    f.reloaded.query = lists(n3)[0] || "";
    await box.click(); await page.waitForTimeout(800);
    f.unticked = await page.evaluate(async () => (await chrome.storage.local.get("folderFiles")).folderFiles);
  }
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
  expect(results.sent.html.includes('src="cid:') && results.sent.attachments.some(a => a.disposition === "inline" && a.contentId) && results.sent.attachments.filter(a => a.disposition === "inline").length === 1 && results.sent.uri.includes("uploadCount=4&totalAttachments=4"), "inline image as cid attachment: " + results.sent.html + " " + JSON.stringify(results.sent.attachments) + " " + results.sent.uri);
  {
    const p = results.pictures;
    expect(p.shown.bar && p.shown.handle && p.shown.size === "800 × 600" && p.shown.originalOn && p.medium.join() === "400,300,400px,400 × 300" && Math.abs(p.dragged.width - p.dragged.want) <= 2 && p.frameFollows &&
      !p.escape.bar && p.escape.composer && p.deleted === 0 && p.undone === 1, "a picture in the composer is scaled, let go and deleted, and the delete undone: " + JSON.stringify(p));
    expect(p.whole?.html && p.whole.widths.join() === "800" && p.smaller?.html && p.smaller.widths.join() === "400", "a picture made smaller is sent whole, or at twice its shown width: " + JSON.stringify({ whole: p.whole, smaller: p.smaller }));
  }
  expect(results.sent.fileParts.some(p => p[1] === "note.txt") && results.sent.attachments.some(a => a.disposition === "attachment"), "attachment sent");
  const names = results.sent.fileParts.map(p => p[1]);
  expect(names.includes("note (2).txt") && new Set(names).size === names.length, "attachments with the same name get unique names: " + JSON.stringify(names));
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
    const ab = results.ab, n = ab.piles, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    expect(ab.noSection === 0 && ab.paletteInline && ab.closed, "Settings has no section for the address book: " + JSON.stringify(ab));
    expect(ab.open.link === 1 && ab.open.focus === "p-filter" && ab.open.on === "people" && same(ab.open.tabs, n) && n.people >= 1 && n.others >= 2 && /^Most recent first/.test(ab.open.rule) && !ab.open.note && ab.open.count === "" && ab.open.noCounts,
      "g c opens Contacts on People, every address under one of three tabs, the filter ready: " + JSON.stringify(ab.open) + " " + JSON.stringify(n));
    expect(ab.filter.tabs.people === 0 && ab.filter.tabs.others === 1 && /^Nothing in People matches .* 1 in Others/.test(ab.filter.empty) && /^0 matches of \d+$/.test(ab.filter.count) && ab.filter.on === "others" && ab.filter.rows === 1,
      "a filter counts its matches on every tab, and an empty tab leads to them: " + JSON.stringify(ab.filter));
    expect(ab.cursor.row === ab.cursor.someone && ab.cursor.page === ab.cursor.someone && ab.cursor.focus === "p-filter" && ab.recent.rows >= 1 && ab.recent.arrows === ab.recent.rows && ab.recent.head === "Recent messages",
      "the arrows move the cursor from the filter box and the person's page follows, with their mail: " + JSON.stringify([ab.cursor, ab.recent]));
    expect(ab.kept.on === "others" && ab.kept.filter === ab.cursor.someone && ab.kept.row === ab.cursor.someone && ab.kept.page === ab.cursor.someone && ab.kept.focus === "p-filter", "Contacts is come back to as it was left: " + JSON.stringify(ab.kept));
    expect(ab.filterCleared === "" && ab.stillOpen === 1 && ab.selected === `${n.others} contacts selected` && ab.groupButtons === "Write to all|Mail from any|Mail to any|Copy addresses|Pin|Hide|Delete|Clear selection" &&
      ab.hid.tabs.others === 0 && ab.hid.tabs.hidden === n.hidden + n.others && ab.hid.empty === 1 && ab.hid.undo === `Undo: hide ${n.others} contacts (z)` && same(ab.undone, n),
      "Ctrl+A selects the whole tab, Hide moves it to Hidden, and z takes that back: " + JSON.stringify(ab));
    expect(ab.eye.tabs.hidden === n.hidden + 1 && ab.eye.listed === 1 && ab.eye.noPin === 1 && same(ab.eye.back, n), "the eye on a row hides it, and unhides it under Hidden, where it has no pin: " + JSON.stringify(ab.eye));
    expect(ab.pin.heads === "Pinned,Written to" && ab.pin.first === ab.pin.who && ab.pin.noEye === 1 && ab.pin.hide && /^Unpin it first/.test(ab.pin.why) && ab.pin.button === "Unpin" && same(ab.pin.after, n),
      "the pin on a row pins it first in People, where it cannot be hidden; the pin unpins it: " + JSON.stringify(ab.pin));
    expect(ab.left.open === 0 && ab.left.link === 0 && ab.left.title === "Sent", "Esc leaves Contacts for the folder it was opened from: " + JSON.stringify(ab.left));
    const sg = results.searchPeople;
    expect(sg.offered.length >= 3 && sg.offered[0].startsWith("Sender") && /^Contacts matching “sender”/.test(sg.offered.at(-1)) && sg.typed.term === "sender" && /^“sender”/.test(sg.typed.title) && sg.typed.closed,
      "the search box offers people, and Enter still searches for what was typed: " + JSON.stringify(sg));
    expect(sg.fullName[0] === "Sender 3s3@x.com" && sg.picked.term === "s3@x.com" && sg.picked.title === "“s3@x.com” in all mail", "a name typed in full is found, and picking the person shows all mail with them: " + JSON.stringify(sg));
    expect(sg.completed.term === "budget from:s3@x.com " && sg.completed.focus === "search" && sg.otherField && sg.escCloses.closed && sg.escCloses.kept === "sender", "Tab completes the address after from:, other fields offer nobody, Esc closes the list first: " + JSON.stringify(sg));
  }
  expect(results.inlineParts.partInlined && results.inlineParts.fromSource && results.inlineParts.clips.startsWith("00100") && results.inlineParts.spacerHeight <= 2 && results.inlineParts.proxyKept && !results.inlineParts.hiddenFetched, "inline images: " + JSON.stringify(results.inlineParts));
  expect(results.attach.ghosts > 0 && results.attach.ghostCards === 0 && results.attach.cards === 7 && results.attach.thumbs === 1 && results.attach.stripBelowBody && results.attach.labels.join(",") === "PDF,CSV,ZIP,,DOC,XLS,PPT", "attachment strip: " + JSON.stringify(results.attach));
  expect(/^ui-monospace, Consolas, Menlo, .*monospace$/.test(results.vMono || ""), "renderer monospace stack: " + results.vMono);
  expect(results.vCsv.join(",") === "Z80,2,6502,1" && results.vZip.includes("src/main.c") && results.vImg === 1 && results.vDoc.includes("Jorge Ruiz") && results.vPdf.pages === 2 && results.vPdf.zoomed && results.vPdf.zoomBar && /page 1 of 2/.test(results.vPdf.meta) && results.vZoomHidden && results.vClosed, "viewer: " + JSON.stringify([results.vCsv, results.vZip, results.vImg, results.vDoc, results.vPdf, results.vZoomHidden, results.vClosed]));
  expect(results.vSheet.cells.join(",") === "Item,Cost,Z80,2.5,6502,1.25" && results.vSheet.tabs === 2 && results.vSheet2.join(",") === "Item,Cost,68000,9", "spreadsheet: " + JSON.stringify([results.vSheet, results.vSheet2]));
  expect(results.vSlides.pages === 5 && results.vSlides.text.includes("Slide one") && results.vSlides.clean && results.vSlides.retried && results.vSlides.docId === "DOC8" && results.vKeyForward &&
    !results.vSlides.escaped && results.vSlides.styled === "26.6667px", "converter: " + JSON.stringify(results.vSlides));
  {
    // Refused on purpose: the sandbox's probe (connect-src 'self'), and by img-src 'none' (reader)
    // and img-src data: (reply quote) a message's images blocked by Spam, Trash or the setting. A
    // Yahoo part address in a message frame is blocked by the extension's own policy as well, since
    // no extension page may load Yahoo-host images.
    const unexpected = (results.cspViolations || []).filter(v => !/https:\/\/mail\.yahoo\.com\/probe-sandbox/.test(v) && !/img-src ('none|data:\\?")/.test(v) &&
      !/^about:srcdoc: Loading the image 'https:\/\/cloud-apis\.mail\.yahoo\.com\//.test(v));
    expect(unexpected.length === 0, "content security policy blocked something the app needs: " + JSON.stringify(unexpected.slice(0, 5)));
  }
  expect(results.vSandbox.origin === "null" && results.vSandbox.cookies === "blocked" && results.vSandbox.chrome === false && results.vSandbox.fetch === "blocked" && !results.vSandbox.reached, "sandbox isolation: " + JSON.stringify(results.vSandbox));
  expect(results.vRaw.textLabel === "View as text" && results.vRaw.text === "not really a deck" && results.vRaw.textMeta.includes("as text") &&
    results.vRaw.binLabel === "View as binary" && results.vRaw.hex.dump === "00000000  50 4b 03 04 14 00 00 00  41 42                    PK......AB" &&
    results.vRaw.hex.note === "10 bytes, shown as offset, hex and ASCII.", "view as text or binary: " + JSON.stringify(results.vRaw));
  {
    const d = results.darkReader;
    expect(!d.lightButton && d.button === "☀" && d.dark.bg === "rgb(31, 31, 31)" && d.dark.fg === "rgb(177, 177, 177)" && d.dark.filter === "none" &&
      d.original.bg === "rgb(255, 255, 255)" && d.original.filter === "brightness(0.9)" && d.original.button === "☾" && d.original.saved === true &&
      d.nextMessage.bg === "rgb(255, 255, 255)" && d.again.bg === "rgb(31, 31, 31)" &&
      d.light.bg === "rgb(255, 255, 255)" && d.light.filter === "none" && !d.light.button, "dark reader: " + JSON.stringify(d));
  }
  expect(results.rows.legacy18 === 18 && results.rows.field === "80", "row height migrated from pixels: " + JSON.stringify(results.rows));
  expect(results.textSize.folder === 16.25 && results.textSize.settings === 13 && results.textSize.folderBack === 13, "text size scales the app, not Settings: " + JSON.stringify(results.textSize));
  expect(results.tabIcon.title === "(3) Baltazar Mail for Yahoo™" && results.tabIcon.href === "icons/32.png", "plain tab icon for mail already there: " + JSON.stringify(results.tabIcon));
  expect(results.newMail.title === "(4) Baltazar Mail for Yahoo™" && results.newMail.dotted === "data:image/png;base64," && results.newMail.cleared === "icons/32.png", "new-mail dot: " + JSON.stringify(results.newMail));
  expect(results.wake.title === "(5) Baltazar Mail for Yahoo™" && results.wake.ms < 2000, "checks for mail on waking: " + JSON.stringify(results.wake));
  {
    const f = results.folderMemory;
    expect(f.before.sel && f.before.reader && f.before.sel.startsWith(f.before.reader) && f.away.sel === "" && f.away.reader === "" &&
      f.back.sel === f.before.sel && f.back.reader === f.before.reader, "per-folder selection and reader: " + JSON.stringify(f));
  }
  expect(results.vDownload === "report.pdf:true" && results.rawFetches === 1 && !/^chrome-extension/.test(results.rawOrigin || ""), "bytes: " + JSON.stringify([results.vDownload, results.rawFetches, results.rawOrigin]));
  expect(results.card.head.includes("s2@x.com") && /^Last exchange /.test(results.card.stats) && !/wrote|\d+ times?/.test(results.card.stats) && results.card.recent >= 1 && results.cardClosed, "contact card: " + JSON.stringify(results.card));
  expect(/^Version 99\.0\.0 is available\. Download it from GitHub\. Checked daily with GitHub; no data about you is sent\.$/.test(results.update.note) &&
    results.update.href === "https://github.com/gdevic/baltazar-mail/releases/latest" && results.update.dot === 1 && /^Baltazar Mail for Yahoo™ \d+\.\d+\.\d+$/.test(results.update.top) && results.update.calls === 1 && !results.update.cookie &&
    results.update.url === "https://api.github.com/repos/gdevic/baltazar-mail/releases/latest", "update notice: " + JSON.stringify(results.update));
  expect(results.spam.dest === "6" && results.spam.undo.includes("as spam") && !results.spam.next.empty && results.spam.next.subject && results.spam.next.sel.startsWith(results.spam.next.subject) &&
    results.spam.undone.subject === results.spam.was && results.spam.undone.sel.startsWith(results.spam.was) &&
    !results.spam.elsewhere.empty && results.spam.elsewhere.subject === results.spam.next.subject && results.spam.elsewhere.sel.startsWith(results.spam.next.subject), "spam moves to Bulk: " + JSON.stringify(results.spam));
  // The original's 7 attachments go by reference; its three inline images (Yahoo part, part taken
  // from the message source, data: spacer) travel as uploaded inline parts.
  const refs = results.fwd.atts.filter(x => x.messageReference), inl = results.fwd.atts.filter(x => x.disposition === "inline");
  expect(results.fwdChips.length === 7 && refs.length === 7 && refs[0].messageReference?.pid === "2" && inl.length === 3 && results.fwd.uri.includes("uploadCount=3&totalAttachments=10") && results.fwd.inReplyTo.forwarded, "forward with attachments: " + JSON.stringify(results.fwd));
  expect(results.palette === 16, "16 text colours");
  expect(results.fontInitial[0] === "Helvetica" && results.fontInitial[1] === "13" && results.fontAfter[0] === "Georgia" && results.fontAfter[1] === "18", "font controls track caret: " + JSON.stringify([results.fontInitial, results.fontAfter]));
  expect(results.noListOnOpen && results.listOnClick && results.noListAfterPick, "address list only on click: " + JSON.stringify([results.noListOnOpen, results.listOnClick, results.noListAfterPick]));
  expect(results.print.url === "print.html" && results.print.body.startsWith("Body of"), "print page: " + JSON.stringify(results.print));
  expect(results.print.header.visible && results.print.header.onTop && results.print.remote.length > 0, "a message's styles cannot hide or cover the printed header: " + JSON.stringify(results.print));
  expect(/^Could not print 1 message: too much.*QUOTA_BYTES/.test(results.printQuota), "a print too large for the hand-off says so: " + results.printQuota);
  const si = results.spamImages;
  expect(si.printImgs.length > 0 && si.printImgs.every(s => s.startsWith("data:")) && si.quoteLive.length === 0, "a Spam message prints and quotes without remote images: " + JSON.stringify(si));
  expect(results.colorScheme === "dark" && results.keepTab === false, "dark palettes set a dark color-scheme; the tab is not discarded: " + JSON.stringify({ cs: results.colorScheme, keep: results.keepTab }));
  const fk = results.frameKeys;
  expect(fk.focus === "r-body" && fk.before === 1 && fk.pageDown === 1 && fk.k === 0, "shortcuts reach the app from the message frame: " + JSON.stringify(fk));
  const bd = results.bidi;
  expect(!/[\u202A-\u202E\u2066-\u2069]/.test(bd) && bd.includes("Pay eulav") && bd.includes("Bobevil") && bd.includes("invfdp.exe"),
    "bidi controls are removed from names, subjects and filenames: " + JSON.stringify(bd));
  const u = results.unsafe;
  expect(!u.error && !u.scripts && !u.forms && !u.frames && !u.refresh && u.csp === 1 && !u.handlers.length && u.link && !u.link.ping && u.link.target === "_blank" && /noopener/.test(u.link.rel) && u.pwned === null &&
    u.others.every(t => t === "_blank" || t === "gone"),
    "the reader removes scripts, forms, frames, refresh, handlers and pings: " + JSON.stringify(u));
  expect(!unexpectedHosts.size, "no request left for the real network: " + [...unexpectedHosts].join(", "));
  expect(results.slowLoad.rows > 0, "an action during a slow folder load leaves the folder filled: " + JSON.stringify(results.slowLoad));
  const de = results.draftEdit;
  expect(de.chips === 7 && /report\.pdf/.test(de.names) && /deck\.pptx/.test(de.names) && de.imgSrcs.filter(s => s.startsWith("data:")).length === 3 && !de.imgSrcs.some(s => s.includes("cloud-apis")) &&
    ["2", "3", "6", "8"].every(p => de.refs.some(r => /^MSG3_\d+:/.test(r) && r.endsWith(":" + p))) && de.refs.length === 7 && !de.uploaded.some(n => !n.startsWith("inline-")) && !de.partLinks && de.closed,
    "editing a draft keeps its attachments, as references to its own parts, and its images: " + JSON.stringify(de));
  expect(de.inReplyTo === null, "a reopened draft drops a reply reference that is not a message id: " + JSON.stringify(de.inReplyTo));
  expect(de.overlay.present && de.overlay.position !== "fixed" && !de.overlay.coversApp, "a quoted box cannot cover the app: " + JSON.stringify(de.overlay));
  expect(de.uploaded.filter(n => n.startsWith("inline-")).every(n => /\.(png|jpg|gif|webp|bmp)$/.test(n)) && de.uploaded.filter(n => n.startsWith("inline-")).length === 3, "only real images become inline parts, bad ones do not stop the save: " + JSON.stringify(de.uploaded));
  expect(results.afterSend.refreshed, "a folder change seen right after a send refreshes the list: " + JSON.stringify(results.afterSend));
  const sq = results.sendQueue;
  expect(/Queue B.*1 more message waiting/.test(sq.pending) && sq.leaveAsks, "two pending sends both wait, and leaving asks first: " + JSON.stringify(sq));
  expect(sq.reopened === "Queue B" && /Queue A/.test(sq.stillPending), "z reopens only the newest send: " + JSON.stringify(sq));
  expect(sq.afterFail.subject === "Queue A" && sq.afterFail.savedB && !sq.afterFail.sentB && /not sent/.test(sq.afterFail.notice), "a failed send saves the open message before reopening: " + JSON.stringify(sq.afterFail));
  expect(sq.leaveQuiet, "nothing pending, leaving does not ask: " + JSON.stringify(sq));
  const fm = results.failedMove;
  expect(fm.text.startsWith("Could not archive the messages.") && /EC-5003/.test(fm.tech) && fm.copy && fm.rowsKept && fm.dismissed, "failed archive shows a notice in words with a report: " + JSON.stringify(fm));
  const k = results.keepUnsaved;
  expect(k.badAddress.open && !k.badAddress.saved && /could not be saved: Not an address: john/.test(k.badAddress.notice), "unsaveable address keeps composer open, with a notice: " + JSON.stringify(k.badAddress));
  expect(k.clickAwayBad.open && /could not be saved/.test(k.clickAwayBad.notice), "clicking another message keeps unsaveable composer open: " + JSON.stringify(k.clickAwayBad));
  expect(k.serverError.open && /could not be saved: draft save failed/.test(k.serverError.notice) && k.serverError.copy && k.serverError.body.includes("do not lose this"), "failed save keeps composer and text, with a report to copy: " + JSON.stringify(k.serverError));
  expect(k.closed && k.status === "message saved to Drafts" && k.noticeAfter === "" && k.savedSubject === "Keep me", "successful save closes composer and clears the notice: " + JSON.stringify(k));
  expect(results.clickAway.composerHidden && results.clickAway.readerText.startsWith("Body of") && results.clickAway.draftSaved, "click-away saves draft and shows message: " + JSON.stringify(results.clickAway));
  {
    const a = results.awake, ours = `chrome-extension://${extId}/`;
    expect(a.locks.length === 1 && /^awake-[0-9a-f-]{36}$/.test(a.locks[0]) && a.before.checked && a.before.status === "Kept awake: the browser has not put this tab to sleep in the last 7 days." && a.before.how === "Browser's own setting" && !a.before.steps && a.before.lead.startsWith("The browser has a list") && a.before.refolded,
      "the signed-in tab holds a lock of its own, and Settings says it has stayed awake and keeps the browser's own setting at hand: " + JSON.stringify(a));
    expect(!a.brief.sleeps.length && !a.brief.noted, "a sleep of a moment is not recorded: " + JSON.stringify(a.brief));
    expect(a.long.sleeps.length === 1 && a.long.sleeps[0][2] === true && Math.round(a.long.sleeps[0][1] / 60e3) === 180 && a.long.noted && a.long.info === 1 &&
      a.long.notice === "The browser put this tab to sleep for 3 h, so mail was not checked. What to do", "a long sleep under the lock is recorded and told in a notice: " + JSON.stringify(a.long));
    expect(a.told.settings && !a.told.notice && a.told.status === "The browser still put this tab to sleep once in the last 7 days, for 3 h." && a.told.how === "How to stop that" && a.told.expanded === "true" && a.told.address === ours && a.told.lines === 2 && a.told.open === 0 &&
      a.told.copied === "Copied " + ours && a.told.folded, "the notice leads to Settings, which gives this copy's address to add: " + JSON.stringify(a.told));
    expect(a.again.count === 2 && !a.again.notice && a.again.status === "The browser still put this tab to sleep 2 times in the last 7 days, for 3 h at the longest.", "a second sleep is counted and not told again: " + JSON.stringify(a.again));
    expect(!a.off.locks.length && a.off.saved === false && a.off.status === "The browser put this tab to sleep 2 times in the last 7 days, for 3 h at the longest." && a.off.how === "Browser's own setting" && a.on.locks === 1,
      "switched off, the lock is given back; switched on, it is taken again: " + JSON.stringify({ off: a.off, on: a.on }));
  }
  {
    const f = results.files;
    expect(f.menu === "Show attachments" && f.tree.added === 0 && f.tree.active.join() === "1" && f.calls.length === 1 && f.calls[0] === "messageGroups.getList" && /folderId:1 has:attachment/.test(f.query),
      "Show attachments lists the folder's attachments with one search, adding nothing to the tree: " + JSON.stringify(f));
    expect(f.list.rows.join() === "f.pdf,f.pdf" && f.list.tiles.join() === "PDF,PDF" && f.list.count === "2 attachments" && f.list.title === "Attachments in Inbox" && !f.list.messages && !f.list.toolbar && !f.list.subs,
      "the files of the folder's mail, without images built into the text or a nameless logo, in the message list's place: " + JSON.stringify(f.list));
    expect(f.reader.subject === "Subject 1-3" && !f.reader.del && f.reader.sel === 1 && f.viewer.name === "f.pdf" && /1 of 2/.test(f.viewer.meta) && /2 of 2/.test(f.viewer.next) && f.keys.sel === "1" && !f.keys.viewer,
      "a click shows the file's message, Enter previews it and the viewer steps on to the next message's file: " + JSON.stringify([f.reader, f.viewer, f.keys]));
    expect(f.badge.idle === "none" && f.badge.hover === "solid" && f.badge.subject === "Subject 1-6" && f.badge.name === "f.pdf" && /2 of 2/.test(f.badge.meta),
      "a row's badge is outlined under the mouse and opens the file over its message: " + JSON.stringify(f.badge));
    expect(!f.esc.pane && f.esc.rows > 0 && f.esc.title === "Inbox" && !f.left.pane && f.left.rows > 0 && f.left.title === "Inbox",
      "Esc, or another folder, leaves Files for messages: " + JSON.stringify([f.esc, f.left]));
    expect(f.subs.shown && !f.subs.ticked && /folderId:\(31 OR 32\) has:attachment/.test(f.subs.query) && f.subs.after && JSON.stringify(f.saved) === '{"me@yahoo.com":{"31":{"subs":true}}}',
      "Subfolders adds the folder's subfolders to the search, and the folder keeps the choice per account: " + JSON.stringify([f.subs, f.saved]));
    expect(f.again.ticked && /folderId:\(31 OR 32\) has:attachment/.test(f.again.query) && !f.reloaded.pane && f.reloaded.title === "Inbox" && f.reloaded.ticked && /folderId:\(31 OR 32\) has:attachment/.test(f.reloaded.query) && JSON.stringify(f.unticked) === "{}",
      "asked for again, and after a reload, the kept choice lists the subfolders' files at once; unticked, nothing is kept: " + JSON.stringify([f.again, f.reloaded, f.unticked]));
  }
  if (errors.length) { console.error("FAILED:", errors); process.exit(1); }
  console.log("PASS");
})().catch(e => { console.error(e); process.exit(1); });
