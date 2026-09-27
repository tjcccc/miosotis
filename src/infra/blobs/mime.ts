import { extname } from "node:path";

/**
 * Small, synchronous content sniffing for the formats miosotis handles. The magic bytes decide for
 * binary formats; text formats (which have no signature) fall back to the file extension.
 */
const SIGNATURES: { mime: string; test: (head: Uint8Array) => boolean }[] = [
  { mime: "image/png", test: (h) => starts(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: "image/jpeg", test: (h) => starts(h, [0xff, 0xd8, 0xff]) },
  { mime: "image/gif", test: (h) => ascii(h, 0, "GIF87a") || ascii(h, 0, "GIF89a") },
  { mime: "image/webp", test: (h) => ascii(h, 0, "RIFF") && ascii(h, 8, "WEBP") },
  { mime: "image/bmp", test: (h) => ascii(h, 0, "BM") },
  { mime: "image/tiff", test: (h) => starts(h, [0x49, 0x49, 0x2a, 0x00]) || starts(h, [0x4d, 0x4d, 0x00, 0x2a]) },
  {
    mime: "image/heic",
    test: (h) => ascii(h, 4, "ftyp") && ["heic", "heix", "mif1", "msf1"].some((brand) => ascii(h, 8, brand)),
  },
  { mime: "application/pdf", test: (h) => ascii(h, 0, "%PDF-") },
  { mime: "application/zip", test: (h) => starts(h, [0x50, 0x4b, 0x03, 0x04]) },
];

const ZIP_BASED: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const TEXT_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".text": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
};

export const OCTET_STREAM = "application/octet-stream";

export function sniffMime(head: Uint8Array, filename: string | undefined): string {
  const extension = extname(filename ?? "").toLowerCase();
  const signature = SIGNATURES.find((candidate) => candidate.test(head));
  if (signature !== undefined) {
    return signature.mime === "application/zip" ? (ZIP_BASED[extension] ?? signature.mime) : signature.mime;
  }
  return TEXT_BY_EXTENSION[extension] ?? OCTET_STREAM;
}

export function isImage(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

export function isPlainText(mime: string): boolean {
  return mime === "text/plain" || mime === "text/markdown" || mime === "application/json";
}

export function extensionFor(mime: string): string {
  const known: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/heic": ".heic",
    "application/pdf": ".pdf",
  };
  return known[mime] ?? ".bin";
}

function starts(head: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => head[index] === byte);
}

function ascii(head: Uint8Array, offset: number, text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (head[offset + index] !== text.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}
