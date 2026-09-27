import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactView, createArtifact, materializeArtifact } from "../../src/app/artifacts.js";
import { createBackup, restoreBackup, verifyBackup } from "../../src/app/backup.js";
import { capture } from "../../src/app/capture.js";
import { openContext } from "../../src/app/context.js";
import { prepareEvidence } from "../../src/app/evidence.js";
import { getSourceView } from "../../src/app/sources.js";
import { latestSchemaVersion } from "../../src/infra/db/migrate.js";
import { MIXED_TEXT } from "../fixtures/multilingual.js";
import { fakeArtifact } from "../helpers/fake-agent.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

afterEach(() => library?.cleanup());

function populate() {
  const id = capture(library.context, { text: MIXED_TEXT, project: "p" }).sources[0]?.id ?? "";
  const evidence = prepareEvidence(library.context, { request: "r", source_refs: [{ ref: id }] });
  const artifact = createArtifact(library.context, fakeArtifact(evidence, "Backup test"));
  return { id, artifactId: artifact.id };
}

describe("backup and restore (scenario L)", () => {
  it("round-trips sources and artifacts into a new library, with zero inference", async () => {
    library = createTestLibrary();
    const { id, artifactId } = populate();
    const backup = await createBackup(library.context, { output: join(library.root, "cloud") });
    expect(backup.manifest.counts).toMatchObject({ sources: 1, artifacts: 1 });
    expect(readdirSync(backup.path).sort()).toEqual(["library.sqlite3", "manifest.json"]);
    expect(verifyBackup(backup.path).manifest.database.sha256).toBe(backup.manifest.database.sha256);

    const restoredDir = join(library.root, "restored");
    const restored = restoreBackup(backup.path, { dataDir: restoredDir, env: library.env });
    expect(restored.schema_version).toBe(latestSchemaVersion());
    const otherHome = join(library.root, "home2");
    mkdirSync(otherHome);
    writeFileSync(join(otherHome, "config.toml"), `data_dir = ${JSON.stringify(restoredDir)}\n`);
    const context = openContext({ env: { MIOSOTIS_HOME: otherHome } });
    try {
      expect(getSourceView(context, id).text).toBe(MIXED_TEXT);
      const original = artifactView(library.context, artifactId);
      const copy = artifactView(context, artifactId);
      expect(copy.content_hash).toBe(original.content_hash);
      expect(copy.markdown).toBe(original.markdown);
      const { path } = materializeArtifact(context, artifactId);
      expect(readFileSync(path, "utf8")).toContain("Backup test");
    } finally {
      context.db.close();
    }
  });

  it("detects tampering and never restores over existing data", async () => {
    library = createTestLibrary();
    populate();
    const backup = await createBackup(library.context, { output: join(library.root, "b") });
    expect(() =>
      restoreBackup(backup.path, { dataDir: library.context.config.library.dataDir, env: library.env }),
    ).toThrow(/not empty/);
    const database = join(backup.path, "library.sqlite3");
    const bytes = readFileSync(database);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    writeFileSync(database, bytes);
    expect(() => verifyBackup(backup.path)).toThrow(/hash does not match/);
  });

  it("does not present an interrupted backup as complete", async () => {
    library = createTestLibrary();
    populate();
    const partial = join(library.root, "b", "miosotis-backup-x.partial");
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "library.sqlite3"), "half-written");
    expect(() => verifyBackup(partial)).toThrow(/not a complete miosotis backup/);
    expect(() => restoreBackup(partial, { dataDir: join(library.root, "r"), env: library.env })).toThrow();
    expect(existsSync(join(library.root, "r", "library.sqlite3"))).toBe(false);
    expect(readdirSync(library.context.config.library.stagingDir)).toEqual([]);
  });

  it("requires a destination", async () => {
    library = createTestLibrary();
    await expect(createBackup(library.context)).rejects.toThrow(/No backup destination/);
  });
});
