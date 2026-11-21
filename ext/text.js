// Text from mail shown in the page. Bidirectional embedding, override and isolate controls are
// removed: in a name, subject or filename they only serve to make text read differently from what
// it is ("invoice<RLO>fdp.exe" shows as "invoiceexe.pdf").
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
export const noBidi = s => String(s ?? "").replace(BIDI_CONTROLS, "");
// attr() is for a data- attribute the page reads back and never shows: the value comes back
// exactly, bidi controls and all, where shown text (esc) has them stripped.
export const attr = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const esc = s => attr(noBidi(s));

// A count with its noun: "1 message", "1,200 messages", "3 matches".
export const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : (/(s|ch)$/.test(w) ? "es" : "s")}`;
