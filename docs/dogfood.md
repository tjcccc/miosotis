# Dogfood scenarios

Real-use checks for the owner and Claude to run through the Skill in Claude Code. Use synthetic or owner-approved content only, and record outcomes in `DEVLOG.md`.

1. Save three short thoughts in different languages. Each receipt shows a real `S-…@v1` and "enrichment complete".
2. Paste a third-party article with a short comment. The article is saved as `imported` with provenance, and the comment separately as your own.
3. Save with a bare `miosotis "…"` in the terminal, then ask Claude to process the backlog.
4. "What did I note about X?" with a paraphrased query in another language. Check that the relevant notes are found.
5. "Review everything in project P this week." Check coverage: every note from that week appears or is explicitly excluded.
6. Ask an analysis question. Check that the answer separates observations from interpretations and attributes quoted claims correctly.
7. Correct a note used by a report. The report stays unchanged, shows a correction notice, and "regenerate" creates a new linked report.
8. Ignore a note. Later reviews exclude it, and older reports show it as unavailable.
9. Open, export, and trash a report with no model involved.
10. Back up to a cloud folder, restore into a temporary folder, and check a report there.
11. (v0.3) "Remove the note about X." The agent previews it, names reports that cite it, and asks. After confirming, the note is in `miosotis trash list`, and "bring it back" restores it.
12. (v0.3) Remove a note together with its report, restore the note, and check that the report came back too.
13. (v0.3) "Empty the trash." The agent shows the plan in plain words (what goes, citing reports, linked items kept, backups unaffected), and deletes only after you agree. The deleted item is gone from search, and a kept report shows "permanently deleted".
14. (v0.3) "Export everything." Open the export's `README.md` and check a note, a file, and a report.
15. (v0.3) Run 11–13 once in Codex (`$miosotis …`) as well.
16. (v0.4) "I have a meeting about X next Monday morning in room Y" (try your own language too). The receipt shows the right date, "morning", and the room, with no invented time.
17. (v0.4) `miosotis schedule`, `--days 14`, `--months 0`, `--from … --to …`: fast, correct ranges. Then ask "How many meetings do I have next week?"
18. (v0.4) "The meeting moved to Tuesday afternoon", then "It's cancelled". The schedule follows each step (`--all` shows the history). Removing the "moved" note brings the original back.
19. (v0.4) A repeating plan ("Every Monday at 09:00 I attend the east region sales meeting", also in your language). `miosotis schedule --days 21` shows three Mondays marked "every Monday". Then skip one date, move one, and end the series; `--all` shows each change.
20. (v0.4) Run 16–19 once in Codex as well.

## Log

- 2026-09-28: The owner ran the v0.4.0 schedule flows live (a weekly plan and a one-time meeting in Chinese, `schedule --days 21`): results good, and the table layout approved.

- 2026-09-28: v0.3.0 through the installed tarball (isolated prefix, temporary HOME and CODEX_HOME), driven by commands rather than a host session.
  - Covered the CLI paths behind items 11–14: remove preview naming the citing report, remove with the report, restore bringing both back, the `trash empty` plan then confirm, gone from search, and export.
- 2026-09-28: The owner ran items 11–15 in live Claude Code and Codex sessions: all OK.

- 2026-09-27: Claude, as the Skill's author, followed `SKILL.md` against the linked CLI on a scratch library.
  - **Run:** scenarios 1 (Chinese, English, Japanese), 2 (imported article with provenance plus a separately saved user comment), 4 (a Chinese query found English notes through multilingual terms), 5, 6, and 7.
  - **Fixed:**
    - Search hits matched only through enrichment terms had empty excerpts. They now show the opening, marked `matched_in: "enrichment"`.
    - Hosts must copy coverage counts rather than count characters (Skill updated).
  - **Not yet tested:** a fresh owner session that discovers the Skill by itself and sees only `SKILL.md`.
