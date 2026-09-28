-- Repeating schedule entries. An event may carry a repeat rule (JSON, normalized by the core) and is
-- expanded into dates at read time; nothing per occurrence is stored unless the user changed it.
-- A later event may replace one occurrence (`replaces_occurrence`) or, without it, the rest of a
-- series from its own start date. Exceptions generalize cancellations: a whole event, one date, or
-- every date from a given one on. As before, only exceptions from live enrichments count.
ALTER TABLE events ADD COLUMN repeat_json TEXT;
ALTER TABLE events ADD COLUMN replaces_occurrence TEXT;

CREATE TABLE event_exceptions (
  derivation_id TEXT NOT NULL REFERENCES derived_records (id),
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('all', 'date', 'from')),
  date TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (derivation_id, event_id, kind, date),
  CHECK ((kind = 'all') = (date = ''))
) STRICT;

CREATE INDEX event_exceptions_event ON event_exceptions (event_id);

INSERT INTO event_exceptions (derivation_id, event_id, kind, date)
SELECT derivation_id, event_id, 'all', '' FROM event_cancellations;

DROP TABLE event_cancellations;
