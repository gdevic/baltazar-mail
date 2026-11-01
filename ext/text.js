// Text from mail shown in the page. Bidirectional embedding, override and isolate controls are
// removed: in a name, subject or filename they only serve to make text read differently from what
// it is ("invoice<RLO>fdp.exe" shows as "invoiceexe.pdf").
export const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
export const noBidi = s => String(s ?? "").replace(BIDI_CONTROLS, "");
export const esc = s => noBidi(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
