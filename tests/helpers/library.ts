import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppContext, openContext } from "../../src/app/context.js";
import { initLibrary } from "../../src/app/init.js";
import { runCli } from "../../src/cli/program.js";

export interface TestLibrary {
  root: string;
  env: NodeJS.ProcessEnv;
  context: AppContext;
  cleanup: () => void;
}

/** A fresh, isolated library under the OS temp dir. Never touches ~/.miosotis. */
export function createTestLibrary(options: { now?: () => Date; timezone?: string } = {}): TestLibrary {
  const root = mkdtempSync(join(tmpdir(), "miosotis-test-"));
  const env: NodeJS.ProcessEnv = { MIOSOTIS_HOME: join(root, "home"), PATH: process.env.PATH ?? "" };
  initLibrary({ env });
  const context = openContext({ env, ...(options.now === undefined ? {} : { now: options.now }) });
  if (options.timezone !== undefined) {
    context.config.timezone = options.timezone;
  }
  return {
    root,
    env,
    context,
    cleanup: () => {
      context.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A clock that advances one second per call, for deterministic ordering. */
export function steppingClock(start = "2026-09-27T08:00:00.000Z"): () => Date {
  let current = Date.parse(start);
  return () => {
    const value = new Date(current);
    current += 1000;
    return value;
  };
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  // biome-ignore lint/suspicious/noExplicitAny: assertions inspect arbitrary envelope payloads
  json: () => { ok: boolean; data?: any; warnings?: string[]; error?: { code: string; message: string } };
}

/** Runs the CLI in-process against an isolated home, capturing output. */
export async function cli(env: NodeJS.ProcessEnv, ...argv: string[]): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    env,
    streams: { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}
