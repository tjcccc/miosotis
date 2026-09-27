import { z } from "zod";
import { MiosotisError } from "../domain/errors.js";

/** Validates untrusted input (CLI flags, agent JSON) against a contract, with a readable error. */
export function parseContract<S extends z.ZodType>(schema: S, input: unknown, label: string): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new MiosotisError("validation", `Invalid ${label}: ${z.prettifyError(result.error)}`, {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}
