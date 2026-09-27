import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli } from "../helpers/library.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "miosotis-cli-"));
  env = { MIOSOTIS_HOME: join(root, "home") };
  const init = await cli(env, "init", "--json");
  expect(init.code).toBe(0);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("CLI contract", () => {
  it("prints exactly one JSON envelope on stdout", async () => {
    const run = await cli(env, "save", "--json", "hello", "world");
    expect(run.code).toBe(0);
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    expect(run.json()).toMatchObject({ ok: true, data: { sources: [{ processing: { enrichment: "pending" } }] } });
  });

  it("saves free text through the default shortcut", async () => {
    const run = await cli(env, "今天的计划", "--project", "daily", "--json");
    expect(run.json()).toMatchObject({ ok: true, data: { project: { slug: "daily", created: true } } });
    const list = await cli(env, "source", "list", "--project", "daily", "--json");
    expect(list.json().data.total).toBe(1);
  });

  it("guards against command typos instead of saving them", async () => {
    const run = await cli(env, "serach");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Did you mean `miosotis search`");
    expect((await cli(env, "sav")).code).toBe(2);
    for (const word of ["love", "hello", "note"]) {
      expect((await cli(env, word, "--json")).json().ok).toBe(true);
    }
  });

  it("reads a capture request file", async () => {
    const file = join(root, "capture.json");
    writeFileSync(
      file,
      JSON.stringify({ text: "--looks like a flag", origin: "imported", idempotency_key: "file-key-01" }),
    );
    const first = await cli(env, "save", "--request-file", file, "--json");
    const replay = await cli(env, "save", "--request-file", file, "--json");
    expect(first.json().data.sources[0].origin).toBe("imported");
    expect(replay.json().data.replayed).toBe(true);
  });

  it("returns structured errors with stable exit codes", async () => {
    const missing = await cli(env, "source", "get", "S-01M3G9NPX0XNVPV0NJTSNDH79K", "--json");
    expect(missing.code).toBe(3);
    expect(missing.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
    const conflictingInput = await cli(env, "save", "--json");
    expect(conflictingInput.code).toBe(2);
    const badOption = await cli(env, "search", "--bogus", "--json");
    expect(badOption.code).toBe(2);
    expect(badOption.json()).toMatchObject({ ok: false, error: { code: "usage" } });
  });

  it("explains that high-level intents need an AI host", async () => {
    const run = await cli(env, "review", "this year's notes", "--json");
    expect(run.code).toBe(6);
    expect(run.json()).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
  });

  it("reports an uninitialized library clearly", async () => {
    const other = { MIOSOTIS_HOME: join(root, "empty-home") };
    const run = await cli(other, "search", "x", "--json");
    expect(run.code).toBe(6);
    expect(run.json()).toMatchObject({ ok: false, error: { code: "library_not_initialized" } });
  });

  it("doctor reports a healthy library without content", async () => {
    await cli(env, "save", "secret-ish content");
    const run = await cli(env, "doctor", "--json");
    expect(run.code).toBe(0);
    const report = run.json().data;
    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({ sources: 1, enrichment_pending: 1 });
    expect(run.stdout).not.toContain("secret-ish");
  });
});
