import type { Command } from "commander";
import { runDoctor } from "../../app/doctor.js";
import { VERSION } from "../../version.js";
import { type CliRuntime, type JsonOption, runCommand } from "../runtime.js";

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

export function registerDoctor(program: Command, runtime: CliRuntime): void {
  program
    .command("doctor")
    .description("Check the runtime, configuration, and library health (never prints content)")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const report = runDoctor({ env: runtime.env, version: VERSION });
        const lines = [
          `miosotis ${report.version} · node ${report.node} · sqlite ${report.sqlite}`,
          `home:     ${report.home}`,
          `data dir: ${report.data_dir}`,
          ...report.checks.map((check) => `[${MARK[check.status]}] ${check.name}: ${check.detail}`),
        ];
        if (report.counts !== null) {
          lines.push(
            `sources: ${report.counts.visible_sources} visible / ${report.counts.sources} total · projects: ${report.counts.projects} · artifacts: ${report.counts.artifacts} · enrichment pending: ${report.counts.enrichment_pending}`,
          );
        }
        return { data: report, human: lines.join("\n"), exitCode: report.ok ? 0 : 1 };
      });
    });
}
