import { escapeHtml } from "./markdown.js";

/** No scripts, no remote resources: pages stay readable offline and cannot execute generated code. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --panel: #f6f8fa; --line: #d1d9e0;
  --accent: #0969da; --warn-bg: #fff8c5; --warn-line: #d4a72c; --info-bg: #ddf4ff; --info-line: #54aeff; --mark: #fff1b8; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --panel: #151b23; --line: #3d444d;
  --accent: #4493f8; --warn-bg: #2e2a1a; --warn-line: #9e6a03; --info-bg: #121d2f; --info-line: #1f6feb; --mark: #4d3d05; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); line-height: 1.65;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC",
    "Microsoft YaHei", "Apple SD Gothic Neo", sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.7rem; line-height: 1.3; margin: 0 0 .5rem; }
h2 { font-size: 1.25rem; margin-top: 2rem; border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
h3 { font-size: 1.05rem; }
a { color: var(--accent); }
.meta { color: var(--muted); font-size: .9rem; margin: 0 0 1.5rem; }
.meta span + span::before { content: " · "; }
.status { border: 1px solid var(--info-line); background: var(--info-bg); border-radius: 6px; padding: .75rem 1rem; margin-bottom: 1.5rem; }
.status.warn { border-color: var(--warn-line); background: var(--warn-bg); }
.status ul { margin: .25rem 0 0; padding-left: 1.25rem; }
.status p { margin: 0; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: .35rem .6rem; text-align: left; vertical-align: top; }
th { background: var(--panel); }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
pre { background: var(--panel); padding: .75rem 1rem; border-radius: 6px; overflow-x: auto; }
blockquote { margin: .5rem 0; padding: .25rem 1rem; border-left: 3px solid var(--line); color: var(--muted); white-space: pre-wrap; }
sup.cite a { text-decoration: none; font-size: .75em; padding: 0 .1em; }
.sources li { margin-bottom: .75rem; }
.request { background: var(--panel); border-radius: 6px; padding: .5rem .75rem; }
pre.source { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 1rem; background: none; padding: 0; }
mark { background: var(--mark); color: inherit; }
.rich-frame { margin: 0 0 1.5rem; }
.rich-frame iframe { width: 100%; height: min(80vh, 760px); border: 1px solid var(--line); border-radius: 8px; background: #000; display: block; }
@media print { .status { break-inside: avoid; } a { color: inherit; } }
`;

export function htmlDocument(input: { title: string; lang?: string; body: string; csp?: string }): string {
  return `<!doctype html>
<html lang="${escapeHtml(input.lang ?? "und")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${input.csp ?? CONTENT_SECURITY_POLICY}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(input.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${input.body}
</main>
</body>
</html>
`;
}

export interface CitedItem {
  handle: string;
  ref: string;
  excerpt: string | null;
  sourcePage: string;
}

/**
 * The frozen artifact body. It is rendered once at creation, stored with the artifact, and never
 * regenerated; later viewers only wrap it with a status banner.
 */
export function artifactBody(input: {
  id: string;
  title: string;
  intent: string;
  request: string;
  finalizedAt: string;
  generator: string;
  contentHtml: string;
  limitations: string[];
  cited: CitedItem[];
}): string {
  const limitations =
    input.limitations.length === 0
      ? ""
      : `<section class="limitations"><h2>Limitations</h2><ul>${input.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`;
  const sources =
    input.cited.length === 0
      ? `<section class="sources"><h2>Sources</h2><p>No evidence cited.</p></section>`
      : `<section class="sources"><h2>Sources</h2><ol>${input.cited
          .map(
            (item) =>
              `<li id="${item.handle}"><a href="${escapeHtml(item.sourcePage)}#span-${item.handle}">[${item.handle}] ${escapeHtml(item.ref)}</a>${
                item.excerpt === null
                  ? " <em>(content unavailable)</em>"
                  : `<blockquote>${escapeHtml(item.excerpt)}</blockquote>`
              }</li>`,
          )
          .join("")}</ol></section>`;
  return `<article class="artifact" data-artifact-id="${escapeHtml(input.id)}">
<header>
<h1>${escapeHtml(input.title)}</h1>
<p class="meta"><span>${escapeHtml(input.intent)}</span><span>${escapeHtml(input.id)}</span><span>${escapeHtml(input.finalizedAt)}</span><span>${escapeHtml(input.generator)}</span></p>
<p class="request">${escapeHtml(input.request)}</p>
</header>
<section class="content">
${input.contentHtml}
</section>
${limitations}
${sources}
</article>`;
}

export interface StatusNotice {
  level: "info" | "warn";
  text: string;
}

export function statusBanner(notices: StatusNotice[], checkedAt: string): string {
  if (notices.length === 0) {
    return `<section class="status"><p>Evidence unchanged since this artifact was created (checked ${escapeHtml(checkedAt)}).</p></section>`;
  }
  const level = notices.some((notice) => notice.level === "warn") ? "warn" : "info";
  return `<section class="status ${level}"><p><strong>Provenance status</strong> (checked ${escapeHtml(checkedAt)}). The report below is unchanged.</p><ul>${notices
    .map((notice) => `<li>${escapeHtml(notice.text)}</li>`)
    .join("")}</ul></section>`;
}

/** A source revision page with the evidence spans used by one artifact highlighted. */
export interface SourcePageImage {
  handle: string;
  filename: string;
  mime: string;
  /** Inline data URI (the viewer loads nothing from disk or network), or null when too large. */
  dataUri: string | null;
  interpretation: string | null;
}

export function sourcePage(input: {
  ref: string;
  origin: string;
  receivedAt: string;
  /** Authored text, or extracted text when `textLabel` says so; null when purged or absent. */
  text: string | null;
  textLabel?: string;
  spans: { handle: string; start: number; end: number }[];
  images?: SourcePageImage[];
  backLink: string;
}): string {
  const images = (input.images ?? [])
    .map(
      (image) => `<figure id="span-${image.handle}">
${image.dataUri === null ? `<p><em>${escapeHtml(image.filename)} is too large to embed here; open it from the library.</em></p>` : `<img src="${escapeHtml(image.dataUri)}" alt="${escapeHtml(image.filename)}" style="max-width:100%;height:auto;border-radius:6px">`}
<figcaption>[${escapeHtml(image.handle)}] ${escapeHtml(image.filename)} (${escapeHtml(image.mime)})${image.interpretation === null ? "" : `<br><strong>Interpretation (model-derived, may contain errors):</strong> ${escapeHtml(image.interpretation)}`}</figcaption>
</figure>`,
    )
    .join("\n");
  const label = input.textLabel ?? "original text";
  const body =
    input.text === null
      ? images.length > 0
        ? ""
        : "<p><em>This revision's content was purged.</em></p>"
      : `<pre class="source">${highlight(input.text, input.spans)}</pre>`;
  return htmlDocument({
    title: input.ref,
    body: `<p><a href="${escapeHtml(input.backLink)}">← Back to the artifact</a></p>
<h1>${escapeHtml(input.ref)}</h1>
<p class="meta"><span>${escapeHtml(input.origin)}</span><span>received ${escapeHtml(input.receivedAt)}</span><span>${escapeHtml(label)}</span></p>
${images}
${body}`,
  });
}

function highlight(text: string, spans: { handle: string; start: number; end: number }[]): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  let html = "";
  let cursor = 0;
  let openUntil = -1;
  for (const span of ordered) {
    if (span.start < cursor) {
      continue;
    }
    html += escapeHtml(text.slice(cursor, span.start));
    if (span.start >= openUntil) {
      html += `<mark id="span-${span.handle}">${escapeHtml(text.slice(span.start, span.end))}</mark>`;
      cursor = span.end;
      openUntil = span.end;
    } else {
      html += `<span id="span-${span.handle}"></span>`;
      cursor = span.start;
    }
  }
  html += escapeHtml(text.slice(cursor));
  // Overlapped spans still get an anchor so every citation link resolves.
  const anchored = new Set([...html.matchAll(/id="span-(c\d+)"/g)].map((match) => match[1]));
  const missing = ordered
    .filter((span) => !anchored.has(span.handle))
    .map((span) => `<span id="span-${span.handle}"></span>`);
  return missing.join("") + html;
}
