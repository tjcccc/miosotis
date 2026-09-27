import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactView, createArtifact, exportBundle, materializeArtifact } from "../../src/app/artifacts.js";
import { createBackup, verifyBackup } from "../../src/app/backup.js";
import { capture } from "../../src/app/capture.js";
import { prepareEvidence } from "../../src/app/evidence.js";
import { PNG_1X1, writeFixture } from "../helpers/files.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;
let dir: string;

beforeEach(() => {
  library = createTestLibrary();
  dir = mkdtempSync(join(tmpdir(), "miosotis-afiles-"));
});

afterEach(() => {
  library.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function base() {
  const id = capture(library.context, { text: "Deck notes: genre split 310 vs 240." }).sources[0]?.id ?? "";
  const evidence = prepareEvidence(library.context, { request: "deck", source_refs: [{ ref: id }] });
  return {
    evidence_run_id: evidence.id,
    intent: "analysis" as const,
    title: "Bestsellers deck",
    request: "make a deck",
    markdown: "Ten slides summarizing the genre split [@c1].",
  };
}

const PPTX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("ppt/slides/slide1.xml [Content_Types].xml"),
]);

describe("artifact files", () => {
  it("stores host-built outputs with the artifact, lists them, and copies them into the folder", async () => {
    const receipt = createArtifact(library.context, {
      ...base(),
      files: [
        { path: writeFixture(dir, "deck.pptx", PPTX), role: "primary" },
        { path: writeFixture(dir, "chart.png", PNG_1X1) },
      ],
    });
    expect(receipt.files.map((f) => [f.filename, f.role])).toEqual([
      ["deck.pptx", "primary"],
      ["chart.png", "supporting"],
    ]);
    const view = artifactView(library.context, receipt.id);
    expect(view.files[0]).toMatchObject({
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const { path } = materializeArtifact(library.context, receipt.id);
    expect(readFileSync(join(path, "..", "files", "0-deck.pptx"))).toEqual(PPTX);
    expect(readFileSync(path, "utf8")).toContain('href="files/0-deck.pptx"');
    expect(() =>
      library.context.db.run("UPDATE artifact_files SET filename = 'x' WHERE artifact_id = ?", [receipt.id]),
    ).toThrow(/immutable/);
    const bundle = exportBundle(library.context, receipt.id, join(dir, "out"));
    expect(existsSync(join(bundle.path, "..", "files", "1-chart.png"))).toBe(true);
    const backup = await createBackup(library.context, { output: join(dir, "backups") });
    expect(verifyBackup(backup.path).manifest.blobs.count).toBeGreaterThanOrEqual(2);
  });

  it("changes the content hash when a file differs", () => {
    const a = createArtifact(library.context, { ...base(), files: [{ path: writeFixture(dir, "a.png", PNG_1X1) }] });
    const b = createArtifact(library.context, { ...base(), files: [{ path: writeFixture(dir, "b.pptx", PPTX) }] });
    expect(a.content_hash).not.toBe(b.content_hash);
  });

  it("rejects macros, scripts, and executables; warns on PDF JavaScript", () => {
    const attempt = (name: string, bytes: Buffer | string) =>
      createArtifact(library.context, { ...base(), files: [{ path: writeFixture(dir, name, bytes) }] });
    expect(() => attempt("deck.pptm", PPTX)).toThrow(/macro-enabled/);
    expect(() => attempt("sneaky.pptx", Buffer.concat([PPTX, Buffer.from("ppt/vbaProject.bin")]))).toThrow(/VBA macro/);
    expect(() =>
      attempt("chart.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    ).toThrow(/SVG/);
    expect(() => attempt("run.sh", "#!/bin/sh\necho hi")).toThrow(/executables and scripts/);
    const pdf = attempt("r.pdf", "%PDF-1.7 /JavaScript (app.alert(1))");
    expect(pdf.warnings.join(" ")).toMatch(/contains JavaScript/);
    expect(library.context.db.get<{ n: number }>("SELECT count(*) AS n FROM artifacts")?.n).toBe(1);
  });
});
