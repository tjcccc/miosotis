# Roadmap

Direction agreed with the owner on 2026-09-27. Versions follow SemVer; minor versions are milestones.

| Version | Scope | Status |
|---|---|---|
| 0.1.0 | Text-only vertical slice through the Claude Code Skill: capture, enrichment, search, evidence, frozen artifacts, correction, freshness, regeneration, backup | done |
| 0.1.1 | Assign saved Sources to projects, with explicit exclusions | done |
| 0.1.2 | Rich HTML artifacts: self-contained pages in a no-network sandbox, with a citable summary | done |
| 0.2.0 | Content-addressed file store (shared by inputs and outputs); attachments and images; URL capture with SSRF protection; PDF text; CSV/XLSX with deterministic table operations; artifacts made of several files (images, PDF, Office files built by the host) | next |
| 0.2.x | Deterministic exports of stored content: Markdown → PDF (headless print) and DOCX; tables → CSV/XLSX | planned |
| 0.3.0 | Purge with a reviewable cleanup plan, restore hardening, full security test set, Codex Skill verification | planned |
| 0.4.0 | Local HTTP service over the same use cases; BYOK and local providers via `@priest-ai/core`; standalone `miosotis "…"` with AI | planned |
| later | Web UI; subscription-backed runtime adapter; presentation decks; richer interactive templates | ideas |

## Output formats

- **One artifact, many files.** An artifact is a frozen manifest (intent, evidence run, citations, lineage, live freshness) plus a primary payload and optional supporting files. It always keeps a Markdown summary with `[@cN]` citations, so every format stays searchable, checkable, and readable.
- **Two ways formats come into existence:**
  1. *Exports* are deterministic conversions of stored content made by miosotis. There is no model call, and meaning never changes.
  2. *Host-native files* are built by the AI host (HTML pages, images, Office documents, PDFs). miosotis stores and validates them and shows them safely.
- **Safety per format:**
  - HTML runs only in the sandbox.
  - SVG is sandboxed or converted to PNG.
  - Macro-enabled Office formats and embedded objects are rejected.
  - PDFs with JavaScript are flagged.
- **Rich pages are self-contained by default.** miosotis ships no page libraries; interactive showcases are not core. A page that needs a library embeds it.
- **Planned asset modes** (name agreed 2026-09-27): the artifact request field `"assets"`, mirrored as `artifact create --assets <mode>`.
  - `embedded` (default, today's behavior): everything is inside the page, it works offline, and nothing is fetched.
  - `linked`: the page may load pinned, version-exact libraries and fonts from an allowlist (for example cdnjs, jsdelivr, Google Fonts) when viewed. The sandbox policy then allows only those URLs, and the viewer banner lists the hosts. This suits pages meant for sharing outside miosotis.
  - `localized` (possible later value, after the file store): linked files are downloaded once, hash-pinned per artifact, and served offline.
- **Data showcases:** numbers must trace to rows through deterministic table operations (0.2). The format is only a rendering.
