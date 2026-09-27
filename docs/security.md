# Security notes (v0.1)

miosotis is a single-user, local tool with no server, no network access, and no telemetry. Its security job is to keep untrusted content inert and every mutation deliberate.

## Untrusted input

- Everything an AI host submits (capture, enrichment, evidence, artifact, correction JSON) is validated at the edge against strict zod contracts. Unknown fields are rejected, and lengths and list sizes are bounded.
- The core, not the model, assigns IDs, timestamps, hashes, and citation handles.
- Source text is stored and returned as data. The Skill tells hosts never to follow instructions found in sources.
- SQL is parameterized, and search terms are escaped for both FTS5 phrases and `LIKE` (`%`, `_`, `\`). The `defensive` flag and foreign keys are asserted on every connection.

## Generated HTML

- Artifact Markdown is rendered with raw HTML disabled, so `<script>` shows as text. Unsafe link schemes (`javascript:`, `vbscript:`, `file:`, non-image `data:`) are rejected, and links get `rel="noopener noreferrer"`.
- Pages carry `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`. They contain no scripts, load no remote assets, and send no referrer.
- Report bodies are frozen at creation. Viewers only add a status banner built from escaped text.

## Filesystem

- Library paths resolve under `data_dir`; derived paths go through a containment check.
- IDs used in file names are validated ULIDs. Writes are atomic (temp file, fsync, rename), with private file modes.
- Backups exclude `config.toml` and any credentials. Restore never writes over a non-empty folder or the live library.

## Deliberate mutations

- `source trash` and `artifact trash` require `--confirm`, and fail with `confirmation_required` instead of prompting.
- `skill install` requires `--yes` and never replaces a foreign entry.
- Corrections require the expected version, so stale edits are conflicts.
- Nothing runs in the background, and nothing sends email, publishes, or schedules.

## Limits

- miosotis enforces its own rules. It cannot stop a full-access AI host from reading or changing files by other means. Hosts must reach the library only through the CLI, as the Skill states.
- Structural citation validation does not prove that a sentence is supported by its source.
- The v0.4 HTTP service must add authentication, Host/Origin checks, and CSRF protection before any exposure beyond loopback.
