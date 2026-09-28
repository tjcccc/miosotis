import { describe, expect, it } from "vitest";
import { addDays, addMonths, isCalendarDate, localDate, startOfMonth, zonedToUtc } from "../../src/domain/time.js";

describe("calendar helpers", () => {
  it("accepts only real dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-2-1")).toBe(false);
  });

  it("adds days and months, clamping to the month's end", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-03-15", -2)).toBe("2026-01-15");
    expect(startOfMonth("2026-09-28")).toBe("2026-09-01");
  });

  it("converts local wall-clock times to UTC, across zones and DST", () => {
    expect(new Date(zonedToUtc("2026-10-05", "10:00", "Asia/Tokyo")).toISOString()).toBe("2026-10-05T01:00:00.000Z");
    expect(new Date(zonedToUtc("2026-07-01", "09:00", "America/New_York")).toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
    expect(new Date(zonedToUtc("2026-12-01", "09:00", "America/New_York")).toISOString()).toBe(
      "2026-12-01T14:00:00.000Z",
    );
    expect(localDate(Date.parse("2026-09-27T20:00:00Z"), "Asia/Shanghai")).toBe("2026-09-28");
  });
});
