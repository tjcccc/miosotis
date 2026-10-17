import type { Command } from "commander";
import { applyEnrichment, pendingEnrichment, prepareEnrichment } from "../../app/enrich.js";
import {
  disableEnrichWorker,
  enableEnrichWorker,
  enrichWorkerStatus,
  runEnrichWorker,
  type WorkerRun,
} from "../../app/worker.js";
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
          (row) => `${row.ref}  ${row.state}  ${row.filename ?? `${row.char_length} chars`}  ${row.created_at}`,
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

  enrich
    .command("run")
    .description("Enrich pending notes now with the background worker (needs `enrich worker enable`)")
    .option("--backlog", "also send notes saved before the worker was enabled")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption & { backlog?: boolean }) => {
      await runCommand(runtime, options.json, async () => {
        const run = await runEnrichWorker({ env: runtime.env, now: runtime.now, backlog: options.backlog === true });
        return { data: run, human: renderRun(run) };
      });
    });

  const worker = enrich
    .command("worker")
    .description("Opt-in background enrichment of new notes by Codex (never on by default)");

  worker
    .command("enable")
    .description("Check Codex, test it on a made-up note, then turn background enrichment on")
    .requiredOption("--provider <provider>", "codex")
    .option("--codex-path <path>", "the Codex executable (default: the first real codex on PATH)")
    .option("--model <model>", "model for Codex to use (default: Codex's default)")
    .option("--reasoning-effort <effort>", "minimal | low | medium | high", "low")
    .option("--yes", "confirm sending new notes to Codex in the background")
    .option("--json", "print a JSON result envelope")
    .action(
      async (
        options: JsonOption & {
          provider: string;
          codexPath?: string;
          model?: string;
          reasoningEffort: string;
          yes?: boolean;
        },
      ) => {
        await runCommand(runtime, options.json, async () => {
          const result = await enableEnrichWorker({
            env: runtime.env,
            provider: options.provider,
            ...(options.codexPath === undefined ? {} : { codexPath: options.codexPath }),
            ...(options.model === undefined ? {} : { model: options.model }),
            reasoningEffort: options.reasoningEffort,
            yes: options.yes === true,
            now: runtime.now(),
          });
          const test = result.test;
          return {
            data: result,
            human: [
              `Background enrichment is on (Codex at ${result.codex_path}${result.model === null ? "" : `, model ${result.model}`}, effort ${result.reasoning_effort}).`,
              `Test on a made-up note: ${test.seconds}s${test.tokens === null ? "" : `, ${test.tokens} tokens`} · "${test.title ?? "untitled"}" · ${test.events} schedule entr${test.events === 1 ? "y" : "ies"}`,
              ...result.changes.map((change) => `  - ${change}`),
              ...(result.backlog > 0
                ? [
                    `${result.backlog} earlier note(s) still wait for enrichment; \`miosotis enrich run --backlog\` sends them to Codex too.`,
                  ]
                : []),
              "New notes are enriched in the background. Turn it off with `miosotis enrich worker disable`.",
            ].join("\n"),
          };
        });
      },
    );

  worker
    .command("status")
    .description("Show the worker's settings, whether Codex is ready, progress, and recent results")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption) => {
      await runCommand(runtime, options.json, async () => {
        const status = await enrichWorkerStatus({ env: runtime.env });
        const lines = status.enabled
          ? [
              `Background enrichment: on (${status.provider}${status.model === null ? "" : `, model ${status.model}`}, effort ${status.reasoning_effort})`,
              `Codex: ${status.codex_path} · ${status.codex_found ? (status.signed_in ? "signed in" : "NOT signed in (run `codex login`)") : "NOT FOUND (run `miosotis enrich worker enable` again)"}`,
              `Worker: ${status.running_pid === null ? "idle" : `running (pid ${status.running_pid})`} · ${status.pending} pending${status.backlog > 0 ? ` (${status.backlog} saved before it was enabled: \`enrich run --backlog\`)` : ""}${status.capped > 0 ? ` (${status.capped} left for the AI host after repeated failures)` : ""}`,
            ]
          : ["Background enrichment: off (`miosotis enrich worker enable --provider codex` turns it on)"];
        for (const entry of status.recent) {
          lines.push(
            `  ${String(entry.at)}  ${String(entry.ref)}  ${String(entry.outcome)}${entry.detail ? `  ${String(entry.detail)}` : ""}`,
          );
        }
        lines.push(`Log: ${status.log_file}`);
        return { data: status, human: lines.join("\n") };
      });
    });

  worker
    .command("disable")
    .description("Turn background enrichment off (pending notes stay pending for the AI host)")
    .option("--json", "print a JSON result envelope")
    .action(async (options: JsonOption) => {
      await runCommand(runtime, options.json, () => {
        const result = disableEnrichWorker({ env: runtime.env });
        return {
          data: result,
          human:
            result.changes.length === 0
              ? "Background enrichment was already off."
              : `Background enrichment is off.\n${result.changes.map((change) => `  - ${change}`).join("\n")}`,
        };
      });
    });
}

function renderRun(run: WorkerRun): string {
  if (!run.ran) {
    return `A worker is already running${run.running_pid === null ? "" : ` (pid ${run.running_pid})`}; it picks up new notes itself.`;
  }
  const lines = run.results.map(
    (result) =>
      `${result.ref}  ${result.outcome}${result.detail === null ? "" : `  ${result.detail}`}  (${result.seconds}s)`,
  );
  const enriched = run.results.filter((result) => result.outcome === "enriched").length;
  lines.push(
    `${enriched} enriched${run.capped > 0 ? ` · ${run.capped} left for the AI host after repeated failures` : ""}`,
  );
  if (run.results.at(-1)?.outcome === "unavailable") {
    lines.push("Stopped: Codex is unavailable. The notes stay pending; the next save or `enrich run` tries again.");
  }
  return lines.join("\n");
}
