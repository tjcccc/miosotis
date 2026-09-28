# DEVLOG

Cross-session development log. Newest first. Keep entries short: what shipped, what was verified, what's open.

## 2026-09-28 — v0.2.1 — English-only docs

- Docs, README, and the Skill are English-only for now; Chinese docs will be translated from the English
  later. Removed the Chinese quick-start section from `docs/getting-started.md`.
- Replaced personal, specific examples with generic ones ("Today I finished Book A", "When was the last
  time I had a meeting?", "Save this PDF to the project marketing").
- The Skill describes intent signals (save, question, undo) as phrases "in any language" rather than a
  fixed list of trigger words; `miosotis undo` itself is unchanged.
- Verified: `pnpm check` (26 files, 143 tests); no CJK text left in Markdown/TOML/YAML docs; both Skill
  copies reinstalled.

## 2026-09-27 — v0.2.0 — Everyday release

- Add artifact files (migration 0007): `artifact create` accepts host-built outputs (decks, PDFs, images,
  spreadsheets). They are frozen with the artifact and included in its hash, copied to its folder,
  linked on its page, and backed up. `artifact export --format bundle` copies the whole folder.
- Screen outputs:
  - Rejected: macro-enabled Office formats and zips with `vbaProject.bin`, SVG with scripts or event
    handlers, and executables.
  - Stored with a warning: PDFs with JavaScript and Office files with embedded objects.
- Make it shareable:
  - `npm pack` produces a self-contained tarball (dist, both host Skills, the Getting Started guide,
    the example config), with a `prepack` build; the package stays `private` so it can't be
    published by accident.
  - Add `docs/getting-started.md`.
  - `doctor` checks the Node version and the host tools (`curl`, `python3`).
- Skill: store deliverables with artifacts instead of loose files.
- Pass `pnpm check`: 143 tests. The tarball installs into an isolated npm prefix with a fresh `HOME`
  (`init --language`, both Skill installs including the Codex sandbox, a first save, `doctor` all green).

## 2026-09-27 — v0.2.0-alpha.3 — Deterministic tables

- Hosts can submit structured `tables` with `extract apply`: columns, rows, physical row numbers, and
  locators, stored with the extraction.
- Add the pure calculation engine (`src/domain/tables.ts`) and `table query`: filters, dedupe by key,
  date-grain grouping, count/count_distinct/sum/min/max/avg, select, sort, limit. Each output row
  keeps lineage to `Sheet!row`. It warns on snapshots combined without dedupe and on undated rows (never
  counted as zero), and sums are decimal-safe.
- Add `--save`, which freezes a dataset `T-…` (migration 0006). Evidence pins datasets; artifacts cite
  them and link a dataset page (result, spec, inputs, warnings, lineage); a "dataset inputs changed"
  notice appears when an input changes. `table get` shows a dataset.
- `artifact create` now warns about `[@cN]` markers that didn't parse as citations (inside code, or
  in a table cell beyond the header's columns).
- Skill: extract spreadsheets with `tables`, never do report arithmetic, check the grain before
  combining files, and cite frozen datasets.
- The Codex install note about network access now reflects the actual config.
- Pass `pnpm check`: 140 tests, including scenario H end to end (cumulative snapshots → Jan 2 / Feb 1
  / Mar 2 after dedupe; the naive union warns). Live on a scratch library: a synthetic workbook read
  with openpyxl gave counts and averages identical to an independent Python calculation.

## 2026-09-27 — v0.2.0-alpha.2 — Host-assisted extraction

- Keep miosotis small (owner decision): drop the planned bundled parsers and network client
  (SheetJS, unpdf, csv-parse, Readability, undici). The AI host extracts files with its own tools.
- Add `extract apply` (`miosotis.extraction.v1`): host-extracted text for a file, bound to its hash,
  with the tool, coverage, and ordered page/sheet/range/section segments. Chunks never cross a
  segment. Identical resubmits are no-ops; changes supersede, and cited artifacts show a notice.
- Add `extract pending`. `enrich prepare` flags `extraction_needed`, and evidence items report `where`
  (for example `p. 2`, `sheet Installs · A1:D4`), which artifact source lists show next to the
  reference.
- Web links: the host downloads the raw HTML and saves it as an attachment with `provenance`
  (`supplied_url`, `final_url`, `fetched_at`, `fetch_tool`), then submits the main readable text.
  miosotis makes no network requests.
- Add an `Importer` plugin seam (`src/infra/importers/registry.ts`); the text/Markdown importer is
  its only built-in.
- `skill install` now copies a **host-adapted** Skill instead of symlinking: the shared
  `skill/miosotis/` plus `skill/hosts/<host>/` (notes inserted into SKILL.md, extra files such as
  Codex's `agents/openai.yaml`). A marker plus a content check detects outdated or hand-edited
  copies (`skill status`, `doctor`), and `--link` stays for Skill development. The Codex version
  covers `$miosotis` and `view_image`.
- `skill install --host codex` also prepares Codex's sandbox. It adds the data folder to
  `writable_roots`, and sets `network_access` only with `--allow-network` (global, so opt-in). The
  config edit keeps the file's content, is verified, writes through symlinks, and makes a backup.
  Every change is listed before and after. Config resolution now honors `HOME` from the passed
  environment, so tests never read the real `~/.miosotis`.
- The owner live-verified the cross-host flow: a note saved with `$miosotis` in Codex was retrieved
  and dated with evidence by `/miosotis` in Claude Code, from the same library.
- Pass `pnpm check`: 131 tests. Claude ran the flow live on a scratch library: it downloaded
  example.com with curl, saved it with provenance, extracted the main text, and read a synthetic
  workbook with openpyxl into per-sheet segments. The workbook is searchable by cell text, and a
  pinned row reports its sheet and range.

## 2026-09-27 — v0.2.0-alpha.1 — Files and attachments

- Add a content-addressed blob store (`data/blobs/sha256/…`): staged, fsynced, atomically renamed,
  deduplicated, capped at 100 MB per file; synchronous magic-byte MIME detection (no dependency).
- Add attachments to capture (`save --attach`, request `attachments`). The comment and each file
  become one capture group of linked Sources with explicit project membership and honest per-stage
  states. Idempotency covers the file hashes, and bad inputs commit nothing (migration 0005).
- Extract text/Markdown files (strict UTF-8, BOM-aware) into blob-backed derivations with their own
  chunks. Keep images with interpretation pending; hosts add `interpretations` bound to the image
  hash. Search, `source get`, enrichment, evidence (extracted spans and whole images), and artifacts
  (extracted-text and embedded-image source pages) all handle files. Image evidence pins the
  interpretation it was cited with; "extraction replaced" and "interpretation replaced" notices
  appear when either is redone.
- A failure during post-commit extraction is recorded as a retryable `failed` state and never makes a
  committed save look failed. `source correct` rejects text corrections of file Sources.
- Centralize search indexing (`reindex`) over authored text, extracted text, filenames, enrichment,
  and interpretations. Backup, restore, and verify copy and hash-check every blob, and `doctor`
  reports missing, corrupted, and orphan files.
- From owner testing:
  - Add `miosotis undo` (confirm-first trash of the latest capture group, restorable).
  - Add a warning when a bare save looks like a question.
  - Add `[user] language`, `init --language`, and `miosotis prefs`.
  - New Skill rules: questions go to retrieval and are never saved as notes, ambiguous requests get one question, the reply language follows `prefs`, and web text fetched by the host is saved only on demand, announced, and marked not verbatim.
- Pass `pnpm check`: 118 tests. Claude used the Skill live against the linked CLI on a scratch
  library: it saved a comment plus a Markdown log and a screenshot, viewed and interpreted the
  image, and stored a cited review.
  - The live run surfaced a host mistake: citation handles written before reading them back. The
    Skill now insists on reading each handle from the evidence response.

## 2026-09-27 — v0.1.3 — Linked assets for HTML artifacts

- Add `"assets": "embedded" | "linked"` (and `artifact create --assets`). `linked` pages may load
  exact-version https URLs from cdnjs, jsdelivr (`/npm/<pkg>@<version>`), unpkg, and Google Fonts;
  plain http, `latest`, unpinned URLs, and other hosts are rejected before storage.
- Freeze the validated hosts with the artifact (migration 0004). The viewer builds a per-page
  sandbox policy that allows loading only from those origins, keeps `connect-src 'none'`, and shows a
  banner listing them; standalone HTML exports carry the same notice.
- Update the Skill (embedded by default; linked on request or for sharing, with the trade-off
  stated), the contracts reference, and the security, data-model, CLI, and roadmap docs.
- Pass `pnpm check`: 102 tests. In headless Chrome, a standalone test page
  (cdnjs three.js r128 plus Google Fonts) was rejected as embedded and rendered fully as linked, while
  `fetch` to an allowed host and images from other hosts stayed blocked.

## 2026-09-27 — v0.1.2 — Rich HTML artifacts

- Add `format: "html"` artifacts: a host-authored, self-contained page stored verbatim next to a
  required, cited Markdown summary. `data-cite` handles in the page are validated like `[@cN]`, and
  the content hash and freeze trigger cover the page (migration 0003).
- Open pages in `<iframe sandbox="allow-scripts">` (opaque origin) with an injected no-network CSP.
  Pages must be self-contained: remote resources (including remote import-map entries), `<base>`, and
  meta refresh are rejected before storage. The banner and summary stay outside the frame.
- Decide against a built-in three.js: showcases are not core, so miosotis ships no page libraries.
  A page embeds what it needs, and the Skill prefers Canvas/SVG/CSS. The roadmap records the agreed
  future field `"assets": "embedded" | "linked"` (later `"localized"`) for opt-in linked pages.
- `export --format html` writes the sandboxed viewer and `--format md` the summary. Update the
  Skill (when and how to offer a rich page), the contracts reference, and the docs; add
  `docs/roadmap.md` with the agreed output-format direction.
- Pass `pnpm check`: 97 tests. Canvas and WebGL pages rendered inside the sandbox in headless
  Chrome, where `fetch`, remote images, parent access, and `localStorage` were blocked.

## 2026-09-27 — v0.1.1 — Assign saved Sources to projects

- Add `source assign <S-id…> --project <slug>`: explicit membership for already-saved Sources, the
  same meaning as `save --project` (creates a new project, upgrades inferred membership), without
  touching text or revisions; all-or-nothing and idempotent.
- Add `source unassign <S-id…> --project <slug>`, which removes membership and records an explicit
  exclusion (migration 0002, `source_project_exclusions`) so enrichment suggestions cannot re-add it;
  enrichment now warns when it skips an excluded suggestion.
- Update the Skill (assign when a project is named after saving; never use `project_suggestions` for
  a user request), the contracts reference, `docs/cli-contract.md`, and `docs/data-model.md`.
- Pass `pnpm check`: 89 tests, including the first populated v1 → v2 schema upgrade, explicit-over-
  inferred and exclusion behavior, trashed/unknown rejection without partial writes, and CLI e2e.
  Existing libraries migrate automatically on the next command.

## 2026-09-27 — v0.1.0 — Skill-first MVP

- Add the miosotis Skill (`skill/miosotis/`): intent routing (save, review, analysis, discuss,
  govern, regenerate), heredoc-only JSON calls, attribution and no-causal-invention rules,
  coverage via deterministic enumeration, and reference contracts/examples.
- Generate request JSON Schemas from the zod contracts (`pnpm gen:schemas`), guarded by a
  staleness test.
- Add `skill install|uninstall|status --host claude-code|codex`: consented symlinks into
  `~/.claude/skills` / `~/.agents/skills` that never replace a foreign entry.
- Add `backup create/verify` (SQLite online backup → single-file snapshot, manifest written last,
  `.partial` until verified) and `restore` into an empty folder only.
- Search hits matched only through enrichment terms now show the source opening
  (`matched_in: "enrichment"`).
- Add `docs/cli-contract.md`, `docs/skill.md`, `docs/backup-and-retention.md`, `docs/security.md`,
  `docs/dogfood.md`, and decision note 0001 (model ownership and the v0.4 provider boundary). Install the global CLI
  with `npm link`.
- Pass `pnpm check`: 83 tests, including backup round-trip into a new library, tamper and
  interrupted-backup detection, and skill-install safety. Claude drove the Skill protocol live
  against the linked CLI on a scratch library (saves, cross-language retrieval via terms, review,
  analysis, correction notice, regeneration); the owner's fresh-session Skill discovery test is
  still pending.

## 2026-09-27 — v0.1.0-alpha.2 — Vertical slice

- Add host-agent enrichment: `enrich pending/prepare/apply` with a bounded, validated
  `miosotis.enrichment.v1` contract (multilingual terms, attributed assertions, honest coverage),
  bound to an exact revision by input digest; malformed results mark enrichment `failed` without
  touching the Source; unknown project suggestions are dropped and inferred membership never
  overrides explicit.
- Add immutable evidence runs: search hits per matching chunk, whole-source or chunk refs, and exact
  quote pins with core-assigned handles; `--from` carries earlier handles; project scope and
  ignore/trash policy are enforced.
- Add frozen artifacts: Markdown citing `[@cN]` (parsed as tokens, so code spans never count),
  database-enforced citation ownership, atomic publication, `derived_from`/`supersedes` lineage, and
  static HTML (strict CSP, no scripts, escaped raw HTML) with per-source highlight pages.
- Add read-time freshness notices (source corrected, source ignored/trashed, new material in scope,
  superseded, trashed) and `artifact get/list/sources/open/export/trash`.
- Add `source correct` (expected-version conflict check, new pending revision, dependents listed) and
  `source ignore/include/trash/restore`; `source get` lists dependent artifacts.
- Pass `pnpm check`: 74 tests, including the brief's phase-1 flow driven through the built CLI by a
  deterministic fake agent, scenarios C–F and J, atomic-publish fault injection, and markdown
  injection checks. The live Skill test is still pending (v0.1.0).

## 2026-09-27 — v0.1.0-alpha.1 — Foundation

- Scaffold a single-package TypeScript 7 / Node 24 / pnpm 12 project with Biome, vitest 5, and a
  `pnpm check` gate (typecheck → lint → build → test).
- Add the `node:sqlite` storage layer: pragmas asserted per connection, a `BEGIN IMMEDIATE`
  transaction helper that rolls back deferred-FK failures, and a `user_version` migration runner
  that re-checks the version under the write lock.
- Add schema v1: append-only source revisions (purge-ready trigger), capture operations with
  idempotency, projects with explicit/inferred membership, chunks, derivations, per-stage
  processing states, evidence runs/items, frozen artifacts with composite-FK citations, lineage
  links, audit events, and the `visible_sources` policy view.
- Add `init`, `doctor`, `save` (arguments, `--stdin`, `--request-file`/stdin JSON, free-text
  shortcut with a typo guard), `source get/list/history`, `project list/create`, `search`, and
  honest `review/analysis/discuss` capability errors, all with one JSON envelope contract.
- Add language-agnostic search: script-aware folding, FTS5 trigram for terms of 3+ code points,
  escaped substring fallback for shorter terms, per-source `all`/`any` matching, project scope,
  and exact-ID lookup.
- Write `CLAUDE.md`/`AGENTS.md`, `docs/architecture.md`, `docs/data-model.md`, and
  `config.example.toml`.
- Pass `pnpm check`: 47 tests across unit, integration, and subprocess e2e (mixed-script fidelity,
  idempotency, deferred-FK rollback, append-only trigger, CJK/Japanese/Korean/Arabic/Hindi and
  diacritic search, LIKE/FTS injection, eight concurrent writer processes). Linked SQLite 3.53.1.
