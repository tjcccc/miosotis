import { describe, expect, it } from "vitest";
import {
  codePointLength,
  foldForSearch,
  isValidSlug,
  normalizeSlug,
  safeSlice,
  splitsSurrogatePair,
} from "../../src/domain/text.js";

describe("foldForSearch", () => {
  it("folds case and Latin diacritics", () => {
    expect(foldForSearch("Café ÜBER Naïve")).toBe("cafe uber naive");
  });

  it("applies compatibility normalization", () => {
    expect(foldForSearch("ＧＰＴ－５")).toBe("gpt-5");
  });

  it("keeps meaningful marks in other scripts", () => {
    expect(foldForSearch("がぎぐ")).toBe("がぎぐ");
    expect(foldForSearch("हिन्दी")).toBe("हिन्दी");
    expect(foldForSearch("한국어")).toBe("한국어");
  });
});

describe("slugs", () => {
  it("normalizes any script into a stable slug", () => {
    expect(normalizeSlug("  My Project / 2026 ")).toBe("my-project-2026");
    expect(normalizeSlug("读书 笔记")).toBe("读书-笔记");
    expect(isValidSlug("读书-笔记")).toBe(true);
    expect(isValidSlug("")).toBe(false);
  });
});

describe("surrogate safety", () => {
  it("never splits a surrogate pair", () => {
    const text = "a🌼b";
    expect(splitsSurrogatePair(text, 2)).toBe(true);
    expect(safeSlice(text, 0, 2)).toBe("a");
    expect(codePointLength(text)).toBe(3);
  });
});
