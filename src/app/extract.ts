import { newId } from "../domain/ids.js";
import { isImage, isPlainText } from "../infra/blobs/mime.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { activeDerived, insertDerivedRecord, supersedeDerived } from "../infra/db/repos/derived.js";
import { insertBlob, insertDerivedChunk, payloadsFor } from "../infra/db/repos/files.js";
import { getSource, setProcessingState } from "../infra/db/repos/sources.js";
import { importText, TEXT_PIPELINE } from "../infra/importers/text.js";
import { chunkText } from "../infra/search/chunker.js";
import { reindex } from "./content.js";
import { type AppContext, isoNow } from "./context.js";

export type ExtractionPlan = "text" | "image" | "later" | "unsupported";

/** Formats whose importers arrive in 0.2.0-alpha.2 stay honestly pending until then. */
const LATER_MIMES = new Set([
  "application/pdf",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function extractionPlan(mime: string): ExtractionPlan {
  if (isPlainText(mime)) {
    return "text";
  }
  if (isImage(mime)) {
    return "image";
  }
  return LATER_MIMES.has(mime) ? "later" : "unsupported";
}

/** Initial processing states for a new file revision (inside the capture transaction). */
export function initialFileStates(
  context: AppContext,
  sourceId: string,
  version: number,
  mime: string,
  at: string,
): Record<string, string> {
  const plan = extractionPlan(mime);
  const extraction = plan === "text" || plan === "later" ? "pending" : "unsupported";
  setProcessingState(context.db, { sourceId, version, stage: "extraction", state: extraction, at });
  const states: Record<string, string> = { extraction };
  if (plan === "image") {
    setProcessingState(context.db, { sourceId, version, stage: "interpretation", state: "pending", at });
    states.interpretation = "pending";
  }
  return states;
}

/**
 * Deterministic extraction for one file revision (phase B, outside the capture transaction). The
 * original bytes stay untouched; extracted text becomes a versioned derivation with its own chunks.
 */
export function runExtraction(context: AppContext, sourceId: string): string {
  const source = getSource(context.db, sourceId);
  if (source === undefined || source.kind !== "file") {
    return "unsupported";
  }
  const version = source.current_version;
  const payload = payloadsFor(context.db, sourceId, version).find((row) => row.role === "original");
  if (payload === undefined || extractionPlan(payload.mime) !== "text") {
    return "unsupported";
  }
  if (activeDerived(context.db, sourceId, version, "extraction") !== undefined) {
    return "complete";
  }
  const imported = importText(context.blobs.read(payload.blob_sha256));
  const at = isoNow(context);
  if (!imported.ok) {
    context.db.transaction(() => {
      setProcessingState(context.db, {
        sourceId,
        version,
        stage: "extraction",
        state: "failed",
        error: imported.reason,
        countAttempt: true,
        at,
      });
    });
    return "failed";
  }
  const stored = context.blobs.putBytes(Buffer.from(imported.text, "utf8"), "extracted.txt");
  context.db.transaction(() => {
    const derivationId = newId("derivation", context.now().getTime());
    insertBlob(context.db, { sha256: stored.sha256, size: stored.size, mime: "text/plain", at });
    insertDerivedRecord(context.db, {
      id: derivationId,
      source_id: sourceId,
      version,
      kind: "extraction",
      input_digest: `sha256:${payload.blob_sha256}`,
      method: "parser",
      model: null,
      schema_version: 1,
      pipeline_version: TEXT_PIPELINE,
      status: "complete",
      content_json: JSON.stringify({ chars: imported.text.length, encoding: "utf-8", bom: imported.bom }),
      superseded_by: null,
      created_at: at,
      purged_at: null,
      content_blob: stored.sha256,
      payload_sha256: payload.blob_sha256,
    });
    supersedeDerived(context.db, sourceId, version, "extraction", derivationId, payload.blob_sha256);
    for (const span of chunkText(imported.text)) {
      insertDerivedChunk(context.db, {
        derivation_id: derivationId,
        ordinal: span.ordinal,
        start_offset: span.start,
        end_offset: span.end,
        locator_json: null,
      });
    }
    setProcessingState(context.db, {
      sourceId,
      version,
      stage: "extraction",
      state: "complete",
      error: null,
      countAttempt: true,
      at,
    });
    reindex(context, sourceId);
    recordAudit(context.db, { at, actor: "system", operation: "source.extract", subjectIds: [sourceId, derivationId] });
  });
  return "complete";
}
