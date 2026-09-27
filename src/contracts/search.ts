import { z } from "zod";
import { Cursor, Limit, ProjectSlugInput } from "./common.js";

export const SearchRequest = z
  .object({
    schema: z.literal("miosotis.search.v1").optional(),
    query: z.string().min(1).max(500).describe("Whitespace-separated terms in any language"),
    project: ProjectSlugInput.optional().describe("Restrict to one project (explicit or inferred membership)"),
    match: z.enum(["all", "any"]).default("all").describe("all = every term must occur somewhere in the source"),
    limit: Limit(100, 20),
    cursor: Cursor.optional(),
  })
  .strict();

export type SearchRequest = z.infer<typeof SearchRequest>;
export type SearchRequestInput = z.input<typeof SearchRequest>;
