import { rmSync } from "node:fs";
import { MiosotisError } from "../domain/errors.js";
import { assertId, isId } from "../domain/ids.js";
import { getArtifact } from "../infra/db/repos/artifacts.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { nextChangeSeq } from "../infra/db/repos/counters.js";
import {
  addPendingErasure,
  artifactsCiting,
  artifactsUsingRun,
  blobReferences,
  blobRowExists,
  blobSizes,
  clearEvidenceRun,
  datasetsUsingSources,
  deleteBlobRow,
  deleteDataset,
  isPendingErasure,
  linkedSources,
  operationsAbout,
  optimizeSearchIndex,
  pendingErasures,
  purgeArtifactRows,
  purgeSourceRows,
  removePendingErasure,
  runCleared,
  runsPinning,
  scrubAuditDetails,
  scrubOperation,
} from "../infra/db/repos/purge.js";
import { currentEnrichments, getSource } from "../infra/db/repos/sources.js";
import { digestOf } from "../infra/digest.js";
import { containedPath } from "../infra/fs/files.js";
import { type AppContext, isoNow } from "./context.js";
import { titleOf } from "./sources.js";

export interface PlannedSource {
  id: string;
  kind: string;
  origin: string;
  retention: string;
  versions: number;
  created_at: string;
  /** Shown so the user can recognize what is about to go; never kept after the purge. */
  title: string | null;
  filenames: string[];
}

export interface PlannedArtifact {
  id: string;
  title: string | null;
  lifecycle: string;
  reason: "requested" | "cites_source" | "cites_dataset";
  action: "delete" | "keep" | "undecided";
}

export interface PurgePlan {
  plan_id: string;
  sources: PlannedSource[];
  artifacts: PlannedArtifact[];
  datasets: string[];
  linked_sources_not_included: { id: string; relation: "comment" | "attached_file"; retention: string }[];
  files: { erase: number; bytes: number; kept_shared: number };
  evidence_runs_cleared: number;
  needs_artifact_choice: boolean;
  effects: string[];
}

interface Plan {
  view: PurgePlan;
  sourceIds: string[];
  artifactIds: string[];
  datasetIds: string[];
  runIds: string[];
  blobs: string[];
  /** Rendered folders that may hold copies of purged text: purged artifacts and kept dependents. */
  folders: string[];
}

/**
 * The permanent-deletion plan for items already in the trash. Artifacts outside the selection that cite
 * the Sources are never deleted here: the user trashes them too, or keeps them (`keepCiting`).
 */
function planFor(context: AppContext, ids: string[], keepCiting: boolean): Plan {
  const { db } = context;
  if (ids.length === 0) {
    throw new MiosotisError("usage", "Name the trashed Sources (S-…) and/or artifacts (A-…) to delete");
  }
  const sourceIds = new Set<string>();
  const requested = new Set<string>();
  for (const raw of ids) {
    if (isId("source", raw)) {
      sourceIds.add(assertId("source", raw));
    } else if (isId("artifact", raw)) {
      requested.add(assertId("artifact", raw));
    } else {
      throw new MiosotisError(
        "validation",
        `Deletion takes whole Sources (S-…) and artifacts (A-…), not ${JSON.stringify(raw)}`,
      );
    }
  }
  const sources = [...sourceIds].sort().map((id) => {
    const source = getSource(db, id);
    if (source === undefined) {
      throw new MiosotisError("not_found", `No source ${id}`);
    }
    if (source.retention === "purged") {
      throw new MiosotisError("validation", `${id} was already deleted permanently`);
    }
    if (source.retention !== "trashed") {
      throw new MiosotisError("validation", `${id} is not in the trash; \`miosotis remove ${id}\` first`);
    }
    return source;
  });
  for (const id of requested) {
    const artifact = getArtifact(db, id);
    if (artifact === undefined) {
      throw new MiosotisError("not_found", `No artifact ${id}`);
    }
    if (artifact.lifecycle === "purged") {
      throw new MiosotisError("validation", `${id} was already deleted permanently`);
    }
    if (artifact.lifecycle !== "trashed") {
      throw new MiosotisError("validation", `${id} is not in the trash; \`miosotis remove ${id}\` first`);
    }
  }
  const sourceList = sources.map((source) => source.id);
  const datasetIds = datasetsUsingSources(db, sourceList);
  const dependents = artifactsCiting(db, sourceList, datasetIds).filter(
    (row) => !requested.has(row.id) && getArtifact(db, row.id)?.lifecycle !== "purged",
  );
  const purgedArtifacts = requested;

  const artifacts: PlannedArtifact[] = [
    ...[...requested].map((id) => ({ id, reason: "requested" as const, action: "delete" as const })),
    ...dependents.map((row) => ({
      id: row.id,
      reason: row.via === "dataset" ? ("cites_dataset" as const) : ("cites_source" as const),
      action: keepCiting ? ("keep" as const) : ("undecided" as const),
    })),
  ]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => {
      const artifact = getArtifact(db, entry.id);
      return { ...entry, title: artifact?.title ?? null, lifecycle: artifact?.lifecycle ?? "unknown" };
    });

  const linked = linkedSources(db, sourceList).flatMap((link) => {
    const other = sourceIds.has(link.from_source) ? link.to_source : link.from_source;
    if (sourceIds.has(other)) {
      return [];
    }
    const retention = getSource(db, other)?.retention ?? "unknown";
    if (retention === "purged") {
      return [];
    }
    return [
      {
        id: other,
        relation: sourceIds.has(link.from_source) ? ("attached_file" as const) : ("comment" as const),
        retention,
      },
    ];
  });

  const owners = { source: sourceIds, dataset: new Set(datasetIds), artifact: purgedArtifacts };
  const references = blobReferences(db);
  const candidates = new Set(
    references.filter((ref) => owners[ref.owner_kind].has(ref.owner_id)).map((ref) => ref.sha256),
  );
  const survivors = new Set(
    references.filter((ref) => !owners[ref.owner_kind].has(ref.owner_id)).map((ref) => ref.sha256),
  );
  const blobs = [...candidates].filter((sha) => !survivors.has(sha)).sort();

  // Runs that pinned the content (or belong to purged artifacts) are cleared unless a kept artifact uses them.
  const candidateRuns = new Set([
    ...runsPinning(db, sourceList, datasetIds),
    ...[...purgedArtifacts].flatMap((id) => getArtifact(db, id)?.evidence_run_id ?? []),
  ]);
  const runIds = [...candidateRuns]
    .filter(
      (runId) =>
        !runCleared(db, runId) &&
        artifactsUsingRun(db, runId).every((user) => user.lifecycle === "purged" || purgedArtifacts.has(user.id)),
    )
    .sort();

  const enrichments = currentEnrichments(db, sourceList);
  const plannedSources: PlannedSource[] = sources.map((source) => ({
    id: source.id,
    kind: source.kind,
    origin: source.origin,
    retention: source.retention,
    versions: source.current_version,
    created_at: source.created_at,
    title: titleOf(enrichments.get(source.id)?.content_json ?? null),
    filenames: db
      .all<{ filename: string | null }>(
        "SELECT DISTINCT filename FROM version_payloads WHERE source_id = ? AND filename IS NOT NULL",
        [source.id],
      )
      .map((row) => row.filename ?? ""),
  }));
  const kept = artifacts.filter((entry) => entry.action === "keep");
  const undecided = artifacts.filter((entry) => entry.action === "undecided");
  const toPurge = artifacts.filter((entry) => entry.action === "delete");
  const files = { erase: blobs.length, bytes: blobSizes(db, blobs), kept_shared: candidates.size - blobs.length };
  const effects = [
    ...(sources.length > 0
      ? [
          `Permanently delete ${sources.length} Source(s) with every revision, annotation, search entry, and stored file.`,
        ]
      : []),
    ...(datasetIds.length > 0 ? [`Delete ${datasetIds.length} dataset(s) calculated from them.`] : []),
    ...(toPurge.length > 0 ? [`Permanently delete ${toPurge.length} artifact(s) and their files.`] : []),
    ...(kept.length > 0
      ? [
          `Keep ${kept.length} artifact(s) that cite them. Their text and attached files may still contain the deleted content; they will show that a source was deleted.`,
        ]
      : []),
    ...(undecided.length > 0
      ? [
          `${undecided.length} artifact(s) cite them and may quote them: ${undecided.map((entry) => entry.id).join(", ")}. Remove them to the trash and include them, or keep them with --keep-artifacts.`,
        ]
      : []),
    ...(linked.length > 0
      ? [`Not included: ${linked.map((entry) => entry.id).join(", ")} (saved together with them).`]
      : []),
    ...(files.kept_shared > 0
      ? [`${files.kept_shared} stored file(s) are also used by items that stay, so they are kept.`]
      : []),
    "Minimal tombstones (IDs, dates, sizes) remain so references can say what happened.",
    "Backups, exports, and AI host transcripts made earlier still hold copies; this cannot reach them.",
  ];
  const folders = [...new Set([...purgedArtifacts, ...dependents.map((row) => row.id)])].sort();
  const plan_id = digestOf({
    sources: plannedSources.map((source) => [source.id, source.versions]),
    artifacts: artifacts.map((entry) => [entry.id, entry.action]),
    datasets: datasetIds,
    runs: runIds,
    blobs,
    folders,
  })
    .replace(/^sha256:/, "")
    .slice(0, 12);
  return {
    view: {
      plan_id,
      sources: plannedSources,
      artifacts,
      datasets: datasetIds,
      linked_sources_not_included: linked,
      files,
      evidence_runs_cleared: runIds.length,
      needs_artifact_choice: undecided.length > 0,
      effects,
    },
    sourceIds: sourceList,
    artifactIds: [...purgedArtifacts].sort(),
    datasetIds,
    runIds,
    blobs,
    folders,
  };
}

/** The reviewable plan, without changing anything. */
export function reviewPurge(context: AppContext, ids: string[], keepCiting = false): PurgePlan {
  return planFor(context, ids, keepCiting).view;
}

export interface PurgeReceipt {
  plan_id: string;
  purged: { sources: string[]; artifacts: string[]; datasets: string[] };
  kept_artifacts: string[];
  files_erased: number;
  bytes_erased: number;
  compacted: boolean;
  warnings: string[];
  note: string;
}

/**
 * Permanent deletion of trashed items. Without `confirm` it only returns the plan (as
 * `confirmation_required`); with `confirm` it needs the reviewed plan's ID and refuses if the library
 * changed since. Database content is removed in one transaction; files are erased after commit from a
 * durable pending list; then the database is vacuumed and its write-ahead log truncated so deleted
 * pages don't linger.
 */
export function purge(
  context: AppContext,
  ids: string[],
  options: { keepCiting?: boolean; confirm?: boolean; plan?: string | undefined; proceed: string },
): PurgeReceipt {
  const keepCiting = options.keepCiting === true;
  const reviewed = planFor(context, ids, keepCiting);
  if (options.confirm !== true) {
    throw new MiosotisError(
      "confirmation_required",
      [
        `Permanent deletion plan ${reviewed.view.plan_id} (nothing has changed yet):`,
        ...reviewed.view.effects.map((line) => `- ${line}`),
        reviewed.view.needs_artifact_choice
          ? "Decide about the citing artifacts, review again, then confirm."
          : `To proceed: ${options.proceed}${keepCiting ? " --keep-artifacts" : ""} --confirm --plan ${reviewed.view.plan_id}`,
      ].join("\n"),
      { plan: reviewed.view },
    );
  }
  if (reviewed.view.needs_artifact_choice) {
    throw new MiosotisError(
      "usage",
      "Artifacts cite these Sources: remove them to the trash and include them, or pass --keep-artifacts",
      { plan: reviewed.view },
    );
  }
  if (options.plan === undefined) {
    throw new MiosotisError("usage", `--confirm needs --plan ${reviewed.view.plan_id} from the reviewed plan`, {
      plan: reviewed.view,
    });
  }
  if (options.plan !== reviewed.view.plan_id) {
    throw new MiosotisError("conflict", "The library changed since this plan was reviewed; review the new plan", {
      plan: reviewed.view,
    });
  }
  const warnings: string[] = [];
  finishErasures(context);
  // Rendered folders are a cache; clear them first so no copy survives a crash before the commit.
  for (const folder of reviewed.folders) {
    removeArtifactFolder(context, folder);
  }
  context.db.exec("PRAGMA secure_delete = ON");
  const at = isoNow(context);
  const plan = context.db.transaction(() => {
    const current = planFor(context, ids, keepCiting);
    if (current.view.plan_id !== options.plan) {
      throw new MiosotisError("conflict", "The library changed since this plan was reviewed; review the new plan", {
        plan: current.view,
      });
    }
    const { db } = context;
    for (const datasetId of current.datasetIds) {
      deleteDataset(db, datasetId);
    }
    for (const sourceId of current.sourceIds) {
      const operations = operationsAbout(db, { sourceId });
      purgeSourceRows(db, sourceId, at, nextChangeSeq(db));
      for (const operation of operations) {
        scrubOperation(db, operation.id, scrubbedReceipt(operation, current.sourceIds));
      }
      scrubAuditDetails(db, sourceId);
    }
    for (const artifactId of current.artifactIds) {
      for (const operation of operationsAbout(db, { artifactId })) {
        scrubOperation(db, operation.id, JSON.stringify({ id: artifactId, purged: true }));
      }
      purgeArtifactRows(db, artifactId, at);
      scrubAuditDetails(db, artifactId);
    }
    for (const runId of current.runIds) {
      clearEvidenceRun(db, runId, at);
    }
    for (const sha of current.blobs) {
      deleteBlobRow(db, sha);
      addPendingErasure(db, "blob", sha, at);
    }
    for (const folder of current.folders) {
      addPendingErasure(db, "artifact_folder", folder, at);
    }
    optimizeSearchIndex(db);
    recordAudit(db, {
      at,
      actor: "user",
      operation: "trash.empty",
      subjectIds: [...current.sourceIds, ...current.artifactIds, ...current.datasetIds],
      detail: {
        plan_id: current.view.plan_id,
        sources: current.sourceIds.length,
        artifacts: current.artifactIds.length,
        datasets: current.datasetIds.length,
        files: current.blobs.length,
      },
    });
    return current;
  });
  finishErasures(context);
  const compacted = compactDatabase(context);
  if (!compacted) {
    warnings.push(
      "The database could not be compacted right now (another process is using it); run `miosotis trash empty --resume` later.",
    );
  }
  return {
    plan_id: plan.view.plan_id,
    purged: { sources: plan.sourceIds, artifacts: plan.artifactIds, datasets: plan.datasetIds },
    kept_artifacts: plan.view.artifacts.filter((entry) => entry.action === "keep").map((entry) => entry.id),
    files_erased: plan.blobs.length,
    bytes_erased: plan.view.files.bytes,
    compacted,
    warnings,
    note: "Deleted content is gone from this library and cannot be restored. Backups, exports, and AI host transcripts made earlier still hold copies.",
  };
}

/** Receipts are kept as tombstones: IDs and roles only, with the purged items marked. */
function scrubbedReceipt(operation: { kind: string; receipt_json: string }, purgedSources: string[]): string {
  const receipt = JSON.parse(operation.receipt_json) as Record<string, unknown>;
  if (operation.kind === "capture" && Array.isArray(receipt.sources)) {
    const sources = (receipt.sources as Record<string, unknown>[]).map((entry) =>
      purgedSources.includes(String(entry.id))
        ? { id: entry.id, version: entry.version, ref: entry.ref, kind: entry.kind, role: entry.role, purged: true }
        : entry,
    );
    return JSON.stringify({ ...receipt, sources });
  }
  return JSON.stringify({
    ...(receipt.source_id === undefined ? {} : { source_id: receipt.source_id }),
    ...(receipt.ref === undefined ? {} : { ref: receipt.ref }),
    purged: true,
  });
}

function removeArtifactFolder(context: AppContext, artifactId: string): void {
  rmSync(containedPath(context.config.library.artifactsDir, assertId("artifact", artifactId)), {
    recursive: true,
    force: true,
  });
}

/**
 * Erases files a purge committed to removing. Each blob is re-checked under the write lock: bytes that
 * something stored again since (a new capture of the same file) are kept.
 */
export function finishErasures(context: AppContext): { files: number; folders: number } {
  let files = 0;
  let folders = 0;
  for (const entry of pendingErasures(context.db)) {
    context.db.transaction(() => {
      if (!isPendingErasure(context.db, entry.kind, entry.target)) {
        return;
      }
      if (entry.kind === "blob") {
        if (!blobRowExists(context.db, entry.target)) {
          context.blobs.remove(entry.target);
          files += 1;
        }
      } else {
        removeArtifactFolder(context, entry.target);
        folders += 1;
      }
      removePendingErasure(context.db, entry.kind, entry.target);
    });
  }
  return { files, folders };
}

/** Rebuilds the database file without free pages and truncates the write-ahead log. */
function compactDatabase(context: AppContext): boolean {
  try {
    context.db.exec("VACUUM");
    const checkpoint = context.db.get<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)");
    return checkpoint?.busy === 0;
  } catch (error) {
    if (error instanceof Error && /locked|busy/i.test(error.message)) {
      return false;
    }
    throw error;
  }
}

/** Finishes an interrupted purge: erases pending files and compacts the database. */
export function resumePurge(context: AppContext) {
  const erased = finishErasures(context);
  const compacted = compactDatabase(context);
  return {
    files_erased: erased.files,
    folders_removed: erased.folders,
    compacted,
    warnings: compacted ? [] : ["The database is in use; run `miosotis trash empty --resume` again later."],
  };
}
