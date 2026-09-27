import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactSources,
  artifactView,
  createArtifact,
  exportArtifact,
  freshness,
  listArtifacts,
  materializeArtifact,
  requireArtifact,
  trashArtifact,
} from "../../src/app/artifacts.js";
import { capture } from "../../src/app/capture.js";
import { prepareEvidence } from "../../src/app/evidence.js";
import { changeSourcePolicy, correctSource } from "../../src/app/governance.js";
import { listProjectViews } from "../../src/app/projects.js";
import { search } from "../../src/app/search.js";
import { getSourceView, listSourceViews } from "../../src/app/sources.js";
import { fakeArtifact } from "../helpers/fake-agent.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

afterEach(() => library?.cleanup());

function setup() {
  library = createTestLibrary();
  const id =
    capture(library.context, { text: "Regeneration must be explicit. 用户决定何时重新生成。", project: "p" }).sources[0]
      ?.id ?? "";
  const evidence = prepareEvidence(library.context, {
    request: "How do artifacts update?",
    project: "p",
    source_refs: [{ ref: id }],
  });
  return { id, evidence };
}

function kinds(artifactId: string): string[] {
  return freshness(library.context, requireArtifact(library.context, artifactId)).map((signal) => signal.kind);
}

describe("artifacts", () => {
  it("publishes frozen content with validated citations and a self-contained folder", () => {
    const { id, evidence } = setup();
    const receipt = createArtifact(library.context, fakeArtifact(evidence, "Update policy"));
    expect(receipt.citations).toEqual(["c1"]);
    const view = artifactView(library.context, receipt.id);
    expect(view.citations).toEqual([expect.objectContaining({ handle: "c1", ref: `${id}@v1` })]);
    expect(view.freshness).toEqual([]);
    const { path } = materializeArtifact(library.context, receipt.id);
    const html = readFileSync(path, "utf8");
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/<script/i);
    expect(existsSync(join(path, "..", "sources", `${id}@v1.html`))).toBe(true);
  });

  it("rejects fabricated handles, other runs' handles, missing revisions, and self-links", () => {
    const { id, evidence } = setup();
    const other = prepareEvidence(library.context, {
      request: "other",
      source_refs: [{ ref: id }, { ref: id, chunk: 0 }],
      quotes: [{ ref: id, quote: "Regeneration" }],
    });
    expect(other.items.map((item) => item.handle)).toEqual(["c1", "c2"]);
    const base = fakeArtifact(evidence, "t");
    expect(() => createArtifact(library.context, { ...base, markdown: "claim [@c7]" })).toThrow(/not in evidence run/);
    expect(() => createArtifact(library.context, { ...base, evidence_run_id: "E-01M3G9NPX0XNVPV0NJTSNDH79K" })).toThrow(
      /No evidence run/,
    );
    const code = createArtifact(library.context, { ...base, markdown: "`[@c9]` real [@c1]" });
    expect(code.citations).toEqual(["c1"]);
    expect(() =>
      library.context.db.run("INSERT INTO artifact_citations (artifact_id, run_id, handle) VALUES (?, ?, 'c2')", [
        code.id,
        other.id,
      ]),
    ).toThrow(/FOREIGN KEY/);
    expect(() => prepareEvidence(library.context, { request: "r", source_refs: [{ ref: `${id}@v9` }] })).toThrow(
      /No version 9/,
    );
    expect(() =>
      library.context.db.run(
        "INSERT INTO artifact_links (parent_id, child_id, kind, created_at) VALUES (?, ?, 'derived_from', 't')",
        [code.id, code.id],
      ),
    ).toThrow(/CHECK/);
  });

  it("refuses to cite a source that was ignored after evidence was gathered", () => {
    const { id, evidence } = setup();
    changeSourcePolicy(library.context, id, "ignore", { reason: "wrong data" });
    expect(() => createArtifact(library.context, fakeArtifact(evidence, "t"))).toThrow(/ignored/);
  });

  it("publishes atomically: a failure mid-publish leaves nothing behind", () => {
    const { evidence } = setup();
    library.context.db.exec(
      "CREATE TEMP TRIGGER fail_citation BEFORE INSERT ON artifact_citations BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    expect(() =>
      createArtifact(library.context, { ...fakeArtifact(evidence, "t"), idempotency_key: "atomic-key-1" }),
    ).toThrow(/injected/);
    library.context.db.exec("DROP TRIGGER fail_citation");
    expect(library.context.db.get<{ n: number }>("SELECT count(*) AS n FROM artifacts")?.n).toBe(0);
    expect(
      library.context.db.get<{ n: number }>("SELECT count(*) AS n FROM operations WHERE kind = 'artifact'")?.n,
    ).toBe(0);
    expect(
      createArtifact(library.context, { ...fakeArtifact(evidence, "t"), idempotency_key: "atomic-key-1" }).replayed,
    ).toBe(false);
  });

  it("keeps an artifact frozen across correction, warns, and regenerates with lineage (scenario D)", () => {
    const { id, evidence } = setup();
    const original = createArtifact(library.context, fakeArtifact(evidence, "v1 review"));
    const before = requireArtifact(library.context, original.id);
    expect(() => correctSource(library.context, id, 2, { text: "stale" })).toThrow(/not the expected v2/);
    const correction = correctSource(library.context, id, 1, {
      text: "Regeneration must be explicit and user-initiated.",
    });
    expect(correction.dependent_artifacts).toEqual([
      expect.objectContaining({ artifact_id: original.id, used_version: 1 }),
    ]);
    const after = requireArtifact(library.context, original.id);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.rendered_html).toBe(before.rendered_html);
    expect(artifactView(library.context, original.id).citations[0]?.ref).toBe(`${id}@v1`);
    expect(kinds(original.id)).toEqual(["source_revised"]);
    expect(() =>
      library.context.db.run("UPDATE artifacts SET content_markdown = 'x' WHERE id = ?", [original.id]),
    ).toThrow(/immutable/);
    const fresh = prepareEvidence(library.context, {
      request: "How do artifacts update?",
      project: "p",
      source_refs: [{ ref: id }],
    });
    expect(fresh.items[0]?.ref).toBe(`${id}@v2`);
    const regenerated = createArtifact(library.context, {
      ...fakeArtifact(fresh, "v2 review"),
      derived_from: original.id,
      supersedes: true,
    });
    expect(regenerated.id).not.toBe(original.id);
    expect(artifactView(library.context, regenerated.id).lineage).toMatchObject({
      derived_from: [original.id],
      supersedes: [original.id],
    });
    expect(kinds(original.id)).toEqual(["source_revised", "superseded"]);
    expect(kinds(regenerated.id)).toEqual([]);
    expect(listArtifacts(library.context).total).toBe(2);
  });

  it("signals new material in scope without touching the body (scenario E)", () => {
    const { evidence } = setup();
    const receipt = createArtifact(library.context, fakeArtifact(evidence, "January–June"));
    const hash = requireArtifact(library.context, receipt.id).content_hash;
    capture(library.context, { text: "Out of scope note", project: "elsewhere" });
    expect(kinds(receipt.id)).toEqual([]);
    const july = capture(library.context, { text: "July dataset arrived", project: "p" }).sources[0]?.id ?? "";
    expect(freshness(library.context, requireArtifact(library.context, receipt.id))).toEqual([
      { kind: "new_material", count: 1, scope: "project" },
    ]);
    changeSourcePolicy(library.context, july, "ignore", { reason: "test" });
    expect(kinds(receipt.id)).toEqual([]);
    changeSourcePolicy(library.context, july, "include");
    expect(kinds(receipt.id)).toEqual(["new_material"]);
    expect(requireArtifact(library.context, receipt.id).content_hash).toBe(hash);
  });

  it("applies ignore/include/trash across search, lists, counts, and evidence (scenario F)", () => {
    const { id, evidence } = setup();
    const receipt = createArtifact(library.context, fakeArtifact(evidence, "t"));
    changeSourcePolicy(library.context, id, "ignore", { reason: "incorrect" });
    expect(search(library.context, { query: "重新生成" }).total).toBe(0);
    expect(listSourceViews(library.context).total).toBe(0);
    expect(listSourceViews(library.context, { all: true }).sources[0]).toMatchObject({ inclusion: "ignored" });
    expect(listProjectViews(library.context)[0]?.source_count).toBe(0);
    expect(kinds(receipt.id)).toEqual(["source_unavailable"]);
    expect(artifactSources(library.context, receipt.id).cited[0]).toMatchObject({ inclusion: "ignored" });
    changeSourcePolicy(library.context, id, "include");
    expect(search(library.context, { query: "重新生成" }).total).toBe(1);
    expect(() => changeSourcePolicy(library.context, id, "trash")).toThrow(/needs --confirm/);
    changeSourcePolicy(library.context, id, "trash", { confirm: true });
    expect(search(library.context, { query: "重新生成" }).total).toBe(0);
    expect(getSourceView(library.context, id).text).toContain("Regeneration");
    changeSourcePolicy(library.context, id, "restore");
    expect(search(library.context, { query: "重新生成" }).total).toBe(1);
  });

  it("trashes an artifact without touching its sources; export and open need no model", () => {
    const { id, evidence } = setup();
    const receipt = createArtifact(library.context, fakeArtifact(evidence, "t"));
    const markdown = exportArtifact(library.context, receipt.id, "md").content;
    expect(markdown).toBe(requireArtifact(library.context, receipt.id).content_markdown);
    expect(exportArtifact(library.context, receipt.id, "html").content).toContain("<!doctype html>");
    expect(() => trashArtifact(library.context, receipt.id, { confirm: false })).toThrow(/needs --confirm/);
    trashArtifact(library.context, receipt.id, { confirm: true });
    expect(listArtifacts(library.context).total).toBe(0);
    expect(listArtifacts(library.context, { all: true }).total).toBe(1);
    expect(getSourceView(library.context, id)).toMatchObject({ retention: "retained", inclusion: "included" });
    expect(materializeArtifact(library.context, receipt.id).notices).toEqual(["This artifact is in the trash."]);
  });
});
