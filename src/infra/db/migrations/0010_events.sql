-- Schedule entries: dated arrangements a Source states, extracted by the AI host as part of
-- enrichment. The Source keeps the user's words; an event is derived data bound to the enrichment
-- that produced it. Which events are current (not replaced or cancelled) is computed at read time
-- from visible Sources, so remove, restore, and correction stay consistent without rewriting rows.
CREATE TABLE events (
  id TEXT PRIMARY KEY CHECK (id GLOB 'V-*'),
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  derivation_id TEXT NOT NULL REFERENCES derived_records (id),
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  start_time TEXT,
  part_of_day TEXT CHECK (part_of_day IN ('morning', 'afternoon', 'evening', 'night')),
  end_date TEXT,
  end_time TEXT,
  precision TEXT NOT NULL CHECK (precision IN ('day', 'part_of_day', 'exact')),
  timezone TEXT NOT NULL,
  location TEXT,
  phrase TEXT,
  replaces TEXT,
  -- UTC instants for ordering and range queries (a part of day uses a fixed representative hour).
  start_at TEXT NOT NULL,
  until_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id, version) REFERENCES source_versions (source_id, version),
  CHECK (until_at >= start_at)
) STRICT;

CREATE INDEX events_start ON events (start_at);
CREATE INDEX events_derivation ON events (derivation_id);
CREATE INDEX events_replaces ON events (replaces);

CREATE TABLE event_cancellations (
  derivation_id TEXT NOT NULL REFERENCES derived_records (id),
  event_id TEXT NOT NULL,
  PRIMARY KEY (derivation_id, event_id)
) STRICT;

CREATE INDEX event_cancellations_event ON event_cancellations (event_id);
