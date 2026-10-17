import { existsSync, readFileSync, realpathSync } from "node:fs";
import { parse } from "smol-toml";
import { MiosotisError } from "../../domain/errors.js";
import { writeFileAtomic } from "../fs/files.js";
import { EnrichTableSchema } from "./config.js";

type TomlValue = string | number | boolean;

/** Where the `[name]` table starts and ends in the text (up to the next table header). */
function tableSpan(text: string, name: string): { start: number; end: number } | undefined {
  const header = new RegExp(`^\\[${name}\\][^\\n]*\\n?`, "m").exec(text);
  if (header === null) {
    return undefined;
  }
  const bodyStart = header.index + header[0].length;
  const next = /^\[/m.exec(text.slice(bodyStart));
  return { start: header.index, end: next === null ? text.length : bodyStart + next.index };
}

/**
 * Pure text edit that replaces the `[enrich]` table with `values` (or removes it when `values` is
 * null), keeping every other line, comment, and table of the user's config intact.
 */
export function planEnrichTableEdit(text: string, values: Record<string, TomlValue> | null): string {
  const span = tableSpan(text, "enrich");
  const without = span === undefined ? text : `${text.slice(0, span.start)}${text.slice(span.end)}`;
  let next = without;
  if (values !== null) {
    const lines = [
      "[enrich]",
      "# Written by `miosotis enrich worker enable`; `miosotis enrich worker disable` turns it off.",
      ...Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    ];
    next = `${without.replace(/\s*$/, "")}\n\n${lines.join("\n")}\n`;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(next) as Record<string, unknown>;
  } catch (error) {
    throw new MiosotisError("validation", `Cannot edit the config: ${(error as Error).message}`);
  }
  const check = EnrichTableSchema.safeParse(parsed.enrich ?? {});
  if (!check.success || (values === null && parsed.enrich !== undefined)) {
    throw new MiosotisError("internal", "Refusing to write the config: the edit did not produce the expected [enrich]");
  }
  return next;
}

/** Applies the `[enrich]` edit to the config file (through a symlink to the real file). */
export function writeEnrichTable(configFile: string, values: Record<string, TomlValue> | null): void {
  const exists = existsSync(configFile);
  const realPath = exists ? realpathSync(configFile) : configFile;
  const original = exists ? readFileSync(realPath, "utf8") : "";
  const next = planEnrichTableEdit(original, values);
  if (next !== original) {
    writeFileAtomic(realPath, next, 0o600);
  }
}
