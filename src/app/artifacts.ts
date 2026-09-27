import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_SCHEMA_VERSION, ArtifactRequest, type ArtifactRequestInput } from "../contracts/artifact.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { assertId, formatSourceRef, newId } from "../domain/ids.js";
import { safeSlice } from "../domain/text.js";
import { type ArtifactRow, getArtifact, getCitations, getLinks, insertArtifact } from "../infra/db/repos/artifacts.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { getEvidenceItems } from "../infra/db/repos/evidence.js";
import { findOperation, insertOperation } from "../infra/db/repos/operations.js";
import { getSource, getSourceVersion } from "../infra/db/repos/sources.js";
import { digestOf, sha256Hex } from "../infra/digest.js";
import { containedPath, ensureDir, writeFileAtomic } from "../infra/fs/files.js";
import { extractCitations, renderMarkdown } from "../infra/render/markdown.js";
import { artifactBody, htmlDocument, type StatusNotice, sourcePage, statusBanner } from "../infra/render/pages.js";
import { type AppContext, isoNow } from "./context.js";
import { requireRun } from "./evidence.js";

const CITED_EXCERPT_LIMIT = 600;

export interface ArtifactReceipt {
  id: string;
  replayed: boolean;
  title: string;
  intent: string;
  evidence_run_id: string;
  content_hash: string;
  citations: string[];
  derived_from: string | null;
  supersedes: boolean;
  warnings: string[];
}

/**
 * Validates and publishes an artifact atomically: frozen Markdown, rendered HTML, citations resolved
 * against the pinned evidence run, and lineage. The core (not the model) assigns ID, time, and hash.
 */
export function createArtifact(context: AppContext, input: ArtifactRequestInput): ArtifactReceipt {
  const request = parseContract(ArtifactRequest, input, "artifact request");
  const requestDigest = digestOf({ ...request, idempotency_key: undefined });
  return context.db.transaction(() => {
    if (request.idempotency_key !== undefined) {
      const previous = findOperation(context.db, "artifact", request.idempotency_key);
      if (previous !== undefined) {
        if (previous.request_digest !== requestDigest) {
          throw new MiosotisError("conflict", "Idempotency key was already used with a different artifact");
        }
        return { ...(JSON.parse(previous.receipt_json) as ArtifactReceipt), replayed: true };
      }
    }
    const run = requireRun(context, request.evidence_run_id);
    const items = new Map(getEvidenceItems(context.db, run.id).map((item) => [item.handle, item]));
    const handles = extractCitations(request.markdown);
    const unknown = handles.filter((handle) => !items.has(handle));
    if (unknown.length > 0) {
      throw new MiosotisError("validation", `Citations not in evidence run ${run.id}: ${unknown.join(", ")}`, {
        unknown_handles: unknown,
      });
    }
    const warnings: string[] = [];
    if (handles.length === 0) {
      warnings.push("The artifact cites no evidence.");
    }
    const cited = handles.map((handle) => {
      const item = items.get(handle);
      if (item === undefined) {
        throw new MiosotisError("internal", `Missing evidence item ${handle}`);
      }
      const source = getSource(context.db, item.source_id);
      if (source === undefined || source.retention !== "retained" || source.inclusion !== "included") {
        throw new MiosotisError(
          "validation",
          `${handle} cites ${item.source_id}, which is now ${source?.retention ?? "missing"}/${source?.inclusion ?? "missing"}; prepare evidence again`,
          { handle, source_id: item.source_id },
        );
      }
      const text = getSourceVersion(context.db, item.source_id, item.version)?.content_text ?? null;
      return {
        handle,
        item,
        ref: formatSourceRef(item.source_id, item.version),
        excerpt:
          text === null
            ? null
            : safeSlice(text, item.start_offset, Math.min(item.end_offset, item.start_offset + CITED_EXCERPT_LIMIT)),
      };
    });
    let parent: ArtifactRow | undefined;
    if (request.derived_from !== undefined) {
      parent = getArtifact(context.db, assertId("artifact", request.derived_from));
      if (parent === undefined) {
        throw new MiosotisError("not_found", `No artifact ${request.derived_from}`);
      }
    } else if (request.supersedes) {
      throw new MiosotisError("validation", "supersedes requires derived_from");
    }
    const at = isoNow(context);
    const id = newId("artifact", context.now().getTime());
    const generator = { mode: "host_agent", model: request.model ?? null };
    const contentHtml = renderMarkdown(request.markdown);
    const renderedHtml = artifactBody({
      id,
      title: request.title,
      intent: request.intent,
      request: request.request,
      finalizedAt: at,
      generator: generator.model === null ? "generated by AI host" : `generated by ${generator.model}`,
      contentHtml,
      limitations: request.limitations,
      cited: cited.map((entry) => ({
        handle: entry.handle,
        ref: entry.ref,
        excerpt: entry.excerpt,
        sourcePage: sourcePagePath(entry.ref),
      })),
    });
    const contentHash = `sha256:${sha256Hex(
      JSON.stringify({
        title: request.title,
        markdown: request.markdown,
        html: renderedHtml,
        limitations: request.limitations,
        citations: handles,
      }),
    )}`;
    insertArtifact(context.db, {
      id,
      schema_version: ARTIFACT_SCHEMA_VERSION,
      intent: request.intent,
      title: request.title,
      request: request.request,
      evidence_run_id: run.id,
      content_markdown: request.markdown,
      rendered_html: renderedHtml,
      content_hash: contentHash,
      generator_json: JSON.stringify(generator),
      limitations_json: JSON.stringify(request.limitations),
      lifecycle: "active",
      finalized_at: at,
      lifecycle_changed_at: null,
      purged_at: null,
    });
    for (const entry of cited) {
      context.db.run("INSERT INTO artifact_citations (artifact_id, run_id, handle) VALUES (?, ?, ?)", [
        id,
        run.id,
        entry.handle,
      ]);
    }
    if (parent !== undefined) {
      context.db.run(
        "INSERT INTO artifact_links (parent_id, child_id, kind, created_at) VALUES (?, ?, 'derived_from', ?)",
        [parent.id, id, at],
      );
      if (request.supersedes) {
        context.db.run(
          "INSERT INTO artifact_links (parent_id, child_id, kind, created_at) VALUES (?, ?, 'supersedes', ?)",
          [parent.id, id, at],
        );
      }
    }
    const receipt: ArtifactReceipt = {
      id,
      replayed: false,
      title: request.title,
      intent: request.intent,
      evidence_run_id: run.id,
      content_hash: contentHash,
      citations: handles,
      derived_from: parent?.id ?? null,
      supersedes: request.supersedes,
      warnings,
    };
    insertOperation(context.db, {
      id: newId("operation", context.now().getTime()),
      kind: "artifact",
      idempotency_key: request.idempotency_key ?? null,
      request_digest: requestDigest,
      receipt_json: JSON.stringify(receipt),
      created_at: at,
    });
    recordAudit(context.db, { at, actor: "agent", operation: "artifact.create", subjectIds: [id, run.id] });
    return receipt;
  });
}

export function requireArtifact(context: AppContext, id: string): ArtifactRow {
  const artifactId = assertId("artifact", id);
  const row = getArtifact(context.db, artifactId);
  if (row === undefined) {
    throw new MiosotisError("not_found", `No artifact ${artifactId}`);
  }
  return row;
}

export type FreshnessSignal =
  | { kind: "source_revised"; source_id: string; used_version: number; current_version: number }
  | { kind: "source_unavailable"; source_id: string; retention: string; inclusion: string }
  | { kind: "new_material"; count: number; scope: string }
  | { kind: "superseded"; by: string }
  | { kind: "trashed" };

/**
 * Freshness is computed at read time from the pinned manifest and current library state. It never
 * modifies the artifact and never calls a model.
 */
export function freshness(context: AppContext, artifact: ArtifactRow): FreshnessSignal[] {
  const signals: FreshnessSignal[] = [];
  if (artifact.lifecycle === "trashed") {
    signals.push({ kind: "trashed" });
  }
  const citations = getCitations(context.db, artifact.id);
  const seen = new Set<string>();
  for (const citation of citations) {
    if (seen.has(citation.source_id)) {
      continue;
    }
    seen.add(citation.source_id);
    const source = getSource(context.db, citation.source_id);
    if (source === undefined) {
      continue;
    }
    if (source.retention !== "retained" || source.inclusion !== "included") {
      signals.push({
        kind: "source_unavailable",
        source_id: source.id,
        retention: source.retention,
        inclusion: source.inclusion,
      });
    }
    const usedMax = Math.max(...citations.filter((c) => c.source_id === source.id).map((c) => c.version));
    if (source.current_version > usedMax) {
      signals.push({
        kind: "source_revised",
        source_id: source.id,
        used_version: usedMax,
        current_version: source.current_version,
      });
    }
  }
  const run = requireRun(context, artifact.evidence_run_id);
  const pinned = [...new Set(getEvidenceItems(context.db, run.id).map((item) => item.source_id))];
  const params: (string | number)[] = [run.watermark_seq];
  let projectClause = "";
  if (run.project_id !== null) {
    projectClause = "AND EXISTS (SELECT 1 FROM source_projects sp WHERE sp.source_id = v.id AND sp.project_id = ?)";
    params.push(run.project_id);
  }
  const exclusion = pinned.length === 0 ? "" : `AND v.id NOT IN (${pinned.map(() => "?").join(", ")})`;
  const fresh =
    context.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM visible_sources v WHERE v.changed_seq > ? ${projectClause} ${exclusion}`,
      [...params, ...pinned],
    )?.n ?? 0;
  if (fresh > 0) {
    signals.push({ kind: "new_material", count: fresh, scope: run.project_id === null ? "library" : "project" });
  }
  for (const link of getLinks(context.db, artifact.id)) {
    if (link.kind === "supersedes" && link.parent_id === artifact.id) {
      signals.push({ kind: "superseded", by: link.child_id });
    }
  }
  return signals;
}

export function describeSignal(signal: FreshnessSignal): StatusNotice {
  switch (signal.kind) {
    case "source_revised":
      return {
        level: "warn",
        text: `${signal.source_id} was corrected: this artifact used v${signal.used_version}, the current revision is v${signal.current_version}.`,
      };
    case "source_unavailable":
      return {
        level: "warn",
        text: `${signal.source_id} is now ${signal.retention}/${signal.inclusion} and would not be used again.`,
      };
    case "new_material":
      return {
        level: "info",
        text: `New material may be available: ${signal.count} source(s) in this ${signal.scope} were added or changed after this artifact's evidence was gathered. Relevance is not implied.`,
      };
    case "superseded":
      return { level: "info", text: `Superseded by ${signal.by}.` };
    case "trashed":
      return { level: "warn", text: "This artifact is in the trash." };
  }
}

export function artifactView(context: AppContext, id: string, options: { includeContent?: boolean } = {}) {
  const artifact = requireArtifact(context, id);
  const signals = freshness(context, artifact);
  const links = getLinks(context.db, artifact.id);
  return {
    id: artifact.id,
    title: artifact.title,
    intent: artifact.intent,
    request: artifact.request,
    lifecycle: artifact.lifecycle,
    finalized_at: artifact.finalized_at,
    evidence_run_id: artifact.evidence_run_id,
    generator: JSON.parse(artifact.generator_json) as unknown,
    content_hash: artifact.content_hash,
    limitations: artifact.limitations_json === null ? [] : (JSON.parse(artifact.limitations_json) as string[]),
    citations: getCitations(context.db, artifact.id).map((row) => ({
      handle: row.handle,
      ref: formatSourceRef(row.source_id, row.version),
      start: row.start_offset,
      end: row.end_offset,
    })),
    lineage: {
      derived_from: links
        .filter((l) => l.child_id === artifact.id && l.kind === "derived_from")
        .map((l) => l.parent_id),
      supersedes: links.filter((l) => l.child_id === artifact.id && l.kind === "supersedes").map((l) => l.parent_id),
      derivatives: links.filter((l) => l.parent_id === artifact.id && l.kind === "derived_from").map((l) => l.child_id),
      superseded_by: links.filter((l) => l.parent_id === artifact.id && l.kind === "supersedes").map((l) => l.child_id),
    },
    freshness: signals,
    notices: signals.map(describeSignal).map((notice) => notice.text),
    ...(options.includeContent === false ? {} : { markdown: artifact.content_markdown }),
    path: existsSync(artifactIndexPath(context, artifact.id)) ? artifactIndexPath(context, artifact.id) : null,
  };
}

export function listArtifacts(context: AppContext, options: { all?: boolean; limit?: number; cursor?: string } = {}) {
  const limit = options.limit ?? 50;
  const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
    throw new MiosotisError("validation", "Invalid limit or cursor");
  }
  const where = options.all ? "lifecycle <> 'purged'" : "lifecycle = 'active'";
  const total = context.db.get<{ n: number }>(`SELECT count(*) AS n FROM artifacts WHERE ${where}`)?.n ?? 0;
  const rows = context.db.all<ArtifactRow>(
    `SELECT * FROM artifacts WHERE ${where} ORDER BY finalized_at DESC, id DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return {
    total,
    next_cursor: offset + rows.length < total ? String(offset + rows.length) : null,
    artifacts: rows.map((row) => ({
      id: row.id,
      title: row.title,
      intent: row.intent,
      lifecycle: row.lifecycle,
      finalized_at: row.finalized_at,
      notices: freshness(context, row).length,
    })),
  };
}

/** Evidence actually cited by an artifact, with each source's present state. */
export function artifactSources(context: AppContext, id: string) {
  const artifact = requireArtifact(context, id);
  const citations = getCitations(context.db, artifact.id);
  return {
    id: artifact.id,
    evidence_run_id: artifact.evidence_run_id,
    cited: citations.map((row) => {
      const source = getSource(context.db, row.source_id);
      return {
        handle: row.handle,
        ref: formatSourceRef(row.source_id, row.version),
        start: row.start_offset,
        end: row.end_offset,
        current_version: source?.current_version ?? null,
        retention: source?.retention ?? null,
        inclusion: source?.inclusion ?? null,
      };
    }),
    retrieved_but_uncited: getEvidenceItems(context.db, artifact.evidence_run_id)
      .filter((item) => !citations.some((row) => row.handle === item.handle))
      .map((item) => ({ handle: item.handle, ref: formatSourceRef(item.source_id, item.version) })),
  };
}

function artifactDir(context: AppContext, id: string): string {
  return containedPath(context.config.library.artifactsDir, id);
}

function artifactIndexPath(context: AppContext, id: string): string {
  return join(artifactDir(context, id), "index.html");
}

function sourcePagePath(ref: string): string {
  return `sources/${ref}.html`;
}

/**
 * Writes the viewable folder: the stored body wrapped with a fresh status banner, plus one page per
 * cited source revision. The stored artifact content is read, never regenerated.
 */
export function materializeArtifact(context: AppContext, id: string): { path: string; notices: string[] } {
  const artifact = requireArtifact(context, id);
  if (artifact.rendered_html === null) {
    throw new MiosotisError("validation", `${artifact.id} was purged`);
  }
  const directory = artifactDir(context, artifact.id);
  ensureDir(directory);
  const notices = freshness(context, artifact).map(describeSignal);
  writeFileAtomic(
    join(directory, "index.html"),
    htmlDocument({
      title: artifact.title ?? artifact.id,
      body: `${statusBanner(notices, isoNow(context))}\n${artifact.rendered_html}`,
    }),
  );
  const citations = getCitations(context.db, artifact.id);
  const byRevision = new Map<string, typeof citations>();
  for (const citation of citations) {
    const ref = formatSourceRef(citation.source_id, citation.version);
    byRevision.set(ref, [...(byRevision.get(ref) ?? []), citation]);
  }
  const sourcesDir = containedPath(directory, "sources");
  ensureDir(sourcesDir);
  for (const [ref, group] of byRevision) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }
    const version = getSourceVersion(context.db, first.source_id, first.version);
    const source = getSource(context.db, first.source_id);
    writeFileAtomic(
      containedPath(sourcesDir, `${ref}.html`),
      sourcePage({
        ref,
        origin: source?.origin ?? "unknown",
        receivedAt: version?.received_at ?? "",
        text: version?.content_text ?? null,
        spans: group.map((citation) => ({
          handle: citation.handle,
          start: citation.start_offset,
          end: citation.end_offset,
        })),
        backLink: "../index.html",
      }),
    );
  }
  return { path: join(directory, "index.html"), notices: notices.map((notice) => notice.text) };
}

export function openInBrowser(path: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", path]]
        : ["xdg-open", [path]];
  const child = spawn(command, args as string[], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export function exportArtifact(
  context: AppContext,
  id: string,
  format: "md" | "html" | "json",
): { content: string; filename: string } {
  const artifact = requireArtifact(context, id);
  if (artifact.content_markdown === null || artifact.rendered_html === null) {
    throw new MiosotisError("validation", `${artifact.id} was purged`);
  }
  if (format === "md") {
    return { content: artifact.content_markdown, filename: `${artifact.id}.md` };
  }
  if (format === "html") {
    return {
      content: htmlDocument({ title: artifact.title ?? artifact.id, body: artifact.rendered_html }),
      filename: `${artifact.id}.html`,
    };
  }
  return {
    content: `${JSON.stringify(artifactView(context, artifact.id), null, 2)}\n`,
    filename: `${artifact.id}.json`,
  };
}

export function trashArtifact(context: AppContext, id: string, options: { confirm: boolean }) {
  const artifact = requireArtifact(context, id);
  if (!options.confirm) {
    throw new MiosotisError(
      "confirmation_required",
      `Trashing ${artifact.id} needs --confirm. Its Sources are not affected.`,
      {
        artifact_id: artifact.id,
      },
    );
  }
  if (artifact.lifecycle !== "active") {
    return { id: artifact.id, lifecycle: artifact.lifecycle, changed: false };
  }
  const at = isoNow(context);
  context.db.transaction(() => {
    context.db.run("UPDATE artifacts SET lifecycle = 'trashed', lifecycle_changed_at = ? WHERE id = ?", [
      at,
      artifact.id,
    ]);
    recordAudit(context.db, { at, actor: "user", operation: "artifact.trash", subjectIds: [artifact.id] });
  });
  return { id: artifact.id, lifecycle: "trashed", changed: true, sources_affected: 0 };
}
