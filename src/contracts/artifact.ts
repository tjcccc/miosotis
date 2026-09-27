import { z } from "zod";
import { IdempotencyKey } from "./common.js";
import { Intent } from "./evidence.js";

export const ARTIFACT_SCHEMA_VERSION = 1;

export const ArtifactRequest = z
  .object({
    schema: z.literal("miosotis.artifact.v1").optional(),
    idempotency_key: IdempotencyKey.optional(),
    evidence_run_id: z.string().min(1).describe("E-… from `evidence prepare`"),
    intent: Intent,
    title: z.string().trim().min(1).max(200),
    request: z.string().trim().min(1).max(2000).describe("The user's request, verbatim"),
    format: z
      .enum(["markdown", "html"])
      .default("markdown")
      .describe(
        "markdown = the Markdown body is the artifact; html = a self-contained interactive page plus the Markdown summary",
      ),
    markdown: z
      .string()
      .min(1)
      .max(500_000)
      .describe(
        "Body in Markdown (for format=html: the citable summary shown under the page). Cite evidence with [@c3]. Raw HTML is shown as text, never executed.",
      ),
    html: z
      .string()
      .min(1)
      .max(5_000_000)
      .optional()
      .describe(
        'format=html only: a complete, self-contained HTML page. No network: inline all CSS/JS (including any library, e.g. as data: modules in an import map) and embed images and fonts as data: URLs. Mark cited elements with data-cite="c3".',
      ),
    limitations: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    model: z.string().trim().min(1).max(120).nullable().optional(),
    derived_from: z.string().min(1).optional().describe("A-… this artifact regenerates or follows up"),
    supersedes: z.boolean().default(false).describe("Mark derived_from as replaced by this artifact"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.format === "html" && value.html === undefined) {
      context.addIssue({ code: "custom", path: ["html"], message: "format=html requires an html page" });
    }
    if (value.format === "markdown" && value.html !== undefined) {
      context.addIssue({ code: "custom", path: ["html"], message: "html is only accepted with format=html" });
    }
  });

export type ArtifactRequest = z.infer<typeof ArtifactRequest>;
export type ArtifactRequestInput = z.input<typeof ArtifactRequest>;

export const CorrectionRequest = z
  .object({
    schema: z.literal("miosotis.correction.v1").optional(),
    idempotency_key: IdempotencyKey.optional(),
    text: z
      .string()
      .max(1_000_000)
      .refine((value) => value.trim().length > 0, "text must not be empty or whitespace only")
      .describe("The complete corrected text (not a diff)"),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type CorrectionRequestInput = z.input<typeof CorrectionRequest>;
