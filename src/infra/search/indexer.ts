import { foldForSearch } from "../../domain/text.js";
import type { Database } from "../db/database.js";
import type { ChunkSpan } from "./chunker.js";

/**
 * Replaces a source's search rows with its given (current) version: one row per chunk of the original
 * text, plus one row of validated enrichment hints. Call inside the transaction that changes the source.
 */
export function reindexSource(
  db: Database,
  input: { sourceId: string; version: number; text: string; chunks: ChunkSpan[]; enrichmentText: string | null },
): void {
  removeFromIndex(db, input.sourceId);
  for (const chunk of input.chunks) {
    db.run("INSERT INTO search_fts (norm, source_id, version, chunk_ordinal, field) VALUES (?, ?, ?, ?, 'body')", [
      foldForSearch(input.text.slice(chunk.start, chunk.end)),
      input.sourceId,
      input.version,
      chunk.ordinal,
    ]);
  }
  if (input.enrichmentText !== null && input.enrichmentText.trim().length > 0) {
    db.run(
      "INSERT INTO search_fts (norm, source_id, version, chunk_ordinal, field) VALUES (?, ?, ?, NULL, 'enrichment')",
      [foldForSearch(input.enrichmentText), input.sourceId, input.version],
    );
  }
}

export function removeFromIndex(db: Database, sourceId: string): void {
  db.run("DELETE FROM search_fts WHERE source_id = ?", [sourceId]);
}
