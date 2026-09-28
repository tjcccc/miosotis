# miosotis request contracts (v1)

All requests go to `--request-file -` via a quoted heredoc. Exact schemas: `../schemas/*.schema.json`. Unknown fields are rejected.

## Capture: `miosotis save --request-file - --json`

```json
{
  "text": "The article claims X. I disagree; our group has not decided.",
  "origin": "user",
  "project": "miosotis",
  "idempotency_key": "save-20260927-a1b2c3",
  "provenance": {
    "supplied_url": "https://example.com/post",
    "author": "Jane Doe",
    "title": "Post title",
    "published": { "value": "2026-03", "precision": "month" }
  }
}
```

- `origin`: `user` (the user's own words), `imported` (pasted or quoted material), or `ai_saved` (AI output the user chose to keep).
- `attachments` (optional, at most 20; each file at most 100 MB): `[{"path": "/abs/file.png", "filename": "shown name", "origin": "imported"|"user"}]`. `text` becomes optional and is the comment on the files. The receipt lists every Source with `role` (`comment`/`text`/`file`), `mime`, `sha256`, and `processing` (for example `extraction: complete|pending|unsupported|failed`, `interpretation: pending`).
- `provenance` is optional and records only what is visible. It is not a reliability score.
- Receipt: `data.sources[0].ref` (`S-…@v1`), `data.project`, `data.replayed`.

## Enrichment: `miosotis enrich apply --request-file - --json`

Copy `source_ref` exactly from `enrich prepare`.

```json
{
  "source_ref": { "id": "S-…", "version": 1, "input_digest": "sha256:…" },
  "title": "Disagreement with article's claim X",
  "abstract": "The user notes an article claiming X, disagrees, and says the group has not decided.",
  "language": "en",
  "terms": ["claim X", "disagreement", "group decision", "undecided"],
  "entities": [{ "name": "Jane Doe", "type": "person" }],
  "project_suggestions": [],
  "assertions": [
    { "text": "X", "holder": "quoted_author", "modality": "quoted" },
    { "text": "The user disagrees with X", "holder": "user", "modality": "explicit" },
    { "text": "The group has not decided", "holder": "group", "modality": "explicit" }
  ],
  "warnings": []
}
```

- `terms`: include translations of key terms into the languages the user searches in.
- Limits: `title` ≤120 chars, `abstract` ≤600 chars, `terms` ≤24, `entities` ≤24, `assertions` ≤10.
- Images: add `"interpretations": [{"payload_sha256": "<files[].sha256>", "description": "…", "transcription": "legible text only", "observations": [{"text": "HP about 30%", "legibility": "uncertain"}]}]`. They are stored as model-derived interpretations of those exact bytes; the original image is never altered.
- `holder` is one of `user`, `quoted_author`, `group`, `unknown`. `modality` is one of `explicit`, `tentative`, `quoted`, `inferred`.
- Omit `coverage` when `enrich prepare` said `complete: true`. For long sources, copy `provided_chars` and `total_chars` from `prepare` into `coverage.read_chars` and `coverage.total_chars`.
- Omit `model` unless you know it reliably.
- Errors:
  - `stale_version`: the source was corrected. Run `enrich prepare` again.
  - `validation` about the digest: prepare again.

## Events in enrichment (schedule)

Add to `enrich apply` when the note states a dated arrangement:

```json
{
  "source_ref": {"id": "S-…", "version": 1, "input_digest": "sha256:…"},
  "title": "Meeting about the roadmap",
  "terms": ["meeting", "roadmap"],
  "events": [
    {"title": "Meeting about the roadmap", "start": {"date": "2026-10-05", "part_of_day": "morning"},
     "location": "Tokyo room", "phrase": "next Monday morning"},
    {"title": "Call with the Tokyo office", "start": {"date": "2026-10-07", "time": "10:00"}, "end": {"time": "11:00"},
     "timezone": "Asia/Tokyo"}
  ]
}
```

- **`start`:** `date` is required. Add either `time` (`HH:MM`, only when stated) or `part_of_day` (`morning|afternoon|evening|night`), not both.
- **`end`** (optional): `date` and/or `time`. A multi-day item gives `end.date`.
- **`timezone`:** defaults to the zone the note was saved in (from `enrich prepare`).
- **`phrase`** must appear in the note verbatim; otherwise it is dropped with a warning.
- **`replaces`** (a `V-…` ID) reschedules an earlier event. The top-level `cancels: ["V-…"]` cancels events.
- `repeat` (optional) makes one event repeat:

  ```json
  {"title": "East region sales meeting", "start": {"date": "2026-09-28", "time": "09:00"},
   "repeat": {"every": "week", "on": ["monday"]}, "phrase": "every Monday at 09:00"}
  ```

  - **`every`** is `day`, `week`, or `month`, and `interval` is N (default 1).
  - **`on`:** weekdays, for weekly rules.
  - **`month_day`** (1–31, `-1` = last day) or **`month_weekday`** (`{"nth": 1..5 | -1, "weekday": …}`), for monthly rules.
  - **`until`** (inclusive) or **`count`**.
  - `start.date` is the first possible date. The stored start moves to the first real occurrence.
- **Changing a repeating event:**
  - `cancels` also takes `{"event": "V-…", "date": "…"}` (one date) or `{"event": "V-…", "from": "…"}` (end the series).
  - A replacing event with `"occurrence": "<date>"` replaces that one date. Without it, the replacement replaces the series from its own start date on.
- The receipt lists `events` (`id`, `title`, `start_date`, `precision`) and `cancelled_events`.

## Schedule: `miosotis schedule [--days N | --months N | --from D [--to D]] [--past] [--all] [--format table|md] [--ids] --json`

```json
{"range": {"from": "2026-09-28", "to": "2026-10-04", "timezone": "Asia/Shanghai", "past": false},
 "today": "2026-09-28", "total": 1,
 "events": [{"id": "V-…", "title": "Dentist", "date": "2026-09-28", "time": "18:00", "part_of_day": null,
   "end_date": null, "end_time": "19:00", "precision": "exact", "timezone": "Asia/Shanghai", "location": null,
   "status": "scheduled", "moved_to": null, "source_ref": "S-…@v1", "phrase": "today at 18:00", "repeat": null, "stale": false}]}
```

- **Output without `--json`:** an aligned table for the terminal (wide characters such as CJK take two columns), or `--format md` for a Markdown table. `--ids` adds the note and event IDs.
- **Default range:** the next 7 days, including today. `--months 0` is the current month. `--to` is inclusive. `--from` alone is open-ended.
- **`--all`** adds cancelled (`status: "cancelled"`) and rescheduled (`"moved"`, with `moved_to`) entries.
- **Repeating events** appear once per date in the range, with the same `id` and `repeat` in words (for example `"every Monday"`). Refer to one date as `{"event": id, "date": date}`. An open-ended `--from` range expands repeats for up to a year.
- **`stale: true`:** the note was corrected and not re-enriched yet.
- Removed, ignored, or deleted notes contribute nothing.

## Extraction: `miosotis extract apply --request-file - --json`

For a file Source whose extraction is pending (PDF, spreadsheet, HTML, …). Copy `payload_sha256` from `extract pending` or `source get`.

```json
{
  "source_ref": { "id": "S-…", "version": 1, "payload_sha256": "<64 hex>" },
  "method": { "tool": "pdftotext", "version": "24.02", "note": "-layout" },
  "text": "Chapter one …\nChapter two …",
  "segments": [
    { "start": 0, "end": 1830, "locator": { "page": 1 } },
    { "start": 1830, "end": 4102, "locator": { "page": 2 } }
  ],
  "coverage": { "complete": true },
  "warnings": []
}
```

- `text` is at most 2,000,000 chars. It is the file's content, not a summary. The whole request is at most 64 MiB (about 100,000 rows × 20 columns of tables plus the text). If it doesn't fit, submit part of it and record partial coverage.
- `segments` (optional) are ordered, non-overlapping UTF-16 spans of `text`. A locator has any of `page`, `sheet`, `range`, `section`. Chunks never cross a segment, and evidence items report `where` (for example `p. 2`).
- For spreadsheets, use one segment per sheet, with the rows as TSV and `{"sheet": "Worksheet", "range": "A1:G551"}`, **and** a structured table per sheet:
  ```json
  "tables": [{"name": "Worksheet", "locator": {"sheet": "Worksheet", "range": "A1:G551"}, "columns": ["Item", "Owner", "Year", "Category"], "header_row": 1, "rows": [["Item A", "Team B", 2026, "Category C"]], "notes": "no hidden rows"}]
  ```
  Cells are strings, numbers, booleans, or null (at most 2,000,000 cells in total). `first_row` defaults to `header_row + 1`.
- `coverage.complete: false` marks a partial extraction, for example `{"complete": false, "note": "pages 1-20 of 45"}`.
- Images are rejected; use `interpretations` via `enrich apply`.
- Resubmitting identical content returns `replayed: true`. Different content supersedes the previous extraction.

A web page is saved as an attachment first, with provenance on the attachment:

```json
{"text": "Interesting article: https://example.com/a",
 "attachments": [{"path": "/tmp/page.html", "provenance": {"supplied_url": "https://example.com/a", "final_url": "https://www.example.com/a/", "fetched_at": "2026-09-27T12:00:00Z", "fetch_tool": "curl 8.7"}}]}
```

## Table query: `miosotis table query --request-file - [--save] --json`

```json
{
  "inputs": [{ "ref": "S-JAN" }, { "ref": "S-FEB" }, { "ref": "S-MAR", "table": "Installs" }],
  "dedupe": { "by": ["Event"], "keep": "first" },
  "filters": [{ "column": "Customer", "op": "neq", "value": "Test" }],
  "group_by": [{ "column": "Installed", "grain": "month", "as": "month" }],
  "aggregates": [{ "op": "count", "as": "new installations" }],
  "sort": [{ "by": "month", "dir": "asc" }],
  "note": "Cumulative monthly snapshots; deduped by event ID; grouped by install date.",
  "save": true
}
```

- Filter `op`: `eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `between`, `contains`, `is_empty`, `not_empty`.
- The result has `columns`, `rows`, `lineage[i].rows` (for example `S-…@v1 Installs!4`), `stats` (input rows, rows removed by dedupe), and `warnings`. With `save`, it also has `dataset_id` (`T-…`).
- `miosotis table get T-…` shows a frozen dataset and whether any input changed since.
- Cite it: `evidence prepare` with `"datasets": ["T-…"]` returns an item with `kind: "dataset"`.

## Search: `miosotis search "<terms>" [--project p] [--match all|any] [--limit n] --json`

- Returns candidates, not evidence. Each hit has `ref`, `title`, and `matches[].excerpt` with offsets.
- Terms are split on whitespace, and `all` (the default) requires every term somewhere in the source. Use `any` for broad recall.
- Paginate with `--cursor <next_cursor>`.

## Enumeration: `miosotis source list [--project p] [--since ISO] [--until ISO] [--limit n] [--cursor c] --json`

- Deterministic, newest first. Use it for completeness ("all notes this month").

## Evidence: `miosotis evidence prepare --request-file - [--from E-…] --json`

```json
{
  "request": "What did I decide about artifact regeneration this month?",
  "intent": "review",
  "project": "miosotis",
  "interpretation": {
    "timezone": "Europe/Berlin",
    "date_from": "2026-09-01",
    "date_to": "2026-09-30",
    "notes": "Month = calendar September in the user's timezone; enumerated with source list."
  },
  "queries": ["regeneration", "report update"],
  "match": "any",
  "per_query_limit": 10,
  "source_refs": [{ "ref": "S-…" }, { "ref": "S-…@v2", "chunk": 0 }],
  "quotes": [{ "ref": "S-…", "quote": "exact text copied from source get" }],
  "max_items": 60
}
```

- The response has `data.id` (`E-…`) and `data.items[]` with `handle`, `ref`, `excerpt`, and `source_state`.
- `interpretation.date_*` fields are recorded, not applied. To limit by date, pin the enumerated sources.
- A quote must match the source text exactly; if it repeats, add `"occurrence": n`.
- Ignored, trashed, or out-of-project sources are rejected.

## Artifact: `miosotis artifact create --request-file - [--derived-from A-…] [--supersedes] --json`

```json
{
  "evidence_run_id": "E-…",
  "intent": "review",
  "title": "Artifact regeneration decisions (September)",
  "request": "What did I decide about artifact regeneration this month?",
  "markdown": "## Decisions\n\n- Regeneration is explicit and user-initiated [@c1].\n- Old reports stay unchanged [@c2].\n",
  "limitations": ["Two notes from September 12 are still unenriched and may be under-represented."],
  "idempotency_key": "artifact-20260927-d4e5f6"
}
```

Rich page variant (`"format": "html"`), for example `--derived-from A-REVIEW`:

```json
{
  "evidence_run_id": "E-…",
  "intent": "review",
  "format": "html",
  "title": "Quarterly results in 3D",
  "request": "Make an interactive 3D chart of the quarterly results",
  "markdown": "Units per quarter: 3, 5, 2 [@c1]. Q2 was the highest [@c1].",
  "html": "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{margin:0}</style></head><body><h2 data-cite=\"c1\">Hours by chapter</h2><canvas id=\"c\"></canvas><script>/* draw with Canvas 2D; everything inline */</script></body></html>"
}
```

- `html` is at most 5 MB. With the default `"assets": "embedded"`, it must be self-contained: embed any library yourself (for example as `data:` modules in an import map), and build large requests with a script rather than typing them out.
- `"assets": "linked"` (or `--assets linked`) allows exact-version URLs on `cdnjs.cloudflare.com` (`/ajax/libs/<lib>/<version>/…`), `cdn.jsdelivr.net` (`/npm/<pkg>@<version>/…`), `unpkg.com` (`/<pkg>@<version>/…`), `fonts.googleapis.com`, and `fonts.gstatic.com`. The receipt lists `linked_hosts`. Plain http, `latest`, unpinned URLs, and other hosts are rejected.
- `data-cite` handles are validated like `[@cN]`.
- `markdown` is required and is what `export --format md` returns.

- `files` (optional, at most 20; each file at most 100 MB) stores host-built outputs with the artifact: `[{"path": "/abs/deck.pptx", "role": "primary"}, {"path": "/abs/chart.png"}]` (`role` defaults to `supporting`). The receipt lists `files`, and PDF JavaScript or embedded Office objects produce a warning.
- Only `[@cN]` handles from that evidence run are accepted. `[@cN]` inside code is ignored.
- Raw HTML in the Markdown is displayed as text.
- The response gives `data.id` (`A-…`), `data.path` (the HTML file), and `data.citations`.

## Correction: `miosotis source correct S-… --expected-version N --request-file - --json`

```json
{ "text": "The complete corrected text.", "reason": "Fixed the date", "idempotency_key": "correct-20260927-0a1b2c" }
```

- A `conflict` error means the source changed since you read it. Re-read and ask the user again.

## Remove: `miosotis remove <S-id|A-id…> [--with-artifacts] [--confirm] --json`

Without `--confirm` the call fails with `confirmation_required`; `error.details` is:

```json
{"sources": [{"id": "S-AAAA", "label": "Meeting notes", "state": "retained"}], "artifacts": [],
 "citing_artifacts": [{"id": "A-CCCC", "title": "Monthly review", "action": "keep"}]}
```

- With `--confirm` it moves the items to the trash. The receipt holds `removed.sources|artifacts`, `already_in_trash`, and `kept_citing_artifacts`.
- `--with-artifacts` moves the citing artifacts too (`action: "remove"`), and restoring the Source brings them back.

## Trash: `miosotis trash list --json`, `miosotis restore [<ids…>] [--confirm] --json`

- `trash list` returns `sources` (`id`, `label`, `trashed_at`, `cited_by`), `artifacts`, and `total`.
- `restore <ids…>` returns `restored.sources|artifacts` and `not_in_trash`. An item deleted permanently fails with `validation`.
- `restore` with no IDs restores everything and needs `--confirm`.

## Empty the trash: `miosotis trash empty [<ids…>] [--keep-artifacts] [--confirm --plan <id>] --json`

Review first (nothing changes). The call fails with `confirmation_required`, and `error.details.plan` is:

```json
{"plan_id": "3f9c0a1b2d4e",
 "sources": [{"id": "S-AAAA", "kind": "text", "versions": 2, "title": "Meeting notes", "filenames": []}],
 "artifacts": [{"id": "A-CCCC", "title": "Monthly review", "reason": "cites_source", "action": "undecided"}],
 "datasets": [], "linked_sources_not_included": [{"id": "S-BBBB", "relation": "attached_file", "retention": "retained"}],
 "files": {"erase": 0, "bytes": 0, "kept_shared": 0}, "needs_artifact_choice": true,
 "effects": ["Permanently delete 1 Source(s) …", "1 artifact(s) cite them … Remove them to the trash and include them, or keep them with --keep-artifacts.", "…"]}
```

- The artifact `action` values:
  - `delete`: a trashed artifact that is part of the selection
  - `undecided`: cites the Sources and needs a decision
  - `keep`: with `--keep-artifacts`
- No IDs means everything in the trash. IDs that are not in the trash fail with `validation`.
- Confirm with the same IDs and flags plus `--confirm --plan <plan_id>`. The receipt holds `purged.sources|artifacts|datasets`, `kept_artifacts`, `files_erased`, and `compacted`.
- `conflict`: the library changed since the review. Show the new plan in `error.details.plan`.
- `trash empty --resume` finishes an interrupted deletion; `doctor` reports one.

## Project membership: `miosotis source assign|unassign <S-id…> --project <slug> --json`

```bash
miosotis source assign S-AAAA S-BBBB --project marketing --json
```

```json
{"project": {"id": "P-…", "slug": "marketing", "name": "marketing", "created": true},
 "results": [{"source_id": "S-AAAA", "change": "assigned"}, {"source_id": "S-BBBB", "change": "upgraded_from_inferred"}]}
```

- `change` for assign: `assigned`, `upgraded_from_inferred`, or `already_explicit`. For unassign: `removed`, `removed_inferred`, or `not_member`.
- No request file is needed; the flags are the whole request. Unknown or trashed Sources fail the whole call.

