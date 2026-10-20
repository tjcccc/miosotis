import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeCodex } from "../helpers/fake-codex.js";

const BIN = new URL("../../dist/index.js", import.meta.url).pathname;
let root: string;
let env: NodeJS.ProcessEnv;

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, json: () => JSON.parse(result.stdout) };
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

  it("points to a retry after a run stopped because Codex was unavailable", async () => {
    // The save starts a background worker with the failing Codex; wait for it to stop.
    run(["save", "A thought saved during an outage", "--json"], { FAKE_CODEX_MODE: "fail" });
    let status = run(["enrich", "worker", "status", "--json"]).json().data;
    for (
      let attempt = 0;
      attempt < 100 && (status.running_pid !== null || status.recent.at(-1)?.outcome !== "unavailable");
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = run(["enrich", "worker", "status", "--json"]).json().data;
    }
    expect(status).toMatchObject({ running_pid: null, pending: 1 });
    expect(run(["enrich", "worker", "status"]).stdout).toContain("Run `miosotis enrich run` to retry now.");

    expect(run(["enrich", "run", "--json"]).json().data.results).toEqual([
      expect.objectContaining({ outcome: "enriched" }),
    ]);
    expect(run(["enrich", "worker", "status"]).stdout).not.toContain("retry now");
  });
});
