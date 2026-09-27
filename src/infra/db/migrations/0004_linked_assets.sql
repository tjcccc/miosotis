-- Asset mode for HTML artifacts. `embedded` (default): the page is fully self-contained.
-- `linked`: the page may load pinned resources from allowlisted hosts; the validated hosts are frozen
-- in `linked_hosts_json` and are the only ones the viewer's policy allows.
ALTER TABLE artifacts ADD COLUMN assets TEXT NOT NULL DEFAULT 'embedded' CHECK (assets IN ('embedded', 'linked'));
ALTER TABLE artifacts ADD COLUMN linked_hosts_json TEXT;

DROP TRIGGER artifacts_content_frozen;

CREATE TRIGGER artifacts_content_frozen
BEFORE UPDATE ON artifacts
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.intent IS NOT OLD.intent
  OR NEW.evidence_run_id IS NOT OLD.evidence_run_id
  OR NEW.generator_json IS NOT OLD.generator_json
  OR NEW.finalized_at IS NOT OLD.finalized_at
  OR NEW.format IS NOT OLD.format
  OR NEW.assets IS NOT OLD.assets
  OR NEW.linked_hosts_json IS NOT OLD.linked_hosts_json
  OR (
    (
      NEW.title IS NOT OLD.title
      OR NEW.request IS NOT OLD.request
      OR NEW.content_markdown IS NOT OLD.content_markdown
      OR NEW.rendered_html IS NOT OLD.rendered_html
      OR NEW.content_hash IS NOT OLD.content_hash
      OR NEW.limitations_json IS NOT OLD.limitations_json
      OR NEW.payload_html IS NOT OLD.payload_html
    )
    AND NOT (
      OLD.purged_at IS NULL
      AND NEW.purged_at IS NOT NULL
      AND NEW.lifecycle = 'purged'
      AND NEW.title IS NULL
      AND NEW.request IS NULL
      AND NEW.content_markdown IS NULL
      AND NEW.rendered_html IS NULL
      AND NEW.content_hash IS NULL
      AND NEW.limitations_json IS NULL
      AND NEW.payload_html IS NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact content is immutable');
END;
