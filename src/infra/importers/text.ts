/** Plain-text and Markdown importer. Decoding is strict so mojibake never becomes "evidence". */
export const TEXT_PIPELINE = "text.v1";

export type TextImport = { ok: true; text: string; bom: boolean } | { ok: false; reason: string };

export function importText(bytes: Uint8Array): TextImport {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    if (text.includes("\u0000")) {
      return { ok: false, reason: "contains NUL bytes; not a text file" };
    }
    return { ok: true, text, bom };
  } catch {
    return { ok: false, reason: "not valid UTF-8 (other encodings are not supported yet)" };
  }
}
