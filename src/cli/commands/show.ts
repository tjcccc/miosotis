import type { Command } from "commander";
import { showLibrary } from "../../app/show.js";
import { parseInteger } from "../io.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";
import { renderShow } from "../templates/show.js";

interface ShowCliOptions extends JsonOption {
  project?: string;
  today?: boolean;
  days?: string;
  from?: string;
  to?: string;
  limit?: string;
  cursor?: string;
}

export function registerShow(program: Command, runtime: CliRuntime): void {
  program
    .command("show")
    .description("Look back at what you saved: recent notes, one note by ID, or notes matching words. No model call.")
    .argument("[words...]", "an S-… ID to open that note, or words to search for")
    .option("--project <slug>", "only this project's notes")
    .option("--today", "notes saved today")
    .option("--days <n>", "notes saved in the last N days, including today")
    .option("--from <date>", "notes saved on or after this date (YYYY-MM-DD)")
    .option("--to <date>", "notes saved on or before this date (YYYY-MM-DD)")
    .option("--limit <n>", "how many to list (default 20)")
    .option("--cursor <cursor>", "continue from a previous page")
    .option("--json", "print a JSON result envelope")
    .action(async (words: string[], options: ShowCliOptions) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) =>
          showLibrary(context, {
            words,
            project: options.project,
            today: options.today === true,
            days: options.days === undefined ? undefined : parseInteger(options.days, "--days"),
            from: options.from,
            to: options.to,
            limit: options.limit === undefined ? undefined : parseInteger(options.limit, "--limit"),
            cursor: options.cursor,
          }),
        );
        return { data: result, human: renderShow(result) };
      });
    });
}
