import { z } from "zod";
import { ArtifactRequest, CorrectionRequest } from "./artifact.js";
import { CaptureRequest } from "./capture.js";
import { EnrichmentRequest } from "./enrichment.js";
import { EvidenceRequest } from "./evidence.js";
import { SearchRequest } from "./search.js";

/** Request contracts published for AI hosts (generated into skill/miosotis/schemas/). */
export const PUBLISHED_CONTRACTS = {
  capture: CaptureRequest,
  enrichment: EnrichmentRequest,
  search: SearchRequest,
  evidence: EvidenceRequest,
  artifact: ArtifactRequest,
  correction: CorrectionRequest,
} as const;

export function contractJsonSchemas(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(PUBLISHED_CONTRACTS).map(([name, schema]) => [
      `${name}.schema.json`,
      `${JSON.stringify({ $id: `miosotis.${name}.v1`, ...z.toJSONSchema(schema, { io: "input" }) }, null, 2)}\n`,
    ]),
  );
}
