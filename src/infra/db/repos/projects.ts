import type { Database } from "../database.js";

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  lifecycle: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export function findProjectBySlug(db: Database, slug: string): ProjectRow | undefined {
  return db.get<ProjectRow>("SELECT * FROM projects WHERE slug = ?", [slug]);
}

export function findProjectById(db: Database, id: string): ProjectRow | undefined {
  return db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
}

export function insertProject(db: Database, row: ProjectRow): void {
  db.run(
    "INSERT INTO projects (id, slug, name, description, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [row.id, row.slug, row.name, row.description, row.lifecycle, row.created_at, row.updated_at],
  );
}

export interface ProjectListRow extends ProjectRow {
  source_count: number;
}

export function listProjects(db: Database): ProjectListRow[] {
  return db.all<ProjectListRow>(
    `SELECT p.*, (
       SELECT count(*) FROM source_projects sp JOIN visible_sources v ON v.id = sp.source_id WHERE sp.project_id = p.id
     ) AS source_count
     FROM projects p
     ORDER BY p.slug`,
  );
}

export interface SourceProjectRow {
  source_id: string;
  project_id: string;
  slug: string;
  name: string;
  assignment: "explicit" | "inferred";
}

export function projectsForSources(db: Database, sourceIds: string[]): SourceProjectRow[] {
  if (sourceIds.length === 0) {
    return [];
  }
  const placeholders = sourceIds.map(() => "?").join(", ");
  return db.all<SourceProjectRow>(
    `SELECT sp.source_id, sp.project_id, p.slug, p.name, sp.assignment
     FROM source_projects sp JOIN projects p ON p.id = sp.project_id
     WHERE sp.source_id IN (${placeholders})
     ORDER BY p.slug`,
    sourceIds,
  );
}

export type AssignmentChange = "assigned" | "upgraded_from_inferred" | "unchanged" | "excluded";

export function isExcluded(db: Database, sourceId: string, projectId: string): boolean {
  return (
    db.get("SELECT 1 FROM source_project_exclusions WHERE source_id = ? AND project_id = ?", [sourceId, projectId]) !==
    undefined
  );
}

export function setExclusion(
  db: Database,
  input: { sourceId: string; projectId: string; actor: string; at: string },
): void {
  db.run(
    "INSERT OR IGNORE INTO source_project_exclusions (source_id, project_id, actor, created_at) VALUES (?, ?, ?, ?)",
    [input.sourceId, input.projectId, input.actor, input.at],
  );
}

export function clearExclusion(db: Database, sourceId: string, projectId: string): void {
  db.run("DELETE FROM source_project_exclusions WHERE source_id = ? AND project_id = ?", [sourceId, projectId]);
}

/** Removes a membership row of either kind; returns the kind removed, if any. */
export function removeMembership(db: Database, sourceId: string, projectId: string): "explicit" | "inferred" | null {
  const row = db.get<{ assignment: "explicit" | "inferred" }>(
    "SELECT assignment FROM source_projects WHERE source_id = ? AND project_id = ?",
    [sourceId, projectId],
  );
  if (row === undefined) {
    return null;
  }
  db.run("DELETE FROM source_projects WHERE source_id = ? AND project_id = ?", [sourceId, projectId]);
  return row.assignment;
}

/**
 * Explicit membership always wins: an explicit assignment upgrades an inferred row and clears any
 * exclusion; an inferred suggestion never overrides explicit membership or an explicit exclusion.
 */
export function assignMembership(
  db: Database,
  input: {
    sourceId: string;
    projectId: string;
    assignment: "explicit" | "inferred";
    actor: string;
    derivationId: string | null;
    at: string;
  },
): AssignmentChange {
  if (input.assignment === "inferred" && isExcluded(db, input.sourceId, input.projectId)) {
    return "excluded";
  }
  if (input.assignment === "explicit") {
    clearExclusion(db, input.sourceId, input.projectId);
  }
  const existing = db.get<{ assignment: string }>(
    "SELECT assignment FROM source_projects WHERE source_id = ? AND project_id = ?",
    [input.sourceId, input.projectId],
  );
  if (existing !== undefined) {
    if (existing.assignment === "inferred" && input.assignment === "explicit") {
      db.run(
        "UPDATE source_projects SET assignment = 'explicit', actor = ?, derivation_id = NULL, created_at = ? WHERE source_id = ? AND project_id = ?",
        [input.actor, input.at, input.sourceId, input.projectId],
      );
      return "upgraded_from_inferred";
    }
    return "unchanged";
  }
  db.run(
    "INSERT INTO source_projects (source_id, project_id, assignment, actor, derivation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.sourceId, input.projectId, input.assignment, input.actor, input.derivationId, input.at],
  );
  return "assigned";
}

export function assignProject(
  db: Database,
  input: {
    sourceId: string;
    projectId: string;
    assignment: "explicit" | "inferred";
    actor: string;
    derivationId: string | null;
    at: string;
  },
): boolean {
  const change = assignMembership(db, input);
  return change === "assigned" || change === "upgraded_from_inferred";
}
