import markdownIt, { type MarkdownIt, type StateInline, type Token } from "markdown-it";

const CITATION = /^\[@(c[1-9]\d{0,4})\]/;

/**
 * Markdown for artifacts. Raw HTML is disabled (shown as text), unsafe link schemes are rejected by
 * markdown-it's link validation, and `[@cN]` citations become a dedicated token so citations inside
 * code spans or escaped brackets are never counted.
 */
function createRenderer(): MarkdownIt {
  const md = markdownIt({ html: false, linkify: false, typographer: false });
  md.inline.ruler.before("link", "citation", (state: StateInline, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x5b) {
      return false;
    }
    const match = CITATION.exec(state.src.slice(state.pos));
    if (match?.[1] === undefined) {
      return false;
    }
    if (!silent) {
      const token = state.push("citation", "", 0);
      token.meta = { handle: match[1] };
    }
    state.pos += match[0].length;
    return true;
  });
  md.renderer.rules.citation = (tokens, index) => {
    const handle = String((tokens[index]?.meta as { handle?: string } | undefined)?.handle ?? "");
    return `<sup class="cite"><a href="#${handle}">${handle}</a></sup>`;
  };
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    tokens[index]?.attrSet("rel", "noopener noreferrer");
    return defaultLinkOpen(tokens, index, options, env, self);
  };
  return md;
}

const renderer = createRenderer();

/** Citation handles in document order (duplicates removed). */
export function extractCitations(markdown: string): string[] {
  const handles: string[] = [];
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "citation") {
        const handle = (token.meta as { handle: string }).handle;
        if (!handles.includes(handle)) {
          handles.push(handle);
        }
      }
      if (token.children !== null) {
        visit(token.children);
      }
    }
  };
  visit(renderer.parse(markdown, {}));
  return handles;
}

export function renderMarkdown(markdown: string): string {
  return renderer.render(markdown);
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
