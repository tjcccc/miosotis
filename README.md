# miosotis

**A local-first memory for your notes, files, links, and plans, managed by the AI agent you already use.**

You tell your agent (Claude Code or Codex) what to remember. miosotis keeps it on your own computer, word for word. Later you ask: what did I save, what's on next week, what changed since March. The agent answers from your own material, with citations back to exactly what you saved.

- **Save anything:** thoughts, files, images, and web links. The agent reads PDFs and spreadsheets with its own tools; miosotis keeps the originals and records what was extracted.
- **Ask and review:** answers, reviews, and analyses cite the exact note, page, or spreadsheet cell. Numbers are calculated by miosotis itself, not guessed by the model.
- **Schedule:** mention a meeting or appointment, including repeating ones like "every Monday at 9:00", and it lands on your schedule. `miosotis schedule` lists what's coming instantly.
- **Stay in control:** correct notes (old versions are kept), undo a save, remove to a trash and restore, or delete permanently after reviewing exactly what goes.
- **Your data, your disk:** everything stays in `~/.miosotis`. Back it up, or export everything as plain files.
- **Any language.**

## Install

You need macOS (Linux should work but is untested), [Node.js 24](https://nodejs.org/), and Claude Code and/or Codex.

```bash
npm install -g miosotis
miosotis init --language en                    # your reply language: en, zh-CN, ja, …
miosotis skill install --host claude-code --yes
miosotis skill install --host codex --yes      # if you use Codex (also prepares its sandbox)
miosotis doctor
```

Each `skill install` prints exactly what it changed. Start a **new** Claude Code or Codex session afterwards.

## Use it

Just talk to your agent, in any language. In Claude Code, start with `/miosotis`; in Codex, with `$miosotis`:

- `/miosotis Remember this: today I finished Book A`
- "Save this PDF to the project marketing: /path/to/report.pdf"
- "Save this link: https://example.com/article"
- "I have a meeting about the roadmap next Monday morning in the Tokyo room"
- "Every Monday at 09:00 I attend the sales meeting"
- "How many meetings do I have next week?"
- "Review my notes in the project marketing from this month"
- "That note is wrong, it should say …"
- "Remove the note about Book A" (it goes to the trash; you can bring it back)

The agent always asks before removing or deleting anything.

## Handy commands

These work directly in your terminal, with no AI involved:

```bash
miosotis schedule                     # the next 7 days (--days 14, --months 0, --from 2026-10-01 --to 2026-10-31, --past)
miosotis trash list                   # what's in the trash
miosotis restore S-…                  # bring an item back
miosotis backup create --output ~/OneDrive/miosotis-backups
miosotis export --all --output ~/Desktop   # everything as plain files
miosotis prefs                        # your reply language and timezone
miosotis doctor                       # health check (shows no note content)
```

## Your data

- **Everything lives in `~/.miosotis`** on your computer. miosotis itself never sends anything anywhere; the AI agent you use reads what it works with, under that agent's own terms.
- **Back up regularly,** and always before updating. A cloud folder is fine for backups, but keep the live `~/.miosotis` on a local disk.
- **Removing is reversible; emptying the trash is not.** Emptying the trash can't reach backups or copies made earlier.

## Good to know

- miosotis organizes and retrieves; the intelligence comes from your agent. Plain `miosotis "…"` in the terminal saves a note, and your agent can process it later.
- **No reminders or calendar sync:** it only answers when you ask.
- **Search is keyword-based,** helped by the multilingual terms the agent adds when saving.
- A citation shows where a statement came from; it doesn't prove the statement is right.

## Documentation

- [Getting started](docs/getting-started.md): install, examples, updating, troubleshooting, uninstall
- [Backup, restore, deletion](docs/backup-and-retention.md) · [Security](docs/security.md) · [Roadmap](docs/roadmap.md)
- For developers: [Development](docs/development.md), [architecture](docs/architecture.md), the [CLI contract](docs/cli-contract.md), and the [Skill](docs/skill.md)

## License

GPL-3.0-only. See `LICENSE`.
