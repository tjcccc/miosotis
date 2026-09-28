import { describe, expect, it } from "vitest";
import { describeRule, firstOccurrence, occurrences, type RepeatRule } from "../../src/domain/recurrence.js";

const rule = (overrides: Partial<RepeatRule>): RepeatRule => ({
  every: "week",
  interval: 1,
  weekdays: [1],
  month_day: null,
  nth: null,
  weekday: null,
  until: null,
  count: null,
  ...overrides,
});

describe("repeat rules", () => {
  it("expands weekly rules on chosen weekdays and every N weeks", () => {
    expect(occurrences(rule({}), "2026-09-28", "2026-10-01", "2026-10-20")).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
    ]);
    expect(occurrences(rule({ interval: 2, weekdays: [1, 4] }), "2026-09-28", "2026-09-28", "2026-10-20")).toEqual([
      "2026-09-28",
      "2026-10-01",
      "2026-10-12",
      "2026-10-15",
    ]);
    expect(firstOccurrence(rule({}), "2026-09-30")).toBe("2026-10-05");
  });

  it("expands daily and monthly rules, skipping months without the day", () => {
    expect(
      occurrences(rule({ every: "day", interval: 3, weekdays: [] }), "2026-09-28", "2026-10-01", "2026-10-08"),
    ).toEqual(["2026-10-01", "2026-10-04", "2026-10-07"]);
    const day31 = rule({ every: "month", weekdays: [], month_day: 31 });
    expect(occurrences(day31, "2026-01-31", "2026-01-01", "2026-06-01")).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
    ]);
    const last = rule({ every: "month", weekdays: [], month_day: -1 });
    expect(occurrences(last, "2026-01-31", "2026-01-01", "2026-04-01")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
    const firstMonday = rule({ every: "month", weekdays: [], nth: 1, weekday: 1 });
    expect(occurrences(firstMonday, "2026-10-01", "2026-10-01", "2027-01-01")).toEqual([
      "2026-10-05",
      "2026-11-02",
      "2026-12-07",
    ]);
    const lastFriday = rule({ every: "month", weekdays: [], nth: -1, weekday: 5 });
    expect(occurrences(lastFriday, "2026-10-01", "2026-10-01", "2026-12-01")).toEqual(["2026-10-30", "2026-11-27"]);
  });

  it("ends by date or by count, counting from the start", () => {
    expect(occurrences(rule({ until: "2026-10-12" }), "2026-09-28", "2026-09-28", "2026-12-31")).toHaveLength(3);
    expect(occurrences(rule({ count: 3 }), "2026-09-28", "2026-10-10", "2026-12-31")).toEqual(["2026-10-12"]);
  });

  it("describes rules in words", () => {
    expect(describeRule(rule({}))).toBe("every Monday");
    expect(describeRule(rule({ interval: 2, weekdays: [1, 4] }))).toBe("every 2 weeks on Mon, Thu");
    expect(describeRule(rule({ every: "month", weekdays: [], nth: 1, weekday: 1 }))).toBe(
      "every month on the first Monday",
    );
    expect(describeRule(rule({ count: 5 }))).toBe("every Monday, 5 times");
  });
});
