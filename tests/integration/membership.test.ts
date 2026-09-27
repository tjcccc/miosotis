import { afterEach, describe, expect, it } from "vitest";
import { capture } from "../../src/app/capture.js";
import { applyEnrichment, prepareEnrichment } from "../../src/app/enrich.js";
import { changeSourcePolicy } from "../../src/app/governance.js";
import { assignSources, unassignSources } from "../../src/app/membership.js";
import { createProject, listProjectViews } from "../../src/app/projects.js";
import { search } from "../../src/app/search.js";
import { getSourceView, listSourceViews } from "../../src/app/sources.js";
import { fakeEnrichment } from "../helpers/fake-agent.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

afterEach(() => library?.cleanup());

function saved(text: string): string {
  return capture(library.context, { text }).sources[0]?.id ?? "";
}

function membership(id: string) {
  return getSourceView(library.context, id).projects.map((p) => [p.slug, p.assignment]);
}

describe("project assignment for existing sources", () => {
  it("assigns explicitly, creating a new project like save --project, and makes the source visible in scope", () => {
    library = createTestLibrary();
    const a = saved("剑之道 note one");
    const b = saved("剑之道 note two");
    const before = getSourceView(library.context, a);
    const result = assignSources(library.context, [a, b], "鬼武者剑之道");
    expect(result.project).toMatchObject({ slug: "鬼武者剑之道", created: true });
    expect(result.results.map((row) => row.change)).toEqual(["assigned", "assigned"]);
    expect(membership(a)).toEqual([["鬼武者剑之道", "explicit"]]);
    expect(search(library.context, { query: "剑之道", project: "鬼武者剑之道" }).total).toBe(2);
    expect(listSourceViews(library.context, { project: "鬼武者剑之道" }).total).toBe(2);
    expect(listProjectViews(library.context)[0]?.source_count).toBe(2);
    const after = getSourceView(library.context, a);
    expect(after.text).toBe(before.text);
    expect(after.current_version).toBe(1);
  });

  it("is idempotent in both directions", () => {
    library = createTestLibrary();
    const a = saved("note");
    assignSources(library.context, [a], "p");
    expect(assignSources(library.context, [a, a], "p").results).toEqual([{ source_id: a, change: "already_explicit" }]);
    expect(unassignSources(library.context, [a], "p").results[0]?.change).toBe("removed");
    expect(unassignSources(library.context, [a], "p").results[0]?.change).toBe("not_member");
    expect(membership(a)).toEqual([]);
    expect(listSourceViews(library.context, { project: "p" }).total).toBe(0);
  });

  it("explicit membership wins over inferred, and an unassign blocks re-inference", () => {
    library = createTestLibrary();
    const project = createProject(library.context, { slug: "p" });
    const a = saved("note for inference");
    applyEnrichment(library.context, {
      ...fakeEnrichment(prepareEnrichment(library.context, a)),
      project_suggestions: [project.id],
    });
    expect(membership(a)).toEqual([["p", "inferred"]]);
    expect(assignSources(library.context, [a], "p").results[0]?.change).toBe("upgraded_from_inferred");
    expect(membership(a)).toEqual([["p", "explicit"]]);
    applyEnrichment(library.context, {
      ...fakeEnrichment(prepareEnrichment(library.context, a)),
      project_suggestions: [project.id],
    });
    expect(membership(a)).toEqual([["p", "explicit"]]);
    unassignSources(library.context, [a], "p");
    const receipt = applyEnrichment(library.context, {
      ...fakeEnrichment(prepareEnrichment(library.context, a)),
      project_suggestions: [project.id],
    });
    expect(receipt.inferred_projects).toEqual([]);
    expect(receipt.warnings.join(" ")).toMatch(/removed this source/);
    expect(membership(a)).toEqual([]);
    assignSources(library.context, [a], "p");
    expect(membership(a)).toEqual([["p", "explicit"]]);
  });

  it("rejects unknown and trashed sources without partial changes", () => {
    library = createTestLibrary();
    const a = saved("keep");
    const b = saved("trashed");
    changeSourcePolicy(library.context, b, "trash", { confirm: true });
    expect(() => assignSources(library.context, [a, b], "p")).toThrow(/trashed/);
    expect(() => assignSources(library.context, [a, "S-01M3G9NPX0XNVPV0NJTSNDH79K"], "p")).toThrow(/No source/);
    expect(membership(a)).toEqual([]);
    expect(listProjectViews(library.context)).toEqual([]);
    expect(() => unassignSources(library.context, [a], "missing")).toThrow(/No project/);
  });
});
