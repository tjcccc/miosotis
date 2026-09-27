import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
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
 * Backs up the canonical library (the SQLite database; v0.1 has no blob store yet). The snapshot is
 * built and verified in staging, the manifest is written last, and the folder only appears under its
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
 * MIOSOTIS_HOME) at the restored folder afterwards.
 */
export function restoreBackup(directory: string, options: { dataDir: string; env?: NodeJS.ProcessEnv }) {
  const { manifest, path } = verifyBackup(directory);
  if (basename(path).endsWith(".partial")) {
    throw new MiosotisError("validation", "Refusing to restore an incomplete (.partial) backup");
  }
  const target = resolveConfiguredPath(options.dataDir, process.cwd()) ?? options.dataDir;
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new MiosotisError("conflict", `${target} is not empty; restore only into a new or empty folder`);
  }
  const current = loadConfig(options.env).library.dataDir;
  if (resolve(current) === resolve(target) && existsSync(join(current, DATABASE_FILENAME))) {
    throw new MiosotisError("conflict", "Refusing to restore over the live library");
  }
  const paths = libraryPaths(target);
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
    const version = migrate(db);
    const integrity = String(db.pragma("integrity_check"));
    if (integrity !== "ok") {
      throw new MiosotisError("internal", `Restored database failed integrity_check: ${integrity}`);
    }
    return {
      data_dir: paths.dataDir,
      database: paths.database,
      schema_version: version,
      restored_from: path,
      counts: manifest.counts,
      next_step: `Set data_dir = ${JSON.stringify(paths.dataDir)} in config.toml (or use MIOSOTIS_HOME) to use the restored library.`,
    };
  } finally {
    db.close();
  }
}
