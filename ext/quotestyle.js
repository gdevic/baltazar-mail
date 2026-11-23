// The formatting of a quoted message, moved from its style sheets into its elements.
// A sender's style sheets cannot go into a reply or forward: there they would apply to the whole
// outgoing message, the user's own text included, and in the editor to the app's own page. Mail
// laid out by its sheets alone would then be quoted bare, so inlineStyles writes what the sheets
// give each element into its style attribute, as the browser's cascade would, and drops the
// sheets. The classes and ids the rules went by are then of no use to the quote.
//
// A rule is taken when it holds on every screen. One under a media query that asks for more than
// "screen" (a width, a colour scheme, print) is for some screens only and stays out, so the quote
// has the layout the message has where no such query matches.
//
// A reset such as * { margin: 0 } lands on every element and would make the quote several times
// the size of the message, past what Gmail shows of one without clipping it. So a declaration that
// changes nothing is left out again (prune): the browser is asked, in a hidden frame, whether the
// element's computed value is the same without it.

// (element, rule) pairs looked at before a message is quoted without its sheets, and the time
// pruning may take before the declarations still unchecked stay as they are.
const HITS_MAX = 200000, PRUNE_MS = 1500;

// The index of the bracket that closes the one at i, strings and escapes stepped over.
function closing(s, i) {
  for (let depth = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'") { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === "\\") i++; }
    else if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && !--depth) return i;
  }
  return s.length;
}

// The selectors of a list: split at its commas, but not at those in brackets.
export function selectorList(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "(" || c === "[") i = closing(text, i);
    else if (c === ",") { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map(s => s.trim()).filter(Boolean);
}

// A selector's specificity as one number: its ids, then its classes (attributes and pseudo-classes
// count as classes), then its element names. :is(), :not() and :has() weigh what their most
// specific argument does and :where() nothing.
const OLD_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);
const WEIGHS_ARGUMENT = new Set(["is", "not", "has", "matches", "-webkit-any"]);
export function specificity(selector) {
  const s = selector, n = s.length;
  // just past the name that begins at i
  const name = i => { while (i < n && (s[i] === "\\" || /[-\w]/.test(s[i]) || s.charCodeAt(i) > 127)) i += s[i] === "\\" ? 2 : 1; return i; };
  let ids = 0, classes = 0, types = 0, inner = 0;
  for (let i = 0; i < n;) {
    const c = s[i];
    if (c === "#") { ids++; i = name(i + 1); }
    else if (c === ".") { classes++; i = name(i + 1); }
    else if (c === "[") { classes++; i = closing(s, i) + 1; }
    else if (c === ":") {
      const element = s[i + 1] === ":", from = i + (element ? 2 : 1), end = name(from), word = s.slice(from, end).toLowerCase();
      const close = s[end] === "(" ? closing(s, end) : -1;
      i = close < 0 ? end : close + 1;
      if (element || OLD_PSEUDO_ELEMENTS.has(word)) types++;
      else if (close >= 0 && WEIGHS_ARGUMENT.has(word)) inner += Math.max(0, ...selectorList(s.slice(end + 1, close)).map(specificity));
      else if (word !== "where") classes++;
    }
    else if (c === "\\" || /[a-z_]/i.test(c) || c.charCodeAt(0) > 127) { const end = name(i); if (s[end] !== "|") types++; i = end; }
    else i++;      // *, a combinator, white space, the | after a namespace
  }
  return (Math.min(ids, 999) * 1e6) + (Math.min(classes, 999) * 1e3) + Math.min(types, 999) + inner;
}

// ---------- the cascade ----------
// Whether a media query list holds on every screen: nothing, "all" or "screen" in each query.
const everyScreen = media => media.split(",").every(q => /^\s*(?:(?:only\s+)?(?:all|screen))?\s*$/i.test(q));

// The style rules of the document's sheets that apply, in the order they are written.
function rulesOf(doc) {
  const rules = [];
  const take = list => {
    for (const r of list) {
      if (r instanceof CSSStyleRule) rules.push(r);
      else if (r instanceof CSSMediaRule ? everyScreen(r.media.mediaText) : r instanceof CSSSupportsRule && CSS.supports(r.conditionText)) take(r.cssRules);
    }
  };
  for (const el of doc.querySelectorAll("style")) {
    if (!everyScreen(el.getAttribute("media") || "")) continue;
    const sheet = new CSSStyleSheet();
    try { sheet.replaceSync(el.textContent); } catch { continue; }
    take(sheet.cssRules);
  }
  return rules;
}

// Each element of the body, and the body, gets the declarations the rules give it, with those of
// its own style attribute, as one style attribute: the more specific selector wins, then the later
// rule, the element's own style over both, and !important over that. What wins is written without
// its !important, as nothing is left for it to win over. Throws when the message has more matches
// than HITS_MAX, with no element changed.
function cascade(doc, rules) {
  const body = doc.body, found = new Map();      // element -> [{ spec, order, style }]
  let hits = 0;
  rules.forEach((rule, order) => {
    if (!rule.style.length) return;
    const best = new Map();                       // element -> the specificity it matches the rule with
    for (const sel of selectorList(rule.selectorText)) {
      let els;
      try { els = [...body.querySelectorAll(sel)]; if (body.matches(sel)) els.push(body); } catch { continue; }
      if (!els.length) continue;
      const spec = specificity(sel);
      for (const el of els) if (!(best.get(el) >= spec)) best.set(el, spec);
    }
    if ((hits += best.size) > HITS_MAX) throw new Error("too many style rules to inline");
    for (const [el, spec] of best) {
      const entry = { spec, order, style: rule.style }, list = found.get(el);
      if (list) list.push(entry); else found.set(el, [entry]);
    }
  });
  const out = doc.createElement("span").style;
  // A longhand of a shorthand written with var() has no value of its own to copy.
  const put = (from, important) => { for (const p of from) { const v = from.getPropertyValue(p); if (v && (from.getPropertyPriority(p) === "important") === important) out.setProperty(p, v); } };
  for (const [el, list] of found) {
    if (!el.style) continue;
    list.sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
    out.cssText = "";
    for (const important of [false, true]) { for (const e of list) put(e.style, important); put(el.style, important); }
    el.setAttribute("style", out.cssText);
  }
}

// ---------- pruning ----------
// Properties an element takes from its parent when nothing sets them. Such a declaration can be
// left out only under an ancestor in the quote that keeps one for the same property: the value
// without it then comes from the quote. With no such ancestor it would come from wherever the
// quote is shown, the editor's font or a mail reader's, which the frame cannot tell.
const INHERITED = /^(?:color$|font|line-height|letter-spacing|word-|overflow-wrap|text-(?!decoration-(?:line|color|style|thickness)|overflow)|white-space|line-break|hyphen|tab-size|direction|writing-mode|visibility|cursor|pointer-events|list-style|border-collapse|border-spacing|-webkit-border-(?:horizontal|vertical)-spacing|caption-side|empty-cells|quotes|orphans|widows|caret-color|accent-color|color-scheme|fill|stroke|-webkit-text|-webkit-font|--)/;
// A value or attribute that may name an address. Nothing in the frame may ask for one: the quote's
// pictures load only in the editor, under the reader's rule for images.
const LOADS = /url\(|image-set\(|\\/i;
const ADDRESS_ATTRS = ["src", "srcset", "poster", "background", "href", "xlink:href"];

// The frame the browser computes styles in: a standards-mode page as the editor is, that runs and
// loads nothing, with one box that is not displayed, so that a size is given as written (auto, a
// percentage) and not as laid out.
async function measuringFrame() {
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-same-origin");
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  f.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:0;border:0;visibility:hidden";
  const loaded = new Promise((done, failed) => { f.onload = done; setTimeout(() => failed(new Error("no frame")), 5000); });
  f.srcdoc = `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><body><div style="display:none"></div>`;
  document.body.appendChild(f);
  try { await loaded; } catch (e) { f.remove(); throw e; }
  return f;
}

// Takes out of the body's and its elements' style attributes every declaration without which the
// element computes the same. A copy of the body, as a div, is measured: it has no address to load,
// and where that takes away what styles an element (a background attribute, a url() in an SVG
// attribute) the element keeps its style as it is. A declaration that names an address is not in
// the copy either and is kept, as is every other declaration of its property, whose computed
// values the copy cannot give.
async function prune(doc) {
  const body = doc.body, copy = doc.createElement("div");
  if (body.hasAttribute("style")) copy.setAttribute("style", body.getAttribute("style"));
  for (const n of body.childNodes) copy.appendChild(n.cloneNode(true));
  const originals = [body, ...body.querySelectorAll("*")], copies = [copy, ...copy.querySelectorAll("*")];
  const asWritten = new Set(), named = new Map(), unmeasured = new Set();     // named: copy -> [[property, value]]
  for (const el of copies) {
    for (const a of [...el.attributes]) {
      if (a.name === "style") continue;
      const address = ADDRESS_ATTRS.includes(a.name) && !(a.name.endsWith("href") && (el.localName === "a" || el.localName === "area"));
      if (!address && !LOADS.test(a.value)) continue;
      el.removeAttribute(a.name);
      if (a.name !== "src" && a.name !== "srcset" && a.name !== "poster") asWritten.add(el);
    }
    if (!el.style || !LOADS.test(el.getAttribute("style") || "")) continue;
    const list = [];
    for (const p of [...el.style]) { const v = el.style.getPropertyValue(p); if (LOADS.test(v)) { list.push([p, v]); unmeasured.add(p); } }
    for (const [p] of list) el.style.removeProperty(p);
    named.set(el, list);
  }
  const frame = await measuringFrame();
  try {
    const view = frame.contentWindow, t0 = performance.now();
    frame.contentDocument.body.firstElementChild.appendChild(frame.contentDocument.adoptNode(copy));
    // each element with the inherited properties an ancestor keeps a declaration of
    const todo = [[copy, new Set()]];
    while (todo.length && performance.now() - t0 < PRUNE_MS) {
      const [el, above] = todo.pop(), st = el.style;
      let kept = above;
      if (st?.length) {
        const computed = view.getComputedStyle(el), keep = p => { if (INHERITED.test(p) && !kept.has(p)) { if (kept === above) kept = new Set(above); kept.add(p); } };
        for (const p of [...st]) {
          if (asWritten.has(el) || unmeasured.has(p) || (INHERITED.test(p) && !above.has(p))) { keep(p); continue; }
          const v = st.getPropertyValue(p), was = computed.getPropertyValue(p);
          st.removeProperty(p);
          if (computed.getPropertyValue(p) !== was) { st.setProperty(p, v); keep(p); }
        }
      }
      for (const c of el.children) todo.push([c, kept]);
    }
  } finally { frame.remove(); }
  originals.forEach((el, i) => {
    const c = copies[i];
    if (!el.style) return;
    el.setAttribute("style", c.getAttribute("style") || "");
    for (const [p, v] of named.get(c) || []) el.style.setProperty(p, v);
    if (!el.getAttribute("style")) el.removeAttribute("style");
  });
}

// html: a message's cleaned HTML. Gives it without its style sheets, each element styled by its
// own attribute as the sheets styled it. What the sheets give the body goes to a div around the
// message, less the heights, which are the page's and not the message's. A message whose sheets
// cannot be worked out is given without them, unstyled.
export async function inlineStyles(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  if (!tpl.content.querySelector("style")) {
    tpl.content.querySelectorAll("link").forEach(e => e.remove());
    return tpl.innerHTML;
  }
  // a whole document, so that selectors naming html or body match as they do in the reader
  const doc = new DOMParser().parseFromString(html, "text/html");
  let styled = false;
  try { cascade(doc, rulesOf(doc)); styled = true; } catch { /* quoted without its sheets */ }
  doc.querySelectorAll("style, link").forEach(e => e.remove());
  if (styled) {
    for (const p of ["height", "min-height"]) doc.body.style.removeProperty(p);
    try { await prune(doc); } catch { /* every declaration stays */ }
  }
  const own = doc.body.getAttribute("style");
  if (!own) return doc.body.innerHTML;
  const box = doc.createElement("div");
  box.setAttribute("style", own);
  box.append(...doc.body.childNodes);
  return box.outerHTML;
}
