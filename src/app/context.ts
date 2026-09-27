import { existsSync } from "node:fs";
import { MiosotisError } from "../domain/errors.js";
import { BlobStore } from "../infra/blobs/store.js";
import { loadConfig, type MiosotisConfig } from "../infra/config/config.js";
import { Database } from "../infra/db/database.js";
import { migrate } from "../infra/db/migrate.js";

/** Everything a use case needs. Interfaces (CLI now, HTTP later) build one per request/process. */
export interface AppContext {
  config: MiosotisConfig;
  db: Database;
  blobs: BlobStore;
  now: () => Date;
}

export interface ContextOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Opens an existing library, applying pending migrations. Never creates one (that is `init`). */
export function openContext(options: ContextOptions = {}): AppContext {
  const config = loadConfig(options.env);
  if (!existsSync(config.library.database)) {
    throw new MiosotisError("library_not_initialized", "No miosotis library found. Run `miosotis init` first.", {
      data_dir: config.library.dataDir,
    });
  }
  const db = new Database(config.library.database);
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    config,
    db,
    blobs: new BlobStore(config.library.blobsDir, config.library.stagingDir),
    now: options.now ?? (() => new Date()),
  };
}

export function closeContext(context: AppContext): void {
  context.db.close();
}

export function withContext<T>(options: ContextOptions, work: (context: AppContext) => T): T {
  const context = openContext(options);
  try {
    return work(context);
  } finally {
    closeContext(context);
  }
}

export async function withContextAsync<T>(
  options: ContextOptions,
  work: (context: AppContext) => Promise<T>,
): Promise<T> {
  const context = openContext(options);
  try {
    return await work(context);
  } finally {
    closeContext(context);
  }
}

export function isoNow(context: AppContext): string {
  return context.now().toISOString();
}
