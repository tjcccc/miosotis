import { escapeHtml } from "./markdown.js";

/** Largest host-authored page accepted, in UTF-8 bytes. */
export const MAX_RICH_HTML_BYTES = 5_000_000;

export type AssetMode = "embedded" | "linked";

/**
 * Hosts a `linked` page may load from, and how a URL on each must pin an exact version. Anything else
 * (other hosts, plain http, unpinned or "latest" URLs) is rejected so a stored page cannot silently change.
 */
const LINKED_HOSTS: { host: string; pinned: RegExp | null; note: string }[] = [
  {
    host: "cdnjs.cloudflare.com",
    pinned: /^\/ajax\/libs\/[^/]+\/(?!latest\/)[^/]*\d[^/]*\//,
    note: "/ajax/libs/<lib>/<version>/… (e.g. three.js/r128)",
  },
  { host: "cdn.jsdelivr.net", pinned: /^\/npm\/(?:@[^/]+\/)?[^/@]+@\d[^/]*(?:\/|$)/, note: "/npm/<pkg>@<version>/…" },
  { host: "unpkg.com", pinned: /^\/(?:@[^/]+\/)?[^/@]+@\d[^/]*(?:\/|$)/, note: "/<pkg>@<version>/…" },
  { host: "fonts.googleapis.com", pinned: null, note: "Google Fonts stylesheets" },
  { host: "fonts.gstatic.com", pinned: null, note: "Google Fonts files" },
];

export const LINKED_HOST_NAMES = LINKED_HOSTS.map((entry) => entry.host);

/** Remote references in places that load resources. Plain `<a href>` links are navigation and allowed. */
const RESOURCE_URL_PATTERNS: { label: string; pattern: RegExp }[] = [
  {
    label: "resource attribute",
    pattern:
      /\b(?:src|poster|data|action|formaction|background|xlink:href)\s*=\s*["']?\s*((?:https?:)?\/\/[^\s"'>]+)/gi,
  },
  { label: "srcset", pattern: /\bsrcset\s*=\s*["']([^"']*\/\/[^"']*)["']/gi },
  { label: "stylesheet or link", pattern: /<link\b[^>]*\bhref\s*=\s*["']?\s*((?:https?:)?\/\/[^\s"'>]+)/gi },
  { label: "CSS url()", pattern: /url\(\s*["']?\s*((?:https?:)?\/\/[^\s"')]+)/gi },
  { label: "CSS @import", pattern: /@import\s+(?:url\()?\s*["']?\s*((?:https?:)?\/\/[^\s"');]+)/gi },
  { label: "module import", pattern: /\b(?:import|from)\s*\(?\s*["']((?:https?:)?\/\/[^"']+)["']/gi },
];

const IMPORT_MAP = /<script\b[^>]*\btype\s*=\s*["']?importmap[^>]*>([\s\S]*?)<\/script>/gi;

const FORBIDDEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "a <base> element", pattern: /<base\b/i },
  { label: "a meta refresh", pattern: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i },
];

const DATA_CITE = /\bdata-cite\s*=\s*["']([^"']*)["']/gi;

export interface RichHtmlInspection {
  bytes: number;
  cites: string[];
  /** Validated hosts a `linked` page loads from (always empty for `embedded`). */
  hosts: string[];
  problems: string[];
}

/** Every remote URL the page would load as a resource (including import-map entries). */
export function resourceUrls(html: string): string[] {
  const urls: string[] = [];
  for (const { label, pattern } of RESOURCE_URL_PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      const value = match[1] ?? "";
      const candidates =
        label === "srcset" ? value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "") : [value];
      urls.push(...candidates.filter((candidate) => /^(?:https?:)?\/\//i.test(candidate)));
    }
  }
  for (const block of html.matchAll(IMPORT_MAP)) {
    for (const match of (block[1] ?? "").matchAll(/"((?:https?:)?\/\/[^"]+)"/g)) {
      urls.push(match[1] ?? "");
    }
  }
  return [...new Set(urls)];
}

function checkLinkedUrl(raw: string): { host: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return { problem: `unparseable URL ${JSON.stringify(raw)}` };
  }
  if (url.protocol !== "https:") {
    return { problem: `${raw} must use https` };
  }
  const entry = LINKED_HOSTS.find((candidate) => candidate.host === url.hostname);
  if (entry === undefined) {
    return { problem: `${url.hostname} is not an allowed linked host (allowed: ${LINKED_HOST_NAMES.join(", ")})` };
  }
  if (entry.pinned !== null && !entry.pinned.test(url.pathname)) {
    return { problem: `${raw} must pin an exact version (${entry.note})` };
  }
  return { host: url.hostname };
}

/**
 * Static checks before a page is stored. `embedded` pages must be self-contained; `linked` pages may
 * reference pinned URLs on allowlisted hosts only. The injected CSP remains the real boundary.
 */
export function inspectRichHtml(html: string, assets: AssetMode = "embedded"): RichHtmlInspection {
  const bytes = Buffer.byteLength(html, "utf8");
  const problems: string[] = [];
  const hosts: string[] = [];
  if (bytes > MAX_RICH_HTML_BYTES) {
    problems.push(`page is ${bytes} bytes; the limit is ${MAX_RICH_HTML_BYTES}`);
  }
  const remote = resourceUrls(html);
  if (assets === "embedded") {
    if (remote.length > 0) {
      problems.push(
        `the page loads remote resources (${remote
          .slice(0, 3)
          .map((url) => JSON.stringify(url))
          .join(", ")}): embed them as data: URLs, or use "assets": "linked" with pinned allowlisted URLs`,
      );
    }
  } else {
    for (const url of remote) {
      const result = checkLinkedUrl(url);
      if ("problem" in result) {
        problems.push(result.problem);
      } else if (!hosts.includes(result.host)) {
        hosts.push(result.host);
      }
    }
    if (hosts.includes("fonts.googleapis.com") && !hosts.includes("fonts.gstatic.com")) {
      hosts.push("fonts.gstatic.com");
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
  return { bytes, cites, hosts: hosts.sort(), problems };
}

/**
 * Policy for host-authored pages. The page may run its own inline code, but it can never send data
 * (`connect-src 'none'`), submit forms, or change its base URL. `embedded` pages load nothing remote;
 * `linked` pages may additionally load scripts, styles, fonts, and images from their validated hosts
 * only. A `srcdoc` iframe inherits the embedding page's policy, so the wrapper uses the same policy
 * (the wrapper itself contains no scripts and only escaped text).
 */
export function richContentSecurityPolicy(hosts: string[] = []): string {
  const origins = hosts.map((host) => `https://${host}`).join(" ");
  const extra = origins.length > 0 ? ` ${origins}` : "";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' data:${extra}`,
    `style-src 'unsafe-inline'${extra}`,
    `img-src data: blob:${extra}`,
    `font-src data:${extra}`,
    "media-src data: blob:",
    "worker-src blob:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The default (embedded) policy. */
export const RICH_CONTENT_SECURITY_POLICY = richContentSecurityPolicy();

/**
 * The page as it runs inside the sandbox: the stored HTML with the CSP injected at the top of <head>.
 * The stored payload is unchanged.
 */
export function sandboxedDocument(html: string, hosts: string[] = []): string {
  const injected = `<meta http-equiv="Content-Security-Policy" content="${richContentSecurityPolicy(hosts)}">`;
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
