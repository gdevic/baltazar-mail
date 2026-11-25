// Screenshots: the real extension in Chromium against a mocked mail service filled with invented
// mail, so no real names, addresses or messages appear. One mailbox is drawn in either edition:
// the Yahoo edition against the mocked Yahoo of this file, the Gmail edition against the Gmail of
// gmail-mock.js, which is given the same folders (as labels), messages and files.
//
// node tools/screenshots.js
//   The README's pictures, of the Yahoo edition: docs/screenshots/{light,viewer,dark,contacts,
//   attachments,settings}.png, and the Gmail edition's sign-in page for docs/gmail-sign-in.md as
//   docs/screenshots/signin-*.png.
// node tools/screenshots.js --store [yahoo|gmail]
//   A store's pictures of each edition (or of the one named), in store/<edition>/: the same scenes
//   at the 1280x800 the stores take, in screenshots/, with a 300x300 logo and the 440x280 and
//   1400x560 promotional tiles beside them. The Gmail edition also gets screenshots/setup.png, the
//   page a new install opens with.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { build, EDITIONS, ROOT } = require("./build.js");
const STORE = process.argv.includes("--store");
const NAMED = process.argv.slice(2).filter(a => !a.startsWith("--"));
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// ---------- invented mailbox ----------
const ME = { name: "Alex Morgan", email: "alex.morgan@example.com" };
const folders = [
  { id: "1", name: "Inbox", types: ["INBOX"], unread: 4, total: 96 },
  { id: "3", name: "Draft", types: ["DRAFT"], unread: 0, total: 2 },
  { id: "2", name: "Sent", types: ["SENT"], unread: 0, total: 3418 },
  { id: "62", name: "Archive", types: ["ARCHIVE"], unread: 0, total: 0 },
  { id: "6", name: "Bulk", types: ["BULK"], unread: 12, total: 41 },
  { id: "4", name: "Trash", types: ["TRASH"], unread: 0, total: 57 },
  ...[["10", "Family", 214], ["11", "Finance", 0], ["12", "Finance/Bank", 88], ["13", "Finance/Taxes", 31], ["14", "Home", 0],
    ["15", "Home/Garden", 23], ["16", "Home/Kitchen remodel", 64], ["17", "Photography", 142], ["18", "Projects", 12],
    ["19", "Projects/3D printer", 37], ["20", "Projects/Robot arm", 58], ["21", "Projects/Weather station", 44], ["22", "Projects/Website", 96],
    ["23", "Receipts", 377], ["24", "Recipes", 19], ["25", "Travel", 0], ["26", "Travel/Coast trip", 48], ["27", "Travel/Mountains", 26],
    ["28", "Newsletters", 1206], ["29", "Volunteering", 33]]
    .map(([id, name, total]) => ({ id, name, types: ["USER"], unread: 0, total })),
].map((f, i) => ({ ...f, highestModSeq: 100 + i }));
const fname = id => folders.find(f => f.id === id)?.name || "Inbox";

// A file of a message, from its name and size, as a Yahoo list row names it. n numbers the files
// of the whole mailbox, and the mocked download and thumbnail addresses carry it.
const TYPES = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png", csv: "text/csv", zip: "application/zip", mp4: "video/mp4",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
let fileSeq = 0;
const fileOf = ([filename, size], i) => {
  const mime = TYPES[filename.split(".").pop().toLowerCase()], [type, subtype] = mime.split("/"), n = fileSeq++;
  return { partId: String(i + 2), filename, size, disposition: "attachment", type, subtype, mime, n, objectId: `OBJ${n}`,
    downloadUrl: `https://cloud-apis.mail.yahoo.com/dl/${n}`, ...(type === "image" ? { thumbnailUrl: `https://cloud-apis.mail.yahoo.com/thumb/${n}?appid=x` } : {}) };
};

let seq = 0;
// o.conv: the conversation a message is in, digits as Yahoo writes them (one of its own otherwise);
// o.ids: its Message-ID, In-Reply-To and References headers; o.files: its files, each [name, size].
// A message is dated a few half hours off its day, so the times in a list differ; one of a
// conversation is not, so every reply is later than the message it answers.
const mk = (folder, daysAgo, from, subject, o = {}) => {
  const files = (o.files || []).map(fileOf);
  return {
    id: `M${folder}_${++seq}`, conversationId: o.conv || String(9000 + seq), size: 4000, csid: `cs${seq}`,
    flags: { read: o.unread ? false : true, flagged: !!o.star },
    attachmentCount: files.length, attachments: files,
    headers: { subject, from: [from], to: [o.to || ME], cc: o.cc || [], date: String(NOW - Math.round(daysAgo * DAY) - (o.conv ? 0 : (seq % 7) * 1800)), ...o.ids },
    folder: { id: folder, name: fname(folder) }, snippet: o.snippet || "",
  };
};
const p = (name, email) => ({ name, email });
const ROBIN = p("Robin Hale", "robin.hale@example.com"), CASEY = p("Casey Wu", "casey.wu@example.com");

// The website design thread, one conversation in Projects/Website, Sent and Inbox, for the dark
// screenshot: each message names its own id, the one it answers and, as References, the chain
// above that, as mail does.
const THREAD = "7001", ANSWERS = { s: "a", b: "s", c: "b", e: "a", d: "e", k: "d", f: "d", g: "f" };
const chain = id => ANSWERS[id] ? [...chain(ANSWERS[id]), ANSWERS[id]] : [];
const msgId = id => `<${id}.staging@website.example>`;
const inThread = id => ({ conv: THREAD, ids: { messageIdRfc822: msgId(id), inReplyTo: ANSWERS[id] ? msgId(ANSWERS[id]) : "", referenceList: chain(id).map(msgId) } });

const inbox = [
  mk("1", 0.1, p("Maya Chen", "maya.chen@example.com"), "Re: Saturday hike, meet at the trailhead?", { unread: true }),
  mk("1", 0.3, p("Contoso Bank", "alerts@contoso.example"), "Your October statement is ready", { unread: true }),
  mk("1", 0.5, CASEY, "Re: Website redesign: staging feedback", inThread("k")),
  mk("1", 0.6, p("Northwind Airlines", "no-reply@northwind.example"), "Your boarding pass for flight NW 482", { star: true }),
  mk("1", 1.2, p("Leo Martins", "leo.martins@example.com"), "Re: Bike repair", {}),
  mk("1", 1.5, p("Fabrikam Utilities", "billing@fabrikam.example"), "Your bill for October is ready", { unread: true }),
  mk("1", 2.1, p("City Library", "notices@library.example.org"), "Two items are due on Monday", {}),
  mk("1", 2.4, p("Priya Patel", "priya.patel@example.com"), "Re: Recipe swap", { files: [["lemon-tart.pdf", 248000]] }),
  mk("1", 3.0, p("Harbor Photo Club", "club@harborphoto.example"), "November meetup: night photography", { star: true }),
  mk("1", 3.3, p("Tom Becker", "tom@beckerbuild.example"), "Kitchen remodel: revised quote", { files: [["quote-revised.pdf", 312000]] }),
  mk("1", 3.9, p("Tailspin Toys", "orders@tailspin.example"), "Your order has shipped", {}),
  mk("1", 4.2, p("Lakeside HOA", "board@lakesidehoa.example"), "Minutes from the annual meeting", { files: [["annual-meeting-minutes.pdf", 164000]] }),
  mk("1", 5.0, p("Maya Chen", "maya.chen@example.com"), "Saturday hike", {}),
  mk("1", 5.4, p("Dr. Rao's Office", "frontdesk@raoclinic.example"), "Appointment reminder: Thursday 9:30", { star: true }),
  mk("1", 6.1, p("Wide World Importers", "receipts@wwi.example"), "Receipt for your purchase #4471-2210", {}),
  mk("1", 6.6, p("Jordan Kim", "jordan.kim@example.com"), "Re: Weather station readings look off", { files: [["readings.csv", 38000]] }),
  mk("1", 7.2, p("Adventure Works", "news@adventureworks.example"), "Fall gear guide: layers that work", {}),
  mk("1", 8.0, p("Sam Rivera", "sam.rivera@example.com"), "Re: Board game night", {}),
  mk("1", 9.5, p("Registry Office", "no-reply@registry.example.gov"), "Your vehicle registration expires soon", { star: true }),
  mk("1", 11.0, p("Jordan Kim", "jordan.kim@example.com"), "3D printer settings for PETG", { files: [["petg-profile.zip", 12000], ["first-layer.jpg", 1100000]] }),
  mk("1", 12.3, p("Elena Novak", "elena.novak@example.com"), "Re: Volunteer schedule for the food bank", {}),
];
const PHOTO_MSG = mk("1", 13.0, p("Sam Rivera", "sam.rivera@example.com"), "Fwd: Photos from the coast trip", { files: [["IMG_1053.JPG", 812000], ["IMG_1230.JPG", 1930000], ["IMG_1254.JPG", 1720000]], cc: [p("Dana Brooks", "dana.brooks@example.com"), ME] });
inbox.push(PHOTO_MSG,
  mk("1", 15.0, p("Contoso Bank", "alerts@contoso.example"), "New sign-in from a new device", {}),
  mk("1", 17.2, p("Leo Martins", "leo.martins@example.com"), "Bike repair", { files: [["bike-estimate.pdf", 96000]] }),
  mk("1", 19.0, p("Harbor Photo Club", "club@harborphoto.example"), "Results of the autumn photo contest", { star: true }),
  mk("1", 22.0, p("Northwind Airlines", "no-reply@northwind.example"), "We have received your refund request", { star: true }),
  mk("1", 26.0, p("Priya Patel", "priya.patel@example.com"), "Recipe swap", {}),
  mk("1", 31.0, p("Fabrikam Utilities", "billing@fabrikam.example"), "Your bill for September is ready", {}),
  mk("1", 38.0, p("Elena Novak", "elena.novak@example.com"), "Volunteer schedule for the food bank", { files: [["schedule-november.xlsx", 22000]] }),
  mk("1", 47.0, p("Tom Becker", "tom@beckerbuild.example"), "Kitchen remodel: first quote", { files: [["quote.pdf", 298000], ["floor-plan.png", 640000]], star: true }),
  mk("1", 60.0, p("Maya Chen", "maya.chen@example.com"), "Trail map for next month", { files: [["trail-map.pdf", 2400000]] }),
  mk("1", 75.0, p("Sam Rivera", "sam.rivera@example.com"), "Coast trip planning", { star: true }),
  mk("1", 96.0, p("Jordan Kim", "jordan.kim@example.com"), "Robot arm servo test", { files: [["servo-test.mp4", 8600000]], star: true }),
);
PHOTO_MSG.html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px">
<p>These turned out great, see the attached ones from Saturday.</p><br>
<div>---------- Forwarded message ---------<br>From: <b>Dana Brooks</b> &lt;<a href="mailto:dana.brooks@example.com">dana.brooks@example.com</a>&gt;<br>
Date: Sat, ${new Date((NOW - 13.3 * DAY) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} at 7:42 PM<br>Subject: Photos from the coast trip<br>
To: <a href="mailto:sam.rivera@example.com">sam.rivera@example.com</a></div><br>
<p>Hi all, I took about forty photos at the cove this morning. Here are three of my favourites; the rest are in the shared album.
The light at the point was perfect around eight. Thanks for organising the trip! Same time next year? - Dana</p></div>`;

// Projects/Website: the design thread, and the project's other mail
const RE = "Re: Website redesign: staging feedback";
const website = [
  [0.2, ME, RE, [], "g"], [0.3, ROBIN, RE, [["gallery-fix.png", 420000]], "f"],
  [0.9, ROBIN, RE, [["staging-notes.pdf", 182000]], "d"], [1.1, ME, RE, [["contact-form.png", 310000]], "e"],
  [1.4, ME, RE, [["staging-checklist.xlsx", 18000]], "c"], [2.0, ROBIN, RE, [], "b"],
  [3.0, ROBIN, "Website redesign: staging feedback", [], "a"], [4.5, CASEY, "Logo files, final versions", [["logo-dark.png", 84000], ["logo-light.png", 79000]]],
  [6.0, CASEY, "Re: Colour palette options", [["palette-v2.png", 156000]]], [9.0, ROBIN, "Hosting renewal and DNS move", []],
  [14.0, CASEY, "Colour palette options", [["palette-options.pdf", 510000]]], [21.0, ROBIN, "Kickoff notes", [["kickoff-notes.docx", 41000]]],
].map(([d, from, s, files, id]) => mk("22", d, from, s, { files, ...(id ? inThread(id) : {}) }));
const DESIGN_MSG = website[2];
DESIGN_MSG.html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px">
<p>Hi Alex,</p>
<p>Thanks for turning the staging build around so quickly. I went through every page on my laptop and phone last night and it is a big step up: the new navigation is much easier to follow, and the pages load noticeably faster.</p>
<p>A few things I noticed, in rough order of importance:</p>
<ul><li>The contact form does not show a confirmation after sending, so I sent it three times.</li>
<li>On narrow screens the gallery thumbnails overlap the footer.</li>
<li>The dark header colour makes the logo hard to read; could we try the lighter variant Casey sent?</li></ul>
<p>I have put the details and screenshots in the attached notes. None of this blocks the launch date as far as I am concerned.</p>
<p>Thanks again,</p><p>Robin</p>
<p>On ${new Date((NOW - 1.1 * DAY) * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, Alex Morgan &lt;<a href="mailto:alex.morgan@example.com">alex.morgan@example.com</a>&gt; wrote:</p>
<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">
<p>Hi Robin,</p>
<p>The staging site is up with everything from our last call: the simplified menu, the new gallery, and the contact form wired to the shared inbox. I also compressed all the images, which roughly halved the page weight.</p>
<p>Could you click through it this week and send me anything that looks wrong? I would like to switch the DNS over before the end of the month.</p>
<p>- Alex</p></blockquote></div>`;

// The other projects, whose files the Attachments picture lists with the website's
const JORDAN = p("Jordan Kim", "jordan.kim@example.com");
const projects = [
  ["20", 5.5, "Servo wiring diagram", [["wiring-diagram.pdf", 265000]]], ["21", 7.0, "October readings", [["readings-october.csv", 52000]]],
  ["19", 8.0, "Bed levelling, step by step", [["bed-levelling.pdf", 730000]]], ["20", 12.0, "Gripper parts list", [["parts-list.xlsx", 27000]]],
  ["19", 16.0, "Benchy at 0.12 mm", [["benchy.jpg", 1300000]]], ["20", 18.0, "Arm firmware 0.4", [["arm-firmware-0.4.zip", 96000]]],
  ["21", 24.0, "Enclosure drawing, rev B", [["enclosure-rev-b.pdf", 388000]]],
].map(([folder, d, s, files]) => mk(folder, d, JORDAN, s, { files }));

const sent = [mk("2", 2.5, ME, RE, { to: ROBIN, ...inThread("s") }), mk("2", 2.2, ME, "Re: Saturday hike", { to: p("Maya Chen", "maya.chen@example.com") })];
const all = [...inbox, ...website, ...projects, ...sent];
for (const m of all) if (!m.html) m.html = `<p>${m.headers.subject}</p>`;
// The bytes of a file: the invented photos for pictures, the staging review for the PDF that is
// opened, and a few bytes for the rest, which are listed and never opened.
const bytesOf = (a, { photos, notesPdf }) => a.type === "image" ? photos[a.n % photos.length] : a.filename === "staging-notes.pdf" ? notesPdf : Buffer.from(a.filename);

// ---------- invented photos (SVG scenes rendered to JPEG) ----------
const grain = `<filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .07 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;
const SCENES = [
  // coastline with a lighthouse
  `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b8fc7"/><stop offset="1" stop-color="#cfe3f1"/></linearGradient>
   <linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f5f8f"/><stop offset="1" stop-color="#2f86a8"/></linearGradient>${grain}</defs>
   <rect width="1600" height="1067" fill="url(#s)"/><rect y="520" width="1600" height="547" fill="url(#w)"/>
   ${Array.from({ length: 26 }, (_, i) => `<path d="M${-40 + (i * 97) % 1640} ${560 + i * 19} q60 -10 120 0" stroke="#e8f4f8" stroke-opacity=".55" stroke-width="3" fill="none"/>`).join("")}
   <path d="M900 1067 L1050 640 Q1120 600 1200 650 L1600 560 L1600 1067Z" fill="#4b4237"/><path d="M1000 1067 L1120 760 L1600 700 L1600 1067Z" fill="#383128"/>
   <rect x="1268" y="430" width="34" height="150" fill="#f2efe9"/><rect x="1268" y="470" width="34" height="18" fill="#c0392b"/><rect x="1268" y="520" width="34" height="18" fill="#c0392b"/><path d="M1262 430 h46 l-8 -22 h-30z" fill="#2c2c2c"/>
   <path d="M0 1067 Q400 940 860 1000 L900 1067Z" fill="#e9dcc0"/><path d="M0 1010 Q420 900 880 965" stroke="#fff" stroke-width="6" stroke-opacity=".7" fill="none"/>
   <rect width="1600" height="1067" filter="url(#g)"/>`,
  // lake at dawn
  `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26355f"/><stop offset=".5" stop-color="#c9786a"/><stop offset=".62" stop-color="#f2b07a"/><stop offset="1" stop-color="#f8dcaa"/></linearGradient>
   <linearGradient id="l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0b386"/><stop offset=".5" stop-color="#9a7a8a"/><stop offset="1" stop-color="#2b3a67"/></linearGradient>
   <radialGradient id="sun"><stop offset="0" stop-color="#fff6d8"/><stop offset=".35" stop-color="#ffe7b0" stop-opacity=".9"/><stop offset="1" stop-color="#ffd08a" stop-opacity="0"/></radialGradient>
   <filter id="b"><feGaussianBlur stdDeviation="14"/></filter><filter id="b2"><feGaussianBlur stdDeviation="3"/></filter>${grain}</defs>
   <rect width="1600" height="1067" fill="url(#s)"/><circle cx="1000" cy="500" r="190" fill="url(#sun)"/><circle cx="1000" cy="500" r="42" fill="#fff6dc"/>
   <path d="M0 560 L180 400 L330 500 L520 310 L760 540 L860 500 L940 470 L1160 590 L1350 380 L1600 540 L1600 640 L0 640Z" fill="#4a5584" opacity=".9"/>
   <path d="M0 640 L240 520 L460 600 L700 500 L980 630 L1240 520 L1600 620 L1600 660 L0 660Z" fill="#2c3763"/>
   <rect y="660" width="1600" height="407" fill="url(#l)"/>
   <g filter="url(#b)"><ellipse cx="1000" cy="760" rx="60" ry="110" fill="#ffe9c0" opacity=".55"/></g>
   <g filter="url(#b2)" opacity=".5">${Array.from({ length: 9 }, (_, i) => `<rect x="${940 + (i % 3) * 12 - i * 2}" y="${680 + i * 22}" width="${120 - i * 9}" height="3" fill="#fff4dc"/>`).join("")}</g>
   ${Array.from({ length: 18 }, (_, i) => `<path d="M${i * 92 - 20} 1067 l40 -${150 + (i * 37) % 120} l40 ${150 + (i * 37) % 120}z" fill="#141a33"/>`).join("")}
   <rect width="1600" height="1067" filter="url(#g)"/>`,
  // green hills and a trail
  `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fb2e5"/><stop offset="1" stop-color="#e2eef8"/></linearGradient>${grain}</defs>
   <rect width="1600" height="1067" fill="url(#s)"/>
   <ellipse cx="380" cy="200" rx="160" ry="38" fill="#fff" opacity=".85"/><ellipse cx="470" cy="180" rx="120" ry="40" fill="#fff" opacity=".85"/><ellipse cx="1180" cy="260" rx="200" ry="34" fill="#fff" opacity=".7"/>
   <path d="M0 560 Q300 380 640 520 T1300 470 T1600 520 L1600 1067 L0 1067Z" fill="#8fb27a"/>
   <path d="M0 700 Q360 560 760 690 T1600 640 L1600 1067 L0 1067Z" fill="#5f9150"/>
   <path d="M0 860 Q420 760 900 880 T1600 840 L1600 1067 L0 1067Z" fill="#3f7238"/>
   <path d="M720 1067 Q760 900 860 800 Q960 720 1010 650" stroke="#d8c39a" stroke-width="40" fill="none" stroke-linecap="round"/>
   ${Array.from({ length: 9 }, (_, i) => `<circle cx="${120 + i * 170}" cy="${930 - (i % 3) * 30}" r="${38 + (i % 4) * 8}" fill="#2f5a2b"/>`).join("")}
   <rect width="1600" height="1067" filter="url(#g)"/>`,
];

// The staging review attached to the design thread, typeset by Chromium as a two-page PDF.
const NOTES_HTML = `<!DOCTYPE html><html><head><style>
  @page { size: Letter; margin: 0.7in 0.75in; }
  body { font: 10.5pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1f2933; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #c2551f; padding-bottom: 10px; margin-bottom: 18px; }
  h1 { font-size: 21pt; margin: 0; letter-spacing: -0.3px; } .sub { color: #66717d; margin-top: 2px; }
  .meta { text-align: right; color: #66717d; font-size: 9pt; line-height: 1.6; }
  h2 { font-size: 12.5pt; color: #c2551f; margin: 20px 0 6px; }
  .summary { display: flex; gap: 12px; margin: 12px 0 4px; }
  .stat { flex: 1; border: 1px solid #e3e7eb; border-radius: 6px; padding: 10px 12px; }
  .stat b { display: block; font-size: 18pt; color: #1f2933; } .stat span { color: #66717d; font-size: 9pt; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 9.5pt; }
  th { text-align: left; background: #f3f5f7; color: #3e4c59; font-weight: 600; padding: 7px 8px; border-bottom: 1px solid #d9dee3; }
  td { padding: 7px 8px; border-bottom: 1px solid #eceff2; vertical-align: top; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 8.5pt; font-weight: 600; }
  .high { background: #fde4dc; color: #a33d12; } .med { background: #fdf1d3; color: #8a5a00; } .low { background: #e3f1e7; color: #2f6b3d; }
  .shots { display: flex; gap: 22px; align-items: flex-start; margin-top: 10px; }
  .frame { border: 1px solid #cfd6dc; border-radius: 8px; padding: 8px; background: #fafbfc; }
  .bar { height: 18px; background: #233142; border-radius: 3px; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .grid div { height: 40px; background: linear-gradient(135deg, #8fb3c9, #5d7f96); border-radius: 3px; }
  .foot { height: 22px; background: #d9dee3; border-radius: 3px; margin-top: 8px; }
  .phone { width: 120px; } .phone .grid { grid-template-columns: 1fr 1fr; } .phone .grid div:nth-child(n+5) { outline: 2px solid #d9480f; }
  .phone .foot { margin-top: -14px; opacity: .85; } .cap { font-size: 8.5pt; color: #66717d; margin-top: 6px; text-align: center; }
  ul { margin: 4px 0; padding-left: 18px; } li { margin: 3px 0; }
  .check li { list-style: none; margin-left: -18px; } .check li::before { content: "\\2713"; color: #2f6b3d; font-weight: 700; margin-right: 8px; }
  .page2 { break-before: page; }
</style></head><body>
<header><div><h1>Website redesign</h1><div class="sub">Staging review, build 0.9.3</div></div>
<div class="meta">Reviewed by Robin Hale<br>Desktop, tablet and phone<br>12 pages checked</div></header>
<p>The staging build is a clear improvement over the current site. Navigation is simpler, pages are lighter, and the new typography reads well on every screen size tested. The issues below are listed by priority; none of them blocks the planned launch.</p>
<div class="summary"><div class="stat"><b>12</b><span>pages reviewed</span></div><div class="stat"><b>1.4 s</b><span>median load, was 3.1 s</span></div><div class="stat"><b>5</b><span>issues found</span></div><div class="stat"><b>0</b><span>launch blockers</span></div></div>
<h2>Issues</h2>
<table><tr><th style="width:22%">Area</th><th>Finding</th><th style="width:13%">Priority</th></tr>
<tr><td>Contact form</td><td>No confirmation after sending; the form simply clears, so it is easy to send twice.</td><td><span class="pill high">High</span></td></tr>
<tr><td>Gallery</td><td>Below 400 px wide, the last row of thumbnails overlaps the footer (sketch below).</td><td><span class="pill high">High</span></td></tr>
<tr><td>Header</td><td>The dark header colour leaves too little contrast for the logo; try the lighter variant.</td><td><span class="pill med">Medium</span></td></tr>
<tr><td>Blog</td><td>Post dates use two formats on the index and article pages.</td><td><span class="pill low">Low</span></td></tr>
<tr><td>Footer</td><td>The newsletter link opens in the same tab and loses the reader's place.</td><td><span class="pill low">Low</span></td></tr></table>
<h2>Gallery on narrow screens</h2>
<div class="shots"><div><div class="frame" style="width:300px"><div class="bar"></div><div class="grid">${"<div></div>".repeat(6)}</div><div class="foot"></div></div><div class="cap">Desktop: correct</div></div>
<div><div class="frame phone"><div class="bar"></div><div class="grid">${"<div></div>".repeat(6)}</div><div class="foot"></div></div><div class="cap">Phone: last row under the footer</div></div></div>
<section class="page2"><h2>Checked and working</h2>
<ul class="check"><li>Navigation menu on desktop, tablet and phone</li><li>Search, including empty and misspelled queries</li><li>Image loading on slow connections</li><li>Keyboard navigation and visible focus</li><li>Print layout of the project pages</li><li>Links and redirects from the old site structure</li></ul>
<h2>Next steps</h2><ul><li>Fix the two high-priority items before launch.</li><li>Casey to send the light logo variant for the header.</li><li>Second pass on phones once the gallery fix is in.</li></ul></section>
</body></html>`;

async function renderNotesPdf(ctx) {
  const pg = await ctx.newPage();
  await pg.setContent(NOTES_HTML);
  const pdf = await pg.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
  await pg.close();
  return pdf;
}

async function renderPhotos(ctx) {
  const pg = await ctx.newPage();
  await pg.setViewportSize({ width: 1600, height: 1067 });
  const out = [];
  for (const s of SCENES) {
    await pg.setContent(`<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067" viewBox="0 0 1600 1067">${s}</svg></body></html>`);
    out.push(await pg.screenshot({ type: "jpeg", quality: 86 }));
  }
  await pg.close();
  return out;
}

// The photos and the staging review, drawn once for both editions.
async function renderAssets() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const assets = { photos: await renderPhotos(ctx), notesPdf: await renderNotesPdf(ctx) };
  await browser.close();
  return assets;
}

// ---------- the mocked Yahoo ----------
// A list is newest first, as a mail service answers it.
function listFor(q) {
  const newest = list => list.slice().sort((a, b) => b.headers.date - a.headers.date);
  if (q.includes("is:flagged")) return newest(all.filter(m => m.flags.flagged && m.folder.id !== "2"));
  // all mail with one person (a contact's page)
  const who = (q.match(/from:\("([^"]+)"\) OR to:/) || [])[1];
  if (who) return newest(all.filter(m => [...m.headers.from, ...m.headers.to].some(a => a.email === who)));
  // a conversation, in every folder (Show conversation)
  const conv = (q.match(/conversationId:(\d+)/) || [])[1];
  if (conv) return newest(all.filter(m => m.conversationId === conv));
  // a folder, or a folder with its subfolders; with has:attachment, their mail that carries files (Show attachments)
  const scope = (q.match(/folderId:\(([^)]+)\)/) || [])[1]?.split(" OR ") || [(q.match(/folderId:(\d+)/) || [])[1] || "1"];
  return newest(all.filter(m => scope.includes(m.folder.id) && (!q.includes("has:attachment") || m.attachmentCount)));
}
// Where the staging feedback with the review is in its folder's list, in either edition.
const DESIGN_ROW = listFor("folderId:22").indexOf(DESIGN_MSG);

// The release check sees the installed version, so Settings shows no update note.
async function sameVersion(ctx, ext) {
  const version = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8")).version;
  await ctx.route("https://api.github.com/**", route => route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ tag_name: `v${version}` }) }));
}

// An edition opened on the mailbox: { ctx, page, ext (its folder), restore() (the mailbox as it
// was, after a scene that changed it), close() }.
// The Yahoo edition, as dist/ has it.
async function openYahoo({ W, H }, assets) {
  const ext = build("yahoo");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "baltazar-mail-shots-"));
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: { width: W, height: H },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  await ctx.route("https://mail.yahoo.com/**", async route => {
    const req = route.request();
    if (req.url() === "https://mail.yahoo.com/") return route.fulfill({ contentType: "text/html", body: `<html><script>window.AppBootstrapData={"appId":"YMailCLDNovation","mailWssid":"w1","primaryMailbox":{"email":"${ME.email}","id":"MB1"}}</script></html>` });
    const post = req.postData() || "";
    const m = post.match(/name="batchJson"\r\n\r\n([\s\S]*?)\r\n--/);
    const top = m ? JSON.parse(m[1]).requests[0] : {};
    const uri = top.uri || "";
    let result;
    if (uri.endsWith("/folders")) result = { folders, accounts: [] };
    else if (uri.endsWith("/accounts")) result = { accounts: [{ id: "1", email: ME.email, sendingName: ME.name, isPrimary: true, isSending: true }] };
    else if (uri.includes("/content/simplebody/full")) {
      const id = uri.match(/@\.id==([^/]+)\/content/)[1];
      const msg = all.find(x => x.id === id) || all[0];
      result = { message: msg, simpleBody: { html: msg.html } };
    } else if (/"method":"(POST|DELETE)"/.test(post)) {
      // flags and moves are kept, with the folders' counts, as the server keeps them, so what is
      // listed afterwards shows them
      const count = (folderId, total, unread) => { const f = folders.find(x => x.id === folderId); if (f) { f.total += total; f.unread += unread; f.highestModSeq++; } };
      for (const r of m ? JSON.parse(m[1]).requests : []) {
        const id = (decodeURIComponent(r.uri || "").match(/id:\(([^)]+)\)/) || [])[1], msg = all.find(x => x.id === id), change = r.payload?.message;
        if (!msg || !change) continue;
        if (change.flags && "read" in change.flags && change.flags.read !== msg.flags.read) count(msg.folder.id, 0, change.flags.read ? -1 : 1);
        if (change.flags) msg.flags = { ...msg.flags, ...change.flags };
        if (change.folder?.id && change.folder.id !== msg.folder.id) {
          count(msg.folder.id, -1, msg.flags.read ? 0 : -1); count(change.folder.id, 1, msg.flags.read ? 0 : 1);
          msg.folder = { id: change.folder.id, name: fname(change.folder.id) };
        }
      }
      const ids = [...post.matchAll(/"id":"((?:UnifiedUpdateMessage|UnifiedDeleteMessage)_\d+)"/g)].map(x => x[1]);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses: ids.map(id => ({ id, httpCode: 204 })) } }) });
    } else {
      const q = decodeURIComponent(uri.split("q=")[1] || "");
      const count = Number((q.match(/count:(\d+)/) || [])[1] || 100), offset = Number((q.match(/offset:(\d+)/) || [])[1] || 0);
      result = { messages: listFor(q).slice(offset, offset + count), query: {} };
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses: [{ id: top.id, httpCode: 200, response: { result } }] }, error: null }) });
  });
  // A picture's thumbnail and download: the invented photo that stands for it.
  await ctx.route("https://cloud-apis.mail.yahoo.com/**", route => {
    const n = Number((route.request().url().match(/\/(?:thumb|dl)\/(\d+)/) || [])[1] || 0);
    return route.fulfill({ contentType: "image/jpeg", body: assets.photos[n % assets.photos.length] });
  });
  // Raw message source, from which the extension cuts attachment bytes.
  await ctx.route("https://apis.mail.yahoo.com/**", route => {
    const b64 = buf => buf.toString("base64").replace(/.{76}/g, "$&\r\n");
    const part = a => `--B\r\nContent-Type: ${a.mime}; name="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename}"\r\n\r\n${b64(bytesOf(a, assets))}\r\n`;
    const msg = all.find(x => route.request().url().includes(`@.id==${x.id}/`)) || PHOTO_MSG;
    const raw = "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nBody\r\n" + msg.attachments.map(part).join("") + "--B--\r\n";
    return route.fulfill({ contentType: "text/plain", body: raw });
  });
  await sameVersion(ctx, ext);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/mail.html`);
  const kept = { messages: all.map(m => [m, m.flags, m.folder]), folders: folders.map(f => [f, f.total, f.unread]) };
  const restore = () => {
    for (const [m, flags, folder] of kept.messages) Object.assign(m, { flags, folder });
    for (const [f, total, unread] of kept.folders) Object.assign(f, { total, unread });
  };
  return { ctx, page, ext, restore, close: async () => { await ctx.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
}

// ---------- the same mailbox in the mocked Gmail ----------
// A folder is a label (Inbox, Sent, Drafts, Spam and Trash are Gmail's own, and Yahoo's Archive
// is none, as archived mail has no label). A message keeps its date, people, text, files and
// place in its conversation. Each label says the counts its Yahoo folder says, changed by what is
// done to its messages here, and All Mail the sum of them. Returns what puts the labels of every
// message back as they were filled.
const SYSTEM_LABEL = { 1: "INBOX", 2: "SENT", 3: "DRAFT", 4: "TRASH", 6: "SPAM" };
const labelOf = id => SYSTEM_LABEL[id] || `Label_${id}`;
function fillGmail(state, assets) {
  const addr = a => `"${a.name}" <${a.email}>`;
  state.messages.clear(); state.attachments.clear(); state.drafts.length = 0;
  state.profile.emailAddress = ME.email;
  state.sendAs = [{ sendAsEmail: ME.email, displayName: ME.name, isPrimary: true, verificationStatus: "accepted" }];
  state.labels = [...state.labels.filter(l => l.type === "system"),
    ...folders.filter(f => f.types[0] === "USER").map(f => ({ id: labelOf(f.id), name: f.name, type: "user", labelListVisibility: "labelShow" }))];
  all.forEach((m, i) => {
    const h = m.headers;
    const made = state.addMessage({ id: `g${i + 1}`, threadId: `t${m.conversationId}`, labels: [labelOf(m.folder.id), ...(m.flags.read ? [] : ["UNREAD"]), ...(m.flags.flagged ? ["STARRED"] : [])],
      subject: h.subject, from: addr(h.from[0]), to: h.to.map(addr).join(", "), cc: h.cc.map(addr).join(", "), date: Number(h.date), html: m.html, inline: [],
      files: m.attachments.map(a => ({ name: a.filename, type: a.mime, bytes: bytesOf(a, assets) })), messageId: h.messageIdRfc822 || null, inReplyTo: h.inReplyTo || null });
    made.snippet = "";
    // a file says the size the mailbox gives it, whatever bytes stand for it
    m.attachments.forEach((a, k) => { made.payload.parts[k + 1].body.size = a.size; });
  });
  const real = id => { const of = [...state.messages.values()].filter(m => m.labelIds.includes(id)); return { total: of.length, unread: of.filter(m => m.labelIds.includes("UNREAD")).length }; };
  const said = new Map(folders.map(f => [labelOf(f.id), { total: f.total, unread: f.unread, was: real(labelOf(f.id)) }]));
  const everywhere = folders.filter(f => !["4", "6"].includes(f.id)).reduce((n, f) => n + f.total, 0);
  state.countsOf = id => {
    if (id === "ALL") return { messagesTotal: everywhere, messagesUnread: 0 };
    const s = said.get(id), now = s && real(id);
    return s ? { messagesTotal: s.total + now.total - s.was.total, messagesUnread: s.unread + now.unread - s.was.unread } : null;
  };
  const kept = [...state.messages.values()].map(m => [m, m.labelIds.slice()]);
  return () => { for (const [m, labels] of kept) m.labelIds = labels.slice(); };
}

// Contacts of the Gmail edition is built from the message headers a little at a time, starting
// two minutes after the mailbox first opened and only while nobody uses the app. The page is told
// the time has come and is loaded as a tab in the background until the book is built.
async function buildContacts(page) {
  const built = () => page.evaluate(() => new Promise(done => {
    const r = indexedDB.open("baltazar-mail");
    r.onerror = () => done(null);
    r.onsuccess = () => {
      try {
        const t = r.result.transaction("meta", "readonly"), q = t.objectStore("meta").get("built");
        t.oncomplete = () => { r.result.close(); done(q.result?.value ?? null); };
        t.onerror = () => { r.result.close(); done(null); };
      } catch { r.result.close(); done(null); }
    };
  }));
  await page.evaluate(() => chrome.storage.local.set({ contactsAfter: 1 }));
  await page.addInitScript(() => {
    try {
      if (window.top !== window || !sessionStorage.getItem("hiddenTab")) return;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    } catch {}
  });
  await page.evaluate(() => sessionStorage.setItem("hiddenTab", "1"));
  await page.reload();
  await page.waitForSelector("#rows .row");
  for (let i = 0; i < 240 && !(await built()); i++) await page.waitForTimeout(500);
  if (!(await built())) throw new Error("the Gmail edition's Contacts was not built in two minutes");
  await page.evaluate(() => { sessionStorage.removeItem("hiddenTab"); delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); });
}

// The Gmail edition, as the browser suites build it (no Google client of anyone's), signed in as
// the suites sign it in: with the token the app would have got from Google.
async function openGmail({ W, H }, assets) {
  const { launch, buildForTest } = require("./harness.js");
  const ext = buildForTest("gmail");
  const h = await launch({ provider: "gmail", gmail: { mime: await import("../ext/mime.js") } });
  const restore = fillGmail(h.gmail, assets);
  await sameVersion(h.ctx, ext);
  const { page } = h;
  await page.setViewportSize({ width: W, height: H });
  await h.open();
  await page.evaluate(email => chrome.storage.session.set({ gmToken: { access_token: "test", expires: Date.now() + 3600e3, email } }), ME.email);
  await page.reload();
  await page.waitForSelector("#rows .row");
  await buildContacts(page);
  return { ctx: h.ctx, page, ext, restore, close: h.close };
}

// ---------- the scenes ----------
// b: an edition opened on the mailbox; o: { W, H, shots: the folder the pictures go to, store }.
async function scenes(b, o) {
  const { page } = b, { W, H } = o;
  const LIST_W = o.store ? 505 : 560, FOLDER_W = o.store ? 190 : 230;
  const shot = (name, opts = {}) => page.screenshot({ path: path.join(o.shots, name), ...opts });
  const setup = async s => {
    await page.evaluate(s => chrome.storage.local.set({ settings: { pollSec: 600, markReadSec: null, ...s } }), s);
    await page.reload();
    await page.waitForSelector("#rows .row");
    await page.waitForFunction(() => /\d/.test(document.querySelector("#folder-list .folder.view .ct")?.textContent || ""));
  };
  const openRow = async subject => {
    await page.locator("#rows .row", { hasText: subject }).first().click();
    await page.waitForFunction(s => document.getElementById("r-subject").textContent === s, subject);
    await page.waitForTimeout(700);
  };
  const openWebsite = async () => {
    await page.locator("#folder-list .folder", { hasText: "Website" }).click();
    await page.waitForFunction(() => document.getElementById("list-title").textContent === "Projects/Website");
  };
  const light = { layout: "vertical", theme: "light", lightTheme: "light", folderW: FOLDER_W, listW: LIST_W, expanded: ["Projects"] };

  // 1. light, three columns, message with photo attachments
  await setup(light);
  await openRow("Fwd: Photos from the coast trip");
  await page.waitForFunction(() => document.querySelectorAll("#r-attach .att-thumb img").length === 3);
  await page.mouse.move(W - 5, H - 5);
  await shot("light.png");

  // 2. the attachment viewer: the design thread's PDF review
  await openWebsite();
  await page.locator("#rows .row").nth(DESIGN_ROW).click();
  await page.waitForFunction(s => document.getElementById("r-subject").textContent === s, DESIGN_MSG.headers.subject);
  await page.waitForSelector("#r-attach .att-card");
  await page.locator("#r-attach .att-card").first().click();
  const pdfFrame = async () => { for (let i = 0; i < 100; i++) { const f = page.frames().find(f => f.url().endsWith("/render.html") && !f.isDetached()); if (f) return f; await page.waitForTimeout(100); } };
  const viewerFrame = await pdfFrame();
  await viewerFrame.waitForFunction(() => document.querySelectorAll(".page canvas, .canvasWrapper canvas").length >= 1 && document.querySelector(".textLayer span"), null, { timeout: 20000 });
  // zoomed out to show the whole first page
  for (let i = 0; i < 3; i++) { await page.locator("#v-zout").click(); await page.waitForTimeout(250); }
  await viewerFrame.waitForFunction(() => document.querySelector(".textLayer span"), null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.mouse.move(W - 5, H - 5);
  await shot("viewer.png");
  await viewerFrame.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitForSelector("#viewer.hidden", { state: "attached" });

  // 3. dark, messages above the preview: the design thread as a conversation, and the undo
  // history open over it with its oldest action taken back alone. The mailbox is put back after.
  await setup({ layout: "horizontal", theme: "dark", darkTheme: "dark", folderW: 230, listH: 36, expanded: ["Projects"] });
  await openWebsite();
  for (const [subject, key] of [["Hosting renewal and DNS move", "e"], ["Logo files, final versions", "s"]]) {
    await page.locator("#rows .row", { hasText: subject }).first().click(); await page.waitForTimeout(400);
    await page.keyboard.press(key); await page.waitForTimeout(600);
  }
  await page.locator("#rows .row").nth(DESIGN_ROW).click();     // Robin's feedback, with the review attached
  await page.waitForFunction(s => document.getElementById("r-subject").textContent === s, DESIGN_MSG.headers.subject);
  await page.keyboard.press("w");
  await page.waitForFunction(() => document.getElementById("list-title").textContent.startsWith("Conversation"));
  await page.waitForTimeout(600);
  await page.keyboard.press("s"); await page.waitForTimeout(600);
  await page.keyboard.press("y"); await page.waitForSelector("#history:not(.hidden)");
  await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#history .h-row.undone:not(.working)"));
  await page.waitForTimeout(800);
  await page.mouse.move(W - 5, 60);
  await shot("dark.png");
  await page.keyboard.press("Escape");
  b.restore();

  // 4. Contacts, in the light theme: the people written to, and one person's page
  await setup(light);
  await page.locator("#contacts-link").click();
  await page.waitForSelector("#p-rows .prow");
  await page.locator("#p-rows .prow", { hasText: "Maya Chen" }).first().click();
  await page.waitForSelector("#person .p-msg");
  await page.mouse.move(W - 5, H - 5);
  await shot("contacts.png");

  // 5. a folder's attachments, in the light theme: the files in the mail of Projects and its
  // subfolders, and the message one of them came with
  await setup(light);
  await page.locator("#folder-list .folder", { has: page.locator(".nm", { hasText: /^Projects$/ }) }).click({ button: "right" });
  await page.locator('#ctx [data-act="files"]').click();
  await page.waitForSelector("#f-subs:not(.hidden)");
  await page.locator("#f-subs-box").check();
  await page.locator("#f-rows .frow", { hasText: "staging-notes.pdf" }).click();
  await page.waitForFunction(s => document.getElementById("r-subject").textContent === s, DESIGN_MSG.headers.subject);
  await page.waitForSelector("#r-attach .att-card");
  await page.waitForTimeout(700);
  await page.mouse.move(W - 5, H - 5);
  await shot("attachments.png");

  // 6. Settings, in the light theme, with the default intervals: the whole panel, with the app
  // hidden behind it
  await setup({ layout: "vertical", theme: "light", lightTheme: "light", folderW: FOLDER_W, listW: LIST_W, pollSec: 20, markReadSec: 2 });
  await page.locator("#list").focus(); await page.keyboard.press(",");
  await page.evaluate(() => { document.getElementById("app").style.visibility = "hidden"; });
  await page.waitForSelector("#settings:not(.hidden)");
  await page.waitForTimeout(300);
  const need = await page.locator("#settings-box").evaluate(e => e.scrollHeight + 2);   // with its borders
  if (o.store) {
    // The panel is taller than a store's picture, which has one size. The window is made as much
    // larger as the whole panel needs, with a margin of 24 px above and below it, and drawn as
    // much smaller, as a browser zoomed out shows it, so the picture is a whole window of the
    // store's size still. The panel's cap of 90% of the window's height, which makes it scroll in
    // a small window, is lifted, so the zoom is no smaller than the panel itself asks for.
    const zoom = [1, 4 / 5, 8 / 11, 2 / 3, 16 / 25, 5 / 8, 1 / 2].find(z => need + 48 <= H / z);
    if (!zoom) throw new Error(`the Settings panel (${need} px) does not fit a store's picture at half size`);
    await page.locator("#settings-box").evaluate(e => { e.style.maxHeight = "none"; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(W / zoom), height: Math.round(H / zoom), deviceScaleFactor: zoom, mobile: false });
    await page.waitForTimeout(400);
    const png = Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64");
    if (png.readUInt32BE(16) !== W || png.readUInt32BE(20) !== H) throw new Error(`the Settings picture came out ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    fs.writeFileSync(path.join(o.shots, "settings.png"), png);
    await cdp.detach();
    await page.setViewportSize({ width: W, height: H });
    return;
  }
  // The README shows the panel alone: the window grows until the whole panel fits under its cap.
  if (need > 0.9 * H) { await page.setViewportSize({ width: W, height: Math.ceil(need / 0.9) + 1 }); await page.waitForTimeout(300); }
  const box = await page.locator("#settings-box").boundingBox(), pad = 16;
  await shot("settings.png", { clip: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad } });
}

// ---------- what a store shows beside the screenshots ----------
// The logo, and the promotional tiles: icon, name and tagline, the large one with what sets the
// app apart and a slice of a screenshot. A tile follows its edition's icon, so the two items tell
// apart in a store as the two icons do in the toolbar. The Yahoo edition's envelope sits on a dark
// tile, and its promotional tiles are dark, in the Graphite palette, around the light-theme
// screenshot; the Gmail edition's envelope has no background, and its tiles are light, in the
// Paper palette, around the dark-theme one.
const TILE = {
  yahoo: { of: "", tag: "Fast, ad-free Yahoo Mail™ client", shot: "light.png", back: "radial-gradient(circle at 25% 30%,#242a31,#15181c 70%)",
    name: "#efe9da", accent: "#d9a441", text: "#c9c4b7", edge: "#3a424c", shadow: "rgba(0,0,0,.55)" },
  gmail: { of: "for Gmail™", tag: "Fast, ad-free mail client", shot: "dark.png", back: "radial-gradient(circle at 25% 30%,#fbf9f4,#e4dece 75%)",
    name: "#1c1a17", accent: "#94570e", text: "#4f4c44", edge: "#c2bbac", shadow: "rgba(40,30,10,.35)" },
};
// What the large tile says of the app, in the order a reader takes it in: what the screenshot
// beside it shows, what no webmail does, and why it can be trusted with mail.
const POINTS = ["PDFs, documents and photos open in place", "Undo for everything, even Send", "No tracking pictures, no server in between"];
async function brand(b, o, edition) {
  const icon = `data:image/svg+xml;base64,${fs.readFileSync(path.join(b.ext, "icons", "icon.svg")).toString("base64")}`;
  const pg = await b.ctx.newPage();
  await pg.setViewportSize({ width: 300, height: 300 });
  await pg.setContent(`<html><body style="margin:0;background:transparent"><img src="${icon}" width="300" height="300"></body></html>`);
  await pg.screenshot({ path: path.join(o.out, "logo-300.png"), omitBackground: true });

  const t = TILE[edition], { of, tag } = t;
  const shot = `data:image/png;base64,${fs.readFileSync(path.join(o.shots, t.shot)).toString("base64")}`;
  const font = "font-family:Inter,'Segoe UI','Helvetica Neue',Arial,sans-serif";   // single quotes: it sits in a style attribute
  const tiles = [
    ["promo-small.png", 440, 280, `
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${of ? 6 : 10}px">
        <img src="${icon}" width="${of ? 84 : 92}" height="${of ? 84 : 92}">
        <div style="font-size:36px;font-weight:700;color:${t.name};letter-spacing:-0.5px">Baltazar Mail</div>
        ${of ? `<div style="font-size:22px;font-weight:600;color:${t.name};margin-top:-6px">${of}</div>` : ""}
        <div style="font-size:16px;color:${t.accent}${of ? ";margin-top:4px" : ""}">${tag}</div>
      </div>`],
    ["promo-large.png", 1400, 560, `
      <div style="position:absolute;left:90px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center">
        <div style="display:flex;align-items:center;gap:22px"><img src="${icon}" width="104" height="104">
          <div style="font-size:60px;font-weight:700;color:${t.name};letter-spacing:-1px;line-height:1.05">Baltazar<br>Mail${of ? `<div style="font-size:32px;font-weight:600;letter-spacing:-0.3px;margin-top:6px">${of}</div>` : ""}</div></div>
        <div style="font-size:27px;color:${t.accent};margin:26px 0 22px">${tag}</div>
        ${POINTS.map(p =>
          `<div style="font-size:21px;color:${t.text};margin:6px 0;display:flex;align-items:center;gap:14px"><span style="flex:none;width:9px;height:9px;border-radius:50%;background:${t.accent}"></span>${p}</div>`).join("")}
      </div>
      <img src="${shot}" style="position:absolute;left:720px;top:70px;width:900px;border-radius:10px;box-shadow:0 18px 50px ${t.shadow};border:1px solid ${t.edge}">`],
  ];
  for (const [file, w, h, body] of tiles) {
    await pg.setViewportSize({ width: w, height: h });
    await pg.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;position:relative;${font};background:${t.back}">${body}</body></html>`);
    await pg.waitForTimeout(200);
    await pg.screenshot({ path: path.join(o.out, file) });
  }
  await pg.close();
}

// The page a new install of the Gmail edition opens with: its setup guide at the first step, in a
// window of the store's size and the light theme.
async function setupShot(file, { W, H }) {
  const h = await require("./harness.js").launch({ provider: "gmail" });
  const { page, extId } = h;
  await page.setViewportSize({ width: W, height: H });
  await page.goto(`chrome-extension://${extId}/mail.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { theme: "light", lightTheme: "light" } }));
  await page.reload();
  await page.waitForSelector("#signin:not(.hidden) .g-step.now");
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: file });
  await h.close();
}

// One edition's pictures. o: { W, H, out: the folder that holds screenshots/, store }.
async function draw(edition, o, assets) {
  o = { ...o, shots: path.join(o.out, "screenshots") };
  fs.mkdirSync(o.shots, { recursive: true });
  const b = await (edition === "gmail" ? openGmail : openYahoo)(o, assets);
  await scenes(b, o);
  if (o.store) await brand(b, o, edition);
  await b.close();
  if (o.store && edition === "gmail") await setupShot(path.join(o.shots, "setup.png"), o);
  console.log(`${path.relative(ROOT, o.out).replaceAll("\\", "/")}: wrote ${[...fs.readdirSync(o.out).filter(n => n.endsWith(".png")), ...fs.readdirSync(o.shots).map(n => `screenshots/${n}`)].join(", ")}`);
}

const DOCS = path.join(ROOT, "docs");
(async () => {
  for (const name of NAMED) if (!EDITIONS[name]) throw new Error(`unknown edition ${name}`);
  if (NAMED.length && !STORE) throw new Error("the README's pictures are of the Yahoo edition; name an edition with --store");
  const assets = await renderAssets();
  if (STORE) for (const edition of NAMED.length ? NAMED : Object.keys(EDITIONS)) await draw(edition, { W: 1280, H: 800, out: path.join(ROOT, "store", edition), store: true }, assets);
  else { await draw("yahoo", { W: 1600, H: 900, out: DOCS, store: false }, assets); await signInShots(); }
})().catch(e => { console.error(e); process.exit(1); });

// The Gmail edition's sign-in page, for docs/gmail-sign-in.md: a build that carries no Google
// client, as a release does, taken through its setup guide against the mocked Gmail of the browser
// suites. Light theme only; each picture is the page's column alone. The Client ID is invented.
async function signInShots() {
  const { launch } = require("./harness.js");
  const h = await launch({ provider: "gmail", gmail: { mime: await import("../ext/mime.js") } });
  const { page, extId, gmail } = h;
  const WIDTH = 900;
  await page.setViewportSize({ width: WIDTH, height: 900 });
  await page.goto(`chrome-extension://${extId}/mail.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { theme: "light", lightTheme: "light" } }));
  await page.reload();
  await page.waitForSelector("#signin:not(.hidden) .g-step.now");
  // The window grows until the whole column fits, then the picture is cut to the column.
  const shot = async file => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(2, 2);
    const need = await page.evaluate(() => document.getElementById("signin").scrollHeight);
    if (need > page.viewportSize().height) await page.setViewportSize({ width: WIDTH, height: need });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const rs = [...document.querySelectorAll("#signin > *")].filter(e => e.offsetParent).map(e => e.getBoundingClientRect());
      return { x: Math.min(...rs.map(b => b.left)), y: Math.min(...rs.map(b => b.top)), right: Math.max(...rs.map(b => b.right)), bottom: Math.max(...rs.map(b => b.bottom)) };
    });
    const pad = 20;
    await page.screenshot({ path: path.join(DOCS, "screenshots", file), clip: { x: r.x - pad, y: r.y - pad, width: r.right - r.x + 2 * pad, height: r.bottom - r.y + 2 * pad } });
  };
  const at = step => page.waitForSelector(`.g-step.now[data-step="${step}"]`);

  await shot("signin-guide.png");
  await page.locator(".g-step.now .g-next").click();
  await page.locator("#g-paste-in").fill("GOCSPX-x1y2z3");
  await shot("signin-paste.png");
  await page.locator("#g-paste-in").fill("123456789012-abc123def456ghi789.apps.googleusercontent.com");
  await page.locator("#g-paste-in").press("Enter");
  await at("api");
  await shot("signin-api.png");
  await page.locator(".g-step.now .g-next").click();
  await at("signin");
  await shot("signin-button.png");
  // Google's window closed early, with the entry for its most common error open
  gmail.flowAnswer = { reject: "The user did not approve access." };
  await page.locator("#retry").click();
  await page.waitForSelector("#signin-alert:not(.hidden)");
  await page.locator('#signin-help details[data-help="redirect_uri_mismatch"] summary').click();
  await shot("signin-help.png");
  // the page once the setup is done and the user has signed out
  await page.evaluate(() => chrome.storage.local.remove("gmSetup"));
  await page.reload();
  await page.waitForSelector("#signin:not(.hidden) #signin-notes:not(.hidden)");
  await shot("signin-ready.png");
  await h.close();
}
