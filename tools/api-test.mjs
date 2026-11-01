// Session values and folder records as Yahoo may send them. node tools/api-test.mjs
import { parseBootstrap, normalizeFolders, isMessageId, saveRequest } from "../ext/api.js";

let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
const page = obj => `<html><script>window.foo={"appId":"Wrong"};window.AppBootstrapData = ${JSON.stringify(obj)};</script></html>`;

// The top-level keys win over same-named keys nested earlier or inside primaryMailbox.
const s = parseBootstrap(page({ config: { appId: "YMailNorrin" }, appId: "YMailCLDNovation", mailWssid: "w1",
  primaryMailbox: { owner: { id: "OWNER", email: "owner@x" }, id: "MB1", email: "me@yahoo.com" } }));
ok(s?.appId === "YMailCLDNovation" && s.wssid === "w1" && s.mailboxId === "MB1" && s.email === "me@yahoo.com", "nested keys do not win: " + JSON.stringify(s));
// Strings containing braces and quotes do not end the object early.
const t = parseBootstrap(page({ note: 'a } b " { c', appId: "A", mailWssid: "W", primaryMailbox: { id: "M" } }));
ok(t?.appId === "A" && t.mailboxId === "M" && t.email === "", "braces inside strings: " + JSON.stringify(t));
// Not JSON (a script object literal): the plain key search still finds the values.
const u = parseBootstrap(`<script>window.AppBootstrapData={appIdLabel:undefined,"appId":"A","mailWssid":"W","primaryMailbox":{"id":"M","email":"e@x"}};</script>`);
ok(u?.appId === "A" && u.wssid === "W" && u.mailboxId === "M" && u.email === "e@x", "fallback for non-JSON: " + JSON.stringify(u));
// Signed out: Yahoo's landing page.
ok(parseBootstrap("<html><title>Yahoo Mail</title></html>") === null, "signed-out page");
ok(parseBootstrap(page({ appId: "A", primaryMailbox: { id: "M" } })) === null, "missing wssid");

const f = normalizeFolders([{ id: 1, name: "Inbox", types: ["INBOX"] }, { id: "88" }, null, { name: "no id" }, { id: "9", name: "", types: "USER" }]);
ok(f.length === 3, "records without an id dropped: " + f.length);
ok(f[0].id === "1" && f[0].types[0] === "INBOX", "ids are strings");
ok(f[1].name === "Folder 88" && Array.isArray(f[1].types) && !f[1].types.length, "missing name and types filled in");
ok(f[2].name === "Folder 9" && f[2].types.length === 0, "bad types and empty name");
ok(normalizeFolders(undefined).length === 0, "no list at all");

// Message ids go into Yahoo queries; a save refuses any that is not in Yahoo's id alphabet.
ok(isMessageId("AJk9_x-1") && !isMessageId("X) OR id:(Y") && !isMessageId("") && !isMessageId(undefined) && !isMessageId("a".repeat(65)), "message id alphabet");
const base = { csid: "1", subject: "s", from: { email: "me@x" }, draftFolderId: "3" };
ok(saveRequest({ ...base, inReplyTo: { id: "AJk9", replied: true }, refs: [{ messageId: "B1", partId: "2" }] }).payloadParts[0].payload.message.inReplyTo.messageReference.id === "AJk9", "good ids pass");
const throws = d => { try { saveRequest(d); return false; } catch { return true; } };
ok(throws({ ...base, inReplyTo: { id: "X) OR id:(Y", replied: true } }), "bad reply id refused");
ok(throws({ ...base, refs: [{ messageId: "a/b", partId: "2" }] }), "bad attachment message id refused");

console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
