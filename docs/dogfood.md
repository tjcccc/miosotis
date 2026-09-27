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

## Log

- 2026-09-27: Claude, as the Skill's author, followed `SKILL.md` against the linked CLI on a scratch library.
  - **Run:** scenarios 1 (Chinese, English, Japanese), 2 (imported article with provenance plus a separately saved user comment), 4 (a Chinese query found English notes through multilingual terms), 5, 6, and 7.
  - **Fixed:**
    - Search hits matched only through enrichment terms had empty excerpts. They now show the opening, marked `matched_in: "enrichment"`.
    - Hosts must copy coverage counts rather than count characters (Skill updated).
  - **Not yet tested:** a fresh owner session that discovers the Skill by itself and sees only `SKILL.md`.
