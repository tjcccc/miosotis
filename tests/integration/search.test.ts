import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/app/capture.js";
import { search } from "../../src/app/search.js";
import { MIXED_TEXT } from "../fixtures/multilingual.js";
import { createTestLibrary, steppingClock, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;
const ids: Record<string, string> = {};

function refs(query: string, extra: Record<string, unknown> = {}): string[] {
  return search(library.context, { query, ...extra }).hits.map((hit) => hit.source_id);
}

beforeEach(() => {
  library = createTestLibrary({ now: steppingClock() });
  const save = (key: string, text: string, project?: string) => {
    ids[key] = capture(library.context, { text, ...(project === undefined ? {} : { project }) }).sources[0]?.id ?? "";
  };
  save("mixed", MIXED_TEXT, "miosotis");
  save("plan", "明天的计划：先写测试，再写代码。", "miosotis");
  save("warehouse", "入库和出库的流程需要重新整理，客户反馈很多。");
  save("model", "Benchmark: GPT-5.5 vs Claude Opus 5.5 on long-context tasks.");
  save("literal", "Percent 100% and snake_case_name are literal characters.");
});

afterEach(() => library.cleanup());

describe("language-agnostic search", () => {
  it("finds two-character CJK terms through the substring path", () => {
    const result = search(library.context, { query: "计划" });
    expect(result.mode).toBe("substring");
    expect(result.hits.map((hit) => hit.source_id).sort()).toEqual([ids.mixed, ids.plan].sort());
    expect(refs("入库")).toEqual([ids.warehouse]);
    expect(refs("出库")).toEqual([ids.warehouse]);
    expect(refs("客户")).toEqual([ids.warehouse]);
  });

  it("finds Japanese, Korean, Arabic, and Hindi text", () => {
    expect(refs("東京タワー")).toEqual([ids.mixed]);
    expect(refs("東京")).toEqual([ids.mixed]);
    expect(refs("한국어")).toEqual([ids.mixed]);
    expect(refs("العالم")).toEqual([ids.mixed]);
    expect(refs("हिन्दी")).toEqual([ids.mixed]);
  });

  it("folds diacritics and case on both the FTS and substring paths", () => {
    expect(refs("cafe")).toEqual([ids.mixed]);
    expect(refs("UBER")).toEqual([ids.mixed]);
    expect(refs("üb")).toEqual([ids.mixed]);
    expect(refs("ub")).toContain(ids.mixed);
  });

  it("handles mixed-script multi-term queries", () => {
    const result = search(library.context, { query: "artifact 溯源" });
    expect(result.mode).toBe("mixed");
    expect(result.hits.map((hit) => hit.source_id)).toEqual([ids.mixed]);
    expect(result.hits[0]?.matches[0]?.excerpt).toContain("溯源");
  });

  it("matches model names with punctuation and exact IDs", () => {
    expect(refs("GPT-5.5")).toEqual([ids.model]);
    expect(refs(ids.plan ?? "")).toEqual([ids.plan]);
    expect(refs(`${ids.plan}@v1`)).toEqual([ids.plan]);
  });

  it("treats LIKE wildcards and FTS syntax as literal text", () => {
    // Only the two fixtures that literally contain "%" / "_" match; unescaped, these would match everything.
    expect(refs("%").sort()).toEqual([ids.literal, ids.mixed].sort());
    expect(refs("e_n")).toEqual([ids.literal]);
    expect(() => search(library.context, { query: 'NEAR( "unbalanced OR' })).not.toThrow();
  });

  it("requires all terms by default and supports any", () => {
    expect(refs("benchmark 计划")).toEqual([]);
    expect(refs("benchmark 计划", { match: "any" }).sort()).toEqual([ids.model, ids.mixed, ids.plan].sort());
  });

  it("respects project boundaries and paginates", () => {
    expect(refs("计划", { project: "miosotis" }).sort()).toEqual([ids.mixed, ids.plan].sort());
    expect(refs("客户", { project: "miosotis" })).toEqual([]);
    const first = search(library.context, { query: "的", limit: 1 });
    expect(first.total).toBeGreaterThan(1);
    expect(first.next_cursor).toBe("1");
    const second = search(library.context, { query: "的", limit: 1, cursor: first.next_cursor ?? undefined });
    expect(second.hits[0]?.source_id).not.toBe(first.hits[0]?.source_id);
  });

  it("rejects an unknown project instead of silently widening scope", () => {
    expect(() => search(library.context, { query: "计划", project: "nope" })).toThrow(/No project/);
  });

  it("excludes ignored and trashed sources from results", () => {
    library.context.db.run("UPDATE sources SET inclusion = 'ignored' WHERE id = ?", [ids.plan ?? ""]);
    library.context.db.run("UPDATE sources SET retention = 'trashed' WHERE id = ?", [ids.warehouse ?? ""]);
    expect(refs("计划")).toEqual([ids.mixed]);
    expect(refs("客户")).toEqual([]);
  });
});
