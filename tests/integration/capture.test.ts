import { afterEach, describe, expect, it } from "vitest";
import { capture } from "../../src/app/capture.js";
import { listProjectViews } from "../../src/app/projects.js";
import { getSourceView, listSourceViews, sourceHistoryView } from "../../src/app/sources.js";
import { MIXED_TEXT } from "../fixtures/multilingual.js";
import { createTestLibrary, steppingClock, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

afterEach(() => library?.cleanup());

function count(table: string): number {
  return library.context.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0;
}

describe("capture", () => {
  it("preserves mixed-script text byte for byte and reports honest state", () => {
    library = createTestLibrary();
    const receipt = capture(library.context, { text: MIXED_TEXT, origin: "user" });
    const source = receipt.sources[0];
    expect(source?.processing.enrichment).toBe("pending");
    expect(source?.char_length).toBe(MIXED_TEXT.length);
    const view = getSourceView(library.context, source?.ref ?? "");
    expect(view.text).toBe(MIXED_TEXT);
    expect(view.truncated).toBe(false);
    expect(view.enrichment).toBeNull();
    expect(view.processing).toMatchObject({ enrichment: { state: "pending" } });
    expect(view.version.content_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("replays an idempotent request without duplicates and rejects key reuse with other content", () => {
    library = createTestLibrary();
    const first = capture(library.context, { text: "remember this", idempotency_key: "key-000001" });
    const replay = capture(library.context, { text: "remember this", idempotency_key: "key-000001" });
    expect(replay.replayed).toBe(true);
    expect(replay.sources[0]?.id).toBe(first.sources[0]?.id);
    expect(count("sources")).toBe(1);
    expect(() => capture(library.context, { text: "something else", idempotency_key: "key-000001" })).toThrow(
      /different content/,
    );
    expect(count("sources")).toBe(1);
  });

  it("treats a repeated capture without a key as a separate event", () => {
    library = createTestLibrary();
    capture(library.context, { text: "same thought" });
    capture(library.context, { text: "same thought" });
    expect(count("sources")).toBe(2);
  });

  it("creates a named project once and associates explicitly", () => {
    library = createTestLibrary();
    const first = capture(library.context, { text: "one", project: "读书 笔记" });
    const second = capture(library.context, { text: "two", project: "读书-笔记" });
    expect(first.project).toMatchObject({ slug: "读书-笔记", created: true });
    expect(second.project).toMatchObject({ slug: "读书-笔记", created: false });
    expect(listProjectViews(library.context)).toMatchObject([{ slug: "读书-笔记", source_count: 2 }]);
    expect(getSourceView(library.context, second.sources[0]?.id ?? "").projects).toMatchObject([
      { assignment: "explicit" },
    ]);
  });

  it("rejects empty text and invalid input without writing anything", () => {
    library = createTestLibrary();
    expect(() => capture(library.context, { text: "   \n\t" })).toThrow(/empty/);
    expect(() => capture(library.context, { text: "x", origin: "robot" as never })).toThrow(/Invalid capture request/);
    expect(() => capture(library.context, { text: "x", timezone: "Mars/Olympus" })).toThrow(/timezone/);
    expect(count("sources")).toBe(0);
    expect(count("operations")).toBe(0);
  });

  it("keeps provenance separate from content and records the timezone", () => {
    library = createTestLibrary({ timezone: "Asia/Tokyo" });
    const receipt = capture(library.context, {
      text: "The article claims X.",
      origin: "imported",
      provenance: {
        supplied_url: "https://example.com/a",
        author: "Someone",
        published: { value: "2026-03", precision: "month" },
      },
    });
    const view = getSourceView(library.context, receipt.sources[0]?.id ?? "");
    expect(view.origin).toBe("imported");
    expect(view.version.timezone).toBe("Asia/Tokyo");
    expect(view.version.provenance).toMatchObject({ published: { value: "2026-03", precision: "month" } });
    expect(view.text).toBe("The article claims X.");
  });

  it("bounds returned text and supports ranges and chunks", () => {
    library = createTestLibrary();
    const long = "段落内容。".repeat(1000);
    const receipt = capture(library.context, { text: long });
    const view = getSourceView(library.context, receipt.sources[0]?.ref ?? "", { maxChars: 100 });
    expect(view.text?.length).toBe(100);
    expect(view.truncated).toBe(true);
    expect(view.chunks.length).toBeGreaterThan(1);
    const chunk = getSourceView(library.context, receipt.sources[0]?.ref ?? "", { chunk: 1 });
    expect(chunk.text).toBe(long.slice(view.chunks[1]?.start, view.chunks[1]?.end));
  });

  it("lists newest first with pagination and history", () => {
    library = createTestLibrary({ now: steppingClock() });
    for (let index = 0; index < 5; index += 1) {
      capture(library.context, { text: `note ${index}` });
    }
    const page = listSourceViews(library.context, { limit: 2 });
    expect(page.total).toBe(5);
    expect(page.sources).toHaveLength(2);
    expect(page.next_cursor).toBe("2");
    const rest = listSourceViews(library.context, { limit: 10, cursor: page.next_cursor ?? undefined });
    expect(rest.sources).toHaveLength(3);
    expect(rest.next_cursor).toBeNull();
    expect(new Set([...page.sources, ...rest.sources].map((s) => s.id)).size).toBe(5);
    const history = sourceHistoryView(library.context, page.sources[0]?.id ?? "");
    expect(history.versions).toMatchObject([{ number: 1, is_current: true, reason: "capture" }]);
  });
});
