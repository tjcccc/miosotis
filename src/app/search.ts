import { SearchRequest, type SearchRequestInput } from "../contracts/search.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { formatSourceRef } from "../domain/ids.js";
import { foldForSearch, safeSlice } from "../domain/text.js";
import { activeDerivedList } from "../infra/db/repos/derived.js";
import { payloadsFor } from "../infra/db/repos/files.js";
import { projectsForSources } from "../infra/db/repos/projects.js";
import { currentEnrichments } from "../infra/db/repos/sources.js";
import { type QueryToken, runSearch, tokenize } from "../infra/search/query.js";
import { readableText } from "./content.js";
import type { AppContext } from "./context.js";
import { resolveProject } from "./projects.js";
import { parseCursor, titleOf } from "./sources.js";

export const SEARCH_STRATEGY_VERSION = "search.v1";
const MAX_MATCHES_PER_SOURCE = 3;
const EXCERPT_BEFORE = 80;
const EXCERPT_AFTER = 220;

export interface SearchMatch {
  /**
   * `text`/`extracted`: a term occurs in this span of authored/extracted text. `enrichment`: only
   * AI-derived terms matched; this is the opening. `file`: no readable text (e.g. an image).
   */
  matched_in: "text" | "extracted" | "enrichment" | "file";
  chunk_ordinal: number;
  /** Set for spans of extracted text. */
  derivation_id: string | null;
  start: number;
  end: number;
  excerpt: string;
}

export interface SearchHit {
  source_id: string;
  ref: string;
  created_at: string;
  title: string | null;
  enrichment_state: string;
  projects: { slug: string; assignment: string }[];
  matched_terms: number;
  matches: SearchMatch[];
}

/**
 * Evidence-finding search for the agent. Results are candidates, not evidence: callers read the
 * original text (`source get`) or pin it (`evidence prepare`) before relying on it.
 */
export function search(context: AppContext, input: SearchRequestInput) {
  const request = parseContract(SearchRequest, input, "search request");
  const tokens = tokenize(request.query);
  if (tokens.length === 0) {
    throw new MiosotisError("validation", "Search query has no usable terms");
  }
  const project = request.project === undefined ? undefined : resolveProject(context, request.project);
  const offset = parseCursor(request.cursor);
  const { rows, total, truncated } = runSearch(context.db, {
    tokens,
    match: request.match,
    projectId: project?.id,
    limit: request.limit,
    offset,
  });
  const ids = rows.map((row) => row.source_id);
  const enrichments = currentEnrichments(context.db, ids);
  const projects = projectsForSources(context.db, ids);
  const states = new Map(
    ids.length === 0
      ? []
      : context.db
          .all<{ source_id: string; state: string }>(
            `SELECT ps.source_id, ps.state FROM processing_states ps JOIN sources s ON s.id = ps.source_id AND s.current_version = ps.version
             WHERE ps.stage = 'enrichment' AND ps.source_id IN (${ids.map(() => "?").join(", ")})`,
            ids,
          )
          .map((row) => [row.source_id, row.state]),
  );
  const hits: SearchHit[] = rows.map((row) => ({
    source_id: row.source_id,
    ref: formatSourceRef(row.source_id, row.current_version),
    created_at: row.created_at,
    title: titleOf(enrichments.get(row.source_id)?.content_json ?? null),
    enrichment_state: states.get(row.source_id) ?? "unknown",
    projects: projects
      .filter((p) => p.source_id === row.source_id)
      .map((p) => ({ slug: p.slug, assignment: p.assignment })),
    matched_terms: row.matched,
    matches: findMatches(context, row.source_id, row.current_version, tokens),
  }));
  const modes = new Set(tokens.map((token) => token.mode));
  return {
    query: request.query,
    strategy: SEARCH_STRATEGY_VERSION,
    mode: modes.size > 1 ? "mixed" : (tokens[0]?.mode ?? "fts"),
    tokens: tokens.map((token) => ({ text: token.text, mode: token.mode })),
    match: request.match,
    scope: { project: project?.slug ?? null, visible_only: true, current_versions_only: true },
    total,
    truncated,
    next_cursor: offset + rows.length < total ? String(offset + rows.length) : null,
    hits,
  };
}

function findMatches(context: AppContext, sourceId: string, version: number, tokens: QueryToken[]): SearchMatch[] {
  const readable = readableText(context, sourceId, version);
  if (readable.segments.length === 0) {
    return fileFallback(context, sourceId, version);
  }
  const text = readable.text;
  const matchedIn = readable.origin === "extracted" ? "extracted" : "text";
  const textTokens = tokens.filter((token) => token.mode !== "id").map((token) => token.folded);
  const scored = readable.segments
    .map((segment) => {
      const original = text.slice(segment.start, segment.end);
      const folded = foldForSearch(original);
      const positions = textTokens.map((token) => folded.indexOf(token)).filter((position) => position >= 0);
      return { segment, original, folded, positions };
    })
    .filter((entry) => entry.positions.length > 0 || textTokens.length === 0)
    .sort((a, b) => b.positions.length - a.positions.length || a.segment.ordinal - b.segment.ordinal)
    .slice(0, MAX_MATCHES_PER_SOURCE);
  const first = readable.segments[0];
  if (scored.length === 0 && first !== undefined) {
    const excerpt = safeSlice(text, first.start, Math.min(first.end, first.start + EXCERPT_BEFORE + EXCERPT_AFTER));
    return [
      {
        matched_in: "enrichment",
        chunk_ordinal: first.ordinal,
        derivation_id: first.derivationId,
        start: first.start,
        end: first.start + excerpt.length,
        excerpt,
      },
    ];
  }
  return scored.map(({ segment, original, folded, positions }) => {
    const firstHit = positions.length > 0 ? Math.min(...positions) : 0;
    const ratio = folded.length === 0 ? 1 : original.length / folded.length;
    const center = Math.round(firstHit * ratio);
    const localStart = Math.max(0, center - EXCERPT_BEFORE);
    const localEnd = Math.min(original.length, center + EXCERPT_AFTER);
    const excerpt = safeSlice(original, localStart, localEnd);
    return {
      matched_in: matchedIn,
      chunk_ordinal: segment.ordinal,
      derivation_id: segment.derivationId,
      start: segment.start + localStart,
      end: segment.start + localStart + excerpt.length,
      excerpt,
    };
  });
}

/** Files without readable text (e.g. images): show the filename and any interpretation, marked. */
function fileFallback(context: AppContext, sourceId: string, version: number): SearchMatch[] {
  const payload = payloadsFor(context.db, sourceId, version)[0];
  if (payload === undefined) {
    return [];
  }
  const interpretation = activeDerivedList(context.db, sourceId, version, "interpretation")[0];
  const description =
    interpretation?.content_json === null || interpretation === undefined
      ? "no interpretation yet"
      : `interpretation (model-derived): ${(JSON.parse(interpretation.content_json) as { description: string }).description}`;
  return [
    {
      matched_in: "file",
      chunk_ordinal: 0,
      derivation_id: null,
      start: 0,
      end: 0,
      excerpt: safeSlice(
        `[${payload.mime}] ${payload.filename ?? "file"} — ${description}`,
        0,
        EXCERPT_BEFORE + EXCERPT_AFTER,
      ),
    },
  ];
}
