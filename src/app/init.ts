import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { MiosotisError } from "../domain/errors.js";
import { configTemplate, loadConfig, resolveConfiguredPath, resolveHome } from "../infra/config/config.js";
import { Database } from "../infra/db/database.js";
import { migrate } from "../infra/db/migrate.js";
import { ensureDir, writeFileAtomic } from "../infra/fs/files.js";

export interface InitResult {
  home: string;
  config_file: string;
  config_created: boolean;
  data_dir: string;
  database: string;
  library_created: boolean;
  schema_version: number;
  journal_mode: string;
}

/** Creates the home folder, config file, and library. Safe to run again. */
export function initLibrary(
  options: { env?: NodeJS.ProcessEnv; dataDir?: string; language?: string } = {},
): InitResult {
  const home = resolveHome(options.env);
  ensureDir(home.home);
  const requestedDataDir = resolveConfiguredPath(options.dataDir, process.cwd());
  let configCreated = false;
  if (existsSync(home.configFile)) {
    if (options.language !== undefined) {
      const existing = parse(readFileSync(home.configFile, "utf8")) as { user?: { language?: unknown } };
      if (existing.user?.language !== options.language) {
        throw new MiosotisError(
          "conflict",
          `${home.configFile} already exists; set language = ${JSON.stringify(options.language)} under [user] there instead.`,
        );
      }
    }
    if (requestedDataDir !== undefined) {
      const existing = parse(readFileSync(home.configFile, "utf8")) as { data_dir?: unknown };
      const configured =
        typeof existing.data_dir === "string" ? resolveConfiguredPath(existing.data_dir, home.home) : undefined;
      if (configured !== requestedDataDir) {
        throw new MiosotisError(
          "conflict",
          `${home.configFile} already exists with a different data_dir. Edit it instead of passing --data-dir.`,
          { configured: configured ?? null, requested: requestedDataDir },
        );
      }
    }
  } else {
    if (options.language !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(options.language)) {
      throw new MiosotisError("validation", `Not a BCP-47 language tag: ${options.language}`);
    }
    writeFileAtomic(home.configFile, configTemplate(requestedDataDir, options.language));
    configCreated = true;
  }
  const config = loadConfig(options.env);
  const { library } = config;
  ensureDir(library.dataDir);
  ensureDir(library.artifactsDir);
  ensureDir(library.stagingDir);
  ensureDir(library.blobsDir);
  const libraryCreated = !existsSync(library.database);
  const db = new Database(library.database, { create: true });
  try {
    const journalMode = String(db.get<{ journal_mode: string }>("PRAGMA journal_mode = WAL")?.journal_mode);
    const schemaVersion = migrate(db);
    db.transaction(() => {
      db.run("INSERT OR IGNORE INTO library_meta (key, value) VALUES ('library_id', ?)", [randomUUID()]);
      db.run("INSERT OR IGNORE INTO library_meta (key, value) VALUES ('created_at', ?)", [new Date().toISOString()]);
    });
    return {
      home: home.home,
      config_file: home.configFile,
      config_created: configCreated,
      data_dir: library.dataDir,
      database: library.database,
      library_created: libraryCreated,
      schema_version: schemaVersion,
      journal_mode: journalMode,
    };
  } finally {
    db.close();
  }
}
