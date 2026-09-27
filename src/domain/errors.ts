/**
 * Stable, machine-readable error codes shared by every interface (CLI today, HTTP later).
 * The code decides the exit status and whether a caller may retry.
 */
export const ERROR_CODES = {
  usage: { exit: 2, retriable: false },
  not_found: { exit: 3, retriable: false },
  ambiguous_reference: { exit: 3, retriable: false },
  conflict: { exit: 4, retriable: false },
  stale_version: { exit: 4, retriable: false },
  busy: { exit: 4, retriable: true },
  validation: { exit: 5, retriable: false },
  confirmation_required: { exit: 5, retriable: false },
  capability_unavailable: { exit: 6, retriable: false },
  library_not_initialized: { exit: 6, retriable: false },
  schema_too_new: { exit: 6, retriable: false },
  environment: { exit: 6, retriable: false },
  internal: { exit: 1, retriable: false },
} as const satisfies Record<string, { exit: number; retriable: boolean }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export class MiosotisError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MiosotisError";
    this.code = code;
    this.details = details;
  }

  get exitCode(): number {
    return ERROR_CODES[this.code].exit;
  }

  get retriable(): boolean {
    return ERROR_CODES[this.code].retriable;
  }
}

export function isMiosotisError(error: unknown): error is MiosotisError {
  return error instanceof MiosotisError;
}
