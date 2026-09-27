import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifact, materializeArtifact } from "../../src/app/artifacts.js";
import { createBackup, restoreBackup, verifyBackup } from "../../src/app/backup.js";
import { capture, safeFilename } from "../../src/app/capture.js";
import { openContext } from "../../src/app/context.js";
import { runDoctor } from "../../src/app/doctor.js";
import { applyEnrichment, prepareEnrichment } from "../../src/app/enrich.js";
import { prepareEvidence } from "../../src/app/evidence.js";
import { correctSource } from "../../src/app/governance.js";
import { search } from "../../src/app/search.js";
import { getSourceView } from "../../src/app/sources.js";
import { BlobStore, MAX_BLOB_BYTES } from "../../src/infra/blobs/store.js";
import { PNG_1X1, writeFixture } from "../helpers/files.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;
let dir: string;

beforeEach(() => {
  library = createTestLibrary();
  dir = mkdtempSync(join(tmpdir(), "miosotis-files-"));
});

afterEach(() => {
  library.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const NOTES = "﻿# 攻略笔记\n\n第二章 boss 需要格挡反击。\n";

describe("blob store", () => {
  it("dedupes identical bytes, enforces limits, and exposes only complete files", () => {
    const store = new BlobStore(join(dir, "blobs"), join(dir, "staging"));
    const a = store.putBytes(Buffer.from("same"));
    const b = store.putFile(writeFixture(dir, "x.txt", "same"));
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ sha256: a.sha256, created: false });
    expect(store.verify(a.sha256)).toBe(true);
    expect(readdirSync(join(dir, "staging"))).toEqual([]);
    expect(() => store.putBytes(Buffer.alloc(MAX_BLOB_BYTES + 1))).toThrow(/larger than/);
    expect(() => store.path("../../etc/passwd")).toThrow(/Not a blob hash/);
  });

  it("keeps hostile filenames as metadata only", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("a\u0000b\nc.png")).toBe("abc.png");
    expect(safeFilename("..")).toBe("file");
    expect(safeFilename("x".repeat(400)).length).toBe(255);
  });
});

describe("capture with attachments", () => {
  it("records a comment plus files as one linked capture group", () => {
    const receipt = capture(library.context, {
      text: "游玩截图和笔记",
      project: "鬼武者",
      attachments: [{ path: writeFixture(dir, "notes.md", NOTES) }, { path: writeFixture(dir, "shot.png", PNG_1X1) }],
    });
    expect(receipt.sources.map((s) => [s.role, s.kind])).toEqual([
      ["comment", "text"],
      ["file", "file"],
      ["file", "file"],
    ]);
    const [comment, notes, shot] = receipt.sources;
    expect(notes).toMatchObject({
      filename: "notes.md",
      mime: "text/markdown",
      processing: { extraction: "complete" },
    });
    expect(shot).toMatchObject({
      mime: "image/png",
      processing: { extraction: "unsupported", interpretation: "pending" },
    });
    const view = getSourceView(library.context, comment?.id ?? "");
    expect(view.links.references.map((link) => link.to_source).sort()).toEqual([notes?.id, shot?.id].sort());
    expect(getSourceView(library.context, notes?.id ?? "").projects[0]?.slug).toBe("鬼武者");
    const notesView = getSourceView(library.context, notes?.id ?? "");
    expect(notesView.text_origin).toBe("extracted");
    expect(notesView.text).toBe(NOTES.slice(1));
    expect(readFileSync(notesView.payloads[0]?.path ?? "")).toEqual(Buffer.from(NOTES));
  });

  it("is idempotent across the whole group and all-or-nothing on bad input", () => {
    const file = writeFixture(dir, "a.md", "hello");
    const first = capture(library.context, { attachments: [{ path: file }], idempotency_key: "files-key-01" });
    expect(capture(library.context, { attachments: [{ path: file }], idempotency_key: "files-key-01" }).replayed).toBe(
      true,
    );
    writeFileSync(file, "changed");
    expect(() => capture(library.context, { attachments: [{ path: file }], idempotency_key: "files-key-01" })).toThrow(
      /different content/,
    );
    expect(() => capture(library.context, { text: "x", attachments: [{ path: join(dir, "missing.png") }] })).toThrow(
      /Cannot read/,
    );
    expect(() => capture(library.context, { text: "x", attachments: [{ path: dir }] })).toThrow(/not a regular file/);
    expect(library.context.db.get<{ n: number }>("SELECT count(*) AS n FROM sources")?.n).toBe(first.sources.length);
  });

  it("marks undecodable text as failed without losing the file", () => {
    const receipt = capture(library.context, {
      attachments: [{ path: writeFixture(dir, "bad.txt", Buffer.from([0xff, 0xfe, 0x00, 0x62])) }],
    });
    const view = getSourceView(library.context, receipt.sources[0]?.id ?? "");
    expect(view.processing).toMatchObject({ extraction: { state: "failed" } });
    expect(view.payloads).toHaveLength(1);
  });
});

describe("robustness", () => {
  it("returns a committed capture even when post-commit extraction throws", () => {
    const original = library.context.blobs.putBytes.bind(library.context.blobs);
    library.context.blobs.putBytes = () => {
      throw new Error("disk full");
    };
    try {
      const receipt = capture(library.context, { attachments: [{ path: writeFixture(dir, "n.md", "hello") }] });
      expect(receipt.sources[0]?.processing.extraction).toBe("failed");
      const view = getSourceView(library.context, receipt.sources[0]?.id ?? "");
      expect(view.processing).toMatchObject({
        extraction: { state: "failed", last_error: expect.stringContaining("disk full") },
      });
    } finally {
      library.context.blobs.putBytes = original;
    }
  });

  it("refuses to correct a file Source with text", () => {
    const receipt = capture(library.context, { attachments: [{ path: writeFixture(dir, "shot.png", PNG_1X1) }] });
    expect(() => correctSource(library.context, receipt.sources[0]?.id ?? "", 1, { text: "replacement" })).toThrow(
      /cannot be corrected with text/,
    );
  });
});

describe("files in retrieval, enrichment, evidence, and artifacts", () => {
  function saveBoth() {
    const receipt = capture(library.context, {
      text: "Boss notes with a screenshot",
      attachments: [{ path: writeFixture(dir, "notes.md", NOTES) }, { path: writeFixture(dir, "boss.png", PNG_1X1) }],
    });
    const [, notes, image] = receipt.sources;
    return { notesId: notes?.id ?? "", imageId: image?.id ?? "", imageSha: image?.sha256 ?? "" };
  }

  it("finds extracted text and images by filename, then by interpretation", () => {
    const { notesId, imageId, imageSha } = saveBoth();
    const hit = search(library.context, { query: "格挡" }).hits[0];
    expect(hit?.source_id).toBe(notesId);
    expect(hit?.matches[0]).toMatchObject({ matched_in: "extracted", excerpt: expect.stringContaining("格挡") });
    expect(search(library.context, { query: "boss.png" }).hits.map((h) => h.source_id)).toContain(imageId);
    const prepared = prepareEnrichment(library.context, imageId);
    expect(prepared.files[0]).toMatchObject({ sha256: imageSha, needs_interpretation: true });
    applyEnrichment(library.context, {
      source_ref: prepared.source_ref,
      title: "Boss screenshot",
      interpretations: [
        {
          payload_sha256: imageSha,
          description: "A red samurai boss health bar at 30%",
          observations: [{ text: "HP about 30%", legibility: "uncertain" }],
        },
      ],
    });
    expect(getSourceView(library.context, imageId).processing).toMatchObject({ interpretation: { state: "complete" } });
    expect(search(library.context, { query: "samurai" }).hits.map((h) => h.source_id)).toEqual([imageId]);
    expect(() =>
      applyEnrichment(library.context, {
        source_ref: prepareEnrichment(library.context, notesId).source_ref,
        interpretations: [{ payload_sha256: imageSha, description: "wrong source" }],
      }),
    ).toThrow(/not an image of this revision/);
  });

  it("pins extracted spans and images, and renders them in the artifact folder", () => {
    const { notesId, imageId } = saveBoth();
    const evidence = prepareEvidence(library.context, {
      request: "boss strategy",
      source_refs: [{ ref: imageId }],
      quotes: [{ ref: notesId, quote: "需要格挡反击" }],
    });
    const image = evidence.items.find((item) => item.kind === "file");
    const quote = evidence.items.find((item) => item.kind === "extracted_text");
    expect(image?.excerpt).toContain("boss.png");
    expect(quote?.excerpt).toBe("需要格挡反击");
    const artifact = createArtifact(library.context, {
      evidence_run_id: evidence.id,
      intent: "review",
      title: "Boss",
      request: "boss strategy",
      markdown: `Block and counter [@${quote?.handle}]; see the screenshot [@${image?.handle}].`,
    });
    const { path } = materializeArtifact(library.context, artifact.id);
    const pages = readdirSync(join(path, "..", "sources"));
    expect(pages).toHaveLength(2);
    const imagePage = readFileSync(join(path, "..", "sources", `${imageId}@v1.html`), "utf8");
    expect(imagePage).toContain("data:image/png;base64,");
    const notesPage = readFileSync(join(path, "..", "sources", `${notesId}@v1.html`), "utf8");
    expect(notesPage).toContain("text extracted from notes.md");
    expect(notesPage).toContain("<mark");
  });

  it("pins the interpretation an image was cited with and signals re-interpretation", () => {
    const { imageId, imageSha } = saveBoth();
    const interpret = (description: string) =>
      applyEnrichment(library.context, {
        source_ref: prepareEnrichment(library.context, imageId).source_ref,
        interpretations: [{ payload_sha256: imageSha, description }],
      });
    interpret("first reading: boss at 30%");
    const evidence = prepareEvidence(library.context, { request: "boss", source_refs: [{ ref: imageId }] });
    const handle = evidence.items[0]?.handle ?? "";
    const artifact = createArtifact(library.context, {
      evidence_run_id: evidence.id,
      intent: "review",
      title: "Boss",
      request: "boss",
      markdown: `Screenshot [@${handle}].`,
    });
    interpret("second reading: boss at 25%");
    const again = prepareEvidence(library.context, { request: "boss", source_refs: [{ ref: imageId }] });
    expect(again.items[0]?.excerpt).toContain("second reading");
    const { path, notices } = materializeArtifact(library.context, artifact.id);
    expect(notices.join(" ")).toMatch(/re-interpreted/);
    const page = readFileSync(join(path, "..", "sources", `${imageId}@v1.html`), "utf8");
    expect(page).toContain("first reading");
    expect(page).not.toContain("second reading");
  });
});

describe("backup, restore, and doctor with files", () => {
  it("round-trips blobs, detects tampering, and reports missing or orphan files", async () => {
    const receipt = capture(library.context, { attachments: [{ path: writeFixture(dir, "shot.png", PNG_1X1) }] });
    const sha = receipt.sources[0]?.sha256 ?? "";
    const backup = await createBackup(library.context, { output: join(dir, "backups") });
    expect(backup.manifest.blobs.count).toBe(1);
    const restoredDir = join(dir, "restored");
    restoreBackup(backup.path, { dataDir: restoredDir, env: library.env });
    expect(existsSync(new BlobStore(join(restoredDir, "blobs"), dir).path(sha))).toBe(true);
    const otherHome = join(dir, "home2");
    mkdirSync(otherHome);
    writeFileSync(join(otherHome, "config.toml"), `data_dir = ${JSON.stringify(restoredDir)}\n`);
    const restored = openContext({ env: { MIOSOTIS_HOME: otherHome } });
    expect(getSourceView(restored, receipt.sources[0]?.id ?? "").payloads[0]?.sha256).toBe(sha);
    restored.db.close();

    const blobInBackup = new BlobStore(join(backup.path, "blobs"), dir).path(sha);
    writeFileSync(blobInBackup, "tampered");
    expect(() => verifyBackup(backup.path)).toThrow(/does not match its hash/);

    library.context.blobs.putBytes(Buffer.from("orphan bytes"));
    rmSync(library.context.blobs.path(sha));
    const report = runDoctor({ env: library.env, version: "test" });
    expect(report.checks.find((check) => check.name === "blobs")?.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "orphan_blobs")?.status).toBe("warn");
  });
});
