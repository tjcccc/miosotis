import type { Database } from "../database.js";

/** Monotonic library change sequence, used as the freshness watermark. Call inside a transaction. */
export function nextChangeSeq(db: Database): number {
  const row = db.get<{ value: number }>(
    "UPDATE counters SET value = value + 1 WHERE name = 'change_seq' RETURNING value",
  );
  if (row === undefined) {
    throw new Error("change_seq counter is missing");
  }
  return row.value;
}

export function currentChangeSeq(db: Database): number {
  return db.get<{ value: number }>("SELECT value FROM counters WHERE name = 'change_seq'")?.value ?? 0;
}
