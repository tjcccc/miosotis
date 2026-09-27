import { z } from "zod";

const Cell = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);

export const TableQueryRequest = z
  .object({
    schema: z.literal("miosotis.table-query.v1").optional(),
    inputs: z
      .array(
        z
          .object({
            ref: z.string().min(1).describe("S-… file Source with host-extracted tables (current or @vN)"),
            table: z
              .string()
              .min(1)
              .max(200)
              .optional()
              .describe("Table/sheet name; required when the file has several"),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .describe("Tables to combine (rows are unioned by column name)"),
    filters: z
      .array(
        z
          .object({
            column: z.string().min(1),
            op: z.enum([
              "eq",
              "neq",
              "in",
              "not_in",
              "gt",
              "gte",
              "lt",
              "lte",
              "contains",
              "is_empty",
              "not_empty",
              "between",
            ]),
            value: z.union([Cell, z.array(Cell).max(1000)]).optional(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    dedupe: z
      .object({ by: z.array(z.string().min(1)).min(1).max(10), keep: z.enum(["first", "last"]).default("first") })
      .strict()
      .optional()
      .describe("Drop repeated records, e.g. the same event ID across cumulative snapshots"),
    group_by: z
      .array(
        z
          .object({
            column: z.string().min(1),
            grain: z.enum(["day", "month", "year"]).optional().describe("Bucket an ISO date column"),
            as: z.string().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(5)
      .default([]),
    aggregates: z
      .array(
        z
          .object({
            op: z.enum(["count", "count_distinct", "sum", "min", "max", "avg"]),
            column: z.string().min(1).optional(),
            as: z.string().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    select: z.array(z.string().min(1)).max(100).default([]).describe("Columns to return when not aggregating"),
    sort: z
      .array(z.object({ by: z.string().min(1), dir: z.enum(["asc", "desc"]).default("asc") }).strict())
      .max(5)
      .default([]),
    limit: z.number().int().min(1).max(10_000).default(1000),
    save: z.boolean().default(false).describe("Freeze the result as a citable dataset (T-…)"),
    note: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe("What this calculation means, e.g. the grain and why dedupe applies"),
  })
  .strict()
  .superRefine((value, context) => {
    value.aggregates.forEach((aggregate, index) => {
      if (aggregate.op !== "count" && aggregate.column === undefined) {
        context.addIssue({
          code: "custom",
          path: ["aggregates", index, "column"],
          message: `${aggregate.op} needs a column`,
        });
      }
    });
  });

export type TableQueryRequestInput = z.input<typeof TableQueryRequest>;
