// Golden values for cleaning tracking out of links in mail, ext/links.js. node tools/links-test.mjs
import { cleanLink } from "../ext/links.js";

let fail = 0;
const eq = (got, want, what) => { if (got !== want) { fail++; console.log("FAIL", what, "got", got, "want", want); } };
const b64url = s => Buffer.from(s).toString("base64url");

// tracking parameters
eq(cleanLink("https://example.com/a?utm_source=news&utm_medium=email&utm_campaign=x"), "https://example.com/a", "utm_ tags only: the ? goes too");
eq(cleanLink("https://example.com/a?id=7&UTM_Source=news&page=2"), "https://example.com/a?id=7&page=2", "any case; the other parameters keep their order");
eq(cleanLink("https://example.com/a?q=a%20b+c&fbclid=XYZ&x=%2F#top"), "https://example.com/a?q=a%20b+c&x=%2F#top", "kept values keep their encoding; the fragment stays");
eq(cleanLink("https://example.com/a?utm_source=x#frag?utm_medium=y"), "https://example.com/a#frag?utm_medium=y", "a fragment is not a query");
eq(cleanLink("https://example.com/?mc_cid=1&mc_eid=2&_hsenc=3&_hsmi=4&gclid=5&msclkid=6"), "https://example.com/", "Mailchimp, HubSpot and ad click ids");
eq(cleanLink("https://example.com/?utm%5Fsource=x&a=1"), "https://example.com/?a=1", "an encoded name is compared decoded");
eq(cleanLink("https://example.com/?pk_campaign=x&pk_id=7&mtm_source=y&hsa_cam=z"), "https://example.com/?pk_id=7", "Matomo and HubSpot ads; pk_id is not Matomo's");
eq(cleanLink("https://example.com/?a=1&utm_source=x&"), "https://example.com/?a=1&", "a trailing & stays as written");
eq(cleanLink("https://example.com/?utm_source"), "https://example.com/", "a name without a value");

// nothing to clean: the very same string
const asIs = [
  "https://example.com/a?b=1&c=2#d",
  "HTTPS://Example.COM/a?b=1",
  "https://example.com/unsubscribe?mkt_tok=abc&ref=nl",
  "https://www.facebook.com/sharer.php?u=https%3A%2F%2Fexample.com%2Fstory",
  "https://twitter.com/intent/tweet?url=https%3A%2F%2Fexample.com%2F&text=hi",
  "https://example.com/redirect?url=https%3A%2F%2Fexample.org%2F",
  "https://u123.ct.sendgrid.net/ls/click?upn=abc",
  "https://example.us1.list-manage.com/track/click?u=1&id=2&e=3",
  "mailto:someone@example.com?subject=hi&utm_source=x",
  "tel:+15551234567",
  "http://exa mple.com/?utm_source=x",
  "https://www.google.com/url?q=javascript:alert(1)",
  "https://www.google.com/search?q=https%3A%2F%2Fexample.com%2F",
];
for (const u of asIs) eq(cleanLink(u), u, "as is: " + u);

// redirectors with the destination inside
eq(cleanLink("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&sa=D&ust=1&usg=x"), "https://example.com/a?b=1", "Google /url?q=");
eq(cleanLink("https://www.google.co.uk/url?url=https://example.com/&sa=t"), "https://example.com/", "Google /url?url= on a country domain");
eq(cleanLink("https://www.youtube.com/redirect?event=video_description&q=https%3A%2F%2Fexample.com%2F"), "https://example.com/", "YouTube redirect");
eq(cleanLink("https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F%3Ffbclid%3Dabc&h=x"), "https://example.com/", "Facebook l.php, its fbclid dropped");
eq(cleanLink("https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2Fp&e=x"), "https://example.com/p", "Instagram");
eq(cleanLink("https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fx%3Futm_source%3Dnl%26id%3D3&data=05%7C01&reserved=0"), "https://example.com/x?id=3", "Outlook SafeLinks, with utm_ inside");
eq(cleanLink("https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.google.com%2Furl%3Fq%3Dhttps%253A%252F%252Fexample.com%252F&data=x"), "https://example.com/", "a redirector forwarding to another");
eq(cleanLink("https://nam12.safelinks.protection.outlook.com/?url=mailto%3Aa%40b.c&data=x"), "https://nam12.safelinks.protection.outlook.com/?url=mailto%3Aa%40b.c&data=x", "a redirector to anything but the web stays");

// Substack: /redirect/2/<base64url JSON>.<signature>
const sub = p => `https://substack.com/redirect/2/${b64url(JSON.stringify(p))}.sig-nature_1?j=abc`;
eq(cleanLink(sub({ e: "https://example.com/post?utm_source=substack&utm_medium=email", p: 1, s: 2 })), "https://example.com/post", "Substack");
eq(cleanLink(sub({ e: "https://example.com/café" })), "https://example.com/café", "Substack, UTF-8 in the payload");
for (const u of [sub({ e: "javascript:alert(1)" }), sub({ x: 1 }), "https://substack.com/redirect/2/not*base64.sig", "https://substack.com/redirect/abc-def?j=xyz"])
  eq(cleanLink(u), u, "Substack without a web destination: " + u);

console.log(fail ? `links: ${fail} FAILED` : "links: PASS");
if (fail) process.exit(1);
