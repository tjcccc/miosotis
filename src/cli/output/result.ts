import { isMiosotisError, MiosotisError } from "../../domain/errors.js";

export const RESULT_SCHEMA = "miosotis.result.v1";

export interface CommandResult<T = unknown> {
  data: T;
  /** Short human rendering; JSON mode ignores it. */
  human: string;
  warnings?: string[];
  /** Non-zero for results that are valid but unhealthy (e.g. a failing doctor report). */
  exitCode?: number;
}

export interface OutputStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const processStreams: OutputStreams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** JSON mode: exactly one envelope on stdout. Human mode: rendered text on stdout. Returns the exit code. */
export function emitResult(result: CommandResult, json: boolean, streams: OutputStreams): number {
  if (json) {
    streams.stdout(
      `${JSON.stringify({ schema: RESULT_SCHEMA, ok: true, data: result.data, warnings: result.warnings ?? [] })}\n`,
    );
  } else {
    if (result.human.length > 0) {
      streams.stdout(result.human.endsWith("\n") ? result.human : `${result.human}\n`);
    }
    for (const warning of result.warnings ?? []) {
      streams.stderr(`warning: ${warning}\n`);
    }
  }
  return result.exitCode ?? 0;
}

export function emitError(error: unknown, json: boolean, streams: OutputStreams): number {
  const failure = toMiosotisError(error);
  if (json) {
    streams.stdout(
      `${JSON.stringify({
        schema: RESULT_SCHEMA,
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
          retriable: failure.retriable,
          details: failure.details ?? {},
        },
      })}\n`,
    );
  } else {
    streams.stderr(`error: ${failure.message}\n`);
  }
  if (failure.code === "internal" && process.env.MIOSOTIS_DEBUG === "1" && error instanceof Error) {
    streams.stderr(`${error.stack ?? ""}\n`);
  }
  return failure.exitCode;
}

function toMiosotisError(error: unknown): MiosotisError {
  if (isMiosotisError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/i.test(message)) {
    return new MiosotisError("conflict", "The change conflicts with existing data");
  }
  if (/constraint failed|append-only|immutable/i.test(message)) {
    return new MiosotisError("validation", `Rejected by library integrity rules: ${message}`);
  }
  return new MiosotisError("internal", message);
}
