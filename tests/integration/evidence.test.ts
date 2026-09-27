import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/app/capture.js";
import { prepareEvidence } from "../../src/app/evidence.js";
import { changeSourcePolicy } from "../../src/app/governance.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;
let noteId: string;
let otherId: string;

beforeEach(() => {
  library = createTestLibrary();
  noteId =
    capture(library.context, { text: "Alpha said yes. Beta said no. Alpha said yes.", project: "p1" }).sources[0]?.id ??
    "";
  otherId = capture(library.context, { text: "Unrelated material about gamma.", project: "p2" }).sources[0]?.id ?? "";
});

afterEach(() => library.cleanup());

describe("evidence runs", () => {
  it("pins search hits, refs, and exact quotes with core-assigned handles", () => {
    const view = prepareEvidence(library.context, {
      request: "What did Beta say?",
      queries: ["Beta"],
      quotes: [{ ref: noteId, quote: "Beta said no." }],
    });
    expect(view.items.map((item) => item.handle)).toEqual(["c1", "c2"]);
    const quote = view.items.find((item) => item.origin === "quote_pin");
    expect(quote?.excerpt).toBe("Beta said no.");
    expect(quote?.start).toBe(16);
  });

  it("rejects missing quotes and requires an occurrence for repeated ones", () => {
    expect(() => prepareEvidence(library.context, { request: "r", quotes: [{ ref: noteId, quote: "Gamma" }] })).toThrow(
      /not found/,
    );
    expect(() =>
      prepareEvidence(library.context, { request: "r", quotes: [{ ref: noteId, quote: "Alpha said yes." }] }),
    ).toThrow(/occurs 2 times/);
    const second = prepareEvidence(library.context, {
      request: "r",
      quotes: [{ ref: noteId, quote: "Alpha said yes.", occurrence: 2 }],
    });
    expect(second.items[0]?.start).toBe(30);
  });

  it("extends a run with --from, keeping earlier handles", () => {
    const first = prepareEvidence(library.context, { request: "r", source_refs: [{ ref: noteId }] });
    const second = prepareEvidence(
      library.context,
      { request: "r", quotes: [{ ref: noteId, quote: "Beta said no." }] },
      { from: first.id },
    );
    expect(second.extends).toBe(first.id);
    expect(second.items.map((item) => [item.handle, item.origin])).toEqual([
      ["c1", "carried"],
      ["c2", "quote_pin"],
    ]);
  });

  it("enforces project scope and eligibility", () => {
    expect(() =>
      prepareEvidence(library.context, { request: "r", project: "p1", source_refs: [{ ref: otherId }] }),
    ).toThrow(/outside/);
    const scoped = prepareEvidence(library.context, {
      request: "r",
      project: "p1",
      queries: ["said", "gamma"],
      match: "any",
    });
    expect(scoped.items.every((item) => item.source_id === noteId)).toBe(true);
    changeSourcePolicy(library.context, noteId, "ignore", { reason: "wrong" });
    expect(() => prepareEvidence(library.context, { request: "r", source_refs: [{ ref: noteId }] })).toThrow(/ignored/);
    expect(prepareEvidence(library.context, { request: "r", queries: ["Beta"] }).items).toHaveLength(0);
  });

  it("reports items dropped by max_items", () => {
    const view = prepareEvidence(library.context, {
      request: "r",
      source_refs: [{ ref: noteId }, { ref: otherId }],
      max_items: 1,
    });
    expect(view.items).toHaveLength(1);
    expect(view.coverage).toMatchObject({ dropped_items: 1 });
  });
});
