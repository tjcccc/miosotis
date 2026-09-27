// Copies non-TypeScript runtime assets (SQL migrations) into dist and marks the CLI executable.
import { chmodSync, cpSync } from "node:fs";

const root = new URL("..", import.meta.url);
cpSync(new URL("src/infra/db/migrations", root), new URL("dist/infra/db/migrations", root), {
  recursive: true,
  filter: (source) => !source.endsWith(".ts"),
});
chmodSync(new URL("dist/index.js", root), 0o755);
