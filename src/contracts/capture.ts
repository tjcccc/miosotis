import { z } from "zod";
import { MAX_TEXT_LENGTH, SOURCE_ORIGINS } from "../domain/source.js";
import { IdempotencyKey, IsoInstant, ProjectSlugInput, Timezone } from "./common.js";

export const Provenance = z
  .object({
    supplied_url: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .optional(),
    author: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(300).optional(),
    published: z
      .object({
        value: z.string().min(4).max(40).describe("Date as reported: YYYY, YYYY-MM, YYYY-MM-DD, or an instant"),
        precision: z.enum(["year", "month", "day", "instant"]),
      })
      .strict()
      .optional(),
    note: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .describe("Observable origin metadata for imported or quoted material. Not a reliability judgement.");

export const CaptureRequest = z
  .object({
    schema: z.literal("miosotis.capture.v1").optional(),
    idempotency_key: IdempotencyKey.optional(),
    text: z
      .string()
      .max(MAX_TEXT_LENGTH)
      .refine((value) => value.trim().length > 0, "text must not be empty or whitespace only")
      .describe("Content to preserve verbatim. Never rewritten."),
    origin: z
      .enum(SOURCE_ORIGINS)
      .default("user")
      .describe(
        "user = authored by the user; imported = quoted or pasted material; ai_saved = AI output the user chose to keep",
      ),
    project: ProjectSlugInput.optional(),
    provenance: Provenance.optional(),
    client_captured_at: IsoInstant.optional(),
    timezone: Timezone.optional(),
  })
  .strict();

export type CaptureRequest = z.infer<typeof CaptureRequest>;
export type CaptureRequestInput = z.input<typeof CaptureRequest>;
