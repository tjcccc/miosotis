import type { Command } from "commander";
import { search } from "../../app/search.js";
import type { SearchRequestInput } from "../../contracts/search.js";
import { MiosotisError } from "../../domain/errors.js";
import { parseInteger, readRequestFile } from "../io.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

interface SearchOptions extends JsonOption {
  requestFile?: string;
  project?: string;
  match?: string;
  limit?: string;
  cursor?: string;
}

export function registerSearch(program: Command, runtime: CliRuntime): void {
  program
    .command("search")
    .description("Find candidate Sources for an AI host (any language; terms under 3 characters use a substring scan)")
    .argument("[query...]", "search terms")
    .option("--request-file <path>", "read a miosotis.search.v1 JSON request from a file, or - for stdin")
    .option("--project <slug>", "restrict to one project")
    .option("--match <mode>", "all | any", "all")
    .option("--limit <n>", "page size (max 100)", "20")
    .option("--cursor <cursor>", "continue from a previous page")
    .option("--json", "print a JSON result envelope")
    .action(async (words: string[], options: SearchOptions) => {
      await runCommand(runtime, options.json, async () => {
        let request: SearchRequestInput;
        if (options.requestFile !== undefined) {
          if (words.length > 0) {
            throw new MiosotisError("usage", "Use either query arguments or --request-file, not both");
          }
          request = (await readRequestFile(options.requestFile)) as SearchRequestInput;
        } else {
          request = {
            query: words.join(" "),
            match: options.match as SearchRequestInput["match"],
            limit: parseInteger(options.limit ?? "20", "--limit"),
            ...(options.project === undefined ? {} : { project: options.project }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          };
        }
        const result = inLibrary(runtime, (context) => search(context, request));
        const lines = result.hits.map((hit) => {
          const excerpt = hit.matches[0]?.excerpt.replace(/\s+/g, " ").trim() ?? "";
          return `${hit.ref}  ${hit.title ?? "(untitled)"}\n    ${excerpt.slice(0, 160)}`;
        });
        lines.push(
          `${result.hits.length} of ${result.total} (${result.mode})${result.next_cursor === null ? "" : ` · next: --cursor ${result.next_cursor}`}`,
        );
        return {
          data: result,
          human: lines.join("\n"),
          warnings: result.truncated ? ["substring scan hit its cap; results may be incomplete"] : [],
        };
      });
    });
}
