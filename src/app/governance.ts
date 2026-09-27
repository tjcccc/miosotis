import { CorrectionRequest, type CorrectionRequestInput } from "../contracts/artifact.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { formatSourceRef, newId, parseSourceRef } from "../domain/ids.js";
import type { Actor } from "../domain/source.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { nextChangeSeq } from "../infra/db/repos/counters.js";
import { findOperation, insertOperation } from "../infra/db/repos/operations.js";
import { insertChunks, insertSourceVersion, setProcessingState } from "../infra/db/repos/sources.js";
import { digestOf, textDigest } from "../infra/digest.js";
import { chunkText } from "../infra/search/chunker.js";
import { reindexSource, removeFromIndex } from "../infra/search/indexer.js";
import { type AppContext, isoNow } from "./context.js";
import { enrichmentSearchText } from "./enrich.js";
import { dependentArtifacts, requireSource, requireVersion } from "./sources.js";

export interface CorrectionReceipt {
  source_id: string;
  ref: string;
  previous_version: number;
  version: number;
  replayed: boolean;
  processing: { enrichment: "pending" };
  dependent_artifacts: ReturnType<typeof dependentArtifacts>;
  note: string;
}

/**
 * A correction appends revision N+1; older revisions and the artifacts pinned to them stay intact.
 * A stale `expectedVersion` is a conflict, never a silent overwrite.
 */
export function correctSource(
  context: AppContext,
  reference: string,
  expectedVersion: number,
  input: CorrectionRequestInput,
  actor: Actor = "user",
): CorrectionReceipt {
  const request = parseContract(CorrectionRequest, input, "correction request");
  const { id } = parseSourceRef(reference);
  const requestDigest = digestOf({ source: id, expected: expectedVersion, text: request.text, reason: request.reason });
  return context.db.transaction(() => {
    if (request.idempotency_key !== undefined) {
      const previous = findOperation(context.db, "correct", request.idempotency_key);
      if (previous !== undefined) {
        if (previous.request_digest !== requestDigest) {
          throw new MiosotisError("conflict", "Idempotency key was already used with a different correction");
        }
        return { ...(JSON.parse(previous.receipt_json) as CorrectionReceipt), replayed: true };
      }
    }
    const source = requireSource(context, id);
    if (source.retention === "purged") {
      throw new MiosotisError("validation", `${id} was purged`);
    }
    if (source.current_version !== expectedVersion) {
      throw new MiosotisError(
        "conflict",
        `${id} is at v${source.current_version}, not the expected v${expectedVersion}; re-read it before correcting`,
        { current_version: source.current_version, expected_version: expectedVersion },
      );
    }
    const current = requireVersion(context, id, source.current_version);
    if (current.content_text === request.text) {
      throw new MiosotisError("validation", "The corrected text is identical to the current revision");
    }
    const at = isoNow(context);
    const version = source.current_version + 1;
    const chunks = chunkText(request.text);
    insertSourceVersion(context.db, {
      source_id: id,
      version,
      parent_version: source.current_version,
      reason: "correction",
      actor,
      content_text: request.text,
      content_digest: textDigest(request.text),
      char_length: request.text.length,
      provenance_json: current.provenance_json,
      received_at: at,
      client_captured_at: null,
      timezone: current.timezone,
      purged_at: null,
    });
    insertChunks(context.db, id, version, chunks);
    context.db.run("UPDATE sources SET current_version = ?, changed_seq = ?, updated_at = ? WHERE id = ?", [
      version,
      nextChangeSeq(context.db),
      at,
      id,
    ]);
    setProcessingState(context.db, { sourceId: id, version, stage: "enrichment", state: "pending", at });
    if (source.retention === "retained") {
      reindexSource(context.db, { sourceId: id, version, text: request.text, chunks, enrichmentText: null });
    }
    const receipt: CorrectionReceipt = {
      source_id: id,
      ref: formatSourceRef(id, version),
      previous_version: source.current_version,
      version,
      replayed: false,
      processing: { enrichment: "pending" },
      dependent_artifacts: dependentArtifacts(context, id),
      note: "Existing artifacts keep the revision they used and now show a correction notice. Regenerate explicitly if needed.",
    };
    insertOperation(context.db, {
      id: newId("operation", context.now().getTime()),
      kind: "correct",
      idempotency_key: request.idempotency_key ?? null,
      request_digest: requestDigest,
      receipt_json: JSON.stringify(receipt),
      created_at: at,
    });
    recordAudit(context.db, {
      at,
      actor,
      operation: "source.correct",
      subjectIds: [id],
      detail: { from: source.current_version, to: version, reason: request.reason ?? null },
    });
    return receipt;
  });
}

type PolicyAction = "ignore" | "include" | "trash" | "restore";

/**
 * Retrieval inclusion and retention are separate policies. None of them rewrites content; artifacts
 * that used the source keep their pinned evidence and show a notice.
 */
export function changeSourcePolicy(
  context: AppContext,
  reference: string,
  action: PolicyAction,
  options: { reason?: string | undefined; confirm?: boolean | undefined; actor?: Actor } = {},
) {
  const { id } = parseSourceRef(reference);
  const actor = options.actor ?? "user";
  if (action === "trash" && options.confirm !== true) {
    const dependents = dependentArtifacts(context, id);
    throw new MiosotisError(
      "confirmation_required",
      `Trashing ${id} needs --confirm. It will leave default retrieval; ${dependents.length} artifact(s) that cite it stay unchanged but will show a notice.`,
      { source_id: id, dependent_artifacts: dependents },
    );
  }
  if (action === "ignore" && (options.reason === undefined || options.reason.trim().length === 0)) {
    throw new MiosotisError("usage", "Ignoring a source needs a --reason");
  }
  return context.db.transaction(() => {
    const source = requireSource(context, id);
    if (source.retention === "purged") {
      throw new MiosotisError("validation", `${id} was purged`);
    }
    const at = isoNow(context);
    let changed = false;
    let reintroduced = false;
    if (action === "ignore" && source.inclusion !== "ignored") {
      context.db.run("UPDATE sources SET inclusion = 'ignored', inclusion_reason = ?, updated_at = ? WHERE id = ?", [
        options.reason?.trim() ?? null,
        at,
        id,
      ]);
      changed = true;
    } else if (action === "include" && source.inclusion !== "included") {
      context.db.run(
        "UPDATE sources SET inclusion = 'included', inclusion_reason = NULL, updated_at = ? WHERE id = ?",
        [at, id],
      );
      changed = true;
      reintroduced = source.retention === "retained";
    } else if (action === "trash" && source.retention !== "trashed") {
      context.db.run("UPDATE sources SET retention = 'trashed', updated_at = ? WHERE id = ?", [at, id]);
      removeFromIndex(context.db, id);
      changed = true;
    } else if (action === "restore" && source.retention === "trashed") {
      context.db.run("UPDATE sources SET retention = 'retained', updated_at = ? WHERE id = ?", [at, id]);
      const version = requireVersion(context, id, source.current_version);
      const chunks = context.db
        .all<{ ordinal: number; start_offset: number; end_offset: number }>(
          "SELECT ordinal, start_offset, end_offset FROM chunks WHERE source_id = ? AND version = ? ORDER BY ordinal",
          [id, source.current_version],
        )
        .map((row) => ({ ordinal: row.ordinal, start: row.start_offset, end: row.end_offset }));
      const enrichment = context.db.get<{ content_json: string | null }>(
        "SELECT content_json FROM derived_records WHERE source_id = ? AND version = ? AND kind = 'enrichment' AND superseded_by IS NULL",
        [id, source.current_version],
      );
      reindexSource(context.db, {
        sourceId: id,
        version: source.current_version,
        text: version.content_text ?? "",
        chunks,
        enrichmentText: enrichment?.content_json ? enrichmentSearchText(JSON.parse(enrichment.content_json)) : null,
      });
      changed = true;
      reintroduced = source.inclusion === "included";
    }
    if (reintroduced) {
      context.db.run("UPDATE sources SET changed_seq = ? WHERE id = ?", [nextChangeSeq(context.db), id]);
    }
    if (changed) {
      recordAudit(context.db, {
        at,
        actor,
        operation: `source.${action}`,
        subjectIds: [id],
        ...(options.reason === undefined ? {} : { detail: { reason: options.reason } }),
      });
    }
    const updated = requireSource(context, id);
    return {
      source_id: id,
      action,
      changed,
      retention: updated.retention,
      inclusion: updated.inclusion,
      inclusion_reason: updated.inclusion_reason,
      dependent_artifacts: dependentArtifacts(context, id),
    };
  });
}
