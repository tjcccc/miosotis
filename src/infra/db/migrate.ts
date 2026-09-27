import { readdirSync, readFileSync } from "node:fs";
import { MiosotisError } from "../../domain/errors.js";
import type { Database } from "./database.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Table rebuilds need foreign keys off, which SQLite only allows outside a transaction. */
  foreignKeysOff: boolean;
}

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const FK_OFF_DIRECTIVE = "-- miosotis:foreign-keys-off";

export function loadMigrations(): Migration[] {
  const migrations = readdirSync(MIGRATIONS_DIR)
    .map((file) => ({ file, match: FILE_PATTERN.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ file, match }) => {
      const sql = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
      return {
        version: Number.parseInt(match[1] ?? "0", 10),
        name: match[2] ?? file,
        sql,
        foreignKeysOff: sql.startsWith(FK_OFF_DIRECTIVE),
      };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MiosotisError("internal", `Migration sequence gap at ${migration.name}`);
    }
  });
  return migrations;
}

export function latestSchemaVersion(): number {
  return loadMigrations().length;
}

export function schemaVersion(db: Database): number {
  return Number(db.pragma("user_version"));
}

/**
 * Applies pending migrations. Each runs in its own IMMEDIATE transaction and re-reads
 * `user_version` after taking the lock, so two processes opening a fresh library cannot both apply it.
 */
export function migrate(db: Database, migrations: Migration[] = loadMigrations()): number {
  const latest = migrations.length;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new MiosotisError("schema_too_new", `Library schema v${current} is newer than this miosotis (v${latest})`, {
      schema_version: current,
      supported: latest,
    });
  }
  for (const migration of migrations) {
    if (migration.version <= schemaVersion(db)) {
      continue;
    }
    if (migration.foreignKeysOff) {
      db.exec("PRAGMA foreign_keys = OFF");
    }
    try {
      db.transaction(() => {
        if (migration.version <= schemaVersion(db)) {
          return;
        }
        db.exec(migration.sql);
        if (migration.foreignKeysOff) {
          const violations = db.all("PRAGMA foreign_key_check");
          if (violations.length > 0) {
            throw new MiosotisError("internal", `Migration ${migration.name} left foreign-key violations`);
          }
        }
        db.exec(`PRAGMA user_version = ${migration.version}`);
      });
    } finally {
      if (migration.foreignKeysOff) {
        db.exec("PRAGMA foreign_keys = ON");
      }
    }
  }
  return schemaVersion(db);
}
