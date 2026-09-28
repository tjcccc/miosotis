import type { Database } from "../database.js";

export interface PayloadRow {
  source_id: string;
  version: number;
  ordinal: number;
  blob_sha256: string;
  role: "original" | "attachment";
  filename: string | null;
  mime: string;
}

export function insertBlob(db: Database, blob: { sha256: string; size: number; mime: string; at: string }): void {
  db.run("INSERT OR IGNORE INTO blobs (sha256, size, mime, created_at) VALUES (?, ?, ?, ?)", [
    blob.sha256,
    blob.size,
    blob.mime,
    blob.at,
  ]);
  // Referencing the bytes again cancels an erasure a purge left pending for them.
  db.run("DELETE FROM pending_erasures WHERE kind = 'blob' AND target = ?", [blob.sha256]);
}

export function insertPayload(db: Database, row: PayloadRow): void {
  db.run(
    "INSERT INTO version_payloads (source_id, version, ordinal, blob_sha256, role, filename, mime) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [row.source_id, row.version, row.ordinal, row.blob_sha256, row.role, row.filename, row.mime],
  );
}

export function payloadsFor(db: Database, sourceId: string, version: number): PayloadRow[] {
  return db.all<PayloadRow>("SELECT * FROM version_payloads WHERE source_id = ? AND version = ? ORDER BY ordinal", [
    sourceId,
    version,
  ]);
}

export function insertLink(
  db: Database,
  link: { from: string; to: string; kind: "references" | "supersedes"; origin: string; at: string },
): void {
  db.run(
    "INSERT OR IGNORE INTO source_links (from_source, to_source, kind, origin, created_at) VALUES (?, ?, ?, ?, ?)",
    [link.from, link.to, link.kind, link.origin, link.at],
  );
}

export function linksFor(db: Database, sourceId: string) {
  return {
    references: db.all<{ to_source: string; kind: string }>(
      "SELECT to_source, kind FROM source_links WHERE from_source = ? ORDER BY to_source",
      [sourceId],
    ),
    referenced_by: db.all<{ from_source: string; kind: string }>(
      "SELECT from_source, kind FROM source_links WHERE to_source = ? ORDER BY from_source",
      [sourceId],
    ),
  };
}

export interface DerivedChunkRow {
  derivation_id: string;
  ordinal: number;
  start_offset: number;
  end_offset: number;
  locator_json: string | null;
}

export function insertDerivedChunk(db: Database, row: DerivedChunkRow): void {
  db.run(
    "INSERT INTO derived_chunks (derivation_id, ordinal, start_offset, end_offset, locator_json) VALUES (?, ?, ?, ?, ?)",
    [row.derivation_id, row.ordinal, row.start_offset, row.end_offset, row.locator_json],
  );
}

export function derivedChunks(db: Database, derivationId: string): DerivedChunkRow[] {
  return db.all<DerivedChunkRow>("SELECT * FROM derived_chunks WHERE derivation_id = ? ORDER BY ordinal", [
    derivationId,
  ]);
}

export function allBlobs(db: Database): { sha256: string; size: number; mime: string }[] {
  return db.all("SELECT sha256, size, mime FROM blobs ORDER BY sha256");
}
