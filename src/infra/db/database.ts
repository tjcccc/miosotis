import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MiosotisError } from "../../domain/errors.js";

export type Params = Record<string, SQLInputValue> | SQLInputValue[];

export interface OpenOptions {
  /** Create the file when missing. Only `init` and `restore` may create a library. */
  create?: boolean;
  readOnly?: boolean;
}

const BUSY_TIMEOUT_MS = 5000;

/**
 * The only module that touches `node:sqlite`. Every connection enforces foreign keys and the
 * defensive flag, uses a bounded busy timeout, and full synchronous durability.
 */
export class Database {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path: string, options: OpenOptions = {}) {
    this.path = path;
    this.db = new DatabaseSync(path, {
      readOnly: options.readOnly ?? false,
      timeout: BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
      defensive: true,
    });
    if (!options.readOnly) {
      this.db.exec("PRAGMA synchronous = FULL");
    }
    if (this.pragma("foreign_keys") !== 1) {
      this.db.close();
      throw new MiosotisError("environment", "SQLite foreign-key enforcement could not be enabled");
    }
  }

  pragma(name: string): unknown {
    if (!/^[a-z_]+$/.test(name)) {
      throw new MiosotisError("internal", `Invalid pragma name: ${name}`);
    }
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Object.values(row)[0];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const statement = this.db.prepare(sql);
    const result = Array.isArray(params) ? statement.run(...params) : statement.run(params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const statement = this.db.prepare(sql);
    return (Array.isArray(params) ? statement.get(...params) : statement.get(params)) as T | undefined;
  }

  all<T>(sql: string, params: Params = []): T[] {
    const statement = this.db.prepare(sql);
    return (Array.isArray(params) ? statement.all(...params) : statement.all(params)) as T[];
  }

  get inTransaction(): boolean {
    return this.db.isTransaction;
  }

  /**
   * Runs `work` inside `BEGIN IMMEDIATE` so concurrent writers wait on the busy timeout instead of
   * failing on lock upgrade. Rolls back on any error, including a deferred foreign-key failure at
   * COMMIT (which leaves the transaction open). Nested calls join the outer transaction.
   */
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) {
      return work();
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw translateBusy(error);
    }
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      throw translateBusy(error);
    } finally {
      if (this.db.isTransaction) {
        this.db.exec("ROLLBACK");
      }
    }
  }

  /** The raw handle, for the backup module only. */
  get handle(): DatabaseSync {
    return this.db;
  }

  close(): void {
    if (this.db.isOpen) {
      this.db.close();
    }
  }
}

function translateBusy(error: unknown): unknown {
  if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) {
    return new MiosotisError("busy", "The library is busy; retry shortly");
  }
  return error;
}

/** Inspects the SQLite library actually linked into this runtime (brief §8.3). */
export function probeSqlite(): { version: string; fts5Trigram: boolean; error: string | null } {
  const probe = new DatabaseSync(":memory:");
  try {
    const version = String((probe.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v);
    try {
      probe.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'trigram remove_diacritics 1')");
      return { version, fts5Trigram: true, error: null };
    } catch (error) {
      return { version, fts5Trigram: false, error: (error as Error).message };
    }
  } finally {
    probe.close();
  }
}
