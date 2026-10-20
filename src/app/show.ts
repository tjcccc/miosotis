import { MiosotisError } from "../domain/errors.js";
import { isId } from "../domain/ids.js";
import { addDays, isCalendarDate, localDate, zonedToUtc } from "../domain/time.js";
import { readableText } from "./content.js";
import type { AppContext } from "./context.js";
import { search } from "./search.js";
import { getSourceView, listSourceViews } from "./sources.js";

/** Characters of a note's first line shown in a list. */
const PREVIEW_CHARS = 100;

export interface ShowOptions {
  /** One `S-…` reference opens that note; any other words search; none lists recent notes. */
  words?: string[] | undefined;
  project?: string | undefined;
  today?: boolean | undefined;
  /** The last N days, including today. */
  days?: number | undefined;
  /** Local dates (YYYY-MM-DD), inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/**
 * `miosotis show`: look back at what was saved, without a model. It reuses the read paths the AI
 * host uses (`source get`, `source list`, `search`) and only adds local-time windows and previews.
 * Ignored and trashed notes stay out of lists and searches, as in `source list`.
 */
export function showLibrary(context: AppContext, options: ShowOptions = {}) {
  const words = (options.words ?? []).filter((word) => word.trim() !== "");
  const window = resolveWindow(context, options);
  if (words.length === 1 && isSourceRef(words[0] ?? "")) {
    if (window !== null || options.project !== undefined) {
      throw new MiosotisError("usage", "A note ID opens that note; leave out --project and the date options");
    }
    return {
      view: "source" as const,
      timezone: context.config.timezone,
      source: getSourceView(context, words[0] ?? ""),
    };
  }
  if (words.length > 0) {
    if (window !== null) {
      throw new MiosotisError("usage", "Searching does not filter by date; show by date without search words");
    }
    const result = search(context, {
      query: words.join(" "),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
    return { view: "search" as const, timezone: context.config.timezone, ...result };
  }
  const page = listSourceViews(context, {
    project: options.project,
    since: window?.since,
    until: window?.until,
    limit: options.limit ?? 20,
    cursor: options.cursor,
  });
  return {
    view: "list" as const,
    timezone: context.config.timezone,
    window: window === null ? null : { from: window.from, to: window.to },
    total: page.total,
    next_cursor: page.next_cursor,
    notes: page.sources.map((row) => ({ ...row, preview: preview(context, row.id, row.ref) })),
  };
}

export type ShowResult = ReturnType<typeof showLibrary>;

function isSourceRef(word: string): boolean {
  const match = /^(S-[0-9A-Z]{26})(?:@v\d+)?$/i.exec(word.trim());
  return match !== null && isId("source", (match[1] ?? "").toUpperCase());
}

/** The first non-empty line of the note's readable text, for notes that have no title yet. */
function preview(context: AppContext, id: string, ref: string): string | null {
  const version = Number(ref.slice(ref.lastIndexOf("@v") + 2));
  const line = readableText(context, id, version)
    .text.split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");
  if (line === undefined) {
    return null;
  }
  const chars = Array.from(line);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("")}…` : line;
}

/** Local dates [from, to] in the user's timezone, as UTC instants [since, until). */
function resolveWindow(
  context: AppContext,
  options: ShowOptions,
): { from: string | null; to: string | null; since: string | undefined; until: string | undefined } | null {
  const byDates = options.from !== undefined || options.to !== undefined;
  const chosen = [options.today === true, options.days !== undefined, byDates].filter(Boolean).length;
  if (chosen === 0) {
    return null;
  }
  if (chosen > 1) {
    throw new MiosotisError("usage", "Use one of --today, --days, or --from/--to");
  }
  const timezone = context.config.timezone;
  const today = localDate(context.now().getTime(), timezone);
  let from: string | null;
  let to: string | null;
  if (options.today === true) {
    from = today;
    to = today;
  } else if (options.days !== undefined) {
    if (!Number.isInteger(options.days) || options.days < 1) {
      throw new MiosotisError("usage", "--days must be a whole number of at least 1");
    }
    from = addDays(today, 1 - options.days);
    to = today;
  } else {
    from = options.from === undefined ? null : checkDate(options.from, "--from");
    to = options.to === undefined ? null : checkDate(options.to, "--to");
    if (from !== null && to !== null && to < from) {
      throw new MiosotisError("usage", "--to is before --from");
    }
  }
  const startOf = (date: string) => new Date(zonedToUtc(date, "00:00", timezone)).toISOString();
  return {
    from,
    to,
    since: from === null ? undefined : startOf(from),
    until: to === null ? undefined : startOf(addDays(to, 1)),
  };
}

function checkDate(value: string, label: string): string {
  if (!isCalendarDate(value)) {
    throw new MiosotisError("usage", `${label} must be a date (YYYY-MM-DD)`);
  }
  return value;
}
