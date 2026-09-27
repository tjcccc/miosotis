# miosotis

miosotis is a local-first, AI-managed personal knowledge system. You express something; miosotis preserves it faithfully. Later you return with an intention (review, analysis, discussion), and it recovers the relevant evidence and produces durable, traceable artifacts.

**Status: `0.1.0-alpha.1` (foundation checkpoint).** Text capture, source inspection, projects, and language-agnostic search work from the CLI. AI enrichment, evidence runs, artifacts, corrections, the Claude Code Skill, and backup arrive in the next checkpoints of v0.1.0.

## Requirements

- Node.js 24 LTS
- pnpm 12

## Setup (development)

```bash
pnpm install
pnpm build
node dist/index.js init        # creates ~/.miosotis (or $MIOSOTIS_HOME)
```

Until a global `miosotis` command is set up (decided and verified at v0.1.0), run `node dist/index.js <args>`. Avoid `pnpm miosotis …` for `--json` use: pnpm echoes the script line to stdout, which breaks the one-envelope contract.

## Everyday commands

```bash
miosotis "A thought I want to remember." --project miosotis   # save shortcut
miosotis save --stdin --project reading < article.txt          # verbatim from stdin
miosotis save --request-file capture.json --json               # agent-friendly JSON request
miosotis source list --project miosotis
miosotis source get S-<id>                                     # original text + state
miosotis search 计划 artifact --json                            # candidates for an AI host
miosotis project list
miosotis doctor
```

- Every command accepts `--json` and then prints exactly one `miosotis.result.v1` envelope on stdout.
- `miosotis review|analysis|discuss` need an AI model. In v0.1 the AI host running the miosotis Skill does this work; without one, these commands say so instead of pretending.

## Data and configuration

- Home: `~/.miosotis` (override with `MIOSOTIS_HOME`), containing `config.toml`. See `config.example.toml`.
- Library: `data_dir` (default `~/.miosotis/data`). It is self-contained and can be moved whole, but keep the **live** library on a local disk. Do not put it in a live-synced folder (OneDrive, iCloud, Dropbox); use `[backup].dir` for cloud copies.

## Honest limits (alpha.1)

- Text only. Attachments, URLs, PDF, and spreadsheets are v0.2.
- Saved text stays `enrichment pending` until an AI host applies enrichment (next checkpoint).
- No HTTP server before v0.4; artifacts will be static HTML files.

## Development

```bash
pnpm check     # typecheck → lint → build → test
pnpm format
```

Design notes: `docs/architecture.md`, `docs/data-model.md`. Change history: `DEVLOG.md`.

## License

GPL-3.0-only. See `LICENSE`.
