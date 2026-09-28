import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/app/capture.js";
import { applyEnrichment, prepareEnrichment } from "../../src/app/enrich.js";
import { changeSourcePolicy, correctSource } from "../../src/app/governance.js";
import { listSchedule } from "../../src/app/schedule.js";
import { renderSchedule } from "../../src/cli/templates/schedule.js";
import { displayWidth } from "../../src/cli/templates/width.js";
import type { CancelRequestInput, EventRequestInput } from "../../src/contracts/enrichment.js";
import { cli, createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

// Monday 2026-09-28, 10:00 in Shanghai.
const NOW = new Date("2026-09-28T02:00:00.000Z");

beforeEach(() => {
  library = createTestLibrary({ now: () => NOW, timezone: "Asia/Shanghai" });
});

afterEach(() => library.cleanup());

type EventRequest = EventRequestInput;

/** Saves the user's words, then enriches them with events as the AI host would. */
function saveWithEvents(text: string, events: EventRequest[], cancels: CancelRequestInput[] = []) {
  const id = capture(library.context, { text }).sources[0]?.id ?? "";
  const receipt = applyEnrichment(library.context, {
    source_ref: prepareEnrichment(library.context, id).source_ref,
    title: text.slice(0, 60),
    events,
    cancels,
  });
  return { id, receipt, eventIds: receipt.events.map((event) => event.id) };
}

function titles(options: Parameters<typeof listSchedule>[1] = {}) {
  return listSchedule(library.context, options).events.map((entry) => entry.title);
}

describe("schedule", () => {
  it("keeps the note, stores the event with its stated precision, and lists it by range", () => {
    const meeting = saveWithEvents("Next Monday morning I have a meeting about miosotis in the Tokyo room.", [
      {
        title: "Meeting about miosotis",
        start: { date: "2026-10-05", part_of_day: "morning" },
        location: "Tokyo room",
        phrase: "Next Monday morning",
      },
    ]);
    saveWithEvents("Dentist today at 18:00 until 19:00.", [
      { title: "Dentist", start: { date: "2026-09-28", time: "18:00" }, end: { time: "19:00" } },
    ]);
    saveWithEvents("Trip to Osaka from Thursday to Saturday.", [
      { title: "Trip to Osaka", start: { date: "2026-10-01" }, end: { date: "2026-10-03" } },
    ]);
    expect(meeting.receipt.events).toMatchObject([{ title: "Meeting about miosotis", precision: "part_of_day" }]);

    expect(titles()).toEqual(["Dentist", "Trip to Osaka"]);
    expect(titles({ days: 14 })).toEqual(["Dentist", "Trip to Osaka", "Meeting about miosotis"]);
    expect(titles({ from: "2026-10-02", to: "2026-10-05" })).toEqual(["Trip to Osaka", "Meeting about miosotis"]);
    expect(titles({ from: "2026-10-04" })).toEqual(["Meeting about miosotis"]);
    // The current month is September: the trip starts on October 1.
    expect(titles({ months: 0 })).toEqual(["Dentist"]);
    expect(titles({ months: 1 })).toEqual(["Dentist", "Trip to Osaka", "Meeting about miosotis"]);

    const view = listSchedule(library.context, { days: 14 });
    expect(view.range).toMatchObject({ from: "2026-09-28", to: "2026-10-11", timezone: "Asia/Shanghai" });
    expect(view.events[2]).toMatchObject({ part_of_day: "morning", time: null, location: "Tokyo room" });
    const text = renderSchedule(view);
    expect(text).toMatch(/morning\s+Meeting about miosotis\s+Tokyo room/);
    expect(text).toMatch(/18:00–19:00\s+Dentist/);
    expect(text).toMatch(/all day, until 2026-10-03\s+Trip to Osaka/);
    expect(text).toContain("· today");
    // The original words stay a normal, searchable note.
    expect(library.context.db.get("SELECT 1 FROM search_fts WHERE source_id = ?", [meeting.id])).toBeDefined();
  });

  it("aligns table columns for wide (CJK) text and renders a Markdown table", () => {
    saveWithEvents("每周一早上九点，我都要参加东区销售会议。", [
      {
        title: "东区销售会议",
        start: { date: "2026-09-28", time: "09:00" },
        repeat: { every: "week", on: ["monday"] },
      },
    ]);
    saveWithEvents("Tomorrow at 15:00 an internal discussion at Studio A.", [
      { title: "Internal discussion", start: { date: "2026-09-29", time: "15:00" }, location: "Studio A" },
    ]);
    const schedule = listSchedule(library.context);
    const rows = renderSchedule(schedule)
      .split("\n")
      .filter((line) => /09:00|15:00/.test(line));
    const whereColumn = (line: string) => {
      const index = line.indexOf("every Monday") >= 0 ? line.indexOf("every Monday") : line.indexOf("Studio A");
      return displayWidth(line.slice(0, index));
    };
    // "every Monday" is in the Repeats column, right of Where; compare the start of the What column instead.
    const whatStart = rows.map((line) => displayWidth(line.slice(0, line.search(/东区|Internal/))));
    expect(new Set(whatStart).size).toBe(1);
    expect(whereColumn(rows[1] ?? "")).toBeGreaterThan(whatStart[0] ?? 0);
    expect(renderSchedule(schedule)).not.toContain("S-");
    expect(renderSchedule(schedule, { ids: true })).toMatch(/S-\S+@v1\s+V-/);
    const md = renderSchedule(schedule, { format: "md" });
    expect(md).toContain("| Date | Time | What | Where | Repeats |");
    expect(md).toMatch(/\| .*today \| 09:00 \| 东区销售会议 \| {2}\| every Monday \|/);
  });

  it("shows another zone's clock time with its zone, and looks back with --past", () => {
    saveWithEvents("Call with Tokyo office on Wednesday at 10:00 Tokyo time.", [
      { title: "Call with Tokyo office", start: { date: "2026-09-30", time: "10:00" }, timezone: "Asia/Tokyo" },
    ]);
    saveWithEvents("Last week I had the kickoff meeting on Tuesday.", [
      { title: "Kickoff meeting", start: { date: "2026-09-22" } },
    ]);
    expect(renderSchedule(listSchedule(library.context))).toMatch(/10:00 \(Asia\/Tokyo\)\s+Call with Tokyo office/);
    expect(titles({ past: true, days: 30 })).toEqual(["Kickoff meeting"]);
    expect(titles({ past: true, months: 1 })).toEqual(["Kickoff meeting"]);
  });

  it("follows rescheduling and cancellation at read time, so removing the later note undoes it", () => {
    const first = saveWithEvents("Budget review on Friday.", [
      { title: "Budget review", start: { date: "2026-10-02" } },
    ]);
    const moved = saveWithEvents("The budget review moved to next Tuesday afternoon.", [
      {
        title: "Budget review",
        start: { date: "2026-10-06", part_of_day: "afternoon" },
        replaces: first.eventIds[0] ?? "",
      },
    ]);
    const planning = saveWithEvents("Planning session on Thursday.", [
      { title: "Planning session", start: { date: "2026-10-01" } },
    ]);
    saveWithEvents("Thursday's planning session is cancelled.", [], [planning.eventIds[0] ?? ""]);

    const current = listSchedule(library.context, { days: 14 }).events;
    expect(current.map((entry) => [entry.title, entry.date])).toEqual([["Budget review", "2026-10-06"]]);
    const everything = listSchedule(library.context, { days: 14, all: true }).events;
    expect(everything.map((entry) => entry.status)).toEqual(["cancelled", "moved", "scheduled"]);

    changeSourcePolicy(library.context, moved.id, "trash", { confirm: true });
    expect(listSchedule(library.context, { days: 14 }).events.map((entry) => entry.date)).toEqual(["2026-10-02"]);
  });

  it("marks entries of a corrected note as not re-read yet, then follows the new reading", () => {
    const note = saveWithEvents("Demo on Friday.", [{ title: "Demo", start: { date: "2026-10-02" } }]);
    correctSource(library.context, note.id, 1, { text: "Demo on Saturday." });
    expect(listSchedule(library.context).events[0]).toMatchObject({ date: "2026-10-02", stale: true });
    applyEnrichment(library.context, {
      source_ref: prepareEnrichment(library.context, note.id).source_ref,
      events: [{ title: "Demo", start: { date: "2026-10-03" } }],
    });
    expect(listSchedule(library.context).events).toMatchObject([{ date: "2026-10-03", stale: false }]);
    changeSourcePolicy(library.context, note.id, "ignore", { reason: "not mine" });
    expect(listSchedule(library.context).events).toEqual([]);
  });

  it("expands a weekly plan, skips or moves single dates, and changes the series from a date on", () => {
    const sales = saveWithEvents("Every Monday at 09:00 I attend the east region sales meeting.", [
      {
        title: "East region sales meeting",
        start: { date: "2026-09-28", time: "09:00" },
        repeat: { every: "week", on: ["monday"] },
        phrase: "Every Monday at 09:00",
      },
    ]);
    const series = sales.eventIds[0] ?? "";
    expect(sales.receipt.events).toMatchObject([{ repeats: true, start_date: "2026-09-28" }]);
    const mondays = (options: Parameters<typeof listSchedule>[1]) =>
      listSchedule(library.context, options).events.map((entry) => `${entry.date} ${entry.time}`);
    expect(mondays({ days: 21 })).toEqual(["2026-09-28 09:00", "2026-10-05 09:00", "2026-10-12 09:00"]);
    expect(listSchedule(library.context, { days: 7 }).events[0]).toMatchObject({ repeat: "every Monday" });
    expect(renderSchedule(listSchedule(library.context))).toMatch(/09:00\s+East region sales meeting\s+every Monday/);

    saveWithEvents("Next Monday's sales meeting is cancelled.", [], [{ event: series, date: "2026-10-05" }]);
    saveWithEvents("The sales meeting on Oct 12 moves to Tuesday.", [
      {
        title: "East region sales meeting",
        start: { date: "2026-10-13", time: "09:00" },
        replaces: series,
        occurrence: "2026-10-12",
      },
    ]);
    const later = saveWithEvents("From November the sales meeting starts at 10:00.", [
      {
        title: "East region sales meeting",
        start: { date: "2026-11-02", time: "10:00" },
        repeat: { every: "week", on: ["monday"] },
        replaces: series,
      },
    ]);
    expect(mondays({ from: "2026-09-28", to: "2026-11-10" })).toEqual([
      "2026-09-28 09:00",
      "2026-10-13 09:00",
      "2026-10-19 09:00",
      "2026-10-26 09:00",
      "2026-11-02 10:00",
      "2026-11-09 10:00",
    ]);
    const history = listSchedule(library.context, { from: "2026-10-05", to: "2026-10-12", all: true }).events;
    expect(history.map((entry) => [entry.date, entry.status])).toEqual([
      ["2026-10-05", "cancelled"],
      ["2026-10-12", "moved"],
    ]);

    // Removing the "from November" note brings the 09:00 series back for those weeks.
    changeSourcePolicy(library.context, later.id, "trash", { confirm: true });
    expect(mondays({ from: "2026-11-02", to: "2026-11-02" })).toEqual(["2026-11-02 09:00"]);
    // Ending the series.
    saveWithEvents("The sales meeting ends after October.", [], [{ event: series, from: "2026-11-01" }]);
    expect(mondays({ from: "2026-10-26", to: "2026-11-30" })).toEqual(["2026-10-26 09:00"]);
  });

  it("rejects repeat rules and occurrences that don't fit", () => {
    const weekly = saveWithEvents("Yoga every Wednesday evening.", [
      {
        title: "Yoga",
        start: { date: "2026-09-28", part_of_day: "evening" },
        repeat: { every: "week", on: ["wednesday"] },
      },
    ]);
    expect(weekly.receipt.events[0]?.start_date).toBe("2026-09-30");
    const id = capture(library.context, { text: "changes" }).sources[0]?.id ?? "";
    const apply = (payload: Record<string, unknown>) =>
      applyEnrichment(library.context, { source_ref: prepareEnrichment(library.context, id).source_ref, ...payload });
    expect(() => apply({ cancels: [{ event: weekly.eventIds[0], date: "2026-10-01" }] })).toThrow(/not a date of/);
    expect(() =>
      apply({ events: [{ title: "x", start: { date: "2026-10-01" }, repeat: { every: "day", on: ["monday"] } }] }),
    ).toThrow(/only to weekly/);
    expect(() =>
      apply({
        events: [{ title: "x", start: { date: "2026-10-01" }, repeat: { every: "week", until: "2026-09-01" } }],
      }),
    ).toThrow(/before the start/);
    expect(() => apply({ events: [{ title: "x", start: { date: "2026-10-01" }, occurrence: "2026-10-01" }] })).toThrow(
      /only meaningful together with replaces/,
    );
  });

  it("validates events and range options", () => {
    const id = capture(library.context, { text: "Party on the 30th of February?" }).sources[0]?.id ?? "";
    const ref = () => prepareEnrichment(library.context, id).source_ref;
    const apply = (events: EventRequest[]) => applyEnrichment(library.context, { source_ref: ref(), events });
    expect(() => apply([{ title: "Party", start: { date: "2026-02-30" } }])).toThrow(/real calendar date/);
    expect(() =>
      apply([{ title: "Party", start: { date: "2026-03-01", time: "20:00", part_of_day: "evening" } }]),
    ).toThrow(/not both/);
    expect(() =>
      apply([{ title: "Party", start: { date: "2026-03-01" }, replaces: "V-01M3JW25S8KGEXBQGWQ2096HG5" }]),
    ).toThrow(/not a known event/);
    const receipt = apply([{ title: "Party", start: { date: "2026-03-01" }, phrase: "words never said" }]);
    expect(receipt.warnings.join(" ")).toMatch(/not in the source text/);

    expect(() => listSchedule(library.context, { days: 3, months: 1 })).toThrow(/one of/);
    expect(() => listSchedule(library.context, { from: "2026-13-01" })).toThrow(/--from/);
    expect(() => listSchedule(library.context, { from: "2026-10-05", to: "2026-10-01" })).toThrow(/before/);
    expect(() => listSchedule(library.context, { past: true, from: "2026-10-01" })).toThrow(/--past/);
  });

  it("answers from the CLI, in JSON and as text", async () => {
    saveWithEvents("Dentist today at 18:00.", [{ title: "Dentist", start: { date: "2026-09-28", time: "18:00" } }]);
    const json = await cli(library.env, "schedule", "--days", "3", "--json");
    expect(json.json()).toMatchObject({ ok: true, data: { total: 1 } });
    const human = await cli(library.env, "schedule", "--from", "2030-01-01", "--to", "2030-01-02");
    expect(human.stdout).toContain("Nothing scheduled.");
    expect((await cli(library.env, "schedule", "--days", "0", "--json")).json().error?.code).toBe("usage");
  });
});
