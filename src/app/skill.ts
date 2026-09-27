import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MiosotisError } from "../domain/errors.js";
import { ensureDir } from "../infra/fs/files.js";

export const SKILL_HOSTS = {
  "claude-code": { label: "Claude Code", relative: [".claude", "skills"] },
  codex: { label: "Codex", relative: [".agents", "skills"] },
} as const;

export type SkillHost = keyof typeof SKILL_HOSTS;

/** The Skill package shipped with this checkout/package (at the package root, beside src/ and dist/). */
export function skillSourceDir(): string {
  return fileURLToPath(new URL("../../skill/miosotis", import.meta.url));
}

function targetFor(host: SkillHost, env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || homedir();
  return join(home, ...SKILL_HOSTS[host].relative, "miosotis");
}

function parseHost(value: string): SkillHost {
  if (!(value in SKILL_HOSTS)) {
    throw new MiosotisError("usage", `--host must be one of: ${Object.keys(SKILL_HOSTS).join(", ")}`);
  }
  return value as SkillHost;
}

function linkState(target: string, source: string): "missing" | "installed" | "foreign" {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) {
    return "missing";
  }
  if (stat.isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === resolve(source)) {
    return "installed";
  }
  return "foreign";
}

export function skillStatus(options: { env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? process.env;
  const source = skillSourceDir();
  return {
    source,
    hosts: (Object.keys(SKILL_HOSTS) as SkillHost[]).map((host) => {
      const target = targetFor(host, env);
      return { host, label: SKILL_HOSTS[host].label, target, state: linkState(target, source) };
    }),
  };
}

/**
 * Links the repository's Skill folder into an agent host's personal skills directory. Writing into
 * another tool's configuration needs explicit consent (`--yes`), and an existing non-miosotis entry is
 * never replaced.
 */
export function installSkill(options: { host: string; yes: boolean; env?: NodeJS.ProcessEnv }) {
  const host = parseHost(options.host);
  const env = options.env ?? process.env;
  const source = skillSourceDir();
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new MiosotisError("environment", `Skill package not found at ${source}`);
  }
  const target = targetFor(host, env);
  const state = linkState(target, source);
  if (state === "installed") {
    return { host, target, source, changed: false, next_step: restartHint(host) };
  }
  if (state === "foreign") {
    throw new MiosotisError(
      "conflict",
      `${target} already exists and is not this miosotis Skill; remove it yourself first`,
      {
        target,
      },
    );
  }
  if (!options.yes) {
    throw new MiosotisError(
      "confirmation_required",
      `This will create a symlink ${target} -> ${source}. Re-run with --yes.`,
      {
        target,
        source,
      },
    );
  }
  ensureDir(dirname(target), 0o755);
  symlinkSync(source, target, "dir");
  return { host, target, source, changed: true, next_step: restartHint(host) };
}

export function uninstallSkill(options: { host: string; env?: NodeJS.ProcessEnv }) {
  const host = parseHost(options.host);
  const env = options.env ?? process.env;
  const source = skillSourceDir();
  const target = targetFor(host, env);
  const state = linkState(target, source);
  if (state === "foreign") {
    throw new MiosotisError("conflict", `${target} is not a miosotis Skill link; leaving it untouched`);
  }
  if (state === "installed") {
    unlinkSync(target);
  }
  return { host, target, changed: state === "installed" };
}

function restartHint(host: SkillHost): string {
  return `Start a new ${SKILL_HOSTS[host].label} session so it discovers the miosotis Skill.`;
}
