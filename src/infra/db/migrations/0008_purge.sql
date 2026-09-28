-- Purge (v0.3): narrow transitions that remove content while keeping non-content tombstones, plus a
-- durable list of files still to erase after the purge transaction commits.

-- FTS5 removes deleted entries from the index right away instead of at a later segment merge.
INSERT INTO search_fts (search_fts, rank) VALUES ('secure-delete', 1);

-- Evidence runs keep their identity; a purge may clear the request wording once.
ALTER TABLE evidence_runs ADD COLUMN purged_at TEXT;

DROP TRIGGER evidence_runs_immutable;

CREATE TRIGGER evidence_runs_immutable
BEFORE UPDATE ON evidence_runs
WHEN NOT (
  OLD.purged_at IS NULL
  AND NEW.purged_at IS NOT NULL
  AND NEW.request = ''
  AND NEW.interpretation_json = '{}'
  AND NEW.coverage_json = '{}'
  AND NEW.id IS OLD.id
  AND NEW.intent IS OLD.intent
  AND NEW.project_id IS OLD.project_id
  AND NEW.scope_json IS OLD.scope_json
  AND NEW.strategy_version IS OLD.strategy_version
  AND NEW.watermark_seq IS OLD.watermark_seq
  AND NEW.extends_run_id IS OLD.extends_run_id
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'evidence runs are immutable');
END;

-- A pinned file's locator names the file; once its revision is purged the locator may be cleared.
DROP TRIGGER evidence_items_immutable;

CREATE TRIGGER evidence_items_immutable
BEFORE UPDATE ON evidence_items
WHEN NOT (
  OLD.locator_json IS NOT NULL
  AND NEW.locator_json = '{"purged":true}'
  AND EXISTS (
    SELECT 1 FROM source_versions v
    WHERE v.source_id = OLD.source_id AND v.version = OLD.version AND v.purged_at IS NOT NULL
  )
  AND NEW.run_id IS OLD.run_id
  AND NEW.handle IS OLD.handle
  AND NEW.source_id IS OLD.source_id
  AND NEW.version IS OLD.version
  AND NEW.start_offset IS OLD.start_offset
  AND NEW.end_offset IS OLD.end_offset
  AND NEW.origin IS OLD.origin
  AND NEW.derivation_id IS OLD.derivation_id
)
BEGIN
  SELECT RAISE(ABORT, 'evidence items are immutable');
END;

-- Files are erased after commit. These rows are written in the purge transaction, so an interrupted
-- purge is finished later instead of leaving purged bytes behind as "orphans".
CREATE TABLE pending_erasures (
  kind TEXT NOT NULL CHECK (kind IN ('blob', 'artifact_folder')),
  target TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, target)
) STRICT;
