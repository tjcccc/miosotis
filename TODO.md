# TODO

## v0.5.0-alpha.5: more worker providers (next; resume after the owner's weekly usage reset, decided 2026-10-17)

Owner's priority: **Ollama** (local) and **ChatGPT-plan sign-in** directly in miosotis. Plain API keys come later.
- **Ollama:** `miosotis enrich worker enable --provider ollama --model <local-model>`. It uses the same worker, prompt, strict output schema, and validation as Codex, and note text never leaves the machine. Check that the chosen local model handles structured output reliably, and report the test result at `enable`.
- **Ollama spike (2026-10-20):** the worker prompt with the strict schema as Ollama `format`, at temperature 0, one run per note. Test notes in Chinese, Korean, and Japanese, each with a relative-date event; reply language `zh-CN`, saved on a Tuesday.
  - `gemma4:e4b-mlx` (15–18 s per note): all answers valid, but 2 of 3 event dates were wrong. It added no translated terms to the Korean and Japanese notes, and set `language: "zh-CN"` on the Korean one. Too weak to write schedule entries.
  - **`gemma4:12b-mlx` (24–31 s): the suggested default.**
    - Dates right 3/3. `phrase` quoted the time words exactly, and translated terms were added to all three.
    - Flaws: it wrote the Japanese note's title in Chinese and set `language: "zh-CN"` on it, found no entities in that note, and once added an `end` equal to the start.
  - `qwen3.5:9b` (30–33 s): dates right 3/3, but it gave the Korean time as `10:00:00`. Ollama did not enforce the schema's `pattern`, and only the zod check caught it. Every `phrase` was the whole sentence, and the Chinese one gained spaces, so it was not verbatim.
  - **Plan from this:**
    - Keep zod validation after `format`, because Ollama doesn't fully enforce the schema.
    - Add content checks for every provider:
      - the event `phrase` must appear verbatim in the note;
      - the date must match the weekday the phrase names;
      - the `language` field must fit the note's script, or be detected in code instead.
    - Make the `enable` test use a non-English note with a relative date, so weak models fail at setup.
- **ChatGPT-plan sign-in:** a provider that signs in with the user's ChatGPT plan (OAuth) without needing the Codex CLI, probably through `@priest-ai/core`. First confirm that this sign-in is permitted for a third-party app, and how tokens are stored (an ignored local file, never printed).
- **Shared:** `enable` keeps its consent, test, and `[enrich]` write. `status` and `doctor` show each provider's readiness. Docs, the Skill, and the DEVLOG follow.

## Mistyped commands become notes (found 2026-10-20)

`miosotis show S-…` (not a command until v0.5.0-alpha.4) saved "show S-…" as a note and started the worker. A bare save whose first word looks like a command, or whose text is mostly IDs, should probably ask first or suggest the right command. Decide the rule; bare `miosotis "a thought"` must stay instant.

## Background service: not now (decided 2026-10-20)

The worker stays start-on-save (a save starts `enrich run`, which works through all pending notes). No launchd/systemd service: it would add per-OS install, restart-after-upgrade, and standing agency, and it would be rebuilt inside the HTTP service later. When the HTTP service lands, move the worker into it: a retry timer and a warm model come with that process. Done instead in v0.5.0-alpha.3: an atomic worker lock, and a retry hint in `enrich worker status` after an outage.

## Fast capture (discussed 2026-09-28; background worker shipped in v0.5.0-alpha.1)

Done in v0.5.0-alpha.1: the opt-in background worker with Codex as its provider (`miosotis enrich worker enable --provider codex`), and the Skill's "just reply Saved" rule when the worker is on. Still open: more providers for the same worker (see v0.5.0-alpha.5 above).

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
