import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/app/capture.js";
import { changeSourcePolicy } from "../../src/app/governance.js";
import { showLibrary } from "../../src/app/show.js";
import { renderShow } from "../../src/cli/templates/show.js";
import { cli, createTestLibrary, type TestLibrary } from "../helpers/library.js";

// Tuesday 2026-10-20, 10:00 in Asia/Shanghai (UTC+8).
const NOW = "2026-10-20T02:00:00.000Z";
let clock = NOW;
let library: TestLibrary;

beforeEach(() => {
  clock = NOW;
  library = createTestLibrary({ now: () => new Date(clock), timezone: "Asia/Shanghai" });
});

afterEach(() => library.cleanup());

function saveAt(instant: string, text: string): string {
  clock = instant;
  const id = capture(library.context, { text }).sources[0]?.id ?? "";
  clock = NOW;
  return id;
}

function listed(options: Parameters<typeof showLibrary>[1]): string[] {
  const result = showLibrary(library.context, options);
  if (result.view !== "list") {
    throw new Error(`expected a list, got ${result.view}`);
  }
  return result.notes.map((note) => note.id);
}

describe("show", () => {
  it("windows by local days in the user's timezone, not UTC", () => {
    const lateYesterday = saveAt("2026-10-19T15:50:00.000Z", "Late last night"); // 23:50 local, Oct 19
    const earlyToday = saveAt("2026-10-19T16:10:00.000Z", "Just after midnight"); // 00:10 local, Oct 20
    const lastWeek = saveAt("2026-10-13T16:10:00.000Z", "A week ago"); // 00:10 local, Oct 14

    expect(listed({ today: true })).toEqual([earlyToday]);
    expect(listed({ days: 2 })).toEqual([earlyToday, lateYesterday]);
    expect(listed({ from: "2026-10-19", to: "2026-10-19" })).toEqual([lateYesterday]);
    expect(listed({ from: "2026-10-14" })).toEqual([earlyToday, lateYesterday, lastWeek]);
    expect(listed({ days: 6 })).not.toContain(lastWeek);
    expect(listed({ days: 7 })).toContain(lastWeek);
  });

  it("previews notes without a title by their first line, and shows local times", () => {
    saveAt("2026-10-19T16:10:00.000Z", "\n  第一行的想法\n第二行");
    const result = showLibrary(library.context, {});
    expect(result.view === "list" && result.notes[0]?.preview).toBe("第一行的想法");
    expect(renderShow(result)).toContain("2026-10-20 00:10  第一行的想法");
  });

  it("opens one note by ID and prints its text exactly as saved", () => {
    const text = "  会议纪要：\n\t- 다음 주 목요일\n- 来週の月曜日  \n\n";
    const id = saveAt(NOW, text);
    const result = showLibrary(library.context, { words: [id.toLowerCase()] });
    expect(result.view).toBe("source");
    expect(result.view === "source" && result.source.text).toBe(text);
    expect(renderShow(result).endsWith(`\n\n${text}`)).toBe(true);
    expect(renderShow(result)).toContain("saved 2026-10-20 10:00");
  });

  it("searches with any other words, and keeps trashed notes out of lists and searches", () => {
    const kept = saveAt(NOW, "Spice jars by cuisine");
    const trashed = saveAt(NOW, "Spice rack idea");
    changeSourcePolicy(library.context, trashed, "trash", { confirm: true });

    const found = showLibrary(library.context, { words: ["spice"] });
    expect(found.view).toBe("search");
    expect(found.view === "search" && found.hits.map((hit) => hit.source_id)).toEqual([kept]);
    expect(listed({})).toEqual([kept]);
    // A word that merely starts like an ID is a search, not a lookup.
    expect(showLibrary(library.context, { words: ["S-curve"] }).view).toBe("search");
  });

  it("rejects mixing a search or an ID with date options", () => {
    const id = saveAt(NOW, "A note");
    expect(() => showLibrary(library.context, { words: ["note"], today: true })).toThrow(/date/);
    expect(() => showLibrary(library.context, { words: [id], days: 3 })).toThrow(/note ID/);
    expect(() => showLibrary(library.context, { today: true, days: 3 })).toThrow(/one of/);
  });
});

describe("show (CLI)", () => {
  it("is a real command, so `show` is never saved as a note", async () => {
    const env = library.env;
    const saved = (await cli(env, "save", "Remember the milk", "--json")).json().data.sources[0].id;
    const shown = await cli(env, "show", saved, "--json");
    expect(shown.json()).toMatchObject({ ok: true, data: { view: "source", source: { text: "Remember the milk" } } });
    expect((await cli(env, "show", "--json")).json().data).toMatchObject({ view: "list", total: 1 });
    expect((await cli(env, "shw")).code).toBe(2);
  });
});
