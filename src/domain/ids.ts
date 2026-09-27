import { isValid, monotonicFactory } from "ulid";
import { MiosotisError } from "./errors.js";

/** Type prefixes for user-facing identifiers. */
export const ID_PREFIX = {
  source: "S",
  project: "P",
  artifact: "A",
  evidence: "E",
  derivation: "D",
  operation: "O",
  dataset: "T",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const nextUlid = monotonicFactory();

export function newId(kind: IdKind, now: number = Date.now()): string {
  return `${ID_PREFIX[kind]}-${nextUlid(now)}`;
}

export function isId(kind: IdKind, value: string): boolean {
  const prefix = `${ID_PREFIX[kind]}-`;
  return value.startsWith(prefix) && isValid(value.slice(prefix.length));
}

export function assertId(kind: IdKind, value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!isId(kind, normalized)) {
    throw new MiosotisError("validation", `Not a valid ${kind} ID: ${value}`, { kind, value });
  }
  return normalized;
}

export interface SourceRef {
  id: string;
  version: number | undefined;
}

/** Parses `S-<ulid>` or `S-<ulid>@v<N>`. */
export function parseSourceRef(value: string): SourceRef {
  const trimmed = value.trim();
  const match = /^(.+?)(?:@v(\d+))?$/i.exec(trimmed);
  const idPart = match?.[1] ?? trimmed;
  const versionPart = match?.[2];
  const id = assertId("source", idPart);
  if (versionPart === undefined) {
    return { id, version: undefined };
  }
  const version = Number.parseInt(versionPart, 10);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new MiosotisError("validation", `Invalid source version in reference: ${value}`);
  }
  return { id, version };
}

export function formatSourceRef(id: string, version: number): string {
  return `${id}@v${version}`;
}

/** Recognizes any type-prefixed miosotis ID inside free text (used by search). */
export const ANY_ID_PATTERN = /^[SPAEDOT]-[0-9A-HJKMNP-TV-Z]{26}$/i;
