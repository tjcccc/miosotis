import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "./files.js";

export interface LockHolder {
  pid: number;
  started_at: string;
}

/** The live holder of a pid lock file, or undefined when it is free or its process is gone. */
export function lockHolder(path: string): LockHolder | undefined {
  let holder: LockHolder;
  try {
    holder = JSON.parse(readFileSync(path, "utf8")) as LockHolder;
  } catch {
    return undefined;
  }
  return Number.isInteger(holder.pid) && processAlive(holder.pid) ? holder : undefined;
}

/**
 * Takes a pid lock file (exclusive create), clearing a stale one whose process has exited.
 * Returns a release function, or undefined when another live process holds it.
 */
export function tryLock(path: string, now: Date): (() => void) | undefined {
  ensureDir(dirname(path));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, started_at: now.toISOString() } satisfies LockHolder));
      } finally {
        closeSync(fd);
      }
      return () => {
        if (lockHolder(path)?.pid === process.pid) {
          rmSync(path, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || lockHolder(path) !== undefined) {
        return undefined;
      }
      rmSync(path, { force: true });
    }
  }
  return undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
