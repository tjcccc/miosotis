import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup } from "../../src/app/backup.js";
import { capture } from "../../src/app/capture.js";
import { runDoctor } from "../../src/app/doctor.js";
import { changeSourcePolicy } from "../../src/app/governance.js";
import { repair } from "../../src/app/repair.js";
import { emptyTrash, removeItems } from "../../src/app/trash.js";
import { isMiosotisError } from "../../src/domain/errors.js";
import { newId } from "../../src/domain/ids.js";
import { Database } from "../../src/infra/db/database.js";
import { sha256Hex } from "../../src/infra/digest.js";
import { cli, createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

beforeEach(() => {
  library = createTestLibrary();
});

afterEach(() => library.cleanup());

function failure(run: () => unknown) {
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

/** Makes a leftover look old enough to be past any work still in progress. */
function age(path: string): void {
  const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(path, past, past);
}

function deletePermanently(id: string) {
  removeItems(library.context, [id], { confirm: true });
  const review = failure(() => emptyTrash(library.context, [id]));
  const plan = (review.details as { plan: { plan_id: string } }).plan.plan_id;
  emptyTrash(library.context, [id], { confirm: true, plan });
}

describe("restore hardening", () => {
  it("assembles the restore aside, leaves nothing behind on failure, and never half-creates the target", async () => {
    const notes = join(library.root, "notes.md");
    writeFileSync(notes, "# Notes\n\nextracted text\n");
    capture(library.context, { text: "with a file", attachments: [{ path: notes }] });
    const backup = await createBackup(library.context, { output: join(library.root, "backups") });
    const parent = join(library.root, "restores");
    mkdirSync(parent);

    const good = restoreBackup(backup.path, { dataDir: join(parent, "good"), env: library.env });
    expect(existsSync(join(good.data_dir, "library.sqlite3"))).toBe(true);
    expect(readdirSync(parent)).toEqual(["good"]);

    // A backup whose hashes check out but which references a file it doesn't contain fails the
    // post-restore reference check: the staged copy is removed and the target never appears.
    const database = join(backup.path, "library.sqlite3");
    const db = new Database(database);
    db.run(
      "UPDATE derived_records SET content_json = json_set(content_json, '$.tables_blob', ?) WHERE kind = 'extraction'",
      ["0".repeat(64)],
    );
    db.close();
    const manifestPath = join(backup.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { database: { sha256: string } };
    manifest.database.sha256 = sha256Hex(readFileSync(database));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => restoreBackup(backup.path, { dataDir: join(parent, "bad"), env: library.env })).toThrow(
      /references a missing file/,
    );
    expect(readdirSync(parent)).toEqual(["good"]);
  });

  it("warns that a backup brings back what was deleted after it, with a count for this library", async () => {
    const kept = capture(library.context, { text: "kept" }).sources[0]?.id ?? "";
    const gone = capture(library.context, { text: "deleted later" }).sources[0]?.id ?? "";
    expect(kept).not.toBe(gone);
    const backup = await createBackup(library.context, { output: join(library.root, "backups") });
    deletePermanently(gone);
    const restored = restoreBackup(backup.path, { dataDir: join(library.root, "restored"), env: library.env });
    expect(restored.warnings[0]).toMatch(/back in the restored copy/);
    expect(restored.warnings[1]).toMatch(/1 item\(s\) you deleted permanently/);
  });

  it("moved backup restore under `backup`, and `restore <dir>` points there", async () => {
    capture(library.context, { text: "cli" });
    const backup = await createBackup(library.context, { output: join(library.root, "backups") });
    const hint = await cli(library.env, "restore", backup.path, "--json");
    expect(hint.json().error?.message).toMatch(/backup restore/);
    const done = await cli(
      library.env,
      "backup",
      "restore",
      backup.path,
      "--data-dir",
      join(library.root, "via-cli"),
      "--json",
    );
    expect(done.json()).toMatchObject({ ok: true });
    expect(done.json().warnings?.[0]).toMatch(/back in the restored copy/);
  });
});

describe("repair", () => {
  it("lists leftovers first, removes only settled unreferenced ones, and leaves the library healthy", () => {
    const { context } = library;
    const { library: paths } = context.config;
    const source = capture(context, { text: "an indexed note" }).sources[0]?.id ?? "";
    const trashed = capture(context, { text: "a trashed note" }).sources[0]?.id ?? "";
    changeSourcePolicy(context, trashed, "trash", { confirm: true });
    // Leftovers of interrupted work.
    mkdirSync(paths.stagingDir, { recursive: true });
    const oldStaging = join(paths.stagingDir, "blob-123-old");
    writeFileSync(oldStaging, "partial bytes");
    age(oldStaging);
    const freshStaging = join(paths.stagingDir, "blob-456-now");
    writeFileSync(freshStaging, "in progress");
    const orphan = context.blobs.putBytes(Buffer.from("orphaned bytes"));
    age(context.blobs.path(orphan.sha256));
    const freshOrphan = context.blobs.putBytes(Buffer.from("a capture still running"));
    const backupDir = join(library.root, "backups");
    context.config.backupDir = backupDir;
    const partial = join(backupDir, "miosotis-backup-2026-09-01T00-00-00-000Z.partial");
    mkdirSync(partial, { recursive: true });
    age(partial);
    const staleFolder = join(paths.artifactsDir, newId("artifact"));
    mkdirSync(staleFolder, { recursive: true });
    context.db.run("DELETE FROM search_fts WHERE source_id = ?", [source]);

    const doctorBefore = runDoctor({ env: library.env, version: "test" });
    expect(doctorBefore.checks.find((check) => check.name === "search_index")?.detail).toMatch(/1 sources missing/);

    const review = failure(() => repair(context));
    expect(review.code).toBe("confirmation_required");
    expect(review.details).toMatchObject({
      plan: {
        staging_leftovers: ["blob-123-old"],
        orphan_files: 1,
        interrupted_backups: [partial],
        stale_artifact_folders: [staleFolder.split("/").pop()],
        unindexed_sources: [source],
      },
    });
    expect(existsSync(oldStaging)).toBe(true);

    const result = repair(context, { confirm: true });
    expect(result.changed).toBe(true);
    expect(existsSync(oldStaging)).toBe(false);
    expect(existsSync(freshStaging)).toBe(true);
    expect(context.blobs.has(orphan.sha256)).toBe(false);
    expect(context.blobs.has(freshOrphan.sha256)).toBe(true);
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(staleFolder)).toBe(false);
    // The trashed note is intentionally unindexed and was neither counted nor reindexed.
    expect(
      context.db.get<{ n: number }>("SELECT count(*) AS n FROM search_fts WHERE source_id = ?", [trashed])?.n,
    ).toBe(0);
    expect(
      runDoctor({ env: library.env, version: "test" }).checks.find((check) => check.name === "search_index")?.status,
    ).toBe("ok");

    rmSync(freshStaging);
    context.blobs.remove(freshOrphan.sha256);
    expect(repair(context)).toMatchObject({ changed: false, actions: [] });
  });
});

describe("restore edge cases", () => {
  it("still succeeds, with the date warning, when the current library is damaged", async () => {
    capture(library.context, { text: "note" });
    const backup = await createBackup(library.context, { output: join(library.root, "backups") });
    library.context.db.close();
    writeFileSync(library.context.config.library.database, "garbage, not a database");
    const restored = restoreBackup(backup.path, { dataDir: join(library.root, "rescue"), env: library.env });
    expect(existsSync(join(restored.data_dir, "library.sqlite3"))).toBe(true);
    expect(restored.warnings).toHaveLength(1);
    expect(restored.warnings[0]).toMatch(/back in the restored copy/);
  });

  it("answers the old `restore <dir> --data-dir` habit with the backup restore hint", async () => {
    const run = await cli(
      library.env,
      "restore",
      join(library.root, "some-backup"),
      "--data-dir",
      join(library.root, "x"),
      "--json",
    );
    expect(run.json().error?.message).toMatch(/miosotis backup restore .* --data-dir/);
  });
});
