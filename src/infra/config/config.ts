import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { MiosotisError } from "../../domain/errors.js";

export const CONFIG_FILENAME = "config.toml";
export const DEFAULT_DATA_DIRNAME = "data";
export const DATABASE_FILENAME = "library.sqlite3";

export interface HomePaths {
  home: string;
  configFile: string;
}

export interface LibraryPaths {
  dataDir: string;
  database: string;
  artifactsDir: string;
  stagingDir: string;
  blobsDir: string;
}

export interface MiosotisConfig {
  paths: HomePaths;
  library: LibraryPaths;
  backupDir: string | undefined;
  timezone: string;
  /** Preferred reply language for AI hosts (BCP-47), or undefined to follow the user's own writing. */
  language: string | undefined;
  /** Whether a config file exists on disk (false means defaults are in effect). */
  fileExists: boolean;
}

const ConfigFileSchema = z
  .object({
    data_dir: z.string().min(1).optional(),
    user: z
      .object({
        timezone: z.string().min(1).optional(),
        language: z
          .string()
          .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a BCP-47 tag such as en, zh-CN, ja")
          .optional(),
      })
      .strict()
      .optional(),
    backup: z
      .object({ dir: z.string().min(1).optional() })
      .strict()
      .optional(),
  })
  .strict();

export function resolveHome(env: NodeJS.ProcessEnv = process.env): HomePaths {
  const override = env.MIOSOTIS_HOME?.trim();
  const home = override ? resolve(expandTilde(override)) : join(env.HOME?.trim() || homedir(), ".miosotis");
  return { home, configFile: join(home, CONFIG_FILENAME) };
}

export function libraryPaths(dataDir: string): LibraryPaths {
  return {
    dataDir,
    database: join(dataDir, DATABASE_FILENAME),
    artifactsDir: join(dataDir, "artifacts"),
    stagingDir: join(dataDir, "staging"),
    blobsDir: join(dataDir, "blobs"),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MiosotisConfig {
  const paths = resolveHome(env);
  const fileExists = existsSync(paths.configFile);
  let raw: unknown = {};
  if (fileExists) {
    try {
      raw = parse(readFileSync(paths.configFile, "utf8"));
    } catch (error) {
      throw new MiosotisError("validation", `Cannot parse ${paths.configFile}: ${(error as Error).message}`);
    }
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MiosotisError("validation", `Invalid ${paths.configFile}: ${z.prettifyError(parsed.error)}`);
  }
  const file = parsed.data;
  const dataDir = resolveConfiguredPath(file.data_dir, paths.home) ?? join(paths.home, DEFAULT_DATA_DIRNAME);
  const timezone = file.user?.timezone ?? systemTimezone();
  assertTimezone(timezone);
  return {
    paths,
    library: libraryPaths(dataDir),
    backupDir: resolveConfiguredPath(file.backup?.dir, paths.home),
    timezone,
    language: file.user?.language,
    fileExists,
  };
}

export function resolveConfiguredPath(value: string | undefined, base: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const expanded = expandTilde(value.trim());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

export function expandTilde(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new MiosotisError("validation", `Unknown IANA timezone: ${timezone}`);
  }
}

export function configTemplate(dataDir: string | undefined, language?: string): string {
  const dataLine = dataDir === undefined ? '# data_dir = "~/.miosotis/data"' : `data_dir = ${JSON.stringify(dataDir)}`;
  return [
    "# miosotis configuration. All keys are optional.",
    "",
    "# Library folder (database + managed files). Keep it on a local disk, not in a live-synced",
    "# folder such as OneDrive or iCloud; use [backup].dir for cloud copies instead.",
    dataLine,
    "",
    "[user]",
    "# Preferred reply language for AI hosts (BCP-47, e.g. en, zh-CN, ja). Unset: follow the language you write in.",
    "# Saved text is never translated.",
    language === undefined ? '# language = "en"' : `language = ${JSON.stringify(language)}`,
    '# IANA timezone used to interpret dates such as "today". Defaults to the system timezone.',
    '# timezone = "Europe/Berlin"',
    "",
    "[backup]",
    "# Default destination for `miosotis backup create` (a cloud-synced folder is fine here).",
    '# dir = "~/OneDrive/miosotis-backups"',
    "",
  ].join("\n");
}
