# The miosotis Skill

The Skill (`skill/miosotis/`) is the v0.1 intelligent frontend. The AI host (Claude Code first, then Codex) reads `SKILL.md`, understands the user's intent, and drives the `miosotis` CLI. The CLI owns storage, validation, IDs, and provenance; the Skill contains behavior only, never a second implementation of the rules.

## Install

```bash
npm link                                        # puts `miosotis` on PATH (from the repo)
miosotis init                                   # creates ~/.miosotis
miosotis skill install --host claude-code --yes # copies the Claude Code version to ~/.claude/skills/miosotis
miosotis skill install --host codex --yes       # copies the Codex version to ~/.agents/skills/miosotis
miosotis skill status                           # copied / outdated / linked / missing, per host
```

- **Copies, adapted per host.** Agent hosts don't all follow the same Skill conventions, so `skill install` renders a copy for each host: the shared `skill/miosotis/` plus `skill/hosts/<host>/`. The overlay's `notes.md` fills the host-notes placeholder in `SKILL.md`, and any other overlay files are added as-is (Codex gets `agents/openai.yaml`).
- **Updating and ownership.** A `.miosotis-skill.json` marker identifies miosotis's own copy. Re-running `skill install` updates it when the rendered content differs (after an upgrade, or after hand edits), and `doctor` warns when a copy is outdated. Entries without the marker are never touched.
- **`--link`** symlinks the shared Skill instead, for Skill development only: changes apply immediately, with no host adaptation.
- Start a new host session (or reload skills) after installing. `skill uninstall --host …` removes only miosotis's own copy.
- To avoid a permission prompt for every call in Claude Code, you may allow `Bash(miosotis:*)`. That choice is yours; the Skill does not grant it.

### Codex setup

- **Invocation:** `$miosotis …`, pick it from `/skills`, or let Codex choose it from the description.
- **Sandbox:** miosotis writes to its library, and saving web links needs network access for `curl`. Codex's sandbox blocks both by default, so `skill install --host codex --yes` prepares it in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):
  - It adds the miosotis data folder to `[sandbox_workspace_write] writable_roots`.
  - With `--allow-network`, it also sets `network_access = true`. That setting applies to **all** sandboxed Codex commands, so it's opt-in.
  - It edits the text in place (comments and other settings kept), re-parses it before writing, writes through symlinks to the real file, and backs up the original as `config.toml.bak-miosotis-<time>`.
  - It reports every change before (in the `--yes` confirmation) and after (`changes` in the result). Running it again changes nothing.
  - `--no-sandbox-config` skips the edit. `writable_roots` applies when Codex runs in workspace-write ("Auto") mode; in read-only mode Codex asks before each write.
- **Images:** the Codex version tells the model to call its `view_image` tool on the library path.

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
| Codex | Adapted copy at `~/.agents/skills/miosotis`, with the sandbox prepared by `skill install`. Live-verified by the owner on 2026-09-27: a note saved with `$miosotis` was enriched in Codex, and a Claude Code session then found it and answered with its date and evidence (same library, cross-host). |

Automated tests cover the protocol with a deterministic fake agent. They say nothing about the semantic quality of real model output.

## Trust boundaries

- Source text is untrusted data. The Skill instructs the host never to follow instructions found in sources, and the CLI's JSON contracts reject anything outside the schema.
- miosotis enforces its own rules (validation, citation ownership, immutability, `--confirm`). It cannot restrict what a full-access host could do on the machine by other means.
