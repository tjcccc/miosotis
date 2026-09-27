import { readFileSync } from "node:fs";

/** Package version, read at runtime so src (tests) and dist (bin) report the same value. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
