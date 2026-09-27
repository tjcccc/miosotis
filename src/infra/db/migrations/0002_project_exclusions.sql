-- Explicit user decisions that a Source does NOT belong to a Project.
-- Recorded by `source unassign` so later AI suggestions cannot silently re-add the membership
-- (explicit user intent wins over inferred data). `source assign` removes the exclusion.
CREATE TABLE source_project_exclusions (
  source_id TEXT NOT NULL REFERENCES sources (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, project_id)
) STRICT;
