import type { listSchedule, ScheduleEntry } from "../../app/schedule.js";
import { displayWidth, padDisplay } from "./width.js";

type Schedule = ReturnType<typeof listSchedule>;

export type ScheduleFormat = "table" | "md";

/** A day label in the user's language when known (e.g. "Mon, Sep 28"); the ISO date otherwise. */
function dayLabel(date: string, language: string | null, withYear: boolean): string {
  try {
    return new Intl.DateTimeFormat(language ?? "en", {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return date;
  }
}

function when(entry: ScheduleEntry, timezone: string): string {
  let text =
    entry.precision === "exact"
      ? `${entry.time}${entry.end_time !== null && (entry.end_date === null || entry.end_date === entry.date) ? `–${entry.end_time}` : ""}`
      : entry.precision === "part_of_day"
        ? (entry.part_of_day ?? "")
        : "all day";
  if (entry.precision !== "day" && entry.timezone !== timezone) {
    text += ` (${entry.timezone})`;
  }
  if (entry.end_date !== null && entry.end_date !== entry.date) {
    text += `, until ${entry.end_date}`;
  }
  return text;
}

function status(entry: ScheduleEntry): string {
  const parts = [
    entry.status === "cancelled" ? "cancelled" : entry.status === "moved" ? `moved → ${entry.moved_to}` : "",
    entry.stale ? "note corrected, not re-read yet" : "",
  ];
  return parts.filter((part) => part.length > 0).join("; ");
}

interface Column {
  header: string;
  values: string[];
}

/** One row per entry; the date only on the first row of each day. */
function columns(schedule: Schedule, options: { ids: boolean; markdown: boolean }): Column[] {
  const { events, range } = schedule;
  const multiYear = events.some((entry) => entry.date.slice(0, 4) !== schedule.today.slice(0, 4));
  const dates = events.map((entry, index) =>
    !options.markdown && index > 0 && events[index - 1]?.date === entry.date
      ? ""
      : `${dayLabel(entry.date, schedule.language, multiYear)}${entry.date === schedule.today ? " · today" : ""}`,
  );
  const result: Column[] = [
    { header: "Date", values: dates },
    { header: "Time", values: events.map((entry) => when(entry, range.timezone)) },
    { header: "What", values: events.map((entry) => entry.title) },
  ];
  const optional: Column[] = [
    { header: "Where", values: events.map((entry) => entry.location ?? "") },
    { header: "Repeats", values: events.map((entry) => entry.repeat ?? "") },
    { header: "Status", values: events.map(status) },
  ];
  result.push(...optional.filter((column) => column.values.some((value) => value.length > 0)));
  if (options.ids) {
    result.push(
      { header: "Note", values: events.map((entry) => entry.source_ref) },
      { header: "Event", values: events.map((entry) => entry.id) },
    );
  }
  return result;
}

function heading(schedule: Schedule): string {
  const { range } = schedule;
  const span = range.to === null ? `from ${range.from}` : `${range.from} – ${range.to}`;
  return `Schedule · ${span} · ${range.timezone}`;
}

function footer(schedule: Schedule): string {
  return `${schedule.total} entr${schedule.total === 1 ? "y" : "ies"}.`;
}

function table(schedule: Schedule, ids: boolean): string {
  const cols = columns(schedule, { ids, markdown: false });
  const widths = cols.map((column) => Math.max(displayWidth(column.header), ...column.values.map(displayWidth)));
  const row = (cells: string[]) =>
    cells
      .map((cell, index) => padDisplay(cell, widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  const lines = [
    row(cols.map((column) => column.header)),
    row(widths.map((width) => "─".repeat(width))),
    ...schedule.events.map((_, index) => row(cols.map((column) => column.values[index] ?? ""))),
  ];
  return [heading(schedule), "", ...lines, "", footer(schedule)].join("\n");
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function markdown(schedule: Schedule, ids: boolean): string {
  const cols = columns(schedule, { ids, markdown: true });
  const lines = [
    `| ${cols.map((column) => column.header).join(" | ")} |`,
    `|${cols.map(() => "---").join("|")}|`,
    ...schedule.events.map((_, index) => `| ${cols.map((column) => cell(column.values[index] ?? "")).join(" | ")} |`),
  ];
  return [`**${heading(schedule)}**`, "", ...lines, "", footer(schedule)].join("\n");
}

/** The built-in schedule templates: an aligned terminal table (default) or a Markdown table. */
export function renderSchedule(schedule: Schedule, options: { format?: ScheduleFormat; ids?: boolean } = {}): string {
  if (schedule.events.length === 0) {
    return `${options.format === "md" ? `**${heading(schedule)}**` : heading(schedule)}\n\nNothing scheduled.`;
  }
  return options.format === "md" ? markdown(schedule, options.ids === true) : table(schedule, options.ids === true);
}
