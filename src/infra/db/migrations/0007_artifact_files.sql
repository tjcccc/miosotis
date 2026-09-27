-- Files that belong to an artifact (host-built decks, PDFs, images). Frozen with the artifact.
CREATE TABLE artifact_files (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  blob_sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'supporting')),
  PRIMARY KEY (artifact_id, ordinal)
) STRICT;

CREATE INDEX artifact_files_blob ON artifact_files (blob_sha256);

CREATE TRIGGER artifact_files_immutable BEFORE UPDATE ON artifact_files
BEGIN
  SELECT RAISE(ABORT, 'artifact files are immutable');
END;
