import type { Actor } from "../../../domain/source.js";
import type { Database } from "../database.js";

/** Records who changed what. Never store source content here. */
export function recordAudit(
  db: Database,
  event: { at: string; actor: Actor; operation: string; subjectIds: string[]; detail?: Record<string, unknown> },
): void {
  db.run("INSERT INTO audit_events (at, actor, operation, subject_ids, detail_json) VALUES (?, ?, ?, ?, ?)", [
    event.at,
    event.actor,
    event.operation,
    JSON.stringify(event.subjectIds),
    event.detail === undefined ? null : JSON.stringify(event.detail),
  ]);
}
