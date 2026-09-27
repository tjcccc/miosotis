-- Rich (HTML) artifacts. `content_markdown` remains the required, citable summary of every artifact;
-- `payload_html` holds a host-authored page stored verbatim and only ever shown inside a sandbox.
ALTER TABLE artifacts ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'html'));
ALTER TABLE artifacts ADD COLUMN payload_html TEXT;

DROP TRIGGER artifacts_content_frozen;

-- Same freeze rule as v1, extended to the new columns: content may only be removed by the purge transition.
CREATE TRIGGER artifacts_content_frozen
BEFORE UPDATE ON artifacts
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.intent IS NOT OLD.intent
  OR NEW.evidence_run_id IS NOT OLD.evidence_run_id
  OR NEW.generator_json IS NOT OLD.generator_json
  OR NEW.finalized_at IS NOT OLD.finalized_at
  OR NEW.format IS NOT OLD.format
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
