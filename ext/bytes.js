// Whether a file's bytes are text, by the checks file(1) and git use: a NUL byte or more than 1%
// control characters means binary. Text decodes as UTF-8, or as Windows-1252 when it is not valid
// UTF-8; UTF-16 is recognised by its byte-order mark. Returns the text, or null for binary.
export function asText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  let ctrl = 0;
  for (const b of bytes) {
    if (b === 0) return null;
    if ((b < 0x20 && b !== 9 && b !== 10 && b !== 12 && b !== 13 && b !== 27) || b === 0x7f) ctrl++;
  }
  if (ctrl * 100 > bytes.length) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}

// Classic hex dump: offset, 16 bytes in hex split in two groups of 8, then printable ASCII.
export function hexDump(bytes) {
  const lines = [];
  for (let o = 0; o < bytes.length; o += 16) {
    const row = [...bytes.subarray(o, o + 16)], hex = row.map(x => x.toString(16).padStart(2, "0"));
    lines.push(`${o.toString(16).padStart(8, "0")}  ${(hex.slice(0, 8).join(" ") + "  " + hex.slice(8).join(" ")).padEnd(48)}  ${row.map(x => x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".").join("")}`);
  }
  return lines.join("\n");
}

// The image format of bytes, from their signature, or null when they are not an image of a kind
// mail clients show inline.
const IMAGE_MAGIC = [["image/png", "89504e47"], ["image/jpeg", "ffd8ff"], ["image/gif", "47494638"], ["image/bmp", "424d"]];
export function sniffImage(b) {
  const hex = [...b.slice(0, 12)].map(x => x.toString(16).padStart(2, "0")).join("");
  if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") return "image/webp";
  return IMAGE_MAGIC.find(([, sig]) => hex.startsWith(sig))?.[0] || null;
}
