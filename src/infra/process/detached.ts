import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "../fs/files.js";

/**
 * Starts `node <script> ...args` in the background, detached from the terminal, with its stderr
 * appended to `logFile`. Returns the child's pid; the caller never waits for it.
 */
export function spawnDetachedNode(script: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): number {
  ensureDir(dirname(logFile));
  const fd = openSync(logFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, [script, ...args], {
      detached: true,
      env,
      stdio: ["ignore", "ignore", fd],
    });
    // A failed start is reported by the caller's own checks; it must never crash the caller.
    child.on("error", () => undefined);
    child.unref();
    return child.pid ?? 0;
  } finally {
    closeSync(fd);
  }
}
