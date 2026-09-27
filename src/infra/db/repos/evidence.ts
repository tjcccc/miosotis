import type { Database } from "../database.js";

export interface EvidenceRunRow {
  id: string;
  request: string;
  intent: "review" | "analysis" | "discuss" | null;
  interpretation_json: string;
  project_id: string | null;
  scope_json: string;
  strategy_version: string;
  watermark_seq: number;
  extends_run_id: string | null;
  coverage_json: string;
  created_at: string;
}

export interface EvidenceItemRow {
  run_id: string;
  handle: string;
  source_id: string;
  version: number;
  start_offset: number;
  end_offset: number;
  origin: "search" | "source_ref" | "quote_pin" | "carried";
  derivation_id: string | null;
  locator_json: string | null;
}

export function insertEvidenceRun(db: Database, row: EvidenceRunRow): void {
  db.run(
    `INSERT INTO evidence_runs (id, request, intent, interpretation_json, project_id, scope_json, strategy_version,
       watermark_seq, extends_run_id, coverage_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.request,
      row.intent,
      row.interpretation_json,
      row.project_id,
      row.scope_json,
      row.strategy_version,
      row.watermark_seq,
      row.extends_run_id,
      row.coverage_json,
      row.created_at,
    ],
  );
}

export function insertEvidenceItem(db: Database, row: EvidenceItemRow): void {
  db.run(
    `INSERT INTO evidence_items (run_id, handle, source_id, version, start_offset, end_offset, origin, derivation_id, locator_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.run_id,
      row.handle,
      row.source_id,
      row.version,
      row.start_offset,
      row.end_offset,
      row.origin,
      row.derivation_id,
      row.locator_json,
    ],
  );
}

export function getEvidenceRun(db: Database, id: string): EvidenceRunRow | undefined {
  return db.get<EvidenceRunRow>("SELECT * FROM evidence_runs WHERE id = ?", [id]);
}

export function getEvidenceItems(db: Database, runId: string): EvidenceItemRow[] {
  return db.all<EvidenceItemRow>(
    "SELECT * FROM evidence_items WHERE run_id = ? ORDER BY CAST(substr(handle, 2) AS INTEGER)",
    [runId],
  );
}
