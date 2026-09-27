import type { Database } from "../database.js";

export interface ArtifactRow {
  id: string;
  schema_version: number;
  intent: "review" | "analysis" | "discuss";
  format: "markdown" | "html";
  payload_html: string | null;
  assets: "embedded" | "linked";
  linked_hosts_json: string | null;
  title: string | null;
  request: string | null;
  evidence_run_id: string;
  content_markdown: string | null;
  rendered_html: string | null;
  content_hash: string | null;
  generator_json: string;
  limitations_json: string | null;
  lifecycle: "active" | "trashed" | "purged";
  finalized_at: string;
  lifecycle_changed_at: string | null;
  purged_at: string | null;
}

export function insertArtifact(db: Database, row: ArtifactRow): void {
  db.run(
    `INSERT INTO artifacts (id, schema_version, intent, format, payload_html, assets, linked_hosts_json, title, request,
       evidence_run_id, content_markdown, rendered_html, content_hash, generator_json, limitations_json, lifecycle,
       finalized_at, lifecycle_changed_at, purged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.schema_version,
      row.intent,
      row.format,
      row.payload_html,
      row.assets,
      row.linked_hosts_json,
      row.title,
      row.request,
      row.evidence_run_id,
      row.content_markdown,
      row.rendered_html,
      row.content_hash,
      row.generator_json,
      row.limitations_json,
      row.lifecycle,
      row.finalized_at,
      row.lifecycle_changed_at,
      row.purged_at,
    ],
  );
}

export function getArtifact(db: Database, id: string): ArtifactRow | undefined {
  return db.get<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", [id]);
}

export interface CitationRow {
  artifact_id: string;
  run_id: string;
  handle: string;
  source_id: string;
  version: number;
  start_offset: number;
  end_offset: number;
  derivation_id: string | null;
  locator_json: string | null;
}

export function getCitations(db: Database, artifactId: string): CitationRow[] {
  return db.all<CitationRow>(
    `SELECT c.artifact_id, c.run_id, c.handle, i.source_id, i.version, i.start_offset, i.end_offset, i.derivation_id,
       i.locator_json
     FROM artifact_citations c JOIN evidence_items i ON i.run_id = c.run_id AND i.handle = c.handle
     WHERE c.artifact_id = ?
     ORDER BY CAST(substr(c.handle, 2) AS INTEGER)`,
    [artifactId],
  );
}

export interface LinkRow {
  parent_id: string;
  child_id: string;
  kind: "derived_from" | "supersedes";
  created_at: string;
}

export function getLinks(db: Database, artifactId: string): LinkRow[] {
  return db.all<LinkRow>("SELECT * FROM artifact_links WHERE parent_id = ? OR child_id = ? ORDER BY created_at", [
    artifactId,
    artifactId,
  ]);
}

/** Artifacts citing any revision of a source, with the revision each one used. */
export function artifactsCitingSource(db: Database, sourceId: string) {
  return db.all<{ artifact_id: string; title: string | null; lifecycle: string; version: number }>(
    `SELECT DISTINCT a.id AS artifact_id, a.title, a.lifecycle, i.version
     FROM artifact_citations c
     JOIN evidence_items i ON i.run_id = c.run_id AND i.handle = c.handle
     JOIN artifacts a ON a.id = c.artifact_id
     WHERE i.source_id = ?
     ORDER BY a.finalized_at DESC`,
    [sourceId],
  );
}
