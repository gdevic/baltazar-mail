// Golden values for the machine-sender rule, the display-name choice and the Contacts view's lists in ext/contacts.js. node tools/contacts-test.mjs
import { createRequire } from "node:module";
// ext/contacts.js imports the adapter beside it, so it is tested in the built Yahoo extension.
createRequire(import.meta.url)("./build.js").build("yahoo");
const { machineAddress, isHidden, scanStep, noteName, bestName, paceWait, pileOf, pinnedFirst, matchOf, sortRows } = await import("../dist/baltazar-mail-yahoo/contacts.js");

const machine = [
  "noreply@example.com", "no-reply@shop.example", "do_not_reply@example.com", "donotreply@mail.example.com",
  "billing.noreply@bank.example", "example-noreply@example.com", "mailer-daemon@example.com", "auto-reply@example.com",
  "notifications@example.com", "bounces+12345@example.com", "news@example.com", "receipts-eu@example.com",
  "info@example.com", "support@example.com", "sales@example.com", "survey@example.com",
  "a1b2c3d4e5f6a7b8c9d0e1f2@example.com",
  "store@email.example.com", "deals@t.example.com", "brand@appmail.example.com", "x@info6.example.com",
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
// The Contacts filter and the two orders.
{
  const rows = [{ name: "Zoë Adams", email: "zoe@example.com", last: 5, lastSent: 9 }, { name: "", email: "bob@example.org", last: 9, lastSent: 0 }, { name: "ann lee", email: "al@example.com", last: 5, lastSent: 3 }];
  check(matchOf(rows[0], "adam") && matchOf(rows[0], "zoe@") && !matchOf(rows[0], "bob") && matchOf(rows[1], "") && matchOf(rows[1], ".org"), "the filter finds its text anywhere in the name or the address");
  const order = by => sortRows(rows, by).map(r => r.email.split("@")[0]).join(" ");
  check(order("last") === "bob al zoe", "last: the last mail first, then by address: " + order("last"));
  check(order("wrote") === "zoe al bob", "wrote: the one last written to first: " + order("wrote"));
  check(rows[0].email === "zoe@example.com", "sorting leaves the given list as it was");
}
console.log(fail ? `${fail} FAIL` : `PASS (${machine.length} machine, ${person.length} person)`);
process.exit(fail ? 1 : 0);
