import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactSources,
  artifactView,
  createArtifact,
  exportBundle,
  listArtifacts,
  materializeArtifact,
} from "../../src/app/artifacts.js";
import { createBackup, restoreBackup } from "../../src/app/backup.js";
import { capture } from "../../src/app/capture.js";
import { runDoctor } from "../../src/app/doctor.js";
import { applyEnrichment, prepareEnrichment } from "../../src/app/enrich.js";
import { evidenceView, prepareEvidence } from "../../src/app/evidence.js";
import { applyHostExtraction } from "../../src/app/extract.js";
import { changeSourcePolicy, correctSource } from "../../src/app/governance.js";
import { type PurgePlan, resumePurge } from "../../src/app/purge.js";
import { search } from "../../src/app/search.js";
import { getSourceView } from "../../src/app/sources.js";
import { queryTables } from "../../src/app/tables.js";
import { emptyTrash, removeItems, restoreItems, trashList } from "../../src/app/trash.js";
import { undoLastCapture } from "../../src/app/undo.js";
import { isMiosotisError } from "../../src/domain/errors.js";
import { PNG_1X1, writeFixture } from "../helpers/files.js";
import { cli, createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;
let dir: string;

beforeEach(() => {
  library = createTestLibrary();
  dir = mkdtempSync(join(tmpdir(), "miosotis-purge-"));
});

afterEach(() => {
  library.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

/** A token whose trigrams appear nowhere else, so any leftover byte or index entry is detectable. */
const MARK = "Qvxjzw";
const SHEET_TEXT = `Item\t${MARK} total\nA\t${MARK} cell`;

function planError(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (isMiosotisError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an error");
}

function allFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? allFiles(path) : [path];
  });
}

/** Seeds the marker into every place content can land: text, files, derivations, receipts, reasons, outputs. */
function seed() {
  const { context } = library;
  const group = capture(context, {
    text: `Meeting note about ${MARK} plans`,
    attachments: [
      { path: writeFixture(dir, `${MARK}-notes.md`, `# Notes\n\nThe ${MARK} budget is 40.\n`) },
      { path: writeFixture(dir, `${MARK}-sheet.xlsx`, Buffer.from(`PK\u0003\u0004 ${MARK}`)) },
      { path: writeFixture(dir, `${MARK}.png`, PNG_1X1) },
    ],
  });
  const [comment, notes, sheet, image] = group.sources;
  const ids = { comment: comment?.id ?? "", notes: notes?.id ?? "", sheet: sheet?.id ?? "", image: image?.id ?? "" };
  applyHostExtraction(context, {
    source_ref: { id: ids.sheet, version: 1, payload_sha256: sheet?.sha256 ?? "" },
    method: { tool: "openpyxl", version: "3.1.5" },
    text: SHEET_TEXT,
    segments: [{ start: 0, end: SHEET_TEXT.length, locator: { sheet: `${MARK}Sheet` } }],
    tables: [
      {
        name: `${MARK}Sheet`,
        locator: { sheet: `${MARK}Sheet`, range: "A1:B2" },
        columns: ["Item", `${MARK} total`],
        rows: [["A", `${MARK} cell`]],
      },
    ],
  });
  applyEnrichment(context, {
    source_ref: prepareEnrichment(context, ids.image).source_ref,
    interpretations: [{ payload_sha256: image?.sha256 ?? "", description: `A chart labeled ${MARK}` }],
  });
  const prepared = prepareEnrichment(context, ids.comment);
  applyEnrichment(context, {
    source_ref: prepared.source_ref,
    title: `${MARK} meeting`,
    abstract: `About ${MARK}.`,
    terms: [MARK.toLowerCase(), "meeting"],
    events: [
      {
        title: `${MARK} meeting`,
        start: { date: "2026-10-05", part_of_day: "morning" },
        location: `${MARK} room`,
        phrase: MARK,
      },
    ],
  });
  changeSourcePolicy(context, ids.comment, "ignore", { reason: `hide ${MARK} for now` });
  changeSourcePolicy(context, ids.comment, "include");
  correctSource(context, ids.comment, 1, {
    text: `Meeting note about ${MARK} plans, corrected`,
    reason: `fix ${MARK}`,
  });
  const dataset = queryTables(context, {
    inputs: [{ ref: ids.sheet }],
    filters: [{ column: `${MARK} total`, op: "eq", value: `${MARK} cell` }],
    aggregates: [{ op: "count" }],
    save: true,
  });
  const evidence = prepareEvidence(context, {
    request: `Review ${MARK}`,
    source_refs: [{ ref: ids.comment }, { ref: ids.image }],
    quotes: [{ ref: ids.notes, quote: `${MARK} budget` }],
    datasets: [dataset.dataset_id ?? ""],
  });
  const handles = evidence.items.map((item) => `[@${item.handle}]`).join(" ");
  const artifact = createArtifact(context, {
    evidence_run_id: evidence.id,
    intent: "review",
    title: `${MARK} review`,
    request: `Review ${MARK}`,
    markdown: `The ${MARK} budget is 40 ${handles}.`,
    limitations: [`Only ${MARK} notes`],
    files: [{ path: writeFixture(dir, `${MARK}-deck.pdf`, `%PDF-1.4 ${MARK}`), role: "primary" }],
  });
  materializeArtifact(context, artifact.id);
  // A run the host prepared but never turned into an artifact still holds the request and queries.
  const unused = prepareEvidence(context, { request: `What about ${MARK}?`, queries: [MARK.toLowerCase()] });
  return {
    ids,
    datasetId: dataset.dataset_id ?? "",
    artifactId: artifact.id,
    runId: evidence.id,
    unusedRunId: unused.id,
  };
}

/**
 * Index entries for the marker: live terms (fts5vocab) plus raw trigram bytes in the index segments,
 * where deleted entries linger until a merge. fts5vocab alone does not see those.
 */
function trigramsLeft(): number {
  const { db } = library.context;
  const lowerMark = MARK.toLowerCase();
  const grams = [0, 1, 2, 3].map((index) => lowerMark.slice(index, index + 3));
  const raw = db
    .all<{ block: Uint8Array }>("SELECT block FROM search_fts_data")
    .filter((row) => grams.some((gram) => Buffer.from(row.block).includes(gram))).length;
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.purge_vocab USING fts5vocab(main, search_fts, 'row')");
  const lower = MARK.toLowerCase();
  const trigrams = [0, 1, 2, 3].map((index) => lower.slice(index, index + 3));
  return (
    raw +
    (db.get<{ n: number }>(
      `SELECT count(*) AS n FROM temp.purge_vocab WHERE term IN (${trigrams.map(() => "?").join(", ")})`,
      trigrams,
    )?.n ?? 0)
  );
}

/** Moves items to the trash, as `miosotis remove … --confirm` does. */
function remove(ids: string[], withArtifacts = false) {
  return removeItems(library.context, ids, { withArtifacts, confirm: true });
}

/** The plan `trash empty` shows before anything is deleted. */
function reviewEmpty(ids: string[], keep = false): PurgePlan {
  const error = planError(() => emptyTrash(library.context, ids, { keepArtifacts: keep }));
  expect(error.code).toBe("confirmation_required");
  return (error.details as { plan: PurgePlan }).plan;
}

function empty(ids: string[], keep = false) {
  return emptyTrash(library.context, ids, { keepArtifacts: keep, confirm: true, plan: reviewEmpty(ids, keep).plan_id });
}

function noTraceUnder(root: string): void {
  for (const file of allFiles(root)) {
    const bytes = readFileSync(file);
    expect(bytes.includes(MARK), file).toBe(false);
    expect(bytes.includes(MARK.toLowerCase()), file).toBe(false);
  }
}

describe("trash: remove, restore", () => {
  it("previews a removal, moves citing artifacts only on request, and restores them together", () => {
    const { ids, artifactId } = seed();
    const preview = planError(() => removeItems(library.context, [ids.comment]));
    expect(preview.code).toBe("confirmation_required");
    expect(preview.details).toMatchObject({ citing_artifacts: [{ id: artifactId, action: "keep" }] });

    const kept = remove([ids.comment]);
    expect(kept).toMatchObject({
      removed: { sources: [ids.comment], artifacts: [] },
      kept_citing_artifacts: [artifactId],
    });
    expect(materializeArtifact(library.context, artifactId).notices.join(" ")).toMatch(/in the trash/);
    restoreItems(library.context, [ids.comment]);

    remove([ids.comment], true);
    expect(trashList(library.context)).toMatchObject({
      total: 2,
      sources: [{ id: ids.comment, cited_by: [artifactId] }],
      artifacts: [{ id: artifactId }],
    });
    // Restoring the Source brings back the artifact removed with it.
    expect(restoreItems(library.context, [ids.comment]).restored).toEqual({
      sources: [ids.comment],
      artifacts: [artifactId],
    });
    expect(trashList(library.context).total).toBe(0);
  });

  it("restores everything only after confirmation, and points folder paths to backup restore", () => {
    const a = capture(library.context, { text: "note one" }).sources[0]?.id ?? "";
    const b = capture(library.context, { text: "note two" }).sources[0]?.id ?? "";
    remove([a, b]);
    expect(planError(() => restoreItems(library.context, [])).code).toBe("confirmation_required");
    expect(restoreItems(library.context, [], { confirm: true }).restored.sources.sort()).toEqual([a, b].sort());
    expect(planError(() => restoreItems(library.context, ["./backups/x"])).message).toMatch(/backup restore/);
  });
});

describe("trash empty (permanent deletion)", () => {
  it("deletes only trashed items after a reviewed plan, leaving no trace in the library files (scenario F)", () => {
    const { ids, datasetId, artifactId, runId, unusedRunId } = seed();
    const other = capture(library.context, { text: "An unrelated note that stays" }).sources[0]?.id ?? "";
    expect(trigramsLeft()).toBeGreaterThan(0);
    const dataDir = library.context.config.library.dataDir;
    const holders = () => allFiles(dataDir).filter((file) => readFileSync(file).includes(MARK));
    expect(holders().length).toBeGreaterThan(3);
    const all = [ids.comment, ids.notes, ids.sheet, ids.image];

    expect(planError(() => emptyTrash(library.context, all)).message).toMatch(/not in the trash/);
    remove([...all, artifactId]);
    // Emptying only the Sources: the trashed artifact that cites them needs a decision.
    const partial = reviewEmpty(all);
    expect(partial.needs_artifact_choice).toBe(true);
    expect(partial.datasets).toEqual([datasetId]);
    expect(partial.artifacts).toMatchObject([{ id: artifactId, action: "undecided" }]);
    expect(planError(() => emptyTrash(library.context, all, { confirm: true, plan: partial.plan_id })).code).toBe(
      "usage",
    );

    const plan = reviewEmpty([]);
    expect(plan.artifacts).toMatchObject([{ id: artifactId, action: "delete" }]);
    expect(planError(() => emptyTrash(library.context, [], { confirm: true })).code).toBe("usage");
    expect(planError(() => emptyTrash(library.context, [], { confirm: true, plan: "000000000000" })).code).toBe(
      "conflict",
    );
    const receipt = emptyTrash(library.context, [], { confirm: true, plan: plan.plan_id });
    expect(receipt.purged).toEqual({ sources: [...all].sort(), artifacts: [artifactId], datasets: [datasetId] });
    expect(receipt.compacted).toBe(true);
    expect(receipt.files_erased).toBeGreaterThanOrEqual(6);

    expect(holders()).toEqual([]);
    noTraceUnder(dataDir);
    expect(trigramsLeft()).toBe(0);
    expect(existsSync(join(library.context.config.library.artifactsDir, artifactId))).toBe(false);

    // Tombstones explain what happened; nothing can come back; the untouched note is still there.
    expect(getSourceView(library.context, ids.comment)).toMatchObject({ retention: "purged", text: null });
    expect(artifactView(library.context, artifactId)).toMatchObject({ title: null });
    expect(evidenceView(library.context, runId).request).toBe("");
    expect(evidenceView(library.context, unusedRunId).request).toBe("");
    expect(planError(() => restoreItems(library.context, [ids.comment])).message).toMatch(/deleted permanently/);
    expect(trashList(library.context).total).toBe(0);
    expect(search(library.context, { query: "unrelated" }).hits.map((hit) => hit.source_id)).toEqual([other]);
    expect(runDoctor({ env: library.env, version: "test" }).checks.filter((check) => check.status === "fail")).toEqual(
      [],
    );
    expect(emptyTrash(library.context, []).note).toBe("The trash is empty.");
  });

  it("keeps chosen artifacts viewable with a notice and keeps files shared with surviving sources", () => {
    const { context } = library;
    const shared = writeFixture(dir, "shared.md", "Shared bytes in two captures\n");
    const first = capture(context, { text: "first comment", attachments: [{ path: shared }] }).sources;
    const second = capture(context, { attachments: [{ path: shared }] }).sources[0];
    const target = first[1]?.id ?? "";
    const cite = (request: string) => {
      const evidence = prepareEvidence(context, { request, source_refs: [{ ref: target }] });
      return createArtifact(context, {
        evidence_run_id: evidence.id,
        intent: "review",
        title: request,
        request,
        markdown: `Shared bytes [@${evidence.items[0]?.handle}].`,
      });
    };
    const artifact = cite("shared");
    remove([target]);
    const plan = reviewEmpty([target], true);
    expect(plan.linked_sources_not_included).toEqual([
      { id: first[0]?.id, relation: "comment", retention: "retained" },
    ]);
    expect(plan.files.kept_shared).toBe(1);
    // A new citation after the review changes the plan, so the old ID no longer applies.
    restoreItems(context, [target]);
    cite("again");
    remove([target]);
    expect(
      planError(() => emptyTrash(context, [target], { keepArtifacts: true, confirm: true, plan: plan.plan_id })).code,
    ).toBe("conflict");
    empty([target], true);

    expect(getSourceView(context, second?.id ?? "").text).toContain("Shared bytes");
    const { path, notices } = materializeArtifact(context, artifact.id);
    expect(notices.join(" ")).toMatch(/permanently deleted/);
    const page = readFileSync(join(path, "..", "sources", `${target}@v1.html`), "utf8");
    expect(page).toContain("purged");
    expect(page).not.toContain("Shared bytes");
  });

  it("keeps chosen artifacts readable after their dataset and image are deleted, then deletes them alone", () => {
    const { context } = library;
    const { ids, artifactId, runId } = seed();
    const all = [ids.comment, ids.notes, ids.sheet, ids.image];
    remove(all);
    empty(all, true);

    const { path, notices } = materializeArtifact(context, artifactId);
    expect(notices.join(" ")).toMatch(/permanently deleted/);
    expect(notices.join(" ")).toMatch(/Dataset T-\S+ was purged/);
    noTraceUnder(join(path, "..", "sources"));
    // The kept artifact keeps its own body (the user chose that); the run it uses keeps its request.
    expect(readFileSync(path, "utf8")).toContain(MARK);
    expect(evidenceView(context, runId).items.every((item) => item.excerpt === null)).toBe(true);
    expect(artifactSources(context, artifactId).cited.every((row) => row.retention === "purged")).toBe(true);
    expect(artifactView(context, artifactId).title).toContain(MARK);
    expect(listArtifacts(context).artifacts.map((row) => row.id)).toContain(artifactId);
    exportBundle(context, artifactId, join(dir, "export"));

    remove([artifactId]);
    empty([artifactId]);
    noTraceUnder(context.config.library.dataDir);
    expect(evidenceView(context, runId).request).toBe("");
  });

  it("deletes an undone capture; a replayed capture key cannot bring it back", () => {
    const { context } = library;
    const saved = capture(context, { text: `oops ${MARK}`, idempotency_key: "save-key-0001" }).sources[0]?.id ?? "";
    undoLastCapture(context, { confirm: true });
    empty([saved]);
    expect(getSourceView(context, saved)).toMatchObject({ retention: "purged", text: null });
    const replay = planError(() => capture(context, { text: `oops ${MARK}`, idempotency_key: "save-key-0001" }));
    expect(replay.code).toBe("conflict");
    expect(resumePurge(context)).toMatchObject({ files_erased: 0, compacted: true });
  });

  it("clears index terms left by edits made before FTS secure-delete was enabled (an upgraded library)", () => {
    const { context } = library;
    context.db.run("INSERT INTO search_fts (search_fts, rank) VALUES ('secure-delete', 0)");
    const id = capture(context, { text: `first ${MARK} draft` }).sources[0]?.id ?? "";
    correctSource(context, id, 1, { text: `second ${MARK} draft` });
    changeSourcePolicy(context, id, "trash", { confirm: true });
    changeSourcePolicy(context, id, "restore");
    remove([id]);
    empty([id]);
    expect(trigramsLeft()).toBe(0);
    noTraceUnder(context.config.library.dataDir);
  });

  it("round-trips a library with deleted items through backup and restore", async () => {
    const { ids } = seed();
    remove([ids.notes]);
    empty([ids.notes], true);
    const backup = await createBackup(library.context, { output: join(dir, "backups") });
    const restored = restoreBackup(backup.path, { dataDir: join(dir, "restored"), env: library.env });
    expect(restored.counts).toBeDefined();
  });

  it("runs remove → trash list → trash empty → confirm through the CLI", async () => {
    const id = capture(library.context, { text: "cli delete target" }).sources[0]?.id ?? "";
    expect((await cli(library.env, "remove", id, "--json")).json().error?.code).toBe("confirmation_required");
    expect((await cli(library.env, "remove", id, "--confirm", "--json")).json().ok).toBe(true);
    expect((await cli(library.env, "trash", "list", "--json")).json().data.sources[0].id).toBe(id);
    const review = await cli(library.env, "trash", "empty", "--json");
    expect(review.code).not.toBe(0);
    const planId =
      (review.json().error as { details?: { plan?: { plan_id?: string } } } | undefined)?.details?.plan?.plan_id ?? "";
    expect(planId).toMatch(/^[0-9a-f]{12}$/);
    const done = await cli(library.env, "trash", "empty", "--confirm", "--plan", planId, "--json");
    expect(done.json()).toMatchObject({ ok: true, data: { purged: { sources: [id] } } });
    expect((await cli(library.env, "restore", id, "--json")).json().error?.message).toMatch(/deleted permanently/);
  });
});
