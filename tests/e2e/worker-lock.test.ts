import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const LOCK_MODULE = new URL("../../dist/infra/fs/lock.js", import.meta.url).href;
let root: string;

beforeAll(() => {
  if (!existsSync(new URL(LOCK_MODULE))) {
    throw new Error("dist/ is missing; run `pnpm build` first (pnpm check builds before testing)");
  }
  root = mkdtempSync(join(tmpdir(), "miosotis-e2e-lock-"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** One process that waits for `startAt`, tries the lock, and holds it briefly if it wins. */
function contender(lockPath: string, startAt: number): Promise<string> {
  const script = `
    const { tryLock } = await import(${JSON.stringify(LOCK_MODULE)});
    while (Date.now() < ${startAt}) {}
    const release = tryLock(${JSON.stringify(lockPath)}, new Date());
    process.stdout.write(release === undefined ? "lost" : "won");
    if (release !== undefined) { await new Promise((r) => setTimeout(r, 500)); release(); }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

describe("worker lock (built module)", () => {
  it("lets exactly one of many simultaneous processes take it", async () => {
    for (let round = 0; round < 5; round += 1) {
      const lockPath = join(root, `round-${round}`, "enrich.lock");
      const startAt = Date.now() + 1_500;
      const outcomes = await Promise.all(Array.from({ length: 12 }, () => contender(lockPath, startAt)));
      expect(outcomes.filter((outcome) => outcome === "won")).toHaveLength(1);
    }
  });
});
