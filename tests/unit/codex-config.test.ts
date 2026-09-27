import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkill } from "../../src/app/skill.js";
import { configureCodexSandbox, planCodexSandboxEdit } from "../../src/infra/config/codex-config.js";

const ROOT = "/Users/me/.miosotis/data";

describe("planCodexSandboxEdit", () => {
  it("appends the table to a config without one, keeping existing content", () => {
    const original = '# my codex\nmodel = "gpt-x"\n\n[tools]\nview_image = true\n';
    const { text, changes } = planCodexSandboxEdit(original, { root: ROOT, allowNetwork: false });
    expect(text.startsWith(original.trimEnd())).toBe(true);
    expect(parse(text)).toMatchObject({
      model: "gpt-x",
      tools: { view_image: true },
      sandbox_workspace_write: { writable_roots: [ROOT] },
    });
    expect(changes).toEqual([`added writable root ${ROOT}`]);
    expect(
      (parse(text) as { sandbox_workspace_write: Record<string, unknown> }).sandbox_workspace_write.network_access,
    ).toBeUndefined();
  });

  it("merges into an existing table and keeps its comments and other keys", () => {
    const original =
      '[sandbox_workspace_write]\n# keep me\nwritable_roots = ["/tmp/a"]\nexclude_slash_tmp = true\n\n[other]\nx = 1\n';
    const { text } = planCodexSandboxEdit(original, { root: ROOT, allowNetwork: true });
    expect(text).toContain("# keep me");
    expect(parse(text)).toMatchObject({
      sandbox_workspace_write: { writable_roots: ["/tmp/a", ROOT], exclude_slash_tmp: true, network_access: true },
      other: { x: 1 },
    });
  });

  it("is a no-op when the settings are already present", () => {
    const original = `[sandbox_workspace_write]\nwritable_roots = ["${ROOT}"]\nnetwork_access = true\n`;
    expect(planCodexSandboxEdit(original, { root: ROOT, allowNetwork: true })).toEqual({ text: original, changes: [] });
  });

  it("refuses a config it cannot parse", () => {
    expect(() => planCodexSandboxEdit("not = [toml", { root: ROOT, allowNetwork: false })).toThrow(/Cannot parse/);
  });
});

describe("configureCodexSandbox and skill install for Codex", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miosotis-codex-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("backs up, writes through a symlinked CODEX_HOME, and reports every change", () => {
    const real = join(dir, "repo", "codex");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "config.toml"), 'approval_policy = "on-request"\n');
    symlinkSync(real, join(dir, "codex-link"), "dir");
    const env = { HOME: join(dir, "home"), CODEX_HOME: join(dir, "codex-link"), MIOSOTIS_HOME: join(dir, "mio") };
    expect(() => installSkill({ host: "codex", yes: false, env })).toThrow(/added writable root .*mio.*data/);
    const result = installSkill({ host: "codex", yes: true, env, now: new Date("2026-09-27T12:00:00Z") });
    expect(result.changes.join("\n")).toMatch(/copied the Codex Skill/);
    expect(result.changes.join("\n")).toMatch(/added writable root .*mio\/data/);
    expect(result.changes.join("\n")).toMatch(/backed up the previous Codex config/);
    expect(result.notes.join(" ")).toMatch(/--allow-network/);
    const written = parse(readFileSync(join(real, "config.toml"), "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({
      approval_policy: "on-request",
      sandbox_workspace_write: { writable_roots: [join(dir, "mio", "data")] },
    });
    expect(readdirSync(real).some((name) => name.startsWith("config.toml.bak-miosotis-"))).toBe(true);
    const again = installSkill({ host: "codex", yes: true, env });
    expect(again).toMatchObject({ changed: false, changes: [] });
    const network = installSkill({ host: "codex", yes: true, allowNetwork: true, env });
    expect(network.changes.join("\n")).toMatch(/enabled network_access/);
    expect(
      configureCodexSandbox(env, { root: join(dir, "mio", "data"), allowNetwork: true, now: new Date() }).changes,
    ).toEqual([]);
  });

  it("can skip the sandbox edit entirely", () => {
    const env = { HOME: join(dir, "home"), CODEX_HOME: join(dir, "codex"), MIOSOTIS_HOME: join(dir, "mio") };
    const result = installSkill({ host: "codex", yes: true, configureSandbox: false, env });
    expect(result.changes).toHaveLength(1);
    expect(result.notes.join(" ")).toMatch(/not configured/);
  });
});
