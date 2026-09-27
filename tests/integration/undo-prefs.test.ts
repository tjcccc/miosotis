import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/app/capture.js";
import { changeSourcePolicy } from "../../src/app/governance.js";
import { search } from "../../src/app/search.js";
import { getSourceView } from "../../src/app/sources.js";
import { undoLastCapture } from "../../src/app/undo.js";
import { cli, createTestLibrary, steppingClock, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

afterEach(() => library?.cleanup());

describe("undo", () => {
  beforeEach(() => {
    library = createTestLibrary({ now: steppingClock() });
  });

  it("describes, then trashes, only the latest capture group; restore brings it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "miosotis-undo-"));
    try {
      const keep = capture(library.context, { text: "keep this note" }).sources[0]?.id ?? "";
      writeFileSync(join(dir, "a.md"), "attached words");
      const last = capture(library.context, {
        text: "我一周目通关是什么时候？",
        attachments: [{ path: join(dir, "a.md") }],
      });
      expect(() => undoLastCapture(library.context, { confirm: false })).toThrow(/Re-run with --confirm/);
      expect(getSourceView(library.context, last.sources[0]?.id ?? "").retention).toBe("retained");
      const undone = undoLastCapture(library.context, { confirm: true });
      expect(undone.changed).toBe(true);
      expect(undone.sources.map((source) => source.retention)).toEqual(["trashed", "trashed"]);
      expect(getSourceView(library.context, keep).retention).toBe("retained");
      expect(search(library.context, { query: "attached" }).total).toBe(0);
      expect(undoLastCapture(library.context, { confirm: true }).changed).toBe(false);
      changeSourcePolicy(library.context, last.sources[1]?.id ?? "", "restore");
      expect(search(library.context, { query: "attached" }).total).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports when there is nothing to undo", () => {
    expect(() => undoLastCapture(library.context, { confirm: true })).toThrow(/Nothing to undo/);
  });
});

describe("CLI: question hint, undo, prefs", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miosotis-prefs-"));
    env = { MIOSOTIS_HOME: join(root, "home") };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("warns when a saved text looks like a question, and undo takes it back", async () => {
    expect((await cli(env, "init", "--language", "en", "--json")).code).toBe(0);
    const saved = (await cli(env, "我一周目通关是什么时候？", "--json")).json();
    expect(saved.ok).toBe(true);
    expect(JSON.stringify(saved)).toContain("miosotis undo");
    const needConfirm = await cli(env, "undo", "--json");
    expect(needConfirm.code).toBe(5);
    expect(needConfirm.json().error?.code).toBe("confirmation_required");
    const undone = (await cli(env, "undo", "--confirm", "--json")).json();
    expect(undone.data.changed).toBe(true);
    expect((await cli(env, "plain note", "--json")).stdout).not.toContain("miosotis undo");
  });

  it("stores the preferred language at init and exposes it via prefs", async () => {
    await cli(env, "init", "--language", "zh-CN");
    expect(readFileSync(join(root, "home", "config.toml"), "utf8")).toContain('language = "zh-CN"');
    const prefs = (await cli(env, "prefs", "--json")).json();
    expect(prefs.data).toMatchObject({ language: "zh-CN", language_rule: expect.stringContaining("zh-CN") });
    expect((await cli(env, "init", "--language", "en", "--json")).json().error?.code).toBe("conflict");
    const other = { MIOSOTIS_HOME: join(root, "other") };
    expect((await cli(other, "init", "--language", "not a tag!", "--json")).json().error?.code).toBe("validation");
    const unset = { MIOSOTIS_HOME: join(root, "unset") };
    await cli(unset, "init");
    expect((await cli(unset, "prefs", "--json")).json().data.language).toBeNull();
  });
});
