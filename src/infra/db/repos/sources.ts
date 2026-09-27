import type {
  Inclusion,
  ProcessingStage,
  ProcessingState,
  Retention,
  SourceKind,
  SourceOrigin,
} from "../../../domain/source.js";
import type { ChunkSpan } from "../../search/chunker.js";
import type { Database } from "../database.js";

export interface SourceRow {
  id: string;
  kind: SourceKind;
  origin: SourceOrigin;
  capture_op_id: string;
  current_version: number;
  retention: Retention;
  inclusion: Inclusion;
  inclusion_reason: string | null;
  created_seq: number;
  changed_seq: number;
  created_at: string;
  updated_at: string;
}

export interface SourceVersionRow {
  source_id: string;
  version: number;
  parent_version: number | null;
  reason: "capture" | "correction";
  actor: string;
  content_text: string | null;
  content_digest: string | null;
  char_length: number;
  provenance_json: string | null;
  received_at: string;
  client_captured_at: string | null;
  timezone: string;
  purged_at: string | null;
}

export interface ChunkRow {
  source_id: string;
  version: number;
  ordinal: number;
  start_offset: number;
  end_offset: number;
}

export interface ProcessingRow {
  source_id: string;
  version: number;
  stage: ProcessingStage;
  state: ProcessingState;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export function insertSource(db: Database, row: SourceRow): void {
  db.run(
    `INSERT INTO sources (id, kind, origin, capture_op_id, current_version, retention, inclusion, inclusion_reason,
       created_seq, changed_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.kind,
      row.origin,
      row.capture_op_id,
      row.current_version,
      row.retention,
      row.inclusion,
      row.inclusion_reason,
      row.created_seq,
      row.changed_seq,
      row.created_at,
      row.updated_at,
    ],
  );
}

export function insertSourceVersion(db: Database, row: SourceVersionRow): void {
  db.run(
    `INSERT INTO source_versions (source_id, version, parent_version, reason, actor, content_text, content_digest,
       char_length, provenance_json, received_at, client_captured_at, timezone, purged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.source_id,
      row.version,
      row.parent_version,
      row.reason,
      row.actor,
      row.content_text,
      row.content_digest,
      row.char_length,
      row.provenance_json,
      row.received_at,
      row.client_captured_at,
      row.timezone,
      row.purged_at,
    ],
  );
}

export function insertChunks(db: Database, sourceId: string, version: number, spans: ChunkSpan[]): void {
  for (const span of spans) {
    db.run("INSERT INTO chunks (source_id, version, ordinal, start_offset, end_offset) VALUES (?, ?, ?, ?, ?)", [
      sourceId,
      version,
      span.ordinal,
      span.start,
      span.end,
    ]);
  }
}

export function setProcessingState(
  db: Database,
  input: {
    sourceId: string;
    version: number;
    stage: ProcessingStage;
    state: ProcessingState;
    error?: string | null;
    countAttempt?: boolean;
    at: string;
  },
): void {
  db.run(
    `INSERT INTO processing_states (source_id, version, stage, state, attempts, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, version, stage) DO UPDATE SET
       state = excluded.state,
       attempts = processing_states.attempts + excluded.attempts,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
    [
      input.sourceId,
      input.version,
      input.stage,
      input.state,
      input.countAttempt ? 1 : 0,
      input.error ?? null,
      input.at,
    ],
  );
}

export function getSource(db: Database, id: string): SourceRow | undefined {
  return db.get<SourceRow>("SELECT * FROM sources WHERE id = ?", [id]);
}

export function getSourceVersion(db: Database, id: string, version: number): SourceVersionRow | undefined {
  return db.get<SourceVersionRow>("SELECT * FROM source_versions WHERE source_id = ? AND version = ?", [id, version]);
}

export function listSourceVersions(db: Database, id: string): SourceVersionRow[] {
  return db.all<SourceVersionRow>("SELECT * FROM source_versions WHERE source_id = ? ORDER BY version", [id]);
}

export function getChunks(db: Database, id: string, version: number): ChunkRow[] {
  return db.all<ChunkRow>("SELECT * FROM chunks WHERE source_id = ? AND version = ? ORDER BY ordinal", [id, version]);
}

export function getProcessingStates(db: Database, id: string, version: number): ProcessingRow[] {
  return db.all<ProcessingRow>("SELECT * FROM processing_states WHERE source_id = ? AND version = ? ORDER BY stage", [
    id,
    version,
  ]);
}

export interface ListSourcesQuery {
  visibleOnly: boolean;
  projectId: string | undefined;
  since: string | undefined;
  until: string | undefined;
  limit: number;
  offset: number;
}

export interface ListedSourceRow extends SourceRow {
  char_length: number;
  received_at: string;
  enrichment_state: ProcessingState | null;
}

export function listSources(db: Database, query: ListSourcesQuery): { rows: ListedSourceRow[]; total: number } {
  const table = query.visibleOnly ? "visible_sources" : "sources";
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.projectId !== undefined) {
    where.push("EXISTS (SELECT 1 FROM source_projects sp WHERE sp.source_id = s.id AND sp.project_id = ?)");
    params.push(query.projectId);
  }
  if (query.since !== undefined) {
    where.push("s.created_at >= ?");
    params.push(query.since);
  }
  if (query.until !== undefined) {
    where.push("s.created_at < ?");
    params.push(query.until);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} s ${clause}`, params)?.n ?? 0;
  const rows = db.all<ListedSourceRow>(
    `SELECT s.*, v.char_length, v.received_at, ps.state AS enrichment_state
     FROM ${table} s
     JOIN source_versions v ON v.source_id = s.id AND v.version = s.current_version
     LEFT JOIN processing_states ps ON ps.source_id = s.id AND ps.version = s.current_version AND ps.stage = 'enrichment'
     ${clause}
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT ? OFFSET ?`,
    [...params, query.limit, query.offset],
  );
  return { rows, total };
}

export interface EnrichmentSummaryRow {
  source_id: string;
  version: number;
  id: string;
  content_json: string | null;
  model: string | null;
  created_at: string;
}

/** The current (non-superseded) enrichment for each given source's current version. */
export function currentEnrichments(db: Database, sourceIds: string[]): Map<string, EnrichmentSummaryRow> {
  const result = new Map<string, EnrichmentSummaryRow>();
  if (sourceIds.length === 0) {
    return result;
  }
  const placeholders = sourceIds.map(() => "?").join(", ");
  const rows = db.all<EnrichmentSummaryRow>(
    `SELECT d.source_id, d.version, d.id, d.content_json, d.model, d.created_at
     FROM derived_records d JOIN sources s ON s.id = d.source_id AND s.current_version = d.version
     WHERE d.kind = 'enrichment' AND d.superseded_by IS NULL AND d.purged_at IS NULL AND d.source_id IN (${placeholders})`,
    sourceIds,
  );
  for (const row of rows) {
    result.set(row.source_id, row);
  }
  return result;
}
