import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { MiosotisError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import { blobPath } from "../infra/blobs/store.js";
import { DATABASE_FILENAME, libraryPaths, loadConfig, resolveConfiguredPath } from "../infra/config/config.js";
import { Database, snapshotDatabase } from "../infra/db/database.js";
import { latestSchemaVersion, migrate, schemaVersion } from "../infra/db/migrate.js";
import { blobReferences } from "../infra/db/repos/purge.js";
import { sha256Hex } from "../infra/digest.js";
import { ensureDir, writeFileAtomic } from "../infra/fs/files.js";
import { VERSION } from "../version.js";
import { type AppContext, isoNow } from "./context.js";

export const BACKUP_SCHEMA = "miosotis.backup.v1";
export const MANIFEST_FILENAME = "manifest.json";

export interface BackupManifest {
  schema: typeof BACKUP_SCHEMA;
  created_at: string;
  miosotis_version: string;
  library_id: string | null;
  schema_version: number;
  database: { file: string; sha256: string; bytes: number };
  counts: Record<string, number>;
  excluded: string[];
  blobs: { count: number; bytes: number };
}

export const BLOBS_DIRNAME = "blobs";

function listBlobs(databasePath: string): { sha256: string; size: number }[] {
  const db = new Database(databasePath, { readOnly: true });
  try {
    return db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'blobs'")?.n === 1
      ? db.all<{ sha256: string; size: number }>("SELECT sha256, size FROM blobs ORDER BY sha256")
      : [];
  } finally {
    db.close();
  }
}

/** Copies one blob between stores, refusing if the source bytes no longer match their hash. */
function copyBlob(fromRoot: string, toRoot: string, sha256: string): number {
  const from = blobPath(fromRoot, sha256);
  if (!existsSync(from)) {
    throw new MiosotisError("validation", `Blob ${sha256} is missing from ${fromRoot}`);
  }
  const bytes = readFileSync(from);
  if (sha256Hex(bytes) !== sha256) {
    throw new MiosotisError("validation", `Blob ${sha256} is corrupted (hash mismatch)`);
  }
  const to = blobPath(toRoot, sha256);
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  writeFileSync(to, bytes, { mode: 0o600 });
  return bytes.byteLength;
}

/**
 * Backs up the canonical library: the SQLite database plus every stored file it references. The
 * snapshot is built and verified in staging, the manifest is written last, and the folder only appears under its
 * final name once complete. Rendered artifact folders are a rebuildable cache and are excluded.
 */
export async function createBackup(context: AppContext, options: { output?: string | undefined } = {}) {
  const destinationRoot =
    resolveConfiguredPath(options.output, process.cwd()) ??
    context.config.backupDir ??
    (() => {
      throw new MiosotisError("usage", "No backup destination: pass --output or set [backup].dir in config.toml");
    })();
  const stamp = isoNow(context).replace(/[:.]/g, "-");
  const name = `miosotis-backup-${stamp}`;
  const finalDir = join(destinationRoot, name);
  if (existsSync(finalDir)) {
    throw new MiosotisError("conflict", `${finalDir} already exists`);
  }
  const staging = join(context.config.library.stagingDir, `backup-${newId("operation")}`);
  ensureDir(staging);
  try {
    const databaseCopy = join(staging, DATABASE_FILENAME);
    await snapshotDatabase(context.db, databaseCopy);
    const manifest = inspectDatabase(databaseCopy, isoNow(context));
    writeFileAtomic(join(staging, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
    ensureDir(destinationRoot);
    const partial = `${finalDir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    copyFileSync(databaseCopy, join(partial, DATABASE_FILENAME));
    for (const blob of listBlobs(databaseCopy)) {
      copyBlob(context.config.library.blobsDir, join(partial, BLOBS_DIRNAME), blob.sha256);
    }
    copyFileSync(join(staging, MANIFEST_FILENAME), join(partial, MANIFEST_FILENAME));
    const verified = verifyBackup(partial);
    renameSync(partial, finalDir);
    return { path: finalDir, manifest: verified.manifest };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function blobTotals(databasePath: string): { count: number; bytes: number } {
  const blobs = listBlobs(databasePath);
  return { count: blobs.length, bytes: blobs.reduce((total, blob) => total + blob.size, 0) };
}

function inspectDatabase(path: string, createdAt: string): BackupManifest {
  const db = new Database(path, { readOnly: true });
  try {
    const integrity = String(db.pragma("integrity_check"));
    if (integrity !== "ok") {
      throw new MiosotisError("internal", `Backup snapshot failed integrity_check: ${integrity}`);
    }
    const count = (sql: string) => db.get<{ n: number }>(sql)?.n ?? 0;
    return {
      schema: BACKUP_SCHEMA,
      created_at: createdAt,
      miosotis_version: VERSION,
      library_id: db.get<{ value: string }>("SELECT value FROM library_meta WHERE key = 'library_id'")?.value ?? null,
      schema_version: schemaVersion(db),
      database: { file: DATABASE_FILENAME, sha256: sha256Hex(readFileSync(path)), bytes: statSync(path).size },
      counts: {
        sources: count("SELECT count(*) AS n FROM sources"),
        source_versions: count("SELECT count(*) AS n FROM source_versions"),
        artifacts: count("SELECT count(*) AS n FROM artifacts"),
        projects: count("SELECT count(*) AS n FROM projects"),
      },
      excluded: ["artifacts/ (rendered views; rebuilt by `artifact open`)", "config.toml and any credentials"],
      blobs: blobTotals(path),
    };
  } finally {
    db.close();
  }
}

/** Checks a backup folder: manifest, file hash, SQLite integrity, and schema compatibility. */
export function verifyBackup(directory: string): { path: string; manifest: BackupManifest } {
  const root = resolve(directory);
  const manifestPath = join(root, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new MiosotisError("validation", `${root} is not a complete miosotis backup (no ${MANIFEST_FILENAME})`);
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch {
    throw new MiosotisError("validation", `${manifestPath} is not valid JSON`);
  }
  if (manifest.schema !== BACKUP_SCHEMA || manifest.database?.file !== DATABASE_FILENAME) {
    throw new MiosotisError("validation", "Unrecognized backup manifest");
  }
  const databasePath = join(root, DATABASE_FILENAME);
  if (!existsSync(databasePath)) {
    throw new MiosotisError("validation", "Backup database file is missing");
  }
  if (sha256Hex(readFileSync(databasePath)) !== manifest.database.sha256) {
    throw new MiosotisError("validation", "Backup database hash does not match its manifest (corrupted or modified)");
  }
  if (manifest.schema_version > latestSchemaVersion()) {
    throw new MiosotisError(
      "schema_too_new",
      `Backup schema v${manifest.schema_version} is newer than this miosotis supports`,
    );
  }
  const db = new Database(databasePath, { readOnly: true });
  try {
    const integrity = String(db.pragma("integrity_check"));
    if (integrity !== "ok") {
      throw new MiosotisError("validation", `Backup database failed integrity_check: ${integrity}`);
    }
  } finally {
    db.close();
  }
  for (const blob of listBlobs(databasePath)) {
    const file = blobPath(join(root, BLOBS_DIRNAME), blob.sha256);
    if (!existsSync(file)) {
      throw new MiosotisError("validation", `Backup is missing blob ${blob.sha256}`);
    }
    if (sha256Hex(readFileSync(file)) !== blob.sha256) {
      throw new MiosotisError(
        "validation",
        `Backup blob ${blob.sha256} does not match its hash (corrupted or modified)`,
      );
    }
  }
  return { path: root, manifest };
}

/**
 * Restores into a new, empty data folder. It never overwrites a live library; point `data_dir` (or
 * MIOSOTIS_HOME) at the restored folder afterwards. The library is assembled and checked in a hidden
 * sibling folder and only renamed into place when complete, so an interrupted restore never leaves a
 * folder that opens as a library with missing files.
 */
export function restoreBackup(directory: string, options: { dataDir: string; env?: NodeJS.ProcessEnv }) {
  const { manifest, path } = verifyBackup(directory);
  if (basename(path).endsWith(".partial")) {
    throw new MiosotisError("validation", "Refusing to restore an incomplete (.partial) backup");
  }
  const target = resolve(resolveConfiguredPath(options.dataDir, process.cwd()) ?? options.dataDir);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new MiosotisError("conflict", `${target} is not empty; restore only into a new or empty folder`);
  }
  const current = loadConfig(options.env).library;
  if (resolve(current.dataDir) === target && existsSync(join(current.dataDir, DATABASE_FILENAME))) {
    throw new MiosotisError("conflict", "Refusing to restore over the live library");
  }
  ensureDir(dirname(target));
  const staging = join(dirname(target), `.${basename(target)}.restoring-${process.pid}-${Date.now()}`);
  let version: number;
  try {
    const paths = libraryPaths(staging);
    ensureDir(paths.dataDir);
    ensureDir(paths.artifactsDir);
    ensureDir(paths.stagingDir);
    copyFileSync(join(path, DATABASE_FILENAME), paths.database);
    ensureDir(paths.blobsDir);
    for (const blob of listBlobs(paths.database)) {
      copyBlob(join(path, BLOBS_DIRNAME), paths.blobsDir, blob.sha256);
    }
    const db = new Database(paths.database);
    try {
      db.get("PRAGMA journal_mode = WAL");
      version = migrate(db);
      checkRestoredLibrary(db, paths.blobsDir);
      db.get("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    if (existsSync(target)) {
      rmdirSync(target);
    }
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const paths = libraryPaths(target);
  return {
    data_dir: paths.dataDir,
    database: paths.database,
    schema_version: version,
    restored_from: path,
    backup_created_at: manifest.created_at,
    counts: manifest.counts,
    warnings: restoreWarnings(manifest, current.database),
    next_step: `Set data_dir = ${JSON.stringify(paths.dataDir)} in config.toml (or use MIOSOTIS_HOME) to use the restored library.`,
  };
}

/** Integrity, foreign keys, and every stored-file reference resolving to a present, listed file. */
function checkRestoredLibrary(db: Database, blobsDir: string): void {
  const integrity = String(db.pragma("integrity_check"));
  if (integrity !== "ok") {
    throw new MiosotisError("validation", `Restored database failed integrity_check: ${integrity}`);
  }
  const violations = db.all("PRAGMA foreign_key_check").length;
  if (violations > 0) {
    throw new MiosotisError("validation", `Restored database has ${violations} dangling reference(s)`);
  }
  const listed = new Set(db.all<{ sha256: string }>("SELECT sha256 FROM blobs").map((row) => row.sha256));
  for (const reference of blobReferences(db)) {
    if (!listed.has(reference.sha256) || !existsSync(blobPath(blobsDir, reference.sha256))) {
      throw new MiosotisError(
        "validation",
        `Restored library references a missing file (${reference.owner_kind} ${reference.owner_id})`,
      );
    }
  }
}

/**
 * A backup is a snapshot: anything removed or permanently deleted after it was made comes back. When
 * the current library is the one the backup came from, say how many deletions that undoes.
 */
function restoreWarnings(manifest: BackupManifest, liveDatabase: string): string[] {
  const warnings = [
    `This backup was made ${manifest.created_at}. Anything removed or permanently deleted after that is back in the restored copy.`,
  ];
  if (manifest.library_id === null || !existsSync(liveDatabase)) {
    return warnings;
  }
  // The restore is already in place; a damaged or busy current library must not turn it into a failure.
  let live: Database;
  try {
    live = new Database(liveDatabase, { readOnly: true });
  } catch {
    return warnings;
  }
  try {
    const libraryId = live.get<{ value: string }>("SELECT value FROM library_meta WHERE key = 'library_id'")?.value;
    if (libraryId !== manifest.library_id || schemaVersion(live) < 8) {
      return warnings;
    }
    const deleted =
      (live.get<{ n: number }>("SELECT count(*) AS n FROM sources WHERE retention = 'purged' AND updated_at > ?", [
        manifest.created_at,
      ])?.n ?? 0) +
      (live.get<{ n: number }>("SELECT count(*) AS n FROM artifacts WHERE lifecycle = 'purged' AND purged_at > ?", [
        manifest.created_at,
      ])?.n ?? 0);
    if (deleted > 0) {
      warnings.push(
        `${deleted} item(s) you deleted permanently in your current library after this backup are in the restored copy again.`,
      );
    }
  } catch {
    return warnings;
  } finally {
    live.close();
  }
  return warnings;
}
