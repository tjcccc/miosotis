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

## Rich HTML artifacts (host-authored pages)

- Pages must be self-contained. The page is untrusted code, so it is stored verbatim and only ever shown inside `<iframe sandbox="allow-scripts">`. There is no `allow-same-origin`, so the page gets an opaque origin: no access to the viewer page, cookies, storage, or other files.
- miosotis injects this policy at the top of the page's `<head>`: `default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`. The page cannot fetch, load remote images, or submit forms. A `srcdoc` frame inherits the viewer's policy, so the viewer uses the same one; the viewer itself contains no scripts, only escaped text.
- Before storing, the core rejects pages that reference remote resources (including remote import-map entries) or use `<base>` or meta refresh. miosotis ships no page libraries. This gives honest early feedback; the CSP remains the actual boundary.
- Verified in Chrome on 2026-09-27: in-page `fetch`, a remote image, parent access, and `localStorage` were all blocked, while self-contained Canvas and WebGL pages rendered.
- The status banner and the cited summary live outside the frame, where the page cannot alter them.

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
