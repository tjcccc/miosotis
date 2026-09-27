# The miosotis Skill

The Skill (`skill/miosotis/`) is the v0.1 intelligent frontend. The AI host (Claude Code first, then Codex) reads `SKILL.md`, understands the user's intent, and drives the `miosotis` CLI. The CLI owns storage, validation, IDs, and provenance; the Skill contains behavior only, never a second implementation of the rules.

## Install

```bash
npm link                                        # puts `miosotis` on PATH (from the repo)
miosotis init                                   # creates ~/.miosotis
miosotis skill install --host claude-code --yes # symlink ~/.claude/skills/miosotis -> repo skill/miosotis
miosotis skill install --host codex --yes       # symlink ~/.agents/skills/miosotis
miosotis skill status
```

- Claude Code officially supports a personal skill folder that is a symlink to a directory elsewhere (code.claude.com/docs/en/skills). Check discovery with `/skills`. A new session is the reliable way to pick it up; a running session may also detect it.
- The link points into the repository, so edits to the Skill take effect in the next session.
- `skill uninstall --host …` removes only that symlink.
- To avoid a permission prompt for every call, you may allow `Bash(miosotis:*)` in your Claude Code permissions. That choice is yours; the Skill does not grant it.

## What it does

- **Save:** stores the intended text verbatim, then enriches it immediately (title, abstract, multilingual terms, attributed assertions).
- **Review / analysis / discuss:** multilingual query variants and deterministic enumeration for coverage, then exact evidence pins, then a cited Markdown artifact stored as static HTML.
- **Govern:** resolves the exact source, corrects it with an expected-version check, and asks before trash.
- **Regenerate:** new evidence, then a new artifact with `--derived-from` lineage.
- **Rich pages:** self-contained interactive HTML (Canvas, SVG, or an embedded library) built from stored evidence, with a cited Markdown summary, opened in a sandbox.

## Verification status (v0.1.0)

| Host | Status |
|---|---|
| Claude Code | Protocol exercised live on 2026-09-27: Claude followed `SKILL.md` against the linked CLI (save ×3 including an imported article, enrichment, review, analysis, correction, regeneration). Automatic Skill discovery in a fresh session still needs the owner's live test. |
| Codex | Install path implemented (`~/.agents/skills`); not yet verified (planned for v0.3). |

Automated tests cover the protocol with a deterministic fake agent. They say nothing about the semantic quality of real model output.

## Trust boundaries

- Source text is untrusted data. The Skill instructs the host never to follow instructions found in sources, and the CLI's JSON contracts reject anything outside the schema.
- miosotis enforces its own rules (validation, citation ownership, immutability, `--confirm`). It cannot restrict what a full-access host could do on the machine by other means.
