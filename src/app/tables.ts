import { TableQueryRequest, type TableQueryRequestInput } from "../contracts/table.js";
import { parseContract } from "../contracts/validate.js";
import { MiosotisError } from "../domain/errors.js";
import { assertId, formatSourceRef, newId, parseSourceRef } from "../domain/ids.js";
import { type Cell, type InputTable, type QueryResult, runQuery, TableQueryError } from "../domain/tables.js";
import { recordAudit } from "../infra/db/repos/audit.js";
import { activeDerived, getDerived } from "../infra/db/repos/derived.js";
import { registerBlob } from "./blobs.js";
import { type AppContext, isoNow } from "./context.js";
import { requireSource, requireVersion } from "./sources.js";

interface StoredTable {
  name: string;
  columns: string[];
  rows: Cell[][];
  header_row: number;
  first_row: number;
  locator?: Record<string, unknown> | null;
}

interface ResolvedInput {
  sourceId: string;
  version: number;
  derivationId: string;
  table: StoredTable;
}

function resolveInput(context: AppContext, ref: string, tableName: string | undefined): ResolvedInput {
  const parsed = parseSourceRef(ref);
  const source = requireSource(context, parsed.id);
  if (source.retention !== "retained" || source.inclusion !== "included") {
    throw new MiosotisError(
      "validation",
      `${source.id} is ${source.retention}/${source.inclusion} and cannot be calculated on`,
    );
  }
  const version = parsed.version ?? source.current_version;
  requireVersion(context, source.id, version);
  const extraction = activeDerived(context.db, source.id, version, "extraction");
  const details =
    extraction?.content_json == null
      ? undefined
      : (JSON.parse(extraction.content_json) as { tables_blob?: string | null });
  if (extraction === undefined || details?.tables_blob == null) {
    throw new MiosotisError(
      "validation",
      `${formatSourceRef(source.id, version)} has no extracted tables; submit them with \`extract apply\` (field "tables")`,
    );
  }
  const tables = (JSON.parse(context.blobs.read(details.tables_blob).toString("utf8")) as { tables: StoredTable[] })
    .tables;
  const table =
    tableName === undefined
      ? tables.length === 1
        ? tables[0]
        : undefined
      : tables.find((candidate) => candidate.name === tableName);
  if (table === undefined) {
    throw new MiosotisError(
      "validation",
      tableName === undefined
        ? `${formatSourceRef(source.id, version)} has ${tables.length} tables; name one: ${tables.map((t) => t.name).join(", ")}`
        : `No table ${JSON.stringify(tableName)} in ${formatSourceRef(source.id, version)}; tables: ${tables.map((t) => t.name).join(", ")}`,
    );
  }
  return { sourceId: source.id, version, derivationId: extraction.id, table };
}

function toInputTable(input: ResolvedInput): InputTable {
  return {
    label: formatSourceRef(input.sourceId, input.version),
    sheet: input.table.name,
    columns: input.table.columns,
    rows: input.table.rows,
    firstRow: input.table.first_row,
  };
}

/**
 * Runs an allowlisted, deterministic query over host-extracted tables. With `save`, the spec, the exact
 * inputs, and the result are frozen as a citable dataset. The model never does the final arithmetic.
 */
export function queryTables(context: AppContext, input: TableQueryRequestInput) {
  const request = parseContract(TableQueryRequest, input, "table query");
  const resolved = request.inputs.map((entry) => resolveInput(context, entry.ref, entry.table));
  let result: QueryResult;
  try {
    result = runQuery(resolved.map(toInputTable), {
      filters: request.filters,
      dedupe: request.dedupe,
      group_by: request.group_by,
      aggregates: request.aggregates,
      select: request.select,
      sort: request.sort,
      limit: request.limit,
    });
  } catch (error) {
    if (error instanceof TableQueryError) {
      throw new MiosotisError("validation", error.message);
    }
    throw error;
  }
  const inputs = resolved.map((entry) => ({
    ref: formatSourceRef(entry.sourceId, entry.version),
    table: entry.table.name,
    derivation_id: entry.derivationId,
    rows: entry.table.rows.length,
  }));
  const { save, ...spec } = request;
  if (!save) {
    return { dataset_id: null, spec, inputs, ...result };
  }
  const at = isoNow(context);
  const id = newId("dataset", context.now().getTime());
  const stored = context.blobs.putBytes(Buffer.from(JSON.stringify(result), "utf8"), "dataset.json");
  context.db.transaction(() => {
    registerBlob(context, { ...stored, mime: "application/json" }, at);
    context.db.run(
      "INSERT INTO datasets (id, spec_json, result_blob, row_count, warnings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, JSON.stringify(spec), stored.sha256, result.rows.length, JSON.stringify(result.warnings), at],
    );
    resolved.forEach((entry, ordinal) => {
      context.db.run(
        "INSERT INTO dataset_inputs (dataset_id, ordinal, source_id, version, derivation_id, table_name) VALUES (?, ?, ?, ?, ?, ?)",
        [id, ordinal, entry.sourceId, entry.version, entry.derivationId, entry.table.name],
      );
    });
    recordAudit(context.db, {
      at,
      actor: "agent",
      operation: "dataset.create",
      subjectIds: [id, ...resolved.map((r) => r.sourceId)],
    });
  });
  return { dataset_id: id, spec, inputs, ...result };
}

export interface DatasetRow {
  id: string;
  spec_json: string;
  result_blob: string;
  row_count: number;
  warnings_json: string;
  created_at: string;
}

/** False once a purge removed the dataset (its ID can still appear in pinned evidence). */
export function datasetExists(context: AppContext, id: string): boolean {
  return context.db.get("SELECT 1 AS present FROM datasets WHERE id = ?", [assertId("dataset", id)]) !== undefined;
}

export function requireDataset(context: AppContext, id: string): DatasetRow {
  const datasetId = assertId("dataset", id);
  const row = context.db.get<DatasetRow>("SELECT * FROM datasets WHERE id = ?", [datasetId]);
  if (row === undefined) {
    throw new MiosotisError("not_found", `No dataset ${datasetId}`);
  }
  return row;
}

export function datasetInputs(context: AppContext, id: string) {
  return context.db.all<{ source_id: string; version: number; derivation_id: string; table_name: string }>(
    "SELECT source_id, version, derivation_id, table_name FROM dataset_inputs WHERE dataset_id = ? ORDER BY ordinal",
    [id],
  );
}

/** A frozen dataset with its spec, inputs, result, and whether any input has changed since. */
export function datasetView(context: AppContext, id: string) {
  const row = requireDataset(context, id);
  const result = JSON.parse(context.blobs.read(row.result_blob).toString("utf8")) as QueryResult;
  const inputs = datasetInputs(context, row.id).map((input) => {
    const source = requireSource(context, input.source_id);
    const derivation = getDerived(context.db, input.derivation_id);
    return {
      ref: formatSourceRef(input.source_id, input.version),
      table: input.table_name,
      derivation_id: input.derivation_id,
      current_version: source.current_version,
      retention: source.retention,
      inclusion: source.inclusion,
      extraction_replaced: derivation?.superseded_by != null,
    };
  });
  return {
    id: row.id,
    created_at: row.created_at,
    spec: JSON.parse(row.spec_json) as unknown,
    inputs,
    ...result,
  };
}

/** Plain-text rendering of a dataset's first rows, for excerpts and citations. */
export function datasetExcerpt(context: AppContext, id: string, maxRows = 12): string | null {
  if (!datasetExists(context, id)) {
    return null;
  }
  const view = datasetView(context, id);
  const lines = [
    view.columns.join(" | "),
    ...view.rows.slice(0, maxRows).map((row) => row.map((cell) => (cell === null ? "" : String(cell))).join(" | ")),
  ];
  if (view.rows.length > maxRows) {
    lines.push(`… ${view.rows.length - maxRows} more row(s)`);
  }
  return `[dataset ${view.id}] ${lines.join("\n")}`;
}
