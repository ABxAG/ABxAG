/**
 * Minimal JSON-schema validation for model-produced data.
 *
 * Supports the subset ABxAG uses for tool arguments and structured planner
 * output: type, properties, required, items, enum, minimum/maximum,
 * minLength/maxLength, maxItems, additionalProperties:false, nullable via
 * type arrays. Unknown keywords are ignored rather than trusted.
 */

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  [key: string]: unknown;
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === "number" && actual === "integer") return true;
  return false;
}

export function validateJson(value: unknown, schema: JsonSchema, at = "$"): ValidationResult {
  const errors: string[] = [];
  const visit = (current: unknown, node: JsonSchema, pointer: string) => {
    if (errors.length > 20) return;
    const actual = typeOf(current);
    if (node.type) {
      const allowed = Array.isArray(node.type) ? node.type : [node.type];
      if (!allowed.some((type) => typeMatches(type, actual))) {
        errors.push(`${pointer}: expected ${allowed.join("|")}, got ${actual}`);
        return;
      }
    }
    if (node.enum && !node.enum.some((option) => option === current)) {
      errors.push(`${pointer}: must be one of ${node.enum.map(String).join(", ")}`);
    }
    if (typeof current === "number") {
      if (node.minimum !== undefined && current < node.minimum) errors.push(`${pointer}: below minimum ${node.minimum}`);
      if (node.maximum !== undefined && current > node.maximum) errors.push(`${pointer}: above maximum ${node.maximum}`);
      if (!Number.isFinite(current)) errors.push(`${pointer}: must be finite`);
    }
    if (typeof current === "string") {
      if (node.minLength !== undefined && current.length < node.minLength) errors.push(`${pointer}: too short`);
      if (node.maxLength !== undefined && current.length > node.maxLength) errors.push(`${pointer}: too long (max ${node.maxLength})`);
    }
    if (Array.isArray(current)) {
      if (node.maxItems !== undefined && current.length > node.maxItems) errors.push(`${pointer}: too many items`);
      if (node.items) current.forEach((item, index) => visit(item, node.items as JsonSchema, `${pointer}[${index}]`));
    }
    if (actual === "object" && current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const key of node.required || []) {
        if (record[key] === undefined) errors.push(`${pointer}.${key}: required`);
      }
      for (const [key, child] of Object.entries(record)) {
        const childSchema = node.properties?.[key];
        if (childSchema) visit(child, childSchema, `${pointer}.${key}`);
        else if (node.additionalProperties === false) errors.push(`${pointer}.${key}: unexpected property`);
        else if (node.additionalProperties && typeof node.additionalProperties === "object") {
          visit(child, node.additionalProperties, `${pointer}.${key}`);
        }
      }
    }
  };
  visit(value, schema, at);
  return { valid: errors.length === 0, errors };
}

/** Extract the first JSON object/array from model text (tolerates code fences). */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[{[]/);
    if (start < 0) throw new Error("No JSON found in model output.");
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      else if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
      }
    }
    throw new Error("Unterminated JSON in model output.");
  }
}

