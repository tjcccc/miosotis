import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkill, skillSourceDir, skillStatus, uninstallSkill } from "../../src/app/skill.js";
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
  it("requires consent, links idempotently, and uninstalls only its own link", () => {
    const env = { HOME: home };
    expect(() => installSkill({ host: "claude-code", yes: false, env })).toThrow(/--yes/);
    const installed = installSkill({ host: "claude-code", yes: true, env });
    expect(installed.target).toBe(join(home, ".claude", "skills", "miosotis"));
    expect(lstatSync(installed.target).isSymbolicLink()).toBe(true);
    expect(installSkill({ host: "claude-code", yes: true, env }).changed).toBe(false);
    expect(skillStatus({ env }).hosts.find((h) => h.host === "claude-code")?.state).toBe("installed");
    expect(uninstallSkill({ host: "claude-code", env }).changed).toBe(true);
    expect(existsSync(installed.target)).toBe(false);
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
