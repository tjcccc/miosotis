import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifact, freshness, materializeArtifact, requireArtifact } from "../../src/app/artifacts.js";
import { capture } from "../../src/app/capture.js";
import { prepareEnrichment } from "../../src/app/enrich.js";
import { prepareEvidence } from "../../src/app/evidence.js";
import { applyHostExtraction, pendingExtraction } from "../../src/app/extract.js";
import { search } from "../../src/app/search.js";
import { getSourceView } from "../../src/app/sources.js";
import { PNG_1X1, writeFixture } from "../helpers/files.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;
let dir: string;

beforeEach(() => {
  library = createTestLibrary();
  dir = mkdtempSync(join(tmpdir(), "miosotis-hostx-"));
});

afterEach(() => {
  library.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const PAGE_1 = "Chapter one: the samurai learns to parry.";
const PAGE_2 = "Chapter two: the boss needs twelve retries.";

function savePdf() {
  const receipt = capture(library.context, {
    attachments: [{ path: writeFixture(dir, "guide.pdf", Buffer.from("%PDF-1.7 fake bytes for tests")) }],
  });
  const file = receipt.sources[0];
  return { id: file?.id ?? "", sha: file?.sha256 ?? "", processing: file?.processing };
}

function extract(id: string, sha: string, text: string, extra: Record<string, unknown> = {}) {
  return applyHostExtraction(library.context, {
    source_ref: { id, version: 1, payload_sha256: sha },
    method: { tool: "pdftotext", version: "24.02" },
    text,
    ...extra,
  });
}

describe("host-assisted extraction", () => {
  it("leaves non-builtin files pending for the host and lists them", () => {
    const { id, processing } = savePdf();
    expect(processing).toMatchObject({ extraction: "pending" });
    expect(pendingExtraction(library.context).files.map((file) => file.ref)).toEqual([`${id}@v1`]);
    expect(prepareEnrichment(library.context, id)).toMatchObject({ extraction_needed: true, text_origin: "none" });
  });

  it("stores host-extracted text with page locators; chunks never cross pages", () => {
    const { id, sha } = savePdf();
    const text = `${PAGE_1}\n${PAGE_2}`;
    const receipt = extract(id, sha, text, {
      segments: [
        { start: 0, end: PAGE_1.length + 1, locator: { page: 1 } },
        { start: PAGE_1.length + 1, end: text.length, locator: { page: 2 } },
      ],
    });
    expect(receipt).toMatchObject({ replayed: false, state: "complete", chunks: 2 });
    const view = getSourceView(library.context, id);
    expect(view).toMatchObject({ text_origin: "extracted", text });
    expect(view.extraction).toMatchObject({
      method: "host_agent",
      details: { host_extracted: true, tool: "pdftotext" },
    });
    expect(pendingExtraction(library.context).total).toBe(0);
    expect(search(library.context, { query: "twelve retries" }).hits[0]?.source_id).toBe(id);
    const evidence = prepareEvidence(library.context, {
      request: "boss",
      quotes: [{ ref: id, quote: "twelve retries" }],
    });
    expect(evidence.items[0]).toMatchObject({ kind: "extracted_text", where: "p. 2", excerpt: "twelve retries" });
  });

  it("is idempotent for identical content and supersedes with a freshness notice otherwise", () => {
    const { id, sha } = savePdf();
    const first = extract(id, sha, PAGE_1);
    expect(extract(id, sha, PAGE_1)).toMatchObject({ replayed: true, derivation_id: first.derivation_id });
    const evidence = prepareEvidence(library.context, {
      request: "parry",
      quotes: [{ ref: id, quote: "learns to parry" }],
    });
    const artifact = createArtifact(library.context, {
      evidence_run_id: evidence.id,
      intent: "review",
      title: "Parry",
      request: "parry",
      markdown: `Parry first [@${evidence.items[0]?.handle}].`,
    });
    const second = extract(id, sha, `${PAGE_1} (re-extracted with layout)`, {
      coverage: { complete: false, note: "page 1 of 2" },
    });
    expect(second).toMatchObject({ replayed: false, state: "partial", replaced: first.derivation_id });
    expect(
      freshness(library.context, requireArtifact(library.context, artifact.id)).map((signal) => signal.kind),
    ).toContain("extraction_replaced");
    const page = readFileSync(
      join(materializeArtifact(library.context, artifact.id).path, "..", "sources", `${id}@v1.html`),
      "utf8",
    );
    expect(page).not.toContain("re-extracted with layout");
  });

  it("validates the target, bounds, and kind", () => {
    const { id, sha } = savePdf();
    expect(() => extract(id, "0".repeat(64), "x")).toThrow(/does not belong/);
    expect(() => extract(id, sha, "short", { segments: [{ start: 0, end: 99, locator: { page: 1 } }] })).toThrow(
      /text length/,
    );
    expect(() =>
      extract(id, sha, "abcdef", {
        segments: [
          { start: 0, end: 4, locator: { page: 1 } },
          { start: 2, end: 6, locator: { page: 2 } },
        ],
      }),
    ).toThrow(/must not overlap/);
    const image = capture(library.context, { attachments: [{ path: writeFixture(dir, "a.png", PNG_1X1) }] }).sources[0];
    expect(() => extract(image?.id ?? "", image?.sha256 ?? "", "text")).toThrow(/interpretations/);
    const note = capture(library.context, { text: "plain" }).sources[0]?.id ?? "";
    expect(() => extract(note, sha, "x")).toThrow(/only files/);
  });

  it("keeps a downloaded web page's URL provenance with its raw HTML", () => {
    const html =
      "<!doctype html><html><head><title>FP</title></head><body><article><p>函数式编程</p></article></body></html>";
    const receipt = capture(library.context, {
      text: "关于函数式编程：https://example.com/a",
      attachments: [
        {
          path: writeFixture(dir, "page.html", html),
          provenance: {
            supplied_url: "https://example.com/a",
            final_url: "https://www.example.com/a/",
            fetched_at: "2026-09-27T12:00:00Z",
            fetch_tool: "curl 8.7",
          },
        },
      ],
    });
    const page = receipt.sources[1];
    expect(page).toMatchObject({ mime: "text/html", processing: { extraction: "pending" } });
    const view = getSourceView(library.context, page?.id ?? "");
    expect(view.version.provenance).toMatchObject({ final_url: "https://www.example.com/a/", fetch_tool: "curl 8.7" });
    extract(page?.id ?? "", page?.sha256 ?? "", "函数式编程", { method: { tool: "readability" } });
    expect(search(library.context, { query: "函数式编程" }).hits.map((hit) => hit.source_id)).toContain(page?.id);
  });
});
