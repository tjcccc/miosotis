# Getting started with miosotis

miosotis is a local-first memory for your notes, files, and web links. You talk to it through an AI agent (Claude Code or Codex); miosotis keeps everything on your own computer, faithfully and with citations.

## What you need

- macOS (tested) or Linux (expected to work; not yet verified). Windows is untested.
- [Node.js 24 LTS](https://nodejs.org/).
- Claude Code and/or Codex, signed in.
- Optional but useful: `curl` (saving web links) and `python3` (the agent uses it to read spreadsheets and PDFs). `miosotis doctor` tells you what's available.

## Install

You'll get a file like `miosotis-0.2.1.tgz` from whoever shared miosotis with you:

```bash
npm install -g ./miosotis-0.2.1.tgz
miosotis init --language en           # or ja, zh-CN, …; creates ~/.miosotis
miosotis skill install --host claude-code --yes
miosotis skill install --host codex --yes    # if you use Codex (it also prepares Codex's sandbox)
miosotis doctor
```

Every `skill install` prints exactly what it changed. For Codex, add `--allow-network` if you want to save web links. That flag lets every sandboxed Codex command use the network, not just miosotis.

Start a **new** Claude Code or Codex session afterwards.

## Use it

Talk normally, in any language. Some examples:

- `/miosotis Remember this: today I finished Book A` (Claude Code), or `$miosotis …` (Codex)
- "Save this PDF to the project marketing: /path/to/report.pdf"
- "Save this link: https://example.com/article" (the agent keeps the page's main text and the original URL)
- "When was the last time I had a meeting?"
- "Review my notes in the project marketing from this month" (a report with citations; open it with `miosotis artifact open A-…`)
- "That note is wrong, it should say …" (the old version is kept; reports built on it show a notice)
- Ask to take back the last save, in your own words. The agent shows what it will undo and asks first.

## Your data

- Everything lives in `~/.miosotis` on your computer. miosotis itself never sends anything anywhere. The AI agent you use does read what it works with, under that agent's own terms.
- Back up regularly, and always before updating:
  ```bash
  miosotis backup create --output ~/OneDrive/miosotis-backups   # any folder, a cloud one is fine
  ```
  Keep the live `~/.miosotis` on a local disk, not inside OneDrive or iCloud.
- Removing: ask the agent to remove something and it goes to the trash, where you can look at it (`miosotis trash list`) or bring it back (`miosotis restore <ID>`). Emptying the trash deletes permanently. The agent shows exactly what will go, including reports that quote it, and asks you first. It can't reach backups or copies made earlier.

## Updating

```bash
miosotis backup create --output <folder>
npm install -g ./miosotis-<new>.tgz
miosotis skill install --host claude-code --yes    # refreshes the installed Skill
miosotis skill install --host codex --yes
miosotis doctor
```

The library upgrades itself on first use. Upgrades only go forward, which is why you back up first.
