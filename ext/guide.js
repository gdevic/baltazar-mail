// Draws a setup guide that the provider gives as data (api.setup; gmail/setup.js describes the
// shape): numbered steps, the current one open, each with what to do, a value to copy, a page to
// open and, for one step, a box to paste into; and a list of what to do about each way a sign-in
// can fail. It names no host: every address comes from the provider. Text is drawn with
// textContent only; **bold** and `code` are the only markup it reads.

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null && k !== false));
  return n;
};

// A line of the guide's text as nodes: **label** in bold, `value` as code.
export function rich(text) {
  const out = document.createDocumentFragment();
  for (const part of String(text || "").split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (/^\*\*.+\*\*$/.test(part)) out.append(el("b", { textContent: part.slice(2, -2) }));
    else if (/^`.+`$/.test(part)) out.append(el("code", { textContent: part.slice(1, -1) }));
    else out.append(part);
  }
  return out;
}

// Copies a value and says so on the button; where the clipboard refuses, the value is selected for
// the keyboard's copy instead.
export async function copyText(value, button, shown) {
  const label = button.dataset.label ||= button.textContent;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
  } catch {
    if (shown) { const r = document.createRange(); r.selectNodeContents(shown); getSelection().removeAllRanges(); getSelection().addRange(r); }
    button.textContent = /Mac/.test(navigator.platform) ? "Press ⌘C" : "Press Ctrl+C";
  }
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => { button.textContent = label; }, 1800);
}

// A value with its label and a Copy button.
export function copyRow({ label, value }) {
  const code = el("code", { className: "g-copy-value", textContent: value });
  const button = el("button", { type: "button", className: "g-copy-btn", textContent: "Copy" });
  button.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
  button.onclick = () => copyText(value, button, code);
  return el("div", { className: "g-copy" }, el("span", { className: "g-copy-label", textContent: label }), code, button);
}

// A page of the provider's, in a tab of its own beside this one. Only an https address is linked.
export function pageLink({ label, href }) {
  const a = el("a", { className: "g-open", textContent: label, target: "_blank", rel: "noopener" });
  if (/^https:\/\//.test(href)) a.href = href;
  return a;
}

const lines = (list, tag = "ol") => el(tag, { className: "g-lines" }, ...list.map(t => el("li", {}, rich(t))));
const linkButton = (label, onclick) => el("button", { type: "button", className: "link", textContent: label, onclick });

// The verdict on what is in the paste box, under it.
function verdict(msg, r) {
  msg.className = "g-msg" + (r.error ? " bad" : r.warn ? " warn" : r.id ? " good" : "");
  msg.replaceChildren(rich(r.error || r.warn || (r.id ? "That is a Client ID." : "")));
}

function pasteBox(p, view, on) {
  const input = el("input", { id: "g-paste-in", type: "text", spellcheck: false, autocomplete: "off", placeholder: p.placeholder, value: view.clientId || "" });
  input.setAttribute("aria-label", p.label);
  const ok = el("button", { id: "g-paste-ok", type: "button", className: "g-primary", textContent: p.button });
  const msg = el("p", { id: "g-paste-msg", className: "g-msg" });
  msg.setAttribute("aria-live", "polite");
  const judge = () => { const r = on.check(input.value); ok.disabled = !r.id; verdict(msg, r); return r; };
  const submit = async () => {
    if (!judge().id) { input.focus(); return; }
    ok.disabled = true;
    const r = await on.paste(input.value);
    if (!r?.id) { ok.disabled = false; verdict(msg, r || {}); }
  };
  input.oninput = judge;
  input.onkeydown = e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } };
  ok.onclick = submit;
  judge();
  return el("div", { className: "g-paste" }, el("div", { className: "g-paste-row" }, input, ok), msg);
}

function stepBody(s, view, on, next) {
  const body = el("div", { className: "g-body" });
  if (s.lead) body.append(el("p", { className: "g-lead" }, rich(s.lead)));
  if (s.copy) body.append(copyRow(s.copy));
  if (s.open) body.append(el("p", {}, pageLink(s.open)));
  // a single instruction is a sentence, not a list of one
  if (s.lines?.length === 1 && !s.signIn) body.append(el("p", {}, rich(s.lines[0])));
  else if (s.lines?.length) body.append(lines(s.lines, s.signIn ? "ul" : "ol"));
  if (s.paste) body.append(pasteBox(s.paste, view, on));
  if (s.signIn) body.append(el("div", { className: "g-slot" }));      // the page's own sign-in button goes here
  if (s.next && next) body.append(el("p", {}, el("button", { type: "button", className: "g-next", textContent: s.next, onclick: () => on.step(next.id) })));
  return body;
}

// The guide of view ({ route, step, steps, other, jump, clientId }) in box. on: { step(id),
// route(route), check(text) -> { id?, error?, warn? }, paste(text) -> Promise of the same }.
// Each step's header opens it; the open step's header can be given the focus with focusStep.
export function drawGuide(box, view, on) {
  const at = Math.max(0, view.steps.findIndex(s => s.id === view.step));
  const list = el("ol", { className: "g-steps" });
  view.steps.forEach((s, i) => {
    const state = i === at ? "now" : i < at ? "done" : "todo";
    const head = el("button", { type: "button", className: "g-head" },
      el("span", { className: "g-num", textContent: state === "done" ? "✓" : String(i + 1) }),
      el("span", { className: "g-title", textContent: s.title }));
    head.setAttribute("aria-expanded", String(state === "now"));
    if (state === "now") head.setAttribute("aria-current", "step");
    if (state === "done") head.setAttribute("aria-label", `${s.title} (done)`);
    head.onclick = () => { if (state !== "now") on.step(s.id); };
    const li = el("li", { className: `g-step ${state}` }, head);
    li.dataset.step = s.id;
    if (state === "now") li.append(stepBody(s, view, on, view.steps[i + 1]));
    list.append(li);
  });
  const ways = el("p", { className: "g-ways" });
  const jumpAt = view.jump ? view.steps.findIndex(s => s.id === view.jump.step) : -1;
  if (jumpAt > at) ways.append(linkButton(view.jump.label, () => on.step(view.jump.step)));
  if (view.other) ways.append(linkButton(view.other.label, () => on.route(view.other.route)));
  box.replaceChildren(list, ways);
}
export const focusStep = box => box.querySelector(".g-step.now .g-head")?.focus();

// What Google's window may have said (entries: [{ id, says, fix, copy?, open? }]), each opening
// to what to do about it; pick: the entry to show open.
export function drawHelp(box, entries, { pick = "", title = "What did Google's window say?" } = {}) {
  const items = entries.map(h => {
    const d = el("details", { className: "g-help-item", open: h.id === pick });
    d.dataset.help = h.id;
    d.append(el("summary", { textContent: h.says }),
      el("div", { className: "g-body" }, lines(h.fix, "ul"), h.copy && copyRow(h.copy), h.open && el("p", {}, pageLink(h.open))));
    return d;
  });
  box.replaceChildren(el("p", { className: "g-help-title", textContent: title }), ...items);
}
