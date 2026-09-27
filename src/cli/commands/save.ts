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
  attach?: string[];
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerSave(program: Command, runtime: CliRuntime): void {
  program
    .command("save")
    .description("Save text verbatim as a new Source (enrichment stays pending until an AI host applies it)")
    .argument("[text...]", "text to save; use --stdin or --request-file for long or flag-like content")
    .option("--project <slug>", "working context; created if it does not exist")
    .option("--origin <origin>", "user | imported | ai_saved", "user")
    .option("--idempotency-key <key>", "replay-safe key for retries")
    .option("--attach <path>", "save a local file with it (repeatable); the text becomes the comment", collect, [])
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
  const warnings = looksLikeQuestion(request.text)
    ? ["Saved as a note. To search instead: `miosotis search …`; to take it back: `miosotis undo`."]
    : [];
  return { data: receipt, human: renderReceipt(receipt), warnings };
}

async function buildCaptureRequest(words: string[], options: SaveOptions): Promise<CaptureRequestInput> {
  const attachments = (options.attach ?? []).map((path) => ({ path }));
  const sources = [words.length > 0, options.stdin === true, options.requestFile !== undefined].filter(Boolean).length;
  if (sources > 1 || (sources === 0 && attachments.length === 0)) {
    throw new MiosotisError(
      "usage",
      "Provide the text exactly one way (arguments, --stdin, or --request-file), or attach files with --attach",
    );
  }
  if (options.requestFile !== undefined) {
    const body = await readRequestFile(options.requestFile);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new MiosotisError("validation", "Capture request must be a JSON object");
    }
    const request = body as CaptureRequestInput;
    return {
      ...request,
      ...(attachments.length > 0 ? { attachments: [...(request.attachments ?? []), ...attachments] } : {}),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.idempotencyKey === undefined ? {} : { idempotency_key: options.idempotencyKey }),
    };
  }
  const text = options.stdin === true ? await readStdin() : words.join(" ");
  return {
    ...(text.length > 0 ? { text } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    origin: (options.origin ?? "user") as CaptureRequestInput["origin"],
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.idempotencyKey === undefined ? {} : { idempotency_key: options.idempotencyKey }),
  };
}

/** A saved text that reads like a question was probably meant as a search (the CLI has no model). */
export function looksLikeQuestion(text: string | undefined): boolean {
  return text !== undefined && /[?？]\s*$/u.test(text.trim());
}

export function renderReceipt(receipt: CaptureReceipt): string {
  if (receipt.sources.length === 0) {
    return "Nothing saved.";
  }
  const project =
    receipt.project === null ? "" : ` · project ${receipt.project.slug}${receipt.project.created ? " (new)" : ""}`;
  const verb = receipt.replayed ? "Already saved" : "Saved";
  const lines = [`${verb}${project}`];
  for (const source of receipt.sources) {
    if (source.kind === "file") {
      const states = Object.entries(source.processing)
        .filter(([stage]) => stage !== "enrichment")
        .map(([stage, state]) => `${stage} ${state}`)
        .join(", ");
      lines.push(
        `  ${source.ref}  ${source.filename} (${source.mime}, ${source.size} bytes)${states.length > 0 ? ` · ${states}` : ""}`,
      );
    } else {
      lines.push(`  ${source.ref}  ${source.role} · original text retained (${source.char_length} chars)`);
    }
  }
  lines.push("Enrichment pending until an AI host applies it.");
  return lines.join("\n");
}
