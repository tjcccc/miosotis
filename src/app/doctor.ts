import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "../infra/blobs/store.js";
import { loadConfig } from "../infra/config/config.js";
import { Database, probeSqlite } from "../infra/db/database.js";
import { latestSchemaVersion, schemaVersion } from "../infra/db/migrate.js";
import { skillStatus } from "./skill.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  node: string;
  sqlite: string;
  home: string;
  config_file: string | null;
  data_dir: string;
  database: string;
  schema_version: number | null;
  supported_schema_version: number;
  counts: Record<string, number> | null;
  checks: DoctorCheck[];
}

/**
 * Reports environment and library health without printing any source content or secrets.
 * Read-only: it never migrates or repairs.
 */
export function runDoctor(options: { env?: NodeJS.ProcessEnv; version: string }): DoctorReport {
  const checks: DoctorCheck[] = [];
  const config = loadConfig(options.env);
  const probe = probeSqlite();
  const sqlite = probe.version;
  checks.push(
    probe.fts5Trigram
      ? { name: "fts5_trigram", status: "ok", detail: "FTS5 trigram tokenizer available" }
      : { name: "fts5_trigram", status: "fail", detail: `FTS5 trigram unavailable: ${probe.error ?? "unknown"}` },
  );
  checks.push({
    name: "sqlite_version",
    status: compareVersions(sqlite, "3.51.3") >= 0 ? "ok" : "fail",
    detail: `linked SQLite ${sqlite} (WAL-reset fix requires >= 3.51.3)`,
  });
  checks.push({
    name: "config",
    status: config.fileExists ? "ok" : "warn",
    detail: config.fileExists ? config.paths.configFile : "no config file; defaults in effect (run `miosotis init`)",
  });
  const report: DoctorReport = {
    ok: false,
    version: options.version,
    node: process.version,
    sqlite,
    home: config.paths.home,
    config_file: config.fileExists ? config.paths.configFile : null,
    data_dir: config.library.dataDir,
    database: config.library.database,
    schema_version: null,
    supported_schema_version: latestSchemaVersion(),
    counts: null,
    checks,
  };
  if (!existsSync(config.library.database)) {
    checks.push({ name: "library", status: "fail", detail: "library not initialized (run `miosotis init`)" });
    return finish(report);
  }
  const db = new Database(config.library.database, { readOnly: true });
  try {
    const version = schemaVersion(db);
    report.schema_version = version;
    checks.push({
      name: "schema",
      status:
        version === report.supported_schema_version
          ? "ok"
          : version < report.supported_schema_version
            ? "warn"
            : "fail",
      detail:
        version === report.supported_schema_version
          ? `schema v${version}`
          : version < report.supported_schema_version
            ? `schema v${version} will be migrated to v${report.supported_schema_version} on next write`
            : `schema v${version} is newer than this build supports`,
    });
    checks.push(pragmaCheck("foreign_keys", db.pragma("foreign_keys"), 1));
    const journal = String(db.pragma("journal_mode"));
    checks.push({ name: "journal_mode", status: journal === "wal" ? "ok" : "warn", detail: `journal_mode=${journal}` });
    const quick = String(db.pragma("quick_check"));
    checks.push({ name: "integrity", status: quick === "ok" ? "ok" : "fail", detail: `quick_check: ${quick}` });
    const fkViolations = db.all("PRAGMA foreign_key_check").length;
    checks.push({
      name: "references",
      status: fkViolations === 0 ? "ok" : "fail",
      detail: fkViolations === 0 ? "no dangling references" : `${fkViolations} foreign-key violations`,
    });
    if (version >= 1) {
      report.counts = {
        sources: db.get<{ n: number }>("SELECT count(*) AS n FROM sources")?.n ?? 0,
        visible_sources: db.get<{ n: number }>("SELECT count(*) AS n FROM visible_sources")?.n ?? 0,
        projects: db.get<{ n: number }>("SELECT count(*) AS n FROM projects")?.n ?? 0,
        artifacts: db.get<{ n: number }>("SELECT count(*) AS n FROM artifacts WHERE lifecycle = 'active'")?.n ?? 0,
        enrichment_pending:
          db.get<{ n: number }>(
            `SELECT count(*) AS n FROM processing_states ps JOIN visible_sources s ON s.id = ps.source_id AND s.current_version = ps.version
             WHERE ps.stage = 'enrichment' AND ps.state IN ('pending', 'failed')`,
          )?.n ?? 0,
      };
      const unindexed =
        db.get<{ n: number }>(
          "SELECT count(*) AS n FROM sources s WHERE s.retention <> 'purged' AND NOT EXISTS (SELECT 1 FROM search_fts f WHERE f.source_id = s.id)",
        )?.n ?? 0;
      checks.push({
        name: "search_index",
        status: unindexed === 0 ? "ok" : "warn",
        detail: unindexed === 0 ? "every source is indexed" : `${unindexed} sources missing from the search index`,
      });
    }
  } finally {
    db.close();
  }
  checks.push(...blobChecks(config.library.database, config.library.blobsDir));
  for (const host of skillStatus({ env: options.env ?? process.env }).hosts) {
    if (host.state === "outdated") {
      checks.push({
        name: `skill_${host.host}`,
        status: "warn",
        detail: `${host.label} Skill is outdated; run \`miosotis skill install --host ${host.host} --yes\``,
      });
    } else if (host.state === "copied" || host.state === "linked") {
      checks.push({ name: `skill_${host.host}`, status: "ok", detail: `${host.label} Skill ${host.state}` });
    }
  }
  const staging = existsSync(config.library.stagingDir) ? readdirSync(config.library.stagingDir) : [];
  checks.push({
    name: "staging",
    status: staging.length === 0 ? "ok" : "warn",
    detail:
      staging.length === 0
        ? "no leftover staging files"
        : `${staging.length} leftover staging entries (safe to inspect)`,
  });
  return finish(report);
}

function finish(report: DoctorReport): DoctorReport {
  report.ok = report.checks.every((check) => check.status !== "fail");
  return report;
}

function pragmaCheck(name: string, actual: unknown, expected: unknown): DoctorCheck {
  return {
    name,
    status: actual === expected ? "ok" : "fail",
    detail: `${name}=${String(actual)}`,
  };
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

const SPOT_CHECK = 20;

/** Stored files versus blob rows: missing files fail; unreferenced files and a hash spot-check warn/fail. */
function blobChecks(databasePath: string, blobsDir: string): DoctorCheck[] {
  const db = new Database(databasePath, { readOnly: true });
  let rows: { sha256: string }[] = [];
  try {
    if (db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'blobs'")?.n !== 1) {
      return [];
    }
    rows = db.all<{ sha256: string }>("SELECT sha256 FROM blobs ORDER BY sha256");
  } finally {
    db.close();
  }
  const store = new BlobStore(blobsDir, blobsDir);
  const known = new Set(rows.map((row) => row.sha256));
  const missing = rows.filter((row) => !store.has(row.sha256)).length;
  const onDisk = listBlobFiles(join(blobsDir, "sha256"));
  const orphans = onDisk.filter((sha) => !known.has(sha)).length;
  const corrupted = rows
    .filter((row) => store.has(row.sha256))
    .slice(0, SPOT_CHECK)
    .filter((row) => !store.verify(row.sha256)).length;
  return [
    {
      name: "blobs",
      status: missing > 0 || corrupted > 0 ? "fail" : "ok",
      detail:
        missing > 0 || corrupted > 0
          ? `${missing} missing and ${corrupted} corrupted of ${rows.length} stored files`
          : `${rows.length} stored files present (hash spot-check of ${Math.min(rows.length, SPOT_CHECK)} passed)`,
    },
    {
      name: "orphan_blobs",
      status: orphans === 0 ? "ok" : "warn",
      detail:
        orphans === 0
          ? "no unreferenced files"
          : `${orphans} unreferenced files (left by an interrupted capture; kept, never auto-deleted)`,
    },
  ];
}

function listBlobFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root).flatMap((prefix) => {
    const directory = join(root, prefix);
    return statSync(directory).isDirectory()
      ? readdirSync(directory).filter((name) => /^[0-9a-f]{64}$/.test(name))
      : [];
  });
}
