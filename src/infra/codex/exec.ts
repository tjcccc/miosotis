import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MiosotisError } from "../../domain/errors.js";
import { ensureDir } from "../fs/files.js";

/**
 * Folders that hold wrappers around `codex` rather than Codex itself (cmux's terminal shims add
 * their own hooks, which would receive the prompt). The worker stores the real binary instead.
 */
const WRAPPER_DIR = /[\\/]cmux-cli-shims([\\/]|$)/;

/** The first `codex` executable on PATH that is not a known wrapper, or undefined. */
export function findCodexBinary(env: NodeJS.ProcessEnv): string | undefined {
  const separator = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
  for (const entry of (env.PATH ?? "").split(separator)) {
    if (entry.length === 0 || WRAPPER_DIR.test(entry)) {
      continue;
    }
    for (const name of names) {
      const candidate = join(entry, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new MiosotisError("environment", `Cannot run ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

/** Whether Codex is signed in (`codex login status`). miosotis never reads Codex credentials. */
export async function codexLoginStatus(
  codexPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; detail: string }> {
  const result = await run(codexPath, ["login", "status"], { env, timeoutMs: 30_000 });
  const detail = `${result.stdout}\n${result.stderr}`.trim().split("\n").at(-1) ?? "";
  return { ok: result.code === 0, detail: detail.slice(0, 200) };
}

/** Event items a tool-less answer may contain; anything else means the model used a tool. */
const ALLOWED_ITEMS = new Set(["agent_message", "reasoning"]);

export interface CodexExecOptions {
  codexPath: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  model: string | undefined;
  reasoningEffort: string;
  /** Private scratch folder (inside the library); a fresh, empty subfolder is the working directory. */
  scratchDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CodexExecResult {
  output: unknown;
  usage: { input_tokens?: number; output_tokens?: number } | null;
}

/**
 * Runs one tool-less `codex exec` turn and returns its structured answer. Codex runs without the
 * user's Codex config, rules, hooks, shell, or web search, in a read-only sandbox, from an empty
 * folder, and keeps no session. Any tool use in the event stream rejects the answer.
 */
export async function codexExec(options: CodexExecOptions): Promise<CodexExecResult> {
  ensureDir(options.scratchDir);
  const workDir = mkdtempSync(join(options.scratchDir, "codex-"));
  const cwd = join(workDir, "cwd");
  ensureDir(cwd);
  const schemaFile = join(workDir, "output.schema.json");
  const outputFile = join(workDir, "output.json");
  writeFileSync(schemaFile, JSON.stringify(options.outputSchema), { mode: 0o600 });
  const args = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    ...["-c", "features.shell_tool=false"],
    ...["-c", "features.hooks=false"],
    ...["-c", "features.apps=false"],
    ...["-c", "features.plugins=false"],
    ...["-c", "features.browser_use=false"],
    ...["-c", "features.computer_use=false"],
    ...["-c", "features.in_app_browser=false"],
    ...["-c", 'web_search="disabled"'],
    ...["-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`],
    ...(options.model === undefined ? [] : ["--model", options.model]),
    "--output-schema",
    schemaFile,
    "--output-last-message",
    outputFile,
    "-",
  ];
  try {
    const result = await run(options.codexPath, args, {
      cwd,
      env: options.env,
      input: options.prompt,
      timeoutMs: options.timeoutMs ?? 300_000,
    });
    if (result.timedOut) {
      throw new MiosotisError("environment", "Codex did not answer in time");
    }
    const events = parseEvents(result.stdout);
    const tools = events.flatMap((event) => {
      const type = event.item?.type;
      return typeof type === "string" && !ALLOWED_ITEMS.has(type) ? [type] : [];
    });
    if (tools.length > 0) {
      throw new MiosotisError("validation", `Codex used a tool (${[...new Set(tools)].join(", ")}); answer rejected`);
    }
    const failure = events.find((event) => event.type === "error" || event.type === "turn.failed");
    if (result.code !== 0 || failure !== undefined) {
      const reason = failure?.message ?? failure?.error?.message ?? lastLine(result.stderr);
      throw new MiosotisError("environment", `Codex failed (exit ${result.code ?? "killed"}): ${reason}`.slice(0, 300));
    }
    if (!existsSync(outputFile)) {
      throw new MiosotisError("validation", "Codex returned no answer");
    }
    let output: unknown;
    try {
      output = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch {
      throw new MiosotisError("validation", "Codex's answer is not JSON");
    }
    const usage = events.find((event) => event.type === "turn.completed")?.usage ?? null;
    return { output, usage };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

interface CodexEvent {
  type?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: unknown };
  usage?: { input_tokens?: number; output_tokens?: number };
}

function parseEvents(stdout: string): CodexEvent[] {
  return stdout.split("\n").flatMap((line) => {
    if (line.trim().length === 0) {
      return [];
    }
    try {
      const event = JSON.parse(line) as unknown;
      return event !== null && typeof event === "object" ? [event as CodexEvent] : [];
    } catch {
      return [];
    }
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? "no output";
}
