import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "../../src/infra/db/database.js";
import { latestSchemaVersion, loadMigrations, migrate, schemaVersion } from "../../src/infra/db/migrate.js";

let root: string;

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("schema upgrades", () => {
  it("upgrades a populated v1 library to the latest schema without touching content", () => {
    root = mkdtempSync(join(tmpdir(), "miosotis-migrate-"));
    const db = new Database(join(root, "library.sqlite3"), { create: true });
    try {
      expect(migrate(db, loadMigrations().slice(0, 1))).toBe(1);
      db.transaction(() => {
        db.run(
          "INSERT INTO operations (id, kind, request_digest, receipt_json, created_at) VALUES ('O-1', 'capture', 'd', '{}', 't')",
        );
        db.run(
          `INSERT INTO sources (id, kind, origin, capture_op_id, current_version, created_seq, changed_seq, created_at, updated_at)
           VALUES ('S-1', 'text', 'user', 'O-1', 1, 1, 1, 't', 't')`,
        );
        db.run(
          `INSERT INTO source_versions (source_id, version, reason, actor, content_text, content_digest, char_length, received_at, timezone)
           VALUES ('S-1', 1, 'capture', 'user', '原文 original', 'd', 11, 't', 'UTC')`,
        );
        db.run("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES ('P-1', 'p', 'p', 't', 't')");
      });
      expect(migrate(db)).toBe(latestSchemaVersion());
      expect(schemaVersion(db)).toBeGreaterThanOrEqual(2);
      expect(
        db.get<{ content_text: string }>("SELECT content_text FROM source_versions WHERE source_id = 'S-1'")
          ?.content_text,
      ).toBe("原文 original");
      db.run(
        "INSERT INTO source_project_exclusions (source_id, project_id, actor, created_at) VALUES ('S-1', 'P-1', 'user', 't')",
      );
      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
