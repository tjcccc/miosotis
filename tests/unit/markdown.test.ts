import { describe, expect, it } from "vitest";
import { extractCitations, renderMarkdown } from "../../src/infra/render/markdown.js";

describe("citations", () => {
  it("extracts handles in order, once each", () => {
    expect(extractCitations("A [@c2] and [@c1], again [@c2].")).toEqual(["c2", "c1"]);
  });

  it("ignores code spans, fenced code, escapes, and malformed handles", () => {
    const markdown = ["`[@c9]`", "```", "[@c8]", "```", "\\[@c7]", "[@c0] [@x1] [@c]", "real [@c3]"].join("\n\n");
    expect(extractCitations(markdown)).toEqual(["c3"]);
  });

  it("finds citations inside emphasis, lists, and tables", () => {
    const markdown = "- *see [@c1]*\n\n| a | b |\n|---|---|\n| x [@c2] | y |";
    expect(extractCitations(markdown)).toEqual(["c1", "c2"]);
  });
});

describe("renderMarkdown", () => {
  it("shows raw HTML as text and never renders script", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("rejects javascript: links and hardens others", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain('href="javascript');
    expect(renderMarkdown("[x](https://example.com)")).toContain('rel="noopener noreferrer"');
  });

  it("renders citations as in-page links", () => {
    expect(renderMarkdown("claim [@c4]")).toContain('<sup class="cite"><a href="#c4">c4</a></sup>');
  });
});
