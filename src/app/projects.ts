import { MiosotisError } from "../domain/errors.js";
import { isId, newId } from "../domain/ids.js";
import { isValidSlug, normalizeSlug } from "../domain/text.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import {
  findProjectById,
  findProjectBySlug,
  insertProject,
  listProjects,
  type ProjectRow,
} from "../infra/db/repos/projects.js";
import { type AppContext, isoNow } from "./context.js";

export interface ProjectView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  lifecycle: string;
  created_at: string;
}

export function toProjectView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    lifecycle: row.lifecycle,
    created_at: row.created_at,
  };
}

export function toSlug(input: string): string {
  const slug = normalizeSlug(input);
  if (!isValidSlug(slug)) {
    throw new MiosotisError("validation", `Not a usable project name: ${JSON.stringify(input)}`);
  }
  return slug;
}

/** Resolves a project by ID or slug; unknown projects are an error (only saving may create one). */
export function resolveProject(context: AppContext, reference: string): ProjectRow {
  const trimmed = reference.trim();
  const row = isId("project", trimmed.toUpperCase())
    ? findProjectById(context.db, trimmed.toUpperCase())
    : findProjectBySlug(context.db, toSlug(trimmed));
  if (row === undefined) {
    throw new MiosotisError("not_found", `No project named ${JSON.stringify(reference)}`, { project: reference });
  }
  return row;
}

/** Finds or creates the project the user explicitly named. Call inside a transaction. */
export function ensureProject(context: AppContext, reference: string): { project: ProjectRow; created: boolean } {
  const trimmed = reference.trim();
  if (isId("project", trimmed.toUpperCase())) {
    return { project: resolveProject(context, trimmed), created: false };
  }
  const slug = toSlug(trimmed);
  const existing = findProjectBySlug(context.db, slug);
  if (existing !== undefined) {
    return { project: existing, created: false };
  }
  return { project: createProjectRow(context, slug, trimmed, null), created: true };
}

export function createProject(
  context: AppContext,
  input: { slug: string; name?: string | undefined; description?: string | undefined },
): ProjectView {
  return context.db.transaction(() => {
    const slug = toSlug(input.slug);
    if (findProjectBySlug(context.db, slug) !== undefined) {
      throw new MiosotisError("conflict", `Project ${slug} already exists`, { slug });
    }
    return toProjectView(createProjectRow(context, slug, input.name ?? input.slug, input.description ?? null));
  });
}

function createProjectRow(context: AppContext, slug: string, name: string, description: string | null): ProjectRow {
  const at = isoNow(context);
  const row: ProjectRow = {
    id: newId("project", context.now().getTime()),
    slug,
    name: name.trim().slice(0, 200) || slug,
    description,
    lifecycle: "active",
    created_at: at,
    updated_at: at,
  };
  insertProject(context.db, row);
  recordAudit(context.db, { at, actor: "user", operation: "project.create", subjectIds: [row.id] });
  return row;
}

export function listProjectViews(context: AppContext): (ProjectView & { source_count: number })[] {
  return listProjects(context.db).map((row) => ({ ...toProjectView(row), source_count: row.source_count }));
}
