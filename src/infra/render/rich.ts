import { escapeHtml } from "./markdown.js";

/** Largest host-authored page accepted, in UTF-8 bytes. */
export const MAX_RICH_HTML_BYTES = 5_000_000;

/**
 * Policy for host-authored pages. The page may run its own inline code (including libraries it embeds
 * itself, e.g. as `data:` modules in an import map), but it cannot load or send anything over the
 * network, submit forms, or change its base URL. A `srcdoc` iframe inherits the embedding page's policy,
 * so the wrapper uses this same policy (the wrapper itself contains no scripts and only escaped text).
 */
export const RICH_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' data:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const REMOTE_PATTERNS: { label: string; pattern: RegExp }[] = [
  {
    label: "remote resource attribute",
    pattern: /\b(?:src|srcset|poster|data|action|formaction|background|xlink:href)\s*=\s*["']?\s*(?:https?:)?\/\//gi,
  },
  { label: "remote stylesheet or link", pattern: /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//gi },
  { label: "remote CSS url()", pattern: /url\(\s*["']?\s*(?:https?:)?\/\//gi },
  { label: "remote CSS @import", pattern: /@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\//gi },
  { label: "remote module import", pattern: /\b(?:import|from)\s*\(?\s*["'](?:https?:)?\/\//gi },
];

const FORBIDDEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  {
    label: "an import map that points at remote URLs (embed modules as data: URLs)",
    pattern: /<script\b[^>]*\btype\s*=\s*["']?importmap[^>]*>[^<]*?(?:https?:)?\/\//i,
  },
  { label: "a <base> element", pattern: /<base\b/i },
  { label: "a meta refresh", pattern: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i },
];

const DATA_CITE = /\bdata-cite\s*=\s*["']([^"']*)["']/gi;

export interface RichHtmlInspection {
  bytes: number;
  cites: string[];
  problems: string[];
}

/** Static checks that make an offline, sandboxed page likely to work; the CSP is the real boundary. */
export function inspectRichHtml(html: string): RichHtmlInspection {
  const bytes = Buffer.byteLength(html, "utf8");
  const problems: string[] = [];
  if (bytes > MAX_RICH_HTML_BYTES) {
    problems.push(`page is ${bytes} bytes; the limit is ${MAX_RICH_HTML_BYTES}`);
  }
  for (const { label, pattern } of REMOTE_PATTERNS) {
    const match = html.match(pattern);
    if (match !== null) {
      problems.push(
        `${label} (${match
          .slice(0, 3)
          .map((m) => JSON.stringify(m.trim()))
          .join(", ")}): inline or embed assets as data: URLs instead`,
      );
    }
  }
  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(html)) {
      problems.push(`the page contains ${label}`);
    }
  }
  const cites: string[] = [];
  for (const match of html.matchAll(DATA_CITE)) {
    for (const token of (match[1] ?? "").split(/[\s,]+/)) {
      if (/^c[1-9]\d{0,4}$/.test(token) && !cites.includes(token)) {
        cites.push(token);
      } else if (token.length > 0 && !/^c[1-9]\d{0,4}$/.test(token)) {
        problems.push(`invalid data-cite handle ${JSON.stringify(token)}`);
      }
    }
  }
  return { bytes, cites, problems };
}

/**
 * The page as it runs inside the sandbox: the stored HTML with the CSP injected at the top of <head>.
 * The stored payload is unchanged.
 */
export function sandboxedDocument(html: string): string {
  const injected = `<meta http-equiv="Content-Security-Policy" content="${RICH_CONTENT_SECURITY_POLICY}">`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) {
    return `${html.slice(0, head.index + head[0].length)}${injected}${html.slice(head.index + head[0].length)}`;
  }
  const root = /<html\b[^>]*>/i.exec(html);
  if (root !== null) {
    return `${html.slice(0, root.index + root[0].length)}<head>${injected}</head>${html.slice(root.index + root[0].length)}`;
  }
  return `<!doctype html><html><head>${injected}</head><body>${html}</body></html>`;
}

/** The iframe that hosts a rich page: scripts allowed, but an opaque origin with no parent access. */
export function sandboxFrame(title: string, document: string): string {
  return `<section class="rich-frame"><iframe title="${escapeHtml(title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="eager" srcdoc="${escapeHtml(document)}"></iframe></section>`;
}
