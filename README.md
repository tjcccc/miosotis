# miosotis

miosotis is a local-first, AI-managed personal knowledge system. You express something; miosotis preserves it faithfully. Later you return with an intention (review, analysis, discussion), and it recovers the relevant evidence and produces durable, traceable artifacts.

**Status: `0.1.0`.** A text-only, single-user MVP that you use through an AI host:
- Tell Claude Code "remember this", "review my notes on X", or "correct that note", and the miosotis Skill saves, organizes, retrieves, and writes cited reports.
- The CLI keeps the library local, faithful, and traceable.
- Reports can be Markdown or interactive HTML pages, always sandboxed. Pages are self-contained by default, or `linked` to pinned CDN/font URLs on request.
- Files can be saved with a note (`--attach`). Text and Markdown are extracted and searchable, and images are kept and interpreted by the AI host. PDFs, spreadsheets, and web pages come in the next 0.2 checkpoints. See `docs/roadmap.md`.

## Requirements

- Node.js 24 LTS
- pnpm 12

## Setup

```bash
pnpm install
pnpm build
npm link                                         # global `miosotis` (links dist/; rerun pnpm build after changes)
miosotis init                                    # creates ~/.miosotis (or $MIOSOTIS_HOME)
miosotis skill install --host claude-code --yes  # links the Skill into ~/.claude/skills
```

Then start a new Claude Code session and talk normally: "记一下…", "Review what I saved about ingestion", "That note is wrong, it should say…". See `docs/skill.md`.

- Undo with `miosotis skill uninstall --host claude-code` and `npm unlink -g miosotis`.
- Without the link, run `node dist/index.js <args>`. Avoid `pnpm miosotis …` for `--json` use: pnpm echoes the script line to stdout.

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
miosotis backup create --output ~/OneDrive/miosotis-backups     # verified snapshot; restore with `miosotis restore`
miosotis undo                                                  # take back the last save (trash; restorable)
miosotis prefs                                                 # reply language / timezone that AI hosts follow
miosotis doctor
```

## AI-host protocol

An AI host (the miosotis Skill in Claude Code, later Codex) supplies the intelligence and calls these commands with JSON on stdin (`--request-file -`). Full grammar and error codes: `docs/cli-contract.md`.

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

## Honest limits (0.1.0)

- Text only. Attachments, URLs, PDF, and spreadsheets are v0.2.
- The bare CLI has no model: saved text stays `enrichment pending` until an AI host applies enrichment.
- Retrieval is keyword-based (any language); paraphrase recall depends on the host's query variants and multilingual enrichment terms.
- Structural citation checks prove a citation points at pinned evidence, not that the sentence is supported by it.
- Claude Code is the tested host. Codex install works but is unverified. There is no HTTP server or Web UI before v0.4.
- Ignore and trash are reversible. Permanent purge is v0.3.

## Development

```bash
pnpm check     # typecheck → lint → build → test
pnpm format
```

Docs: `docs/architecture.md`, `docs/data-model.md`, `docs/cli-contract.md`, `docs/skill.md`, `docs/backup-and-retention.md`, `docs/security.md`, `docs/roadmap.md`, `docs/dogfood.md`, `docs/decisions/`. Change history: `DEVLOG.md`.

## License

GPL-3.0-only. See `LICENSE`.
