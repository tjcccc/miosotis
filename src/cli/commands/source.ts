import type { Command } from "commander";
import { changeSourcePolicy, correctSource } from "../../app/governance.js";
import { getSourceView, listSourceViews, sourceHistoryView } from "../../app/sources.js";
import type { CorrectionRequestInput } from "../../contracts/artifact.js";
import { parseInstantOption, parseInteger, parseRange, readRequestFile } from "../io.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

export function registerSource(program: Command, runtime: CliRuntime): void {
  const source = program.command("source").description("Inspect and govern Sources");

  source
    .command("get")
    .description("Show a Source revision with its original text (bounded) and derived annotations")
    .argument("<ref>", "S-<id> or S-<id>@v<N>")
    .option("--range <start:end>", "UTF-16 offset range of the text to return")
    .option("--chunk <n>", "return one chunk by ordinal")
    .option("--max-chars <n>", "maximum characters of text to return", "20000")
    .option("--json", "print a JSON result envelope")
    .action(async (ref: string, options: JsonOption & { range?: string; chunk?: string; maxChars: string }) => {
      await runCommand(runtime, options.json, () => {
        const view = inLibrary(runtime, (context) =>
          getSourceView(context, ref, {
            range: options.range === undefined ? undefined : parseRange(options.range),
            chunk: options.chunk === undefined ? undefined : parseInteger(options.chunk, "--chunk"),
            maxChars: parseInteger(options.maxChars, "--max-chars"),
          }),
        );
        const header = [
          `${view.ref} · ${view.origin} · ${view.retention}/${view.inclusion}${view.version.is_current ? "" : ` · historical (current v${view.current_version})`}`,
          `received ${view.version.received_at}${view.projects.length > 0 ? ` · projects ${view.projects.map((p) => p.slug).join(", ")}` : ""}`,
          `enrichment: ${String((view.processing as Record<string, { state: string }>).enrichment?.state ?? "unknown")}`,
          "",
        ];
        const body = view.text ?? "[content purged]";
        const tail = view.truncated
          ? `\n… truncated (${view.version.char_length} chars total; use --range or --chunk)`
          : "";
        return { data: view, human: `${header.join("\n")}${body}${tail}` };
      });
    });

  source
    .command("list")
    .description("Enumerate Sources newest first (deterministic, paginated; use for coverage checks)")
    .option("--project <slug>", "restrict to one project")
    .option("--since <date>", "created at or after this ISO date/instant")
    .option("--until <date>", "created before this ISO date/instant")
    .option("--limit <n>", "page size (max 200)", "50")
    .option("--cursor <cursor>", "continue from a previous page")
    .option("--all", "include ignored and trashed Sources")
    .option("--json", "print a JSON result envelope")
    .action(
      async (
        options: JsonOption & {
          project?: string;
          since?: string;
          until?: string;
          limit: string;
          cursor?: string;
          all?: boolean;
        },
      ) => {
        await runCommand(runtime, options.json, () => {
          const page = inLibrary(runtime, (context) =>
            listSourceViews(context, {
              project: options.project,
              since: options.since === undefined ? undefined : parseInstantOption(options.since, "--since"),
              until: options.until === undefined ? undefined : parseInstantOption(options.until, "--until"),
              limit: parseInteger(options.limit, "--limit"),
              cursor: options.cursor,
              all: options.all,
            }),
          );
          const lines = page.sources.map(
            (row) =>
              `${row.ref}  ${row.created_at}  ${row.title ?? "(untitled)"}${row.retention !== "retained" || row.inclusion !== "included" ? `  [${row.retention}/${row.inclusion}]` : ""}`,
          );
          lines.push(
            `${page.sources.length} of ${page.total}${page.next_cursor === null ? "" : ` · next: --cursor ${page.next_cursor}`}`,
          );
          return { data: page, human: lines.join("\n") };
        });
      },
    );

  source
    .command("history")
    .description("List every revision of a Source")
    .argument("<ref>", "S-<id>")
    .option("--json", "print a JSON result envelope")
    .action(async (ref: string, options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const history = inLibrary(runtime, (context) => sourceHistoryView(context, ref));
        const lines = history.versions.map(
          (version) =>
            `${version.ref}${version.is_current ? " (current)" : ""}  ${version.reason} by ${version.actor}  ${version.received_at}  ${version.char_length} chars`,
        );
        return { data: history, human: lines.join("\n") };
      });
    });

  source
    .command("correct")
    .description("Append a corrected revision (old revisions and artifacts stay pinned)")
    .argument("<S-id>")
    .requiredOption("--expected-version <n>", "the revision you corrected; a stale value is rejected")
    .requiredOption("--request-file <path>", "miosotis.correction.v1 JSON file, or - for stdin")
    .option("--json", "print a JSON result envelope")
    .action(async (id: string, options: JsonOption & { expectedVersion: string; requestFile: string }) => {
      await runCommand(runtime, options.json, async () => {
        const request = (await readRequestFile(options.requestFile)) as CorrectionRequestInput;
        const receipt = inLibrary(runtime, (context) =>
          correctSource(context, id, parseInteger(options.expectedVersion, "--expected-version"), request),
        );
        const dependents = receipt.dependent_artifacts.length;
        return {
          data: receipt,
          human: `${receipt.replayed ? "Already corrected" : "Corrected"} ${receipt.source_id}: v${receipt.previous_version} → v${receipt.version}. Enrichment pending.${
            dependents > 0
              ? `
${dependents} artifact(s) cite this source; they are unchanged and will show a correction notice.`
              : ""
          }`,
        };
      });
    });

  const policy = (name: "ignore" | "include" | "trash" | "restore", description: string) => {
    const command = source
      .command(name)
      .description(description)
      .argument("<S-id>")
      .option("--json", "print a JSON result envelope");
    if (name === "ignore") {
      command.requiredOption("--reason <text>", "why it should leave default retrieval");
    }
    if (name === "trash") {
      command.option("--confirm", "confirm the action");
    }
    command.action(async (id: string, options: JsonOption & { reason?: string; confirm?: boolean }) => {
      await runCommand(runtime, options.json, () => {
        const result = inLibrary(runtime, (context) =>
          changeSourcePolicy(context, id, name, { reason: options.reason, confirm: options.confirm }),
        );
        const dependents = result.dependent_artifacts.length;
        return {
          data: result,
          human: `${result.changed ? "Updated" : "Unchanged"} ${result.source_id}: ${result.retention}/${result.inclusion}${dependents > 0 ? ` · ${dependents} dependent artifact(s) keep their pinned evidence` : ""}`,
        };
      });
    });
  };
  policy("ignore", "Exclude from default retrieval (content kept; reversible with include)");
  policy("include", "Return an ignored Source to default retrieval");
  policy("trash", "Move to the trash (content kept; reversible with restore)");
  policy("restore", "Restore a trashed Source");
}
