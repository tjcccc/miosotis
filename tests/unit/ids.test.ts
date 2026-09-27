import { describe, expect, it } from "vitest";
import { formatSourceRef, isId, newId, parseSourceRef } from "../../src/domain/ids.js";
import { canonicalJson } from "../../src/infra/digest.js";

describe("ids", () => {
  it("creates type-prefixed, monotonic ULIDs", () => {
    const a = newId("source");
    const b = newId("source");
    expect(isId("source", a)).toBe(true);
    expect(isId("project", a)).toBe(false);
    expect(a < b).toBe(true);
  });

  it("parses revision references", () => {
    const id = newId("source");
    expect(parseSourceRef(`${id}@v2`)).toEqual({ id, version: 2 });
    expect(parseSourceRef(id.toLowerCase())).toEqual({ id, version: undefined });
    expect(formatSourceRef(id, 3)).toBe(`${id}@v3`);
    expect(() => parseSourceRef("S-123")).toThrow(/valid source ID/);
    expect(() => parseSourceRef(`${id}@v0`)).toThrow(/version/);
  });
});

describe("canonicalJson", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});
