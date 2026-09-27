import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkill, MARKER_FILE, skillSourceDir, skillStatus, uninstallSkill } from "../../src/app/skill.js";
import { contractJsonSchemas } from "../../src/contracts/schemas.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "miosotis-skill-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("skill package", () => {
  it("has spec-compliant frontmatter", () => {
    const text = readFileSync(join(skillSourceDir(), "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    expect(frontmatter).toMatch(/^name: miosotis$/m);
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(text.split("\n").length).toBeLessThan(500);
  });

  it("ships up-to-date JSON schemas (run `pnpm gen:schemas` if this fails)", () => {
    for (const [file, content] of Object.entries(contractJsonSchemas())) {
      expect(readFileSync(join(skillSourceDir(), "schemas", file), "utf8"), file).toBe(content);
    }
  });

  it("references only files that exist", () => {
    const text = readFileSync(join(skillSourceDir(), "SKILL.md"), "utf8");
    for (const match of text.matchAll(/`(references\/[\w.-]+\.md)`/g)) {
      expect(existsSync(join(skillSourceDir(), match[1] ?? "")), match[1]).toBe(true);
    }
  });
});

describe("skill install", () => {
  it("requires consent, copies an adapted Skill per host, and uninstalls only its own copy", () => {
    const env = { HOME: home };
    expect(() => installSkill({ host: "claude-code", yes: false, env })).toThrow(/--yes/);
    const claude = installSkill({ host: "claude-code", yes: true, env });
    expect(claude).toMatchObject({ mode: "copy", changed: true, target: join(home, ".claude", "skills", "miosotis") });
    expect(lstatSync(claude.target).isSymbolicLink()).toBe(false);
    const claudeSkill = readFileSync(join(claude.target, "SKILL.md"), "utf8");
    expect(claudeSkill).toContain("Host notes (Claude Code)");
    expect(claudeSkill).not.toContain("miosotis:host-notes");
    expect(existsSync(join(claude.target, MARKER_FILE))).toBe(true);
    expect(existsSync(join(claude.target, "references", "contracts.md"))).toBe(true);
    const codex = installSkill({ host: "codex", yes: true, env });
    expect(readFileSync(join(codex.target, "SKILL.md"), "utf8")).toContain("view_image");
    expect(readFileSync(join(codex.target, "agents", "openai.yaml"), "utf8")).toContain("allow_implicit_invocation");
    expect(installSkill({ host: "claude-code", yes: true, env }).changed).toBe(false);
    expect(skillStatus({ env }).hosts.map((h) => h.state)).toEqual(["copied", "copied"]);
    expect(uninstallSkill({ host: "claude-code", env }).changed).toBe(true);
    expect(existsSync(claude.target)).toBe(false);
  });

  it("detects an outdated copy and replaces it only with consent", () => {
    const env = { HOME: home };
    const installed = installSkill({ host: "codex", yes: true, env });
    writeFileSync(join(installed.target, "SKILL.md"), "stale");
    expect(skillStatus({ env }).hosts.find((h) => h.host === "codex")?.state).toBe("outdated");
    expect(() => installSkill({ host: "codex", yes: false, env })).toThrow(/replace the installed/);
    expect(installSkill({ host: "codex", yes: true, env }).changed).toBe(true);
    expect(skillStatus({ env }).hosts.find((h) => h.host === "codex")?.state).toBe("copied");
  });

  it("supports a development symlink and migrates it to a copy", () => {
    const env = { HOME: home };
    const linked = installSkill({ host: "claude-code", yes: true, link: true, env });
    expect(lstatSync(linked.target).isSymbolicLink()).toBe(true);
    expect(skillStatus({ env }).hosts[0]?.state).toBe("linked");
    installSkill({ host: "claude-code", yes: true, env });
    expect(lstatSync(linked.target).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(skillSourceDir(), "SKILL.md"), "utf8")).toContain("miosotis:host-notes");
  });

  it("never replaces an existing non-miosotis entry", () => {
    const env = { HOME: home };
    const target = join(home, ".agents", "skills", "miosotis");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "someone else's skill");
    expect(() => installSkill({ host: "codex", yes: true, env })).toThrow(/not this miosotis Skill/);
    expect(() => uninstallSkill({ host: "codex", env })).toThrow(/untouched/);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("someone else's skill");
    expect(() => installSkill({ host: "vim", yes: true, env })).toThrow(/--host/);
  });
});
