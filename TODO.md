# TODO

## Fast capture (discussed 2026-09-28, not scheduled)

Problem: saving through the agent takes 30–80 s per note, measured in the owner's session (a weekly meeting took 1 min 20 s, a one-time meeting 34 s). That's annoying when ideas come one after another. The CLI save itself takes about 100 ms; the rest is the agent's reasoning plus the prepare → enrich round trips.

**Agent-based (a small v0.4.x, mostly Skill wording and docs):**
- **Quick capture in the Skill.**
  - For a plain thought, save it, reply "Saved", and stop.
  - Enrich later in one batch: when the user pauses or says they're done, or before the next search or review.
  - Unenriched notes stay findable by their own words; they only lack translated terms and a summary.
- **Plans are the exception:** a stated meeting or appointment is still enriched right away, because the user expects it on the schedule.
- **Document the instant terminal path:** `miosotis "idea"` (about 100 ms, no AI), optionally with `alias m='miosotis'`. The agent later processes `enrich pending`.
- **Optional, Claude Code only:** hand the backlog to a background subagent, possibly on a faster model (for example Haiku), so the conversation isn't blocked. Check whether Codex has anything similar before relying on it.

**Service-based (v0.5, with BYOK):**
- Capture through the service is a plain save: instant, and possible from a phone.
- **A background enrichment worker** processes new notes with a model the user configures, for example a fast, cheap cloud model or a local one (Ollama). It retries failures, and progress shows in `enrich pending`.
- **Guardrails:**
  - **Opt-in** in config ("no unsolicited agency", and never silently send content to a cloud model).
  - **Only enriches the user's own new notes**, and never regenerates reports.
