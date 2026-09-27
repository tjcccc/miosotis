import type { Database } from "../database.js";

export type OperationKind = "capture" | "enrich" | "artifact" | "correct";

export interface OperationRow {
  id: string;
  kind: OperationKind;
  idempotency_key: string | null;
  request_digest: string;
  receipt_json: string;
  created_at: string;
}

export function findOperation(db: Database, kind: OperationKind, key: string): OperationRow | undefined {
  return db.get<OperationRow>("SELECT * FROM operations WHERE kind = ? AND idempotency_key = ?", [kind, key]);
}

export function insertOperation(db: Database, row: OperationRow): void {
  db.run(
    "INSERT INTO operations (id, kind, idempotency_key, request_digest, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [row.id, row.kind, row.idempotency_key, row.request_digest, row.receipt_json, row.created_at],
  );
}

export function setOperationReceipt(db: Database, id: string, receiptJson: string): void {
  db.run("UPDATE operations SET receipt_json = ? WHERE id = ?", [receiptJson, id]);
}
