import { z } from "zod";

export const EXTRACTION_SCHEMA_VERSION = 1;
export const HOST_EXTRACTION_PIPELINE = "host.v1";
export const MAX_EXTRACTED_CHARS = 2_000_000;

export const TextLocator = z
  .object({
    page: z.number().int().min(1).optional().describe("1-based page number (PDF, slides)"),
    sheet: z.string().trim().min(1).max(200).optional().describe("Spreadsheet sheet name"),
    range: z.string().trim().min(1).max(64).optional().describe("Cell range such as A1:G51"),
    section: z.string().trim().min(1).max(300).optional().describe("Heading or section title"),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "a locator needs at least one field");

export const ExtractionRequest = z
  .object({
    schema: z.literal("miosotis.extraction.v1").optional(),
    source_ref: z
      .object({
        id: z.string().min(1),
        version: z.number().int().min(1),
        payload_sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .describe("sha256 of the file you extracted (from source get)"),
      })
      .strict(),
    method: z
      .object({
        tool: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe('What produced the text, e.g. "pdftotext", "openpyxl", "readability", "manual reading"'),
        version: z.string().trim().min(1).max(60).optional(),
        note: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    text: z
      .string()
      .min(1)
      .max(MAX_EXTRACTED_CHARS)
      .describe("The file's content as text, in reading order. Not a summary: keep the original wording."),
    segments: z
      .array(z.object({ start: z.number().int().min(0), end: z.number().int().min(1), locator: TextLocator }).strict())
      .max(5000)
      .default([])
      .describe(
        "Optional spans of `text` (UTF-16 offsets) with locators, e.g. one per page or sheet; chunks never cross them",
      ),
    coverage: z
      .object({
        complete: z.boolean(),
        note: z.string().trim().min(1).max(500).optional().describe('e.g. "pages 1-20 of 45", "first sheet only"'),
      })
      .strict()
      .default({ complete: true }),
    warnings: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    let previousEnd = 0;
    value.segments.forEach((segment, index) => {
      if (segment.end <= segment.start || segment.end > value.text.length) {
        context.addIssue({
          code: "custom",
          path: ["segments", index],
          message: "segment must satisfy start < end <= text length",
        });
      }
      if (segment.start < previousEnd) {
        context.addIssue({
          code: "custom",
          path: ["segments", index],
          message: "segments must be ordered and must not overlap",
        });
      }
      previousEnd = segment.end;
    });
  });

export type ExtractionRequestInput = z.input<typeof ExtractionRequest>;
