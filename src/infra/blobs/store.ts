import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MiosotisError } from "../../domain/errors.js";
import { containedPath, ensureDir } from "../fs/files.js";
import { sniffMime } from "./mime.js";

export const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CHUNK = 1024 * 1024;

export interface StoredBlob {
  sha256: string;
  size: number;
  mime: string;
  /** False when identical bytes were already stored (deduplicated). */
  created: boolean;
}

export function blobPath(blobsRoot: string, sha256: string): string {
  if (!HASH_PATTERN.test(sha256)) {
    throw new MiosotisError("validation", `Not a blob hash: ${sha256}`);
  }
  return containedPath(blobsRoot, "sha256", sha256.slice(0, 2), sha256);
}

/**
 * Content-addressed storage. Bytes are streamed into staging while hashing, fsynced, then renamed into
 * place, so a blob path only ever exposes complete content. Callers insert database rows referencing a
 * blob only after this returns, so committed rows never point at missing files (a failed transaction
 * can leave an orphan blob, which `doctor` reports).
 */
export class BlobStore {
  readonly root: string;
  private readonly staging: string;

  constructor(blobsRoot: string, stagingDir: string) {
    this.root = blobsRoot;
    this.staging = stagingDir;
  }

  path(sha256: string): string {
    return blobPath(this.root, sha256);
  }

  has(sha256: string): boolean {
    return existsSync(this.path(sha256));
  }

  read(sha256: string): Buffer {
    return readFileSync(this.path(sha256));
  }

  putBytes(bytes: Uint8Array, filename?: string): StoredBlob {
    if (bytes.byteLength > MAX_BLOB_BYTES) {
      throw new MiosotisError("validation", `File is larger than ${MAX_BLOB_BYTES} bytes`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mime = sniffMime(bytes.subarray(0, 64), filename);
    if (this.has(sha256)) {
      return { sha256, size: bytes.byteLength, mime, created: false };
    }
    const temp = this.stagingFile();
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return this.finalize(temp, sha256, bytes.byteLength, mime);
  }

  /** Copies a local file into the store (hashing while copying). */
  putFile(sourcePath: string, filename?: string): StoredBlob {
    let input: number;
    try {
      input = openSync(sourcePath, "r");
    } catch (error) {
      throw new MiosotisError("not_found", `Cannot read ${sourcePath}: ${(error as Error).message}`);
    }
    const temp = this.stagingFile();
    let output: number | undefined;
    try {
      const stat = fstatSync(input);
      if (!stat.isFile()) {
        throw new MiosotisError("validation", `${sourcePath} is not a regular file`);
      }
      if (stat.size > MAX_BLOB_BYTES) {
        throw new MiosotisError("validation", `${sourcePath} is larger than ${MAX_BLOB_BYTES} bytes`);
      }
      output = openSync(temp, "wx", 0o600);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(CHUNK);
      let head: Buffer | undefined;
      let size = 0;
      for (;;) {
        const read = readSync(input, buffer, 0, CHUNK, null);
        if (read === 0) {
          break;
        }
        size += read;
        if (size > MAX_BLOB_BYTES) {
          throw new MiosotisError("validation", `${sourcePath} grew beyond ${MAX_BLOB_BYTES} bytes while reading`);
        }
        const slice = buffer.subarray(0, read);
        head ??= Buffer.from(slice.subarray(0, 64));
        hash.update(slice);
        writeSync(output, slice);
      }
      fsyncSync(output);
      closeSync(output);
      output = undefined;
      const sha256 = hash.digest("hex");
      const mime = sniffMime(head ?? new Uint8Array(), filename);
      if (this.has(sha256)) {
        rmSync(temp, { force: true });
        return { sha256, size, mime, created: false };
      }
      return this.finalize(temp, sha256, size, mime);
    } catch (error) {
      if (output !== undefined) {
        closeSync(output);
      }
      rmSync(temp, { force: true });
      throw error;
    } finally {
      closeSync(input);
    }
  }

  /** Recomputes a stored blob's hash. */
  verify(sha256: string): boolean {
    return this.has(sha256) && createHash("sha256").update(this.read(sha256)).digest("hex") === sha256;
  }

  size(sha256: string): number {
    return statSync(this.path(sha256)).size;
  }

  /** Hashes of every stored file on disk (listed or not). */
  list(): string[] {
    const root = join(this.root, "sha256");
    if (!existsSync(root)) {
      return [];
    }
    return readdirSync(root).flatMap((prefix) => {
      const directory = join(root, prefix);
      return statSync(directory).isDirectory() ? readdirSync(directory).filter((name) => HASH_PATTERN.test(name)) : [];
    });
  }

  modifiedAt(sha256: string): number {
    return statSync(this.path(sha256)).mtimeMs;
  }

  /** Deletes a stored file (purge only; callers first make sure nothing references it). */
  remove(sha256: string): void {
    rmSync(this.path(sha256), { force: true });
  }

  private stagingFile(): string {
    ensureDir(this.staging);
    return join(this.staging, `blob-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  private finalize(temp: string, sha256: string, size: number, mime: string): StoredBlob {
    const target = this.path(sha256);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(temp, target);
    return { sha256, size, mime, created: true };
  }
}
