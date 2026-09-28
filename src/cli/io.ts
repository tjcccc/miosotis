import { readFileSync, statSync } from "node:fs";
import { MiosotisError } from "../domain/errors.js";

/** Upper bound for a request file or stdin. Contracts bound each field; this bounds memory first. */
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

function tooLarge(): MiosotisError {
  return new MiosotisError("validation", `Request is larger than ${MAX_REQUEST_BYTES / 1024 / 1024} MiB`);
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new MiosotisError("usage", "Expected input on stdin, but stdin is a terminal");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw tooLarge();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a JSON request from a file path, or from stdin when the path is `-`. */
export async function readRequestFile(path: string): Promise<unknown> {
  const text = path === "-" ? await readStdin() : readFile(path);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new MiosotisError("validation", `Request is not valid JSON: ${(error as Error).message}`);
  }
}

function readFile(path: string): string {
  try {
    if (statSync(path).size > MAX_REQUEST_BYTES) {
      throw tooLarge();
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof MiosotisError) {
      throw error;
    }
    throw new MiosotisError("not_found", `Cannot read request file ${path}: ${(error as Error).message}`);
  }
}

export function parseInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new MiosotisError("usage", `${label} must be a non-negative integer`);
  }
  return Number.parseInt(value, 10);
}

export function parseRange(value: string): { start: number; end: number } {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new MiosotisError("usage", "--range must look like START:END (UTF-16 offsets)");
  }
  return { start: Number.parseInt(match[1], 10), end: Number.parseInt(match[2], 10) };
}

export function parseInstantOption(value: string, label: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new MiosotisError("usage", `${label} must be an ISO date or instant`);
  }
  return new Date(time).toISOString();
}
