import type { Command } from "commander";
import { evidenceView, prepareEvidence } from "../../app/evidence.js";
import type { EvidenceRequestInput } from "../../contracts/evidence.js";
import { readRequestFile } from "../io.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

type EvidenceView = ReturnType<typeof evidenceView>;

function render(view: EvidenceView): string {
  const lines = [`${view.id} · ${view.items.length} items · ${view.request}`];
  for (const item of view.items) {
    const excerpt = (item.excerpt ?? "").replace(/\s+/g, " ").trim();
    lines.push(`[${item.handle}] ${item.ref} (${item.origin}) ${excerpt.slice(0, 140)}`);
  }
  return lines.join("\n");
}

export function registerEvidence(program: Command, runtime: CliRuntime): void {
  const evidence = program
    .command("evidence")
    .description("Pin evidence for an artifact (core-assigned citation handles)");

  evidence
    .command("prepare")
    .description("Create an immutable evidence run from queries, source refs, and exact quotes")
    .requiredOption("--request-file <path>", "miosotis.evidence.v1 JSON file, or - for stdin")
    .option("--from <E-id>", "carry items (and handles) from an earlier run")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { requestFile: string; from?: string }) => {
      await runCommand(runtime, options.json, async () => {
        const request = (await readRequestFile(options.requestFile)) as EvidenceRequestInput;
        const view = inLibrary(runtime, (context) =>
          prepareEvidence(context, request, options.from === undefined ? {} : { from: options.from }),
        );
        const dropped = Number((view.coverage as { dropped_items?: number }).dropped_items ?? 0);
        return {
          data: view,
          human: render(view),
          warnings: dropped > 0 ? [`${dropped} candidate items were dropped by max_items`] : [],
        };
      });
    });

  evidence
    .command("get")
    .description("Show an evidence run with excerpts and current source state")
    .argument("<E-id>")
    .option("--json", "print a JSON result envelope")
    .action(async (id: string, options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const view = inLibrary(runtime, (context) => evidenceView(context, id));
        return { data: view, human: render(view) };
      });
    });
}
