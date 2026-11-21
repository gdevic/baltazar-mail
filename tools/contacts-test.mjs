// Golden values for the machine-sender rule, the display-name choice and the Contacts view's lists in ext/contacts.js. node tools/contacts-test.mjs
import { createRequire } from "node:module";
// ext/contacts.js imports the adapter beside it, so it is tested in the built Yahoo extension.
createRequire(import.meta.url)("./build.js").build("yahoo");
const { machineAddress, isHidden, scanStep, noteName, bestName, paceWait, pileOf, pinnedFirst, matchOf, sortRows, record, setOwnAddresses, setInbox, planImport, completes } = await import("../dist/baltazar-mail-yahoo/contacts.js");
const file = await import("../dist/baltazar-mail-yahoo/contactsfile.js");

const machine = [
  "noreply@example.com", "no-reply@shop.example", "do_not_reply@example.com", "donotreply@mail.example.com",
  "billing.noreply@bank.example", "example-noreply@example.com", "mailer-daemon@example.com", "auto-reply@example.com",
  "notifications@example.com", "bounces+12345@example.com", "news@example.com", "receipts-eu@example.com",
  "info@example.com", "support@example.com", "sales@example.com", "survey@example.com",
  "a1b2c3d4e5f6a7b8c9d0e1f2@example.com",
  "store@email.example.com", "deals@t.example.com", "brand@appmail.example.com", "x@info6.example.com",
  "unsubscribe@example.com", "acme-unsubscribe@example.com", "unsubscribe.4711@example.com",
  "NOREPLY@example.com", "acme-auto-reply@example.com", "acme.newsletter@example.com", "acme_automated@example.com",
  "acme-info@example.com", "info.us@example.com", "deals@email.shop.co.uk", "x@news.example.com.br", "x@example-info.com", "x@infos-example.com", "x@shopemail.com", "x@example.email",
];
const person = [
  "jane.doe@gmail.com", "john@yahoo.com", "ana@hotmail.com", "bob@protonmail.com", "mike@fastmail.com",
  "j.smith@company.example", "newman@example.com", "updike@example.com", "teamlead.joe@example.com",
  "jane@mail.example.edu", "x@mail.example.ac.uk", "dept42@example.com", "sinfo@example.com", "infoman@example.com", "irena@example.hr",
  "ana@hotmail.co.uk", "joao@hotmail.com.br", "ken@mail.co.jp", "liz@gmail.com.au", "sam@email.co.nz",
];
let fail = 0;
const check = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
for (const e of machine) if (!machineAddress(e)) { fail++; console.log("FAIL should hide:", e); }
for (const e of person) if (machineAddress(e)) { fail++; console.log("FAIL should keep:", e); }
// The rule applies only to addresses never written to, and never overrides the user's choice.
const cases = [
  [{ email: "noreply@example.com", lastSent: 0 }, true], [{ email: "noreply@example.com", lastSent: 1700000000 }, false],
  [{ email: "noreply@example.com", hidden: false }, false], [{ email: "jane.doe@gmail.com" }, false],
  [{ email: "jane.doe@gmail.com", lastSent: 1700000000, hidden: true }, true],
];
for (const [e, want] of cases) if (isHidden(e) !== want) { fail++; console.log("FAIL isHidden", JSON.stringify(e), "want", want); }
// Scans walk newest-first and stop at the bookmark; a future-dated message never moves it.
{
  const now = 2_000_000_000, day = 86400;
  const scan = (dates, opts) => { let newest = opts.newestSeen, recorded = 0, stopped = false;
    for (const d of dates) { const s = scanStep(d, newest, { ...opts, now }); if (s.stop) { stopped = true; break; } if (s.record) recorded++; newest = s.newest; }
    return { newest, recorded, stopped }; };
  const future = now + 365 * day;
  const first = scan([future, now - 10, now - 20], { full: true, newestSeen: 0 });
  check(first.recorded === 3 && first.newest === now - 10, "full scan counts the future-dated message once, bookmark stays at today: " + JSON.stringify(first));
  const next = scan([future, now - 5, now - 10, now - 20], { full: false, newestSeen: first.newest });
  check(next.recorded === 1 && next.stopped && next.newest === now - 5, "incremental scan passes the future message and learns the new one: " + JSON.stringify(next));
}
// Names by source: a label other senders put on an address loses to the person's own From name,
// which loses to the name the user typed, however often the weaker one is seen.
{
  const e = { names: { "Legacy": 9 } };
  check(bestName(e) === "Legacy", "a name recorded before sources were kept still shows");
  for (let i = 0; i < 20; i++) noteName(e, "Click Here To Pay", "others");
  check(bestName(e) === "Click Here To Pay", "others' labels outvote legacy names only by count");
  noteName(e, "Ann Smith", "self");
  check(bestName(e) === "Ann Smith", "the person's own name beats any number of labels");
  noteName(e, "Annie", "mine"); noteName(e, "  ", "mine"); noteName(e, null, "mine");
  check(bestName(e) === "Annie", "the user's own name for them beats everything");
  noteName(e, "Bob\u202Eevil", "mine"); noteName(e, "Bob\u202Eevil", "mine");
  check(bestName(e) === "Bobevil", "bidi controls are not stored");
  noteName(e, "x".repeat(300), "self");
  check(Object.keys(e.nameBy.self).every(n => n.length <= 100), "names are capped in length");
  const f = {};
  for (let i = 0; i < 30; i++) noteName(f, `Spam ${i}`, "others");
  noteName(f, "Spam 29", "others");
  check(Object.keys(f.nameBy.others).length === 8 && bestName(f) === "Spam 29" && "Spam 28" in f.nameBy.others, "at most 8 names per source, newest kept: " + JSON.stringify(f.nameBy.others));
}
// The first build of a provider that paces it: not before its start time, then only once the user
// has been idle long enough, at once when the tab is hidden, and without limits where none are set.
{
  const now = 1_000_000_000, idle = 60e3;
  const wait = o => paceWait({ now, idle, ...o });
  check(wait({ after: now + 120e3, lastInput: now - 90e3 }) === 120e3, "nothing before the start time, however idle the user is");
  check(wait({ after: now + 120e3, lastInput: now - 90e3, hidden: true }) === 120e3, "a hidden tab does not start the build early");
  check(wait({ after: now - 1, lastInput: now - 5e3 }) === 55e3, "after the start time, it waits until the user has been idle long enough");
  check(wait({ after: now - 1, lastInput: now - 5e3, hidden: true }) === 0, "a hidden tab is a user away");
  check(wait({ after: now - 1, lastInput: now - 60e3 }) === 0 && wait({ after: 0, lastInput: now - 90e3 }) === 0, "an idle user lets it go");
  check(paceWait({ now, lastInput: now }) === 0, "no start time and no idle time: no wait");
}
// Contacts' three piles: hidden wins, then anyone written to or pinned is a person.
{
  const pile = r => pileOf({ lastSent: 0, pinned: 0, hidden: false, ...r });
  check(pile({ lastSent: 5 }) === "people" && pile({ pinned: 9 }) === "people" && pile({}) === "others" && pile({ hidden: true, lastSent: 5 }) === "hidden",
    "an address is a person once written to or pinned, hidden whenever it is hidden, and one of the others otherwise");
  const pins = pinnedFirst([{ email: "b@x.com", pinned: 200 }, { email: "c@x.com", pinned: 0 }, { email: "a@x.com", pinned: 100 }]).map(r => r.email).join(" ");
  check(pins === "a@x.com b@x.com", "the pinned ones, in the order they were pinned: " + pins);
}
// What one message teaches the book. A thread among many people (one To, a long Cc of bare and
// named addresses, the user's own among them, one at an ISP's email. subdomain) loses nobody:
// everyone but the user is one of the others, and those in Cc are marked as copied, which keeps
// the one with the bulk-mail subdomain from being taken for a machine.
{
  setOwnAddresses(["Me@Yahoo.com"]);
  const who = (email, name = "") => ({ name, email });
  const pile = e => pileOf({ ...e, hidden: isHidden(e), pinned: 0 });
  const cc = [who("ana@mac.example", "Ana Kos"), who("bruno@gmail.example"), who("vlado.babic@zg.isp-net.example"), who("me@yahoo.com", "Me Myself"), who("Iva@email.isp-net.example"),
    who("infodata@zg.isp-net.example"), who("sektor@sektor.example"), who("miro@fondovi.info"), who("Tin@open.example", "Tin Maric"), who("projekt@kovina.example")];
  const thread = new Map();
  record({ headers: { date: "1700000000", from: [who("ivo@class.example", "Ivo Horvat")], to: [who("Dora.Peric@uni.example.edu", "Dora Peric")], cc } }, thread);
  const got = [...thread.values()];
  check(got.length === 11 && !thread.has("me@yahoo.com"), "everyone in From, To and Cc is recorded but the user: " + got.map(e => e.email).join(" "));
  check(got.every(e => pile(e) === "others"), "all of them are among the others, none hidden: " + got.map(e => `${e.email}=${pile(e)}`).join(" "));
  check(got.every(e => e.copied === (e.email !== "ivo@class.example" && e.email !== "dora.peric@uni.example.edu")), "those in Cc are marked as copied, and only those: " + got.filter(e => e.copied).map(e => e.email).join(" "));
  const iva = thread.get("iva@email.isp-net.example");
  check(machineAddress(iva.email) && !isHidden(iva) && isHidden({ ...iva, copied: false }), "an address at a bulk-mail subdomain is a person once mail was copied to it, and a machine's otherwise");
  check(got.every(e => e.lastSent === 0 && e.last === 1700000000) && thread.get("ana@mac.example").nameBy.others["Ana Kos"] === 1 && thread.get("ivo@class.example").nameBy.self["Ivo Horvat"] === 1, "a message someone else wrote dates the mail, not a writing to them, and names them by source");
  // Who wrote a message says which way it went, not where it is kept: a reply of the user's filed
  // in a folder of their own is a writing to its recipients, as is anything read from Sent. In
  // Inbox anyone's mail arrives with any From, so a message there is taken as received.
  setInbox("1");
  const mineIn = folder => { const out = new Map(); record({ folder: { id: folder }, headers: { date: "1700000500", from: [who("ME@yahoo.com", "Me Myself")], to: [who("serena@maker.example", "Maker Services")], cc: [who("lin@maker.example")] } }, out); return out; };
  const reply = mineIn("31");
  const serena = reply.get("serena@maker.example"), lin = reply.get("lin@maker.example");
  check(reply.size === 2 && serena.lastSent === 1700000500 && pile(serena) === "people" && !serena.copied && pile(lin) === "people" && lin.copied && serena.nameBy.mine["Maker Services"] === 1,
    "a message the user wrote, filed in a folder of theirs, lists its recipients under People: " + JSON.stringify([...reply.values()]));
  const forged = mineIn("1"), fake = forged.get("serena@maker.example");
  check(fake && !fake.lastSent && pile(fake) !== "people", "a message in Inbox with the user's From is taken as received: " + JSON.stringify([...forged.values()]));
  setInbox(null);
  const sent = new Map();
  record({ headers: { date: "1700000900", from: [who("alias@elsewhere.example")], to: [who("pat@x.example")], bcc: [who("quiet@x.example")] } }, sent, true);
  check(sent.size === 2 && sent.get("pat@x.example").lastSent === 1700000900 && sent.get("quiet@x.example").copied && !sent.has("alias@elsewhere.example"), "whatever is read from Sent is the user's, whichever address it was sent from: " + JSON.stringify([...sent.values()]));
  setOwnAddresses([]);
}
// An address named for a role is a machine's wherever it is seen; only the guess from the domain
// is dropped for an address mail was copied to.
{
  const seen = (email, copied) => isHidden({ email, lastSent: 0, copied });
  check(seen("info@firm.example", true) && seen("info@firm.example", false) && seen("noreply@firm.example", true) && seen("support.eu@firm.example", true), "info@, noreply@ and the like are hidden though mail was copied to them");
  check(!seen("iva@email.isp-net.example", true) && seen("iva@email.isp-net.example", false) && !isHidden({ email: "info@firm.example", lastSent: 5, copied: true }), "a bulk-mail domain hides only an address never copied on mail, and nothing hides one written to");
}
// The user's own name for a contact is shown before any name the mail gives.
{
  const e = { nameBy: { self: { MS: 1 }, others: { "Mislav Sabolic": 20 } } };
  check(bestName(e) === "MS" && bestName({ ...e, given: "Mislav" }) === "Mislav" && bestName({ ...e, given: "" }) === "MS", "the name the user gave wins, and without one the person's own does");
}
// The contacts file: a contact a line as mail writes it, the pinned first in their order and then
// the people, the others and the hidden by address; what is written is read back the same.
{
  const rows = [
    { name: "Maya Chen", email: "maya.chen@x.example", pinned: 20, hidden: false, lastSent: 5 },
    { name: "Kos, Ana", email: "ana.kos@x.example", pinned: 10, hidden: false, lastSent: 0 },
    { name: "Robin Hale", email: "robin.hale@x.example", pinned: 0, hidden: false, lastSent: 9 },
    { name: "", email: "ana@mac.example", pinned: 0, hidden: false, lastSent: 0 },
    { name: '#1 "Deals" <now>', email: "deals@shop.example", pinned: 0, hidden: true, lastSent: 0 },
  ];
  const text = file.format(rows, { account: "me@yahoo.com", date: "2026-11-20" });
  const body = text.split("\n").filter(l => l && !l.startsWith("# ")).join("|");
  check(text.startsWith("# Baltazar Mail contacts of me@yahoo.com, 2026-11-20\n") && text.endsWith("\n") && ["# Pinned", "# People", "# Others", "# Hidden"].every(h => text.includes(`\n\n${h}\n`)), "the file starts with what it is and how it is written, and heads each group: " + JSON.stringify(text.slice(0, 80)));
  check(body === '"Kos, Ana" <ana.kos@x.example> pinned|Maya Chen <maya.chen@x.example> pinned|Robin Hale <robin.hale@x.example>|ana@mac.example|"#1 \\"Deals\\" <now>" <deals@shop.example> hidden', "a contact a line, quoted only where the name needs it: " + body);
  check(file.format([{ name: "Two\nLines\tHere", email: "two@x.example", pinned: 0, hidden: false, lastSent: 0 }]).includes("\nTwo Lines Here <two@x.example>\n"), "a name is written on one line, whatever line breaks it has");
  const back = file.parse(file.format(rows, { eol: "\r\n" }));
  check(!back.errors.length && JSON.stringify(back.entries.map(e => [e.name, e.email, e.pinned, e.hidden])) === JSON.stringify([rows[1], rows[0], rows[2], rows[3], rows[4]].map(r => [r.name, r.email, !!r.pinned, r.hidden])), "what is written is read back the same, with either line ending: " + JSON.stringify(back));
  const odd = file.parse("\uFEFFAna <A@B.example> Pinned\nBob b@c.example\n<c@d.example>\nx@y.example pined\nq@r.example pinned hidden\n# a note\n\nAna Two <a@b.example>\na@x.example, b@x.example\nEve <not an address>\n");
  check(JSON.stringify(odd.entries.map(e => [e.email, e.name, e.pinned, e.line])) === '[["c@d.example","",false,3],["a@b.example","Ana Two",false,8]]', "an address is read without regard to case, once, as its last line has it: " + JSON.stringify(odd.entries));
  check(JSON.stringify(odd.errors.map(e => e.line)) === "[2,4,5,9,10]" && /is not pinned or hidden$/.test(odd.errors[1].why) && odd.errors[2].why === "pinned and hidden at once" && /several addresses/.test(odd.errors[3].why), "the lines that are not a contact are told apart, with the reason: " + JSON.stringify(odd.errors));
}
// What an import makes of the book: merging takes what the file says and leaves the rest;
// replacing makes the book what the file says; and a file written from the book changes nothing.
{
  setOwnAddresses(["me@yahoo.com"]);
  const book = () => new Map([
    { email: "maya@x.example", name: "Maya Chen", nameBy: { self: { "Maya Chen": 3 } }, last: 50, lastSent: 40, pinned: 100 },
    { email: "robin@x.example", name: "Robin Hale", nameBy: { self: { "Robin Hale": 1 } }, last: 30, lastSent: 20, pinned: 200 },
    { email: "ms@x.example", name: "MS", nameBy: { self: { MS: 1 }, others: { "Mislav Sabolic": 5 } }, last: 10, lastSent: 0 },
    { email: "noreply@shop.example", name: "Shop", nameBy: { self: { Shop: 2 } }, last: 5, lastSent: 0 },
    { email: "bare@x.example", name: "", nameBy: {}, last: 4, lastSent: 0 },
  ].map(e => [e.email, e]));
  const listed = b => [...b.values()].map(e => ({ name: e.name, email: e.email, pinned: e.pinned || 0, hidden: isHidden(e), lastSent: e.lastSent }));
  const written = file.parse(file.format(listed(book()))).entries;
  for (const replace of [false, true]) { const p = planImport(book(), written, { replace, now: 1000 }); check(!p.put.length && !p.drop.length, `the book's own file changes nothing (${replace ? "replacing" : "merging"}): ` + JSON.stringify(p)); }
  const x = (email, name = "", word = "") => ({ email, name, pinned: word === "pinned", hidden: word === "hidden" });
  const merged = planImport(book(), [x("ms@x.example", "Mislav Sabolic"), x("new@y.example", "New One", "pinned"), x("robin@x.example", "Robin Hale", "hidden"), x("me@yahoo.com", "Me")], { now: 1000 });
  const got = Object.fromEntries(merged.put.map(e => [e.email, e]));
  check(merged.put.length === 3 && !merged.drop.length && got["ms@x.example"].given === "Mislav Sabolic" && got["ms@x.example"].name === "Mislav Sabolic" && got["ms@x.example"].last === 10 &&
    got["new@y.example"].added && got["new@y.example"].given === "New One" && got["new@y.example"].pinned === 1000 && got["robin@x.example"].hidden === true && !got["robin@x.example"].pinned,
    "merging names a contact, adds a new one and hides one, and touches nobody else: " + JSON.stringify(merged.put));
  check(JSON.stringify(merged.counts) === '{"added":1,"renamed":1,"pinned":0,"unpinned":1,"hidden":1,"shown":0,"removed":0,"restored":0}', "and counts what it did: " + JSON.stringify(merged.counts));
  const replaced = planImport(book(), [x("robin@x.example", "Robin Hale", "pinned"), x("maya@x.example", "Maya", "pinned"), x("ms@x.example", "MS"), x("noreply@shop.example", "Shop"), x("new@y.example")], { replace: true, now: 1000 });
  const now = Object.fromEntries(replaced.put.map(e => [e.email, e]));
  check(JSON.stringify(replaced.drop) === '["bare@x.example"]' && now["robin@x.example"].pinned === 999 && now["maya@x.example"].pinned === 1000 && now["maya@x.example"].given === "Maya" && !("ms@x.example" in now) &&
    now["noreply@shop.example"].hidden === false && now["new@y.example"].added && now["new@y.example"].name === "",
    "replacing puts the pins in the file's order, the last of them now, shows what the file does not hide, and takes out who is not in it: " + JSON.stringify(replaced));
  check(JSON.stringify(replaced.counts) === '{"added":1,"renamed":1,"pinned":0,"unpinned":0,"hidden":0,"shown":1,"removed":1,"restored":0}', "and counts what it did: " + JSON.stringify(replaced.counts));
  // A contact the user deleted is in no list, and the file does not know of it: the book's own file
  // leaves the deletion alone, replacing does not take it out, and a line that names it brings the
  // contact back. The word deleted is not one the file has.
  const gone = () => new Map([...book(), ["dead@x.example", { email: "dead@x.example", name: "Dead One", nameBy: { self: { "Dead One": 1 } }, last: 3, lastSent: 0, deleted: true }]]);
  const whole = file.format(listed(book()));
  check(!/deleted/i.test(whole) && /After the address: pinned or hidden\./.test(whole), "the file says nothing of deletions: " + JSON.stringify(whole.slice(0, 200)));
  const kept = planImport(gone(), written, { replace: true, now: 1000 }), again = planImport(gone(), [x("dead@x.example", "Dead One")], { now: 1000 });
  check(!kept.put.length && !kept.drop.length && kept.counts.removed === 0, "the book's own file does not touch a deleted contact, even replacing: " + JSON.stringify(kept));
  check(again.put.length === 1 && !("deleted" in again.put[0]) && again.put[0].added && again.counts.restored === 1 && again.counts.added === 0, "a line that names a deleted contact brings it back: " + JSON.stringify(again));
  const word = file.parse("Dead One <dead@x.example> deleted\n");
  check(!word.entries.length && word.errors.length === 1 && /"deleted" after the address is not pinned or hidden/.test(word.errors[0].why), "a line marked deleted is not one the file reads: " + JSON.stringify(word));
  const back = planImport(new Map([["ms@x.example", { ...book().get("ms@x.example"), given: "Mislav" }]]), [x("ms@x.example")], { replace: true, now: 1000 });
  check(back.put.length === 1 && !("given" in back.put[0]) && back.put[0].name === "MS", "replacing with a line that has no name takes the user's name back: " + JSON.stringify(back.put));
  setOwnAddresses([]);
}
// An unchanged export imported changes nothing, whatever the user chose: a contact unhidden, a
// given name the mail now gives too, pins made together; and pins an import gives end now.
{
  setOwnAddresses(["me@yahoo.com"]);
  const pins = Array.from({ length: 20 }, (_, i) => ({ email: `p${String(i).padStart(2, "0")}@x.example`, name: `P ${i}`, nameBy: { self: { [`P ${i}`]: 1 } }, last: 9, lastSent: 9, pinned: 500 }));
  const book = () => new Map([
    { email: "support@acme.example", name: "Acme", nameBy: { self: { Acme: 2 } }, last: 50, lastSent: 40, hidden: false },
    { email: "unhid@x.example", name: "Un Hid", nameBy: { self: { "Un Hid": 1 } }, last: 30, lastSent: 0, hidden: false, pinned: 300 },
    { email: "ana@x.example", name: "Ana Kos", nameBy: { self: { "Ana Kos": 4 } }, last: 20, lastSent: 10, given: "Ana Kos" },
    ...pins,
  ].map(e => [e.email, structuredClone(e)]));
  const listed = b => [...b.values()].map(e => ({ name: e.name, email: e.email, pinned: e.pinned || 0, hidden: isHidden(e), lastSent: e.lastSent }));
  const written = file.parse(file.format(listed(book()))).entries;
  for (const replace of [false, true]) { const p = planImport(book(), written, { replace, now: 1000 }); check(!p.put.length && !p.drop.length, `an unchanged file keeps every choice (${replace ? "replacing" : "merging"}): ` + JSON.stringify(p.put.map(e => e.email))); }
  const x = (email, word = "") => ({ email, name: "", pinned: word === "pinned", hidden: false });
  const added = planImport(book(), [x("n1@x.example", "pinned"), x("n2@x.example", "pinned"), x("n3@x.example", "pinned")], { now: 1000 }).put.map(e => e.pinned);
  check(JSON.stringify(added) === "[998,999,1000]", "the pins an import gives are in its order, the last of them now: " + JSON.stringify(added));
}
// A line written as a To field is several addresses, refused, while a name that is an address is one.
{
  const several = ["Ana Kos <ana@x.example>, Bob Ban <bob@x.example>", "<ana@x.example>; <bob@x.example>", "ana@x.example, Bob <bob@x.example>"].map(t => file.parse(t).errors[0]?.why);
  check(several.every(w => w === "several addresses: a line is one contact"), "several addresses on a line are refused: " + JSON.stringify(several));
  const one = file.parse('john@x.example <john@x.example>\n"Kos, Ana <ana@x.example>" <ana@x.example>\nSmith, John <js@x.example>\n');
  check(!one.errors.length && one.entries.map(e => e.name).join("|") === "john@x.example|Kos, Ana <ana@x.example>|Smith, John", "a name that is an address, or quoted, is one contact: " + JSON.stringify(one));
}
// A name is kept as the file writes it, so the round trip leaves it as it was: a tab is a space,
// and a cut at 100 characters never splits one in two.
{
  const tab = {}, emoji = {};
  noteName(tab, "Ana" + String.fromCharCode(9) + "Kos", "self");
  noteName(emoji, "x".repeat(99) + String.fromCodePoint(0x1F600) + "tail", "self");
  const kept = Object.keys(emoji.nameBy.self)[0];
  check(Object.keys(tab.nameBy.self)[0] === "Ana Kos" && [...kept].length === 100 && kept.endsWith(String.fromCodePoint(0x1F600)), "names are one line and cut between characters: " + JSON.stringify([Object.keys(tab.nameBy.self), [...kept].length]));
  check(file.parse(file.format([{ name: kept, email: "e@x.example", pinned: 0, hidden: false, lastSent: 0 }])).entries[0]?.name === kept, "and come back from the file unchanged");
}
// The Contacts filter and the two orders.
{
  const rows = [{ name: "Zoë Adams", email: "zoe@example.com", last: 5, lastSent: 9 }, { name: "", email: "bob@example.org", last: 9, lastSent: 0 }, { name: "ann lee", email: "al@example.com", last: 5, lastSent: 3 }];
  check(matchOf(rows[0], "adam") && matchOf(rows[0], "zoe@") && !matchOf(rows[0], "bob") && matchOf(rows[1], "") && matchOf(rows[1], ".org"), "the filter finds its text anywhere in the name or the address");
  const order = by => sortRows(rows, by).map(r => r.email.split("@")[0]).join(" ");
  check(order("last") === "bob al zoe", "last: the last mail first, then by address: " + order("last"));
  check(order("wrote") === "zoe al bob", "wrote: the one last written to first: " + order("wrote"));
  check(rows[0].email === "zoe@example.com", "sorting leaves the given list as it was");
}
// What may stand for typed text in the composer: an address or a word of the name that starts
// with it, never an address that only contains it.
{
  const joann = { name: "Joann New", email: "joann@corp.example" }, jordan = { name: "", email: "jordan@gmail.com" };
  check(completes("jo", joann) && completes("NEW", joann) && completes("joann@corp", joann) && completes(" joann@corp.example ", joann), "an address or a name word that starts with the text completes it");
  check(!completes("ann@corp.example", joann) && !completes("dan@gmail.com", jordan) && !completes("corp.example", joann) && !completes("", joann), "an address that only contains the text does not complete it");
}
console.log(fail ? `${fail} FAIL` : `PASS (${machine.length} machine, ${person.length} person)`);
process.exit(fail ? 1 : 0);
