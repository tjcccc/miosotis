import type { Database } from "../database.js";

/** Every stored file reference and the item that owns it. Purge erases a file only when no survivor uses it. */
export interface BlobReference {
  sha256: string;
  owner_kind: "source" | "dataset" | "artifact";
  owner_id: string;
}

export function blobReferences(db: Database): BlobReference[] {
  return db.all<BlobReference>(
    `SELECT blob_sha256 AS sha256, 'source' AS owner_kind, source_id AS owner_id FROM version_payloads
     UNION ALL
     SELECT content_blob, 'source', source_id FROM derived_records WHERE content_blob IS NOT NULL
     UNION ALL
     SELECT json_extract(content_json, '$.tables_blob'), 'source', source_id FROM derived_records
       WHERE content_json IS NOT NULL AND json_extract(content_json, '$.tables_blob') IS NOT NULL
     UNION ALL
     SELECT result_blob, 'dataset', id FROM datasets
     UNION ALL
     SELECT blob_sha256, 'artifact', artifact_id FROM artifact_files`,
  );
}

export function blobSizes(db: Database, hashes: string[]): number {
  if (hashes.length === 0) {
    return 0;
  }
  return (
    db.get<{ bytes: number | null }>(
      `SELECT sum(size) AS bytes FROM blobs WHERE sha256 IN (${hashes.map(() => "?").join(", ")})`,
      hashes,
    )?.bytes ?? 0
  );
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(", ");
}

export function datasetsUsingSources(db: Database, sourceIds: string[]): string[] {
  if (sourceIds.length === 0) {
    return [];
  }
  return db
    .all<{ id: string }>(
      `SELECT DISTINCT dataset_id AS id FROM dataset_inputs WHERE source_id IN (${placeholders(sourceIds)}) ORDER BY id`,
      sourceIds,
    )
    .map((row) => row.id);
}

/** Artifacts whose citations point at these sources, directly or through a dataset calculated from them. */
export function artifactsCiting(
  db: Database,
  sourceIds: string[],
  datasetIds: string[],
): { id: string; via: "source" | "dataset" }[] {
  const direct =
    sourceIds.length === 0
      ? []
      : db.all<{ id: string }>(
          `SELECT DISTINCT c.artifact_id AS id FROM artifact_citations c
           JOIN evidence_items i ON i.run_id = c.run_id AND i.handle = c.handle
           WHERE i.source_id IN (${placeholders(sourceIds)})
             AND json_extract(coalesce(i.locator_json, '{}'), '$.dataset_id') IS NULL`,
          sourceIds,
        );
  const viaDataset =
    datasetIds.length === 0
      ? []
      : db.all<{ id: string }>(
          `SELECT DISTINCT c.artifact_id AS id FROM artifact_citations c
           JOIN evidence_items i ON i.run_id = c.run_id AND i.handle = c.handle
           WHERE json_extract(i.locator_json, '$.dataset_id') IN (${placeholders(datasetIds)})`,
          datasetIds,
        );
  const result = new Map<string, "source" | "dataset">();
  for (const row of direct) {
    result.set(row.id, "source");
  }
  for (const row of viaDataset) {
    if (!result.has(row.id)) {
      result.set(row.id, "dataset");
    }
  }
  return [...result].map(([id, via]) => ({ id, via }));
}

/** Sources saved together with these (comment ↔ attached files), outside the given set. */
export function linkedSources(db: Database, sourceIds: string[]) {
  if (sourceIds.length === 0) {
    return [];
  }
  const list = placeholders(sourceIds);
  return db.all<{ from_source: string; to_source: string }>(
    `SELECT from_source, to_source FROM source_links WHERE from_source IN (${list}) OR to_source IN (${list})`,
    [...sourceIds, ...sourceIds],
  );
}

/** Evidence runs (not yet cleared) that pinned these sources or datasets; their requests often quote the content. */
export function runsPinning(db: Database, sourceIds: string[], datasetIds: string[]): string[] {
  if (sourceIds.length === 0 && datasetIds.length === 0) {
    return [];
  }
  const bySource = sourceIds.length === 0 ? "0" : `i.source_id IN (${placeholders(sourceIds)})`;
  const byDataset =
    datasetIds.length === 0 ? "0" : `json_extract(i.locator_json, '$.dataset_id') IN (${placeholders(datasetIds)})`;
  return db
    .all<{ id: string }>(
      `SELECT DISTINCT r.id FROM evidence_items i JOIN evidence_runs r ON r.id = i.run_id
       WHERE r.purged_at IS NULL AND (${bySource} OR ${byDataset}) ORDER BY r.id`,
      [...sourceIds, ...datasetIds],
    )
    .map((row) => row.id);
}

export function runCleared(db: Database, runId: string): boolean {
  return db.get("SELECT 1 AS cleared FROM evidence_runs WHERE id = ? AND purged_at IS NOT NULL", [runId]) !== undefined;
}

export function artifactsUsingRun(db: Database, runId: string): { id: string; lifecycle: string }[] {
  return db.all("SELECT id, lifecycle FROM artifacts WHERE evidence_run_id = ?", [runId]);
}

export function deleteDataset(db: Database, datasetId: string): void {
  db.run("DELETE FROM dataset_inputs WHERE dataset_id = ?", [datasetId]);
  db.run("DELETE FROM datasets WHERE id = ?", [datasetId]);
}

/**
 * Removes a source's content everywhere in the database, keeping only non-content tombstones: the
 * source row (kind, origin, dates, retention `purged`), its revision rows (numbers, sizes, times),
 * derivation rows (kind, method, model), and the offsets of pinned evidence.
 */
export function purgeSourceRows(db: Database, sourceId: string, at: string, changeSeq: number): void {
  db.run(
    "UPDATE source_versions SET content_text = NULL, content_digest = NULL, provenance_json = NULL, purged_at = ? WHERE source_id = ? AND purged_at IS NULL",
    [at, sourceId],
  );
  db.run(
    `UPDATE evidence_items SET locator_json = '{"purged":true}'
     WHERE source_id = ? AND json_extract(locator_json, '$.payload_sha256') IS NOT NULL`,
    [sourceId],
  );
  db.run("DELETE FROM version_payloads WHERE source_id = ?", [sourceId]);
  db.run("DELETE FROM derived_chunks WHERE derivation_id IN (SELECT id FROM derived_records WHERE source_id = ?)", [
    sourceId,
  ]);
  db.run(
    `UPDATE derived_records SET content_json = NULL, content_blob = NULL, payload_sha256 = NULL,
       input_digest = 'purged', purged_at = coalesce(purged_at, ?)
     WHERE source_id = ?`,
    [at, sourceId],
  );
  db.run("DELETE FROM chunks WHERE source_id = ?", [sourceId]);
  db.run("DELETE FROM processing_states WHERE source_id = ?", [sourceId]);
  db.run("DELETE FROM search_fts WHERE source_id = ?", [sourceId]);
  db.run("DELETE FROM source_projects WHERE source_id = ?", [sourceId]);
  db.run("DELETE FROM source_project_exclusions WHERE source_id = ?", [sourceId]);
  db.run(
    "UPDATE sources SET retention = 'purged', inclusion_reason = NULL, changed_seq = ?, updated_at = ? WHERE id = ?",
    [changeSeq, at, sourceId],
  );
}

/** The artifact purge transition (allowed by the freeze trigger) plus its stored files. */
export function purgeArtifactRows(db: Database, artifactId: string, at: string): void {
  db.run(
    `UPDATE artifacts SET lifecycle = 'purged', lifecycle_changed_at = ?, purged_at = ?, title = NULL, request = NULL,
       content_markdown = NULL, rendered_html = NULL, content_hash = NULL, limitations_json = NULL, payload_html = NULL
     WHERE id = ?`,
    [at, at, artifactId],
  );
  db.run("DELETE FROM artifact_files WHERE artifact_id = ?", [artifactId]);
}

export function clearEvidenceRun(db: Database, runId: string, at: string): void {
  db.run(
    "UPDATE evidence_runs SET request = '', interpretation_json = '{}', coverage_json = '{}', purged_at = ? WHERE id = ? AND purged_at IS NULL",
    [at, runId],
  );
}

/** Operations whose receipts or request digests describe an item (receipts can name files and titles). */
export function operationsAbout(
  db: Database,
  item: { sourceId: string } | { artifactId: string },
): { id: string; kind: string; receipt_json: string }[] {
  if ("artifactId" in item) {
    return db.all(
      "SELECT id, kind, receipt_json FROM operations WHERE kind = 'artifact' AND json_extract(receipt_json, '$.id') = ?",
      [item.artifactId],
    );
  }
  return db.all(
    `SELECT id, kind, receipt_json FROM operations
     WHERE id IN (SELECT capture_op_id FROM sources WHERE id = ?)
        OR (kind = 'enrich' AND json_extract(receipt_json, '$.ref') LIKE ?)
        OR (kind = 'correct' AND json_extract(receipt_json, '$.source_id') = ?)`,
    [item.sourceId, `${item.sourceId}@v%`, item.sourceId],
  );
}

/** A replay of a scrubbed operation's idempotency key then conflicts instead of revealing or recreating content. */
export function scrubOperation(db: Database, id: string, receiptJson: string): void {
  db.run("UPDATE operations SET request_digest = 'purged', receipt_json = ? WHERE id = ?", [receiptJson, id]);
}

/** Audit rows keep who did what and when; details (reasons, changes) can quote content, so they go. */
export function scrubAuditDetails(db: Database, subjectId: string): void {
  db.run(
    `UPDATE audit_events SET detail_json = NULL
     WHERE detail_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(audit_events.subject_ids) WHERE value = ?)`,
    [subjectId],
  );
}

export function deleteBlobRow(db: Database, sha256: string): void {
  db.run("DELETE FROM blobs WHERE sha256 = ?", [sha256]);
}

export type ErasureKind = "blob" | "artifact_folder";

export function addPendingErasure(db: Database, kind: ErasureKind, target: string, at: string): void {
  db.run("INSERT OR IGNORE INTO pending_erasures (kind, target, created_at) VALUES (?, ?, ?)", [kind, target, at]);
}

export function pendingErasures(db: Database): { kind: ErasureKind; target: string }[] {
  return db.all("SELECT kind, target FROM pending_erasures ORDER BY created_at, kind, target");
}

export function isPendingErasure(db: Database, kind: ErasureKind, target: string): boolean {
  return (
    db.get("SELECT 1 AS present FROM pending_erasures WHERE kind = ? AND target = ?", [kind, target]) !== undefined
  );
}

export function removePendingErasure(db: Database, kind: ErasureKind, target: string): void {
  db.run("DELETE FROM pending_erasures WHERE kind = ? AND target = ?", [kind, target]);
}

export function blobRowExists(db: Database, sha256: string): boolean {
  return db.get("SELECT 1 AS present FROM blobs WHERE sha256 = ?", [sha256]) !== undefined;
}

export function optimizeSearchIndex(db: Database): void {
  db.run("INSERT INTO search_fts (search_fts) VALUES ('optimize')");
}
