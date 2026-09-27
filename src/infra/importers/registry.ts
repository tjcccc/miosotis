import { importText, TEXT_PIPELINE } from "./text.js";

/** A locator for part of extracted text, e.g. a PDF page or a spreadsheet range. */
export interface TextLocator {
  page?: number | undefined;
  sheet?: string | undefined;
  range?: string | undefined;
  section?: string | undefined;
}

export interface ImportedSegment {
  start: number;
  end: number;
  locator: TextLocator;
}

export type ImportResult =
  | { ok: true; text: string; segments: ImportedSegment[]; details: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * A deterministic, built-in file importer. This is the plugin seam: optional importer packages could
 * register here later. miosotis ships only the text importer; other formats are extracted by the AI
 * host and submitted through `extract apply`.
 */
export interface Importer {
  id: string;
  pipeline: string;
  accepts(mime: string): boolean;
  extract(bytes: Uint8Array): ImportResult;
}

const textImporter: Importer = {
  id: "text",
  pipeline: TEXT_PIPELINE,
  accepts: (mime) => mime === "text/plain" || mime === "text/markdown" || mime === "application/json",
  extract: (bytes) => {
    const imported = importText(bytes);
    return imported.ok
      ? { ok: true, text: imported.text, segments: [], details: { encoding: "utf-8", bom: imported.bom } }
      : { ok: false, reason: imported.reason };
  },
};

const IMPORTERS: Importer[] = [textImporter];

export function findImporter(mime: string): Importer | undefined {
  return IMPORTERS.find((importer) => importer.accepts(mime));
}
