import { basename } from "node:path";
import { CaptureRequest, type CaptureRequestInput } from "../contracts/capture.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { formatSourceRef, newId } from "../domain/ids.js";
import type { Actor, SourceOrigin } from "../domain/source.js";
import type { StoredBlob } from "../infra/blobs/store.js";
import { assertTimezone } from "../infra/config/config.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { nextChangeSeq } from "../infra/db/repos/counters.js";
import { insertBlob, insertLink, insertPayload } from "../infra/db/repos/files.js";
import { findOperation, insertOperation } from "../infra/db/repos/operations.js";
import { assignProject } from "../infra/db/repos/projects.js";
import { insertChunks, insertSource, insertSourceVersion, setProcessingState } from "../infra/db/repos/sources.js";
import { digestOf, textDigest } from "../infra/digest.js";
import { chunkText } from "../infra/search/chunker.js";
import { reindex } from "./content.js";
import { type AppContext, isoNow } from "./context.js";
import { extractionPlan, initialFileStates, runExtraction } from "./extract.js";
import { ensureProject } from "./projects.js";

export interface CapturedSource {
  id: string;
  version: number;
  ref: string;
  kind: "text" | "file";
  /** `comment` when text was saved together with files. */
  role: "text" | "comment" | "file";
  origin: string;
  char_length: number;
  received_at: string;
  filename?: string;
  mime?: string;
  size?: number;
  sha256?: string;
  processing: Record<string, string>;
}

export interface CaptureReceipt {
  operation_id: string;
  replayed: boolean;
  sources: CapturedSource[];
  project: { id: string; slug: string; name: string; created: boolean } | null;
}

interface StagedFile {
  filename: string;
  origin: SourceOrigin;
  blob: StoredBlob;
  provenance: unknown;
}

/** Filenames are display metadata only: base name, no control characters, bounded length. */
export function safeFilename(raw: string): string {
  const cleaned = basename(raw.replaceAll("\\", "/"))
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, 255);
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

/**
 * Phase A durable capture (brief §9.1). Attached files are hashed and stored first (outside the
 * transaction); then one short transaction records the capture group: the verbatim text (the comment,
 * when files are attached), one file Source per attachment, `references` links, project membership,
 * and processing states. The receipt is returned only after COMMIT. Text files are extracted right
 * after (phase B); failures there never undo the capture.
 */
export function capture(context: AppContext, input: CaptureRequestInput, actor: Actor = "user"): CaptureReceipt {
  const request = parseContract(CaptureRequest, input, "capture request");
  const timezone = request.timezone ?? context.config.timezone;
  assertTimezone(timezone);
  const text = request.text !== undefined && request.text.length > 0 ? request.text : undefined;
  const staged: StagedFile[] = request.attachments.map((attachment) => {
    const filename = safeFilename(attachment.filename ?? attachment.path);
    return {
      filename,
      origin: attachment.origin,
      blob: context.blobs.putFile(attachment.path, filename),
      provenance: attachment.provenance,
    };
  });
  const requestDigest = digestOf({
    text,
    origin: request.origin,
    project: request.project,
    provenance: request.provenance,
    client_captured_at: request.client_captured_at,
    timezone,
    attachments: staged.map((file) => ({
      sha256: file.blob.sha256,
      filename: file.filename,
      origin: file.origin,
      provenance: file.provenance,
    })),
  });
  const receipt = context.db.transaction((): CaptureReceipt => {
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
    const sources: CapturedSource[] = [];
    insertOperation(context.db, {
      id: operationId,
      kind: "capture",
      idempotency_key: request.idempotency_key ?? null,
      request_digest: requestDigest,
      receipt_json: "{}",
      created_at: at,
    });
    const register = (sourceId: string, kind: "text" | "file", origin: SourceOrigin) => {
      const seq = nextChangeSeq(context.db);
      insertSource(context.db, {
        id: sourceId,
        kind,
        origin,
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
    };
    let commentId: string | undefined;
    if (text !== undefined) {
      commentId = newId("source", nowMs);
      register(commentId, "text", request.origin);
      insertSourceVersion(context.db, {
        source_id: commentId,
        version: 1,
        parent_version: null,
        reason: "capture",
        actor,
        content_text: text,
        content_digest: textDigest(text),
        char_length: text.length,
        provenance_json: request.provenance === undefined ? null : JSON.stringify(request.provenance),
        received_at: at,
        client_captured_at: request.client_captured_at ?? null,
        timezone,
        purged_at: null,
      });
      insertChunks(context.db, commentId, 1, chunkText(text));
      setProcessingState(context.db, { sourceId: commentId, version: 1, stage: "enrichment", state: "pending", at });
      sources.push({
        id: commentId,
        version: 1,
        ref: formatSourceRef(commentId, 1),
        kind: "text",
        role: staged.length > 0 ? "comment" : "text",
        origin: request.origin,
        char_length: text.length,
        received_at: at,
        processing: { enrichment: "pending" },
      });
    }
    for (const file of staged) {
      const fileId = newId("source", nowMs);
      register(fileId, "file", file.origin);
      insertBlob(context.db, { sha256: file.blob.sha256, size: file.blob.size, mime: file.blob.mime, at });
      insertSourceVersion(context.db, {
        source_id: fileId,
        version: 1,
        parent_version: null,
        reason: "capture",
        actor,
        content_text: "",
        content_digest: `sha256:${file.blob.sha256}`,
        char_length: 0,
        provenance_json: file.provenance === undefined ? null : JSON.stringify(file.provenance),
        received_at: at,
        client_captured_at: request.client_captured_at ?? null,
        timezone,
        purged_at: null,
      });
      insertPayload(context.db, {
        source_id: fileId,
        version: 1,
        ordinal: 0,
        blob_sha256: file.blob.sha256,
        role: "original",
        filename: file.filename,
        mime: file.blob.mime,
      });
      setProcessingState(context.db, { sourceId: fileId, version: 1, stage: "enrichment", state: "pending", at });
      const states = initialFileStates(context, fileId, 1, file.blob.mime, at);
      if (commentId !== undefined) {
        insertLink(context.db, { from: commentId, to: fileId, kind: "references", origin: actor, at });
      }
      sources.push({
        id: fileId,
        version: 1,
        ref: formatSourceRef(fileId, 1),
        kind: "file",
        role: "file",
        origin: file.origin,
        char_length: 0,
        received_at: at,
        filename: file.filename,
        mime: file.blob.mime,
        size: file.blob.size,
        sha256: file.blob.sha256,
        processing: { enrichment: "pending", ...states },
      });
    }
    for (const source of sources) {
      if (project !== null) {
        assignProject(context.db, {
          sourceId: source.id,
          projectId: project.project.id,
          assignment: "explicit",
          actor,
          derivationId: null,
          at,
        });
      }
      reindex(context, source.id);
    }
    const result: CaptureReceipt = {
      operation_id: operationId,
      replayed: false,
      sources,
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
    context.db.run("UPDATE operations SET receipt_json = ? WHERE id = ?", [JSON.stringify(result), operationId]);
    recordAudit(context.db, {
      at,
      actor,
      operation: "source.capture",
      subjectIds: [...sources.map((s) => s.id), operationId],
    });
    return result;
  });
  if (receipt.replayed) {
    return receipt;
  }
  return {
    ...receipt,
    sources: receipt.sources.map((source) =>
      source.kind === "file" && source.mime !== undefined && extractionPlan(source.mime) === "builtin"
        ? { ...source, processing: { ...source.processing, extraction: extractAfterCommit(context, source.id) } }
        : source,
    ),
  };
}

/**
 * Phase B must never make a committed capture look failed (brief §2.3): any extraction error is
 * recorded as a retryable `failed` state and the receipt is still returned.
 */
function extractAfterCommit(context: AppContext, sourceId: string): string {
  try {
    return runExtraction(context, sourceId);
  } catch (error) {
    try {
      context.db.transaction(() => {
        setProcessingState(context.db, {
          sourceId,
          version: 1,
          stage: "extraction",
          state: "failed",
          error: `extraction error: ${(error as Error).message}`.slice(0, 500),
          countAttempt: true,
          at: isoNow(context),
        });
      });
    } catch {
      // The source is committed either way; `doctor`/`enrich pending` still surface it.
    }
    return "failed";
  }
}
