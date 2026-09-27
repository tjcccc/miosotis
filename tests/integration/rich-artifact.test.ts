import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactView,
  createArtifact,
  exportArtifact,
  materializeArtifact,
  requireArtifact,
} from "../../src/app/artifacts.js";
import { capture } from "../../src/app/capture.js";
import { prepareEvidence } from "../../src/app/evidence.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

afterEach(() => library?.cleanup());

const PAGE =
  '<!doctype html><html><head><title>demo</title></head><body><h1 data-cite="c1">Hours</h1><canvas id="c"></canvas><script>const g = document.getElementById("c").getContext("2d"); g.fillRect(0, 0, 30, 50);</script></body></html>';

function setup() {
  library = createTestLibrary();
  const id = capture(library.context, { text: "Chapter 1: 3h. Chapter 2: 5h." }).sources[0]?.id ?? "";
  const evidence = prepareEvidence(library.context, { request: "3D playthrough", source_refs: [{ ref: id }] });
  const base = {
    evidence_run_id: evidence.id,
    intent: "review" as const,
    title: "Playthrough in 3D",
    request: "3D playthrough",
    markdown: "Chapter hours: 3 and 5 [@c1].",
  };
  return { base };
}

describe("rich HTML artifacts", () => {
  it("stores the page verbatim with a citable summary and opens it sandboxed", () => {
    const { base } = setup();
    const receipt = createArtifact(library.context, { ...base, format: "html", html: PAGE });
    expect(receipt).toMatchObject({ format: "html", citations: ["c1"] });
    expect(requireArtifact(library.context, receipt.id).payload_html).toBe(PAGE);
    expect(artifactView(library.context, receipt.id).format).toBe("html");
    const viewer = readFileSync(materializeArtifact(library.context, receipt.id).path, "utf8");
    expect(viewer).toContain('sandbox="allow-scripts"');
    expect(viewer).not.toContain("allow-same-origin");
    const outsideFrame = viewer.replace(/srcdoc="[^"]*"/, 'srcdoc=""');
    expect(outsideFrame).not.toMatch(/<script/i);
    expect(viewer).toContain("Chapter hours: 3 and 5");
    expect(exportArtifact(library.context, receipt.id, "md").content).toBe(base.markdown);
    expect(exportArtifact(library.context, receipt.id, "html").content).toContain('sandbox="allow-scripts"');
  });

  it("validates the contract, page citations, and offline-ness before storing anything", () => {
    const { base } = setup();
    expect(() => createArtifact(library.context, { ...base, format: "html" })).toThrow(/requires an html page/);
    expect(() => createArtifact(library.context, { ...base, html: PAGE })).toThrow(/only accepted with format=html/);
    expect(() =>
      createArtifact(library.context, { ...base, format: "html", html: '<div data-cite="c9">x</div>' }),
    ).toThrow(/not in evidence run/);
    expect(() =>
      createArtifact(library.context, { ...base, format: "html", html: '<img src="https://example.com/boss.jpg">' }),
    ).toThrow(/cannot be stored/);
    expect(library.context.db.get<{ n: number }>("SELECT count(*) AS n FROM artifacts")?.n).toBe(0);
  });

  it("freezes the page and its format", () => {
    const { base } = setup();
    const receipt = createArtifact(library.context, { ...base, format: "html", html: PAGE });
    expect(() =>
      library.context.db.run("UPDATE artifacts SET payload_html = '<p>x</p>' WHERE id = ?", [receipt.id]),
    ).toThrow(/immutable/);
    expect(() => library.context.db.run("UPDATE artifacts SET format = 'markdown' WHERE id = ?", [receipt.id])).toThrow(
      /immutable/,
    );
  });
});
