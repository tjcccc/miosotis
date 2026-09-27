import { z } from "zod";
import { IdempotencyKey } from "./common.js";

export const ENRICHMENT_SCHEMA_VERSION = 1;
export const ENRICHMENT_PIPELINE_VERSION = "enrichment.v1";

const ShortText = (max: number) => z.string().trim().min(1).max(max);

export const Assertion = z
  .object({
    text: ShortText(300).describe("The claim, briefly, in the source's own terms"),
    holder: z
      .enum(["user", "quoted_author", "group", "unknown"])
      .describe("Who asserts it. A quoted article's claim is not the user's belief."),
    modality: z
      .enum(["explicit", "tentative", "quoted", "inferred"])
      .describe("How strongly and directly it is asserted"),
  })
  .strict();

export const EnrichmentRequest = z
  .object({
    schema: z.literal("miosotis.enrichment.v1").optional(),
    idempotency_key: IdempotencyKey.optional(),
    source_ref: z
      .object({
        id: z.string().min(1),
        version: z.number().int().min(1),
        input_digest: z.string().min(1).describe("Copy from `enrich prepare`; binds this result to the exact revision"),
      })
      .strict(),
    title: ShortText(120).optional(),
    abstract: ShortText(600).optional().describe("What the source says, not what it proves"),
    language: z
      .string()
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
      .optional()
      .describe("BCP-47 tag of the main language"),
    terms: z
      .array(ShortText(64))
      .max(24)
      .default([])
      .describe("Retrieval terms. Include useful synonyms and translations in other languages the user may search in."),
    entities: z
      .array(z.object({ name: ShortText(120), type: ShortText(40).optional() }).strict())
      .max(24)
      .default([]),
    project_suggestions: z
      .array(z.string().min(1))
      .max(5)
      .default([])
      .describe("IDs (P-…) of existing projects only; stored as inferred, never overriding explicit membership"),
    assertions: z.array(Assertion).max(10).default([]),
    coverage: z
      .object({
        read_chars: z.number().int().min(0),
        total_chars: z.number().int().min(0),
      })
      .strict()
      .optional()
      .describe("How much of the text was actually read"),
    warnings: z.array(ShortText(300)).max(10).default([]),
    model: ShortText(120)
      .nullable()
      .optional()
      .describe("Model name only if the host reports it reliably; otherwise omit"),
  })
  .strict();

export type EnrichmentRequest = z.infer<typeof EnrichmentRequest>;
export type EnrichmentRequestInput = z.input<typeof EnrichmentRequest>;
