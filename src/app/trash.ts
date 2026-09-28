import { MiosotisError } from "../domain/errors.js";
import { assertId, isId, newId } from "../domain/ids.js";
import { getArtifact } from "../infra/db/repos/artifacts.js";
import { payloadsFor } from "../infra/db/repos/files.js";
import { artifactsCiting, datasetsUsingSources } from "../infra/db/repos/purge.js";
import { currentEnrichments, getSource, getSourceVersion } from "../infra/db/repos/sources.js";
import {
  artifactsRemovedWith,
  removalOf,
  setRemovedWith,
  trashedArtifacts,
  trashedSources,
} from "../infra/db/repos/trash.js";
import { restoreArtifact, trashArtifact } from "./artifacts.js";
import type { AppContext } from "./context.js";
import { changeSourcePolicy } from "./governance.js";
import { type PurgeReceipt, purge } from "./purge.js";
import { titleOf } from "./sources.js";

const PREVIEW = 80;

interface Items {
  sources: string[];
  artifacts: string[];
}

/** Splits IDs into Sources and artifacts; anything else (revisions, paths, other kinds) is refused. */
function parseItems(ids: string[], verb: string): Items {
  const items: Items = { sources: [], artifacts: [] };
  for (const raw of ids) {
    if (isId("source", raw)) {
      items.sources.push(assertId("source", raw));
    } else if (isId("artifact", raw)) {
      items.artifacts.push(assertId("artifact", raw));
    } else if (verb === "restore" && !/^[A-Z]-/i.test(raw)) {
      throw new MiosotisError(
        "usage",
        `\`miosotis restore\` brings items back from the trash by ID. To restore a backup folder, use \`miosotis backup restore ${raw} --data-dir <new folder>\`.`,
      );
    } else {
      throw new MiosotisError("validation", `Only whole Sources (S-…) and artifacts (A-…) can be ${verb}d, not ${raw}`);
    }
  }
  return { sources: [...new Set(items.sources)], artifacts: [...new Set(items.artifacts)] };
}

/** A recognizable label: the enrichment title, else the filename or the start of the text. */
function sourceLabel(context: AppContext, id: string): string {
  const title = titleOf(currentEnrichments(context.db, [id]).get(id)?.content_json ?? null);
  if (title !== null) {
    return title;
  }
  const source = getSource(context.db, id);
  if (source === undefined) {
    return "";
  }
  if (source.kind === "file") {
    return payloadsFor(context.db, id, source.current_version)[0]?.filename ?? "file";
  }
  return (getSourceVersion(context.db, id, source.current_version)?.content_text ?? "").slice(0, PREVIEW);
}

function requireItems(context: AppContext, items: Items): void {
  for (const id of items.sources) {
    const source = getSource(context.db, id);
    if (source === undefined) {
      throw new MiosotisError("not_found", `No source ${id}`);
    }
    if (source.retention === "purged") {
      throw new MiosotisError("validation", `${id} was deleted permanently`);
    }
  }
  for (const id of items.artifacts) {
    const artifact = getArtifact(context.db, id);
    if (artifact === undefined) {
      throw new MiosotisError("not_found", `No artifact ${id}`);
    }
    if (artifact.lifecycle === "purged") {
      throw new MiosotisError("validation", `${id} was deleted permanently`);
    }
  }
}

/** Active artifacts outside the selection that cite these Sources (directly or through a dataset). */
function citingArtifacts(context: AppContext, items: Items): { id: string; title: string | null }[] {
  const datasets = datasetsUsingSources(context.db, items.sources);
  return artifactsCiting(context.db, items.sources, datasets)
    .filter((row) => !items.artifacts.includes(row.id) && getArtifact(context.db, row.id)?.lifecycle === "active")
    .map((row) => ({ id: row.id, title: getArtifact(context.db, row.id)?.title ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Moves Sources and artifacts to the trash (reversible with `restore`). Without `confirm` it only
 * describes what would move, including the artifacts that cite the Sources. Those stay (with a notice)
 * unless `withArtifacts` moves them to the trash too, together with the Source.
 */
export function removeItems(
  context: AppContext,
  ids: string[],
  options: { withArtifacts?: boolean; confirm?: boolean } = {},
) {
  if (ids.length === 0) {
    throw new MiosotisError("usage", "Name the Sources (S-…) and/or artifacts (A-…) to remove");
  }
  const items = parseItems(ids, "remove");
  requireItems(context, items);
  const citing = citingArtifacts(context, items);
  const withArtifacts = options.withArtifacts === true;
  const preview = {
    sources: items.sources.map((id) => ({
      id,
      label: sourceLabel(context, id),
      state: getSource(context.db, id)?.retention,
    })),
    artifacts: items.artifacts.map((id) => ({
      id,
      label: getArtifact(context.db, id)?.title ?? "",
      state: getArtifact(context.db, id)?.lifecycle,
    })),
    citing_artifacts: citing.map((row) => ({ ...row, action: withArtifacts ? "remove" : "keep" })),
  };
  if (options.confirm !== true) {
    throw new MiosotisError(
      "confirmation_required",
      [
        "Move to the trash (reversible with `miosotis restore`):",
        ...preview.sources.map((row) => `- ${row.id}  ${row.label}`),
        ...preview.artifacts.map((row) => `- ${row.id}  ${row.label}`),
        ...(citing.length === 0
          ? []
          : withArtifacts
            ? [`Also moving ${citing.length} artifact(s) that cite them: ${citing.map((row) => row.id).join(", ")}.`]
            : [
                `${citing.length} artifact(s) cite them and stay, showing a notice: ${citing.map((row) => row.id).join(", ")}. Add --with-artifacts to remove them too.`,
              ]),
        `To proceed: miosotis remove ${ids.join(" ")}${withArtifacts ? " --with-artifacts" : ""} --confirm`,
      ].join("\n"),
      preview,
    );
  }
  const removal = newId("operation", context.now().getTime());
  const artifacts = [...items.artifacts, ...(withArtifacts ? citing.map((row) => row.id) : [])];
  return context.db.transaction(() => {
    const moved: Items = { sources: [], artifacts: [] };
    const already: string[] = [];
    for (const id of items.sources) {
      if (changeSourcePolicy(context, id, "trash", { confirm: true }).changed) {
        setRemovedWith(context.db, { sourceId: id }, removal);
        moved.sources.push(id);
      } else {
        already.push(id);
      }
    }
    for (const id of artifacts) {
      if (trashArtifact(context, id, { confirm: true }).changed) {
        setRemovedWith(context.db, { artifactId: id }, removal);
        moved.artifacts.push(id);
      } else {
        already.push(id);
      }
    }
    return {
      removed: moved,
      already_in_trash: already,
      kept_citing_artifacts: withArtifacts ? [] : citing.map((row) => row.id),
      note: "Moved to the trash. `miosotis restore <IDs>` brings items back; `miosotis trash empty` deletes them permanently.",
    };
  });
}

/** Everything in the trash, newest first, with what still cites each Source. */
export function trashList(context: AppContext) {
  const sources = trashedSources(context.db).map((row) => ({
    id: row.id,
    kind: row.kind,
    label: sourceLabel(context, row.id),
    trashed_at: row.trashed_at,
    cited_by: artifactsCiting(context.db, [row.id], datasetsUsingSources(context.db, [row.id]))
      .map((entry) => entry.id)
      .filter((id) => getArtifact(context.db, id)?.lifecycle !== "purged"),
  }));
  const artifacts = trashedArtifacts(context.db).map((row) => ({
    id: row.id,
    label: row.title ?? "",
    trashed_at: row.trashed_at,
  }));
  return { sources, artifacts, total: sources.length + artifacts.length };
}

/**
 * Brings items back from the trash. Restoring a Source also restores the artifacts that one `remove`
 * moved to the trash with it. With no IDs, everything in the trash comes back (needs `confirm`).
 */
export function restoreItems(context: AppContext, ids: string[], options: { confirm?: boolean } = {}) {
  let items: Items;
  if (ids.length === 0) {
    const listed = trashList(context);
    items = { sources: listed.sources.map((row) => row.id), artifacts: listed.artifacts.map((row) => row.id) };
    if (listed.total > 0 && options.confirm !== true) {
      throw new MiosotisError(
        "confirmation_required",
        `Restore everything in the trash (${listed.sources.length} Source(s), ${listed.artifacts.length} artifact(s))? Run \`miosotis restore --confirm\`.`,
        { trash: listed },
      );
    }
  } else {
    items = parseItems(ids, "restore");
    requireItems(context, items);
  }
  const removals = items.sources.flatMap((id) => removalOf(context.db, id) ?? []);
  const artifacts = [...new Set([...items.artifacts, ...artifactsRemovedWith(context.db, removals)])];
  return context.db.transaction(() => {
    const restored: Items = { sources: [], artifacts: [] };
    const notInTrash: string[] = [];
    for (const id of items.sources) {
      if (changeSourcePolicy(context, id, "restore").changed) {
        setRemovedWith(context.db, { sourceId: id }, null);
        restored.sources.push(id);
      } else {
        notInTrash.push(id);
      }
    }
    for (const id of artifacts) {
      if (restoreArtifact(context, id).changed) {
        setRemovedWith(context.db, { artifactId: id }, null);
        restored.artifacts.push(id);
      } else {
        notInTrash.push(id);
      }
    }
    return { restored, not_in_trash: notInTrash };
  });
}

/**
 * Permanently deletes trashed items: the given IDs, or everything in the trash. Always reviewed first
 * (a plan with an ID), then applied with `confirm` + that plan ID. Artifacts outside the selection that
 * cite the Sources are kept only with `keepArtifacts`.
 */
export function emptyTrash(
  context: AppContext,
  ids: string[],
  options: { keepArtifacts?: boolean; confirm?: boolean; plan?: string | undefined } = {},
): PurgeReceipt {
  let targets = ids;
  if (ids.length === 0) {
    const listed = trashList(context);
    targets = [...listed.sources.map((row) => row.id), ...listed.artifacts.map((row) => row.id)];
    if (targets.length === 0) {
      return {
        plan_id: "",
        purged: { sources: [], artifacts: [], datasets: [] },
        kept_artifacts: [],
        files_erased: 0,
        bytes_erased: 0,
        compacted: false,
        warnings: [],
        note: "The trash is empty.",
      };
    }
  } else {
    parseItems(ids, "delete");
  }
  return purge(context, targets, {
    keepCiting: options.keepArtifacts === true,
    confirm: options.confirm === true,
    plan: options.plan,
    proceed: `miosotis trash empty${ids.length === 0 ? "" : ` ${ids.join(" ")}`}`,
  });
}
