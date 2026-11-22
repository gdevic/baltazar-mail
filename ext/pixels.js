// Tracking pictures in mail. Newsletters carry a picture nobody sees, a pixel or none, whose address
// names the reader, so that loading it tells the sender that the message was opened, and when.
// isTracker tells such a picture by what the message says of it, without any request: a remote
// picture at most one pixel wide and one pixel tall, or one at a mailing service's known
// open-tracking address. The client takes it out of the message as it cleans it, so it never
// loads; it was invisible, so nothing looks different without it.
//
// Never a tracker: a picture inside the message (data:, and the message's own parts, which the
// client asks the adapter about: api.isInlineRef), a spacer (wide and one pixel tall, or tall and
// one pixel wide), and a picture its style merely hides: responsive mail hides real pictures with
// display, visibility or max-height, and shows them on a narrow screen.

// Paths at which a mailing service serves its open-tracking picture, each seen in real mail:
// SendGrid's /wf/open, on its own hosts and on the senders' branded ones. Such a picture may be
// given any size, so its address alone decides.
const OPEN_PATHS = new Set(["/wf/open"]);

// A width or height attribute in pixels, read as the browser reads one (leading digits and a
// fraction, anything after them ignored); null when it gives none, or gives a percentage.
function attrPx(v) {
  const m = /^[\t\n\f\r ]*(\d+(?:\.\d+)?)(%?)/.exec(String(v ?? ""));
  return m && !m[2] ? Number(m[1]) : null;
}

// A width or height an inline style sets, as the browser's parser gives it ("1px", "0px", "auto",
// "50%"): pixels, 0 for zero in any unit, Infinity for any other size, null when it sets none.
function stylePx(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  const px = /^(\d*\.?\d+)px$/.exec(s);
  if (px) return Number(px[1]);
  return /^0*\.?0+([a-z]+|%)?$/.test(s) ? 0 : Infinity;
}

// src: the picture's address as its sender wrote it (api.imageOrigin); width and height: its
// attributes; style: its inline style as the browser parsed it (an element's style, or anything
// with width and height). Where both give a size, the style's is the one shown, so it wins.
export function isTracker({ src, width = null, height = null, style = null } = {}) {
  let url;
  try { url = new URL(String(src ?? "").trim()); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const w = stylePx(style?.width) ?? attrPx(width), h = stylePx(style?.height) ?? attrPx(height);
  if (w !== null && h !== null && w <= 1 && h <= 1) return true;
  return OPEN_PATHS.has(url.pathname);
}
