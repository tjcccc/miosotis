import type { Command } from "commander";
import { applyEnrichment, pendingEnrichment, prepareEnrichment } from "../../app/enrich.js";
import type { EnrichmentRequestInput } from "../../contracts/enrichment.js";
import { parseInteger, readRequestFile } from "../io.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

export function registerEnrich(program: Command, runtime: CliRuntime): void {
  const enrich = program
    .command("enrich")
    .description("Lightweight AI enrichment, performed by the AI host (host_agent mode)");

  enrich
    .command("pending")
    .description("List Sources whose current revision still needs enrichment (oldest first)")
    .option("--limit <n>", "maximum entries (max 200)", "20")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { limit: string }) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) =>
          pendingEnrichment(context, { limit: parseInteger(options.limit, "--limit") }),
        );
        const lines = result.sources.map(
          (row) => `${row.ref}  ${row.state}  ${row.char_length} chars  ${row.created_at}`,
        );
        lines.push(`${result.sources.length} of ${result.total} pending`);
        return { data: result, human: lines.join("\n") };
      });
    });

  enrich
    .command("prepare")
    .description("Return bounded text, the input digest, and known projects for the host model")
    .argument("<ref>", "S-<id> or S-<id>@v<N> (must be the current revision)")
    .option("--json", "print a JSON result envelope")
    .action(async (ref: string, options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const prepared = inLibrary(runtime, (context) => prepareEnrichment(context, ref));
        return {
          data: prepared,
          human: `${prepared.ref} · ${prepared.provided_chars}/${prepared.total_chars} chars · digest ${prepared.source_ref.input_digest}\n\n${prepared.text}`,
        };
      });
    });

  enrich
    .command("apply")
    .description("Store a miosotis.enrichment.v1 result (validated; never alters the original text)")
    .requiredOption("--request-file <path>", "JSON file, or - for stdin")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { requestFile: string }) => {
      await runCommand(runtime, options.json, async () => {
        const request = (await readRequestFile(options.requestFile)) as EnrichmentRequestInput;
        const receipt = inLibrary(runtime, (context) => applyEnrichment(context, request));
        return {
          data: receipt,
          human: `${receipt.replayed ? "Already enriched" : "Enriched"} ${receipt.ref} (${receipt.state})${receipt.inferred_projects.length > 0 ? ` · inferred ${receipt.inferred_projects.join(", ")}` : ""}`,
          warnings: receipt.warnings,
        };
      });
    });
}
