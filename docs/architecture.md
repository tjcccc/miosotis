# Architecture

miosotis is a small modular monolith: one package, one deterministic core, thin interfaces.

## Dependency direction

```text
Skill (AI host) ──runs──▶ CLI ─┐
future HTTP service ───────────┤
                               ▼
                        src/app  (use cases)
                               │
          ┌────────────────────┼─────────────────────┐
          ▼                    ▼                     ▼
     src/domain          src/contracts           src/infra
  (pure rules, ids,     (zod request/response   (config, SQLite, search,
   text folding)         schemas)                rendering, files)
```

- `src/cli` parses arguments, reads files/stdin, and renders results. It holds no product rules.
- `src/app` owns the use cases (capture, source queries, search, enrichment, evidence, artifacts, governance, backup, skill installation). Each use case validates input with a contract and runs its writes in one `Database.transaction()`.
- `src/domain/tables.ts` is the pure calculation engine. Numbers in reports come from it, never from a model.
- `src/domain` and `src/contracts` import no Node APIs and nothing from `infra`, so the rules and contracts stay reusable by the v0.5 service and future clients.
- `src/infra` implements storage and I/O. `infra` never imports `app` or `cli`. Only `src/infra/db/database.ts` imports `node:sqlite`.
- Processes: only three files start one, each with an argument array and no shell (a security test enforces this). `src/app/artifacts.ts` runs the OS "open" helper. `src/infra/process/detached.ts` starts the background worker (this CLI). `src/infra/codex/exec.ts` runs the worker's tool-less `codex exec` turn.

Built-in importers sit behind the small `Importer` interface in `src/infra/importers/registry.ts`, which is the plugin seam. Only the text/Markdown importer ships; everything else is extracted by the AI host and recorded through `extract apply`, keeping miosotis small.

The core deliberately calls `infra` repositories directly instead of going through abstract repository interfaces: there is one storage engine, and the boundary that matters (interfaces over one core) is kept.

## Runtime model (v0.1)

- **No server.** Every CLI invocation opens the library, does its work, and exits. The Skill drives the same CLI.
- **Concurrency.** WAL mode plus `BEGIN IMMEDIATE` for every write; concurrent processes wait on a 5 s busy timeout instead of failing on lock upgrade. Migrations re-check the schema version after taking the write lock.
- **Durability.** `synchronous=FULL` for acknowledged personal records. A receipt is returned only after COMMIT.
- **Data home.** `~/.miosotis/config.toml` (or `$MIOSOTIS_HOME`). The library lives in `data_dir` (default `~/.miosotis/data`), is self-contained, and uses relative references so it can be moved whole. Keep the live library on a local disk; point `[backup].dir` at a cloud folder instead.

## Model ownership

v0.1 has no model runner of its own. The AI host running the Skill (Claude Code or Codex) supplies all intelligence and submits schema-validated results through the CLI (`host_agent` mode). The core records generator metadata but never invents a model name. The v0.5 service adds its own providers (BYOK/subscription) through `@priest-ai/core`, behind the same use cases.

**Background enrichment (v0.5.0-alpha.1, opt-in).** `src/app/worker.ts` enriches pending notes without a person in the loop.
- It builds the same packet as `enrich prepare` (with the shared `TEXT_GUIDANCE`) and asks a provider for the content fields only (`WorkerEnrichmentOutput`, sent as a strict JSON Schema).
- It stores the answer through `applyEnrichment` with `external_runtime` provenance. The model never runs miosotis commands or touches the database.
- The first provider is the user's own signed-in Codex CLI. Direct BYOK providers can plug into the same worker later.

## Search

Search exists for the AI host, not as an end-user feature. It is language-agnostic:

- Text is folded for search (NFKC, lowercase, diacritics stripped only from Latin/Greek/Cyrillic) and indexed with the FTS5 trigram tokenizer, which needs no word segmentation.
- Terms of three or more code points use FTS; shorter terms (common in CJK) use an escaped `LIKE` over the same folded text.
- Matching is per source (`all` terms by default, or `any`), filtered through the single `visible_sources` policy view, and limited to current revisions.
- Paraphrase recall comes from the AI issuing query variants and from multilingual enrichment terms, not from embeddings.

## Current vs future scope

| Area | v0.1 | Later |
|---|---|---|
| Inputs | text | attachments, URLs, PDF, CSV/XLSX (v0.2) |
| Interfaces | CLI + Skill | HTTP service (v0.5), Web UI |
| AI | host agent via Skill | BYOK/subscription providers (v0.5) |
| Artifacts | Markdown; sandboxed, self-contained HTML pages | multi-file artifacts, images/PDF/Office, deterministic exports (see `docs/roadmap.md`) |
| Deletion | ignore; remove to the trash / restore; `trash empty` with a reviewable plan | — |
| Retrieval | FTS trigram + substring | optional embeddings attached to exact chunks |
