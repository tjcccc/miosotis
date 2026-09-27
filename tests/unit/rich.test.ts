import { describe, expect, it } from "vitest";
import {
  inspectRichHtml,
  MAX_RICH_HTML_BYTES,
  RICH_CONTENT_SECURITY_POLICY,
  sandboxedDocument,
  sandboxFrame,
} from "../../src/infra/render/rich.js";

describe("inspectRichHtml", () => {
  it("accepts a self-contained page, including an import map of embedded data: modules", () => {
    const page =
      '<html><head><script type="importmap">{"imports":{"lib":"data:text/javascript;base64,ZXhwb3J0IGNvbnN0IHggPSAxOw=="}}</script></head><body><div data-cite="c1 c2">x</div><span data-cite="c2">y</span><img src="data:image/png;base64,AAA"><script type="module">import { x } from "lib";</script></body></html>';
    expect(inspectRichHtml(page)).toMatchObject({ cites: ["c1", "c2"], problems: [] });
  });

  it("rejects anything that would load from the network", () => {
    const cases = [
      '<img src="https://example.com/a.png">',
      '<script src="//cdn.example.com/x.js"></script>',
      '<link rel="stylesheet" href="https://fonts.example.com/f.css">',
      '<style>body{background:url("https://example.com/bg.jpg")}</style>',
      "<style>@import url(https://example.com/a.css);</style>",
      '<script type="module">import x from "https://esm.sh/x";</script>',
      "<video poster='http://example.com/p.jpg'></video>",
    ];
    for (const page of cases) {
      expect(inspectRichHtml(page).problems.length, page).toBeGreaterThan(0);
    }
    expect(inspectRichHtml('<a href="https://example.com">official site</a>').problems).toEqual([]);
  });

  it("rejects remote import maps, <base>, meta refresh, bad handles, and oversized pages", () => {
    expect(
      inspectRichHtml(
        '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three"}}</script>',
      ).problems.join(),
    ).toMatch(/import map/);
    expect(inspectRichHtml('<base href="/">').problems.join()).toMatch(/base/);
    expect(inspectRichHtml('<meta http-equiv="refresh" content="0">').problems.join()).toMatch(/refresh/);
    expect(inspectRichHtml('<p data-cite="source-1">').problems.join()).toMatch(/invalid data-cite/);
    expect(inspectRichHtml("x".repeat(MAX_RICH_HTML_BYTES + 1)).problems.join()).toMatch(/limit/);
  });
});

describe("sandboxedDocument", () => {
  it("injects the CSP first in <head>, adding a head when the page has none", () => {
    const plain = sandboxedDocument("<html><head><title>t</title></head><body>hi</body></html>");
    expect(plain.indexOf("Content-Security-Policy")).toBeLessThan(plain.indexOf("<title>"));
    expect(sandboxedDocument("<html><body>x</body></html>")).toContain(
      '<html><head><meta http-equiv="Content-Security-Policy"',
    );
    expect(sandboxedDocument("<p>fragment</p>").startsWith("<!doctype html><html><head><meta")).toBe(true);
  });

  it("hosts the page in an opaque-origin iframe with scripts only", () => {
    const frame = sandboxFrame('A "title"', "<p>page</p>");
    expect(frame).toContain('sandbox="allow-scripts"');
    expect(frame).not.toContain("allow-same-origin");
    expect(frame).toContain('srcdoc="&lt;p&gt;page&lt;/p&gt;"');
    expect(RICH_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
  });
});
