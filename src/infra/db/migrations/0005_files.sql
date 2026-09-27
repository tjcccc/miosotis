-- Files: a content-addressed blob store shared by inputs (attachments) and derived data.
-- Blob identity is the SHA-256 of the bytes; original filenames live on the references.

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  mime TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- Original bytes of a source revision. A `file` Source's revision has empty content_text and one
-- `original` payload; its content_digest is `sha256:<blob>`.
CREATE TABLE version_payloads (
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  blob_sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  role TEXT NOT NULL CHECK (role IN ('original', 'attachment')),
  filename TEXT,
  mime TEXT NOT NULL,
  PRIMARY KEY (source_id, version, ordinal),
  FOREIGN KEY (source_id, version) REFERENCES source_versions (source_id, version)
) STRICT;

CREATE INDEX version_payloads_blob ON version_payloads (blob_sha256);

CREATE TRIGGER version_payloads_immutable
BEFORE UPDATE ON version_payloads
BEGIN
  SELECT RAISE(ABORT, 'payload references are immutable');
END;

-- A few typed links, e.g. the user's comment -> the files saved with it. Not a graph subsystem.
CREATE TABLE source_links (
  from_source TEXT NOT NULL REFERENCES sources (id),
  to_source TEXT NOT NULL REFERENCES sources (id),
  kind TEXT NOT NULL CHECK (kind IN ('references', 'supersedes')),
  origin TEXT NOT NULL CHECK (origin IN ('user', 'agent', 'system')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_source, to_source, kind),
  CHECK (from_source <> to_source)
) STRICT;

CREATE INDEX source_links_to ON source_links (to_source);

-- Large derived content (extracted text) lives in the blob store; interpretations name the payload.
ALTER TABLE derived_records ADD COLUMN content_blob TEXT REFERENCES blobs (sha256);
ALTER TABLE derived_records ADD COLUMN payload_sha256 TEXT;

-- Chunks over extracted text (a file has no content_text offsets).
CREATE TABLE derived_chunks (
  derivation_id TEXT NOT NULL REFERENCES derived_records (id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL,
  locator_json TEXT,
  PRIMARY KEY (derivation_id, ordinal),
  CHECK (end_offset > start_offset)
) STRICT;

-- Evidence may pin a span of extracted text (derivation_id) or a whole payload (locator_json
-- {"payload_sha256": …}; offsets are then 0..1 and ignored).
ALTER TABLE evidence_items ADD COLUMN derivation_id TEXT REFERENCES derived_records (id);
ALTER TABLE evidence_items ADD COLUMN locator_json TEXT;
