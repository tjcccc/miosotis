import { describe, expect, it } from "vitest";
import { type InputTable, type QuerySpec, runQuery, TableQueryError } from "../../src/domain/tables.js";

const COLUMNS = ["Event", "Customer", "Installed"];

function snapshot(label: string, rows: string[][]): InputTable {
  return { label, sheet: "Installs", columns: COLUMNS, rows, firstRow: 2 };
}

// Brief scenario H: cumulative monthly snapshots with stable event IDs.
const JAN = snapshot("jan", [
  ["E1", "Acme", "2026-01-05"],
  ["E2", "Beta", "2026-01-20"],
]);
const FEB = snapshot("feb", [...JAN.rows.map((r) => [...(r as string[])]), ["E3", "Acme", "2026-02-10"]]);
const MAR = snapshot("mar", [
  ...FEB.rows.map((r) => [...(r as string[])]),
  ["E4", "Gamma", "2026-03-02"],
  ["E5", "Beta", "2026-03-15"],
]);

function spec(overrides: Partial<QuerySpec>): QuerySpec {
  return { filters: [], group_by: [], aggregates: [], select: [], sort: [], limit: 1000, ...overrides };
}

describe("table engine: cumulative snapshots (scenario H)", () => {
  const monthly = spec({
    group_by: [{ column: "Installed", grain: "month", as: "month" }],
    aggregates: [{ op: "count", as: "new" }],
  });

  it("counts new installations per month by event date after deduping event IDs", () => {
    const result = runQuery([JAN, FEB, MAR], { ...monthly, dedupe: { by: ["Event"], keep: "first" } });
    expect(result.columns).toEqual(["month", "new"]);
    expect(result.rows).toEqual([
      ["2026-01", 2],
      ["2026-02", 1],
      ["2026-03", 2],
    ]);
    expect(result.stats).toMatchObject({ input_rows: 10, removed_by_dedupe: 5 });
    expect(result.lineage[0]?.rows).toEqual(["jan Installs!2", "jan Installs!3"]);
    expect(result.warnings).toEqual([]);
  });

  it("warns instead of silently summing snapshots when no dedupe key is given", () => {
    const naive = runQuery([JAN, FEB, MAR], monthly);
    expect(naive.rows).toEqual([
      ["2026-01", 6],
      ["2026-02", 2],
      ["2026-03", 2],
    ]);
    expect(naive.warnings.join(" ")).toMatch(/without dedupe/);
  });

  it("never reports a missing month as zero and flags undated rows", () => {
    const withGap = snapshot("q", [
      ["E1", "Acme", "2026-01-05"],
      ["E9", "Acme", "2026-03-01"],
      ["E7", "Acme", "unknown"],
    ]);
    const result = runQuery([withGap], monthly);
    expect(result.rows.map((row) => row[0])).toEqual(["2026-01", "2026-03"]);
    expect(result.warnings.join(" ")).toMatch(/no usable date/);
  });
});

describe("table engine: operations", () => {
  const sales: InputTable = {
    label: "s",
    sheet: "Sheet1",
    columns: ["Region", "Amount", "Rep"],
    rows: [
      ["North", 10.1, "a"],
      ["South", "20.2", "b"],
      ["North", 0.2, "b"],
      ["South", "n/a", "a"],
      ["West", null, "c"],
    ],
    firstRow: 2,
  };

  it("filters, groups, and aggregates deterministically with decimal-safe sums", () => {
    const result = runQuery(
      [sales],
      spec({
        filters: [{ column: "Region", op: "in", value: ["North", "South"] }],
        group_by: [{ column: "Region" }],
        aggregates: [
          { op: "sum", column: "Amount", as: "total" },
          { op: "count_distinct", column: "Rep", as: "reps" },
        ],
      }),
    );
    expect(result.rows).toEqual([
      ["North", 10.3, 2],
      ["South", 20.2, 2],
    ]);
    expect(result.warnings.join(" ")).toMatch(/1 non-numeric value/);
  });

  it("selects, sorts, and limits with lineage per row", () => {
    const result = runQuery(
      [sales],
      spec({
        select: ["Rep", "Amount"],
        filters: [{ column: "Amount", op: "not_empty" }],
        sort: [{ by: "Rep", dir: "desc" }],
        limit: 2,
      }),
    );
    expect(result.rows).toEqual([
      ["b", "20.2"],
      ["b", 0.2],
    ]);
    expect(result.lineage.map((l) => l.rows)).toEqual([["s Sheet1!3"], ["s Sheet1!4"]]);
    expect(result.stats.truncated_output).toBe(true);
  });

  it("rejects unknown columns with the available ones", () => {
    expect(() => runQuery([sales], spec({ group_by: [{ column: "Month" }] }))).toThrow(TableQueryError);
    expect(() => runQuery([sales], spec({ group_by: [{ column: "Month" }] }))).toThrow(
      /Available: Region, Amount, Rep/,
    );
  });
});
