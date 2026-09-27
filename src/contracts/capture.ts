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
    final_url: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .optional()
      .describe("Where the supplied URL ended up after redirects"),
    fetched_at: z.iso.datetime({ offset: true }).optional().describe("When the host downloaded the page"),
    fetch_tool: z.string().min(1).max(120).optional().describe('e.g. "curl 8.7"'),
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
      .optional()
      .describe(
        "Content to preserve verbatim. Never rewritten. Optional when attachments are given (it becomes the comment on them).",
      ),
    attachments: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096).describe("Local file path readable by the miosotis CLI"),
            filename: z.string().min(1).max(255).optional().describe("Display name; defaults to the file's base name"),
            origin: z.enum(["imported", "user"]).default("imported").describe("user = the user made this file"),
            provenance: Provenance.optional().describe(
              "Observable origin of this file, e.g. the URL a web page was downloaded from",
            ),
          })
          .strict(),
      )
      .max(20)
      .default([])
      .describe("Files saved with this capture; each becomes its own Source linked from the comment"),
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
  .strict()
  .superRefine((value, context) => {
    const hasText = value.text !== undefined && value.text.trim().length > 0;
    if (!hasText && value.attachments.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "text must not be empty or whitespace only (or attach files)",
      });
    }
    if (value.text !== undefined && value.text.length > 0 && value.text.trim().length === 0) {
      context.addIssue({ code: "custom", path: ["text"], message: "text must not be empty or whitespace only" });
    }
  });

export type CaptureRequest = z.infer<typeof CaptureRequest>;
export type CaptureRequestInput = z.input<typeof CaptureRequest>;
