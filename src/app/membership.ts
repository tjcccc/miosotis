import { MiosotisError } from "../domain/errors.js";
import { parseSourceRef } from "../domain/ids.js";
import type { Actor } from "../domain/source.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { nextChangeSeq } from "../infra/db/repos/counters.js";
import { assignMembership, removeMembership, setExclusion } from "../infra/db/repos/projects.js";
import { type AppContext, isoNow } from "./context.js";
import { ensureProject, resolveProject } from "./projects.js";
import { requireSource } from "./sources.js";

function assignableSource(context: AppContext, reference: string) {
  const { id } = parseSourceRef(reference);
  const source = requireSource(context, id);
  if (source.retention !== "retained") {
    throw new MiosotisError("validation", `${id} is ${source.retention}; restore it before changing its projects`, {
      source_id: id,
      retention: source.retention,
    });
  }
  return source;
}

function uniqueRefs(references: string[]): string[] {
  if (references.length === 0) {
    throw new MiosotisError("usage", "Name at least one Source");
  }
  return [...new Set(references.map((reference) => parseSourceRef(reference).id))];
}

/**
 * Explicit, user-assigned membership for existing Sources. Same meaning as `save --project`: it creates
 * a named project that does not exist yet, upgrades inferred membership, and clears a prior exclusion.
 * It never touches source text or revisions. All-or-nothing across the given Sources.
 */
export function assignSources(
  context: AppContext,
  references: string[],
  projectReference: string,
  actor: Actor = "user",
) {
  const ids = uniqueRefs(references);
  return context.db.transaction(() => {
    const sources = ids.map((id) => assignableSource(context, id));
    const { project, created } = ensureProject(context, projectReference);
    const at = isoNow(context);
    const results = sources.map((source) => {
      const change = assignMembership(context.db, {
        sourceId: source.id,
        projectId: project.id,
        assignment: "explicit",
        actor,
        derivationId: null,
        at,
      });
      if (change === "assigned") {
        // Newly in scope: project artifacts may now be missing material.
        context.db.run("UPDATE sources SET changed_seq = ?, updated_at = ? WHERE id = ?", [
          nextChangeSeq(context.db),
          at,
          source.id,
        ]);
      }
      return { source_id: source.id, change: change === "unchanged" ? "already_explicit" : change };
    });
    recordAudit(context.db, {
      at,
      actor,
      operation: "source.assign",
      subjectIds: [project.id, ...ids],
      detail: { changes: results.map((result) => result.change) },
    });
    return { project: { id: project.id, slug: project.slug, name: project.name, created }, results };
  });
}

/**
 * Removes membership (explicit or inferred) and records an explicit exclusion so later AI suggestions
 * cannot re-add it. Reversible with `assignSources`. Unknown projects are an error, never created.
 */
export function unassignSources(
  context: AppContext,
  references: string[],
  projectReference: string,
  actor: Actor = "user",
) {
  const ids = uniqueRefs(references);
  return context.db.transaction(() => {
    const sources = ids.map((id) => assignableSource(context, id));
    const project = resolveProject(context, projectReference);
    const at = isoNow(context);
    const results = sources.map((source) => {
      const removed = removeMembership(context.db, source.id, project.id);
      setExclusion(context.db, { sourceId: source.id, projectId: project.id, actor, at });
      return {
        source_id: source.id,
        change: removed === "explicit" ? "removed" : removed === "inferred" ? "removed_inferred" : "not_member",
      };
    });
    recordAudit(context.db, {
      at,
      actor,
      operation: "source.unassign",
      subjectIds: [project.id, ...ids],
      detail: { changes: results.map((result) => result.change) },
    });
    return { project: { id: project.id, slug: project.slug, name: project.name }, results };
  });
}
