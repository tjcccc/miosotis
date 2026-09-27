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
  "terms": ["claim X", "disagreement", "group decision", "分歧", "未决定"],
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

- Limits: `title` ≤120 chars, `abstract` ≤600 chars, `terms` ≤24, `entities` ≤24, `assertions` ≤10.
- `holder` is one of `user`, `quoted_author`, `group`, `unknown`. `modality` is one of `explicit`, `tentative`, `quoted`, `inferred`.
- Omit `coverage` when `enrich prepare` said `complete: true`. For long sources, copy `provided_chars` and `total_chars` from `prepare` into `coverage.read_chars` and `coverage.total_chars`.
- Omit `model` unless you know it reliably.
- Errors:
  - `stale_version`: the source was corrected. Run `enrich prepare` again.
  - `validation` about the digest: prepare again.

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
  "queries": ["regeneration", "重新生成"],
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
  "title": "Playthrough in 3D",
  "request": "Make a cool 3D demo of my playthrough",
  "markdown": "Hours per chapter: 3, 5, 2 [@c1]. Chapter 2 needed 12 boss retries [@c1].",
  "html": "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{margin:0}</style></head><body><h2 data-cite=\"c1\">Hours by chapter</h2><canvas id=\"c\"></canvas><script>/* draw with Canvas 2D; everything inline */</script></body></html>"
}
```

- `html` is at most 5 MB. With the default `"assets": "embedded"`, it must be self-contained: embed any library yourself (for example as `data:` modules in an import map), and build large requests with a script rather than typing them out.
- `"assets": "linked"` (or `--assets linked`) allows exact-version URLs on `cdnjs.cloudflare.com` (`/ajax/libs/<lib>/<version>/…`), `cdn.jsdelivr.net` (`/npm/<pkg>@<version>/…`), `unpkg.com` (`/<pkg>@<version>/…`), `fonts.googleapis.com`, and `fonts.gstatic.com`. The receipt lists `linked_hosts`. Plain http, `latest`, unpinned URLs, and other hosts are rejected.
- `data-cite` handles are validated like `[@cN]`.
- `markdown` is required and is what `export --format md` returns.

- Only `[@cN]` handles from that evidence run are accepted. `[@cN]` inside code is ignored.
- Raw HTML in the Markdown is displayed as text.
- The response gives `data.id` (`A-…`), `data.path` (the HTML file), and `data.citations`.

## Correction: `miosotis source correct S-… --expected-version N --request-file - --json`

```json
{ "text": "The complete corrected text.", "reason": "Fixed the date", "idempotency_key": "correct-20260927-0a1b2c" }
```

- A `conflict` error means the source changed since you read it. Re-read and ask the user again.

## Project membership: `miosotis source assign|unassign <S-id…> --project <slug> --json`

```bash
miosotis source assign S-AAAA S-BBBB --project 鬼武者剑之道 --json
```

```json
{"project": {"id": "P-…", "slug": "鬼武者剑之道", "name": "鬼武者剑之道", "created": true},
 "results": [{"source_id": "S-AAAA", "change": "assigned"}, {"source_id": "S-BBBB", "change": "upgraded_from_inferred"}]}
```

- `change` for assign: `assigned`, `upgraded_from_inferred`, or `already_explicit`. For unassign: `removed`, `removed_inferred`, or `not_member`.
- No request file is needed; the flags are the whole request. Unknown or trashed Sources fail the whole call.

