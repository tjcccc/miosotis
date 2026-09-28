import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { MiosotisError } from "../domain/errors.js";
import { isId } from "../domain/ids.js";
import { getArtifact } from "../infra/db/repos/artifacts.js";
import { blobRowExists, pendingErasures } from "../infra/db/repos/purge.js";
import { containedPath } from "../infra/fs/files.js";
import { reindex } from "./content.js";
import type { AppContext } from "./context.js";
import { resumePurge } from "./purge.js";

/** Leftovers younger than this may belong to work still in progress (a capture or backup running now). */
const SETTLE_MS = 60 * 60 * 1000;

export interface RepairPlan {
  pending_erasures: number;
  staging_leftovers: string[];
  orphan_files: number;
  interrupted_backups: string[];
  stale_artifact_folders: string[];
  unindexed_sources: string[];
}

function settled(path: string, now: number): boolean {
  return now - statSync(path).mtimeMs > SETTLE_MS;
}

function planRepair(context: AppContext): RepairPlan {
  const now = context.now().getTime();
  const { library, backupDir } = context.config;
  const staging = existsSync(library.stagingDir)
    ? readdirSync(library.stagingDir).filter((name) => settled(join(library.stagingDir, name), now))
    : [];
  const orphans = context.blobs
    .list()
    .filter((sha) => !blobRowExists(context.db, sha) && now - context.blobs.modifiedAt(sha) > SETTLE_MS);
  const backups =
    backupDir !== undefined && existsSync(backupDir)
      ? readdirSync(backupDir)
          .filter((name) => /^miosotis-backup-.+\.partial$/.test(name) && settled(join(backupDir, name), now))
          .map((name) => join(backupDir, name))
      : [];
  const folders = existsSync(library.artifactsDir)
    ? readdirSync(library.artifactsDir).filter((name) => {
        if (!isId("artifact", name)) {
          return false;
        }
        const artifact = getArtifact(context.db, name);
        return artifact === undefined || artifact.lifecycle === "purged";
      })
    : [];
  const unindexed = context.db
    .all<{ id: string }>(
      "SELECT s.id FROM sources s WHERE s.retention = 'retained' AND NOT EXISTS (SELECT 1 FROM search_fts f WHERE f.source_id = s.id) ORDER BY s.id",
    )
    .map((row) => row.id);
  return {
    pending_erasures: pendingErasures(context.db).length,
    staging_leftovers: staging,
    orphan_files: orphans.length,
    interrupted_backups: backups,
    stale_artifact_folders: folders,
    unindexed_sources: unindexed,
  };
}

function describe(plan: RepairPlan): string[] {
  return [
    ...(plan.pending_erasures > 0
      ? [`Finish an interrupted deletion (${plan.pending_erasures} file(s) to erase).`]
      : []),
    ...(plan.staging_leftovers.length > 0
      ? [`Delete ${plan.staging_leftovers.length} leftover temporary file(s) from interrupted saves or backups.`]
      : []),
    ...(plan.orphan_files > 0
      ? [`Delete ${plan.orphan_files} stored file(s) that nothing references (left by interrupted saves).`]
      : []),
    ...(plan.interrupted_backups.length > 0
      ? [`Delete ${plan.interrupted_backups.length} interrupted (.partial) backup folder(s) in the backup folder.`]
      : []),
    ...(plan.stale_artifact_folders.length > 0
      ? [`Delete ${plan.stale_artifact_folders.length} rendered folder(s) of artifacts that no longer exist.`]
      : []),
    ...(plan.unindexed_sources.length > 0
      ? [`Rebuild the search index for ${plan.unindexed_sources.length} Source(s) missing from it.`]
      : []),
  ];
}

/**
 * Cleans up what interrupted work leaves behind, never anything the library references. Without
 * `confirm` it only lists what it would do. Items younger than an hour are left alone, since they may
 * belong to a save or backup that is still running.
 */
export function repair(context: AppContext, options: { confirm?: boolean } = {}) {
  const plan = planRepair(context);
  const actions = describe(plan);
  if (actions.length === 0) {
    return { changed: false, plan, actions, warnings: [] as string[] };
  }
  if (options.confirm !== true) {
    throw new MiosotisError(
      "confirmation_required",
      ["Repair would:", ...actions.map((line) => `- ${line}`), "To proceed: miosotis repair --confirm"].join("\n"),
      { plan, actions },
    );
  }
  const warnings: string[] = [];
  if (plan.pending_erasures > 0) {
    warnings.push(...resumePurge(context).warnings);
  }
  const { library } = context.config;
  for (const name of plan.staging_leftovers) {
    rmSync(containedPath(library.stagingDir, name), { recursive: true, force: true });
  }
  const now = context.now().getTime();
  for (const sha of context.blobs.list()) {
    context.db.transaction(() => {
      // Re-checked under the write lock: a capture may have referenced these bytes meanwhile.
      if (!blobRowExists(context.db, sha) && now - context.blobs.modifiedAt(sha) > SETTLE_MS) {
        context.blobs.remove(sha);
      }
    });
  }
  for (const path of plan.interrupted_backups) {
    rmSync(path, { recursive: true, force: true });
  }
  for (const name of plan.stale_artifact_folders) {
    rmSync(containedPath(library.artifactsDir, name), { recursive: true, force: true });
  }
  context.db.transaction(() => {
    for (const id of plan.unindexed_sources) {
      reindex(context, id);
    }
  });
  return { changed: true, plan, actions, warnings };
}
