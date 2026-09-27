# Backup, restore, deletion, and retention

## Backup is not sync

- Keep the **live** library (`data_dir`) on a local disk. Do not put it in a live-synced folder (OneDrive, iCloud, Dropbox): WAL mode involves several files that sync tools can split or conflict.
- Put **backups** in a cloud folder with `[backup].dir` or `--output`.

## What a backup contains

- `library.sqlite3`: a consistent online snapshot made with SQLite's backup API, converted to a single self-contained file (rollback-journal mode).
- `manifest.json`: schema, creation time, miosotis version, library ID, schema version, SHA-256 and size of the database, and counts.
- `blobs/sha256/…`: every stored file the database references (attachments, extracted text), copied and hash-verified. The manifest records the blob count and bytes.
- **Excluded:** rendered `artifacts/` folders (a cache rebuilt by `artifact open`), `config.toml`, and any credentials.

## How a backup is made

1. The snapshot is written and checked (`integrity_check`) in `data_dir/staging/`.
2. The manifest is written last.
3. The files are copied to `<dest>/miosotis-backup-<time>.partial/`, verified again, and only then renamed to the final name.

An interrupted backup therefore never looks complete: it has no manifest or it keeps the `.partial` suffix. `backup verify` and `restore` reject it.

## Restore

- `miosotis restore <backup> --data-dir <new empty folder>`
- It refuses non-empty targets and the live library. It verifies the database hash and integrity, and verifies every blob's hash while copying (a mismatch aborts). It then applies pending migrations and switches the copy to WAL.
- Afterwards, point `data_dir` (or `MIOSOTIS_HOME`) at the restored folder.

## Deletion levels (v0.1)

| Action | Effect | Reversible |
|---|---|---|
| `source ignore --reason` | Leaves default search, lists, counts, and evidence | `source include` |
| `source trash --confirm` | Retention `trashed`; removed from the search index | `source restore` |
| `artifact trash --confirm` | Hidden from `artifact list`; its sources are unaffected | not yet exposed (the row is kept) |
| correction | New revision; old revisions stay for provenance | n/a |

- Permanent **purge** arrives in v0.3. The schema already supports it: content is removed in place, and only non-content tombstones remain.
- Removing a source will not automatically remove quotations already embedded in artifacts. v0.3 will present a reviewable cleanup plan for dependent excerpts, evidence, and artifacts.
- Backups, exports, and host transcripts are separate copies. Deleting live content never deletes copies already made elsewhere.
