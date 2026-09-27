import type { Command } from "commander";
import { type CaptureReceipt, capture } from "../../app/capture.js";
import type { CaptureRequestInput } from "../../contracts/capture.js";
import { MiosotisError } from "../../domain/errors.js";
import { readRequestFile, readStdin } from "../io.js";
import type { CommandResult } from "../output/result.js";
import { type CliRuntime, inLibrary, type JsonOption, runCommand } from "../runtime.js";

export interface SaveOptions extends JsonOption {
  project?: string;
  origin?: string;
  idempotencyKey?: string;
  stdin?: boolean;
  requestFile?: string;
}

export function registerSave(program: Command, runtime: CliRuntime): void {
  program
    .command("save")
    .description("Save text verbatim as a new Source (enrichment stays pending until an AI host applies it)")
    .argument("[text...]", "text to save; use --stdin or --request-file for long or flag-like content")
    .option("--project <slug>", "working context; created if it does not exist")
    .option("--origin <origin>", "user | imported | ai_saved", "user")
    .option("--idempotency-key <key>", "replay-safe key for retries")
    .option("--stdin", "read the text verbatim from stdin")
    .option("--request-file <path>", "read a miosotis.capture.v1 JSON request from a file, or - for stdin")
    .option("--json", "print a JSON result envelope")
    .action(async (words: string[], options: SaveOptions) => {
      await runCommand(runtime, options.json, () => saveAction(runtime, words, options));
    });
}

export async function saveAction(runtime: CliRuntime, words: string[], options: SaveOptions): Promise<CommandResult> {
  const request = await buildCaptureRequest(words, options);
  const receipt = inLibrary(runtime, (context) => capture(context, request, "user"));
  return { data: receipt, human: renderReceipt(receipt) };
}

async function buildCaptureRequest(words: string[], options: SaveOptions): Promise<CaptureRequestInput> {
  const sources = [words.length > 0, options.stdin === true, options.requestFile !== undefined].filter(Boolean).length;
  if (sources !== 1) {
    throw new MiosotisError(
      "usage",
      "Provide the text exactly one way: as arguments, with --stdin, or with --request-file",
    );
  }
  if (options.requestFile !== undefined) {
    const body = await readRequestFile(options.requestFile);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new MiosotisError("validation", "Capture request must be a JSON object");
    }
    return {
      ...(body as CaptureRequestInput),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.idempotencyKey === undefined ? {} : { idempotency_key: options.idempotencyKey }),
    };
  }
  const text = options.stdin === true ? await readStdin() : words.join(" ");
  return {
    text,
    origin: (options.origin ?? "user") as CaptureRequestInput["origin"],
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.idempotencyKey === undefined ? {} : { idempotency_key: options.idempotencyKey }),
  };
}

export function renderReceipt(receipt: CaptureReceipt): string {
  const source = receipt.sources[0];
  if (source === undefined) {
    return "Nothing saved.";
  }
  const project =
    receipt.project === null ? "" : ` · project ${receipt.project.slug}${receipt.project.created ? " (new)" : ""}`;
  return [
    `${receipt.replayed ? "Already saved" : "Saved"} ${source.ref}${project}`,
    `Original text retained (${source.char_length} chars). Enrichment ${source.processing.enrichment}.`,
  ].join("\n");
}
