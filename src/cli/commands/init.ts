import type { Command } from "commander";
import { initLibrary } from "../../app/init.js";
import { type CliRuntime, type JsonOption, runCommand } from "../runtime.js";

export function registerInit(program: Command, runtime: CliRuntime): void {
  program
    .command("init")
    .description("Create ~/.miosotis (or $MIOSOTIS_HOME), its config file, and the library. Safe to re-run.")
    .option("--data-dir <path>", "library folder to record in a new config file")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { dataDir?: string }) => {
      await runCommand(runtime, options.json, () => {
        const result = initLibrary({
          env: runtime.env,
          ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
        });
        const lines = [
          result.library_created ? "Initialized a new miosotis library." : "miosotis library already initialized.",
          `  config:   ${result.config_file}${result.config_created ? " (created)" : ""}`,
          `  data dir: ${result.data_dir}`,
          `  schema:   v${result.schema_version} (journal ${result.journal_mode})`,
        ];
        return { data: result, human: lines.join("\n") };
      });
    });
}
