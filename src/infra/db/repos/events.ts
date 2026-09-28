import type { Database } from "../database.js";

export interface EventRow {
  id: string;
  source_id: string;
  version: number;
  derivation_id: string;
  title: string;
  start_date: string;
  start_time: string | null;
  part_of_day: "morning" | "afternoon" | "evening" | "night" | null;
  end_date: string | null;
  end_time: string | null;
  precision: "day" | "part_of_day" | "exact";
  timezone: string;
  location: string | null;
  phrase: string | null;
  replaces: string | null;
  replaces_occurrence: string | null;
  /** Normalized repeat rule (JSON), or null for a one-time event. */
  repeat_json: string | null;
  start_at: string;
  until_at: string;
  created_at: string;
}

export interface LiveEventRow extends EventRow {
  current_version: number;
}

export type ExceptionKind = "all" | "date" | "from";

export function insertEvent(db: Database, row: EventRow): void {
  db.run(
    `INSERT INTO events (id, source_id, version, derivation_id, title, start_date, start_time, part_of_day, end_date,
       end_time, precision, timezone, location, phrase, replaces, replaces_occurrence, repeat_json, start_at, until_at,
       created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.source_id,
      row.version,
      row.derivation_id,
      row.title,
      row.start_date,
      row.start_time,
      row.part_of_day,
      row.end_date,
      row.end_time,
      row.precision,
      row.timezone,
      row.location,
      row.phrase,
      row.replaces,
      row.replaces_occurrence,
      row.repeat_json,
      row.start_at,
      row.until_at,
      row.created_at,
    ],
  );
}

export function insertException(
  db: Database,
  exception: { derivationId: string; eventId: string; kind: ExceptionKind; date: string | null },
): void {
  db.run("INSERT OR IGNORE INTO event_exceptions (derivation_id, event_id, kind, date) VALUES (?, ?, ?, ?)", [
    exception.derivationId,
    exception.eventId,
    exception.kind,
    exception.date ?? "",
  ]);
}

export function getEvent(db: Database, id: string): EventRow | undefined {
  return db.get<EventRow>("SELECT * FROM events WHERE id = ?", [id]);
}

/**
 * The live enrichment of each visible Source: the active enrichment of its newest enriched revision.
 * Events, replacements, and exceptions from other enrichments (superseded, older revisions, hidden
 * Sources) do not count.
 */
const LIVE = `
  live AS (
    SELECT d.id AS derivation_id, d.source_id, s.current_version
    FROM derived_records d JOIN visible_sources s ON s.id = d.source_id
    WHERE d.kind = 'enrichment' AND d.superseded_by IS NULL AND d.purged_at IS NULL
      AND d.version = (
        SELECT max(x.version) FROM derived_records x
        WHERE x.source_id = d.source_id AND x.kind = 'enrichment' AND x.superseded_by IS NULL AND x.purged_at IS NULL
      )
  ),
  live_events AS (
    SELECT e.*, l.current_version FROM events e JOIN live l ON l.derivation_id = e.derivation_id
  )`;

/**
 * Live events that may fall in [from, to): one-time events overlapping the range, and every repeating
 * event that started before its end (the caller expands and filters occurrences).
 */
export function liveEventCandidates(db: Database, range: { from: string; to: string | null }): LiveEventRow[] {
  const params: string[] = [range.from, range.from];
  let upper = "";
  if (range.to !== null) {
    upper = "AND le.start_at < ?";
    params.push(range.to);
  }
  return db.all<LiveEventRow>(
    `WITH ${LIVE}
     SELECT le.* FROM live_events le
     WHERE (le.repeat_json IS NOT NULL OR le.until_at > ? OR le.start_at >= ?) ${upper}
     ORDER BY le.start_at, le.id`,
    params,
  );
}

/** Live events that replace another event (or one date of a series). */
export function liveReplacements(db: Database) {
  return db.all<{ id: string; replaces: string; replaces_occurrence: string | null; start_date: string }>(
    `WITH ${LIVE}
     SELECT le.id, le.replaces, le.replaces_occurrence, le.start_date FROM live_events le
     WHERE le.replaces IS NOT NULL ORDER BY le.created_at, le.id`,
  );
}

/** Cancellations stated by live enrichments. */
export function liveExceptions(db: Database) {
  return db.all<{ event_id: string; kind: ExceptionKind; date: string; source_id: string }>(
    `WITH ${LIVE}
     SELECT x.event_id, x.kind, x.date, l.source_id FROM event_exceptions x
     JOIN live l ON l.derivation_id = x.derivation_id`,
  );
}

/** Live events of the given Sources (for export). */
export function eventsOfSources(db: Database, sourceIds: string[]): EventRow[] {
  if (sourceIds.length === 0) {
    return [];
  }
  return db.all<EventRow>(
    `WITH ${LIVE}
     SELECT le.* FROM live_events le WHERE le.source_id IN (${sourceIds.map(() => "?").join(", ")})
     ORDER BY le.start_at, le.id`,
    sourceIds,
  );
}

/** Permanent deletion: a Source's events, and exceptions it stated or that point at its events. */
export function deleteEventsOfSource(db: Database, sourceId: string): void {
  db.run(
    `DELETE FROM event_exceptions
     WHERE derivation_id IN (SELECT id FROM derived_records WHERE source_id = ?)
        OR event_id IN (SELECT id FROM events WHERE source_id = ?)`,
    [sourceId, sourceId],
  );
  db.run("DELETE FROM events WHERE source_id = ?", [sourceId]);
}
