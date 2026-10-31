// Golden values for the machine-sender rule in ext/contacts.js. node tools/contacts-test.mjs
import { machineAddress, isHidden } from "../ext/contacts.js";

const machine = [
  "noreply@example.com", "no-reply@shop.example", "do_not_reply@example.com", "donotreply@mail.example.com",
  "billing.noreply@bank.example", "example-noreply@example.com", "mailer-daemon@example.com", "auto-reply@example.com",
  "notifications@example.com", "bounces+12345@example.com", "news@example.com", "receipts-eu@example.com",
  "info@example.com", "support@example.com", "sales@example.com", "survey@example.com",
  "a1b2c3d4e5f6a7b8c9d0e1f2@example.com",
  "store@email.example.com", "deals@t.example.com", "brand@appmail.example.com", "x@info6.example.com",
  "NOREPLY@example.com", "acme-auto-reply@example.com", "acme.newsletter@example.com", "acme_automated@example.com",
  "acme-info@example.com", "info.us@example.com", "x@example-info.com", "x@infos-example.com", "x@shopemail.com", "x@example.email",
];
const person = [
  "jane.doe@gmail.com", "john@yahoo.com", "ana@hotmail.com", "bob@protonmail.com", "mike@fastmail.com",
  "j.smith@company.example", "newman@example.com", "updike@example.com", "teamlead.joe@example.com",
  "jane@mail.example.edu", "x@mail.example.ac.uk", "dept42@example.com", "sinfo@example.com", "infoman@example.com", "irena@example.hr",
];
let fail = 0;
for (const e of machine) if (!machineAddress(e)) { fail++; console.log("FAIL should hide:", e); }
for (const e of person) if (machineAddress(e)) { fail++; console.log("FAIL should keep:", e); }
// The rule applies only to addresses never written to, and never overrides the user's choice.
const cases = [
  [{ email: "noreply@example.com", sent: 0 }, true], [{ email: "noreply@example.com", sent: 2 }, false],
  [{ email: "noreply@example.com", sent: 0, hidden: false }, false], [{ email: "jane.doe@gmail.com", sent: 0 }, false],
  [{ email: "jane.doe@gmail.com", sent: 5, hidden: true }, true],
];
for (const [e, want] of cases) if (isHidden(e) !== want) { fail++; console.log("FAIL isHidden", JSON.stringify(e), "want", want); }
console.log(fail ? `${fail} FAIL` : `PASS (${machine.length} machine, ${person.length} person)`);
process.exit(fail ? 1 : 0);
