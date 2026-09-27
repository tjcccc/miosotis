# Data model

The schema lives in `src/infra/db/migrations/`. Schema version is tracked with `PRAGMA user_version`. Released migrations are never edited; changes are new numbered files.

## Identifiers

- User-facing IDs are type-prefixed ULIDs: `S-` Source, `P-` Project, `A-` Artifact, `E-` evidence run, `D-` derivation, `O-` operation.
- A source revision is `S-…@vN`. Revision numbers are local to one source and are not timestamps.
- v0.1 accepts full IDs only. A ULID's leading characters encode time, so short prefixes collide.
- Project slugs can change; foreign keys always use IDs.

## Sources and revisions

- `sources` holds identity and current policy: `kind`, `origin` (`user`, `imported`, `ai_saved`), `current_version`, `retention` (`retained`, `trashed`, `purged`), `inclusion` (`included`, `ignored`, with a reason), and the change sequence numbers used for freshness.
- `source_versions` holds immutable content: verbatim `content_text`, `content_digest`, `char_length`, observable `provenance_json` (supplied URL, author, reported publication date with precision), `received_at` (UTC), optional `client_captured_at`, and the IANA `timezone` used to interpret it.
- `(sources.id, current_version)` references `source_versions` with a deferred foreign key, so a source can never point at a missing or foreign revision. Inserts therefore run inside the transaction helper.
- A trigger makes `source_versions` append-only. The only permitted update is the purge transition (content and digest set to NULL, `purged_at` set, identity kept). Purge itself ships in v0.3; the schema is ready for it.
- A correction adds version N+1 with `parent_version = N` and moves `current_version`, guarded by an expected-version check (a stale value is a `conflict`). The new revision starts with enrichment `pending`; older revisions, their enrichment, and artifacts pinned to them are untouched.

## Capture groups and idempotency

- Every capture is an `operations` row (`O-…`) that also acts as the capture group. In v0.1 one capture creates one text source; attachments in v0.2 will add more sources to the same group.
- `idempotency_key` is unique per operation kind. The same key with the same canonical request digest returns the original receipt (`replayed: true`); the same key with different content is a `conflict`.
- Saving the same text again without a key is a new, separate capture. Hashes protect integrity; they never merge history.

## Derived data

- `chunks` stores contiguous, non-overlapping paragraph spans (UTF-16 offsets, never splitting a surrogate pair) for every revision, so pinned evidence always resolves.
- `derived_records` stores enrichment (and later extraction/interpretation) tied to an exact revision and input digest, with `method`, nullable `model` (never invented), schema and pipeline versions, and `superseded_by`.
- `processing_states` tracks each stage separately (`pending`, `complete`, `partial`, `unsupported`, `failed`), never a single `processed` flag.
- `search_fts` indexes folded text of **current** revisions only: one row per chunk plus one row of enrichment hints. Capture, correction, and enrichment replace a source's rows inside the same transaction. Policy (retention, inclusion, project) is applied at query time through the `visible_sources` view, so ignoring a source takes effect immediately without reindexing.

## Projects

- `projects` has a stable ID, a unique slug in any script, a name, and an optional user-authored description.
- `source_projects` records `explicit` (user) or `inferred` (AI suggestion) membership. Inferred never overwrites explicit. Saving with `--project <new slug>`, or `source assign`, creates the project because the user named it.
- `source_project_exclusions` (migration 0002) records an explicit "not in this project" decision made by `source unassign`. Inferred suggestions skip excluded pairs; `source assign` clears the exclusion. Assignment changes never touch source text or revisions. A newly assigned source bumps `changed_seq`, so project artifacts may show "new material".

## Evidence and artifacts

- `evidence_runs` pin a request, its interpretation (timezone, date bounds, query variants), scope, strategy version, and a `watermark_seq` for later freshness checks.
- `evidence_items` assign core-owned handles (`c1…cN`) to exact `(source, version, start, end)` spans. Excerpts are computed from immutable text rather than copied, so a future purge has nothing extra to chase.
- `artifacts` store frozen Markdown, rendered HTML, and a content hash; a trigger rejects content changes except the purge transition. `artifact_citations` uses composite foreign keys so a citation can only reference a handle from the artifact's own evidence run. `artifact_links` records `derived_from`/`supersedes` lineage.
- `artifacts.format` (migration 0003) is `markdown` or `html`. An `html` artifact stores the host-authored page verbatim in `payload_html`. `content_markdown` still holds its required, citable summary, and `rendered_html` the frozen summary body. The freeze trigger covers `format` and `payload_html`, and the content hash includes the page. Citations are the union of `[@cN]` in the summary and `data-cite` handles in the page.
- `artifacts.assets` (migration 0004) is `embedded` (default) or `linked`. For linked pages, `linked_hosts_json` freezes the hosts validated at creation, and the viewer's policy allows only those. Both columns are covered by the freeze trigger.
- An evidence run is immutable. `evidence prepare --from E-…` creates a new run that carries earlier items with their handles.
- Artifact publication (artifact row, citations, lineage links, idempotency receipt) is one transaction. The static folder `artifacts/<A-id>/` (`index.html` plus `sources/<S-id>@vN.html`) is a rebuildable view: it wraps the stored body with a status banner computed at open time.

## Source policy

- `ignore` / `include` change retrieval inclusion (with a reason); `trash` / `restore` change retention. None rewrites content.
- Trashing removes the source's search rows; restoring rebuilds them from the stored chunks and current enrichment.
- Re-including or restoring bumps `changed_seq`, so artifacts in scope show "new material may be available". Ignoring or trashing a cited source shows "unavailable" on those artifacts instead.

## Freshness watermark

`counters.change_seq` increases on every source mutation. Sources record `created_seq` and `changed_seq`; evidence runs record the watermark at creation. "New material may be available" means a visible, in-scope source changed after the watermark and is not already cited.

## Time

- Instants are stored as UTC ISO-8601 strings; the capture timezone is stored separately.
- Reported dates keep their precision (`year`, `month`, `day`, `instant`) instead of being padded to midnight.
- Unknown is `NULL`, never zero or an empty string.
