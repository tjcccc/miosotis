# DEVLOG

Cross-session development log. Newest first. Keep entries short: what shipped, what was verified, what's open.

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
