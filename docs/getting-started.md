# Getting started with miosotis

miosotis is a local-first memory for your notes, files, and web links. You talk to it through an AI agent (Claude Code or Codex); miosotis keeps everything on your own computer, faithfully and with citations.

*中文说明见下方。*

## What you need

- macOS (tested) or Linux (expected to work; not yet verified). Windows is untested.
- [Node.js 24 LTS](https://nodejs.org/).
- Claude Code and/or Codex, signed in.
- Optional but useful: `curl` (saving web links) and `python3` (the agent uses it to read spreadsheets and PDFs). `miosotis doctor` tells you what's available.

## Install

You'll get a file like `miosotis-0.2.0.tgz` from whoever shared miosotis with you:

```bash
npm install -g ./miosotis-0.2.0.tgz
miosotis init --language zh-CN        # or en, ja, …; creates ~/.miosotis
miosotis skill install --host claude-code --yes
miosotis skill install --host codex --yes    # if you use Codex (it also prepares Codex's sandbox)
miosotis doctor
```

Every `skill install` prints exactly what it changed. For Codex, add `--allow-network` if you want to save web links. That flag lets every sandboxed Codex command use the network, not just miosotis.

Start a **new** Claude Code or Codex session afterwards.

## Use it

Talk normally, in any language:

- `/miosotis 记一下：今天读完了《陌生》，结尾很震撼` (Claude Code) or `$miosotis …` (Codex)
- "Save this with my notes: /path/to/screenshot.png /path/to/guide.pdf, project Onimusha"
- "记一下这个链接 https://…" (the agent saves the page's main text and the original URL)
- "What did I note about X?" / "我一周目通关是什么时候？"
- "Review everything in project P this month" → a report with citations, opened with `miosotis artifact open A-…`
- "That note is wrong, it should say …" (the old version is kept; reports built on it show a notice)
- "Undo" / "撤销" (takes back the last save)

## Your data

- Everything lives in `~/.miosotis` on your computer. miosotis itself never sends anything anywhere. The AI agent you use does read what it works with, under that agent's own terms.
- Back up regularly, and always before updating:
  ```bash
  miosotis backup create --output ~/OneDrive/miosotis-backups   # any folder, a cloud one is fine
  ```
  Keep the live `~/.miosotis` on a local disk, not inside OneDrive or iCloud.
- Deleting: `ignore` and `trash` are reversible (`include`, `restore`). **Permanent deletion arrives in v0.3**, so for now don't save anything you might need to erase completely.

## Updating

```bash
miosotis backup create --output <folder>
npm install -g ./miosotis-<new>.tgz
miosotis skill install --host claude-code --yes    # refreshes the installed Skill
miosotis skill install --host codex --yes
miosotis doctor
```

The library upgrades itself on first use. Upgrades only go forward, which is why you back up first.

---

## 中文快速上手

miosotis 是一个本地优先的笔记与资料记忆库。你通过 AI 助手（Claude Code 或 Codex）和它对话，所有数据都保存在你自己的电脑上，可追溯、可引用。

1. 安装 Node.js 24，然后执行：
   ```bash
   npm install -g ./miosotis-0.2.0.tgz
   miosotis init --language zh-CN
   miosotis skill install --host claude-code --yes
   miosotis skill install --host codex --yes     # 使用 Codex 时；加 --allow-network 才能保存网页链接
   miosotis doctor
   ```
2. 重新打开 Claude Code 或 Codex，直接说话即可，例如：
   - `/miosotis 记一下：……`（Codex 里用 `$miosotis`）
   - 「把这张截图和这份攻略存起来：/路径/a.png /路径/b.pdf，项目 鬼武者」
   - 「我一周目通关是什么时候？」「整理一下这个月关于某某的记录」
   - 「撤销」可以撤回刚才的保存
3. 数据都在 `~/.miosotis`，miosotis 本身不会上传任何内容。请定期备份，更新前一定要备份：`miosotis backup create --output <目录>`。
4. 目前「忽略」和「移到回收站」都可以恢复；**彻底删除要到 v0.3 才提供**，敏感内容请暂时不要存入。
