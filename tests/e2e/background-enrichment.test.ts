import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeCodex } from "../helpers/fake-codex.js";

const BIN = new URL("../../dist/index.js", import.meta.url).pathname;
let root: string;
let env: NodeJS.ProcessEnv;

function run(args: string[]) {
  const result = spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
  return { code: result.status, json: () => JSON.parse(result.stdout) };
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error("dist/index.js is missing; run `pnpm build` first (pnpm check builds before testing)");
  }
  root = mkdtempSync(join(tmpdir(), "miosotis-e2e-worker-"));
  installFakeCodex(join(root, "bin"));
  env = { MIOSOTIS_HOME: join(root, "home"), PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("background enrichment (built CLI)", () => {
  it("returns from a save at once and enriches the note in the background", async () => {
    expect(run(["init", "--json"]).code).toBe(0);
    expect(run(["enrich", "worker", "enable", "--provider", "codex", "--yes", "--json"]).code).toBe(0);
    const saved = run(["save", "A thought to enrich later", "--json"]).json();
    expect(saved.data.background_enrichment).toMatchObject({
      provider: "Codex",
      state: expect.stringMatching(/started|running/),
    });
    let total = 1;
    for (let attempt = 0; attempt < 100 && total > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      total = run(["enrich", "pending", "--json"]).json().data.total;
    }
    expect(total).toBe(0);
    const status = run(["enrich", "worker", "status", "--json"]).json().data;
    expect(status).toMatchObject({ enabled: true, signed_in: true, pending: 0 });
    expect(status.recent.at(-1)).toMatchObject({ outcome: "enriched" });
  });
});
