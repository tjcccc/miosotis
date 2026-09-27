# DEVLOG

Cross-session development log. Newest first. Keep entries short: what shipped, what was verified, what's open.

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
