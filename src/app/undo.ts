import { MiosotisError } from "../domain/errors.js";
import { formatSourceRef } from "../domain/ids.js";
import { payloadsFor } from "../infra/db/repos/files.js";
import type { SourceRow } from "../infra/db/repos/sources.js";
import type { AppContext } from "./context.js";
import { changeSourcePolicy } from "./governance.js";

const PREVIEW = 80;

function lastCapture(context: AppContext) {
  const operation = context.db.get<{ id: string; created_at: string }>(
    "SELECT id, created_at FROM operations WHERE kind = 'capture' ORDER BY created_at DESC, id DESC LIMIT 1",
  );
  if (operation === undefined) {
    throw new MiosotisError("not_found", "Nothing to undo: no captures yet");
  }
  const sources = context.db.all<SourceRow & { content_text: string | null }>(
    `SELECT s.*, v.content_text FROM sources s
     JOIN source_versions v ON v.source_id = s.id AND v.version = s.current_version
     WHERE s.capture_op_id = ? ORDER BY s.id`,
    [operation.id],
  );
  return {
    operation_id: operation.id,
    captured_at: operation.created_at,
    sources: sources.map((source) => ({
      id: source.id,
      ref: formatSourceRef(source.id, source.current_version),
      kind: source.kind,
      retention: source.retention,
      preview:
        source.kind === "file"
          ? (payloadsFor(context.db, source.id, source.current_version)[0]?.filename ?? "file")
          : (source.content_text ?? "").slice(0, PREVIEW),
    })),
  };
}

/**
 * Takes back the most recent capture (the comment and any files saved with it) by moving it to the
 * trash. Reversible with `source restore`. Only the latest capture is eligible; older ones are
 * trashed by ID. Without `confirm` it only describes what would happen.
 */
export function undoLastCapture(context: AppContext, options: { confirm: boolean }) {
  const target = lastCapture(context);
  const retained = target.sources.filter((source) => source.retention === "retained");
  if (retained.length === 0) {
    return {
      ...target,
      changed: false,
      note: "The last capture is already undone. Use `source restore <S-id>` to bring it back.",
    };
  }
  if (!options.confirm) {
    throw new MiosotisError(
      "confirmation_required",
      `Undo would move the last capture (${target.captured_at}) to the trash: ${retained.map((source) => `${source.ref} "${source.preview}"`).join("; ")}. Re-run with --confirm.`,
      { ...target },
    );
  }
  context.db.transaction(() => {
    for (const source of retained) {
      changeSourcePolicy(context, source.id, "trash", { confirm: true, reason: "undo last capture" });
    }
  });
  return {
    ...lastCapture(context),
    changed: true,
    note: "Moved to the trash. Restore any of them with `source restore <S-id>`.",
  };
}
