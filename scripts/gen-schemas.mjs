// Writes the published request contracts as JSON Schema files for the Skill. Run after `pnpm build`.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { contractJsonSchemas } from "../dist/contracts/schemas.js";

const target = new URL("../skill/miosotis/schemas/", import.meta.url);
mkdirSync(target, { recursive: true });
const files = contractJsonSchemas();
for (const existing of readdirSync(target)) {
  if (!(existing in files)) {
    rmSync(new URL(existing, target));
  }
}
for (const [name, content] of Object.entries(files)) {
  writeFileSync(new URL(name, target), content);
}
console.log(`Wrote ${Object.keys(files).length} schemas to skill/miosotis/schemas/`);
