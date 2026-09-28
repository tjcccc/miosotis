# Security notes

miosotis is a single-user, local tool with no server, no network access, and no telemetry. Its security job is to keep untrusted content inert and every mutation deliberate.

## Untrusted input

- Everything an AI host submits (capture, enrichment, evidence, artifact, correction JSON) is validated at the edge against strict zod contracts. Unknown fields are rejected, and lengths and list sizes are bounded. Request files and stdin are capped at 64 MiB before parsing.
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
- Before storing, the core rejects pages that use `<base>` or meta refresh. miosotis ships no page libraries.
- **`embedded` (default):** any remote resource reference, including remote import-map entries, is rejected.
- **`linked` (explicit):** only exact-version https URLs on `cdnjs.cloudflare.com`, `cdn.jsdelivr.net/npm`, `unpkg.com`, and Google Fonts are accepted.
  - The validated hosts are frozen with the artifact, and the page's policy allows scripts, styles, fonts, and images from exactly those origins.
  - `connect-src 'none'` still applies, so the page can load but never send data. The viewer banner lists the hosts.
  - Viewing a linked page reveals your IP address to those CDNs, and a CDN outage can break the display. This is the trade-off the user opts into. This gives honest early feedback; the CSP remains the actual boundary.
- Verified in Chrome on 2026-09-27:
  - `embedded`: in-page `fetch`, a remote image, parent access, and `localStorage` were all blocked, while self-contained Canvas and WebGL pages rendered.
  - `linked`: three.js r128 from cdnjs and Google Fonts loaded, while `fetch` to the same allowed host and an image from another host were blocked.
- The status banner and the cited summary live outside the frame, where the page cannot alter them.

## Network and parsing stay with the host

- miosotis makes no network requests and bundles no PDF, spreadsheet, or HTML parser. There is no SSRF surface in miosotis itself.
- The AI host downloads web pages and extracts files with its own tools; the Skill tells it to fetch only URLs the user gave, http(s) only, without cookies or credentials, never local or private addresses, and with time and size limits.
- The raw downloaded bytes are kept verbatim. Extracted text is labeled host-extracted with the tool used, so it is never mistaken for the original.

## Attached files

- The CLI reads attachments from local paths given by the local user or host. The future HTTP service will accept uploaded bytes instead, never server-side paths.
- Files are copied into the library, so moving or deleting the original later doesn't affect the saved copy. Each file is capped at 100 MB, and a capture at 20 files.
- Filenames are display metadata only: miosotis keeps the base name, strips control characters, and caps the length. Storage paths are always the content hash.
- Types are detected from magic bytes (text formats by extension). Nothing is executed. Text is decoded strictly as UTF-8, and anything else is marked `failed` rather than turned into garbled "evidence".
- `source get` exposes a read-only library path so a vision-capable host can look at images. Hosts must never write there.
- Images in artifact source pages are embedded as `data:` URIs (up to 10 MB), so pages still load nothing from disk or the network.

## Artifact output files

- Host-built outputs are stored, never executed.
- Rejected: macro-enabled Office formats (`.docm`, `.xlsm`, `.pptm`, …) and any Office zip containing `vbaProject.bin`; SVG with scripts, event handlers, or `javascript:` URLs; executables and scripts.
- A PDF containing JavaScript, or an Office file with embedded objects, is stored with a warning.
- The artifact page links the files for download; it doesn't embed or open them.

## Filesystem

- Library paths resolve under `data_dir`; derived paths go through a containment check.
- IDs used in file names are validated ULIDs. Writes are atomic (temp file, fsync, rename), with private file modes.
- Backups exclude `config.toml` and any credentials. Restore never writes over a non-empty folder or the live library.

## Permanent deletion

- Only trashed items can be deleted. `trash empty` shows a reviewable plan first and applies it only with `--confirm --plan <id>`, re-checked inside the transaction.
- Citing artifacts outside the selection need an explicit decision (remove them too, or `--keep-artifacts`).
- After a deletion, a raw scan of the library files (database, log, stored files, rendered folders) finds no trace of the content, and the search index holds none of its terms. An integration test enforces this, covering:
  - text, filenames, extraction locators, tables, datasets, and interpretations
  - enrichment, reasons, evidence requests, and artifacts
- Limits: backups, exports, host transcripts, and disk-level remnants (SSD blocks, snapshots) are outside miosotis's reach; the plan says so.

## Deliberate mutations

- `remove`, `source trash`, `artifact trash`, `undo`, restoring everything, and `trash empty` require `--confirm`, and fail with `confirmation_required` instead of prompting.
- `skill install` requires `--yes` and never replaces a foreign entry.
- Corrections require the expected version, so stale edits are conflicts.
- Nothing runs in the background, and nothing sends email, publishes, or schedules.

## Test coverage (brief scenario K)

| Threat | Covered by |
|---|---|
| Traversal paths | `security.test.ts` (hostile output filenames stay in the artifact folder); `files.test.ts` (hostile attachment filenames are metadata only); `containedPath` on every derived path |
| Hostile filenames | `files.test.ts`, `security.test.ts` (escaped in every viewer page) |
| Oversized payloads | `security.test.ts` (64 MiB request cap, checked before reading); `files.test.ts` (100 MB per file); zod bounds on every contract field |
| Malicious source instructions | `security.test.ts` (stored verbatim, no side effects, one JSON envelope); Skill rule: source content is data |
| Raw HTML / script injection | `markdown.test.ts`, `rich.test.ts`, `rich-artifact.test.ts`, `security.test.ts` (titles, text, filenames, requests escaped; CSP on every page) |
| Unsafe URL targets / redirects | Not applicable in the core: miosotis makes no network requests. `security.test.ts` asserts the source has no network code; the Skill bounds what the host may fetch |
| Unauthorized mutations | `security.test.ts` (every removing or deleting command without confirmation changes nothing); `trash.test.ts` (plan ID re-checked); `skill.test.ts` (consent for installs) |
| Cross-origin requests | Not applicable until the v0.5 HTTP service (see below) |
| Secrets in logs or export bundles | `security.test.ts` (a config canary never appears in backups, bundles, doctor output, or errors) |
| Arbitrary SQL / shell | `search.test.ts` (FTS and `LIKE` syntax are literal); `db.test.ts` (defensive flag); `security.test.ts` (no shell execution; the only spawned process is the OS file opener with an argument array) |
| Deleted content left behind | `trash.test.ts` (raw byte scan and FTS segment check after `trash empty`, with negative controls) |

## Limits

- miosotis enforces its own rules. It cannot stop a full-access AI host from reading or changing files by other means. Hosts must reach the library only through the CLI, as the Skill states.
- Structural citation validation does not prove that a sentence is supported by its source.
- The v0.5 HTTP service must add authentication, Host/Origin checks, and CSRF protection before any exposure beyond loopback.
