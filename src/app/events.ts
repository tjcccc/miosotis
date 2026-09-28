import type { CancelInput, EventInput, RepeatInput } from "../contracts/enrichment.js";
import { MiosotisError } from "../domain/errors.js";
import { assertId, isId, newId } from "../domain/ids.js";
import { firstOccurrence, isOccurrence, isoWeekday, type RepeatRule, WEEKDAYS } from "../domain/recurrence.js";
import {
  addDays,
  diffDays,
  isCalendarDate,
  isTimeZone,
  type PartOfDay,
  representativeTime,
  zonedToUtc,
} from "../domain/time.js";
import { type EventRow, type ExceptionKind, getEvent, insertEvent, insertException } from "../infra/db/repos/events.js";
import type { AppContext } from "./context.js";

type EventRequest = ReturnType<typeof EventInput.parse>;
type RepeatRequest = ReturnType<typeof RepeatInput.parse>;
type CancelRequest = ReturnType<typeof CancelInput.parse>;

interface Owner {
  sourceId: string;
  version: number;
  derivationId: string;
  timezone: string;
  text: string;
  at: string;
}

function requireDate(value: string, label: string): string {
  if (!isCalendarDate(value)) {
    throw new MiosotisError("validation", `${label} ${value} is not a real calendar date`);
  }
  return value;
}

function weekdayNumber(name: (typeof WEEKDAYS)[number]): number {
  return WEEKDAYS.indexOf(name) + 1;
}

/** Validates a repeat rule and fills its defaults from the start date. */
function normalizeRule(input: RepeatRequest, startDate: string): RepeatRule {
  if (input.every !== "week" && input.on !== undefined) {
    throw new MiosotisError("validation", "repeat.on applies only to weekly rules");
  }
  if (input.every !== "month" && (input.month_day !== undefined || input.month_weekday !== undefined)) {
    throw new MiosotisError("validation", "repeat.month_day and repeat.month_weekday apply only to monthly rules");
  }
  if (input.month_day !== undefined && input.month_weekday !== undefined) {
    throw new MiosotisError("validation", "A monthly rule has a month_day or a month_weekday, not both");
  }
  if (input.until !== undefined && input.count !== undefined) {
    throw new MiosotisError("validation", "A repeat rule ends by until or by count, not both");
  }
  const until = input.until === undefined ? null : requireDate(input.until, "repeat.until");
  if (until !== null && until < startDate) {
    throw new MiosotisError("validation", "repeat.until is before the start date");
  }
  const byWeekday = input.month_weekday;
  return {
    every: input.every,
    interval: input.interval,
    weekdays:
      input.every === "week"
        ? [...new Set((input.on ?? []).map(weekdayNumber))]
            .sort((a, b) => a - b)
            .concat(input.on === undefined ? [isoWeekday(startDate)] : [])
        : [],
    month_day:
      input.every === "month" && byWeekday === undefined ? (input.month_day ?? Number(startDate.slice(8, 10))) : null,
    nth: byWeekday?.nth ?? null,
    weekday: byWeekday === undefined ? null : weekdayNumber(byWeekday.weekday),
    until,
    count: input.count ?? null,
  };
}

function ruleOf(event: EventRow): RepeatRule | null {
  return event.repeat_json === null ? null : (JSON.parse(event.repeat_json) as RepeatRule);
}

function requireEvent(context: AppContext, raw: string, field: string): EventRow {
  const id = raw.trim().toUpperCase();
  const event = isId("event", id) ? getEvent(context.db, id) : undefined;
  if (event === undefined) {
    throw new MiosotisError("validation", `${field} names ${raw}, which is not a known event`);
  }
  return event;
}

function requireOccurrence(event: EventRow, date: string, field: string): void {
  const rule = ruleOf(event);
  if (rule === null) {
    throw new MiosotisError("validation", `${field}: ${event.id} does not repeat, so it has no single dates`);
  }
  if (!isOccurrence(rule, event.start_date, requireDate(date, field))) {
    throw new MiosotisError("validation", `${field}: ${date} is not a date of ${event.id}`);
  }
}

/**
 * Turns a host-submitted event into a stored row. The stated precision is kept: a "morning" stays a
 * morning (ordered with a representative hour that is never shown), and a date without a time is a
 * whole-day entry. A repeating event is stored once, starting at its first occurrence.
 */
function normalize(context: AppContext, input: EventRequest, owner: Owner): { row: EventRow; warning: string | null } {
  const timezone = input.timezone ?? owner.timezone;
  if (!isTimeZone(timezone)) {
    throw new MiosotisError("validation", `Unknown IANA timezone: ${timezone}`);
  }
  let startDate = requireDate(input.start.date, "start.date");
  if (input.start.time !== undefined && input.start.part_of_day !== undefined) {
    throw new MiosotisError("validation", "An event start has a time or a part_of_day, not both");
  }
  const span = input.end?.date === undefined ? 0 : diffDays(startDate, requireDate(input.end.date, "end.date"));
  if (span < 0) {
    throw new MiosotisError("validation", `The event "${input.title}" ends before it starts`);
  }
  let rule: RepeatRule | null = null;
  if (input.repeat !== undefined) {
    rule = normalizeRule(input.repeat, startDate);
    const first = firstOccurrence(rule, startDate);
    if (first === null) {
      throw new MiosotisError("validation", `The repeat rule of "${input.title}" never occurs`);
    }
    startDate = first;
  }
  const endDate = input.end?.date === undefined ? null : addDays(startDate, span);
  const precision =
    input.start.time !== undefined ? "exact" : input.start.part_of_day !== undefined ? "part_of_day" : "day";
  const partOfDay = (input.start.part_of_day ?? null) as PartOfDay | null;
  const startClock = input.start.time ?? (partOfDay === null ? "00:00" : representativeTime(partOfDay));
  const startAt = zonedToUtc(startDate, startClock, timezone);
  let untilAt: number;
  if (input.end?.time !== undefined) {
    untilAt = zonedToUtc(endDate ?? startDate, input.end.time, timezone);
  } else if (endDate !== null) {
    untilAt = zonedToUtc(addDays(endDate, 1), "00:00", timezone);
  } else {
    untilAt = precision === "day" ? zonedToUtc(addDays(startDate, 1), "00:00", timezone) : startAt;
  }
  if (untilAt < startAt) {
    throw new MiosotisError("validation", `The event "${input.title}" ends before it starts`);
  }
  let replaces: string | null = null;
  if (input.replaces !== undefined) {
    const target = requireEvent(context, input.replaces, "replaces");
    replaces = assertId("event", target.id);
    if (input.occurrence !== undefined) {
      requireOccurrence(target, input.occurrence, "occurrence");
    }
  } else if (input.occurrence !== undefined) {
    throw new MiosotisError("validation", "occurrence is only meaningful together with replaces");
  }
  const phraseFound = input.phrase === undefined || owner.text.includes(input.phrase);
  return {
    row: {
      id: newId("event", context.now().getTime()),
      source_id: owner.sourceId,
      version: owner.version,
      derivation_id: owner.derivationId,
      title: input.title,
      start_date: startDate,
      start_time: input.start.time ?? null,
      part_of_day: partOfDay,
      end_date: endDate,
      end_time: input.end?.time ?? null,
      precision,
      timezone,
      location: input.location ?? null,
      phrase: phraseFound ? (input.phrase ?? null) : null,
      replaces,
      replaces_occurrence: input.occurrence ?? null,
      repeat_json: rule === null ? null : JSON.stringify(rule),
      start_at: new Date(startAt).toISOString(),
      until_at: new Date(untilAt).toISOString(),
      created_at: owner.at,
    },
    warning: phraseFound ? null : `event phrase ${JSON.stringify(input.phrase)} is not in the source text; not stored`,
  };
}

/** A cancellation: the whole event, one date of a series, or a series from a date on. */
function normalizeCancel(
  context: AppContext,
  input: CancelRequest,
): { eventId: string; kind: ExceptionKind; date: string | null } {
  if (typeof input === "string") {
    return { eventId: requireEvent(context, input, "cancels").id, kind: "all", date: null };
  }
  const event = requireEvent(context, input.event, "cancels");
  if (input.date !== undefined && input.from !== undefined) {
    throw new MiosotisError("validation", "A cancellation names a date or a from date, not both");
  }
  if (input.date !== undefined) {
    if (event.repeat_json === null && input.date === event.start_date) {
      return { eventId: event.id, kind: "all", date: null };
    }
    requireOccurrence(event, input.date, "cancels.date");
    return { eventId: event.id, kind: "date", date: input.date };
  }
  if (input.from !== undefined) {
    if (event.repeat_json === null) {
      throw new MiosotisError("validation", `cancels.from: ${event.id} does not repeat; cancel it as a whole`);
    }
    return { eventId: event.id, kind: "from", date: requireDate(input.from, "cancels.from") };
  }
  return { eventId: event.id, kind: "all", date: null };
}

/** Stores the events and cancellations of one enrichment (inside its transaction). */
export function storeEvents(
  context: AppContext,
  request: { events: EventRequest[]; cancels: CancelRequest[] },
  owner: Owner,
): {
  events: { id: string; title: string; start_date: string; precision: string; repeats: boolean }[];
  cancelled: { event: string; kind: ExceptionKind; date: string | null }[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const stored: { id: string; title: string; start_date: string; precision: string; repeats: boolean }[] = [];
  for (const input of request.events) {
    const { row, warning } = normalize(context, input, owner);
    insertEvent(context.db, row);
    stored.push({
      id: row.id,
      title: row.title,
      start_date: row.start_date,
      precision: row.precision,
      repeats: row.repeat_json !== null,
    });
    if (warning !== null) {
      warnings.push(warning);
    }
  }
  const cancelled: { event: string; kind: ExceptionKind; date: string | null }[] = [];
  for (const input of request.cancels) {
    const exception = normalizeCancel(context, input);
    insertException(context.db, { derivationId: owner.derivationId, ...exception });
    cancelled.push({ event: exception.eventId, kind: exception.kind, date: exception.date });
  }
  return { events: stored, cancelled, warnings };
}
