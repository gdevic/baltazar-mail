// What a folder's Files lists from search rows (ext/files.js). node tools/files-test.mjs
import { filesOf, isFile } from "../ext/files.js";

let fail = 0;
const eq = (got, want, what) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { fail++; console.log("FAIL", what, "got", g, "want", w); } };
const row = (id, attachments) => ({ id, attachments, headers: { subject: `s ${id}`, date: "0" } });
const pdf = (partId, extra = {}) => ({ partId, disposition: "attachment", filename: "itinerary.pdf", size: 52000, type: "application", subtype: "pdf", ...extra });
const brief = items => items.map(x => `${x.key}:${x.filename || "-"}:${x.copies}`);

// what counts as a file
eq(isFile(pdf("2")), true, "a named attachment");
eq(isFile({ disposition: "inline", filename: "logo.png", type: "image" }), false, "an image built into the text");
eq(isFile({ disposition: "attachment", filename: "", type: "image", subtype: "png" }), false, "a nameless picture (a sender's logo)");
eq(isFile({ disposition: "attachment", filename: "", type: "text", subtype: "calendar" }), true, "a nameless file that is not a picture");
eq(isFile(undefined), false, "nothing");

// entries in row order, each with its row and message id
const rows = [
  row("m1", [pdf("2", { objectId: "A" }), { disposition: "inline", filename: "pic.png", type: "image" }, { partId: "3", disposition: "attachment", filename: "boarding.png", size: 900, type: "image", subtype: "png", objectId: "B" }]),
  row("m2", []),
  row("m3", [pdf("2", { objectId: "A" })]),
  row("m4", [pdf("2", { objectId: "C" })]),
];
const items = filesOf(rows);
eq(brief(items), ["m1/2:itinerary.pdf:2", "m1/3:boarding.png:1", "m4/2:itinerary.pdf:1"], "the same content twice is one entry, a different one of the same name is not");
eq([items[0].msgId, items[0].row.id, items[0].size, items[0].type], ["m1", "m1", 52000, "application"], "an entry keeps its file's fields and its row");

// without a content id, the same name and size are the same file; a further page counts against the first
const seen = new Map();
const first = filesOf([row("g1", [pdf("1"), { partId: "2", disposition: "attachment", filename: "Itinerary.PDF ", size: 52000, type: "application" }])], { seen });
const more = filesOf([row("g2", [pdf("1"), pdf("4", { size: 51000 })])], { seen });
eq([brief(first), brief(more)], [["g1/1:itinerary.pdf:3"], ["g2/4:itinerary.pdf:1"]], "name and size, across pages");

// a file the provider cannot fetch is left out; a row without a part list has nothing to list
eq(brief(filesOf([row("y1", [pdf("2", { objectId: "Z" }), pdf("3", { objectId: "Y", filename: "x.doc" })])], { listed: a => a.filename !== "x.doc" })), ["y1/2:itinerary.pdf:1"], "only files the provider can fetch");
eq(filesOf([{ id: "r", attachmentCount: 2 }]), [], "a row without its part list");
eq(brief(filesOf([row("n", [{ disposition: "attachment", filename: "a.txt", type: "text" }])])), ["n/0:a.txt:1"], "a file without a part id is keyed by its place");

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log("files: all passed");
