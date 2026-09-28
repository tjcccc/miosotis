import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifact } from "../../src/app/artifacts.js";
import { capture } from "../../src/app/capture.js";
import { prepareEvidence } from "../../src/app/evidence.js";
import { correctSource } from "../../src/app/governance.js";
import { removeItems } from "../../src/app/trash.js";
import { MIXED_TEXT } from "../fixtures/multilingual.js";
import { PNG_1X1, writeFixture } from "../helpers/files.js";
import { cli, createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;
let dir: string;

beforeEach(() => {
  library = createTestLibrary();
  dir = mkdtempSync(join(tmpdir(), "miosotis-export-"));
});

afterEach(() => {
  library.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("export --all", () => {
  it("writes every revision verbatim, original files, artifacts, and an index, without trash by default", async () => {
    const { context } = library;
    const group = capture(context, {
      text: MIXED_TEXT,
      project: "marketing",
      attachments: [
        { path: writeFixture(dir, "notes.md", "# Notes\n\nplain text\n") },
        { path: writeFixture(dir, "chart.png", PNG_1X1) },
      ],
    });
    const [comment, notes, image] = group.sources;
    correctSource(context, comment?.id ?? "", 1, { text: `${MIXED_TEXT} (corrected)` });
    const trashed = capture(context, { text: "in the trash" }).sources[0]?.id ?? "";
    removeItems(context, [trashed], { confirm: true });
    const evidence = prepareEvidence(context, { request: "r", source_refs: [{ ref: comment?.id ?? "" }] });
    const artifact = createArtifact(context, {
      evidence_run_id: evidence.id,
      intent: "review",
      title: "Review",
      request: "r",
      format: "html",
      html: '<!doctype html><html><body><p data-cite="c1">page</p></body></html>',
      markdown: `Summary [@${evidence.items[0]?.handle}].`,
      files: [{ path: writeFixture(dir, "deck.pdf", "%PDF-1.4 deck"), role: "primary" }],
    });

    const run = await cli(library.env, "export", "--all", "--output", join(dir, "out"), "--json");
    expect(run.json()).toMatchObject({ ok: true, data: { sources: 3, artifacts: 1 } });
    const root = run.json().data.path as string;
    expect(readdirSync(join(dir, "out"))).toEqual([root.split("/").pop()]);
    const read = (path: string) => readFileSync(join(root, path));
    const index = JSON.parse(read("index.json").toString("utf8"));
    expect(index.schema).toBe("miosotis.export.v1");
    const commentEntry = index.sources.find((source: { id: string }) => source.id === comment?.id);
    expect(commentEntry.projects).toEqual(["marketing"]);
    expect(read(commentEntry.revisions[0].path).toString("utf8")).toBe(MIXED_TEXT);
    expect(read(commentEntry.revisions[1].path).toString("utf8")).toBe(`${MIXED_TEXT} (corrected)`);
    const imageEntry = index.sources.find((source: { id: string }) => source.id === image?.id);
    expect(read(imageEntry.files[0].path).equals(PNG_1X1)).toBe(true);
    const notesEntry = index.sources.find((source: { id: string }) => source.id === notes?.id);
    expect(read(notesEntry.extracted_text).toString("utf8")).toContain("plain text");
    expect(index.sources.some((source: { id: string }) => source.id === trashed)).toBe(false);
    const artifactEntry = index.artifacts[0];
    expect(artifactEntry.id).toBe(artifact.id);
    expect(read(artifactEntry.content).toString("utf8")).toContain("Summary [@c1]");
    expect(artifactEntry.page).toMatch(/page\.html\.txt$/);
    expect(read(artifactEntry.files[0].path).toString("utf8")).toBe("%PDF-1.4 deck");
    expect(read("README.md").toString("utf8")).toContain(comment?.id ?? "");

    const withTrash = await cli(
      library.env,
      "export",
      "--all",
      "--include-trash",
      "--output",
      join(dir, "t"),
      "--json",
    );
    expect(withTrash.json().data.sources).toBe(4);
    expect((await cli(library.env, "export", "--output", join(dir, "x"), "--json")).json().error?.code).toBe("usage");
    expect(existsSync(join(dir, "x"))).toBe(false);
  });
});
