import { foldForSearch } from "../../domain/text.js";
import type { Database } from "../db/database.js";

export type SearchField = "body" | "extracted" | "filename" | "enrichment" | "interpretation";

export interface SearchRow {
  text: string;
  field: SearchField;
  /** Chunk ordinal for `body` (authored text) and `extracted` rows; null otherwise. */
  chunkOrdinal: number | null;
}

/**
 * Replaces a source's search rows. Only current-version content is indexed; policy (retention,
 * inclusion, project) is applied at query time. Call inside the transaction that changes the source.
 */
export function replaceSearchRows(db: Database, sourceId: string, version: number, rows: SearchRow[]): void {
  removeFromIndex(db, sourceId);
  for (const row of rows) {
    if (row.text.trim().length === 0) {
      continue;
    }
    db.run("INSERT INTO search_fts (norm, source_id, version, chunk_ordinal, field) VALUES (?, ?, ?, ?, ?)", [
      foldForSearch(row.text),
      sourceId,
      version,
      row.chunkOrdinal,
      row.field,
    ]);
  }
}

export function removeFromIndex(db: Database, sourceId: string): void {
  db.run("DELETE FROM search_fts WHERE source_id = ?", [sourceId]);
}
