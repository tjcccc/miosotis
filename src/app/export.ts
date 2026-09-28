import { existsSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MiosotisError } from "../domain/errors.js";
import { formatSourceRef } from "../domain/ids.js";
import { getArtifact } from "../infra/db/repos/artifacts.js";
import { eventsOfSources } from "../infra/db/repos/events.js";
import { payloadsFor } from "../infra/db/repos/files.js";
import { projectsForSources } from "../infra/db/repos/projects.js";
import { currentEnrichments, getSource, getSourceVersion } from "../infra/db/repos/sources.js";
import { containedPath, ensureDir, writeFileAtomic } from "../infra/fs/files.js";
import { VERSION } from "../version.js";
import { artifactFiles } from "./artifacts.js";
import { safeFilename } from "./capture.js";
import { readableText } from "./content.js";
import { type AppContext, isoNow } from "./context.js";

export const EXPORT_SCHEMA = "miosotis.export.v1";

interface ExportedSource {
  id: string;
  kind: string;
  origin: string;
  created_at: string;
  retention: string;
  inclusion: string;
  projects: string[];
  /** Model-derived (enrichment); the original text is in `revisions`. */
  title: string | null;
  revisions: { version: number; received_at: string; path: string | null }[];
  files: { filename: string; mime: string; sha256: string; path: string }[];
  extracted_text: string | null;
}

interface ExportedArtifact {
  id: string;
  title: string | null;
  intent: string;
  format: string;
  finalized_at: string;
  lifecycle: string;
  content: string;
  page: string | null;
  files: { filename: string; role: string; path: string }[];
}

/** A unique, safe file name inside one folder: "0-name", "1-name", … keeps originals apart. */
function fileName(ordinal: number, raw: string): string {
  return `${ordinal}-${safeFilename(raw)}`;
}

/**
 * Writes the whole library as plain files, so the data can always be taken out without miosotis:
 * every revision's text verbatim, original files, extracted text, artifacts, and an index. No model
 * call. Permanently deleted items have nothing left to export; trashed ones only with `includeTrash`.
 * The folder is written as `.partial` and renamed when complete.
 */
export function exportLibrary(context: AppContext, options: { output: string; includeTrash?: boolean }) {
  const root = resolve(options.output);
  const stamp = isoNow(context).replace(/[:.]/g, "-");
  const finalDir = join(root, `miosotis-export-${stamp}`);
  if (existsSync(finalDir)) {
    throw new MiosotisError("conflict", `${finalDir} already exists`);
  }
  const partial = `${finalDir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  ensureDir(partial);
  try {
    const retention = options.includeTrash === true ? "retention IN ('retained', 'trashed')" : "retention = 'retained'";
    const ids = context.db
      .all<{ id: string }>(`SELECT id FROM sources WHERE ${retention} ORDER BY created_at, id`)
      .map((row) => row.id);
    const enrichments = currentEnrichments(context.db, ids);
    const projects = projectsForSources(context.db, ids);
    const sources = ids.map((id) => exportSource(context, partial, id, enrichments, projects));
    const lifecycle = options.includeTrash === true ? "lifecycle IN ('active', 'trashed')" : "lifecycle = 'active'";
    const artifacts = context.db
      .all<{ id: string }>(`SELECT id FROM artifacts WHERE ${lifecycle} ORDER BY finalized_at, id`)
      .map((row) => exportArtifact(context, partial, row.id));
    const events = eventsOfSources(context.db, ids).map((event) => ({
      id: event.id,
      source_id: event.source_id,
      title: event.title,
      date: event.start_date,
      time: event.start_time,
      part_of_day: event.part_of_day,
      end_date: event.end_date,
      end_time: event.end_time,
      timezone: event.timezone,
      location: event.location,
      repeat: event.repeat_json === null ? null : (JSON.parse(event.repeat_json) as unknown),
    }));
    const index = {
      schema: EXPORT_SCHEMA,
      created_at: isoNow(context),
      miosotis_version: VERSION,
      includes_trash: options.includeTrash === true,
      sources,
      artifacts,
      /** Schedule entries the AI read from the Sources (may include cancelled or rescheduled ones). */
      events,
    };
    writeFileAtomic(join(partial, "index.json"), `${JSON.stringify(index, null, 2)}\n`, 0o600);
    writeFileAtomic(join(partial, "README.md"), readme(index), 0o600);
    renameSync(partial, finalDir);
    return { path: finalDir, sources: sources.length, artifacts: artifacts.length };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

function exportSource(
  context: AppContext,
  root: string,
  id: string,
  enrichments: ReturnType<typeof currentEnrichments>,
  projects: ReturnType<typeof projectsForSources>,
): ExportedSource {
  const source = getSource(context.db, id);
  if (source === undefined) {
    throw new MiosotisError("internal", `Source ${id} disappeared during export`);
  }
  const folder = `sources/${id}`;
  ensureDir(containedPath(root, "sources", id));
  const revisions: ExportedSource["revisions"] = [];
  for (let version = 1; version <= source.current_version; version += 1) {
    const row = getSourceVersion(context.db, id, version);
    if (row === undefined) {
      continue;
    }
    let path: string | null = null;
    if (row.content_text !== null && row.content_text.length > 0) {
      path = `${folder}/v${version}.txt`;
      writeFileAtomic(containedPath(root, "sources", id, `v${version}.txt`), row.content_text, 0o600);
    }
    revisions.push({ version, received_at: row.received_at, path });
  }
  const payloads = payloadsFor(context.db, id, source.current_version);
  if (payloads.length > 0) {
    ensureDir(containedPath(root, "sources", id, "files"));
  }
  const files = payloads.map((payload) => {
    const name = fileName(payload.ordinal, payload.filename ?? "file");
    writeFileAtomic(containedPath(root, "sources", id, "files", name), context.blobs.read(payload.blob_sha256), 0o600);
    return {
      filename: payload.filename ?? "file",
      mime: payload.mime,
      sha256: payload.blob_sha256,
      path: `${folder}/files/${name}`,
    };
  });
  const readable = readableText(context, id, source.current_version);
  let extracted: string | null = null;
  if (readable.origin === "extracted" && readable.text.length > 0) {
    extracted = `${folder}/extracted.txt`;
    writeFileAtomic(containedPath(root, "sources", id, "extracted.txt"), readable.text, 0o600);
  }
  const enrichment = enrichments.get(id)?.content_json;
  return {
    id,
    kind: source.kind,
    origin: source.origin,
    created_at: source.created_at,
    retention: source.retention,
    inclusion: source.inclusion,
    projects: projects.filter((row) => row.source_id === id).map((row) => row.slug),
    title: enrichment == null ? null : ((JSON.parse(enrichment) as { title?: string }).title ?? null),
    revisions,
    files,
    extracted_text: extracted,
  };
}

function exportArtifact(context: AppContext, root: string, id: string): ExportedArtifact {
  const artifact = getArtifact(context.db, id);
  if (artifact === undefined || artifact.content_markdown === null) {
    throw new MiosotisError("internal", `Artifact ${id} disappeared during export`);
  }
  const folder = `artifacts/${id}`;
  ensureDir(containedPath(root, "artifacts", id));
  writeFileAtomic(containedPath(root, "artifacts", id, "content.md"), artifact.content_markdown, 0o600);
  let page: string | null = null;
  if (artifact.payload_html !== null) {
    // Stored as text: the page is untrusted code, and opening it directly would run it unsandboxed.
    page = `${folder}/page.html.txt`;
    writeFileAtomic(containedPath(root, "artifacts", id, "page.html.txt"), artifact.payload_html, 0o600);
  }
  const stored = artifactFiles(context, id);
  if (stored.length > 0) {
    ensureDir(containedPath(root, "artifacts", id, "files"));
  }
  const files = stored.map((file) => {
    const name = fileName(file.ordinal, file.filename);
    writeFileAtomic(containedPath(root, "artifacts", id, "files", name), context.blobs.read(file.blob_sha256), 0o600);
    return { filename: file.filename, role: file.role, path: `${folder}/files/${name}` };
  });
  return {
    id,
    title: artifact.title,
    intent: artifact.intent,
    format: artifact.format,
    finalized_at: artifact.finalized_at,
    lifecycle: artifact.lifecycle,
    content: `${folder}/content.md`,
    page,
    files,
  };
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function readme(index: { created_at: string; sources: ExportedSource[]; artifacts: ExportedArtifact[] }): string {
  const sources = index.sources.map((source) => {
    const latest = source.revisions.at(-1);
    const where = source.kind === "file" ? (source.files[0]?.path ?? "") : (latest?.path ?? "");
    const ref = latest === undefined ? source.id : formatSourceRef(source.id, latest.version);
    return `| ${ref} | ${source.created_at} | ${source.kind} | ${cell(source.title ?? "")} | ${where} |`;
  });
  const artifacts = index.artifacts.map(
    (artifact) => `| ${artifact.id} | ${artifact.finalized_at} | ${cell(artifact.title ?? "")} | ${artifact.content} |`,
  );
  return [
    "# miosotis export",
    "",
    `Exported ${index.created_at}. Everything here is plain files; no miosotis is needed to read it.`,
    "",
    "- `sources/<S-id>/v<N>.txt`: each revision's text, exactly as saved.",
    "- `sources/<S-id>/files/`: original files; `extracted.txt`: text extracted from them.",
    "- `artifacts/<A-id>/content.md`: each report as frozen; `files/`: its output files.",
    "  `page.html.txt` is an interactive page stored as text: rename it to `.html` only if you trust it.",
    "- `index.json`: everything below, with projects, dates, and hashes. Titles are AI-made summaries.",
    "",
    "## Sources",
    "",
    "| Source | Saved | Kind | Title (AI) | File |",
    "|---|---|---|---|---|",
    ...sources,
    "",
    "## Artifacts",
    "",
    "| Artifact | Made | Title | File |",
    "|---|---|---|---|",
    ...artifacts,
    "",
  ].join("\n");
}
