import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = new URL("../../dist/index.js", import.meta.url).pathname;
let root: string;
let env: NodeJS.ProcessEnv;

function run(args: string[], input?: string) {
  const result = spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error("dist/index.js is missing; run `pnpm build` first (pnpm check builds before testing)");
  }
  root = mkdtempSync(join(tmpdir(), "miosotis-e2e-"));
  env = { MIOSOTIS_HOME: join(root, "home"), PATH: process.env.PATH ?? "" };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("built CLI (subprocess)", () => {
  it("initializes, saves from stdin JSON, and searches", () => {
    expect(run(["init", "--json"]).code).toBe(0);
    const request = JSON.stringify({ text: '多行\n内容 with `code` and "quotes"', project: "smoke" });
    const saved = run(["save", "--request-file", "-", "--json"], request);
    expect(saved.code).toBe(0);
    const receipt = JSON.parse(saved.stdout);
    expect(saved.stderr).toBe("");
    const found = JSON.parse(run(["search", "内容", "--project", "smoke", "--json"]).stdout);
    expect(found.data.hits[0].source_id).toBe(receipt.data.sources[0].id);
    const got = JSON.parse(run(["source", "get", receipt.data.sources[0].ref, "--json"]).stdout);
    expect(got.data.text).toBe('多行\n内容 with `code` and "quotes"');
  });

  it("reads raw text verbatim from stdin", () => {
    const saved = JSON.parse(run(["save", "--stdin", "--json"], "  keep\n  indentation\n").stdout);
    const got = JSON.parse(run(["source", "get", saved.data.sources[0].ref, "--json"]).stdout);
    expect(got.data.text).toBe("  keep\n  indentation\n");
  });

  it("serializes concurrent writers from parallel processes without losing captures", async () => {
    const saves = Array.from(
      { length: 8 },
      (_, index) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, [BIN, "save", "--json", `parallel note ${index}`], {
            env,
            stdio: "ignore",
          });
          child.on("close", resolve);
        }),
    );
    expect(await Promise.all(saves)).toEqual(Array(8).fill(0));
    const listed = JSON.parse(run(["search", "parallel", "--limit", "50", "--json"]).stdout);
    expect(listed.data.total).toBe(8);
  });

  it("assigns and unassigns existing sources to a project", () => {
    const first = JSON.parse(run(["save", "--json", "剑之道 one"]).stdout).data.sources[0].id;
    const second = JSON.parse(run(["save", "--json", "剑之道 two"]).stdout).data.sources[0].id;
    const assigned = run(["source", "assign", first, second, "--project", "鬼武者剑之道", "--json"]);
    expect(assigned.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(assigned.stdout).data.project.created).toBe(true);
    expect(JSON.parse(run(["source", "list", "--project", "鬼武者剑之道", "--json"]).stdout).data.total).toBe(2);
    expect(JSON.parse(run(["search", "剑之道", "--project", "鬼武者剑之道", "--json"]).stdout).data.total).toBe(2);
    const again = JSON.parse(run(["source", "unassign", second, "--project", "鬼武者剑之道", "--json"]).stdout);
    expect(again.data.results[0].change).toBe("removed");
    const missing = run(["source", "assign", "S-01M3G9NPX0XNVPV0NJTSNDH79K", "--project", "x", "--json"]);
    expect(missing.code).toBe(3);
  });
});
