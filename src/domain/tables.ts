/**
 * Deterministic table operations: the only way miosotis computes numbers for reports (the model never
 * does the final arithmetic). Pure functions over host-submitted tables; every output row keeps
 * lineage to the physical input rows it came from.
 */

export type Cell = string | number | boolean | null;

export interface InputTable {
  /** Label used in lineage, e.g. `S-…@v1 Worksheet`. */
  label: string;
  /** Sheet or table name, used to build `Sheet!row` locators. */
  sheet: string;
  columns: string[];
  rows: Cell[][];
  /** Physical row number of rows[0] in the original file. */
  firstRow: number;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "is_empty"
  | "not_empty"
  | "between";

export interface Filter {
  column: string;
  op: FilterOp;
  value?: Cell | Cell[] | undefined;
}

export type Grain = "day" | "month" | "year";

export interface GroupKey {
  column: string;
  grain?: Grain | undefined;
  as?: string | undefined;
}

export type AggregateOp = "count" | "count_distinct" | "sum" | "min" | "max" | "avg";

export interface Aggregate {
  op: AggregateOp;
  column?: string | undefined;
  as?: string | undefined;
}

export interface QuerySpec {
  filters: Filter[];
  dedupe?: { by: string[]; keep: "first" | "last" } | undefined;
  group_by: GroupKey[];
  aggregates: Aggregate[];
  select: string[];
  sort: { by: string; dir: "asc" | "desc" }[];
  limit: number;
}

export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  lineage: { rows: string[]; truncated: boolean }[];
  stats: {
    input_rows: number;
    after_filters: number;
    removed_by_dedupe: number;
    output_rows: number;
    truncated_output: boolean;
    per_input: { label: string; rows: number }[];
  };
  warnings: string[];
}

export class TableQueryError extends Error {}

interface Row {
  values: Map<string, Cell>;
  locator: string;
  order: number;
}

const LINEAGE_LIMIT = 50;

export function isEmpty(cell: Cell | undefined): boolean {
  return cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "");
}

export function toNumber(cell: Cell | undefined): number | undefined {
  if (typeof cell === "number" && Number.isFinite(cell)) {
    return cell;
  }
  if (typeof cell === "string" && /^\s*-?\d+(?:[.,]\d+)?\s*$/.test(cell)) {
    return Number(cell.replace(",", "."));
  }
  return undefined;
}

/** Calendar parts of ISO-like dates (YYYY, YYYY-MM, YYYY-MM-DD, YYYY/MM/DD, ISO instants). */
export function dateParts(cell: Cell | undefined): { y: string; m?: string; d?: string } | undefined {
  if (typeof cell !== "string") {
    return undefined;
  }
  const match = /^\s*(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?(?:[T\s].*)?$/.exec(cell);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const pad = (value: string | undefined) => (value === undefined ? undefined : value.padStart(2, "0"));
  const month = pad(match[2]);
  const day = pad(match[3]);
  if (
    (month !== undefined && (Number(month) < 1 || Number(month) > 12)) ||
    (day !== undefined && (Number(day) < 1 || Number(day) > 31))
  ) {
    return undefined;
  }
  return { y: match[1], ...(month === undefined ? {} : { m: month }), ...(day === undefined ? {} : { d: day }) };
}

function grainKey(cell: Cell | undefined, grain: Grain): string | undefined {
  const parts = dateParts(cell);
  if (parts === undefined) {
    return undefined;
  }
  if (grain === "year") {
    return parts.y;
  }
  if (parts.m === undefined) {
    return undefined;
  }
  if (grain === "month") {
    return `${parts.y}-${parts.m}`;
  }
  return parts.d === undefined ? undefined : `${parts.y}-${parts.m}-${parts.d}`;
}

function compare(a: Cell | undefined, b: Cell | undefined): number {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== undefined && nb !== undefined) {
    return na - nb;
  }
  if (isEmpty(a) || isEmpty(b)) {
    return isEmpty(a) === isEmpty(b) ? 0 : isEmpty(a) ? -1 : 1;
  }
  return String(a).localeCompare(String(b));
}

function same(a: Cell | undefined, b: Cell | undefined): boolean {
  if (isEmpty(a) || isEmpty(b)) {
    return isEmpty(a) && isEmpty(b);
  }
  const na = toNumber(a);
  const nb = toNumber(b);
  return na !== undefined && nb !== undefined ? na === nb : String(a) === String(b);
}

function matches(row: Row, filter: Filter): boolean {
  const cell = row.values.get(filter.column);
  const value = filter.value;
  switch (filter.op) {
    case "eq":
      return same(cell, value as Cell);
    case "neq":
      return !same(cell, value as Cell);
    case "in":
      return Array.isArray(value) && value.some((candidate) => same(cell, candidate));
    case "not_in":
      return !(Array.isArray(value) && value.some((candidate) => same(cell, candidate)));
    case "gt":
      return !isEmpty(cell) && compare(cell, value as Cell) > 0;
    case "gte":
      return !isEmpty(cell) && compare(cell, value as Cell) >= 0;
    case "lt":
      return !isEmpty(cell) && compare(cell, value as Cell) < 0;
    case "lte":
      return !isEmpty(cell) && compare(cell, value as Cell) <= 0;
    case "between":
      return (
        Array.isArray(value) &&
        !isEmpty(cell) &&
        compare(cell, value[0] ?? null) >= 0 &&
        compare(cell, value[1] ?? null) <= 0
      );
    case "contains":
      return (
        !isEmpty(cell) &&
        String(cell)
          .toLowerCase()
          .includes(String(value ?? "").toLowerCase())
      );
    case "is_empty":
      return isEmpty(cell);
    case "not_empty":
      return !isEmpty(cell);
  }
}

export function runQuery(inputs: InputTable[], spec: QuerySpec): QueryResult {
  const warnings: string[] = [];
  const known = new Set(inputs.flatMap((table) => table.columns));
  const referenced = [
    ...spec.filters.map((f) => f.column),
    ...(spec.dedupe?.by ?? []),
    ...spec.group_by.map((g) => g.column),
    ...spec.aggregates.flatMap((a) => (a.column === undefined ? [] : [a.column])),
    ...spec.select,
  ];
  const unknown = [...new Set(referenced.filter((column) => !known.has(column)))];
  if (unknown.length > 0) {
    throw new TableQueryError(`Unknown column(s): ${unknown.join(", ")}. Available: ${[...known].join(", ")}`);
  }
  for (const table of inputs) {
    const missing = [...known].filter((column) => !table.columns.includes(column) && referenced.includes(column));
    if (missing.length > 0) {
      warnings.push(`${table.label} has no column ${missing.join(", ")}; those cells count as empty`);
    }
  }
  let order = 0;
  const all: Row[] = inputs.flatMap((table) =>
    table.rows.map((cells, index) => ({
      values: new Map(table.columns.map((column, position) => [column, cells[position] ?? null] as const)),
      locator: `${table.label} ${table.sheet}!${table.firstRow + index}`,
      order: order++,
    })),
  );
  const filtered = all.filter((row) => spec.filters.every((filter) => matches(row, filter)));
  let kept = filtered;
  let removed = 0;
  if (spec.dedupe !== undefined) {
    const byKey = new Map<string, Row>();
    let emptyKeys = 0;
    for (const row of filtered) {
      const parts = spec.dedupe.by.map((column) => row.values.get(column));
      if (parts.some((part) => isEmpty(part))) {
        emptyKeys += 1;
        byKey.set(`\u0000empty:${row.order}`, row);
        continue;
      }
      const key = JSON.stringify(parts.map((part) => toNumber(part) ?? String(part)));
      if (!byKey.has(key) || spec.dedupe.keep === "last") {
        byKey.set(key, row);
      }
    }
    kept = [...byKey.values()].sort((a, b) => a.order - b.order);
    removed = filtered.length - kept.length;
    if (emptyKeys > 0) {
      warnings.push(`${emptyKeys} row(s) have an empty dedupe key and were kept as distinct`);
    }
  } else if (inputs.length > 1) {
    warnings.push(
      `${inputs.length} tables were combined without dedupe; if they are cumulative snapshots, rows repeat across them (set dedupe.by to an event/record key)`,
    );
  }
  const result =
    spec.group_by.length > 0 || spec.aggregates.length > 0
      ? aggregate(kept, spec, warnings)
      : project(kept, spec, known);
  const ordered = sortRows(result, spec.sort, spec.group_by.length);
  const truncatedOutput = ordered.rows.length > spec.limit;
  const limited = ordered.rows.slice(0, spec.limit);
  return {
    columns: ordered.columns,
    rows: limited.map((entry) => entry.cells),
    lineage: limited.map((entry) => ({
      rows: entry.lineage.slice(0, LINEAGE_LIMIT),
      truncated: entry.lineage.length > LINEAGE_LIMIT,
    })),
    stats: {
      input_rows: all.length,
      after_filters: filtered.length,
      removed_by_dedupe: removed,
      output_rows: limited.length,
      truncated_output: truncatedOutput,
      per_input: inputs.map((table) => ({ label: table.label, rows: table.rows.length })),
    },
    warnings,
  };
}

interface OutRow {
  cells: Cell[];
  lineage: string[];
}

function project(rows: Row[], spec: QuerySpec, known: Set<string>): { columns: string[]; rows: OutRow[] } {
  const columns = spec.select.length > 0 ? spec.select : [...known];
  return {
    columns,
    rows: rows.map((row) => ({
      cells: columns.map((column) => row.values.get(column) ?? null),
      lineage: [row.locator],
    })),
  };
}

function aggregate(rows: Row[], spec: QuerySpec, warnings: string[]): { columns: string[]; rows: OutRow[] } {
  const aggregates = spec.aggregates.length > 0 ? spec.aggregates : [{ op: "count" as const }];
  const groups = new Map<string, { key: Cell[]; rows: Row[] }>();
  let undated = 0;
  let emptyGroup = 0;
  for (const row of rows) {
    const key: Cell[] = [];
    let skip = false;
    for (const group of spec.group_by) {
      const cell = row.values.get(group.column);
      if (group.grain !== undefined) {
        const bucket = grainKey(cell, group.grain);
        if (bucket === undefined) {
          skip = true;
          undated += 1;
          break;
        }
        key.push(bucket);
      } else {
        if (isEmpty(cell)) {
          emptyGroup += 1;
        }
        key.push(cell ?? null);
      }
    }
    if (skip) {
      continue;
    }
    const id = JSON.stringify(key);
    const entry = groups.get(id) ?? { key, rows: [] };
    entry.rows.push(row);
    groups.set(id, entry);
  }
  if (undated > 0) {
    warnings.push(`${undated} row(s) had no usable date for grouping and were left out (not counted as zero)`);
  }
  if (emptyGroup > 0) {
    warnings.push(`${emptyGroup} row(s) have an empty grouping value (shown as an empty group)`);
  }
  const skippedNumbers = new Map<string, number>();
  const columns = [
    ...spec.group_by.map(
      (group) => group.as ?? (group.grain === undefined ? group.column : `${group.column} (${group.grain})`),
    ),
    ...aggregates.map((agg) => agg.as ?? (agg.column === undefined ? agg.op : `${agg.op}(${agg.column})`)),
  ];
  const out = [...groups.values()].map((group) => ({
    cells: [
      ...group.key,
      ...aggregates.map((agg): Cell => {
        const values = agg.column === undefined ? [] : group.rows.map((row) => row.values.get(agg.column ?? ""));
        if (agg.op === "count") {
          return agg.column === undefined ? group.rows.length : values.filter((value) => !isEmpty(value)).length;
        }
        if (agg.op === "count_distinct") {
          return new Set(values.filter((value) => !isEmpty(value)).map((value) => String(toNumber(value) ?? value)))
            .size;
        }
        const numbers = values.map(toNumber).filter((value): value is number => value !== undefined);
        const skipped = values.filter((value) => !isEmpty(value) && toNumber(value) === undefined).length;
        if (skipped > 0) {
          skippedNumbers.set(agg.column ?? "", (skippedNumbers.get(agg.column ?? "") ?? 0) + skipped);
        }
        if (numbers.length === 0) {
          return null;
        }
        switch (agg.op) {
          case "sum":
            return roundSum(numbers);
          case "min":
            return Math.min(...numbers);
          case "max":
            return Math.max(...numbers);
          case "avg":
            return roundSum(numbers) / numbers.length;
          default:
            return null;
        }
      }),
    ],
    lineage: group.rows.map((row) => row.locator),
  }));
  for (const [column, count] of skippedNumbers) {
    warnings.push(`${count} non-numeric value(s) in ${column} were skipped by numeric aggregates`);
  }
  return { columns, rows: out };
}

/** Sums with decimal-safe rounding so 0.1 + 0.2 reports as 0.3. */
function roundSum(numbers: number[]): number {
  const decimals = Math.max(0, ...numbers.map((value) => (String(value).split(".")[1] ?? "").length));
  const factor = 10 ** Math.min(decimals, 10);
  return Math.round(numbers.reduce((total, value) => total + Math.round(value * factor), 0)) / factor;
}

function sortRows(
  result: { columns: string[]; rows: OutRow[] },
  sort: QuerySpec["sort"],
  groupKeys: number,
): { columns: string[]; rows: OutRow[] } {
  if (sort.length === 0) {
    // Groups are ordered by their keys; plain selections keep the input order.
    return groupKeys === 0
      ? result
      : { ...result, rows: [...result.rows].sort((a, b) => compareCells(a.cells, b.cells, groupKeys)) };
  }
  const indexes = sort.map((entry) => {
    const index = result.columns.indexOf(entry.by);
    if (index < 0) {
      throw new TableQueryError(`Cannot sort by ${entry.by}; output columns are: ${result.columns.join(", ")}`);
    }
    return { index, dir: entry.dir };
  });
  return {
    ...result,
    rows: [...result.rows].sort((a, b) => {
      for (const { index, dir } of indexes) {
        const difference = compare(a.cells[index], b.cells[index]);
        if (difference !== 0) {
          return dir === "asc" ? difference : -difference;
        }
      }
      return 0;
    }),
  };
}

function compareCells(a: Cell[], b: Cell[], count: number): number {
  for (let index = 0; index < count; index += 1) {
    const difference = compare(a[index], b[index]);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
