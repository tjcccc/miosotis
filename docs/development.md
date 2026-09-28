# Development

## Requirements

- Node.js 24 LTS
- pnpm 12

## From source

```bash
pnpm install
pnpm build
npm link                                         # global `miosotis` (links dist/; rerun pnpm build after changes)
miosotis init                                    # creates ~/.miosotis (or $MIOSOTIS_HOME)
miosotis skill install --host claude-code --yes  # copies the Claude Code version into ~/.claude/skills
miosotis skill install --host codex --yes        # copies the Codex version into ~/.agents/skills (see docs/skill.md for its sandbox)
```

- Undo with `miosotis skill uninstall --host claude-code` and `npm unlink -g miosotis`.
- Without the link, run `node dist/index.js <args>`. Avoid `pnpm miosotis …` for `--json` use: pnpm echoes the script line to stdout.
- Tests use a temporary `MIOSOTIS_HOME` and never touch `~/.miosotis`.

```bash
pnpm check     # typecheck → lint → build → test (the e2e tests run the built dist/)
pnpm format
pnpm gen:schemas   # after changing a request contract (a test fails when the schemas are stale)
```

## Commands for scripts and agents

Every command accepts `--json` and then prints exactly one `miosotis.result.v1` envelope on stdout. Full grammar and error codes: [CLI contract](cli-contract.md).

```bash
miosotis "A thought I want to remember." --project p            # save shortcut
miosotis save --stdin --project reading < article.txt          # verbatim from stdin
miosotis source list --project p
miosotis source get S-<id>                                     # original text, state, dependent artifacts
miosotis source correct S-<id> --expected-version 1 --request-file fix.json
miosotis source ignore S-<id> --reason "wrong dataset"         # or include
miosotis remove S-<id> --confirm                               # to the trash (restorable)
miosotis trash empty                                           # permanent: shows a plan, then --confirm --plan <id>
miosotis artifact list
miosotis artifact open A-<id>                                  # refresh the status banner, open in the browser
miosotis artifact export A-<id> --format md
miosotis undo                                                  # take back the last save (trash; restorable)
miosotis repair                                                # clean up leftovers of interrupted work (lists first)
```

The AI host (the miosotis Skill in Claude Code or Codex) supplies the intelligence and calls these with JSON on stdin (`--request-file -`):

```bash
miosotis enrich pending --json                                 # backlog of unenriched Sources
miosotis enrich prepare S-<id> --json                          # bounded text + input digest
miosotis enrich apply --request-file - --json                  # miosotis.enrichment.v1 (including schedule events)
miosotis search "meeting notes" --json                         # candidates, any language
miosotis table query --request-file - --save --json            # deterministic counts/sums over extracted tables → dataset T-…
miosotis evidence prepare --request-file - --json              # pin hits/refs/quotes → handles c1…cN
miosotis artifact create --request-file - --json               # Markdown citing [@cN]
miosotis artifact create --request-file - --derived-from A-<id> [--supersedes]   # regenerate
```

- Agent JSON is validated; the core assigns IDs, times, hashes, and citation handles, and rejects citations outside the evidence run.
- `miosotis review|analysis|discuss` need an AI model. Until v0.5 the AI host does this work; without one, these commands say so instead of pretending.

## Data and configuration

- Home: `~/.miosotis` (override with `MIOSOTIS_HOME`), containing `config.toml`. See `config.example.toml`.
- Library: `data_dir` (default `~/.miosotis/data`). It is self-contained and can be moved whole, but keep the **live** library on a local disk. Do not put it in a live-synced folder (OneDrive, iCloud, Dropbox); use `[backup].dir` for cloud copies.

## Limits

- The bare CLI has no model: saved text stays `enrichment pending` until an AI host applies enrichment.
- PDFs, spreadsheets, and web pages are read by the AI host with its own tools. miosotis stores the originals, records what was extracted and how, and calculates numbers itself.
- Retrieval is keyword-based (any language). How well it finds paraphrases depends on the host's query variants and the multilingual enrichment terms.
- Structural citation checks prove that a citation points at pinned evidence, not that the sentence is supported by it.
- Claude Code and Codex are both live-tested. There is no HTTP server or Web UI before v0.5.
- Tested on macOS. Linux is expected to work; Windows is untested.

## Releasing

1. Bump `version` in `package.json` and `metadata.version` in `skill/miosotis/SKILL.md` together, add a `DEVLOG.md` entry, then run `pnpm check`.
2. `npm pack` builds `miosotis-<version>.tgz`: `dist`, `skill`, `docs/getting-started.md`, `config.example.toml`, README, and LICENSE. Try it in an isolated prefix: `npm install -g --prefix <tmp> ./miosotis-<version>.tgz`.
3. `npm publish` (with two-factor auth) publishes it.

## More

- [Architecture](architecture.md) · [Data model](data-model.md) · [CLI contract](cli-contract.md) · [Skill](skill.md)
- [Backup and retention](backup-and-retention.md) · [Security](security.md) · [Roadmap](roadmap.md) · [Dogfood](dogfood.md) · `decisions/`
- Change history: `DEVLOG.md`
