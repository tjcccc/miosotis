import type { Database } from "../database.js";

export interface TrashedSourceRow {
  id: string;
  kind: string;
  trashed_at: string;
  removed_with: string | null;
}

export interface TrashedArtifactRow {
  id: string;
  title: string | null;
  trashed_at: string | null;
  removed_with: string | null;
}

export function trashedSources(db: Database): TrashedSourceRow[] {
  return db.all(
    "SELECT id, kind, updated_at AS trashed_at, removed_with FROM sources WHERE retention = 'trashed' ORDER BY updated_at DESC, id",
  );
}

export function trashedArtifacts(db: Database): TrashedArtifactRow[] {
  return db.all(
    `SELECT id, title, lifecycle_changed_at AS trashed_at, removed_with FROM artifacts
     WHERE lifecycle = 'trashed' ORDER BY lifecycle_changed_at DESC, id`,
  );
}

export function setRemovedWith(
  db: Database,
  item: { sourceId: string } | { artifactId: string },
  removal: string | null,
) {
  if ("sourceId" in item) {
    db.run("UPDATE sources SET removed_with = ? WHERE id = ?", [removal, item.sourceId]);
  } else {
    db.run("UPDATE artifacts SET removed_with = ? WHERE id = ?", [removal, item.artifactId]);
  }
}

export function removalOf(db: Database, sourceId: string): string | null {
  return (
    db.get<{ removed_with: string | null }>("SELECT removed_with FROM sources WHERE id = ?", [sourceId])
      ?.removed_with ?? null
  );
}

/** Trashed artifacts that one `remove` moved to the trash together with a Source. */
export function artifactsRemovedWith(db: Database, removals: string[]): string[] {
  if (removals.length === 0) {
    return [];
  }
  return db
    .all<{ id: string }>(
      `SELECT id FROM artifacts WHERE lifecycle = 'trashed' AND removed_with IN (${removals.map(() => "?").join(", ")}) ORDER BY id`,
      removals,
    )
    .map((row) => row.id);
}
