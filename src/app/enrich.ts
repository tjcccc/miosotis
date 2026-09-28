import {
  ENRICHMENT_PIPELINE_VERSION,
  ENRICHMENT_SCHEMA_VERSION,
  type EnrichmentRequest,
  type EnrichmentRequestInput,
  EnrichmentRequest as EnrichmentSchema,
} from "../contracts/enrichment.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { assertId, formatSourceRef, isId, newId, parseSourceRef } from "../domain/ids.js";
import { safeSlice } from "../domain/text.js";
import { isImage } from "../infra/blobs/mime.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { nextChangeSeq } from "../infra/db/repos/counters.js";
import { activeDerived, activeDerivedList, insertDerivedRecord, supersedeDerived } from "../infra/db/repos/derived.js";
import { payloadsFor } from "../infra/db/repos/files.js";
import { findOperation, insertOperation } from "../infra/db/repos/operations.js";
import { assignMembership, findProjectById, listProjects, projectsForSources } from "../infra/db/repos/projects.js";
import { setProcessingState } from "../infra/db/repos/sources.js";
import { digestOf } from "../infra/digest.js";
import { readableText, reindex } from "./content.js";
import { type AppContext, isoNow } from "./context.js";
import { storeEvents } from "./events.js";
import { requireSource, requireVersion } from "./sources.js";

/** Maximum text handed to the host for lightweight enrichment. Longer sources get partial coverage. */
export const ENRICH_MAX_CHARS = 12_000;

/** Sources whose current revision still needs enrichment (pending or failed), oldest first. */
export function pendingEnrichment(context: AppContext, options: { limit?: number } = {}) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new MiosotisError("validation", "limit must be an integer between 1 and 200");
  }
  const where = `ps.stage = 'enrichment' AND ps.state IN ('pending', 'failed')`;
  const rows = context.db.all<{
    id: string;
    current_version: number;
    created_at: string;
    char_length: number;
    state: string;
    attempts: number;
    last_error: string | null;
    filename: string | null;
  }>(
    `SELECT s.id, s.current_version, s.created_at, v.char_length, ps.state, ps.attempts, ps.last_error,
       (SELECT p.filename FROM version_payloads p WHERE p.source_id = s.id AND p.version = s.current_version AND p.ordinal = 0) AS filename
     FROM visible_sources s
     JOIN source_versions v ON v.source_id = s.id AND v.version = s.current_version
     JOIN processing_states ps ON ps.source_id = s.id AND ps.version = s.current_version
     WHERE ${where}
     ORDER BY s.created_at ASC, s.id ASC
     LIMIT ?`,
    [limit],
  );
  const total =
    context.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM visible_sources s JOIN processing_states ps ON ps.source_id = s.id AND ps.version = s.current_version WHERE ${where}`,
    )?.n ?? 0;
  return {
    total,
    sources: rows.map((row) => ({
      ref: formatSourceRef(row.id, row.current_version),
      created_at: row.created_at,
      char_length: row.char_length,
      filename: row.filename,
      state: row.state,
      attempts: row.attempts,
      last_error: row.last_error,
    })),
  };
}

/** Bounded input for the host model plus the contract it must return. No model is called here. */
export function prepareEnrichment(context: AppContext, reference: string) {
  const ref = parseSourceRef(reference);
  const source = requireSource(context, ref.id);
  const versionNumber = ref.version ?? source.current_version;
  if (versionNumber !== source.current_version) {
    throw new MiosotisError(
      "stale_version",
      `${formatSourceRef(source.id, versionNumber)} is not the current revision`,
      {
        current_version: source.current_version,
      },
    );
  }
  const version = requireVersion(context, source.id, versionNumber);
  if (version.content_text === null || version.content_digest === null) {
    throw new MiosotisError("validation", "This revision's content was purged");
  }
  const readable = readableText(context, source.id, versionNumber);
  const text = safeSlice(readable.text, 0, ENRICH_MAX_CHARS);
  const payloads = payloadsFor(context.db, source.id, versionNumber);
  return {
    source_ref: { id: source.id, version: versionNumber, input_digest: version.content_digest },
    ref: formatSourceRef(source.id, versionNumber),
    origin: source.origin,
    provenance: version.provenance_json === null ? null : (JSON.parse(version.provenance_json) as unknown),
    received_at: version.received_at,
    timezone: version.timezone,
    kind: source.kind,
    text_origin: readable.origin,
    /** True when a non-image file has no extracted text yet: extract it first (`miosotis extract apply`). */
    extraction_needed:
      source.kind === "file" && readable.origin === "none" && payloads.some((payload) => !isImage(payload.mime)),
    total_chars: readable.text.length,
    provided_chars: text.length,
    complete: text.length === readable.text.length,
    chunk_count: readable.segments.length,
    files: payloads.map((payload) => ({
      sha256: payload.blob_sha256,
      filename: payload.filename,
      mime: payload.mime,
      /** Read-only; look at images here and submit `interpretations`. */
      path: context.blobs.path(payload.blob_sha256),
      needs_interpretation: isImage(payload.mime),
    })),
    current_projects: projectsForSources(context.db, [source.id]).map((row) => ({
      id: row.project_id,
      slug: row.slug,
    })),
    known_projects: listProjects(context.db).map((row) => ({ id: row.id, slug: row.slug, name: row.name })),
    text,
    contract: "miosotis.enrichment.v1 (see skill/miosotis/schemas/enrichment.schema.json)",
    guidance: [
      "Summarize what the text says; do not judge whether it is true.",
      "Attribute claims: quoted or imported material is not the user's belief.",
      "Add retrieval terms in the languages the user is likely to search in, including translations.",
      "Suggest only existing project IDs; leave suggestions empty when unsure.",
      "Report coverage honestly when you read only part of the text.",
      "For images: look at the file and add `interpretations` bound to its sha256; transcribe only what is legible and mark uncertain readings.",
      "If extraction_needed is true: read the file with your own tools, submit its text with `miosotis extract apply`, then prepare again.",
      "If the source states a dated arrangement (meeting, appointment, trip), add `events`: resolve relative dates ('next Monday') from received_at in timezone, keep the stated precision (a date, a part of day, or a clock time), and never invent a time.",
    ],
  };
}

export interface EnrichmentReceipt {
  derivation_id: string;
  ref: string;
  replayed: boolean;
  state: "complete" | "partial";
  inferred_projects: string[];
  /** Schedule entries stored from this enrichment (`miosotis schedule` lists them). */
  events: { id: string; title: string; start_date: string; precision: string; repeats: boolean }[];
  cancelled_events: { event: string; kind: "all" | "date" | "from"; date: string | null }[];
  warnings: string[];
}

/**
 * Stores host-generated enrichment as a derived record bound to an exact revision. Agent JSON is
 * untrusted: it is validated, bounded, and can never modify the original text or explicit membership.
 */
export function applyEnrichment(context: AppContext, input: EnrichmentRequestInput): EnrichmentReceipt {
  let request: EnrichmentRequest;
  try {
    request = parseContract(EnrichmentSchema, input, "enrichment request");
  } catch (error) {
    recordFailure(context, input, error);
    throw error;
  }
  const sourceId = assertId("source", request.source_ref.id);
  const requestDigest = digestOf({ ...request, idempotency_key: undefined });
  return context.db.transaction(() => {
    if (request.idempotency_key !== undefined) {
      const previous = findOperation(context.db, "enrich", request.idempotency_key);
      if (previous !== undefined) {
        if (previous.request_digest !== requestDigest) {
          throw new MiosotisError("conflict", "Idempotency key was already used with a different enrichment");
        }
        return { ...(JSON.parse(previous.receipt_json) as EnrichmentReceipt), replayed: true };
      }
    }
    const source = requireSource(context, sourceId);
    const version = requireVersion(context, sourceId, request.source_ref.version);
    if (request.source_ref.version !== source.current_version) {
      throw new MiosotisError(
        "stale_version",
        `Enrichment targets ${formatSourceRef(sourceId, request.source_ref.version)} but the current revision is v${source.current_version}`,
        { current_version: source.current_version },
      );
    }
    if (version.content_text === null || version.content_digest !== request.source_ref.input_digest) {
      throw new MiosotisError("validation", "input_digest does not match this revision; run `enrich prepare` again");
    }
    const warnings: string[] = [];
    const projectIds: string[] = [];
    for (const candidate of request.project_suggestions) {
      const id = candidate.trim().toUpperCase();
      if (isId("project", id) && findProjectById(context.db, id) !== undefined) {
        projectIds.push(id);
      } else {
        warnings.push(`ignored unknown project suggestion ${JSON.stringify(candidate)}`);
      }
    }
    // Without a reported coverage, assume the host read only what `prepare` provided.
    const readableLength = readableText(context, sourceId, version.version).text.length;
    // Without a reported coverage, assume the host read only what `prepare` provided.
    const coverage = request.coverage ?? {
      read_chars: Math.min(readableLength, ENRICH_MAX_CHARS),
      total_chars: readableLength,
    };
    const status = coverage.read_chars < readableLength ? "partial" : "complete";
    const imagePayloads = payloadsFor(context.db, sourceId, version.version).filter((payload) => isImage(payload.mime));
    for (const interpretation of request.interpretations) {
      if (!imagePayloads.some((payload) => payload.blob_sha256 === interpretation.payload_sha256)) {
        throw new MiosotisError(
          "validation",
          `interpretation names ${interpretation.payload_sha256}, which is not an image of this revision`,
        );
      }
    }
    const at = isoNow(context);
    const derivationId = newId("derivation", context.now().getTime());
    const content = {
      title: request.title ?? null,
      abstract: request.abstract ?? null,
      language: request.language ?? null,
      terms: request.terms,
      entities: request.entities,
      project_suggestions: projectIds,
      assertions: request.assertions,
      coverage,
      warnings: request.warnings,
    };
    insertDerivedRecord(context.db, {
      id: derivationId,
      source_id: sourceId,
      version: version.version,
      kind: "enrichment",
      input_digest: request.source_ref.input_digest,
      method: "host_agent",
      model: request.model ?? null,
      schema_version: ENRICHMENT_SCHEMA_VERSION,
      pipeline_version: ENRICHMENT_PIPELINE_VERSION,
      status,
      content_json: JSON.stringify(content),
      superseded_by: null,
      created_at: at,
      purged_at: null,
      content_blob: null,
      payload_sha256: null,
    });
    supersedeDerived(context.db, sourceId, version.version, "enrichment", derivationId);
    const schedule = storeEvents(
      context,
      { events: request.events, cancels: request.cancels },
      {
        sourceId,
        version: version.version,
        derivationId,
        timezone: version.timezone,
        text: [
          readableText(context, sourceId, version.version).text,
          ...request.interpretations.map((entry) => entry.transcription ?? ""),
        ].join("\n"),
        at,
      },
    );
    warnings.push(...schedule.warnings);
    setProcessingState(context.db, {
      sourceId,
      version: version.version,
      stage: "enrichment",
      state: status,
      error: null,
      countAttempt: true,
      at,
    });
    for (const interpretation of request.interpretations) {
      const interpretationId = newId("derivation", context.now().getTime());
      insertDerivedRecord(context.db, {
        id: interpretationId,
        source_id: sourceId,
        version: version.version,
        kind: "interpretation",
        input_digest: `sha256:${interpretation.payload_sha256}`,
        method: "host_agent",
        model: request.model ?? null,
        schema_version: ENRICHMENT_SCHEMA_VERSION,
        pipeline_version: ENRICHMENT_PIPELINE_VERSION,
        status: "complete",
        content_json: JSON.stringify({
          description: interpretation.description,
          transcription: interpretation.transcription ?? null,
          observations: interpretation.observations,
        }),
        superseded_by: null,
        created_at: at,
        purged_at: null,
        content_blob: null,
        payload_sha256: interpretation.payload_sha256,
      });
      supersedeDerived(
        context.db,
        sourceId,
        version.version,
        "interpretation",
        interpretationId,
        interpretation.payload_sha256,
      );
    }
    if (imagePayloads.length > 0) {
      const interpreted = new Set(
        activeDerivedList(context.db, sourceId, version.version, "interpretation").map((row) => row.payload_sha256),
      );
      const done = imagePayloads.every((payload) => interpreted.has(payload.blob_sha256));
      setProcessingState(context.db, {
        sourceId,
        version: version.version,
        stage: "interpretation",
        state: done ? "complete" : "pending",
        error: null,
        countAttempt: request.interpretations.length > 0,
        at,
      });
    }
    const inferred: string[] = [];
    for (const projectId of projectIds) {
      const change = assignMembership(context.db, {
        sourceId,
        projectId,
        assignment: "inferred",
        actor: "agent",
        derivationId,
        at,
      });
      if (change === "assigned") {
        inferred.push(projectId);
      } else if (change === "excluded") {
        warnings.push(`project suggestion ${projectId} ignored: the user removed this source from that project`);
      }
    }
    reindex(context, sourceId);
    // Newly matchable material counts as a change for freshness checks.
    context.db.run("UPDATE sources SET changed_seq = ?, updated_at = ? WHERE id = ?", [
      nextChangeSeq(context.db),
      at,
      sourceId,
    ]);
    const receipt: EnrichmentReceipt = {
      derivation_id: derivationId,
      ref: formatSourceRef(sourceId, version.version),
      replayed: false,
      state: status,
      inferred_projects: inferred,
      events: schedule.events,
      cancelled_events: schedule.cancelled,
      warnings,
    };
    insertOperation(context.db, {
      id: newId("operation", context.now().getTime()),
      kind: "enrich",
      idempotency_key: request.idempotency_key ?? null,
      request_digest: requestDigest,
      receipt_json: JSON.stringify(receipt),
      created_at: at,
    });
    recordAudit(context.db, { at, actor: "agent", operation: "source.enrich", subjectIds: [sourceId, derivationId] });
    return receipt;
  });
}

/** A malformed result leaves the Source saved and marks enrichment failed (retryable). */
function recordFailure(context: AppContext, input: unknown, error: unknown): void {
  const ref = (input as { source_ref?: { id?: unknown; version?: unknown } } | null)?.source_ref;
  if (typeof ref?.id !== "string" || typeof ref.version !== "number") {
    return;
  }
  const id = ref.id.trim().toUpperCase();
  const version = ref.version;
  if (!isId("source", id)) {
    return;
  }
  context.db.transaction(() => {
    const current = context.db.get<{ current_version: number }>("SELECT current_version FROM sources WHERE id = ?", [
      id,
    ]);
    if (current?.current_version !== version || activeDerived(context.db, id, version, "enrichment") !== undefined) {
      return;
    }
    setProcessingState(context.db, {
      sourceId: id,
      version,
      stage: "enrichment",
      state: "failed",
      error: error instanceof Error ? error.message.slice(0, 500) : "invalid enrichment",
      countAttempt: true,
      at: isoNow(context),
    });
  });
}
