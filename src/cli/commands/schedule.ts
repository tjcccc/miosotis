import type { Command } from "commander";
import { listSchedule } from "../../app/schedule.js";
import { MiosotisError } from "../../domain/errors.js";
import { parseInteger } from "../io.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";
import { renderSchedule, type ScheduleFormat } from "../templates/schedule.js";

interface ScheduleCliOptions extends JsonOption {
  days?: string;
  months?: string;
  from?: string;
  to?: string;
  past?: boolean;
  all?: boolean;
  format?: string;
  ids?: boolean;
}

export function registerSchedule(program: Command, runtime: CliRuntime): void {
  program
    .command("schedule")
    .description("List saved arrangements (meetings, appointments); next 7 days by default. No model call.")
    .option("--days <n>", "the next N days, including today")
    .option("--months <n>", "the next N months from today; 0 = the current month")
    .option("--from <date>", "from this date (YYYY-MM-DD)")
    .option("--to <date>", "through this date (YYYY-MM-DD)")
    .option("--past", "look back instead (with --days or --months), through today")
    .option("--all", "also show cancelled and rescheduled entries")
    .option("--format <format>", "table (aligned, for the terminal; default) | md (a Markdown table)", "table")
    .option("--ids", "also show the note and event IDs")
    .option("--json", "print a JSON result envelope")
    .action(async (options: ScheduleCliOptions) => {
      await runCommand(runtime, options.json, () => {
        if (options.format !== "table" && options.format !== "md") {
          throw new MiosotisError("usage", "--format must be table or md");
        }
        const format: ScheduleFormat = options.format;
        const result = inLibrary(runtime, (context) =>
          listSchedule(context, {
            days: options.days === undefined ? undefined : parseInteger(options.days, "--days"),
            months: options.months === undefined ? undefined : parseInteger(options.months, "--months"),
            from: options.from,
            to: options.to,
            past: options.past === true,
            all: options.all === true,
          }),
        );
        return { data: result, human: renderSchedule(result, { format, ids: options.ids === true }) };
      });
    });
}
