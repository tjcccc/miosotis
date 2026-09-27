import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { MiosotisError } from "../../domain/errors.js";

/** Resolves `candidate` under `root`, rejecting anything that escapes it. */
export function containedPath(root: string, ...segments: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || resolve(base, rel) !== target) {
    throw new MiosotisError("validation", "Path escapes the managed library", { segments });
  }
  return target;
}

export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
}

/** Write-to-temp, fsync, then rename, so readers never observe a half-written file. */
export function writeFileAtomic(path: string, content: string | Uint8Array, mode = 0o600): void {
  ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { mode });
  const fd = openSync(temp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
