import { SearchRequest, type SearchRequestInput } from "../contracts/search.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { formatSourceRef } from "../domain/ids.js";
import { foldForSearch, safeSlice } from "../domain/text.js";
import { projectsForSources } from "../infra/db/repos/projects.js";
import { currentEnrichments, getChunks, getSourceVersion } from "../infra/db/repos/sources.js";
import { type QueryToken, runSearch, tokenize } from "../infra/search/query.js";
import type { AppContext } from "./context.js";
import { resolveProject } from "./projects.js";
import { parseCursor, titleOf } from "./sources.js";

export const SEARCH_STRATEGY_VERSION = "search.v1";
const MAX_MATCHES_PER_SOURCE = 3;
const EXCERPT_BEFORE = 80;
const EXCERPT_AFTER = 220;

export interface SearchMatch {
  chunk_ordinal: number;
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
  const text = getSourceVersion(context.db, sourceId, version)?.content_text;
  if (text === null || text === undefined) {
    return [];
  }
  const textTokens = tokens.filter((token) => token.mode !== "id").map((token) => token.folded);
  const scored = getChunks(context.db, sourceId, version)
    .map((chunk) => {
      const original = text.slice(chunk.start_offset, chunk.end_offset);
      const folded = foldForSearch(original);
      const positions = textTokens.map((token) => folded.indexOf(token)).filter((position) => position >= 0);
      return { chunk, original, folded, positions };
    })
    .filter((entry) => entry.positions.length > 0 || textTokens.length === 0)
    .sort((a, b) => b.positions.length - a.positions.length || a.chunk.ordinal - b.chunk.ordinal)
    .slice(0, MAX_MATCHES_PER_SOURCE);
  return scored.map(({ chunk, original, folded, positions }) => {
    const first = positions.length > 0 ? Math.min(...positions) : 0;
    const ratio = folded.length === 0 ? 1 : original.length / folded.length;
    const center = Math.round(first * ratio);
    const localStart = Math.max(0, center - EXCERPT_BEFORE);
    const localEnd = Math.min(original.length, center + EXCERPT_AFTER);
    const excerpt = safeSlice(original, localStart, localEnd);
    return {
      chunk_ordinal: chunk.ordinal,
      start: chunk.start_offset + localStart,
      end: chunk.start_offset + localStart + excerpt.length,
      excerpt,
    };
  });
}
