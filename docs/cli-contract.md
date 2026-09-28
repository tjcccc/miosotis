# CLI contract

One grammar serves people and AI hosts. The v0.4 HTTP service will expose the same use cases.

## Output

- `--json` prints exactly one envelope on stdout:
  - success: `{"schema":"miosotis.result.v1","ok":true,"data":…,"warnings":[]}`
  - failure: `{"schema":"miosotis.result.v1","ok":false,"error":{"code","message","retriable","details"}}`
- Logs and human warnings go to stderr. Human mode prints short text.
- `artifact export` writes the stored content byte for byte (or to `--output`).

| Exit | Error codes |
|---|---|
| 0 | success |
| 1 | `internal` |
| 2 | `usage` |
| 3 | `not_found`, `ambiguous_reference` |
| 4 | `conflict`, `stale_version`, `busy` (retriable) |
| 5 | `validation`, `confirmation_required` |
| 6 | `capability_unavailable`, `library_not_initialized`, `schema_too_new`, `environment` |

## Input rules

- Long or multilingual input goes through `--request-file <path>` or `--request-file -` (stdin), or `save --stdin` for raw text. Never build shell strings from user content.
- Requests are validated against the contracts in `src/contracts/` (published as `skill/miosotis/schemas/*.schema.json`). Unknown fields are rejected.
- `save`, `enrich apply`, `artifact create`, and `source correct` accept `idempotency_key`: the same key with the same request returns the original receipt, and the same key with a different request is a `conflict`.
- Commands that remove or delete (`remove`, `source trash`, `artifact trash`, `undo`, `restore` with no IDs, `trash empty`) require `--confirm` and never prompt. `trash empty` also needs the `--plan <id>` of the plan it showed, and refuses if the library changed since. `skill install` requires `--yes`.
- IDs are full type-prefixed IDs (`S-…`, `S-…@vN`, `P-…`, `E-…`, `A-…`). Projects may also be named by slug.

## Commands

| Area | Commands |
|---|---|
| Setup | `init [--data-dir] [--language <bcp47>]`, `doctor`, `prefs` (reply language, timezone for hosts), `skill install [--link] [--allow-network] [--no-sandbox-config] --yes\|uninstall\|status --host claude-code\|codex` (host-adapted copies; for Codex, also prepares the sandbox and reports every change) |
| Capture | `miosotis "text"` (shortcut), `save [text…] [--stdin] [--request-file] [--project] [--origin] [--idempotency-key] [--attach <path>]…` |
| Sources | `source get <ref> [--range a:b] [--chunk n] [--max-chars n]`, `source list [--project] [--since] [--until] [--limit] [--cursor] [--all]`, `source history <S-id>` |
| Undo | `undo [--confirm]`: moves the most recent capture group (comment and files) to the trash; reversible with `restore` |
| Trash | `remove <S-id\|A-id…> [--with-artifacts] --confirm`, `trash list`, `restore [<S-id\|A-id…>]` (all with no IDs, after `--confirm`), `trash empty [<ids…>] [--keep-artifacts] [--confirm --plan <id>]`, `trash empty --resume` (see below) |
| Governance | `source correct <S-id> --expected-version N --request-file`, `source assign <S-id…> --project <slug>`, `source unassign <S-id…> --project <slug>`, `source ignore <S-id> --reason`, `source include`, `source trash --confirm`, `source restore` |
| Projects | `project list`, `project create <slug> [--name] [--description]` |
| Extraction | `extract pending [--limit]` (files waiting for the host), `extract apply --request-file` (host-extracted text with page/sheet locators) |
| Enrichment | `enrich pending [--limit]`, `enrich prepare <ref>`, `enrich apply --request-file` |
| Retrieval | `search [terms…] [--project] [--match all\|any] [--limit] [--cursor]` or `--request-file` |
| Tables | `table query --request-file [--save]` (deterministic calculation over host-extracted tables), `table get <T-id>` |
| Evidence | `evidence prepare --request-file [--from E-id]`, `evidence get <E-id>` |
| Artifacts | `artifact create --request-file [--derived-from A-id] [--supersedes]` (`format`: `markdown`, or `html` with a sandboxed page; `--assets embedded|linked` for html), `artifact get\|list\|sources\|open [--no-launch]\|export [--format md\|html\|json\|bundle] [--output]\|trash --confirm\|restore` (`files` in the create request attaches host-built outputs) |
| Backup | `backup create [--output]`, `backup verify <dir>`, `backup restore <dir> --data-dir <empty>` |
| Intents | `review\|analysis\|discuss` → `capability_unavailable` in v0.1 (use the Skill) |

`source assign` has the same meaning as `save --project`: membership is explicit, and a new slug creates the project. `source unassign` removes membership and records an exclusion so AI suggestions cannot re-add it; the project must already exist. Both take several Sources (all-or-nothing), are idempotent (`already_explicit`, `not_member`), and reject unknown or trashed Sources.

**Removing and deleting.** Nothing is deleted permanently unless it went through the trash.

- **`remove`** moves Sources and artifacts to the trash, where they can be restored.
  - Without `--confirm` it only describes the move, including `citing_artifacts`: the active artifacts that cite the Sources.
  - Those artifacts stay (with a notice) unless `--with-artifacts` moves them too.
  - `restore <S-id>` brings back the artifacts removed together with that Source.
  - `restore` with no IDs brings back everything, after `--confirm`. A folder path given to `restore` points to `backup restore`.
- **`trash empty`** deletes permanently, in two steps:
  1. Without `--confirm` it changes nothing and fails with `confirmation_required`. `error.details.plan` holds:
     - `plan_id`
     - the Sources (with titles and filenames, so the user can recognize them), artifacts, and datasets to delete
     - the other artifacts that cite them, each with an `action`
     - `linked_sources_not_included` (a comment or files saved with them)
     - file counts, including files kept because a surviving item shares the bytes
     - `effects` in plain words
  2. `--confirm --plan <plan_id>` applies exactly that plan.
- **Which items it takes.** With no IDs it takes everything in the trash. IDs must be in the trash (`remove` first).
- **Citing artifacts outside the selection** block it until the user removes and includes them, or passes `--keep-artifacts`. A kept artifact still shows its frozen text, which may quote the deleted content, with a "permanently deleted" notice.
- **Afterwards.** The database is vacuumed and its write-ahead log truncated. If another process held it, the result warns; run `trash empty --resume` later, which also finishes an interrupted deletion.

A saved text ending in a question mark (ASCII or full-width) still saves (the CLI has no model), but the result carries a warning pointing to `search` and `undo`.

A free-text save that is a single word close to a command name (for example `serach`) is rejected as a probable typo. Use `miosotis save <word>` to save it anyway.

## Source-to-artifact walkthrough

```bash
miosotis save --request-file - --json <<'J'
{"text": "Regeneration must be explicit.", "project": "miosotis", "idempotency_key": "save-001"}
J
miosotis enrich prepare S-…@v1 --json            # → source_ref.input_digest, text
miosotis enrich apply --request-file - --json <<'J'
{"source_ref": {"id": "S-…", "version": 1, "input_digest": "sha256:…"}, "title": "Explicit regeneration", "terms": ["regeneration", "report update"]}
J
miosotis evidence prepare --request-file - --json <<'J'
{"request": "How do reports update?", "intent": "review", "project": "miosotis", "queries": ["regeneration"]}
J
miosotis artifact create --request-file - --json <<'J'
{"evidence_run_id": "E-…", "intent": "review", "title": "Report updates", "request": "How do reports update?", "markdown": "Regeneration is explicit [@c1]."}
J
miosotis source correct S-… --expected-version 1 --request-file - --json <<'J'
{"text": "Regeneration must be explicit and user-initiated."}
J
miosotis artifact open A-…                        # unchanged body + "was corrected" notice
miosotis artifact create --request-file new.json --derived-from A-… --json   # regenerate
```
