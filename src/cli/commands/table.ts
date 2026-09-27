import type { Command } from "commander";
import { datasetView, queryTables } from "../../app/tables.js";
import type { TableQueryRequestInput } from "../../contracts/table.js";
import type { Cell } from "../../domain/tables.js";
import { readRequestFile } from "../io.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

function renderTable(columns: string[], rows: Cell[][]): string {
  return [
    columns.join("\t"),
    ...rows.map((row) => row.map((cell) => (cell === null ? "" : String(cell))).join("\t")),
  ].join("\n");
}

export function registerTable(program: Command, runtime: CliRuntime): void {
  const table = program.command("table").description("Deterministic calculations over host-extracted tables");

  table
    .command("query")
    .description(
      "Run a miosotis.table-query.v1 request (filters, dedupe, group, aggregates); --save freezes a citable dataset",
    )
    .requiredOption("--request-file <path>", "JSON file, or - for stdin")
    .option("--save", "freeze the result as a dataset (T-…) that evidence and artifacts can cite")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { requestFile: string; save?: boolean }) => {
      await runCommand(runtime, options.json, async () => {
        const body = (await readRequestFile(options.requestFile)) as TableQueryRequestInput;
        const result = inLibrary(runtime, (context) =>
          queryTables(context, { ...body, ...(options.save ? { save: true } : {}) }),
        );
        const lines = [
          renderTable(result.columns, result.rows),
          `${result.rows.length} row(s)${result.dataset_id === null ? "" : ` · saved as ${result.dataset_id}`}`,
        ];
        return { data: result, human: lines.join("\n"), warnings: result.warnings };
      });
    });

  table
    .command("get")
    .description("Show a frozen dataset: spec, inputs (and whether they changed), result, warnings")
    .argument("<T-id>")
    .option("--json", "print a JSON result envelope")
    .action(async (id: string, options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const view = inLibrary(runtime, (context) => datasetView(context, id));
        return {
          data: view,
          human: `${view.id} · ${view.created_at}\n${renderTable(view.columns, view.rows)}`,
          warnings: view.warnings,
        };
      });
    });
}
