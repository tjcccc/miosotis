/**
 * Calendar arithmetic on local dates (YYYY-MM-DD) and IANA time zones, using only `Intl`. Schedule
 * entries keep the precision they were stated with; these helpers never invent a time of day.
 */

export const PARTS_OF_DAY = ["morning", "afternoon", "evening", "night"] as const;
export type PartOfDay = (typeof PARTS_OF_DAY)[number];

/** Used only to order and range-filter "morning"-style entries; never displayed as a time. */
const REPRESENTATIVE_TIME: Record<PartOfDay, string> = {
  morning: "09:00",
  afternoon: "14:00",
  evening: "19:00",
  night: "22:00",
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isClockTime(value: string): boolean {
  return TIME.test(value);
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parts(date: string): [number, number, number] {
  const match = DATE.exec(date);
  if (match === null) {
    throw new RangeError(`Not a date: ${date}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function format(year: number, month: number, day: number): string {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = parts(date);
  return format(year, month, day + days);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: string, to: string): number {
  const [a, b, c] = parts(from);
  const [x, y, z] = parts(to);
  return Math.round((Date.UTC(x, y - 1, z) - Date.UTC(a, b - 1, c)) / 86_400_000);
}

/** Same day of the month N months later, clamped to the month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = parts(date);
  const last = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return format(year, month + months, Math.min(day, last));
}

export function startOfMonth(date: string): string {
  const [year, month] = parts(date);
  return format(year, month, 1);
}

/** Milliseconds the zone is ahead of UTC at a given instant. */
function offset(instant: number, timeZone: string): number {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour),
    Number(fields.minute),
    Number(fields.second),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of a local wall-clock time in a zone (DST-aware). */
export function zonedToUtc(date: string, time: string, timeZone: string): number {
  const [year, month, day] = parts(date);
  const match = TIME.exec(time);
  if (match === null) {
    throw new RangeError(`Not a time: ${time}`);
  }
  const guess = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]));
  const first = guess - offset(guess, timeZone);
  return guess - offset(first, timeZone);
}

/** The local calendar date of an instant in a zone. */
export function localDate(instant: number, timeZone: string): string {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function representativeTime(partOfDay: PartOfDay): string {
  return REPRESENTATIVE_TIME[partOfDay];
}
