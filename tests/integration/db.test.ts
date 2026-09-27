import { afterEach, describe, expect, it } from "vitest";
import { capture } from "../../src/app/capture.js";
import { initLibrary } from "../../src/app/init.js";
import { MiosotisError } from "../../src/domain/errors.js";
import { latestSchemaVersion, migrate, schemaVersion } from "../../src/infra/db/migrate.js";
import { createTestLibrary, type TestLibrary } from "../helpers/library.js";

let library: TestLibrary;

afterEach(() => library?.cleanup());

describe("database integrity", () => {
  it("enforces foreign keys and the defensive flag on every connection", () => {
    library = createTestLibrary();
    expect(library.context.db.pragma("foreign_keys")).toBe(1);
    expect(library.context.db.pragma("journal_mode")).toBe("wal");
    expect(schemaVersion(library.context.db)).toBe(latestSchemaVersion());
  });

  it("rolls back a transaction whose deferred foreign key fails at COMMIT", () => {
    library = createTestLibrary();
    const { db } = library.context;
    expect(() =>
      db.transaction(() => {
        db.run(
          "INSERT INTO operations (id, kind, request_digest, receipt_json, created_at) VALUES ('O-X', 'capture', 'd', '{}', 't')",
        );
        db.run(
          `INSERT INTO sources (id, kind, origin, capture_op_id, current_version, created_seq, changed_seq, created_at, updated_at)
           VALUES ('S-ORPHAN', 'text', 'user', 'O-X', 1, 1, 1, 't', 't')`,
        );
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(db.inTransaction).toBe(false);
    expect(db.get("SELECT * FROM sources WHERE id = 'S-ORPHAN'")).toBeUndefined();
    expect(db.get("SELECT * FROM operations WHERE id = 'O-X'")).toBeUndefined();
  });

  it("keeps source revisions append-only except for the purge transition", () => {
    library = createTestLibrary();
    const receipt = capture(library.context, { text: "original words" });
    const id = receipt.sources[0]?.id;
    const { db } = library.context;
    expect(() =>
      db.run("UPDATE source_versions SET content_text = 'rewritten' WHERE source_id = ?", [id ?? ""]),
    ).toThrow(/append-only/);
    expect(() => db.run("UPDATE source_versions SET timezone = 'UTC' WHERE source_id = ?", [id ?? ""])).toThrow(
      /append-only/,
    );
    db.run(
      "UPDATE source_versions SET content_text = NULL, content_digest = NULL, provenance_json = NULL, purged_at = 't' WHERE source_id = ?",
      [id ?? ""],
    );
    expect(
      db.get<{ content_text: string | null }>("SELECT content_text FROM source_versions WHERE source_id = ?", [
        id ?? "",
      ]),
    ).toEqual({
      content_text: null,
    });
  });

  it("migrates idempotently and refuses a newer schema", () => {
    library = createTestLibrary();
    const { db } = library.context;
    expect(migrate(db)).toBe(latestSchemaVersion());
    db.exec(`PRAGMA user_version = ${latestSchemaVersion() + 1}`);
    expect(() => migrate(db)).toThrow(MiosotisError);
    db.exec(`PRAGMA user_version = ${latestSchemaVersion()}`);
  });

  it("re-running init is safe and keeps the library", () => {
    library = createTestLibrary();
    capture(library.context, { text: "keep me" });
    const again = initLibrary({ env: library.env });
    expect(again.library_created).toBe(false);
    expect(again.config_created).toBe(false);
    expect(library.context.db.get<{ n: number }>("SELECT count(*) AS n FROM sources")?.n).toBe(1);
  });

  it("rejects init with a conflicting data dir", () => {
    library = createTestLibrary();
    expect(() => initLibrary({ env: library.env, dataDir: `${library.root}/elsewhere` })).toThrow(/different data_dir/);
  });
});
