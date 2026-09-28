import {
  EXTRACTION_SCHEMA_VERSION,
  ExtractionRequest,
  type ExtractionRequestInput,
  HOST_EXTRACTION_PIPELINE,
} from "../contracts/extraction.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { assertId, formatSourceRef, newId } from "../domain/ids.js";
import { isImage } from "../infra/blobs/mime.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { nextChangeSeq } from "../infra/db/repos/counters.js";
import { activeDerived, insertDerivedRecord, supersedeDerived } from "../infra/db/repos/derived.js";
import { derivedChunks, insertDerivedChunk, payloadsFor } from "../infra/db/repos/files.js";
import { getSource, setProcessingState } from "../infra/db/repos/sources.js";
import { digestOf } from "../infra/digest.js";
import type { TextLocator } from "../infra/importers/registry.js";
import { findImporter } from "../infra/importers/registry.js";
import { chunkText } from "../infra/search/chunker.js";
import { registerBlob } from "./blobs.js";
import { reindex } from "./content.js";
import { type AppContext, isoNow } from "./context.js";
import { requireSource } from "./sources.js";

/**
 * `builtin`: a bundled importer extracts it right after capture. `image`: kept as-is and interpreted by
 * a vision-capable host. `host`: waits for the AI host to extract it with its own tools (`extract apply`).
 */
export type ExtractionPlan = "builtin" | "image" | "host";

export function extractionPlan(mime: string): ExtractionPlan {
  if (findImporter(mime) !== undefined) {
    return "builtin";
  }
  return isImage(mime) ? "image" : "host";
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
  const extraction = plan === "image" ? "unsupported" : "pending";
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
  const importer = payload === undefined ? undefined : findImporter(payload.mime);
  if (payload === undefined || importer === undefined) {
    return "pending";
  }
  if (activeDerived(context.db, sourceId, version, "extraction") !== undefined) {
    return "complete";
  }
  const imported = importer.extract(context.blobs.read(payload.blob_sha256));
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
    registerBlob(context, { ...stored, mime: "text/plain" }, at);
    insertDerivedRecord(context.db, {
      id: derivationId,
      source_id: sourceId,
      version,
      kind: "extraction",
      input_digest: `sha256:${payload.blob_sha256}`,
      method: "parser",
      model: null,
      schema_version: 1,
      pipeline_version: importer.pipeline,
      status: "complete",
      content_json: JSON.stringify({ importer: importer.id, chars: imported.text.length, ...imported.details }),
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

export interface HostExtractionReceipt {
  derivation_id: string;
  ref: string;
  replayed: boolean;
  state: "complete" | "partial";
  chars: number;
  chunks: number;
  tables: { name: string; columns: number; rows: number }[];
  replaced: string | null;
}

/**
 * Stores text the AI host extracted from a file with its own tools (PDF, spreadsheet, HTML, …). It is
 * bound to the exact file hash, labeled host-extracted with the tool used, and never alters the file.
 * Resubmitting identical content returns the existing extraction; different content supersedes it.
 */
export function applyHostExtraction(context: AppContext, input: ExtractionRequestInput): HostExtractionReceipt {
  const request = parseContract(ExtractionRequest, input, "extraction request");
  const sourceId = assertId("source", request.source_ref.id);
  const requestDigest = digestOf({
    text: request.text,
    segments: request.segments,
    method: request.method,
    coverage: request.coverage,
    tables: request.tables,
  });
  return context.db.transaction(() => {
    const source = requireSource(context, sourceId);
    if (source.kind !== "file") {
      throw new MiosotisError("validation", `${sourceId} is a ${source.kind} Source; only files take extracted text`);
    }
    if (request.source_ref.version !== source.current_version) {
      throw new MiosotisError("stale_version", `${sourceId} is at v${source.current_version}`, {
        current_version: source.current_version,
      });
    }
    const version = source.current_version;
    const payload = payloadsFor(context.db, sourceId, version).find(
      (row) => row.blob_sha256 === request.source_ref.payload_sha256,
    );
    if (payload === undefined) {
      throw new MiosotisError(
        "validation",
        "payload_sha256 does not belong to this revision; read it from `source get`",
      );
    }
    if (isImage(payload.mime)) {
      throw new MiosotisError("validation", "Images take `interpretations` via `enrich apply`, not extracted text");
    }
    const previous = activeDerived(context.db, sourceId, version, "extraction");
    if (
      previous?.content_json != null &&
      (JSON.parse(previous.content_json) as { request_digest?: string }).request_digest === requestDigest
    ) {
      return {
        derivation_id: previous.id,
        ref: formatSourceRef(sourceId, version),
        replayed: true,
        state: previous.status,
        chars: request.text.length,
        chunks: derivedChunks(context.db, previous.id).length,
        tables: [],
        replaced: null,
      };
    }
    const at = isoNow(context);
    const stored = context.blobs.putBytes(Buffer.from(request.text, "utf8"), "extracted.txt");
    registerBlob(context, { ...stored, mime: "text/plain" }, at);
    const tables = request.tables.map((table) => ({
      ...table,
      first_row: table.first_row ?? table.header_row + 1,
    }));
    let tablesBlob: string | null = null;
    if (tables.length > 0) {
      const tableBytes = context.blobs.putBytes(Buffer.from(JSON.stringify({ tables }), "utf8"), "tables.json");
      registerBlob(context, { ...tableBytes, mime: "application/json" }, at);
      tablesBlob = tableBytes.sha256;
    }
    const derivationId = newId("derivation", context.now().getTime());
    const status = request.coverage.complete ? "complete" : "partial";
    insertDerivedRecord(context.db, {
      id: derivationId,
      source_id: sourceId,
      version,
      kind: "extraction",
      input_digest: `sha256:${payload.blob_sha256}`,
      method: "host_agent",
      model: null,
      schema_version: EXTRACTION_SCHEMA_VERSION,
      pipeline_version: HOST_EXTRACTION_PIPELINE,
      status,
      content_json: JSON.stringify({
        host_extracted: true,
        tool: request.method.tool,
        tool_version: request.method.version ?? null,
        note: request.method.note ?? null,
        coverage: request.coverage,
        warnings: request.warnings,
        chars: request.text.length,
        request_digest: requestDigest,
        tables_blob: tablesBlob,
        tables: tables.map((table) => ({
          name: table.name,
          locator: table.locator ?? null,
          columns: table.columns,
          rows: table.rows.length,
          header_row: table.header_row,
          first_row: table.first_row,
          notes: table.notes ?? null,
        })),
      }),
      superseded_by: null,
      created_at: at,
      purged_at: null,
      content_blob: stored.sha256,
      payload_sha256: payload.blob_sha256,
    });
    supersedeDerived(context.db, sourceId, version, "extraction", derivationId, payload.blob_sha256);
    const spans = locatedChunks(request.text, request.segments);
    spans.forEach((span, ordinal) => {
      insertDerivedChunk(context.db, {
        derivation_id: derivationId,
        ordinal,
        start_offset: span.start,
        end_offset: span.end,
        locator_json: span.locator === null ? null : JSON.stringify(span.locator),
      });
    });
    setProcessingState(context.db, {
      sourceId,
      version,
      stage: "extraction",
      state: status,
      error: null,
      countAttempt: true,
      at,
    });
    reindex(context, sourceId);
    context.db.run("UPDATE sources SET changed_seq = ?, updated_at = ? WHERE id = ?", [
      nextChangeSeq(context.db),
      at,
      sourceId,
    ]);
    recordAudit(context.db, {
      at,
      actor: "agent",
      operation: "source.extract",
      subjectIds: [sourceId, derivationId],
      detail: { tool: request.method.tool },
    });
    return {
      derivation_id: derivationId,
      ref: formatSourceRef(sourceId, version),
      replayed: false,
      state: status,
      chars: request.text.length,
      chunks: spans.length,
      tables: tables.map((table) => ({ name: table.name, columns: table.columns.length, rows: table.rows.length })),
      replaced: previous?.id ?? null,
    };
  });
}

/** Chunks that never cross a located segment (page, sheet), each carrying its segment's locator. */
function locatedChunks(text: string, segments: { start: number; end: number; locator: TextLocator }[]) {
  if (segments.length === 0) {
    return chunkText(text).map((span) => ({ start: span.start, end: span.end, locator: null as TextLocator | null }));
  }
  return segments.flatMap((segment) =>
    chunkText(text.slice(segment.start, segment.end)).map((span) => ({
      start: segment.start + span.start,
      end: segment.start + span.end,
      locator: segment.locator as TextLocator | null,
    })),
  );
}

/** Files still waiting for extraction by the host (oldest first). */
export function pendingExtraction(context: AppContext, options: { limit?: number } = {}) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new MiosotisError("validation", "limit must be an integer between 1 and 200");
  }
  const where = `ps.stage = 'extraction' AND ps.state IN ('pending', 'failed')`;
  const rows = context.db.all<{
    id: string;
    current_version: number;
    created_at: string;
    state: string;
    filename: string | null;
    mime: string;
    blob_sha256: string;
  }>(
    `SELECT s.id, s.current_version, s.created_at, ps.state, p.filename, p.mime, p.blob_sha256
     FROM visible_sources s
     JOIN processing_states ps ON ps.source_id = s.id AND ps.version = s.current_version
     JOIN version_payloads p ON p.source_id = s.id AND p.version = s.current_version AND p.ordinal = 0
     WHERE ${where}
     ORDER BY s.created_at ASC, s.id ASC LIMIT ?`,
    [limit],
  );
  const total =
    context.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM visible_sources s JOIN processing_states ps ON ps.source_id = s.id AND ps.version = s.current_version WHERE ${where}`,
    )?.n ?? 0;
  return {
    total,
    files: rows.map((row) => ({
      ref: formatSourceRef(row.id, row.current_version),
      filename: row.filename,
      mime: row.mime,
      payload_sha256: row.blob_sha256,
      path: context.blobs.path(row.blob_sha256),
      state: row.state,
      created_at: row.created_at,
    })),
  };
}
