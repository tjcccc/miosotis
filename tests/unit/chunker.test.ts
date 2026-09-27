import { describe, expect, it } from "vitest";
import { splitsSurrogatePair } from "../../src/domain/text.js";
import { chunkText } from "../../src/infra/search/chunker.js";

describe("chunkText", () => {
  it("keeps short text whole", () => {
    expect(chunkText("short note")).toEqual([{ ordinal: 0, start: 0, end: 10 }]);
  });

  it("returns no chunks for empty text", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("covers long text contiguously without overlap and prefers paragraph breaks", () => {
    const paragraph = "word ".repeat(200).trim();
    const text = Array.from({ length: 6 }, () => paragraph).join("\n\n");
    const chunks = chunkText(text, 1500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks.at(-1)?.end).toBe(text.length);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index]?.start).toBe(chunks[index - 1]?.end);
    }
    expect(text.slice((chunks[0]?.end ?? 0) - 2, chunks[0]?.end)).toBe("\n\n");
  });

  it("never cuts inside a surrogate pair", () => {
    const text = "🌼".repeat(2000);
    for (const chunk of chunkText(text, 1501)) {
      expect(splitsSurrogatePair(text, chunk.start)).toBe(false);
      expect(splitsSurrogatePair(text, chunk.end)).toBe(false);
    }
  });
});
