import type { AppContext } from "../app/context.js";
import { withContext } from "../app/context.js";
import { type CommandResult, emitError, emitResult, type OutputStreams } from "./output/result.js";

export interface CliRuntime {
  env: NodeJS.ProcessEnv;
  streams: OutputStreams;
  now: () => Date;
  exitCode: number;
}

export interface JsonOption {
  json?: boolean;
}

/** Runs one command handler and renders its result or error; never throws. */
export async function runCommand(
  runtime: CliRuntime,
  json: boolean | undefined,
  handler: () => CommandResult | Promise<CommandResult>,
): Promise<void> {
  try {
    const result = await handler();
    runtime.exitCode = emitResult(result, json === true, runtime.streams);
  } catch (error) {
    runtime.exitCode = emitError(error, json === true, runtime.streams);
  }
}

/** Opens the library for the duration of `work`. */
export function inLibrary<T>(runtime: CliRuntime, work: (context: AppContext) => T): T {
  return withContext({ env: runtime.env, now: runtime.now }, work);
}
