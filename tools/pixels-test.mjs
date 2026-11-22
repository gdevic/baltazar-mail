// Golden values for telling tracking pictures in mail, ext/pixels.js, also behind Yahoo's image
// proxy (imageOrigin in yahoo/api.js). node tools/pixels-test.mjs
import { createRequire } from "node:module";
import { isTracker } from "../ext/pixels.js";
// The Yahoo adapter imports the shared modules beside it, so it is tested as built.
createRequire(import.meta.url)("./build.js").build("yahoo");
const { imageOrigin } = await import("../dist/baltazar-mail-yahoo/api.js");

let fail = 0;
const eq = (got, want, what) => { if (got !== want) { fail++; console.log("FAIL", what, "got", got, "want", want); } };
const T = "https://track.example/o.gif?r=7";

// trackers by size: at most one pixel each way, from the attributes or the inline style
eq(isTracker({ src: T, width: "1", height: "1" }), true, "1 by 1 attributes");
eq(isTracker({ src: T, width: "0", height: "0" }), true, "0 by 0 attributes");
eq(isTracker({ src: T, width: " 1px", height: "1 " }), true, "attributes read as the browser reads them");
eq(isTracker({ src: "http://track.example/o.gif", width: "1", height: "1" }), true, "plain http is remote too");
eq(isTracker({ src: T, style: { width: "1px", height: "1px" } }), true, "1 by 1 in the style alone");
eq(isTracker({ src: T, style: { width: "0px", height: "0em" } }), true, "zero in any unit");
eq(isTracker({ src: T, width: "1", style: { width: "", height: "0px" } }), true, "one size from each");
eq(isTracker({ src: T, width: "600", height: "300", style: { width: "1px", height: "1px" } }), true, "the style wins over the attributes");
eq(isTracker({ src: ` ${T} `, width: "1", height: "1" }), true, "the address as written, spaces around it");

// trackers by address, whatever their size
eq(isTracker({ src: "https://u123.ct.sendgrid.net/wf/open?upn=abc" }), true, "SendGrid's open picture, no size");
eq(isTracker({ src: "https://email.news.example/wf/open?upn=abc", width: "20", height: "20" }), true, "SendGrid on a branded host, any size");

// never trackers
const never = [
  [{ src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", width: "1", height: "1" }, "a data: picture"],
  [{ src: "cid:pixel@x", width: "1", height: "1" }, "a part of the message"],
  [{ src: "o.gif", width: "1", height: "1" }, "a relative address"],
  [{ src: "", width: "1", height: "1" }, "no address"],
  [{ width: "1", height: "1" }, "no src at all"],
  [{ src: T, width: "640", height: "1" }, "a spacer, wide and 1 tall"],
  [{ src: T, width: "1", height: "40" }, "a spacer, tall and 1 wide"],
  [{ src: T, style: { width: "100%", height: "1px" } }, "a spacer sized by its style"],
  [{ src: T, width: "1" }, "a width alone"],
  [{ src: T, height: "1" }, "a height alone"],
  [{ src: T }, "no size at all"],
  [{ src: T, width: "1%", height: "1%" }, "percentages"],
  [{ src: T, width: "2", height: "2" }, "two pixels"],
  [{ src: T, width: "1", height: "1", style: { width: "300px", height: "100px" } }, "1 by 1 attributes the style makes larger"],
  [{ src: T, width: "1", height: "1", style: { width: "auto", height: "auto" } }, "1 by 1 attributes the style sizes otherwise"],
  [{ src: T, width: "600", height: "300", style: { display: "none", width: "", height: "" } }, "a real picture hidden by display"],
  [{ src: T, height: "200", style: { display: "none", maxHeight: "0px", width: "0px", height: "" } }, "a real picture hidden the responsive way"],
  [{ src: T, width: "600", height: "300", style: { visibility: "hidden", width: "", height: "" } }, "a real picture hidden by visibility"],
  [{ src: "https://u123.ct.sendgrid.net/wf/opened" }, "a path that only starts like /wf/open"],
  [{ src: "https://news.example/x/wf/open" }, "/wf/open further down a path"],
  [{ src: "https://news.example/p.gif?next=/wf/open" }, "/wf/open in the query"],
];
for (const [pic, what] of never) eq(isTracker(pic), false, "never: " + what);

// Yahoo's proxy: the sender's address is in its url parameter
const proxied = u => `https://ecp.yusercontent.com/mail?url=${encodeURIComponent(u)}&t=1700000000&sig=abc`;
eq(imageOrigin(proxied("https://u1.ct.sendgrid.net/wf/open?upn=abc")), "https://u1.ct.sendgrid.net/wf/open?upn=abc", "the proxy gives the sender's address");
eq(isTracker({ src: imageOrigin(proxied("https://u1.ct.sendgrid.net/wf/open?upn=abc")) }), true, "SendGrid behind the proxy");
eq(isTracker({ src: imageOrigin(proxied(T)), width: "1", height: "1" }), true, "1 by 1 behind the proxy");
eq(isTracker({ src: imageOrigin(proxied("https://news.example/hero.png")), width: "600", height: "300" }), false, "a real picture behind the proxy");
eq(imageOrigin("https://ECP.yusercontent.com/mail?url=https%3A%2F%2Fnews.example%2Fa.png"), "https://news.example/a.png", "the host in any case");
const own = [
  "https://ecp.yusercontent.com/mail?t=1&sig=abc",
  "https://ecp.yusercontent.com/mail?url=javascript%3Aalert(1)",
  "https://ecp.yusercontent.com/other?url=https%3A%2F%2Fnews.example%2Fa.png",
  "http://ecp.yusercontent.com/mail?url=https%3A%2F%2Fnews.example%2Fa.png",
  "https://yusercontent.com.evil.example/mail?url=https%3A%2F%2Fnews.example%2Fa.png",
  "https://news.example/mail?url=https%3A%2F%2Fu1.ct.sendgrid.net%2Fwf%2Fopen",
  "https://cloud-apis.mail.yahoo.com/ws/v3/mailboxes/@.id==MB1/messages/@.id==M1/content/parts/@.id==2/thumbnail&appid=x",
  "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
  "cid:pixel@x",
  "",
];
for (const u of own) eq(imageOrigin(u), u, "its own address: " + u);
eq(imageOrigin(undefined), undefined, "no address");

console.log(fail ? `pixels: ${fail} FAILED` : "pixels: PASS");
if (fail) process.exit(1);
