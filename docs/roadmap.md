# Roadmap

Direction agreed with the owner on 2026-09-27. Versions follow SemVer; minor versions are milestones.

| Version | Scope | Status |
|---|---|---|
| 0.1.0 | Text-only vertical slice through the Claude Code Skill: capture, enrichment, search, evidence, frozen artifacts, correction, freshness, regeneration, backup | done |
| 0.1.1 | Assign saved Sources to projects, with explicit exclusions | done |
| 0.1.2 | Rich HTML artifacts: self-contained pages in a no-network sandbox, with a citable summary | done |
| 0.1.3 | `"assets": "linked"` for HTML artifacts: pinned, allowlisted CDN and font URLs, frozen hosts, a network banner | done |
| 0.2.0-alpha.1 | File store, attachments (comment + files as one capture group), text/Markdown extraction, image interpretation by the host, file evidence, backup/doctor with blobs | done |
| 0.2.0-alpha.2 | Host-assisted extraction (`extract apply`): the AI host extracts PDFs, spreadsheets, HTML, and other files with its own tools, and miosotis stores the result as host-extracted text with page/sheet locators. Web links: the host saves the raw HTML plus URL provenance and submits the main text. An importer plugin seam. No new dependencies; miosotis itself stays offline. | done |
| 0.2.0-alpha.3 | Deterministic table operations over host-submitted tables (`table query`, frozen datasets `T-…`, row lineage, ambiguity warnings), monthly-snapshot semantics | done |
| 0.2.0 | Multi-file artifacts (host-built decks, PDFs, images), shareable-release step; release | next |
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
- **Asset modes** (name agreed 2026-09-27; `embedded` and `linked` shipped in 0.1.3): the artifact request field `"assets"`, mirrored as `artifact create --assets <mode>`.
  - `embedded` (default, today's behavior): everything is inside the page, it works offline, and nothing is fetched.
  - `linked`: the page may load pinned, version-exact libraries and fonts from an allowlist (for example cdnjs, jsdelivr, Google Fonts) when viewed. The sandbox policy then allows only those URLs, and the viewer banner lists the hosts. This suits pages meant for sharing outside miosotis.
  - `localized` (possible later value, after the file store): linked files are downloaded once, hash-pinned per artifact, and served offline.
- **Web links (agreed 2026-09-27, 0.2.0-alpha.2):** a saved link becomes a Source that keeps the original URL (requested and final), the fetch time, the raw HTML bytes, and the page's main readable text for search and citation. The host does the fetching and text extraction; miosotis records and verifies. A pixel-faithful page archive (images, CSS, fonts) is not in scope; it could become an explicit option later.
- **Keep miosotis small (owner, 2026-09-27):** format parsing (XLSX, PDF, HTML) and web fetching are left to the AI host, which already has scripts and packages. miosotis stores bytes faithfully, records what was extracted and how, indexes, cites, and calculates. Built-in parsers, if ever needed, come as optional importer plugins.
- **Data showcases:** numbers must trace to rows through deterministic table operations (0.2). The format is only a rendering.
