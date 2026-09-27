import { CaptureRequest, type CaptureRequestInput } from "../contracts/capture.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { formatSourceRef, newId } from "../domain/ids.js";
import type { Actor } from "../domain/source.js";
import { assertTimezone } from "../infra/config/config.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { nextChangeSeq } from "../infra/db/repos/counters.js";
import { findOperation, insertOperation } from "../infra/db/repos/operations.js";
import { assignProject } from "../infra/db/repos/projects.js";
import { insertChunks, insertSource, insertSourceVersion, setProcessingState } from "../infra/db/repos/sources.js";
import { digestOf, textDigest } from "../infra/digest.js";
import { chunkText } from "../infra/search/chunker.js";
import { reindexSource } from "../infra/search/indexer.js";
import { type AppContext, isoNow } from "./context.js";
import { ensureProject } from "./projects.js";

export interface CaptureReceipt {
  operation_id: string;
  replayed: boolean;
  sources: {
    id: string;
    version: number;
    ref: string;
    kind: "text";
    origin: string;
    char_length: number;
    received_at: string;
    processing: { enrichment: "pending" };
  }[];
  project: { id: string; slug: string; name: string; created: boolean } | null;
}

/**
 * Phase A durable capture (brief §9.1): validate, then persist the verbatim text, its chunks and
 * search rows, project association, and a pending enrichment state in one short transaction.
 * The receipt is returned only after COMMIT. Enrichment happens later and can fail independently.
 */
export function capture(context: AppContext, input: CaptureRequestInput, actor: Actor = "user"): CaptureReceipt {
  const request = parseContract(CaptureRequest, input, "capture request");
  const timezone = request.timezone ?? context.config.timezone;
  assertTimezone(timezone);
  const requestDigest = digestOf({
    text: request.text,
    origin: request.origin,
    project: request.project,
    provenance: request.provenance,
    client_captured_at: request.client_captured_at,
    timezone,
  });
  return context.db.transaction(() => {
    if (request.idempotency_key !== undefined) {
      const previous = findOperation(context.db, "capture", request.idempotency_key);
      if (previous !== undefined) {
        if (previous.request_digest !== requestDigest) {
          throw new MiosotisError("conflict", "Idempotency key was already used with different content", {
            idempotency_key: request.idempotency_key,
            operation_id: previous.id,
          });
        }
        return { ...(JSON.parse(previous.receipt_json) as CaptureReceipt), replayed: true };
      }
    }
    const at = isoNow(context);
    const nowMs = context.now().getTime();
    const project = request.project === undefined ? null : ensureProject(context, request.project);
    const operationId = newId("operation", nowMs);
    const sourceId = newId("source", nowMs);
    const seq = nextChangeSeq(context.db);
    const chunks = chunkText(request.text);
    const receipt: CaptureReceipt = {
      operation_id: operationId,
      replayed: false,
      sources: [
        {
          id: sourceId,
          version: 1,
          ref: formatSourceRef(sourceId, 1),
          kind: "text",
          origin: request.origin,
          char_length: request.text.length,
          received_at: at,
          processing: { enrichment: "pending" },
        },
      ],
      project:
        project === null
          ? null
          : {
              id: project.project.id,
              slug: project.project.slug,
              name: project.project.name,
              created: project.created,
            },
    };
    insertOperation(context.db, {
      id: operationId,
      kind: "capture",
      idempotency_key: request.idempotency_key ?? null,
      request_digest: requestDigest,
      receipt_json: JSON.stringify(receipt),
      created_at: at,
    });
    insertSource(context.db, {
      id: sourceId,
      kind: "text",
      origin: request.origin,
      capture_op_id: operationId,
      current_version: 1,
      retention: "retained",
      inclusion: "included",
      inclusion_reason: null,
      created_seq: seq,
      changed_seq: seq,
      created_at: at,
      updated_at: at,
    });
    insertSourceVersion(context.db, {
      source_id: sourceId,
      version: 1,
      parent_version: null,
      reason: "capture",
      actor,
      content_text: request.text,
      content_digest: textDigest(request.text),
      char_length: request.text.length,
      provenance_json: request.provenance === undefined ? null : JSON.stringify(request.provenance),
      received_at: at,
      client_captured_at: request.client_captured_at ?? null,
      timezone,
      purged_at: null,
    });
    insertChunks(context.db, sourceId, 1, chunks);
    setProcessingState(context.db, { sourceId, version: 1, stage: "enrichment", state: "pending", at });
    if (project !== null) {
      assignProject(context.db, {
        sourceId,
        projectId: project.project.id,
        assignment: "explicit",
        actor,
        derivationId: null,
        at,
      });
    }
    reindexSource(context.db, { sourceId, version: 1, text: request.text, chunks, enrichmentText: null });
    recordAudit(context.db, { at, actor, operation: "source.capture", subjectIds: [sourceId, operationId] });
    return receipt;
  });
}
