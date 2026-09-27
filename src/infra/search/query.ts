import { ANY_ID_PATTERN } from "../../domain/ids.js";
import { codePointLength, foldForSearch } from "../../domain/text.js";
import type { Database } from "../db/database.js";

export type TokenMode = "fts" | "substring" | "id";

export interface QueryToken {
  text: string;
  folded: string;
  mode: TokenMode;
}

/** Trigram FTS cannot match fewer than three characters; shorter terms use an escaped substring scan. */
export const MIN_FTS_CODE_POINTS = 3;
export const MAX_TOKENS = 16;
export const SUBSTRING_CANDIDATE_CAP = 5000;

export function tokenize(query: string): QueryToken[] {
  const seen = new Set<string>();
  const tokens: QueryToken[] = [];
  for (const raw of query.split(/\s+/u)) {
    if (raw.length === 0) {
      continue;
    }
    const idMatch = /^([SPAEDO]-[0-9A-Z]{26})(?:@v\d+)?$/i.exec(raw);
    if (idMatch?.[1] !== undefined && ANY_ID_PATTERN.test(idMatch[1])) {
      const id = idMatch[1].toUpperCase();
      if (!seen.has(`id:${id}`)) {
        seen.add(`id:${id}`);
        tokens.push({ text: raw, folded: id, mode: "id" });
      }
      continue;
    }
    const folded = foldForSearch(raw);
    if (folded.length === 0 || seen.has(folded)) {
      continue;
    }
    seen.add(folded);
    tokens.push({ text: raw, folded, mode: codePointLength(folded) >= MIN_FTS_CODE_POINTS ? "fts" : "substring" });
  }
  return tokens.slice(0, MAX_TOKENS);
}

export function ftsPhrase(folded: string): string {
  return `norm : "${folded.replaceAll('"', '""')}"`;
}

export function likePattern(folded: string): string {
  return `%${folded.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export interface SearchSqlInput {
  tokens: QueryToken[];
  match: "all" | "any";
  projectId: string | undefined;
  limit: number;
  offset: number;
}

export interface SearchHitRow {
  source_id: string;
  current_version: number;
  created_at: string;
  score: number;
  matched: number;
}

/**
 * Per-source matching over current-version rows, filtered by the shared `visible_sources` policy view.
 * `all` requires every token to hit somewhere in the source (any chunk or the enrichment row).
 */
export function runSearch(
  db: Database,
  input: SearchSqlInput,
): { rows: SearchHitRow[]; total: number; truncated: boolean } {
  const ctes: string[] = [];
  const params: (string | number)[] = [];
  let truncated = false;
  input.tokens.forEach((token, index) => {
    if (token.mode === "fts") {
      ctes.push(
        // MATERIALIZED keeps bm25() in a plain FTS query; SQLite rejects it once flattened into an aggregate.
        `r${index} AS MATERIALIZED (SELECT source_id, bm25(search_fts) AS score FROM search_fts WHERE search_fts MATCH ?), ` +
          `t${index} AS (SELECT source_id, min(score) AS score FROM r${index} GROUP BY source_id)`,
      );
      params.push(ftsPhrase(token.folded));
    } else if (token.mode === "substring") {
      ctes.push(
        `t${index} AS (SELECT source_id, 0.0 AS score FROM search_fts WHERE norm LIKE ? ESCAPE '\\' GROUP BY source_id LIMIT ${SUBSTRING_CANDIDATE_CAP + 1})`,
      );
      params.push(likePattern(token.folded));
      const count =
        db.get<{ n: number }>(
          `SELECT count(*) AS n FROM (SELECT DISTINCT source_id FROM search_fts WHERE norm LIKE ? ESCAPE '\\' LIMIT ${SUBSTRING_CANDIDATE_CAP + 1})`,
          [likePattern(token.folded)],
        )?.n ?? 0;
      truncated ||= count > SUBSTRING_CANDIDATE_CAP;
    } else {
      ctes.push(`t${index} AS (SELECT id AS source_id, -1000.0 AS score FROM sources WHERE id = ?)`);
      params.push(token.folded);
    }
  });
  const union = input.tokens.map((_, index) => `SELECT source_id, score FROM t${index}`).join(" UNION ALL ");
  const required = input.match === "all" ? input.tokens.length : 1;
  const projectClause =
    input.projectId === undefined
      ? ""
      : "AND EXISTS (SELECT 1 FROM source_projects sp WHERE sp.source_id = v.id AND sp.project_id = ?)";
  const base = `WITH ${ctes.join(", ")},
    hits AS (SELECT source_id, sum(score) AS score, count(*) AS matched FROM (${union}) GROUP BY source_id HAVING count(*) >= ${required})
    SELECT v.id AS source_id, v.current_version, v.created_at, hits.score, hits.matched
    FROM hits JOIN visible_sources v ON v.id = hits.source_id
    WHERE 1 = 1 ${projectClause}`;
  const baseParams = input.projectId === undefined ? params : [...params, input.projectId];
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM (${base})`, baseParams)?.n ?? 0;
  const rows = db.all<SearchHitRow>(
    `${base} ORDER BY hits.matched DESC, hits.score ASC, v.created_at DESC LIMIT ? OFFSET ?`,
    [...baseParams, input.limit, input.offset],
  );
  return { rows, total, truncated };
}
