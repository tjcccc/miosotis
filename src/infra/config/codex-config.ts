import { copyFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { MiosotisError } from "../../domain/errors.js";
import { writeFileAtomic } from "../fs/files.js";

const TABLE = "sandbox_workspace_write";

export function codexConfigPath(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".codex");
  return join(codexHome, "config.toml");
}

interface SandboxTable {
  writable_roots?: unknown;
  network_access?: unknown;
}

function readTable(text: string): SandboxTable | undefined {
  try {
    const parsed = parse(text) as Record<string, unknown>;
    const table = parsed[TABLE];
    return table !== null && typeof table === "object" ? (table as SandboxTable) : undefined;
  } catch (error) {
    throw new MiosotisError("validation", `Cannot parse the Codex config: ${(error as Error).message}`);
  }
}

/** Where `[sandbox_workspace_write]` starts and ends in the text (up to the next table header). */
function tableSpan(text: string): { start: number; bodyStart: number; end: number } | undefined {
  const header = /^\[sandbox_workspace_write\][^\n]*\n?/m.exec(text);
  if (header === null) {
    return undefined;
  }
  const bodyStart = header.index + header[0].length;
  const next = /^\[/m.exec(text.slice(bodyStart));
  return { start: header.index, bodyStart, end: next === null ? text.length : bodyStart + next.index };
}

/**
 * Pure text edit that adds `root` to `writable_roots` (and optionally sets `network_access = true`)
 * under `[sandbox_workspace_write]`, keeping everything else — comments, order, other tables — intact.
 */
export function planCodexSandboxEdit(
  text: string,
  options: { root: string; allowNetwork: boolean },
): { text: string; changes: string[] } {
  const table = readTable(text);
  const existingRoots: unknown = table?.writable_roots;
  const roots = Array.isArray(existingRoots) ? existingRoots.filter((r): r is string => typeof r === "string") : [];
  const needsRoot = !roots.includes(options.root);
  const needsNetwork = options.allowNetwork && table?.network_access !== true;
  if (!needsRoot && !needsNetwork) {
    return { text, changes: [] };
  }
  const changes: string[] = [];
  const rootsLine = `writable_roots = ${JSON.stringify([...roots, options.root])}`;
  let next = text;
  const span = tableSpan(next);
  if (span === undefined) {
    const lines = [`[${TABLE}]`, "# Added by `miosotis skill install --host codex` so miosotis can write its library."];
    if (needsRoot) {
      lines.push(rootsLine);
      changes.push(`added writable root ${options.root}`);
    }
    if (needsNetwork) {
      lines.push("network_access = true");
      changes.push("enabled network_access (applies to all sandboxed Codex commands)");
    }
    next = `${next.replace(/\s*$/, "")}\n\n${lines.join("\n")}\n`;
  } else {
    let body = next.slice(span.bodyStart, span.end);
    if (needsRoot) {
      const existing = /^writable_roots\s*=\s*\[[\s\S]*?\]/m;
      body = existing.test(body) ? body.replace(existing, rootsLine) : `${rootsLine}\n${body}`;
      changes.push(`added writable root ${options.root}`);
    }
    if (needsNetwork) {
      const existing = /^network_access\s*=\s*\S+/m;
      body = existing.test(body) ? body.replace(existing, "network_access = true") : `network_access = true\n${body}`;
      changes.push("enabled network_access (applies to all sandboxed Codex commands)");
    }
    next = `${next.slice(0, span.bodyStart)}${body}${next.slice(span.end)}`;
  }
  const verify = readTable(next);
  if (!Array.isArray(verify?.writable_roots) || !(verify.writable_roots as unknown[]).includes(options.root)) {
    throw new MiosotisError(
      "internal",
      "Refusing to write the Codex config: the edit did not produce the expected setting",
    );
  }
  return { text: next, changes };
}

export interface CodexConfigResult {
  path: string;
  /** The real file written when `path` is (or sits inside) a symlink. */
  real_path: string;
  backup: string | null;
  changes: string[];
}

/**
 * Applies the edit to the user's Codex config: backs up the original next to it, writes through
 * symlinks to the real file, and does nothing when the settings are already present.
 */
export function configureCodexSandbox(
  env: NodeJS.ProcessEnv,
  options: { root: string; allowNetwork: boolean; now: Date },
): CodexConfigResult {
  const path = codexConfigPath(env);
  const exists = existsSync(path);
  const realPath = exists ? realpathSync(path) : path;
  const original = exists ? readFileSync(realPath, "utf8") : "";
  const plan = planCodexSandboxEdit(original, options);
  if (plan.changes.length === 0) {
    return { path, real_path: realPath, backup: null, changes: [] };
  }
  let backup: string | null = null;
  if (exists) {
    backup = `${realPath}.bak-miosotis-${options.now.toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(realPath, backup);
  }
  writeFileAtomic(realPath, plan.text, 0o600);
  return { path, real_path: realPath, backup, changes: plan.changes };
}

/** Whether the user's Codex config already allows network access for sandboxed commands. */
export function codexNetworkEnabled(env: NodeJS.ProcessEnv): boolean {
  const path = codexConfigPath(env);
  if (!existsSync(path)) {
    return false;
  }
  return readTable(readFileSync(realpathSync(path), "utf8"))?.network_access === true;
}
