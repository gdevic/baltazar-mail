// Links in mail, cleaned of tracking. Newsletters tag their links with campaign and reader
// identifiers (utm_source, fbclid, mc_eid...) and pass them through redirectors that log the click
// before forwarding it (Google's /url?q=, Outlook SafeLinks). cleanLink takes the destination out of
// a known redirector and drops the known tags, without any request: a redirect whose destination is
// not in the link itself (Mailchimp, SendGrid and most other mailing services) stays as it is, since
// finding out where it goes would mean visiting it, which is the very click it records.

// Parameters that only identify a campaign, an ad click or a reader, compared without regard to
// case. Generic names a site may use for its own purposes (ref, source, id) are not here, and
// Matomo's pk_ names are listed one by one, since a site may start names of its own with pk_. Nor
// is mkt_tok: Marketo's unsubscribe pages need it to know who is leaving.
export const TRACKING_PREFIXES = ["utm_", "mtm_", "hsa_"];
export const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "twclid", "ttclid", "yclid", "igshid", "li_fat_id",
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "__hstc", "__hssc", "__hsfp", "_ga", "_gl", "oly_anon_id", "oly_enc_id",
  "rb_clickid", "vero_id", "vero_conv", "ref_src", "_openstat",
  "pk_campaign", "pk_kwd", "pk_keyword", "pk_source", "pk_medium", "pk_content", "pk_cid",
]);

// Redirectors that carry their destination in a query parameter. Only these are unwrapped: a
// parameter named url or u elsewhere is often the point of the link, as in a share button
// (facebook.com/sharer.php?u=, twitter.com/intent/tweet?url=).
export const WRAPPERS = [
  { host: /^(www\.)?google(\.[a-z]{2,3}){1,2}$/, path: /^\/url$/, params: ["q", "url"] },
  { host: /^(www\.|m\.)?youtube\.com$/, path: /^\/redirect$/, params: ["q"] },
  { host: /^lm?\.facebook\.com$/, path: /^\/l\.php$/, params: ["u"] },
  { host: /^l\.instagram\.com$/, path: /^\/$/, params: ["u"] },
  { host: /\.safelinks\.protection\.outlook\.com$/, path: /^\/$/, params: ["url"] },
];

const WEB = /^https?:\/\//i;
const isWeb = v => typeof v === "string" && WEB.test(v) && URL.canParse(v);

const isTracking = name => {
  let n = name;
  try { n = decodeURIComponent(name.replace(/\+/g, " ")); } catch { /* compared as written */ }
  n = n.toLowerCase();
  return TRACKING_PARAMS.has(n) || TRACKING_PREFIXES.some(p => n.startsWith(p));
};

// Substack's links are /redirect/2/<payload>.<signature>, the payload base64url-encoded JSON whose
// "e" holds the destination.
function substackTarget(path) {
  const m = path.match(/^\/redirect\/2\/([\w-]+)\./);
  if (!m) return null;
  try {
    const b = atob(m[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(m[1].length / 4) * 4, "="));
    const e = JSON.parse(new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))))?.e;
    return isWeb(e) ? e : null;
  } catch { return null; }
}

// The destination a known redirector forwards to, or null.
function unwrap(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  for (const w of WRAPPERS) {
    if (!w.host.test(u.hostname) || !w.path.test(u.pathname)) continue;
    for (const p of w.params) {
      const v = u.searchParams.get(p)?.trim();
      if (isWeb(v)) return v;
    }
    return null;
  }
  return u.hostname === "substack.com" ? substackTarget(u.pathname) : null;
}

// The query is filtered as written, pair by pair: the kept pairs, and everything around the query,
// stay byte for byte, since re-encoding a value (%20 to +) can change what a site reads.
function stripQuery(href) {
  const h = href.indexOf("#");
  const main = h < 0 ? href : href.slice(0, h), frag = h < 0 ? "" : href.slice(h);
  const q = main.indexOf("?");
  if (q < 0) return href;
  const pairs = main.slice(q + 1).split("&");
  const kept = pairs.filter(p => !isTracking(p.split("=", 1)[0]));
  if (kept.length === pairs.length) return href;
  const query = kept.join("&");
  return main.slice(0, q) + (/[^&]/.test(query) ? "?" + query : "") + frag;
}

// href: an absolute link as the message gives it. Anything but a web link, or a web link with
// nothing to clean, comes back as the same string.
export function cleanLink(href) {
  if (!isWeb(href)) return href;
  let url = href;
  for (let i = 0; i < 3; i++) {       // a redirector may forward to another
    const inner = unwrap(url);
    if (!inner) break;
    url = inner;
  }
  return stripQuery(url);
}
