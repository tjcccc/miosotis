import { z } from "zod";
import { ProjectSlugInput, Timezone } from "./common.js";

export const INTENTS = ["review", "analysis", "discuss"] as const;
export const Intent = z.enum(INTENTS);

export const EvidenceRequest = z
  .object({
    schema: z.literal("miosotis.evidence.v1").optional(),
    request: z.string().trim().min(1).max(2000).describe("The user's request, verbatim"),
    intent: Intent.optional(),
    project: ProjectSlugInput.optional().describe("Scope; defaults to the whole library"),
    interpretation: z
      .object({
        timezone: Timezone.optional(),
        date_from: z.string().max(40).optional(),
        date_to: z.string().max(40).optional(),
        notes: z.string().max(2000).optional().describe("How the request was interpreted (boundaries, assumptions)"),
      })
      .strict()
      .optional(),
    queries: z
      .array(z.string().trim().min(1).max(500))
      .max(12)
      .default([])
      .describe("Search queries (variants, other languages); each hit's matching chunks become items"),
    match: z.enum(["all", "any"]).default("all"),
    per_query_limit: z.number().int().min(1).max(50).default(10),
    source_refs: z
      .array(
        z
          .object({
            ref: z.string().min(1).describe("S-… (current) or S-…@vN"),
            chunk: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([])
      .describe("Pin whole sources (every chunk) or one chunk"),
    quotes: z
      .array(
        z
          .object({
            ref: z.string().min(1),
            quote: z.string().min(1).max(5000).describe("Exact text copied from the source"),
            occurrence: z.number().int().min(1).optional().describe("Which occurrence, when the quote repeats"),
          })
          .strict(),
      )
      .max(100)
      .default([])
      .describe("Pin exact passages you read in full"),
    datasets: z.array(z.string().min(1)).max(20).default([]).describe("Frozen table-query results (T-…) to cite"),
    max_items: z.number().int().min(1).max(200).default(60),
  })
  .strict();

export type EvidenceRequest = z.infer<typeof EvidenceRequest>;
export type EvidenceRequestInput = z.input<typeof EvidenceRequest>;
