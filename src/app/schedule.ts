import { MiosotisError } from "../domain/errors.js";
import { formatSourceRef } from "../domain/ids.js";
import { describeRule, occurrences, type RepeatRule } from "../domain/recurrence.js";
import {
  addDays,
  addMonths,
  diffDays,
  isCalendarDate,
  localDate,
  representativeTime,
  startOfMonth,
  zonedToUtc,
} from "../domain/time.js";
import { liveEventCandidates, liveExceptions, liveReplacements } from "../infra/db/repos/events.js";
import type { AppContext } from "./context.js";

export interface ScheduleOptions {
  days?: number | undefined;
  months?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  past?: boolean | undefined;
  /** Also list cancelled and rescheduled entries (marked). */
  all?: boolean | undefined;
}

export interface ScheduleEntry {
  id: string;
  title: string;
  date: string;
  time: string | null;
  part_of_day: string | null;
  end_date: string | null;
  end_time: string | null;
  precision: "day" | "part_of_day" | "exact";
  timezone: string;
  location: string | null;
  /** For repeating entries: the rule in words (e.g. "every Monday"); each date is its own entry. */
  repeat: string | null;
  status: "scheduled" | "cancelled" | "moved";
  moved_to: string | null;
  source_ref: string;
  phrase: string | null;
  /** The Source was corrected and the correction has not been read yet; this entry is from before. */
  stale: boolean;
}

const MAX_DAYS = 3660;
const MAX_MONTHS = 120;

function checkDate(value: string, flag: string): string {
  if (!isCalendarDate(value)) {
    throw new MiosotisError("usage", `${flag} must be a date like 2026-10-01`);
  }
  return value;
}

/** The local date range [from, to) in the user's timezone; `to` null means open-ended. */
function resolveRange(today: string, options: ScheduleOptions): { from: string; to: string | null } {
  const byDates = options.from !== undefined || options.to !== undefined;
  const chosen = [byDates, options.days !== undefined, options.months !== undefined].filter(Boolean).length;
  if (chosen > 1) {
    throw new MiosotisError("usage", "Use one of --days, --months, or --from/--to");
  }
  if (byDates) {
    if (options.past === true) {
      throw new MiosotisError("usage", "--past works with --days or --months; with dates, give --from/--to directly");
    }
    const from = options.from === undefined ? today : checkDate(options.from, "--from");
    if (options.to === undefined) {
      return { from, to: null };
    }
    const to = checkDate(options.to, "--to");
    if (to < from) {
      throw new MiosotisError("usage", "--to is before --from");
    }
    return { from, to: addDays(to, 1) };
  }
  if (options.months !== undefined) {
    if (!Number.isInteger(options.months) || options.months < 0 || options.months > MAX_MONTHS) {
      throw new MiosotisError("usage", `--months must be a whole number from 0 to ${MAX_MONTHS}`);
    }
    if (options.months === 0) {
      const first = startOfMonth(today);
      return { from: first, to: addMonths(first, 1) };
    }
    return options.past === true
      ? { from: addMonths(today, -options.months), to: addDays(today, 1) }
      : { from: today, to: addMonths(today, options.months) };
  }
  const days = options.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new MiosotisError("usage", `--days must be a whole number from 1 to ${MAX_DAYS}`);
  }
  return options.past === true
    ? { from: addDays(today, -days), to: addDays(today, 1) }
    : { from: today, to: addDays(today, days) };
}

/** How far an open-ended range (`--from` without `--to`) expands repeating events. */
const OPEN_ENDED_DAYS = 366;

type Status = ScheduleEntry["status"];

/**
 * Lists schedule entries of visible Sources in a date range, from the database alone: no model call,
 * so it answers immediately. Default: the next 7 days including today, in the user's timezone.
 * Repeating events are expanded into their dates here; cancellations and replacements stated by live
 * notes decide each entry's status.
 */
export function listSchedule(context: AppContext, options: ScheduleOptions = {}) {
  const timezone = context.config.timezone;
  const today = localDate(context.now().getTime(), timezone);
  const range = resolveRange(today, options);
  const fromAt = zonedToUtc(range.from, "00:00", timezone);
  const toAt = range.to === null ? null : zonedToUtc(range.to, "00:00", timezone);
  const candidates = liveEventCandidates(context.db, {
    from: new Date(fromAt).toISOString(),
    to: toAt === null ? null : new Date(toAt).toISOString(),
  });
  const replacements = liveReplacements(context.db);
  const exceptions = liveExceptions(context.db);

  const statusOf = (eventId: string, date: string, repeating: boolean): { status: Status; movedTo: string | null } => {
    const cancelled = exceptions.some(
      (x) =>
        x.event_id === eventId &&
        (x.kind === "all" || (x.kind === "date" && x.date === date) || (x.kind === "from" && x.date <= date)),
    );
    if (cancelled) {
      return { status: "cancelled", movedTo: null };
    }
    const moved = replacements.findLast(
      (r) =>
        r.replaces === eventId &&
        (r.replaces_occurrence === null ? !repeating || r.start_date <= date : r.replaces_occurrence === date),
    );
    return moved === undefined ? { status: "scheduled", movedTo: null } : { status: "moved", movedTo: moved.id };
  };

  const entries: (ScheduleEntry & { at: number })[] = [];
  for (const row of candidates) {
    const base = {
      id: row.id,
      title: row.title,
      time: row.start_time,
      part_of_day: row.part_of_day,
      end_time: row.end_time,
      precision: row.precision,
      timezone: row.timezone,
      location: row.location,
      source_ref: formatSourceRef(row.source_id, row.version),
      phrase: row.phrase,
      stale: row.version < row.current_version,
    };
    const rule = row.repeat_json === null ? null : (JSON.parse(row.repeat_json) as RepeatRule);
    if (rule === null) {
      const { status, movedTo } = statusOf(row.id, row.start_date, false);
      entries.push({
        ...base,
        date: row.start_date,
        end_date: row.end_date,
        repeat: null,
        status,
        moved_to: movedTo,
        at: Date.parse(row.start_at),
      });
      continue;
    }
    // Occurrence dates are local to the event's zone; widen by a day, then filter on exact instants.
    const duration = Date.parse(row.until_at) - Date.parse(row.start_at);
    const span = row.end_date === null ? 0 : diffDays(row.start_date, row.end_date);
    const lastDate = range.to ?? addDays(range.from, OPEN_ENDED_DAYS);
    const clock = row.start_time ?? (row.part_of_day === null ? "00:00" : representativeTime(row.part_of_day));
    for (const date of occurrences(rule, row.start_date, addDays(range.from, -1 - span), addDays(lastDate, 1))) {
      const startAt = zonedToUtc(date, clock, row.timezone);
      const untilAt = startAt + duration;
      if (
        !(
          (untilAt > fromAt || startAt >= fromAt) &&
          (toAt === null ? startAt < zonedToUtc(lastDate, "00:00", timezone) : startAt < toAt)
        )
      ) {
        continue;
      }
      const { status, movedTo } = statusOf(row.id, date, true);
      entries.push({
        ...base,
        date,
        end_date: row.end_date === null ? null : addDays(date, span),
        repeat: describeRule(rule),
        status,
        moved_to: movedTo,
        at: startAt,
      });
    }
  }
  const events: ScheduleEntry[] = entries
    .filter((entry) => options.all === true || entry.status === "scheduled")
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map(({ at: _at, ...entry }) => entry);
  return {
    range: {
      from: range.from,
      to: range.to === null ? null : addDays(range.to, -1),
      timezone,
      past: options.past === true,
    },
    today,
    /** The user's preferred language (BCP-47), for dates in the built-in template. */
    language: context.config.language ?? null,
    total: events.length,
    events,
  };
}
