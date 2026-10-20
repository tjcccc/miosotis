import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * Takes a pid lock file, clearing a stale one whose process has exited. Returns a release function,
 * or undefined when another live process holds it.
 *
 * The holder is written to a private file first and then hard-linked into place, so the lock never
 * exists without its holder: a contender can never mistake a half-written lock for a stale one.
 */
export function tryLock(path: string, now: Date): (() => void) | undefined {
  ensureDir(dirname(path));
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, JSON.stringify({ pid: process.pid, started_at: now.toISOString() } satisfies LockHolder), {
    mode: 0o600,
  });
  try {
    return linkLock(draft, path);
  } finally {
    rmSync(draft, { force: true });
  }
}

function linkLock(draft: string, path: string): (() => void) | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      linkSync(draft, path);
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
