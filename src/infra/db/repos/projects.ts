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
      return true;
    }
    return false;
  }
  db.run(
    "INSERT INTO source_projects (source_id, project_id, assignment, actor, derivation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.sourceId, input.projectId, input.assignment, input.actor, input.derivationId, input.at],
  );
  return true;
}
