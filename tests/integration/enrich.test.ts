import { afterEach, describe, expect, it } from "vitest";
import { capture } from "../../src/app/capture.js";
import { applyEnrichment, pendingEnrichment, prepareEnrichment } from "../../src/app/enrich.js";
import { correctSource } from "../../src/app/governance.js";
import { createProject } from "../../src/app/projects.js";
import { search } from "../../src/app/search.js";
import { getSourceView } from "../../src/app/sources.js";
import { fakeEnrichment } from "../helpers/fake-agent.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

afterEach(() => library?.cleanup());

function saved(text: string, project?: string): string {
  return capture(library.context, { text, ...(project === undefined ? {} : { project }) }).sources[0]?.id ?? "";
}

describe("enrichment (host_agent)", () => {
  it("stores derived metadata without touching the original, and makes terms searchable", () => {
    library = createTestLibrary();
    const id = saved("Artifacts should be regenerated only when the user asks.");
    const prepared = prepareEnrichment(library.context, id);
    expect(prepared.complete).toBe(true);
    const receipt = applyEnrichment(library.context, {
      ...fakeEnrichment(prepared),
      terms: ["regeneration", "重新生成", "再生成"],
      model: null,
    });
    expect(receipt.state).toBe("complete");
    const view = getSourceView(library.context, id);
    expect(view.text).toBe("Artifacts should be regenerated only when the user asks.");
    expect(view.processing).toMatchObject({ enrichment: { state: "complete" } });
    expect(view.enrichment).toMatchObject({ derived: true, model: null });
    const viaTerms = search(library.context, { query: "重新生成" });
    expect(viaTerms.hits.map((hit) => hit.source_id)).toEqual([id]);
    expect(viaTerms.hits[0]?.matches[0]).toMatchObject({
      matched_in: "enrichment",
      excerpt: expect.stringContaining("Artifacts"),
    });
    expect(pendingEnrichment(library.context).total).toBe(0);
  });

  it("keeps a malformed result from losing the source and marks it retryable", () => {
    library = createTestLibrary();
    const id = saved("keep me safe");
    const prepared = prepareEnrichment(library.context, id);
    expect(() =>
      applyEnrichment(library.context, {
        source_ref: prepared.source_ref,
        title: "x".repeat(500),
        terms: "not-a-list",
      } as never),
    ).toThrow(/Invalid enrichment request/);
    const view = getSourceView(library.context, id);
    expect(view.text).toBe("keep me safe");
    expect(view.processing).toMatchObject({ enrichment: { state: "failed", attempts: 1 } });
    expect(pendingEnrichment(library.context).sources.map((row) => row.ref)).toEqual([`${id}@v1`]);
    applyEnrichment(library.context, fakeEnrichment(prepared));
    expect(pendingEnrichment(library.context).total).toBe(0);
  });

  it("binds results to the exact revision (digest and stale version)", () => {
    library = createTestLibrary();
    const id = saved("version one");
    const prepared = prepareEnrichment(library.context, id);
    expect(() =>
      applyEnrichment(library.context, {
        ...fakeEnrichment(prepared),
        source_ref: { ...prepared.source_ref, input_digest: "sha256:bad" },
      }),
    ).toThrow(/input_digest/);
    correctSource(library.context, id, 1, { text: "version two" });
    expect(() => applyEnrichment(library.context, fakeEnrichment(prepared))).toThrow(/current revision is v2/);
    expect(() => prepareEnrichment(library.context, `${id}@v1`)).toThrow(/not the current revision/);
  });

  it("keeps attribution: a quoted claim is not stored as the user's belief", () => {
    library = createTestLibrary();
    const text = "The article claims X. I disagree; our group has not decided.";
    const id = saved(text);
    const prepared = prepareEnrichment(library.context, id);
    applyEnrichment(library.context, {
      ...fakeEnrichment(prepared),
      assertions: [
        { text: "X", holder: "quoted_author", modality: "quoted" },
        { text: "The user disagrees with X", holder: "user", modality: "explicit" },
        { text: "The group has not decided", holder: "group", modality: "explicit" },
      ],
    });
    const content = getSourceView(library.context, id).enrichment?.content as { assertions: { holder: string }[] };
    expect(content.assertions.map((a) => a.holder)).toEqual(["quoted_author", "user", "group"]);
    expect(getSourceView(library.context, id).text).toBe(text);
  });

  it("records only existing project suggestions as inferred and never overrides explicit membership", () => {
    library = createTestLibrary();
    const other = createProject(library.context, { slug: "other" });
    const id = saved("belongs to alpha", "alpha");
    const alpha = getSourceView(library.context, id).projects[0]?.id ?? "";
    const prepared = prepareEnrichment(library.context, id);
    const receipt = applyEnrichment(library.context, {
      ...fakeEnrichment(prepared),
      project_suggestions: [alpha, other.id, "P-01M3G9NPX0XNVPV0NJTSNDH79K", "not-an-id"],
    });
    expect(receipt.inferred_projects).toEqual([other.id]);
    expect(receipt.warnings).toHaveLength(2);
    expect(getSourceView(library.context, id).projects).toEqual([
      expect.objectContaining({ slug: "alpha", assignment: "explicit" }),
      expect.objectContaining({ slug: "other", assignment: "inferred" }),
    ]);
  });

  it("reports partial coverage honestly for long sources", () => {
    library = createTestLibrary();
    const id = saved("長い文章。".repeat(5000));
    const prepared = prepareEnrichment(library.context, id);
    expect(prepared.complete).toBe(false);
    expect(applyEnrichment(library.context, fakeEnrichment(prepared)).state).toBe("partial");
    const { coverage: _omitted, ...withoutCoverage } = fakeEnrichment(prepareEnrichment(library.context, id));
    expect(applyEnrichment(library.context, withoutCoverage).state).toBe("partial");
  });

  it("replays idempotent enrichment", () => {
    library = createTestLibrary();
    const id = saved("idempotent");
    const request = { ...fakeEnrichment(prepareEnrichment(library.context, id)), idempotency_key: "enrich-key-1" };
    const first = applyEnrichment(library.context, request);
    const replay = applyEnrichment(library.context, request);
    expect(replay).toMatchObject({ replayed: true, derivation_id: first.derivation_id });
  });
});
