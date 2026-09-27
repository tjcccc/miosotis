import type { Database } from "../database.js";

export interface DerivedRecordRow {
  id: string;
  source_id: string;
  version: number;
  kind: "enrichment" | "extraction" | "interpretation";
  input_digest: string;
  method: string;
  model: string | null;
  schema_version: number;
  pipeline_version: string;
  status: "complete" | "partial";
  content_json: string | null;
  superseded_by: string | null;
  created_at: string;
  purged_at: string | null;
  content_blob: string | null;
  payload_sha256: string | null;
}

export function insertDerivedRecord(db: Database, row: DerivedRecordRow): void {
  db.run(
    `INSERT INTO derived_records (id, source_id, version, kind, input_digest, method, model, schema_version,
       pipeline_version, status, content_json, superseded_by, created_at, purged_at, content_blob, payload_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.source_id,
      row.version,
      row.kind,
      row.input_digest,
      row.method,
      row.model,
      row.schema_version,
      row.pipeline_version,
      row.status,
      row.content_json,
      row.superseded_by,
      row.created_at,
      row.purged_at,
      row.content_blob,
      row.payload_sha256,
    ],
  );
}

/** Marks earlier active records of the same kind for this exact revision as superseded by `newId`. */
export function supersedeDerived(
  db: Database,
  sourceId: string,
  version: number,
  kind: string,
  newId: string,
  payloadSha256: string | null = null,
): void {
  db.run(
    `UPDATE derived_records SET superseded_by = ?
     WHERE source_id = ? AND version = ? AND kind = ? AND superseded_by IS NULL AND id <> ? AND payload_sha256 IS ?`,
    [newId, sourceId, version, kind, newId, payloadSha256],
  );
}

export function activeDerivedList(db: Database, sourceId: string, version: number, kind: string): DerivedRecordRow[] {
  return db.all<DerivedRecordRow>(
    "SELECT * FROM derived_records WHERE source_id = ? AND version = ? AND kind = ? AND superseded_by IS NULL AND purged_at IS NULL ORDER BY created_at",
    [sourceId, version, kind],
  );
}

export function getDerived(db: Database, id: string): DerivedRecordRow | undefined {
  return db.get<DerivedRecordRow>("SELECT * FROM derived_records WHERE id = ?", [id]);
}

export function activeDerived(
  db: Database,
  sourceId: string,
  version: number,
  kind: string,
): DerivedRecordRow | undefined {
  return db.get<DerivedRecordRow>(
    "SELECT * FROM derived_records WHERE source_id = ? AND version = ? AND kind = ? AND superseded_by IS NULL AND purged_at IS NULL",
    [sourceId, version, kind],
  );
}
