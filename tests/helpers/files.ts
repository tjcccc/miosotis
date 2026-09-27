import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A valid 1x1 PNG. */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function writeFixture(directory: string, name: string, content: string | Buffer): string {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}
