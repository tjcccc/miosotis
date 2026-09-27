import { MiosotisError } from "../domain/errors.js";
import { formatSourceRef, parseSourceRef } from "../domain/ids.js";
import { safeSlice } from "../domain/text.js";
import { projectsForSources } from "../infra/db/repos/projects.js";
import {
  currentEnrichments,
  getChunks,
  getProcessingStates,
  getSource,
  getSourceVersion,
  listSources,
  listSourceVersions,
  type SourceRow,
  type SourceVersionRow,
} from "../infra/db/repos/sources.js";
import type { AppContext } from "./context.js";
import { resolveProject } from "./projects.js";

export const DEFAULT_MAX_CHARS = 20_000;

export function requireSource(context: AppContext, id: string): SourceRow {
  const row = getSource(context.db, id);
  if (row === undefined) {
    throw new MiosotisError("not_found", `No source ${id}`, { source_id: id });
  }
  return row;
}

export function requireVersion(context: AppContext, id: string, version: number): SourceVersionRow {
  const row = getSourceVersion(context.db, id, version);
  if (row === undefined) {
    throw new MiosotisError("not_found", `No version ${version} of ${id}`, { source_id: id, version });
  }
  return row;
}

export interface GetSourceOptions {
  range?: { start: number; end: number } | undefined;
  chunk?: number | undefined;
  maxChars?: number | undefined;
}

export function getSourceView(context: AppContext, reference: string, options: GetSourceOptions = {}) {
  const ref = parseSourceRef(reference);
  const source = requireSource(context, ref.id);
  const versionNumber = ref.version ?? source.current_version;
  const version = requireVersion(context, source.id, versionNumber);
  const chunks = getChunks(context.db, source.id, versionNumber);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const full = version.content_text;
  let start = 0;
  let end = full?.length ?? 0;
  if (options.chunk !== undefined) {
    const chunk = chunks.find((candidate) => candidate.ordinal === options.chunk);
    if (chunk === undefined) {
      throw new MiosotisError("not_found", `No chunk ${options.chunk} in ${formatSourceRef(source.id, versionNumber)}`);
    }
    start = chunk.start_offset;
    end = chunk.end_offset;
  } else if (options.range !== undefined) {
    start = options.range.start;
    end = options.range.end;
  }
  if (start < 0 || end < start) {
    throw new MiosotisError("validation", "Invalid text range");
  }
  const bounded = Math.min(end, start + maxChars);
  const text = full === null ? null : safeSlice(full, start, bounded);
  const enrichment =
    versionNumber === source.current_version ? currentEnrichments(context.db, [source.id]).get(source.id) : undefined;
  return {
    id: source.id,
    ref: formatSourceRef(source.id, versionNumber),
    kind: source.kind,
    origin: source.origin,
    retention: source.retention,
    inclusion: source.inclusion,
    inclusion_reason: source.inclusion_reason,
    created_at: source.created_at,
    current_version: source.current_version,
    version: versionView(version, source.current_version),
    text,
    text_range: full === null ? null : { start, end: start + (text?.length ?? 0) },
    truncated: full !== null && start + (text?.length ?? 0) < Math.min(end, full.length),
    chunks: chunks.map((chunk) => ({ ordinal: chunk.ordinal, start: chunk.start_offset, end: chunk.end_offset })),
    projects: projectsForSources(context.db, [source.id]).map((row) => ({
      id: row.project_id,
      slug: row.slug,
      name: row.name,
      assignment: row.assignment,
    })),
    processing: Object.fromEntries(
      getProcessingStates(context.db, source.id, versionNumber).map((row) => [
        row.stage,
        { state: row.state, attempts: row.attempts, last_error: row.last_error, updated_at: row.updated_at },
      ]),
    ),
    enrichment:
      enrichment === undefined
        ? null
        : {
            derived: true,
            derivation_id: enrichment.id,
            model: enrichment.model,
            created_at: enrichment.created_at,
            content: enrichment.content_json === null ? null : (JSON.parse(enrichment.content_json) as unknown),
          },
  };
}

function versionView(version: SourceVersionRow, current: number) {
  return {
    number: version.version,
    ref: formatSourceRef(version.source_id, version.version),
    is_current: version.version === current,
    parent_version: version.parent_version,
    reason: version.reason,
    actor: version.actor,
    received_at: version.received_at,
    client_captured_at: version.client_captured_at,
    timezone: version.timezone,
    char_length: version.char_length,
    content_digest: version.content_digest,
    provenance: version.provenance_json === null ? null : (JSON.parse(version.provenance_json) as unknown),
    purged: version.purged_at !== null,
  };
}

export function sourceHistoryView(context: AppContext, reference: string) {
  const ref = parseSourceRef(reference);
  const source = requireSource(context, ref.id);
  return {
    id: source.id,
    current_version: source.current_version,
    retention: source.retention,
    inclusion: source.inclusion,
    versions: listSourceVersions(context.db, source.id).map((version) => versionView(version, source.current_version)),
  };
}

export interface ListSourcesOptions {
  project?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  all?: boolean | undefined;
}

/** Deterministic enumeration (newest first) for coverage checks; not relevance-ranked. */
export function listSourceViews(context: AppContext, options: ListSourcesOptions = {}) {
  const limit = clampLimit(options.limit, 200, 50);
  const offset = parseCursor(options.cursor);
  const project = options.project === undefined ? undefined : resolveProject(context, options.project);
  const { rows, total } = listSources(context.db, {
    visibleOnly: !options.all,
    projectId: project?.id,
    since: options.since,
    until: options.until,
    limit,
    offset,
  });
  const ids = rows.map((row) => row.id);
  const enrichments = currentEnrichments(context.db, ids);
  const projects = projectsForSources(context.db, ids);
  return {
    scope: {
      project: project?.slug ?? null,
      since: options.since ?? null,
      until: options.until ?? null,
      visible_only: !options.all,
    },
    total,
    next_cursor: offset + rows.length < total ? String(offset + rows.length) : null,
    sources: rows.map((row) => ({
      id: row.id,
      ref: formatSourceRef(row.id, row.current_version),
      kind: row.kind,
      origin: row.origin,
      retention: row.retention,
      inclusion: row.inclusion,
      created_at: row.created_at,
      char_length: row.char_length,
      enrichment_state: row.enrichment_state,
      title: titleOf(enrichments.get(row.id)?.content_json ?? null),
      projects: projects.filter((p) => p.source_id === row.id).map((p) => ({ slug: p.slug, assignment: p.assignment })),
    })),
  };
}

export function titleOf(contentJson: string | null): string | null {
  if (contentJson === null) {
    return null;
  }
  const parsed = JSON.parse(contentJson) as { title?: unknown };
  return typeof parsed.title === "string" ? parsed.title : null;
}

export function clampLimit(value: number | undefined, max: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new MiosotisError("validation", `limit must be an integer between 1 and ${max}`);
  }
  return value;
}

export function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    throw new MiosotisError("validation", "Invalid cursor");
  }
  return Number.parseInt(cursor, 10);
}
