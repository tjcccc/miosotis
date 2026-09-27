import { MiosotisError } from "../domain/errors.js";
import { activeDerived, activeDerivedList, type DerivedRecordRow } from "../infra/db/repos/derived.js";
import { derivedChunks, payloadsFor } from "../infra/db/repos/files.js";
import { getChunks, getSource, getSourceVersion } from "../infra/db/repos/sources.js";
import { replaceSearchRows, type SearchRow } from "../infra/search/indexer.js";
import type { AppContext } from "./context.js";

export interface TextSegment {
  ordinal: number;
  start: number;
  end: number;
  /** Set when the segment is part of extracted text rather than authored text. */
  derivationId: string | null;
}

/** The readable text of one revision: authored text, or the active extraction of its file. */
export interface ReadableText {
  origin: "authored" | "extracted" | "none";
  text: string;
  derivationId: string | null;
  segments: TextSegment[];
}

export function derivationText(context: AppContext, derivation: DerivedRecordRow): string {
  if (derivation.content_blob === null) {
    throw new MiosotisError("internal", `Derivation ${derivation.id} has no stored text`);
  }
  return context.blobs.read(derivation.content_blob).toString("utf8");
}

export function readableText(context: AppContext, sourceId: string, version: number): ReadableText {
  const row = getSourceVersion(context.db, sourceId, version);
  if (row === undefined || row.content_text === null) {
    return { origin: "none", text: "", derivationId: null, segments: [] };
  }
  if (row.content_text.length > 0) {
    return {
      origin: "authored",
      text: row.content_text,
      derivationId: null,
      segments: getChunks(context.db, sourceId, version).map((chunk) => ({
        ordinal: chunk.ordinal,
        start: chunk.start_offset,
        end: chunk.end_offset,
        derivationId: null,
      })),
    };
  }
  const extraction = activeDerived(context.db, sourceId, version, "extraction");
  if (extraction === undefined || extraction.content_blob === null) {
    return { origin: "none", text: "", derivationId: null, segments: [] };
  }
  return {
    origin: "extracted",
    text: derivationText(context, extraction),
    derivationId: extraction.id,
    segments: derivedChunks(context.db, extraction.id).map((chunk) => ({
      ordinal: chunk.ordinal,
      start: chunk.start_offset,
      end: chunk.end_offset,
      derivationId: extraction.id,
    })),
  };
}

export interface InterpretationContent {
  description: string;
  transcription?: string | null;
  observations?: { text: string; legibility: string }[];
}

export function interpretationSearchText(content: InterpretationContent): string {
  return [content.description, content.transcription ?? "", ...(content.observations ?? []).map((o) => o.text)].join(
    "\n",
  );
}

function enrichmentText(json: string | null): string {
  if (json === null) {
    return "";
  }
  const content = JSON.parse(json) as {
    title?: string | null;
    abstract?: string | null;
    terms?: string[];
    entities?: { name: string }[];
  };
  return [
    content.title ?? "",
    content.abstract ?? "",
    ...(content.terms ?? []),
    ...(content.entities ?? []).map((e) => e.name),
  ].join("\n");
}

/**
 * Rebuilds a source's search rows from its current revision: authored or extracted text chunks,
 * payload filenames, the active enrichment, and active image interpretations. Trashed or purged
 * sources are removed from the index. Call inside a write transaction.
 */
export function reindex(context: AppContext, sourceId: string): void {
  const source = getSource(context.db, sourceId);
  if (source === undefined) {
    return;
  }
  const version = source.current_version;
  if (source.retention !== "retained") {
    replaceSearchRows(context.db, sourceId, version, []);
    return;
  }
  const rows: SearchRow[] = [];
  const readable = readableText(context, sourceId, version);
  for (const segment of readable.segments) {
    rows.push({
      text: readable.text.slice(segment.start, segment.end),
      field: readable.origin === "extracted" ? "extracted" : "body",
      chunkOrdinal: segment.ordinal,
    });
  }
  for (const payload of payloadsFor(context.db, sourceId, version)) {
    if (payload.filename !== null) {
      rows.push({ text: payload.filename, field: "filename", chunkOrdinal: null });
    }
  }
  const enrichment = activeDerived(context.db, sourceId, version, "enrichment");
  rows.push({ text: enrichmentText(enrichment?.content_json ?? null), field: "enrichment", chunkOrdinal: null });
  for (const interpretation of activeDerivedList(context.db, sourceId, version, "interpretation")) {
    if (interpretation.content_json !== null) {
      rows.push({
        text: interpretationSearchText(JSON.parse(interpretation.content_json) as InterpretationContent),
        field: "interpretation",
        chunkOrdinal: null,
      });
    }
  }
  replaceSearchRows(context.db, sourceId, version, rows);
}

/** Where an extracted-text span sits (page, sheet, range), from the chunk that contains it. */
export function spanLocator(
  context: AppContext,
  derivationId: string | null,
  start: number,
): Record<string, unknown> | null {
  if (derivationId === null) {
    return null;
  }
  const chunk = context.db.get<{ locator_json: string | null }>(
    "SELECT locator_json FROM derived_chunks WHERE derivation_id = ? AND start_offset <= ? AND end_offset > ? ORDER BY ordinal LIMIT 1",
    [derivationId, start, start],
  );
  return chunk?.locator_json == null ? null : (JSON.parse(chunk.locator_json) as Record<string, unknown>);
}

export function describeLocator(locator: Record<string, unknown> | null): string {
  if (locator === null) {
    return "";
  }
  return [
    typeof locator.page === "number" ? `p. ${locator.page}` : "",
    typeof locator.sheet === "string" ? `sheet ${locator.sheet}` : "",
    typeof locator.range === "string" ? locator.range : "",
    typeof locator.section === "string" ? `§ ${locator.section}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
}
