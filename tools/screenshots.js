// README screenshots: the real extension in Chromium against a mocked Yahoo backend filled with
// invented mail, so no real names, addresses or messages appear. node tools/screenshots.js
// Writes docs/screenshots/{light,viewer,dark}.png.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXT = path.join(__dirname, "..", "ext");
const OUT = path.join(__dirname, "..", "docs", "screenshots");
const W = 1600, H = 900;
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

let seq = 0;
const mk = (folder, daysAgo, from, subject, o = {}) => ({
  id: `M${folder}_${++seq}`, conversationId: `C${seq}`, size: 4000, csid: `cs${seq}`,
  flags: { read: o.unread ? false : true, flagged: !!o.star },
  attachmentCount: o.att || 0,
  headers: { subject, from: [from], to: [o.to || ME], cc: o.cc || [], date: String(NOW - Math.round(daysAgo * DAY) - (seq % 7) * 1800) },
  folder: { id: folder, name: fname(folder) }, snippet: o.snippet || "",
});
const p = (name, email) => ({ name, email });

const inbox = [
  mk("1", 0.1, p("Maya Chen", "maya.chen@example.com"), "Re: Saturday hike, meet at the trailhead?", { unread: true }),
  mk("1", 0.3, p("Contoso Bank", "alerts@contoso.example"), "Your October statement is ready", { unread: true }),
  mk("1", 0.6, p("Northwind Airlines", "no-reply@northwind.example"), "Your boarding pass for flight NW 482", { star: true }),
  mk("1", 1.2, p("Leo Martins", "leo.martins@example.com"), "Re: Bike repair", {}),
  mk("1", 1.5, p("Fabrikam Utilities", "billing@fabrikam.example"), "Your bill for October is ready", { unread: true }),
  mk("1", 2.1, p("City Library", "notices@library.example.org"), "Two items are due on Monday", {}),
  mk("1", 2.4, p("Priya Patel", "priya.patel@example.com"), "Re: Recipe swap", { att: 1 }),
  mk("1", 3.0, p("Harbor Photo Club", "club@harborphoto.example"), "November meetup: night photography", { star: true }),
  mk("1", 3.3, p("Tom Becker", "tom@beckerbuild.example"), "Kitchen remodel: revised quote", { att: 1 }),
  mk("1", 3.9, p("Tailspin Toys", "orders@tailspin.example"), "Your order has shipped", {}),
  mk("1", 4.2, p("Lakeside HOA", "board@lakesidehoa.example"), "Minutes from the annual meeting", { att: 1 }),
  mk("1", 5.0, p("Maya Chen", "maya.chen@example.com"), "Saturday hike", {}),
  mk("1", 5.4, p("Dr. Rao's Office", "frontdesk@raoclinic.example"), "Appointment reminder: Thursday 9:30", { star: true }),
  mk("1", 6.1, p("Wide World Importers", "receipts@wwi.example"), "Receipt for your purchase #4471-2210", {}),
  mk("1", 6.6, p("Jordan Kim", "jordan.kim@example.com"), "Re: Weather station readings look off", { att: 1 }),
  mk("1", 7.2, p("Adventure Works", "news@adventureworks.example"), "Fall gear guide: layers that work", {}),
  mk("1", 8.0, p("Sam Rivera", "sam.rivera@example.com"), "Re: Board game night", {}),
  mk("1", 9.5, p("Registry Office", "no-reply@registry.example.gov"), "Your vehicle registration expires soon", { star: true }),
  mk("1", 11.0, p("Jordan Kim", "jordan.kim@example.com"), "3D printer settings for PETG", { att: 2 }),
  mk("1", 12.3, p("Elena Novak", "elena.novak@example.com"), "Re: Volunteer schedule for the food bank", {}),
];
const PHOTO_MSG = mk("1", 13.0, p("Sam Rivera", "sam.rivera@example.com"), "Fwd: Photos from the coast trip", { att: 3, cc: [p("Dana Brooks", "dana.brooks@example.com"), ME] });
inbox.push(PHOTO_MSG,
  mk("1", 15.0, p("Contoso Bank", "alerts@contoso.example"), "New sign-in from a new device", {}),
  mk("1", 17.2, p("Leo Martins", "leo.martins@example.com"), "Bike repair", { att: 1 }),
  mk("1", 19.0, p("Harbor Photo Club", "club@harborphoto.example"), "Results of the autumn photo contest", { star: true }),
  mk("1", 22.0, p("Northwind Airlines", "no-reply@northwind.example"), "We have received your refund request", { star: true }),
  mk("1", 26.0, p("Priya Patel", "priya.patel@example.com"), "Recipe swap", {}),
  mk("1", 31.0, p("Fabrikam Utilities", "billing@fabrikam.example"), "Your bill for September is ready", {}),
  mk("1", 38.0, p("Elena Novak", "elena.novak@example.com"), "Volunteer schedule for the food bank", { att: 1 }),
  mk("1", 47.0, p("Tom Becker", "tom@beckerbuild.example"), "Kitchen remodel: first quote", { att: 2, star: true }),
  mk("1", 60.0, p("Maya Chen", "maya.chen@example.com"), "Trail map for next month", { att: 1 }),
  mk("1", 75.0, p("Sam Rivera", "sam.rivera@example.com"), "Coast trip planning", { star: true }),
  mk("1", 96.0, p("Jordan Kim", "jordan.kim@example.com"), "Robot arm servo test", { att: 1, star: true }),
);
PHOTO_MSG.attachments = ["IMG_1053.JPG", "IMG_1230.JPG", "IMG_1254.JPG"].map((filename, i) => ({
  partId: String(i + 2), filename, size: [812000, 4310000, 4120000][i], disposition: "attachment", type: "image", subtype: "jpeg",
  downloadUrl: `https://cloud-apis.mail.yahoo.com/dl/${i}`, thumbnailUrl: `https://cloud-apis.mail.yahoo.com/thumb/${i}?appid=x`,
}));
PHOTO_MSG.html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px">
<p>These turned out great, see the attached ones from Saturday.</p><br>
<div>---------- Forwarded message ---------<br>From: <b>Dana Brooks</b> &lt;<a href="mailto:dana.brooks@example.com">dana.brooks@example.com</a>&gt;<br>
Date: Sat, ${new Date((NOW - 13.3 * DAY) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} at 7:42 PM<br>Subject: Photos from the coast trip<br>
To: <a href="mailto:sam.rivera@example.com">sam.rivera@example.com</a></div><br>
<p>Hi all, I took about forty photos at the cove this morning. Here are three of my favourites; the rest are in the shared album.
The light at the point was perfect around eight. Thanks for organising the trip! Same time next year? - Dana</p></div>`;

// Projects/Website: a design thread for the dark screenshot
const ROBIN = p("Robin Hale", "robin.hale@example.com");
const website = [
  [0.2, ME, "Re: Website redesign: staging feedback", 0], [0.3, ROBIN, "Re: Website redesign: staging feedback", 1],
  [0.9, ROBIN, "Re: Website redesign: staging feedback", 1], [1.1, ME, "Re: Website redesign: staging feedback", 1],
  [1.4, ME, "Re: Website redesign: staging feedback", 1], [2.0, ROBIN, "Re: Website redesign: staging feedback", 0],
  [3.0, ROBIN, "Website redesign: staging feedback", 0], [4.5, p("Casey Wu", "casey.wu@example.com"), "Logo files, final versions", 2],
  [6.0, p("Casey Wu", "casey.wu@example.com"), "Re: Colour palette options", 1], [9.0, ROBIN, "Hosting renewal and DNS move", 0],
  [14.0, p("Casey Wu", "casey.wu@example.com"), "Colour palette options", 1], [21.0, ROBIN, "Kickoff notes", 1],
].map(([d, from, s, att]) => mk("22", d, from, s, { att }));
const DESIGN_MSG = website[2];
DESIGN_MSG.attachments = [{ partId: "2", filename: "staging-notes.pdf", size: 182000, disposition: "attachment", type: "application", subtype: "pdf", downloadUrl: "https://cloud-apis.mail.yahoo.com/dl/9" }];
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

const sent = [mk("2", 1.1, ME, "Re: Website redesign: staging feedback", { to: ROBIN }), mk("2", 2.2, ME, "Re: Saturday hike", { to: p("Maya Chen", "maya.chen@example.com") })];
const all = [...inbox, ...website, ...sent];
for (const m of all) if (!m.html) m.html = `<p>${m.headers.subject}</p>`;

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

// ---------- mocked backend ----------
function listFor(q) {
  if (q.includes("is:flagged")) return all.filter(m => m.flags.flagged && m.folder.id !== "2");
  const folder = (q.match(/folderId:(\d+)/) || [])[1] || "1";
  return all.filter(m => m.folder.id === folder);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ymail-shots-"));
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: { width: W, height: H },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const photos = await renderPhotos(ctx);

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
      result = { message: { ...msg, attachments: msg.attachments || [] }, simpleBody: { html: msg.html } };
    } else if (/"method":"(POST|DELETE)"/.test(post)) {
      const ids = [...post.matchAll(/"id":"((?:UnifiedUpdateMessage|UnifiedDeleteMessage)_\d+)"/g)].map(x => x[1]);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses: ids.map(id => ({ id, httpCode: 204 })) } }) });
    } else {
      const q = decodeURIComponent(uri.split("q=")[1] || "");
      const count = Number((q.match(/count:(\d+)/) || [])[1] || 100), offset = Number((q.match(/offset:(\d+)/) || [])[1] || 0);
      result = { messages: listFor(q).slice(offset, offset + count), query: {} };
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { responses: [{ id: top.id, httpCode: 200, response: { result } }] }, error: null }) });
  });
  await ctx.route("https://cloud-apis.mail.yahoo.com/**", route => {
    const i = Number((route.request().url().match(/\/(?:thumb|dl)\/(\d+)/) || [])[1] || 0);
    return route.fulfill({ contentType: "image/jpeg", body: photos[i % photos.length] });
  });
  await ctx.route("https://apis.mail.yahoo.com/**", route => {
    const b64 = buf => buf.toString("base64").replace(/.{76}/g, "$&\r\n");
    const raw = "From: sam.rivera@example.com\r\nSubject: Fwd: Photos from the coast trip\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nPhotos\r\n" +
      PHOTO_MSG.attachments.map((a, i) => `--B\r\nContent-Type: image/jpeg; name="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename}"\r\n\r\n${b64(photos[i])}\r\n`).join("") + "--B--\r\n";
    return route.fulfill({ contentType: "text/plain", body: raw });
  });

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/mail.html`);
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

  // 1. light, three columns, message with photo attachments
  await setup({ layout: "vertical", theme: "light", lightTheme: "light", folderW: 230, listW: 560, expanded: ["Projects"] });
  await openRow("Fwd: Photos from the coast trip");
  await page.waitForFunction(() => document.querySelectorAll("#r-attach .att-thumb img").length === 3);
  await page.mouse.move(W - 5, H - 5);
  await page.screenshot({ path: path.join(OUT, "light.png") });

  // 2. the attachment viewer over it
  await page.locator("#r-attach .att-card").nth(1).click();
  await page.waitForFunction(() => { const i = document.querySelector("#v-body img.v-img"); return i && i.complete && i.naturalWidth > 0; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "viewer.png") });
  await page.keyboard.press("Escape");

  // 3. dark, messages above the preview, a project thread
  await setup({ layout: "horizontal", theme: "dark", darkTheme: "dark", folderW: 230, listH: 36, expanded: ["Projects"] });
  await page.locator("#folder-list .folder", { hasText: "Website" }).click();
  await page.waitForFunction(() => document.getElementById("list-title").textContent === "Projects/Website");
  await openRow("Re: Website redesign: staging feedback");
  await page.locator("#rows .row").nth(2).click();
  await page.waitForTimeout(800);
  await page.mouse.move(W - 5, 60);
  await page.screenshot({ path: path.join(OUT, "dark.png") });

  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log("wrote", fs.readdirSync(OUT).join(", "));
})().catch(e => { console.error(e); process.exit(1); });
