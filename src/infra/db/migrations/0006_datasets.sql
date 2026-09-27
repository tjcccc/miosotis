-- Datasets: immutable, citable results of deterministic table queries over host-extracted tables.
-- The spec, the exact inputs (source revision + extraction), and the result are frozen together.
CREATE TABLE datasets (
  id TEXT PRIMARY KEY CHECK (id GLOB 'T-*'),
  spec_json TEXT NOT NULL,
  result_blob TEXT NOT NULL REFERENCES blobs (sha256),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  warnings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE dataset_inputs (
  dataset_id TEXT NOT NULL REFERENCES datasets (id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  derivation_id TEXT NOT NULL REFERENCES derived_records (id),
  table_name TEXT NOT NULL,
  PRIMARY KEY (dataset_id, ordinal),
  FOREIGN KEY (source_id, version) REFERENCES source_versions (source_id, version)
) STRICT;

CREATE TRIGGER datasets_immutable BEFORE UPDATE ON datasets
BEGIN
  SELECT RAISE(ABORT, 'datasets are immutable');
END;

CREATE TRIGGER dataset_inputs_immutable BEFORE UPDATE ON dataset_inputs
BEGIN
  SELECT RAISE(ABORT, 'dataset inputs are immutable');
END;
