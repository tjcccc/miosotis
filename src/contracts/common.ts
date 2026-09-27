import { z } from "zod";

export const IdempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "printable ASCII without spaces")
  .describe("Client-chosen key; replaying the same request with it returns the original receipt.");

export const IsoInstant = z.iso.datetime({ offset: true }).describe("ISO-8601 instant with offset or Z");

export const Timezone = z.string().min(1).max(64).describe("IANA timezone, e.g. Europe/Berlin");

export const ProjectSlugInput = z.string().min(1).max(64).describe("Project slug (any script); created on save if new");

export const Limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);

export const Cursor = z.string().regex(/^\d+$/).describe("Opaque pagination cursor from a previous response");
