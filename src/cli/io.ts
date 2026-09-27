import { readFileSync } from "node:fs";
import { MiosotisError } from "../domain/errors.js";

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new MiosotisError("usage", "Expected input on stdin, but stdin is a terminal");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
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
    return readFileSync(path, "utf8");
  } catch (error) {
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
