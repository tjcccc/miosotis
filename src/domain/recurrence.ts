/**
 * Repeating schedule rules and their expansion into dates. A deliberately small subset of calendar
 * recurrence: every N days, weeks (on chosen weekdays), or months (on a day number or an nth weekday),
 * ending on a date, after a count, or never.
 */
import { addDays, addMonths } from "./time.js";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface RepeatRule {
  every: "day" | "week" | "month";
  interval: number;
  /** ISO weekday numbers, 1 = Monday … 7 = Sunday (weekly rules). */
  weekdays: number[];
  /** Day of the month, or -1 for the last day (monthly rules by day). */
  month_day: number | null;
  /** The nth (1–5, or -1 = last) weekday of the month (monthly rules by weekday). */
  nth: number | null;
  weekday: number | null;
  until: string | null;
  count: number | null;
}

/** Hard stop for expansion, so a daily rule over a long range stays cheap. */
const MAX_STEPS = 20_000;

function dateParts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return [year, month, day];
}

/** ISO weekday of a date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [year, month, day] = dateParts(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The date of the rule's day in one month, or null when that month has no such day. */
function monthlyDate(rule: RepeatRule, year: number, month: number): string | null {
  const length = daysInMonth(year, month);
  if (rule.month_day !== null) {
    const day = rule.month_day === -1 ? length : rule.month_day;
    return day <= length ? `${year}-${pad(month)}-${pad(day)}` : null;
  }
  if (rule.nth === null || rule.weekday === null) {
    return null;
  }
  const firstWeekday = isoWeekday(`${year}-${pad(month)}-01`);
  const first = 1 + ((rule.weekday - firstWeekday + 7) % 7);
  let day: number;
  if (rule.nth === -1) {
    day = first + 7 * Math.floor((length - first) / 7);
  } else {
    day = first + 7 * (rule.nth - 1);
  }
  return day <= length ? `${year}-${pad(month)}-${pad(day)}` : null;
}

/**
 * Every occurrence date on or after `start` in [from, to), in order. `start` is the first possible
 * date (usually the first occurrence); `count` counts occurrences from `start`, not from `from`.
 */
export function occurrences(rule: RepeatRule, start: string, from: string, to: string): string[] {
  const result: string[] = [];
  let seen = 0;
  const done = (date: string) =>
    date >= to || (rule.until !== null && date > rule.until) || (rule.count !== null && seen >= rule.count);
  const take = (date: string): boolean => {
    if (date < start) {
      return true;
    }
    if (done(date)) {
      return false;
    }
    seen += 1;
    if (date >= from) {
      result.push(date);
    }
    return true;
  };
  if (rule.every === "day") {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (!take(addDays(start, step * rule.interval))) {
        break;
      }
    }
  } else if (rule.every === "week") {
    const weekStart = addDays(start, 1 - isoWeekday(start));
    const days = [...rule.weekdays].sort((a, b) => a - b);
    outer: for (let week = 0; week < MAX_STEPS; week += rule.interval) {
      for (const weekday of days) {
        if (!take(addDays(weekStart, week * 7 + weekday - 1))) {
          break outer;
        }
      }
    }
  } else {
    const [year, month] = dateParts(start);
    for (let step = 0; step < MAX_STEPS; step += rule.interval) {
      const anchor = addMonths(`${year}-${pad(month)}-01`, step);
      const [y, m] = dateParts(anchor);
      if (anchor >= to || (rule.until !== null && anchor > rule.until)) {
        break;
      }
      const date = monthlyDate(rule, y, m);
      if (date !== null && !take(date)) {
        break;
      }
      if (rule.count !== null && seen >= rule.count) {
        break;
      }
    }
  }
  return result;
}

/** The first occurrence on or after `start`, or null if the rule never occurs (e.g. already ended). */
export function firstOccurrence(rule: RepeatRule, start: string): string | null {
  return occurrences(rule, start, start, addDays(start, 800))[0] ?? null;
}

export function isOccurrence(rule: RepeatRule, start: string, date: string): boolean {
  return occurrences(rule, start, date, addDays(date, 1)).includes(date);
}

const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ORDINAL: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last" };

/** A short description such as "every Monday", "every 2 weeks on Mon, Thu", "every month on the 15th". */
export function describeRule(rule: RepeatRule): string {
  const every = (unit: string) => (rule.interval === 1 ? `every ${unit}` : `every ${rule.interval} ${unit}s`);
  let text: string;
  if (rule.every === "day") {
    text = every("day");
  } else if (rule.every === "week") {
    const names = rule.weekdays.map((day) => (rule.weekdays.length === 1 ? LONG : SHORT)[day - 1]);
    text =
      rule.interval === 1 && rule.weekdays.length === 1
        ? `every ${names[0]}`
        : `${every("week")} on ${names.join(", ")}`;
  } else if (rule.month_day !== null) {
    text = `${every("month")} on ${rule.month_day === -1 ? "the last day" : `day ${rule.month_day}`}`;
  } else {
    text = `${every("month")} on the ${ORDINAL[rule.nth ?? 1]} ${LONG[(rule.weekday ?? 1) - 1]}`;
  }
  if (rule.until !== null) {
    text += ` until ${rule.until}`;
  } else if (rule.count !== null) {
    text += `, ${rule.count} times`;
  }
  return text;
}
