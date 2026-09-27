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
    tables: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200).describe("Sheet or table name; unique within this file"),
            locator: TextLocator.optional(),
            columns: z
              .array(z.string().max(300))
              .min(1)
              .max(300)
              .describe("Header texts as in the file (or names you gave when there is no header)"),
            header_row: z.number().int().min(0).default(1).describe("Physical row of the header (0 = no header row)"),
            first_row: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe("Physical row number of rows[0]; defaults to header_row + 1"),
            rows: z
              .array(z.array(z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()])).max(300))
              .max(100_000)
              .describe("Cell values in column order; dates as ISO strings (YYYY-MM-DD); never computed by you"),
            notes: z
              .string()
              .trim()
              .min(1)
              .max(1000)
              .optional()
              .describe("Hidden rows/sheets, merged headers, formula caches, etc."),
          })
          .strict(),
      )
      .max(50)
      .default([])
      .describe("Optional structured tables (spreadsheets, CSV) so miosotis can calculate deterministically"),
    warnings: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const names = new Set<string>();
    value.tables.forEach((table, index) => {
      if (names.has(table.name)) {
        context.addIssue({ code: "custom", path: ["tables", index, "name"], message: "table names must be unique" });
      }
      names.add(table.name);
      if (table.rows.some((row) => row.length > table.columns.length)) {
        context.addIssue({
          code: "custom",
          path: ["tables", index, "rows"],
          message: "a row has more cells than there are columns",
        });
      }
    });
    if (value.tables.reduce((total, table) => total + table.rows.length * table.columns.length, 0) > 2_000_000) {
      context.addIssue({ code: "custom", path: ["tables"], message: "tables exceed 2,000,000 cells in total" });
    }
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
