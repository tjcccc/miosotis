import type { Command } from "commander";
import { applyHostExtraction, pendingExtraction } from "../../app/extract.js";
import type { ExtractionRequestInput } from "../../contracts/extraction.js";
import { parseInteger, readRequestFile } from "../io.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

export function registerExtract(program: Command, runtime: CliRuntime): void {
  const extract = program
    .command("extract")
    .description("Text extracted from files by the AI host (PDF, spreadsheets, HTML, …), recorded as host-extracted");

  extract
    .command("pending")
    .description("List files still waiting for extraction, with their read-only paths")
    .option("--limit <n>", "maximum entries (max 200)", "20")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { limit: string }) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) =>
          pendingExtraction(context, { limit: parseInteger(options.limit, "--limit") }),
        );
        const lines = result.files.map((row) => `${row.ref}  ${row.state}  ${row.filename ?? "file"} (${row.mime})`);
        lines.push(`${result.files.length} of ${result.total} waiting for extraction`);
        return { data: result, human: lines.join("\n") };
      });
    });

  extract
    .command("apply")
    .description("Store a miosotis.extraction.v1 result for one file (the file itself is never changed)")
    .requiredOption("--request-file <path>", "JSON file, or - for stdin")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { requestFile: string }) => {
      await runCommand(runtime, options.json, async () => {
        const request = (await readRequestFile(options.requestFile)) as ExtractionRequestInput;
        const receipt = inLibrary(runtime, (context) => applyHostExtraction(context, request));
        return {
          data: receipt,
          human: `${receipt.replayed ? "Already extracted" : "Extracted"} ${receipt.ref} (${receipt.state}, ${receipt.chars} chars, ${receipt.chunks} chunks)${receipt.replaced === null ? "" : `, replacing ${receipt.replaced}`}`,
        };
      });
    });
}
