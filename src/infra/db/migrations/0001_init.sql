-- miosotis schema v1.
-- Originals are append-only; derived data is separate and rebuildable; policy lives in queryable columns.
-- Future enum values (file/url kinds, purge states, other processing stages) are admitted now so later
-- milestones do not need table rebuilds around the circular sources <-> source_versions reference.

CREATE TABLE library_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

INSERT INTO counters (name, value) VALUES ('change_seq', 0);

CREATE TABLE operations (
  id TEXT PRIMARY KEY CHECK (id GLOB 'O-*'),
  kind TEXT NOT NULL CHECK (kind IN ('capture', 'enrich', 'artifact', 'correct')),
  idempotency_key TEXT,
  request_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, idempotency_key)
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (id GLOB 'P-*'),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE sources (
  id TEXT PRIMARY KEY CHECK (id GLOB 'S-*'),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'file', 'url')),
  origin TEXT NOT NULL CHECK (origin IN ('user', 'imported', 'ai_saved')),
  capture_op_id TEXT NOT NULL REFERENCES operations (id),
  current_version INTEGER NOT NULL,
  retention TEXT NOT NULL DEFAULT 'retained' CHECK (retention IN ('retained', 'trashed', 'purged')),
  inclusion TEXT NOT NULL DEFAULT 'included' CHECK (inclusion IN ('included', 'ignored')),
  inclusion_reason TEXT,
  created_seq INTEGER NOT NULL,
  changed_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (id, current_version) REFERENCES source_versions (source_id, version) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX sources_created_at ON sources (created_at);
CREATE INDEX sources_changed_seq ON sources (changed_seq);

CREATE TABLE source_versions (
  source_id TEXT NOT NULL REFERENCES sources (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  parent_version INTEGER,
  reason TEXT NOT NULL CHECK (reason IN ('capture', 'correction')),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  content_text TEXT,
  content_digest TEXT,
  char_length INTEGER NOT NULL CHECK (char_length >= 0),
  provenance_json TEXT,
  received_at TEXT NOT NULL,
  client_captured_at TEXT,
  timezone TEXT NOT NULL,
  purged_at TEXT,
  PRIMARY KEY (source_id, version),
  FOREIGN KEY (source_id, parent_version) REFERENCES source_versions (source_id, version),
  CHECK ((version = 1 AND parent_version IS NULL) OR (version > 1 AND parent_version = version - 1)),
  CHECK ((content_text IS NULL) = (purged_at IS NOT NULL)),
  CHECK ((content_digest IS NULL) = (purged_at IS NOT NULL))
) STRICT;

-- Append-only: the only permitted UPDATE is the purge transition (content removed, identity kept).
CREATE TRIGGER source_versions_append_only
BEFORE UPDATE ON source_versions
WHEN NOT (
  OLD.purged_at IS NULL
  AND NEW.purged_at IS NOT NULL
  AND NEW.content_text IS NULL
  AND NEW.content_digest IS NULL
  AND NEW.provenance_json IS NULL
  AND NEW.source_id IS OLD.source_id
  AND NEW.version IS OLD.version
  AND NEW.parent_version IS OLD.parent_version
  AND NEW.reason IS OLD.reason
  AND NEW.actor IS OLD.actor
  AND NEW.char_length IS OLD.char_length
  AND NEW.received_at IS OLD.received_at
  AND NEW.client_captured_at IS OLD.client_captured_at
  AND NEW.timezone IS OLD.timezone
)
BEGIN
  SELECT RAISE(ABORT, 'source_versions rows are append-only');
END;

CREATE TABLE source_projects (
  source_id TEXT NOT NULL REFERENCES sources (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  assignment TEXT NOT NULL CHECK (assignment IN ('explicit', 'inferred')),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  derivation_id TEXT REFERENCES derived_records (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, project_id)
) STRICT;

CREATE INDEX source_projects_project ON source_projects (project_id);

-- Contiguous spans of each version's text, kept for every version so pinned evidence always resolves.
CREATE TABLE chunks (
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL,
  PRIMARY KEY (source_id, version, ordinal),
  FOREIGN KEY (source_id, version) REFERENCES source_versions (source_id, version),
  CHECK (end_offset > start_offset)
) STRICT;

CREATE TABLE derived_records (
  id TEXT PRIMARY KEY CHECK (id GLOB 'D-*'),
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('enrichment', 'extraction', 'interpretation')),
  input_digest TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('host_agent', 'local_provider', 'api_provider', 'external_runtime', 'parser')),
  model TEXT,
  schema_version INTEGER NOT NULL,
  pipeline_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  content_json TEXT,
  superseded_by TEXT REFERENCES derived_records (id),
  created_at TEXT NOT NULL,
  purged_at TEXT,
  FOREIGN KEY (source_id, version) REFERENCES source_versions (source_id, version)
) STRICT;

CREATE INDEX derived_records_source ON derived_records (source_id, version, kind);

CREATE TABLE processing_states (
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('extraction', 'enrichment', 'interpretation', 'indexing')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'partial', 'unsupported', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, version, stage),
  FOREIGN KEY (source_id, version) REFERENCES source_versions (source_id, version)
) STRICT;

CREATE INDEX processing_states_pending ON processing_states (stage, state);

-- Search index over folded text of current versions only. Policy filters are applied by JOIN at query time.
CREATE VIRTUAL TABLE search_fts USING fts5 (
  norm,
  source_id UNINDEXED,
  version UNINDEXED,
  chunk_ordinal UNINDEXED,
  field UNINDEXED,
  tokenize = 'trigram remove_diacritics 1'
);

CREATE TABLE evidence_runs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'E-*'),
  request TEXT NOT NULL,
  intent TEXT CHECK (intent IN ('review', 'analysis', 'discuss')),
  interpretation_json TEXT NOT NULL,
  project_id TEXT REFERENCES projects (id),
  scope_json TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  watermark_seq INTEGER NOT NULL,
  extends_run_id TEXT REFERENCES evidence_runs (id),
  coverage_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- Excerpts are not stored: they are computed from immutable version text and these offsets.
CREATE TABLE evidence_items (
  run_id TEXT NOT NULL REFERENCES evidence_runs (id),
  handle TEXT NOT NULL CHECK (handle GLOB 'c[1-9]*'),
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('search', 'source_ref', 'quote_pin', 'carried')),
  PRIMARY KEY (run_id, handle),
  FOREIGN KEY (source_id, version) REFERENCES source_versions (source_id, version),
  CHECK (end_offset > start_offset)
) STRICT;

CREATE INDEX evidence_items_source ON evidence_items (source_id, version);

CREATE TRIGGER evidence_runs_immutable
BEFORE UPDATE ON evidence_runs
BEGIN
  SELECT RAISE(ABORT, 'evidence runs are immutable');
END;

CREATE TRIGGER evidence_items_immutable
BEFORE UPDATE ON evidence_items
BEGIN
  SELECT RAISE(ABORT, 'evidence items are immutable');
END;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY CHECK (id GLOB 'A-*'),
  schema_version INTEGER NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('review', 'analysis', 'discuss')),
  title TEXT,
  request TEXT,
  evidence_run_id TEXT NOT NULL REFERENCES evidence_runs (id),
  content_markdown TEXT,
  rendered_html TEXT,
  content_hash TEXT,
  generator_json TEXT NOT NULL,
  limitations_json TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'trashed', 'purged')),
  finalized_at TEXT NOT NULL,
  lifecycle_changed_at TEXT,
  purged_at TEXT,
  UNIQUE (id, evidence_run_id),
  CHECK ((content_markdown IS NULL) = (purged_at IS NOT NULL))
) STRICT;

CREATE INDEX artifacts_finalized_at ON artifacts (finalized_at);

-- Content is frozen. Lifecycle may change; content may only be removed by the purge transition.
CREATE TRIGGER artifacts_content_frozen
BEFORE UPDATE ON artifacts
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.intent IS NOT OLD.intent
  OR NEW.evidence_run_id IS NOT OLD.evidence_run_id
  OR NEW.generator_json IS NOT OLD.generator_json
  OR NEW.finalized_at IS NOT OLD.finalized_at
  OR (
    (
      NEW.title IS NOT OLD.title
      OR NEW.request IS NOT OLD.request
      OR NEW.content_markdown IS NOT OLD.content_markdown
      OR NEW.rendered_html IS NOT OLD.rendered_html
      OR NEW.content_hash IS NOT OLD.content_hash
      OR NEW.limitations_json IS NOT OLD.limitations_json
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
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact content is immutable');
END;

-- The composite keys make the database itself reject a handle from another evidence run.
CREATE TABLE artifact_citations (
  artifact_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  PRIMARY KEY (artifact_id, handle),
  FOREIGN KEY (artifact_id, run_id) REFERENCES artifacts (id, evidence_run_id),
  FOREIGN KEY (run_id, handle) REFERENCES evidence_items (run_id, handle)
) STRICT;

CREATE INDEX artifact_citations_item ON artifact_citations (run_id, handle);

CREATE TABLE artifact_links (
  parent_id TEXT NOT NULL REFERENCES artifacts (id),
  child_id TEXT NOT NULL REFERENCES artifacts (id),
  kind TEXT NOT NULL CHECK (kind IN ('derived_from', 'supersedes')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (parent_id, child_id, kind),
  CHECK (parent_id <> child_id)
) STRICT;

CREATE INDEX artifact_links_child ON artifact_links (child_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  operation TEXT NOT NULL,
  subject_ids TEXT NOT NULL,
  detail_json TEXT
) STRICT;

-- The single policy filter for default retrieval: every search, list, count, and evidence path uses it.
CREATE VIEW visible_sources AS
SELECT *
FROM sources
WHERE retention = 'retained' AND inclusion = 'included';
