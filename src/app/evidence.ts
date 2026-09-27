import { EvidenceRequest, type EvidenceRequestInput } from "../contracts/evidence.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { assertId, formatSourceRef, newId, parseSourceRef } from "../domain/ids.js";
import { safeSlice } from "../domain/text.js";
import { assertTimezone } from "../infra/config/config.js";
import { currentChangeSeq } from "../infra/db/repos/counters.js";
import { activeDerivedList, getDerived } from "../infra/db/repos/derived.js";
import {
  type EvidenceItemRow,
  getEvidenceItems,
  getEvidenceRun,
  insertEvidenceItem,
  insertEvidenceRun,
} from "../infra/db/repos/evidence.js";
import { payloadsFor } from "../infra/db/repos/files.js";
import { findProjectById } from "../infra/db/repos/projects.js";
import { currentEnrichments, getSource, getSourceVersion } from "../infra/db/repos/sources.js";
import { derivationText, describeLocator, readableText, spanLocator } from "./content.js";
import { type AppContext, isoNow } from "./context.js";
import { resolveProject } from "./projects.js";
import { search } from "./search.js";
import { requireSource, requireVersion, titleOf } from "./sources.js";

export const EVIDENCE_STRATEGY_VERSION = "evidence.v1";
const EXCERPT_LIMIT = 2000;

interface PendingItem {
  source_id: string;
  version: number;
  start: number;
  end: number;
  origin: EvidenceItemRow["origin"];
  /** Extracted-text span of this derivation (null for authored text or whole payloads). */
  derivationId: string | null;
  /** Whole-payload item, e.g. an image: {"payload_sha256", "filename", "mime"}. */
  locator: Record<string, unknown> | null;
  handle?: string;
}

/** One item per payload, for revisions without readable text (images). */
function payloadItems(
  context: AppContext,
  sourceId: string,
  version: number,
  origin: PendingItem["origin"],
): PendingItem[] {
  const interpretations = activeDerivedList(context.db, sourceId, version, "interpretation");
  return payloadsFor(context.db, sourceId, version).map((payload) => ({
    source_id: sourceId,
    version,
    start: 0,
    end: 1,
    origin,
    derivationId: null,
    locator: {
      payload_sha256: payload.blob_sha256,
      filename: payload.filename,
      mime: payload.mime,
      // The interpretation in force when pinned, so later re-interpretation cannot change the excerpt.
      interpretation_id: interpretations.find((row) => row.payload_sha256 === payload.blob_sha256)?.id ?? null,
    },
  }));
}

/** The interpretation an image item was pinned with (null when none existed at pin time). */
export function pinnedInterpretation(
  context: AppContext,
  sourceId: string,
  version: number,
  locator: { payload_sha256: string; interpretation_id?: string | null },
) {
  if (locator.interpretation_id === undefined) {
    return activeDerivedList(context.db, sourceId, version, "interpretation").find(
      (row) => row.payload_sha256 === locator.payload_sha256,
    );
  }
  return locator.interpretation_id === null ? undefined : getDerived(context.db, locator.interpretation_id);
}

/**
 * Pins evidence for one request: search hits (per matching chunk), explicit source/chunk refs, and
 * exact quotes. The core assigns handles (c1…cN) that artifacts must cite. Runs are immutable;
 * `from` starts a new run that carries earlier items with their handles.
 */
export function prepareEvidence(context: AppContext, input: EvidenceRequestInput, options: { from?: string } = {}) {
  const request = parseContract(EvidenceRequest, input, "evidence request");
  const timezone = request.interpretation?.timezone ?? context.config.timezone;
  assertTimezone(timezone);
  const project = request.project === undefined ? undefined : resolveProject(context, request.project);
  const base = options.from === undefined ? undefined : requireRun(context, options.from);
  if (base !== undefined && (base.project_id ?? undefined) !== project?.id) {
    throw new MiosotisError("validation", "An extended evidence run must keep the same project scope");
  }
  const items: PendingItem[] = [];
  const seen = new Set<string>();
  const add = (item: PendingItem) => {
    const key = `${item.source_id}@${item.version}:${item.derivationId ?? ""}:${JSON.stringify(item.locator)}:${item.start}-${item.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
    }
  };
  if (base !== undefined) {
    for (const item of getEvidenceItems(context.db, base.id)) {
      add({
        source_id: item.source_id,
        version: item.version,
        start: item.start_offset,
        end: item.end_offset,
        origin: "carried",
        derivationId: item.derivation_id,
        locator: item.locator_json === null ? null : (JSON.parse(item.locator_json) as Record<string, unknown>),
        handle: item.handle,
      });
    }
  }
  const queryCoverage = request.queries.map((query) => {
    const result = search(context, {
      query,
      match: request.match,
      limit: request.per_query_limit,
      ...(project === undefined ? {} : { project: project.id }),
    });
    for (const hit of result.hits) {
      const version = Number(hit.ref.split("@v")[1]);
      const readable = readableText(context, hit.source_id, version);
      if (readable.segments.length === 0) {
        for (const item of payloadItems(context, hit.source_id, version, "search")) {
          add(item);
        }
        continue;
      }
      const matched = hit.matches.filter((match) => match.matched_in !== "file").map((match) => match.chunk_ordinal);
      for (const ordinal of matched.length > 0 ? matched : [0]) {
        const segment = readable.segments.find((candidate) => candidate.ordinal === ordinal);
        if (segment !== undefined) {
          add({
            source_id: hit.source_id,
            version,
            start: segment.start,
            end: segment.end,
            origin: "search",
            derivationId: segment.derivationId,
            locator: null,
          });
        }
      }
    }
    return {
      query,
      mode: result.mode,
      total: result.total,
      returned: result.hits.length,
      truncated: result.total > result.hits.length || result.truncated,
    };
  });
  for (const pin of request.source_refs) {
    const { id, version } = eligibleRevision(context, pin.ref, project?.id);
    const readable = readableText(context, id, version);
    if (readable.segments.length === 0) {
      if (pin.chunk !== undefined) {
        throw new MiosotisError(
          "not_found",
          `${formatSourceRef(id, version)} has no text chunks (it is a file without extracted text)`,
        );
      }
      for (const item of payloadItems(context, id, version, "source_ref")) {
        add(item);
      }
      continue;
    }
    const selected =
      pin.chunk === undefined
        ? readable.segments
        : readable.segments.filter((segment) => segment.ordinal === pin.chunk);
    if (selected.length === 0) {
      throw new MiosotisError("not_found", `No chunk ${pin.chunk} in ${formatSourceRef(id, version)}`);
    }
    for (const segment of selected) {
      add({
        source_id: id,
        version,
        start: segment.start,
        end: segment.end,
        origin: "source_ref",
        derivationId: segment.derivationId,
        locator: null,
      });
    }
  }
  for (const pin of request.quotes) {
    const { id, version } = eligibleRevision(context, pin.ref, project?.id);
    const readable = readableText(context, id, version);
    const offsets = occurrences(readable.text, pin.quote);
    if (offsets.length === 0) {
      throw new MiosotisError("validation", `Quote not found verbatim in ${formatSourceRef(id, version)}`, {
        ref: pin.ref,
      });
    }
    if (offsets.length > 1 && pin.occurrence === undefined) {
      throw new MiosotisError(
        "validation",
        `Quote occurs ${offsets.length} times in ${formatSourceRef(id, version)}; set "occurrence"`,
        {
          ref: pin.ref,
          occurrences: offsets.length,
        },
      );
    }
    const start = offsets[(pin.occurrence ?? 1) - 1];
    if (start === undefined) {
      throw new MiosotisError("validation", `Quote has only ${offsets.length} occurrence(s)`);
    }
    add({
      source_id: id,
      version,
      start,
      end: start + pin.quote.length,
      origin: "quote_pin",
      derivationId: readable.derivationId,
      locator: null,
    });
  }
  const carried = items.filter((item) => item.handle !== undefined);
  const fresh = items.filter((item) => item.handle === undefined);
  const room = Math.max(0, request.max_items - carried.length);
  const kept = fresh.slice(0, room);
  let next = carried.reduce((max, item) => Math.max(max, Number((item.handle ?? "c0").slice(1))), 0);
  for (const item of kept) {
    next += 1;
    item.handle = `c${next}`;
  }
  const at = isoNow(context);
  const runId = newId("evidence", context.now().getTime());
  context.db.transaction(() => {
    insertEvidenceRun(context.db, {
      id: runId,
      request: request.request,
      intent: request.intent ?? null,
      interpretation_json: JSON.stringify({
        timezone,
        date_from: request.interpretation?.date_from ?? null,
        date_to: request.interpretation?.date_to ?? null,
        notes: request.interpretation?.notes ?? null,
        queries: request.queries,
      }),
      project_id: project?.id ?? null,
      scope_json: JSON.stringify({ project: project?.slug ?? null, match: request.match, visible_only: true }),
      strategy_version: EVIDENCE_STRATEGY_VERSION,
      watermark_seq: currentChangeSeq(context.db),
      extends_run_id: base?.id ?? null,
      coverage_json: JSON.stringify({
        queries: queryCoverage,
        items: carried.length + kept.length,
        dropped_items: fresh.length - kept.length,
      }),
      created_at: at,
    });
    for (const item of [...carried, ...kept]) {
      insertEvidenceItem(context.db, {
        run_id: runId,
        handle: item.handle ?? "",
        source_id: item.source_id,
        version: item.version,
        start_offset: item.start,
        end_offset: item.end,
        origin: item.handle !== undefined && carried.includes(item) ? "carried" : item.origin,
        derivation_id: item.derivationId,
        locator_json: item.locator === null ? null : JSON.stringify(item.locator),
      });
    }
  });
  return evidenceView(context, runId);
}

export function requireRun(context: AppContext, id: string) {
  const runId = assertId("evidence", id);
  const run = getEvidenceRun(context.db, runId);
  if (run === undefined) {
    throw new MiosotisError("not_found", `No evidence run ${runId}`);
  }
  return run;
}

/** The pinned run with computed excerpts and each source's present state. */
export function evidenceView(context: AppContext, id: string) {
  const run = requireRun(context, id);
  const items = getEvidenceItems(context.db, run.id);
  const sourceIds = [...new Set(items.map((item) => item.source_id))];
  const enrichments = currentEnrichments(context.db, sourceIds);
  const project = run.project_id === null ? undefined : findProjectById(context.db, run.project_id);
  const coverage = JSON.parse(run.coverage_json) as Record<string, unknown>;
  return {
    id: run.id,
    request: run.request,
    intent: run.intent,
    project: project === undefined ? null : { id: project.id, slug: project.slug },
    interpretation: JSON.parse(run.interpretation_json) as unknown,
    strategy: run.strategy_version,
    watermark_seq: run.watermark_seq,
    extends: run.extends_run_id,
    created_at: run.created_at,
    coverage,
    citation_syntax: "Cite items in Markdown as [@c1]; only handles from this run are accepted.",
    items: items.map((item) => {
      const source = getSource(context.db, item.source_id);
      const excerpt = itemExcerpt(context, item, EXCERPT_LIMIT);
      return {
        handle: item.handle,
        ref: formatSourceRef(item.source_id, item.version),
        source_id: item.source_id,
        version: item.version,
        start: item.start_offset,
        end: item.end_offset,
        origin: item.origin,
        kind: item.locator_json !== null ? "file" : item.derivation_id !== null ? "extracted_text" : "text",
        /** Page/sheet/range of an extracted-text item, when the extraction recorded one. */
        where: describeLocator(spanLocator(context, item.derivation_id, item.start_offset)) || null,
        derivation_id: item.derivation_id,
        locator: item.locator_json === null ? null : (JSON.parse(item.locator_json) as unknown),
        title:
          item.version === source?.current_version
            ? titleOf(enrichments.get(item.source_id)?.content_json ?? null)
            : null,
        source_origin: source?.origin ?? null,
        source_state: {
          current_version: source?.current_version ?? null,
          retention: source?.retention ?? null,
          inclusion: source?.inclusion ?? null,
        },
        excerpt,
        excerpt_truncated:
          item.locator_json === null && excerpt !== null && excerpt.length < item.end_offset - item.start_offset,
      };
    }),
  };
}

/**
 * The text an evidence item stands for: a span of authored or extracted text, or for a whole payload
 * (image) its filename plus any interpretation, clearly marked as model-derived.
 */
export function itemExcerpt(context: AppContext, item: EvidenceItemRow, limit: number): string | null {
  if (item.locator_json !== null) {
    const locator = JSON.parse(item.locator_json) as {
      payload_sha256: string;
      filename?: string | null;
      mime?: string;
      interpretation_id?: string | null;
    };
    const interpretation = pinnedInterpretation(context, item.source_id, item.version, locator);
    const described =
      interpretation?.content_json == null
        ? "not interpreted yet"
        : `interpretation (model-derived): ${(JSON.parse(interpretation.content_json) as { description: string }).description}`;
    return safeSlice(
      `[${locator.mime ?? "file"}] ${locator.filename ?? locator.payload_sha256} — ${described}`,
      0,
      limit,
    );
  }
  let text: string | null;
  if (item.derivation_id !== null) {
    const derivation = getDerived(context.db, item.derivation_id);
    text = derivation === undefined || derivation.content_blob === null ? null : derivationText(context, derivation);
  } else {
    text = getSourceVersion(context.db, item.source_id, item.version)?.content_text ?? null;
  }
  return text === null
    ? null
    : safeSlice(text, item.start_offset, Math.min(item.end_offset, item.start_offset + limit));
}

function eligibleRevision(context: AppContext, reference: string, projectId: string | undefined) {
  const ref = parseSourceRef(reference);
  const source = requireSource(context, ref.id);
  if (source.retention !== "retained" || source.inclusion !== "included") {
    throw new MiosotisError(
      "validation",
      `${source.id} is ${source.retention}/${source.inclusion} and cannot be used as evidence`,
      {
        source_id: source.id,
      },
    );
  }
  if (projectId !== undefined) {
    const member = context.db.get("SELECT 1 FROM source_projects WHERE source_id = ? AND project_id = ?", [
      source.id,
      projectId,
    ]);
    if (member === undefined) {
      throw new MiosotisError("validation", `${source.id} is outside the evidence run's project scope`);
    }
  }
  const version = ref.version ?? source.current_version;
  const row = requireVersion(context, source.id, version);
  if (row.content_text === null) {
    throw new MiosotisError("validation", `${formatSourceRef(source.id, version)} was purged`);
  }
  return { id: source.id, version };
}

function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  let index = text.indexOf(quote);
  while (index !== -1) {
    found.push(index);
    index = text.indexOf(quote, index + 1);
  }
  return found;
}
