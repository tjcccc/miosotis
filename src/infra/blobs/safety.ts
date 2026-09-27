import { extname } from "node:path";

/** Office formats that can carry macros are never stored as artifact outputs. */
const MACRO_EXTENSIONS = new Set([
  ".docm",
  ".dotm",
  ".xlsm",
  ".xltm",
  ".xlsb",
  ".xlam",
  ".pptm",
  ".potm",
  ".ppsm",
  ".sldm",
]);

/** Executables and scripts are not artifact outputs. */
const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".app",
  ".dmg",
  ".pkg",
  ".msi",
  ".bat",
  ".cmd",
  ".com",
  ".ps1",
  ".sh",
  ".command",
  ".scpt",
  ".jar",
  ".js",
  ".mjs",
  ".vbs",
]);

export interface FileVerdict {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(text, "latin1"));
}

/**
 * Checks a host-built output before it is stored with an artifact. Nothing is ever executed; this only
 * keeps obviously active content (macros, scripts, executables) out of the library.
 */
export function checkArtifactFile(filename: string, mime: string, bytes: Uint8Array): FileVerdict {
  const problems: string[] = [];
  const warnings: string[] = [];
  const extension = extname(filename).toLowerCase();
  if (MACRO_EXTENSIONS.has(extension)) {
    problems.push(`${filename}: macro-enabled Office files are not accepted; save it as .docx/.xlsx/.pptx`);
  }
  if (BLOCKED_EXTENSIONS.has(extension)) {
    problems.push(`${filename}: executables and scripts are not accepted as artifact files`);
  }
  if (mime === "application/zip" || mime.startsWith("application/vnd.openxmlformats-officedocument")) {
    // The zip central directory stores entry names in plain text.
    if (containsAscii(bytes, "vbaProject.bin")) {
      problems.push(`${filename}: contains a VBA macro project (vbaProject.bin)`);
    }
    if (containsAscii(bytes, "oleObject") || containsAscii(bytes, "/embeddings/")) {
      warnings.push(`${filename}: contains embedded objects; they are stored but never opened by miosotis`);
    }
  }
  if (mime === "image/svg+xml") {
    const text = Buffer.from(bytes).toString("utf8");
    if (/<script\b/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text)) {
      problems.push(`${filename}: SVG with scripts or event handlers is not accepted; export it as PNG or a clean SVG`);
    }
  }
  if (mime === "application/pdf" && (containsAscii(bytes, "/JavaScript") || containsAscii(bytes, "/JS "))) {
    warnings.push(`${filename}: the PDF contains JavaScript; open it in a viewer that blocks scripts`);
  }
  return { ok: problems.length === 0, problems, warnings };
}
