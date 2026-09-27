import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifact, freshness, materializeArtifact, requireArtifact } from "../../src/app/artifacts.js";
import { capture } from "../../src/app/capture.js";
import { prepareEvidence } from "../../src/app/evidence.js";
import { applyHostExtraction } from "../../src/app/extract.js";
import { datasetView, queryTables } from "../../src/app/tables.js";
import { writeFixture } from "../helpers/files.js";
import { cli, createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;
let dir: string;

beforeEach(() => {
  library = createTestLibrary();
  dir = mkdtempSync(join(tmpdir(), "miosotis-tables-"));
});

afterEach(() => {
  library.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const HEADER = ["Event", "Customer", "Installed"];
const EVENTS = [
  ["E1", "Acme", "2026-01-05"],
  ["E2", "Beta", "2026-01-20"],
  ["E3", "Acme", "2026-02-10"],
  ["E4", "Gamma", "2026-03-02"],
  ["E5", "Beta", "2026-03-15"],
];

/** Saves a monthly cumulative snapshot workbook and submits its table as the host would. */
function snapshot(month: string, rows: string[][]) {
  const file = capture(library.context, {
    attachments: [{ path: writeFixture(dir, `installs-${month}.xlsx`, Buffer.from(`PK\u0003\u0004 fake ${month}`)) }],
  }).sources[0];
  applyHostExtraction(library.context, {
    source_ref: { id: file?.id ?? "", version: 1, payload_sha256: file?.sha256 ?? "" },
    method: { tool: "openpyxl", version: "3.1.5" },
    text: [HEADER, ...rows].map((row) => row.join("\t")).join("\n"),
    tables: [
      { name: "Installs", locator: { sheet: "Installs", range: `A1:C${rows.length + 1}` }, columns: HEADER, rows },
    ],
  });
  return file?.id ?? "";
}

describe("deterministic tables end to end (scenario H)", () => {
  it("computes monthly new installations from cumulative snapshots, freezes, cites, and tracks input changes", () => {
    const jan = snapshot("jan", EVENTS.slice(0, 2));
    const feb = snapshot("feb", EVENTS.slice(0, 3));
    const mar = snapshot("mar", EVENTS);
    const result = queryTables(library.context, {
      inputs: [{ ref: jan }, { ref: feb }, { ref: mar }],
      dedupe: { by: ["Event"] },
      group_by: [{ column: "Installed", grain: "month", as: "month" }],
      aggregates: [{ op: "count", as: "new installations" }],
      note: "Cumulative snapshots; deduped by event ID; grouped by install date.",
      save: true,
    });
    expect(result.rows).toEqual([
      ["2026-01", 2],
      ["2026-02", 1],
      ["2026-03", 2],
    ]);
    expect(result.dataset_id).toMatch(/^T-/);
    expect(result.lineage[1]?.rows).toEqual([`${feb}@v1 Installs!4`]);

    const evidence = prepareEvidence(library.context, {
      request: "monthly installs",
      datasets: [result.dataset_id ?? ""],
    });
    expect(evidence.items[0]).toMatchObject({ kind: "dataset", excerpt: expect.stringContaining("2026-02 | 1") });
    const artifact = createArtifact(library.context, {
      evidence_run_id: evidence.id,
      intent: "review",
      title: "New installations per month",
      request: "monthly installs",
      markdown: `| month | new |\n|---|---|\n| 2026-01 | 2 |\n| 2026-02 | 1 |\n| 2026-03 | 2 |\n\nCounted by miosotis from the snapshots [@${evidence.items[0]?.handle}].`,
    });
    const { path } = materializeArtifact(library.context, artifact.id);
    const page = readFileSync(join(path, "..", "sources", `${result.dataset_id}.html`), "utf8");
    expect(page).toContain("computed by miosotis, not by the model");
    expect(page).toContain("Installs!4");
    expect(readFileSync(path, "utf8")).toContain(`sources/${result.dataset_id}.html`);
    expect(freshness(library.context, requireArtifact(library.context, artifact.id))).toEqual([]);

    applyHostExtraction(library.context, {
      source_ref: { id: feb, version: 1, payload_sha256: getSha(feb) },
      method: { tool: "openpyxl", version: "3.1.5" },
      text: "re-extracted",
      tables: [{ name: "Installs", columns: HEADER, rows: EVENTS.slice(0, 2) }],
    });
    expect(
      freshness(library.context, requireArtifact(library.context, artifact.id)).map((signal) => signal.kind),
    ).toContain("dataset_inputs_changed");
    expect(datasetView(library.context, result.dataset_id ?? "").rows).toEqual(result.rows);
  });

  it("explains missing tables, ambiguous inputs, and unknown columns", () => {
    const text = capture(library.context, {
      attachments: [{ path: writeFixture(dir, "plain.pdf", Buffer.from("%PDF-1.7 x")) }],
    }).sources[0]?.id;
    expect(() => queryTables(library.context, { inputs: [{ ref: text ?? "" }] })).toThrow(/no extracted tables/);
    const jan = snapshot("jan", EVENTS.slice(0, 2));
    expect(() => queryTables(library.context, { inputs: [{ ref: jan, table: "Nope" }] })).toThrow(/No table "Nope"/);
    expect(() => queryTables(library.context, { inputs: [{ ref: jan }], group_by: [{ column: "Month" }] })).toThrow(
      /Unknown column/,
    );
    expect(() => queryTables(library.context, { inputs: [{ ref: jan }], aggregates: [{ op: "sum" }] })).toThrow(
      /needs a column/,
    );
    const dataset = queryTables(library.context, { inputs: [{ ref: jan }], aggregates: [{ op: "count" }], save: true });
    const evidence = prepareEvidence(library.context, { request: "x", datasets: [dataset.dataset_id ?? ""] });
    const receipt = createArtifact(library.context, {
      evidence_run_id: evidence.id,
      intent: "review",
      title: "t",
      request: "x",
      markdown: "| a |\n|---|\n| 2 | [@c1]",
    });
    expect(receipt.warnings.join(" ")).toMatch(/\[@c1\] were not recognized/);
  });

  it("runs through the CLI and returns warnings in the envelope", async () => {
    const jan = snapshot("jan", EVENTS.slice(0, 2));
    const feb = snapshot("feb", EVENTS.slice(0, 3));
    const request = join(dir, "q.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(request, JSON.stringify({ inputs: [{ ref: jan }, { ref: feb }], aggregates: [{ op: "count" }] }));
    const run = await cli(library.env, "table", "query", "--request-file", request, "--json");
    const envelope = run.json();
    expect(envelope.data.rows).toEqual([[5]]);
    expect(JSON.stringify(envelope)).toContain("without dedupe");
  });
});

function getSha(sourceId: string): string {
  const row = library.context.db.get<{ blob_sha256: string }>(
    "SELECT blob_sha256 FROM version_payloads WHERE source_id = ?",
    [sourceId],
  );
  return row?.blob_sha256 ?? "";
}
