// Runtime test of the Gmail extension: a build without a Google client of its own (out/test/)
// loaded into Chromium against the Gmail of gmail-mock.js, driven through the setup guide and
// sign-in, reading, search, actions with undo, folders, compose, drafts and polling.
// node tools/gmail-runtime.js
const path = require("path");
const fs = require("fs");
const { launch, watchdog, viewerKey } = require("./harness");
const { FX } = require("./gmail-mock.js");

(async () => {
  const mime = await import("../ext/mime.js");
  const h = await launch({ provider: "gmail", gmail: { mime } });
  watchdog(h, __filename);
  const { ctx, page, extId, profile, gmail, errors, cspViolations, unexpectedHosts } = h;
  const results = {};
  const CID = "123456789012-abc123def456ghi789.apps.googleusercontent.com";   // the client the user sets up
  const REDIRECT = `https://${extId}.chromiumapp.org/`;
  const expect = (c, w) => { if (!c) errors.push("assert: " + w); };
  const frameText = async () => page.frameLocator("#r-body").locator("body").innerText({ timeout: 3000 }).catch(() => "FRAME-ERR");
  const folder = async name => { await page.locator("#folder-list .folder", { hasText: name }).first().click(); await page.waitForTimeout(600); };
  const menu = async (act, timeout = 4000) => { await page.locator(`#ctx [data-act="${act}"]`).click(); await page.waitForTimeout(timeout === 0 ? 0 : 400); };
  const lastUpload = () => gmail.uploads.at(-1);
  const partsOf = up => mime.listParts(Buffer.from(up.raw, "latin1")).parts.map(p => [p.partId, p.type, p.filename]);
  const headersOf = up => { const o = {}; for (const line of up.raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ").split("\r\n")) { const c = line.indexOf(":"); if (c > 0) o[line.slice(0, c).toLowerCase()] = line.slice(c + 1).trim(); } return o; };

  // without a Google client the sign-in page is the setup guide, for this copy's redirect address,
  // and opens no window
  await page.goto(`chrome-extension://${extId}/mail.html`);
  await page.waitForSelector("#signin:not(.hidden) .g-step.now", { timeout: 20000 });
  const guideState = () => page.evaluate(() => {
    const q = s => document.querySelector(s), state = li => ["now", "done", "todo"].find(c => li.classList.contains(c));
    return { steps: [...document.querySelectorAll(".g-step")].map(li => `${li.dataset.step}:${state(li)}`).join(), copy: q(".g-step.now .g-copy-value")?.textContent ?? null,
      open: q(".g-step.now .g-open")?.href ?? null, focus: document.activeElement?.closest?.(".g-step")?.dataset.step ?? null, button: !!q("#signin-guide #retry") && !!q("#retry").offsetParent };
  });
  results.signIn = { title: await page.locator("#signin-title").textContent(), text: await page.locator("#signin-text").textContent(), app: await page.locator("#app").isHidden(), tab: await page.title(),
    brand: await page.locator("#brand").textContent(), fails: await page.locator("#signin-fail").isHidden(), ...(await guideState()), flows: gmail.signIns.length };
  // Copy puts the address on the clipboard, and the button says so
  await page.evaluate(() => { window.copied = []; navigator.clipboard.writeText = async t => { window.copied.push(t); }; });
  await page.locator(".g-step.now .g-copy-btn").click();
  results.copied = { values: await page.evaluate(() => window.copied), label: await page.locator(".g-step.now .g-copy-btn").textContent() };
  // Google's page opens in a tab of its own
  const [consoleTab] = await Promise.all([ctx.waitForEvent("page"), page.locator(".g-step.now .g-open").click()]);
  await consoleTab.waitForLoadState().catch(() => {});
  results.opened = { url: consoleTab.url(), noted: [...gmail.consolePages] };
  await consoleTab.close(); await page.bringToFront();
  // on to the paste step: keys typed into the box are not shortcuts, and each wrong value says why
  await page.locator(".g-step.now .g-next").click();
  results.pasteStep = await guideState();
  await page.locator("#g-paste-in").focus();
  await page.keyboard.type("c,?t");
  results.keys = { compose: await page.locator("#compose").isHidden(), settings: await page.locator("#settings").isHidden(), help: await page.locator("#help").isHidden(), typed: await page.locator("#g-paste-in").inputValue() };
  const verdictOf = async v => { await page.locator("#g-paste-in").fill(v); return { msg: await page.locator("#g-paste-msg").textContent(), ok: await page.locator("#g-paste-ok").isEnabled() }; };
  results.paste = { redirect: await verdictOf(REDIRECT), secret: await verdictOf("GOCSPX-abc"), good: await verdictOf(CID) };
  await page.locator("#g-paste-in").press("Enter");
  await page.waitForSelector('.g-step.now[data-step="api"]', { timeout: 5000 });
  results.apiStep = await guideState();
  // a reload carries on where the guide stood
  await page.reload();
  await page.waitForSelector('.g-step.now[data-step="api"]', { timeout: 20000 });
  results.resumed = await guideState();
  await page.locator(".g-step.now .g-next").click();
  await page.waitForSelector('.g-step.now[data-step="signin"]', { timeout: 5000 });
  results.signinStep = { ...(await guideState()), label: await page.locator("#retry").textContent(), notes: await page.locator(".g-step.now .g-lines li").count() };
  // Google's window closed before the end: the page says so, offers what Google's window may have said, and stays
  const flowsAtGuide = gmail.signIns.length;
  gmail.flowAnswer = { reject: "The user did not approve access." };
  await page.locator("#retry").click();
  await page.waitForSelector("#signin-alert:not(.hidden)", { timeout: 5000 });
  results.closed = { flows: gmail.signIns.slice(flowsAtGuide), alert: await page.locator("#signin-alert").textContent(), help: await page.locator("#signin-help:not(.hidden) .g-help-item").count(),
    enabled: await page.locator("#retry").isEnabled(), steps: (await guideState()).steps };
  // Google gives a token, but the Gmail API is off: the page links to it, and Continue needs no window
  gmail.flowAnswer = { fragment: "access_token=test&token_type=Bearer&expires_in=3600" };
  gmail.fail = { status: 403, times: 1, body: { error: { code: 403, message: "Gmail API has not been used in project 123456789012 before or it is disabled.", status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured" }], details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }] } } };
  await page.locator("#retry").click();
  await page.waitForFunction(() => /Gmail API/.test(document.getElementById("signin-alert").textContent), null, { timeout: 5000 });
  results.apiOff = { alert: await page.locator("#signin-alert").textContent(), link: await page.locator("#signin-alert .g-open").getAttribute("href"), button: await page.locator("#retry").textContent() };
  const flowsHeld = gmail.signIns.length;
  await page.locator("#retry").click();
  await page.waitForSelector("#rows .row", { timeout: 20000 });
  results.continued = { flows: gmail.signIns.length - flowsHeld, setup: await page.evaluate(async () => (await chrome.storage.local.get("gmSetup")).gmSetup ?? null), client: await page.evaluate(async () => (await chrome.storage.local.get("gmClientId")).gmClientId) };
  const flowsAtMailbox = gmail.signIns.length;
  await page.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.storage.local.get("updateCheck")).updateCheck; i++) await new Promise(r => setTimeout(r, 100)); });
  await page.evaluate(() => chrome.storage.local.set({ settings: { pollSec: 5, undoSendSec: 2 } }));
  await page.reload();
  await page.waitForSelector("#rows .row", { timeout: 20000 });
  results.signedIn = { account: await page.locator("#account").textContent(), tab: await page.title(), flows: gmail.calls.filter(c => c.path === "/profile").length > 0 };

  // the address book: nothing is read for it in the first minutes, and the page keeps when it may
  // start; a build cut short carries on with what is left, a small page at a time, once nobody
  // uses the app (its pages ask for 20 rows, the user's lists for more)
  const abMeta = (op, key, value) => page.evaluate(([op, key, value]) => new Promise((ok, no) => {
    const r = indexedDB.open("baltazar-mail");
    r.onerror = () => no(r.error);
    r.onsuccess = () => {
      const t = r.result.transaction("meta", op === "get" ? "readonly" : "readwrite"), s = t.objectStore("meta");
      const q = op === "get" ? s.get(key) : s.put({ key, value });
      t.oncomplete = () => { r.result.close(); ok(op === "get" ? q.result?.value ?? null : true); };
      t.onerror = () => no(t.error);
    };
  }), [op, key, value]);
  const listsOf = (calls, label, n) => calls.filter(c => c.path === "/messages" && c.q.labelIds === label && (!n || c.q.maxResults === n)).length;
  await page.waitForTimeout(1500);
  results.abWait = { after: (await page.evaluate(async () => (await chrome.storage.local.get("contactsAfter")).contactsAfter)) - Date.now(), sent: listsOf(gmail.calls, "SENT"), built: await abMeta("get", "built") };
  // Contacts says that it is still being built, above whatever it has learned so far
  await page.locator("#list").focus(); await page.keyboard.press("g"); await page.keyboard.press("c");
  await page.waitForFunction(() => !document.getElementById("p-note").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
  results.abNote = { open: await page.locator("#app.contacts-view").count(), shown: await page.locator("#p-note").isVisible(), text: await page.locator("#p-note").textContent() };
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("app").classList.contains("contacts-view"), null, { timeout: 5000 }).catch(() => {});
  await page.waitForSelector("#rows .row", { timeout: 20000 });
  // a build that had read all of Sent before the tab closed
  await abMeta("put", "filling", Date.now());
  await abMeta("put", "fill:SENT", { offset: 8, newest: 1, seen: 3, done: true });
  await page.evaluate(() => chrome.storage.local.set({ contactsAfter: 1 }));
  const callsBeforeBuild = gmail.calls.length;
  // reloaded as a tab in the background, which nobody is using, so the build goes on without a
  // minute's wait for the app to be left alone; the tab shows again once it is built
  await page.addInitScript(() => {
    try {
      if (window.top !== window || !sessionStorage.getItem("hiddenTab")) return;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    } catch {}
  });
  await page.evaluate(() => sessionStorage.setItem("hiddenTab", "1"));
  await page.reload();
  await page.waitForSelector("#rows .row", { timeout: 20000 });
  for (let i = 0; i < 220 && !(await abMeta("get", "built")); i++) await page.waitForTimeout(500);
  await page.evaluate(() => { sessionStorage.removeItem("hiddenTab"); delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); });
  const buildCalls = gmail.calls.slice(callsBeforeBuild);
  results.abBuilt = { built: !!(await abMeta("get", "built")), sent: listsOf(buildCalls, "SENT", "20"), inbox: listsOf(buildCalls, "INBOX", "20"), bookmark: !!(await abMeta("get", "scan:SENT")), filling: await abMeta("get", "filling") };

  // the folder tree: Gmail's labels as folders, Starred after Inbox, All Mail for the archive
  results.tree = { names: await page.locator("#folder-list .folder .nm").allTextContents(), counts: await page.locator("#folder-list .folder .ct").allTextContents(),
    unread: await page.locator("#folder-list .folder.unread .nm").allTextContents(), rows: await page.locator("#rows .row").count(),
    clips: await page.locator("#rows .row .fl").evaluateAll(els => els.map(e => e.innerHTML ? 1 : 0).join("")), unreadRows: await page.locator("#rows .row.unread").count() };

  // reading: the HTML body with its cid image inlined, hostile markup removed, both spacers kept flat
  await page.locator("#rows .row").nth(2).click(); await page.waitForTimeout(800);
  results.read = { subject: await page.locator("#r-subject").textContent(), from: await page.locator("#r-from").textContent(), folder: await page.locator("#r-folder").textContent(), body: (await frameText()).slice(0, 20),
    imgs: await page.frameLocator("#r-body").locator("img").evaluateAll(els => els.map(e => (e.getAttribute("src") || "").slice(0, 22))),
    spacer: await page.frameLocator("#r-body").locator("#spacer").evaluate(e => e.getBoundingClientRect().height),
    spacer2: await page.frameLocator("#r-body").locator("#spacer2").evaluate(e => e.getBoundingClientRect().height),
    csp: await page.frameLocator("#r-body").locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content") };
  // attachments: seven cards, the image with a thumbnail, no converter for the deck
  results.attach = { cards: await page.locator("#r-attach .att-card").count(), labels: await page.locator("#r-attach .att-thumb").allTextContents() };
  await page.waitForFunction(() => document.querySelectorAll("#r-attach .att-thumb img").length === 1, null, { timeout: 5000 }).catch(() => {});
  results.attach.thumbs = await page.locator("#r-attach .att-thumb img").evaluateAll(els => els.map(e => e.src.slice(0, 15)));
  const view = async i => { await page.locator("#r-attach .att-card").nth(i).click(); await page.waitForSelector("#viewer:not(.hidden)"); await page.waitForFunction(() => !document.getElementById("v-body").textContent.startsWith("Loading"), null, { timeout: 15000 }); };
  const next = async name => { await page.locator("#v-next").click(); await page.waitForFunction(n => document.getElementById("v-name").textContent === n && !document.getElementById("v-body").textContent.startsWith("Loading"), name, { timeout: 15000 }); };
  const box = async () => { for (let i = 0; i < 100; i++) { const f = page.frames().find(f => f.url().endsWith("/render.html") && !f.isDetached()); if (f) return f; await page.waitForTimeout(100); } throw new Error("no render frame"); };
  await view(0);
  let f = await box();
  await f.waitForFunction(() => document.querySelector(".pdfViewer .page canvas") && /Quarterly/.test(document.querySelector(".textLayer")?.textContent || ""), null, { timeout: 15000 });
  results.viewer = { pdfPages: await f.evaluate(() => document.querySelectorAll(".pdfViewer .page").length), sandboxFetch: await f.evaluate(async () => { try { await fetch("https://gmail.googleapis.com/sandbox-probe"); return "allowed"; } catch { return "blocked"; } }) };
  // CORS alone would refuse the answer, so what counts is that the request never left the sandbox
  results.viewer.sandboxReached = gmail.calls.some(c => c.path === "/sandbox-probe");
  const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.locator("#v-dl").click();
  const d = await dl;
  results.viewer.download = d ? d.suggestedFilename() + ":" + (fs.statSync(await d.path()).size === fs.statSync(path.join(FX, "report.pdf")).size) : "none";
  await next("data.csv"); results.viewer.csv = await (await box()).evaluate(() => [...document.querySelectorAll("td")].map(t => t.textContent).join(","));
  await next("src.zip"); results.viewer.zip = await (await box()).evaluate(() => [...document.querySelectorAll("td:first-child")].map(t => t.textContent).join(","));
  await next("photo.png"); results.viewer.img = await page.locator("#v-body img.v-img").count();
  await next("cv.docx"); f = await box(); await f.waitForFunction(() => /Jorge Ruiz/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => {}); results.viewer.doc = (await f.evaluate(() => document.body.textContent)).includes("Jorge Ruiz");
  await next("budget.xlsx"); f = await box(); results.viewer.sheet = await f.evaluate(() => [...document.querySelectorAll(".grid td")].map(t => t.textContent).join(","));
  // the deck has no renderer and Gmail no converter: offered as text, since its bytes are text
  await next("deck.pptx");
  await page.waitForSelector("#v-raw", { timeout: 15000 });
  results.viewer.deck = { note: (await page.locator("#v-body").textContent()).slice(0, 60), raw: await page.locator("#v-raw").textContent() };
  await page.locator("#v-raw").click();
  f = await box(); await f.waitForFunction(() => document.querySelector("pre"), null, { timeout: 5000 }).catch(() => {});
  results.viewer.deck.text = await f.evaluate(() => document.querySelector("pre")?.textContent || "");
  results.viewer.deck.label = await f.evaluate(() => document.querySelector(".note")?.textContent || "");
  await f.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitForSelector("#viewer.hidden", { state: "attached", timeout: 5000 }).catch(() => {});
  results.viewer.closed = await page.locator("#viewer").isHidden();

  // the reader's cleaning of a hostile message (Projects)
  await folder("Projects");
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(800);
  results.unsafe = await page.frameLocator("#r-body").locator("body").evaluate(b => {
    const d = b.ownerDocument;
    return { scripts: d.querySelectorAll("script").length, forms: d.querySelectorAll("form, input, button, textarea, select").length, frames: d.querySelectorAll("iframe, object, embed").length,
      refresh: d.querySelectorAll('meta[http-equiv="refresh" i]').length, handlers: [...d.querySelectorAll("*")].flatMap(e => [...e.attributes].filter(a => /^on/i.test(a.name)).map(a => a.name)).length,
      link: (() => { const l = d.getElementById("h-link"); return l && { ping: l.hasAttribute("ping"), target: l.target }; })() };
  }).catch(e => ({ error: e.message }));
  results.unsafe.pwned = await page.evaluate(() => window.pwned ?? null);
  // bidi controls never reach the page (Projects/FPGA)
  await page.locator("#folder-list .folder", { hasText: "Projects" }).locator(".tw").click();
  await folder("FPGA");
  await page.locator("#rows .row").nth(0).click(); await page.waitForTimeout(600);
  results.bidi = await page.evaluate(() => [...document.querySelectorAll("#rows, #r-subject, #r-from, #list-title")].map(e => e.textContent).join(" "));
  await page.locator("#folder-list .folder", { hasText: "Projects" }).locator(".tw").click();

  // Starred: a search across folders, with the label as the folder
  await folder("Starred");
  results.starred = { rows: await page.locator("#rows .row").count(), count: await page.locator("#folder-list .folder.view .ct").textContent(), folders: await page.locator("#rows .row .sb em").allTextContents(), q: gmail.calls.filter(c => c.path === "/messages" && /starred/.test(c.q?.q || "")).at(-1)?.q?.q };

  // search from Projects: the folder and its subfolder by label names, the rest below a divider
  await folder("Projects");
  await page.locator("#search").click(); await page.keyboard.type("Subject");
  results.search = { chip: await page.locator("#search-scope").textContent() };
  await page.keyboard.press("Enter");
  await page.waitForSelector("#rows .elsewhere", { timeout: 8000 });
  const qs = gmail.calls.filter(c => c.path === "/messages" && c.q.q?.includes("Subject")).map(c => c.q);
  results.search.inQ = qs.some(q => q.q === '(label:"Projects" OR label:"Projects/FPGA") Subject');
  results.search.outQ = qs.some(q => q.q === '-label:"Projects" -label:"Projects/FPGA" Subject');
  results.search.title = await page.locator("#list-title").textContent();
  results.search.divider = await page.locator("#rows .elsewhere span").textContent();
  results.search.scoped = await page.locator("#rows .row:not(.else)").count();
  results.search.elseRows = await page.locator("#rows .row.else").count();
  // a compound query goes out as one Gmail query
  await page.locator("#search").click(); await page.keyboard.press("Control+A"); await page.keyboard.type('"Subject" AND m-2 -from:bob'); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("list-title").textContent.startsWith("“\"Subject\" AND m-2"), null, { timeout: 5000 });
  await page.waitForTimeout(500);
  results.search.compound = { q: gmail.calls.filter(c => c.path === "/messages" && /m-2 -from:bob/.test(c.q.q || "")).map(c => c.q.q), tip: await page.locator("#list-title").getAttribute("title"), rows: await page.locator("#rows .row:not(.else)").count() };
  await page.locator("#search").focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  results.search.back = await page.locator("#list-title").textContent();

  // actions with undo: read, star, archive (to All Mail and back), spam, delete, permanent delete
  await folder("Inbox");
  const row = i => page.locator("#rows .row").nth(i);
  // label changes as { ids, addLabelIds, removeLabelIds }, made one message each or in bulk
  const mods = () => gmail.calls.filter(c => c.path === "/messages/batchModify" || /^\/messages\/[^/]+\/modify$/.test(c.path)).map(c => c.path.endsWith("/modify") ? { ids: [c.path.split("/")[2]], ...c.body } : c.body);
  await row(0).click(); await page.waitForTimeout(700);
  const n0 = mods().length;
  await page.locator("#list").focus(); await page.keyboard.press("u"); await page.waitForTimeout(500);
  results.actions = { inboxUnread: [...gmail.messages.values()].filter(m => m.labelIds.includes("INBOX") && m.labelIds.includes("UNREAD")).length, readCall: mods()[n0], readRow: await row(0).evaluate(e => e.classList.contains("unread")), inboxCount: await page.locator("#folder-list .folder", { hasText: "Inbox" }).locator(".ct").textContent() };
  await page.keyboard.press("s"); await page.waitForTimeout(500);
  results.actions.starCall = mods().at(-1);
  results.actions.starOn = await row(0).locator(".st.on").count();
  const rowsBefore = await page.locator("#rows .row").count();
  const archivedSubject = await page.locator("#r-subject").textContent();
  await page.keyboard.press("e");
  await page.waitForFunction(n => document.querySelectorAll("#rows .row").length === n - 1, rowsBefore, { timeout: 5000 });
  results.actions.archive = { call: mods().at(-1), undo: await page.locator('#st-acts [data-act="undo"]').getAttribute("title"), rows: await page.locator("#rows .row").count() };
  await page.keyboard.press("z");
  await page.waitForFunction(n => document.querySelectorAll("#rows .row").length === n, rowsBefore, { timeout: 5000 });
  await page.waitForFunction(s => document.getElementById("r-subject").textContent === s, archivedSubject, { timeout: 4000 }).catch(() => {});
  results.actions.undone = { call: mods().at(-1), subject: await page.locator("#r-subject").textContent(), was: archivedSubject };
  await page.keyboard.press("!"); await page.waitForTimeout(600);
  results.actions.spam = { call: mods().at(-1), undo: await page.locator('#st-acts [data-act="undo"]').getAttribute("title") };
  await page.keyboard.press("z"); await page.waitForTimeout(800);
  await page.keyboard.press("#"); await page.waitForTimeout(600);
  results.actions.trash = { call: mods().at(-1), rows: await page.locator("#rows .row").count() };
  // the reader's Undelete moves a message from Trash to Inbox
  await folder("Trash");
  await page.locator("#rows .row").first().click(); await page.waitForTimeout(500);
  const undel = { label: await page.locator("#r-delete").textContent(), rows: await page.locator("#rows .row").count() };
  await page.locator("#r-delete").click(); await page.waitForTimeout(600);
  results.actions.undelete = { ...undel, call: mods().at(-1), rowsAfter: await page.locator("#rows .row").count(), undo: await page.locator('#st-acts [data-act="undo"]').getAttribute("title") };
  await page.locator("#list").focus(); await page.keyboard.press("z");
  await page.waitForFunction(n => document.querySelectorAll("#rows .row").length === n, undel.rows, { timeout: 5000 }).catch(() => {});
  // in Trash, delete is for good, after asking
  await page.locator("#rows .row").first().click(); await page.waitForTimeout(500);
  page.once("dialog", d => d.accept());
  const trashRows = await page.locator("#rows .row").count();
  await page.locator("#list").focus(); await page.keyboard.press("#");
  await page.waitForFunction(n => document.querySelectorAll("#rows .row").length === n - 1, trashRows, { timeout: 5000 }).catch(() => {});
  results.actions.forever = { deleted: gmail.calls.some(c => c.path === "/messages/batchDelete"), rows: trashRows - await page.locator("#rows .row").count(), undo: await page.locator('#st-acts [data-act="undo"]').getAttribute("title") };
  // Empty Trash and Mark all read from the folder menus
  page.once("dialog", d => d.accept());
  await page.locator("#folder-list .folder", { hasText: "Trash" }).click({ button: "right" });
  await menu("empty");
  await page.waitForFunction(() => document.querySelector("#rows .list-empty"), null, { timeout: 8000 }).catch(() => {});
  results.folderOps = { emptied: await page.locator("#rows .list-empty").count() === 1 && ![...gmail.messages.values()].some(m => m.labelIds.includes("TRASH")), trashCount: await page.locator("#folder-list .folder", { hasText: "Trash" }).locator(".ct").textContent() };
  await page.locator("#folder-list .folder", { hasText: "Projects" }).first().click({ button: "right" });
  await menu("mark-read");
  // the status is read once it shows: a refresh of the Trash list could replace it
  await page.waitForFunction(() => /^marked Projects read/.test(document.getElementById("st-msg").textContent), null, { timeout: 4000 }).catch(() => {});
  results.folderOps.markRead = { status: await page.locator("#st-msg").textContent(), unreadLeft: [...gmail.messages.values()].filter(m => m.labelIds.includes("Label_1") && m.labelIds.includes("UNREAD")).length };
  // create, rename (cascading to the subfolder), move and delete folders
  await page.locator("#folder-list .folders-head").click({ button: "right" });
  await menu("new", 0);
  await page.waitForSelector("#promptbox:not(.hidden)");
  await page.keyboard.type("Zeta"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#folder-list .folder .nm")].some(e => e.textContent === "Zeta"), null, { timeout: 5000 });
  await page.locator("#folder-list .folder", { hasText: "Projects" }).first().click({ button: "right" });
  await menu("rename", 0);
  await page.waitForSelector("#promptbox:not(.hidden)");
  await page.keyboard.press("Control+A"); await page.keyboard.type("Work"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#folder-list .folder .nm")].some(e => e.textContent === "Work"), null, { timeout: 5000 });
  await page.locator("#folder-list .folder", { hasText: "Work" }).first().locator(".tw").click();
  await page.waitForTimeout(300);
  results.folderOps.renamed = { names: await page.locator("#folder-list .folder .nm").allTextContents(), labels: gmail.labels.filter(l => l.type === "user").map(l => l.name) };
  await page.locator("#folder-list .folder", { hasText: "Work" }).first().locator(".tw").click();
  page.once("dialog", d => d.accept());
  await page.locator("#folder-list .folder", { hasText: "Zeta" }).click({ button: "right" });
  await menu("delete");
  await page.waitForFunction(() => ![...document.querySelectorAll("#folder-list .folder .nm")].some(e => e.textContent === "Zeta"), null, { timeout: 5000 }).catch(() => {});
  results.folderOps.deleted = !gmail.labels.some(l => l.name === "Zeta") && !(await page.locator("#folder-list .folder .nm").allTextContents()).includes("Zeta");

  // All Mail lists every message, each placed by its labels: archive there takes a message out
  // of Inbox and leaves its row, and undo puts it back
  await folder("All Mail");
  await page.locator("#rows .row", { hasText: "Subject m-4" }).click(); await page.waitForTimeout(600);
  const allRows = await page.locator("#rows .row").count(), allMods = mods().length;
  results.allMail = { shownIn: await page.locator("#r-folder").textContent() };
  await page.locator("#list").focus(); await page.keyboard.press("e");
  await page.waitForFunction(() => /^archived|^already/.test(document.getElementById("st-msg").textContent), null, { timeout: 5000 }).catch(() => {});
  Object.assign(results.allMail, { status: await page.locator("#st-msg").textContent(), call: mods().slice(allMods).at(-1) ?? null, rows: await page.locator("#rows .row").count() - allRows, inbox: gmail.messages.get("m4").labelIds.includes("INBOX") });
  await page.keyboard.press("z");
  await page.waitForFunction(() => /^undone/.test(document.getElementById("st-msg").textContent), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  results.allMail.undone = gmail.messages.get("m4").labelIds.includes("INBOX");

  // contact card: recent mail with the person, through the search
  await folder("Inbox");
  await page.locator("#rows .row", { hasText: "Subject m-2" }).click(); await page.waitForTimeout(600);
  await page.locator("#r-from .who").first().hover();
  await page.waitForSelector("#card:not(.hidden)", { timeout: 4000 });
  await page.waitForSelector("#card .card-recent div", { timeout: 4000 }).catch(() => {});
  results.card = { head: await page.locator("#card .card-head").textContent(), recent: await page.locator("#card .card-recent div").count(), q: gmail.calls.find(c => c.path === "/messages" && /from:s2@x\.com/.test(c.q.q || ""))?.q?.q };
  await page.mouse.move(5, 600); await page.waitForTimeout(400);

  // print: the open message, images embedded only
  const [printPage] = await Promise.all([ctx.waitForEvent("page"), page.keyboard.press("p")]);
  await printPage.waitForSelector(".msg .body", { timeout: 8000 });
  results.print = { body: (await printPage.locator(".msg .body p").first().innerText()).slice(0, 12), csp: await printPage.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content),
    referrer: await printPage.evaluate(() => document.querySelector('meta[name="referrer"]')?.content),
    imgs: await printPage.evaluate(() => [...document.querySelector(".msg .body").shadowRoot.querySelectorAll("img")].map(i => (i.getAttribute("src") || "").slice(0, 15))) };
  await printPage.close(); await page.bringToFront();

  // reply: the quote, the thread and the chained headers
  await page.locator("#rows .row", { hasText: "Subject m-3" }).click(); await page.waitForTimeout(600);
  await page.locator("#list").focus(); await page.keyboard.press("r"); await page.waitForSelector("#compose:not(.hidden)");
  results.reply = { title: await page.locator("#c-title").textContent(), to: (await page.locator("#c-to .chip").allTextContents()).join(" | "), subject: await page.inputValue("#c-subject") };
  await page.locator("#c-editor").focus(); await page.keyboard.type("Thanks!");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Sending in"));
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 10000 });
  const reply = lastUpload();
  results.reply.upload = { path: reply.path, meta: reply.meta, headers: headersOf(reply), parts: partsOf(reply), quoted: /Body of/.test(reply.raw), cid: /cid:/.test(reply.raw) };

  // forward: the original's files travel again as parts
  await page.locator("#rows .row", { hasText: "Subject m-3" }).click(); await page.waitForTimeout(600);
  await page.locator("#list").focus(); await page.keyboard.press("f"); await page.waitForSelector("#compose:not(.hidden)");
  results.fwd = { chips: await page.locator("#c-filelist .c-file").allTextContents() };
  await page.locator("#c-to input").type("fwd@example.com"); await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 15000 });
  results.fwd.parts = partsOf(lastUpload());
  results.fwd.meta = lastUpload().meta;

  // the attachment limit: a file attached again counts once, and a drop reports what it attached
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  const MB = 1048576;
  const drop = files => page.evaluate(files => {
    const dt = new DataTransfer();
    for (const [name, size] of files) dt.items.add(new File([new Uint8Array(size)], name, { type: "application/octet-stream" }));
    const ed = document.getElementById("c-editor"), r = ed.getBoundingClientRect();
    ed.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 12 }));
    const notice = document.getElementById("notice");
    return { status: document.getElementById("st-msg").textContent, notice: notice.classList.contains("hidden") ? "" : document.getElementById("notice-text").textContent, chips: document.querySelectorAll("#c-filelist .c-file").length };
  }, files);
  results.attachLimit = { first: await drop([["a.bin", 13 * MB], ["small.txt", 10]]), again: await drop([["a.bin", 13 * MB]]), mixed: await drop([["a.bin", 13 * MB], ["b.txt", 20]]), over: await drop([["c.bin", 13 * MB], ["d.txt", 30]]) };
  page.once("dialog", d => d.accept());
  await page.click("#c-discard");
  await page.waitForFunction(() => document.getElementById("compose").classList.contains("hidden"), null, { timeout: 8000 });

  // new message with an attachment and an inline image: held, cancelled, then sent
  await page.locator("#list").focus(); await page.keyboard.press("c"); await page.waitForSelector("#compose:not(.hidden)");
  await page.locator("#c-to input").type("Alice <alice@example.com>, bob@example.com"); await page.keyboard.press("Tab");
  await page.fill("#c-subject", "Gmail runtime test");
  await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.type("Hello from the Gmail runtime test.");
  await page.setInputFiles("#c-files", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("attached text") });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  await page.locator("#c-editor").click({ position: { x: 300, y: 12 } });
  await page.setInputFiles("#c-imgfile", { name: "shot.png", mimeType: "image/png", buffer: png });
  await page.waitForSelector("#c-editor img");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-undo").textContent.startsWith("Sending in"));
  results.send = { pending: await page.locator("#st-undo").textContent() };
  await page.keyboard.press("z");
  await page.waitForSelector("#compose:not(.hidden)");
  results.send.afterCancel = { to: (await page.locator("#c-to .chip").allTextContents()).join(" | "), files: await page.locator("#c-filelist").textContent() };
  const uploadsBefore = gmail.uploads.length;
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("st-msg").textContent.startsWith("sent"), null, { timeout: 15000 });
  const sent = lastUpload();
  results.send.upload = { path: sent.path, headers: headersOf(sent), parts: partsOf(sent), cid: /src=(3D)?"cid:/.test(sent.raw), uploads: gmail.uploads.length - uploadsBefore, sentLabel: [...gmail.messages.values()].some(m => m.labelIds.includes("SENT") && m.payload.headers.some(x => x.name === "Subject" && x.value === "Gmail runtime test")) };
  results.send.closed = await page.locator("#compose").isHidden();

  // a draft: opened with its file and inline image, saved again under the same draft id with a
  // new message id, reopened, discarded
  await folder("Drafts");
  const draftRowsBefore = await page.locator("#rows .row").count();
  await page.locator("#rows .row", { hasText: "Re: Subject m-3" }).first().click();
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 });
  results.draft = { title: await page.locator("#c-title").textContent(), chips: await page.locator("#c-filelist .c-file").allTextContents(), to: (await page.locator("#c-to .chip").allTextContents()).join(" | "),
    imgs: await page.locator("#c-editor img").evaluateAll(els => els.map(e => (e.getAttribute("src") || "").slice(0, 15))),
    overlay: await page.evaluate(() => { const b = [...document.querySelectorAll("#c-editor div")].find(d => d.textContent === "Session expired"); return b ? getComputedStyle(b).position : "gone"; }) };
  await page.locator("#c-editor").click({ position: { x: 20, y: 12 } }); await page.keyboard.type("edited ");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("compose").classList.contains("hidden"), null, { timeout: 8000 });
  await page.waitForTimeout(800);
  const saved = lastUpload();
  results.draft.save = { path: saved.path, method: saved.method, meta: saved.meta, parts: partsOf(saved), headers: headersOf(saved), edited: /edited/.test(saved.raw), rows: await page.locator("#rows .row").count(), rowsBefore: draftRowsBefore, drafts: gmail.drafts.map(d => d.id) };
  await page.locator("#rows .row", { hasText: "Re: Subject m-3" }).first().click();
  await page.waitForSelector("#compose:not(.hidden)", { timeout: 15000 });
  results.draft.reopened = { chips: await page.locator("#c-filelist .c-file").allTextContents(), text: (await page.locator("#c-editor").innerText()).slice(0, 20) };
  page.once("dialog", d => d.accept());
  await page.click("#c-discard");
  await page.waitForFunction(() => !document.querySelector("#rows .row"), null, { timeout: 8000 }).catch(() => {});
  results.draft.discarded = { deleteCall: gmail.calls.filter(c => c.method === "DELETE" && /^\/drafts\//.test(c.path)).map(c => c.path), rows: await page.locator("#rows .row").count(), drafts: gmail.drafts.length };

  // address book: learned from Sent, Inbox and All Mail through the API's pages, and listed by Contacts, which
  // no longer says it is being built; Settings has the sign-out button and nothing about the book
  await page.locator("#list").focus(); await page.keyboard.press("g"); await page.keyboard.press("c");
  await page.waitForSelector("#app.contacts-view #p-rows .prow", { timeout: 5000 }).catch(() => {});
  results.ab = { learned: await page.evaluate(async () => (await (await import("./contacts.js")).all()).length), listed: await page.locator("#p-rows .prow").count(), note: await page.locator("#p-note").isVisible() };
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("app").classList.contains("contacts-view"), null, { timeout: 5000 }).catch(() => {});
  await page.waitForSelector("#rows .row", { timeout: 20000 }).catch(() => {});
  await page.locator("#list").focus(); await page.keyboard.press(",");
  await page.waitForSelector("#settings:not(.hidden)", { timeout: 5000 }).catch(() => {});
  Object.assign(results.ab, { section: await page.locator("#ab-summary, #ab-open").count(), signOut: await page.locator("#signout").isVisible(), version: await page.locator("#app-version").textContent() });
  await page.keyboard.press("Escape");

  // new mail while the tab is in the background: history names Inbox, the count rises, the dot shows
  await folder("Inbox");
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }));
  gmail.deliver("m99", "Fresh mail");
  await page.waitForFunction(() => document.querySelector('link[rel="icon"]').href.startsWith("data:image/png"), null, { timeout: 15000 }).catch(() => {});
  const dotted = await page.evaluate(() => document.querySelector('link[rel="icon"]').href);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForFunction(() => [...document.querySelectorAll("#rows .row .sb")].some(e => e.textContent.startsWith("Fresh mail")), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  results.newMail = { title: await page.title(), unread: [...gmail.messages.values()].filter(m => m.labelIds.includes("INBOX") && m.labelIds.includes("UNREAD")).length, dotted: dotted.slice(0, 22), listed: await page.locator("#rows .row .sb", { hasText: "Fresh mail" }).count(), history: gmail.calls.filter(c => c.path === "/history").length > 0 };

  // Gmail refuses a request for the quota of its minute: the status bar says what is waited for
  // and how long, an action tried meanwhile says it too, and a click on the time at the right
  // copies the session's requests and waits, with nothing of the mail in them
  const statusSays = () => page.locator("#st-msg").textContent();
  const starDone = () => page.waitForFunction(() => /^(un)?starred 1 message/.test(document.getElementById("st-msg").textContent), null, { timeout: 15000 }).catch(() => {});
  await page.locator("#rows .row", { hasText: "Fresh mail" }).click();
  await page.waitForTimeout(3000);                 // the message is marked read, and its action is over
  await page.evaluate(() => { window.copied = []; navigator.clipboard.writeText = async t => { window.copied.push(t); }; });
  gmail.fail = { status: 429, times: 1, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }],
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "6000", window_start_time: String(Math.floor(Date.now() / 1000) - 54) } }] } } };
  await page.locator("#list").focus(); await page.keyboard.press("s");
  await page.waitForSelector("#st-wait:not(.hidden)", { timeout: 5000 }).catch(() => {});
  results.waits = { said: await page.locator("#st-wait").textContent() };
  await page.keyboard.press("u");
  results.waits.busy = await statusSays();
  await starDone();
  await page.waitForFunction(() => document.getElementById("st-wait").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
  Object.assign(results.waits, { done: await statusSays(), hidden: await page.locator("#st-wait").isHidden(), unread: gmail.messages.get("m99").labelIds.includes("UNREAD") });
  await page.locator("#st-lat").click();
  await page.waitForFunction(() => window.copied.length > 0, null, { timeout: 3000 }).catch(() => {});
  Object.assign(results.waits, { copied: (await page.evaluate(() => window.copied))[0] || "", copiedSaid: await statusSays() });
  await page.locator("#list").focus(); await page.keyboard.press("s");
  await starDone();

  // A sender's style sheet loses the rules that read the message (an attribute selector, :has()),
  // also inside a media query, and a sheet without any stays as written; a string that would end
  // the style element once the browser has written the sheet back ends nothing. The remote
  // picture is asked for without a referrer, and nothing else is.
  const SHEET = ".keep { color: rgb(1, 2, 3) } a[href*=\"token\"] { background: url(https://leak.example/attr.png) } div:has(> a) { background: url(https://leak.example/has.png) }" +
    " @media screen { [data-x] .y { color: red } .kept-in-media { color: blue } } .s::after { content: \"\\3c /style>\\3c b id=broke>x\\3c /b>\" }";
  const PLAIN_SHEET = ".plain{color:#123456}/* as written */";
  gmail.addMessage({ id: "css1", labels: ["Label_5"], subject: "Styled", from: "\"Styler\" <styler@x.com>", cc: "", inline: [],
    html: "<style>" + SHEET + "</style><style>" + PLAIN_SHEET + "</style><div><a href=\"https://site.example/reset?token=SECRET\">reset</a></div><div class=\"keep s\">kept</div><img id=\"remote\" src=\"https://img.example/photo.png\" width=\"40\" height=\"30\">" });
  // More references to parts the message does not have than the 60 it may fetch, before its own picture.
  gmail.addMessage({ id: "cap1", labels: ["Label_5"], subject: "Many pictures", from: "\"Styler\" <styler@x.com>", cc: "",
    html: Array.from({ length: 70 }, (_, i) => "<img src=\"cid:none-" + i + "@x\" width=\"1\" height=\"1\">").join("") + "<img id=\"own\" src=\"cid:cap1-pic@x\">" });
  gmail.addMessage({ id: "svg1", labels: ["Label_5"], subject: "Vector", from: "\"Styler\" <styler@x.com>", cc: "", html: "<p>See the logo.</p>", inline: [],
    files: [{ name: "logo.svg", type: "image/svg+xml", bytes: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"20\"><rect width=\"40\" height=\"20\" fill=\"#c00\"/><script>window.ran = 1</script></svg>") }] });
  await page.locator("#folder-list .folder", { hasText: "Travel" }).first().locator(".tw").click();
  await folder("2025");
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const policies = [];
  cdp.on("Network.requestWillBeSent", e => { if (e.request.url.startsWith("https://img.example/")) policies.push(e.request.referrerPolicy); });
  await page.locator("#rows .row", { hasText: "Styled" }).click();
  await page.waitForFunction(() => document.getElementById("r-subject").textContent === "Styled", null, { timeout: 8000 });
  for (let i = 0; i < 50 && !gmail.images.length; i++) await page.waitForTimeout(100);
  const styled = page.frameLocator("#r-body");
  results.css = { sheets: (await styled.locator("style").evaluateAll(els => els.map(e => e.textContent))).slice(1), broke: await styled.locator("#broke").count(),
    kept: await styled.locator(".keep").evaluate(e => getComputedStyle(e).color), referrer: await styled.locator('meta[name="referrer"]').getAttribute("content"),
    page: await page.evaluate(() => document.querySelector('meta[name="referrer"]')?.content), images: gmail.images.map(i => [i.url, i.from, i.referer]), policies };
  await cdp.detach();
  await page.locator("#rows .row", { hasText: "Many pictures" }).click();
  await page.waitForFunction(() => document.getElementById("r-subject").textContent === "Many pictures", null, { timeout: 8000 });
  await page.waitForTimeout(500);
  results.cap = { own: ((await page.frameLocator("#r-body").locator("#own").getAttribute("src")) || "").slice(0, 14), others: await page.frameLocator("#r-body").locator('img[src^="cid:"]').count() };
  // An SVG attachment is shown as a bitmap of itself, so the picture opened in a tab is a PNG,
  // not a document of the sender's under the extension's address.
  await page.locator("#rows .row", { hasText: "Vector" }).click();
  await page.waitForFunction(() => document.getElementById("r-subject").textContent === "Vector", null, { timeout: 8000 });
  await page.waitForSelector("#r-attach .att-card");
  await view(0);
  await page.waitForSelector("#v-body img.v-img", { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector("#v-body img.v-img").naturalWidth > 0, null, { timeout: 8000 }).catch(() => {});
  results.svg = await page.evaluate(() => { const i = document.querySelector("#v-body img.v-img"); return { width: i.naturalWidth, height: i.naturalHeight, blob: i.src.startsWith("blob:"), density: /^blob:\S+ [\d.]+x$/.test(i.srcset) }; });
  const [svgTab] = await Promise.all([ctx.waitForEvent("page"), page.evaluate(() => { window.open(document.querySelector("#v-body img.v-img").src, "_blank"); })]);
  await svgTab.waitForLoadState();
  results.svg.opened = await svgTab.evaluate(() => document.contentType);
  await svgTab.close(); await page.bringToFront();
  await page.keyboard.press("Escape");
  await page.waitForSelector("#viewer.hidden", { state: "attached", timeout: 5000 }).catch(() => {});

  // Files: a folder's attachments listed from its search rows, with no message body fetched; an
  // empty folder says its subfolder is not included, and Subfolders adds it by label name; a
  // file's message shows on a click and the file previews through attachments.get; Esc goes back
  // to the folder's messages
  {
    const f = results.files = {};
    // the oldest file, in a message also in Inbox: its row is shown in Inbox, its file is Travel/2025's
    gmail.addMessage({ id: "both1", labels: ["INBOX", "Label_5"], subject: "Both", from: "\"Agent\" <agent@x.com>", cc: "", html: "<p>Your seat.</p>", inline: [],
      date: Math.floor(Date.now() / 1000) - 10 ** 7, files: [{ name: "ticket.txt", type: "text/plain", bytes: Buffer.from("seat 12A") }] });
    const travel = page.locator("#folder-list .folder", { hasText: "Travel" }).first();
    const lists = from => gmail.calls.slice(from).filter(c => c.path === "/messages" && c.method === "GET").map(c => c.q);
    const c0 = gmail.calls.length;
    await travel.click({ button: "right" });
    await menu("files", 800);
    f.empty = await page.locator("#f-rows .list-empty").textContent().catch(() => "");
    f.q0 = lists(c0)[0];
    const c1 = gmail.calls.length;
    await page.locator("#f-subs-box").click();
    await page.waitForSelector("#f-rows .frow", { timeout: 5000 }).catch(() => {});
    f.q1 = lists(c1)[0]?.q;
    f.bodies = gmail.calls.slice(c0).filter(c => /^\/messages\/[^/]+$/.test(c.path) && c.q?.fields === "id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload").length;
    f.rows = await page.locator("#f-rows .frow .fn").allTextContents();
    f.tiles = await page.locator("#f-rows .frow .ft").allTextContents();
    // the second file, report.pdf of v3 (the SVG test's Vector message, also in Travel/2025, comes first)
    await page.locator("#f-rows .frow").nth(1).click();
    await page.waitForFunction(() => document.getElementById("r-subject").textContent === "Subject v-3", null, { timeout: 8000 }).catch(() => {});
    f.subject = await page.locator("#r-subject").textContent();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#v-body .v-box", { timeout: 8000 }).catch(() => {});
    f.viewer = { name: await page.locator("#v-name").textContent(), meta: await page.locator("#v-meta").textContent(), fetched: gmail.calls.slice(c1).some(c => /\/attachments\//.test(c.path)) };
    await viewerKey(page, "Escape");
    await page.waitForSelector("#viewer.hidden", { state: "attached", timeout: 5000 }).catch(() => {});
    await page.keyboard.press("Escape"); await page.waitForTimeout(800);
    f.off = { pane: await page.locator("#files-pane").isVisible(), title: await page.locator("#list-title").textContent() };
    // the choice was Travel's, and it goes with the account at sign-out below
    f.saved = await page.evaluate(async () => Object.values((await chrome.storage.local.get("folderFiles")).folderFiles || {}).map(a => Object.keys(a)));
  }

  // sign out: asked first, and Cancel changes nothing; once confirmed the token is revoked and
  // forgotten, and the sign-in page comes back
  await page.locator("#list").focus(); await page.keyboard.press(",");
  let asked = "";
  page.once("dialog", d => { asked = d.message(); d.dismiss(); });
  await page.locator("#signout").click();
  await page.waitForTimeout(500);
  results.signOutDeclined = { asked, settings: await page.locator("#settings").isVisible(), app: await page.locator("#app").isVisible(), revoked: gmail.calls.some(c => c.path === "/revoke") };
  page.once("dialog", d => d.accept());
  await page.locator("#signout").click();
  await page.waitForSelector("#signin:not(.hidden)", { timeout: 8000 });
  await page.waitForSelector("#signin-text:has-text('Sign in with your')", { timeout: 5000 }).catch(() => {});
  results.signOut = { panel: await page.locator("#signin-none").isVisible(), app: await page.locator("#app").isHidden(), revoked: gmail.calls.some(c => c.path === "/revoke"), token: await page.evaluate(async () => (await chrome.storage.session.get("gmToken")).gmToken ?? null),
    guide: await page.locator("#signin-guide").isHidden(), text: await page.locator("#signin-text").textContent(), button: await page.locator("#retry").textContent(), reset: await page.locator("#signin-reset").isVisible(),
    notes: await page.locator("#signin-notes li").count(), client: await page.evaluate(async () => (await chrome.storage.local.get("gmClientId")).gmClientId),
    files: await page.evaluate(async () => (await chrome.storage.local.get("folderFiles")).folderFiles ?? null) };
  await page.locator("#signin-trouble").click();
  results.signOut.help = await page.locator("#signin-help:not(.hidden) .g-help-item").count();

  // only the button starts a sign-in: none since the mailbox loaded, and one, for the user's client, once it is pressed
  const flowsBefore = gmail.signIns.length;
  await page.locator("#retry").click();
  for (let i = 0; i < 50 && gmail.signIns.length === flowsBefore; i++) await page.waitForTimeout(100);
  await page.waitForSelector("#signin-alert:not(.hidden)", { timeout: 8000 }).catch(() => {});
  results.signInFlows = { before: gmail.signIns.slice(flowsAtMailbox, flowsBefore), pressed: gmail.signIns.slice(flowsBefore), panel: await page.locator("#signin").isVisible(), alert: await page.locator("#signin-alert").isVisible() };

  results.cspViolations = cspViolations;
  console.log(JSON.stringify(results, null, 1));
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });

  expect(h.firstRun === 1, "the first install opened the mail tab once: " + h.firstRun);
  const s = results.signIn;
  expect(s.title === "Baltazar Mail for Gmail™" && /^Welcome! .*Gmail™.*Google™.*Client ID/.test(s.text) && s.app && s.tab === "Baltazar Mail for Gmail™" && s.brand === "Baltazar Mail for Gmail™" && s.fails &&
    s.steps === "create:now,paste:todo,api:todo,signin:todo" && s.copy === REDIRECT && s.open === "https://console.cloud.google.com/auth/overview/personal" && !s.button && s.flows === 0 && extId === "enejfhgeailmbkfpdgfdlajlfhnnbafd",
    "without a Google client the sign-in page is the guide, for this copy's redirect address and the id the committed key pins: " + JSON.stringify({ s, extId }));
  expect(results.copied.values.join() === REDIRECT && results.copied.label === "Copied" && results.opened.url === s.open && results.opened.noted.includes(s.open), "the address is copied, and Google's page opens in a tab of its own: " + JSON.stringify([results.copied, results.opened]));
  const ps = results.paste, kb = results.keys;
  expect(results.pasteStep.steps === "create:done,paste:now,api:todo,signin:todo" && results.pasteStep.focus === "paste" && kb.compose && kb.settings && kb.help && kb.typed === "c,?t", "the next step opens with the focus, and keys typed into it are not shortcuts: " + JSON.stringify([results.pasteStep, kb]));
  expect(/redirect address/.test(ps.redirect.msg) && !ps.redirect.ok && /client secret/.test(ps.secret.msg) && !ps.secret.ok && /That is a Client ID/.test(ps.good.msg) && ps.good.ok, "the paste box says what was pasted: " + JSON.stringify(ps));
  expect(results.apiStep.steps === "create:done,paste:done,api:now,signin:todo" && results.apiStep.open === "https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=123456789012" && results.apiStep.focus === "api" && results.resumed.steps === results.apiStep.steps,
    "a Client ID leads to the Gmail API of its project, and a reload carries on there: " + JSON.stringify([results.apiStep, results.resumed]));
  expect(results.signinStep.steps.endsWith("signin:now") && results.signinStep.button && results.signinStep.label === "Sign in with Google" && results.signinStep.notes === 3, "the last step holds the sign-in button and what Google will ask: " + JSON.stringify(results.signinStep));
  const cl = results.closed;
  expect(cl.flows.length === 1 && cl.flows[0].interactive && cl.flows[0].prompt === "select_account consent" && cl.flows[0].client === CID && cl.flows[0].redirect === REDIRECT && /closed before/.test(cl.alert) && cl.help === 10 && cl.enabled && cl.steps.endsWith("signin:now"),
    "a window closed before the end is explained, with what Google may have said, and the page stays: " + JSON.stringify(cl));
  expect(/Gmail API is still off/.test(results.apiOff.alert) && results.apiOff.link === "https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=123456789012" && results.apiOff.button === "Continue" && results.continued.flows === 0 && results.continued.setup === null && results.continued.client === CID,
    "the Gmail API being off is named and linked, and Continue signs in with the token Google gave, without a window: " + JSON.stringify([results.apiOff, results.continued]));
  const aw = results.abWait, abb = results.abBuilt;
  expect(aw.after > 90e3 && aw.after <= 120e3 && aw.sent === 0 && !aw.built, "the address book is not built in the first minutes, and when it may start is kept: " + JSON.stringify(aw));
  expect(abb.built && abb.sent === 0 && abb.inbox === 1 && abb.bookmark && abb.filling === null, "a build cut short carries on with what is left, in small pages, once the app is left alone: " + JSON.stringify(abb));
  expect(results.signedIn.account === "me@gmail.com" && /Baltazar Mail for Gmail™$/.test(results.signedIn.tab), "signed in with the planted token: " + JSON.stringify(results.signedIn));
  const t = results.tree;
  expect(t.names.join(",") === "Inbox,Starred,Drafts,Sent,All Mail,Spam,Trash,Projects,Travel" && t.unread.join() === "Inbox,Projects" && t.counts.join() === "4,2,1,8,32,2,1,3," && t.rows === 8 && t.clips === "00100100" && t.unreadRows === 4, "folder tree from labels: " + JSON.stringify(t));
  const r = results.read;
  expect(r.subject === "Subject m-3" && r.from.includes("s3@x.com") && r.folder === "Inbox" && r.body.startsWith("Body of") && r.imgs[0]?.startsWith("data:image/png") && r.imgs[1]?.startsWith("data:image/png") && r.spacer <= 2 && r.spacer2 <= 6 && /img-src https: data:/.test(r.csp), "reading with the cid image inlined: " + JSON.stringify(r));
  expect(results.attach.cards === 7 && results.attach.labels.join(",") === "PDF,CSV,ZIP,,DOC,XLS,PPT" && results.attach.thumbs.length === 1 && results.attach.thumbs[0].startsWith("data:image/png"), "attachment strip: " + JSON.stringify(results.attach));
  const v = results.viewer;
  expect(v.pdfPages === 2 && v.sandboxFetch === "blocked" && !v.sandboxReached && v.download === "report.pdf:true" && v.csv === "Z80,2,6502,1" && v.zip.includes("src/main.c") && v.img === 1 && v.doc && v.sheet === "Item,Cost,Z80,2.5,6502,1.25", "viewer through attachments.get: " + JSON.stringify(v));
  expect(/^No preview available for this file\. /.test(v.deck.note) && v.deck.raw === "View as text" && v.deck.text === "not really a deck" && v.deck.label === "" && v.closed, "no converter: the deck is offered as text: " + JSON.stringify(v.deck));
  const u = results.unsafe;
  expect(!u.error && !u.scripts && !u.forms && !u.frames && !u.refresh && !u.handlers && u.link && !u.link.ping && u.link.target === "_blank" && u.pwned === null, "the reader cleans the sender's own HTML: " + JSON.stringify(u));
  expect(!/[‪-‮⁦-⁩]/.test(results.bidi) && results.bidi.includes("Pay eulav") && results.bidi.includes("Bobevil"), "bidi controls removed: " + JSON.stringify(results.bidi));
  expect(results.starred.rows === 2 && results.starred.count === "2" && results.starred.folders.join() === "Projects/FPGA,Inbox" && results.starred.q === "is:starred", "starred view: " + JSON.stringify(results.starred));
  const q = results.search;
  expect(q.chip === "in Projects" && q.inQ && q.outQ && q.title === "“Subject” in Projects" && q.scoped === 5 && /\d+ matches in other folders/.test(q.divider) && q.elseRows >= 20 && q.back === "Projects", "scoped search by label names: " + JSON.stringify(q));
  expect(q.compound.q.includes('(label:"Projects" OR label:"Projects/FPGA") Subject m-2 -from:bob') && q.compound.tip === "Searched for: Subject AND m-2 AND NOT from:bob" && q.compound.rows === 0, "a compound search is one Gmail query: " + JSON.stringify(q.compound));
  const a = results.actions;
  expect(a.readCall?.removeLabelIds?.join() === "UNREAD" && !a.readRow && a.inboxCount === String(a.inboxUnread) && a.starCall?.addLabelIds?.join() === "STARRED" && a.starOn === 1, "read and star: " + JSON.stringify([a.readCall, a.readRow, a.inboxCount, a.inboxUnread, a.starCall, a.starOn]));
  expect(a.archive.call?.removeLabelIds?.join() === "INBOX" && a.archive.call.addLabelIds.length === 0 && a.archive.undo.startsWith(`Undo: archive "${a.undone.was}" from `) && a.archive.rows === 7 && a.undone.call?.addLabelIds?.join() === "INBOX" && a.undone.subject === a.undone.was, "archive to All Mail and back: " + JSON.stringify([a.archive, a.undone]));
  expect(a.spam.call?.addLabelIds?.join() === "SPAM" && a.spam.call.removeLabelIds.join() === "INBOX" && /as spam/.test(a.spam.undo) && a.trash.call?.addLabelIds?.join() === "TRASH" && a.trash.rows === 7, "spam and trash are label moves: " + JSON.stringify([a.spam, a.trash]));
  expect(a.forever.deleted && a.forever.rows === 1, "delete from Trash is for good: " + JSON.stringify(a.forever));
  const fo = results.folderOps;
  expect(a.undelete.label === "Undelete" && a.undelete.call?.addLabelIds?.join() === "INBOX" && a.undelete.call.removeLabelIds.join() === "TRASH" && a.undelete.rowsAfter === a.undelete.rows - 1 && /^Undo: restore "[^"]*" (from|to) .+ to Inbox \(z\)/.test(a.undelete.undo), "undelete from the reader: " + JSON.stringify(a.undelete));
  expect(fo.emptied && fo.trashCount === "" && /^marked Projects read/.test(fo.markRead.status) && fo.markRead.unreadLeft === 0, "empty Trash and mark all read: " + JSON.stringify([fo.emptied, fo.trashCount, fo.markRead]));
  expect(fo.renamed.labels.includes("Work") && fo.renamed.labels.includes("Work/FPGA") && !fo.renamed.labels.includes("Projects") && fo.renamed.names.includes("Work") && fo.renamed.names.includes("FPGA") && fo.renamed.names.includes("Zeta") && fo.deleted, "folders created, renamed with the subfolder, deleted: " + JSON.stringify(fo.renamed) + " " + fo.deleted);
  const am = results.allMail;
  expect(am.shownIn === "Inbox" && /^archived 1 message/.test(am.status) && am.call?.removeLabelIds?.join() === "INBOX" && am.call.addLabelIds.length === 0 && am.rows === 0 && !am.inbox && am.undone, "archive in All Mail takes the message out of Inbox: " + JSON.stringify(am));
  expect(results.card.head.includes("s2@x.com") && results.card.recent >= 1 && /\(from:s2@x\.com OR to:s2@x\.com OR cc:s2@x\.com\)/.test(results.card.q || ""), "contact card through a person search: " + JSON.stringify(results.card));
  expect(results.print.body.startsWith("Body of") && /img-src data: https:/.test(results.print.csp) && results.print.imgs.length > 0 && results.print.imgs.every(i => i.startsWith("data:")) && results.print.referrer === "no-referrer", "print page with the Gmail image policy: " + JSON.stringify(results.print));
  const rp = results.reply;
  expect(rp.title === "Reply" && rp.to.includes("s3@x.com") && rp.subject === "Re: Subject m-3" && rp.upload.path === "/upload/messages/send" && rp.upload.meta.threadId === "t-m3" && rp.upload.headers["in-reply-to"] === "<m3@x.com>" && rp.upload.headers.references === "<m3@x.com>" && rp.upload.quoted && rp.upload.cid, "a reply joins the thread with chained headers: " + JSON.stringify(rp));
  expect(results.fwd.chips.length === 7 && results.fwd.parts.filter(p => p[2] && !/^inline-/.test(p[2])).length === 7 && results.fwd.parts.some(p => p[2] === "report.pdf") && results.fwd.parts.some(p => p[2] === "deck.pptx") && results.fwd.meta.threadId === "t-m3", "a forward embeds the original's files and stays in its thread: " + JSON.stringify(results.fwd));
  const sd = results.send;
  expect(/^Sending in \d s: send "Gmail runtime test"/.test(sd.pending) && sd.afterCancel.to.includes("alice@example.com") && /note\.txt/.test(sd.afterCancel.files), "undo-send holds and restores: " + JSON.stringify([sd.pending, sd.afterCancel]));
  expect(sd.upload.path === "/upload/messages/send" && sd.upload.headers.to === "Alice <alice@example.com>, bob@example.com" && sd.upload.headers.subject === "Gmail runtime test" && sd.upload.parts.some(p => p[2] === "note.txt") && sd.upload.parts.some(p => p[1] === "image/png" && /^inline-1\.png$/.test(p[2])) && sd.upload.cid && sd.upload.uploads === 1 && sd.upload.sentLabel && sd.closed, "a new message goes out as one upload with its file and inline image: " + JSON.stringify(sd.upload));
  const al = results.attachLimit;
  expect(al.first.status === "attached 2 files" && al.first.chips === 2 && al.again.status === "attached 2 files" && al.again.chips === 2 && !al.again.notice && al.mixed.status === "attached 1 file" && al.mixed.chips === 3 && !al.mixed.notice &&
    al.over.status === "attached 1 file" && al.over.chips === 4 && /^Not attached: c\.bin\. Attachments are limited to 25 MB/.test(al.over.notice), "a file attached again counts once, and a drop says what it attached: " + JSON.stringify(al));
  const dr = results.draft;
  expect(dr.title === "Draft" && dr.chips.length === 1 && /^notes\.txt/.test(dr.chips[0]) && dr.to.includes("s3@x.com") && dr.imgs.every(s => s.startsWith("data:")) && dr.imgs.length >= 1 && dr.overlay !== "fixed", "a draft opens with its file and inline image: " + JSON.stringify([dr.title, dr.chips, dr.to, dr.imgs, dr.overlay]));
  expect(dr.save.path === "/upload/drafts/r-d1" && dr.save.method === "PUT" && dr.save.meta.message.threadId === "t-m3" && dr.save.headers["in-reply-to"] === "<m3@x.com>" && dr.save.parts.some(p => p[2] === "notes.txt") && dr.save.parts.some(p => p[1] === "image/png") && dr.save.edited && dr.save.rows === dr.save.rowsBefore && dr.save.drafts.includes("r-d1"), "saving the draft keeps its draft id, file and image: " + JSON.stringify(dr.save));
  expect(dr.reopened.chips.length === 1 && /^notes\.txt/.test(dr.reopened.chips[0]) && dr.reopened.text.includes("edited") && dr.discarded.deleteCall.includes("/drafts/r-d1") && dr.discarded.rows === 0 && dr.discarded.drafts === 0, "the saved draft reopens and discards: " + JSON.stringify([dr.reopened, dr.discarded]));
  expect(results.abNote.open === 1 && results.abNote.shown && /^Contacts is still being built from your message headers, a little at a time while you are not using the app\./.test(results.abNote.text), "Contacts says while its book is still being built: " + JSON.stringify(results.abNote));
  expect(results.ab.learned > 0 && results.ab.listed > 0 && !results.ab.note && results.ab.section === 0 && results.ab.signOut && /^Baltazar Mail for Gmail™ \d+\.\d+\.\d+$/.test(results.ab.version), "the book once built is listed by Contacts without the notice, and Settings has the sign-out button: " + JSON.stringify(results.ab));
  const nm = results.newMail;
  expect(nm.title === `(${nm.unread}) Baltazar Mail for Gmail™` && nm.unread >= 1 && nm.dotted === "data:image/png;base64," && nm.listed === 1 && nm.history, "new mail through history: " + JSON.stringify(nm));
  const wt = results.waits;
  expect(/^Gmail's request limit is reached, \d+ s more$/.test(wt.said) && /^busy: Gmail's request limit is reached, \d+ s more$/.test(wt.busy) && /^(un)?starred 1 message/.test(wt.done) && wt.hidden && !wt.unread,
    "the status bar says what Gmail is waited for, an action tried meanwhile says it too and is not done, and the wait ends: " + JSON.stringify({ ...wt, copied: undefined }));
  expect(/^Baltazar Mail for Gmail™ \d+\.\d+\.\d+\n[^\n]+\nRequests and waits up to \d\d:\d\d:\d\d: \d+ requests, the slowest \d+ ms; \d+ waits, /.test(wt.copied) && /waited +Gmail's request limit is reached/.test(wt.copied) && !/@|Subject|Fresh/.test(wt.copied) && /^copied this session's requests and waits/.test(wt.copiedSaid),
    "a click on the time copies the session's requests and waits, with nothing of the mail in them: " + JSON.stringify([wt.copiedSaid, wt.copied.slice(0, 400)]));
  const cs = results.css;
  expect(cs.sheets.length === 2 && !/\[|:has\(/.test(cs.sheets[0]) && /\.keep\b/.test(cs.sheets[0]) && /@media screen \{\s*\.kept-in-media/.test(cs.sheets[0]) && !/<\/style/i.test(cs.sheets[0]) && cs.broke === 0 && cs.kept === "rgb(1, 2, 3)" &&
    cs.sheets[1] === ".plain{color:#123456}/* as written */", "a sender's style sheet keeps only rules that do not read the message: " + JSON.stringify([cs.sheets, cs.broke, cs.kept]));
  expect(cs.referrer === "no-referrer" && cs.page === "no-referrer" && cs.images.length === 1 && cs.images[0][0] === "https://img.example/photo.png" && cs.images[0][1] === "about:srcdoc" && cs.images[0][2] === "" && cs.policies.length === 1 && cs.policies[0] === "no-referrer",
    "a remote picture is asked for once, without a referrer: " + JSON.stringify([cs.referrer, cs.page, cs.images, cs.policies]));
  expect(results.cap.own === "data:image/png" && results.cap.others === 70, "references to parts a message does not have take none of its 60 inline images: " + JSON.stringify(results.cap));
  expect(results.svg.width === 40 && results.svg.height === 20 && results.svg.blob && results.svg.density && results.svg.opened === "image/png", "an SVG attachment is shown, and opens, as a bitmap: " + JSON.stringify(results.svg));
  const fl = results.files;
  expect(/^No attachments in Travel\..*subfolder is not included/.test(fl.empty) && fl.q0?.labelIds === "Label_4" && fl.q0?.q === "has:attachment" && fl.q1 === '(label:"Travel" OR label:"Travel/2025") has:attachment' && fl.bodies === 0 &&
    fl.rows.join() === ["logo.svg", "report.pdf", "data.csv", "src.zip", "photo.png", "cv.docx", "budget.xlsx", "deck.pptx", "ticket.txt"].map(n => n + "2025").join() && fl.tiles.join() === "IMG,PDF,CSV,ZIP,IMG,DOC,XLS,PPT,TXT",
    "a folder's attachments are listed from its search rows, each named with its subfolder, also one whose message is in Inbox too: " + JSON.stringify(fl));
  expect(fl.subject === "Subject v-3" && fl.viewer.name === "report.pdf" && /2 of 9/.test(fl.viewer.meta) && fl.viewer.fetched && !fl.off.pane && fl.off.title === "Travel",
    "a file's message on a click, its preview, and Esc back to the folder's messages: " + JSON.stringify([fl.subject, fl.viewer, fl.off]));
  expect(JSON.stringify(fl.saved) === '[["Label_4"]]' && JSON.stringify(results.signOut.files) === "{}",
    "the folder keeps its Subfolders choice until the account is signed out: " + JSON.stringify([fl.saved, results.signOut.files]));
  const sk = results.signOutDeclined;
  expect(/^Sign out of me@gmail\.com\? /.test(sk.asked) && sk.settings && sk.app && !sk.revoked, "sign out asks first, and Cancel keeps the sign-in: " + JSON.stringify(sk));
  const so = results.signOut;
  expect(so.panel && so.app && so.revoked && so.token === null, "sign out: " + JSON.stringify(so));
  expect(so.guide && /^Sign in with your Google™ account/.test(so.text) && so.button === "Sign in with Google" && so.reset && so.notes === 3 && so.client === CID && so.help === 10, "after sign-out the Client ID stays, so the page is one button with help at hand: " + JSON.stringify(so));
  const sf = results.signInFlows;
  expect(sf.before.length === 0 && sf.pressed.length === 1 && sf.pressed[0].how === "flow" && sf.pressed[0].interactive && sf.pressed[0].prompt === "select_account consent" && sf.pressed[0].client === CID && sf.panel && sf.alert, "no sign-in starts by itself; the button starts one, and its failure is shown: " + JSON.stringify(sf));
  // Blocked on purpose: the sandbox's own fetch (tried above, of an address nothing else asks
  // for), images where the reader has them off (Trash), and a cid: source that was never meant to
  // load from the network.
  const unexpectedCsp = (results.cspViolations || []).filter(x => !/img-src ('none|data:\\?")/.test(x) && !/gmail\.googleapis\.com\/sandbox-probe\b/.test(x) && !/Loading the image 'cid:/.test(x));
  expect(unexpectedCsp.length === 0, "content security policy blocked something the app needs: " + JSON.stringify(unexpectedCsp.slice(0, 5)));
  expect(!unexpectedHosts.size, "no request left for the real network: " + [...unexpectedHosts].join(", "));
  if (errors.length) { console.error("FAILED:", errors); process.exit(1); }
  console.log("PASS");
})().catch(e => { console.error(e); process.exit(1); });
