import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MiosotisError } from "../domain/errors.js";
import {
  codexConfigPath,
  codexNetworkEnabled,
  configureCodexSandbox,
  planCodexSandboxEdit,
} from "../infra/config/codex-config.js";
import { loadConfig } from "../infra/config/config.js";
import { ensureDir } from "../infra/fs/files.js";
import { VERSION } from "../version.js";

export const SKILL_HOSTS = {
  "claude-code": { label: "Claude Code", relative: [".claude", "skills"] },
  codex: { label: "Codex", relative: [".agents", "skills"] },
} as const;

export type SkillHost = keyof typeof SKILL_HOSTS;

/** Written into an installed copy so miosotis can recognize, update, and remove only its own Skill. */
export const MARKER_FILE = ".miosotis-skill.json";

type InstallState = "missing" | "copied" | "outdated" | "linked" | "foreign";

interface Marker {
  name: "miosotis";
  version: string;
  content_hash: string;
  installed_at: string;
}

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

const HOST_NOTES_PLACEHOLDER = "<!-- miosotis:host-notes -->";

/** Host-specific overlays: `notes.md` is inserted into SKILL.md; other files are added as-is. */
export function hostOverlayDir(host: SkillHost): string {
  return fileURLToPath(new URL(`../../skill/hosts/${host}`, import.meta.url));
}

function files(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== MARKER_FILE)
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * The Skill as installed for one host: the shared package plus that host's overlay. Agent hosts do not
 * all follow the same Skill conventions (invocation syntax, image tools, sandboxes, extra metadata).
 */
export function renderSkill(host: SkillHost): Map<string, Buffer> {
  const source = skillSourceDir();
  const overlay = hostOverlayDir(host);
  const rendered = new Map<string, Buffer>();
  for (const file of files(source)) {
    rendered.set(file, readFileSync(join(source, file)));
  }
  const notesPath = join(overlay, "notes.md");
  const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8").trim() : "";
  const skill = rendered.get("SKILL.md")?.toString("utf8") ?? "";
  rendered.set("SKILL.md", Buffer.from(skill.replace(HOST_NOTES_PLACEHOLDER, notes), "utf8"));
  for (const file of files(overlay)) {
    if (file !== "notes.md") {
      rendered.set(file, readFileSync(join(overlay, file)));
    }
  }
  return rendered;
}

/** A hash over relative paths and bytes, so an installed copy can be checked for drift. */
export function contentHash(entries: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const file of [...entries.keys()].sort()) {
    hash
      .update(file)
      .update("\0")
      .update(entries.get(file) ?? Buffer.alloc(0))
      .update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function readMarker(target: string): Marker | undefined {
  try {
    const marker = JSON.parse(readFileSync(join(target, MARKER_FILE), "utf8")) as Marker;
    return marker.name === "miosotis" ? marker : undefined;
  } catch {
    return undefined;
  }
}

function installState(target: string, source: string, sourceHash: string): { state: InstallState; marker?: Marker } {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) {
    return { state: "missing" };
  }
  if (stat.isSymbolicLink()) {
    return resolve(dirname(target), readlinkSync(target)) === resolve(source)
      ? { state: "linked" }
      : { state: "foreign" };
  }
  const marker = stat.isDirectory() ? readMarker(target) : undefined;
  if (marker === undefined) {
    return { state: "foreign" };
  }
  // Compare what is actually on disk, so both upgrades and hand edits count as outdated.
  const installed = new Map(files(target).map((file) => [file, readFileSync(join(target, file))] as const));
  return { state: contentHash(installed) === sourceHash ? "copied" : "outdated", marker };
}

export function skillStatus(options: { env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? process.env;
  const source = skillSourceDir();
  return {
    source,
    version: VERSION,
    hosts: (Object.keys(SKILL_HOSTS) as SkillHost[]).map((host) => {
      const target = targetFor(host, env);
      const { state, marker } = installState(target, source, contentHash(renderSkill(host)));
      return { host, label: SKILL_HOSTS[host].label, target, state, installed_version: marker?.version ?? null };
    }),
  };
}

/** Removes an entry only if it is miosotis's own (its symlink, or a copy carrying the marker). */
function removeOwn(target: string, state: InstallState): void {
  if (state === "linked") {
    unlinkSync(target);
  } else if (state === "copied" || state === "outdated") {
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Installs the Skill into an agent host's personal skills folder. By default it copies the Skill (so it
 * works without this checkout) and writes a marker with the version and content hash; running it again
 * updates only miosotis's own copy. `link` creates a symlink instead, for development. Writing into
 * another tool's folder needs explicit consent (`yes`), and entries miosotis did not create are never
 * replaced.
 */
export interface InstallOptions {
  host: string;
  yes: boolean;
  link?: boolean;
  /** Codex only: also add the miosotis data folder to Codex's sandbox writable roots (default true). */
  configureSandbox?: boolean;
  /** Codex only: also set `network_access = true` (affects all sandboxed Codex commands). */
  allowNetwork?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

/**
 * Installs the Skill into an agent host's personal skills folder. By default it copies a host-adapted
 * Skill (so it works without this checkout) with a marker; running it again updates only miosotis's own
 * copy. For Codex it also prepares the sandbox (a writable root for the library, and network only on
 * request). Writing into another tool's folders needs explicit consent (`yes`); every pending change is
 * listed before, and every applied change after. Entries miosotis did not create are never replaced.
 */
export function installSkill(options: InstallOptions) {
  const host = parseHost(options.host);
  const env = options.env ?? process.env;
  const source = skillSourceDir();
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new MiosotisError("environment", `Skill package not found at ${source}`);
  }
  const mode = options.link === true ? "link" : "copy";
  const rendered = renderSkill(host);
  const sourceHash = contentHash(rendered);
  const target = targetFor(host, env);
  const { state } = installState(target, source, sourceHash);
  if (state === "foreign") {
    throw new MiosotisError(
      "conflict",
      `${target} already exists and is not this miosotis Skill; remove it yourself first`,
      {
        target,
      },
    );
  }
  const skillUpToDate = (mode === "copy" && state === "copied") || (mode === "link" && state === "linked");
  const pending: string[] = [];
  if (!skillUpToDate) {
    pending.push(
      mode === "link"
        ? `create a symlink ${target} -> ${source}`
        : state === "missing"
          ? `copy the ${SKILL_HOSTS[host].label} version of the Skill (v${VERSION}) to ${target}`
          : `replace the installed Skill at ${target} with the ${SKILL_HOSTS[host].label} version of v${VERSION}`,
    );
  }
  const sandbox =
    host === "codex" && options.configureSandbox !== false
      ? {
          root: loadConfig(env).library.dataDir,
          allowNetwork: options.allowNetwork === true,
          path: codexConfigPath(env),
        }
      : undefined;
  if (sandbox !== undefined) {
    const current = existsSync(sandbox.path) ? readFileSync(realpathSync(sandbox.path), "utf8") : "";
    for (const change of planCodexSandboxEdit(current, sandbox).changes) {
      pending.push(`${change} in ${sandbox.path}`);
    }
  }
  if (pending.length === 0) {
    return {
      host,
      target,
      source,
      mode,
      version: VERSION,
      changed: false,
      changes: [] as string[],
      notes: hostNotes(host, sandbox, env),
      next_step: restartHint(host),
    };
  }
  if (!options.yes) {
    throw new MiosotisError("confirmation_required", `This will: ${pending.join("; ")}. Re-run with --yes.`, {
      target,
      source,
      mode,
      pending,
    });
  }
  const changes: string[] = [];
  if (!skillUpToDate) {
    ensureDir(dirname(target), 0o755);
    if (mode === "link") {
      removeOwn(target, state);
      symlinkSync(source, target, "dir");
      changes.push(`linked ${target} -> ${source}`);
    } else {
      const staging = `${target}.installing-${process.pid}`;
      rmSync(staging, { recursive: true, force: true });
      for (const [file, bytes] of rendered) {
        ensureDir(dirname(join(staging, file)), 0o755);
        writeFileSync(join(staging, file), bytes);
      }
      const marker: Marker = {
        name: "miosotis",
        version: VERSION,
        content_hash: sourceHash,
        installed_at: new Date().toISOString(),
      };
      writeFileSync(join(staging, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
      removeOwn(target, state);
      renameSync(staging, target);
      changes.push(
        `${state === "missing" ? "copied" : "updated"} the ${SKILL_HOSTS[host].label} Skill (v${VERSION}) at ${target}`,
      );
    }
  }
  if (sandbox !== undefined) {
    const result = configureCodexSandbox(env, { ...sandbox, now: options.now ?? new Date() });
    for (const change of result.changes) {
      changes.push(
        `${change} in ${result.real_path}${result.real_path === result.path ? "" : ` (via ${result.path})`}`,
      );
    }
    if (result.backup !== null) {
      changes.push(`backed up the previous Codex config to ${result.backup}`);
    }
  }
  return {
    host,
    target,
    source,
    mode,
    version: VERSION,
    changed: true,
    changes,
    notes: hostNotes(host, sandbox, env),
    next_step: restartHint(host),
  };
}

function hostNotes(host: SkillHost, sandbox: { allowNetwork: boolean } | undefined, env: NodeJS.ProcessEnv): string[] {
  if (host !== "codex") {
    return [];
  }
  const notes = [
    'Codex applies writable_roots when it runs in workspace-write ("Auto") mode; in read-only mode it asks before each write.',
  ];
  if (sandbox !== undefined && !sandbox.allowNetwork && !codexNetworkEnabled(env)) {
    notes.push(
      "Network access was not changed. Saving web links needs it: re-run with --allow-network (affects all sandboxed Codex commands).",
    );
  }
  if (sandbox === undefined) {
    notes.push("The Codex sandbox was not configured (--no-sandbox-config); see docs/skill.md.");
  }
  return notes;
}

export function uninstallSkill(options: { host: string; env?: NodeJS.ProcessEnv }) {
  const host = parseHost(options.host);
  const env = options.env ?? process.env;
  const source = skillSourceDir();
  const target = targetFor(host, env);
  const { state } = installState(target, source, contentHash(renderSkill(host)));
  if (state === "foreign") {
    throw new MiosotisError("conflict", `${target} is not a miosotis Skill; leaving it untouched`);
  }
  removeOwn(target, state);
  return { host, target, changed: state !== "missing" };
}

function restartHint(host: SkillHost): string {
  return `Start a new ${SKILL_HOSTS[host].label} session (or reload skills) so it picks up the miosotis Skill.`;
}
