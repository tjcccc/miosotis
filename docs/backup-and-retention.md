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

An interrupted backup therefore never looks complete: it has no manifest or it keeps the `.partial` suffix. `backup verify` and `backup restore` reject it.

## Restore

- `miosotis backup restore <backup> --data-dir <new empty folder>`
- It refuses non-empty targets and the live library. It verifies the database hash and integrity, and verifies every blob's hash while copying (a mismatch aborts). It then applies pending migrations and switches the copy to WAL.
- Afterwards, point `data_dir` (or `MIOSOTIS_HOME`) at the restored folder.

## Deletion levels

| Action | Effect | Reversible |
|---|---|---|
| `source ignore --reason` | Leaves default search, lists, counts, and evidence | `source include` |
| `remove <ids…> --confirm` (also `source trash`, `artifact trash`, `undo`) | Moves Sources/artifacts to the trash; trashed Sources leave the search index | `restore <ids…>` |
| `trash empty [ids…] --confirm --plan <id>` | Permanent: content, files, derived data, and search entries are removed; tombstones remain | no |
| correction | New revision; old revisions stay for provenance | n/a |

## Trash

- **Remove sees dependencies.** `remove` lists the artifacts that cite the Sources. They stay (showing "in the trash") unless `--with-artifacts` moves them to the trash too.
- **Restore mirrors remove.** Restoring a Source also brings back the artifacts removed together with it. `restore` with no IDs brings back everything, after `--confirm`.
- **`trash list`** shows what's in the trash, newest first, and what still cites each Source.
- A trashed Source keeps its content, so a report citing it can still show its source page.

## Emptying the trash (permanent deletion)

- **Only trashed items.** `trash empty` takes everything in the trash, or the given trashed IDs; anything else is refused ("remove it first").
- **Always a plan first.** Without `--confirm` it returns a plan and changes nothing. The plan lists:
  - the Sources (with titles and filenames, so they can be recognized), the artifacts, and the datasets calculated from the Sources
  - other artifacts that cite them, directly or through a dataset
  - items saved together with them that are *not* included
  - how many files will be erased, and how many are kept because another item shares the bytes
- **No silent cascade.** An artifact outside the selection that cites the Sources is never deleted by this. The user removes it and includes it, or keeps it with `--keep-artifacts`. A kept artifact's frozen text may still quote the deleted content; its page says the source was permanently deleted, and its source page shows nothing.
- **Applies exactly what was reviewed.** `--confirm --plan <id>` refuses if the library changed since the review (for example, a new artifact cited the Source).
- **What remains:** IDs, dates, sizes, and revision numbers, so references can explain themselves. No titles, text, filenames, or reasons.
- **Physically removed from the library:** the database is vacuumed and its write-ahead log truncated. Stored files are deleted, and rendered artifact folders are cleared (they rebuild on open).
- Backups, exports, and host transcripts are separate copies. Deleting live content never deletes copies already made elsewhere. **Restoring a backup made before a deletion brings the deleted content back.** Delete or replace such backups if the content must be gone.
- miosotis removes what it stores. It can't guarantee erasure from the disk itself: SSDs, filesystem snapshots (Time Machine, APFS), and temporary files the operating system kept may still hold old blocks.
