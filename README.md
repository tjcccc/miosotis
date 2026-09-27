# miosotis

miosotis is a local-first, AI-managed personal knowledge system. You express something; miosotis preserves it faithfully. Later you return with an intention (review, analysis, discussion), and it recovers the relevant evidence and produces durable, traceable artifacts.

**Status: `0.1.0-alpha.2` (vertical-slice checkpoint).** The full text workflow works through the CLI protocol: capture → AI-host enrichment → search → pinned evidence → frozen artifact (static HTML) → correction → provenance notices → explicit regeneration. The Claude Code Skill, backup/restore, and a global install arrive at v0.1.0.

## Requirements

- Node.js 24 LTS
- pnpm 12

## Setup (development)

```bash
pnpm install
pnpm build
node dist/index.js init        # creates ~/.miosotis (or $MIOSOTIS_HOME)
```

To get a global `miosotis` command, link the checkout with npm (it links the built `dist/`, so rerun `pnpm build` after changes):

```bash
npm link            # remove later with: npm unlink -g miosotis
```

Without the link, run `node dist/index.js <args>`. Avoid `pnpm miosotis …` for `--json` use: pnpm echoes the script line to stdout, which breaks the one-envelope contract.

## Everyday commands

```bash
miosotis "A thought I want to remember." --project miosotis   # save shortcut
miosotis save --stdin --project reading < article.txt          # verbatim from stdin
miosotis source list --project miosotis
miosotis source get S-<id>                                     # original text, state, dependent artifacts
miosotis artifact list
miosotis artifact open A-<id>                                  # refresh status banner, open in browser
miosotis artifact export A-<id> --format md
miosotis source correct S-<id> --expected-version 1 --request-file fix.json
miosotis source ignore S-<id> --reason "wrong dataset"         # or include / trash --confirm / restore
miosotis doctor
```

## AI-host protocol

An AI host (the miosotis Skill in Claude Code, later Codex) supplies the intelligence and calls these commands with JSON on stdin (`--request-file -`):

```bash
miosotis enrich pending --json                                 # backlog of unenriched Sources
miosotis enrich prepare S-<id> --json                          # bounded text + input digest
miosotis enrich apply --request-file - --json                  # miosotis.enrichment.v1
miosotis search 计划 artifact --json                            # candidates, any language
miosotis evidence prepare --request-file - --json              # pin hits/refs/quotes → handles c1…cN
miosotis artifact create --request-file - --json               # Markdown citing [@cN]
miosotis artifact create --request-file - --derived-from A-<id> [--supersedes]   # regenerate
```

- Every command accepts `--json` and then prints exactly one `miosotis.result.v1` envelope on stdout.
- Agent JSON is validated; the core assigns IDs, times, hashes, and citation handles, and rejects citations outside the evidence run.
- `miosotis review|analysis|discuss` need an AI model. In v0.1 the AI host does this work; without one, these commands say so instead of pretending.

## Data and configuration

- Home: `~/.miosotis` (override with `MIOSOTIS_HOME`), containing `config.toml`. See `config.example.toml`.
- Library: `data_dir` (default `~/.miosotis/data`). It is self-contained and can be moved whole, but keep the **live** library on a local disk. Do not put it in a live-synced folder (OneDrive, iCloud, Dropbox); use `[backup].dir` for cloud copies.

## Honest limits (alpha.2)

- Text only. Attachments, URLs, PDF, and spreadsheets are v0.2.
- The bare CLI has no model: saved text stays `enrichment pending` until an AI host applies enrichment.
- Structural citation checks prove a citation points at pinned evidence, not that the sentence is supported by it.
- No HTTP server before v0.4; artifacts are static HTML files under the data folder.
- Permanent purge is v0.3 (ignore and trash are reversible).

## Development

```bash
pnpm check     # typecheck → lint → build → test
pnpm format
```

Design notes: `docs/architecture.md`, `docs/data-model.md`. Change history: `DEVLOG.md`.

## License

GPL-3.0-only. See `LICENSE`.
