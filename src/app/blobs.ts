import { MiosotisError } from "../domain/errors.js";
import { insertBlob } from "../infra/db/repos/files.js";
import type { AppContext } from "./context.js";

/**
 * Records a stored file inside the caller's transaction. Identical bytes may have been erased by a
 * concurrent purge after they were stored; the transaction then fails (retry stores them again)
 * instead of committing a row that points at a missing file.
 */
export function registerBlob(
  context: AppContext,
  blob: { sha256: string; size: number; mime: string },
  at: string,
): void {
  if (!context.blobs.has(blob.sha256)) {
    throw new MiosotisError("busy", "A stored file was erased by a concurrent purge; retry");
  }
  insertBlob(context.db, { ...blob, at });
}
