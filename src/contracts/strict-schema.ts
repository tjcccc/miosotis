import { z } from "zod";

type JsonNode = unknown;

/**
 * The input JSON Schema of `schema` in the strict structured-output form model APIs require: every
 * property is required (optional ones accept `null` instead) and objects allow no other properties.
 * Read the model's answer back with `dropNulls` before validating it against the original contract.
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return strictNode(z.toJSONSchema(schema, { io: "input" })) as Record<string, unknown>;
}

function strictNode(node: JsonNode): JsonNode {
  if (Array.isArray(node)) {
    return node.map(strictNode);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const result: Record<string, JsonNode> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== "default" && key !== "$schema") {
      result[key] = strictNode(value);
    }
  }
  const properties = result.properties as Record<string, JsonNode> | undefined;
  if (result.type === "object" && properties !== undefined) {
    const required = new Set(Array.isArray(result.required) ? (result.required as string[]) : []);
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) {
        properties[key] = { anyOf: [properties[key], { type: "null" }] };
      }
    }
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
}

/** Removes `null` object members recursively, so "not stated" becomes an omitted optional field. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dropNulls);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, member]) => member !== null)
      .map(([key, member]) => [key, dropNulls(member)]),
  );
}
