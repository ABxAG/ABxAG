/**
 * Redaction for logs, audit entries and debug views.
 *
 * Structured values are walked recursively. Keys that name secrets are
 * replaced entirely; free text is scrubbed for well-known secret shapes
 * (API keys, bearer tokens, JWTs, card-like digit runs, inline passwords).
 */

const SECRET_KEY = /(api[-_]?key|apikey|secret|token|password|passwd|pwd|authorization|cookie|credential|private[-_]?key|execute_token|otp|pin)$/i;
const CONTENT_KEY = /^(clipboard|clipboardText|content|text_content|file_content|image_base64|imageBase64|audio|data)$/i;

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GOOGLE_KEY]"],
  [/sk-(?:ant-|proj-)?[0-9A-Za-z_-]{16,}/g, "[REDACTED_API_KEY]"],
  [/\bBearer\s+[0-9A-Za-z._~+/=-]{12,}/gi, "Bearer [REDACTED]"],
  [/\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED_NUMBER]"],
  [/(password|passwd|pwd)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"],
];

export function redactText(value: string, maxLength = 2_000): string {
  let output = value;
  for (const [pattern, replacement] of TEXT_PATTERNS) output = output.replace(pattern, replacement);
  return output.length > maxLength ? `${output.slice(0, maxLength)}…[+${output.length - maxLength}]` : output;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) out[key] = "[REDACTED]";
      else if (CONTENT_KEY.test(key) && typeof item === "string") out[key] = `[${item.length} chars omitted]`;
      else out[key] = redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** Argument summary for logs: key names plus short, redacted scalar previews. */
export function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "{}";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (SECRET_KEY.test(key) || CONTENT_KEY.test(key)) {
      parts.push(`${key}=[hidden]`);
    } else if (typeof value === "string") {
      parts.push(`${key}=${JSON.stringify(redactText(value, 60))}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    } else {
      parts.push(`${key}=[${Array.isArray(value) ? "array" : typeof value}]`);
    }
  }
  return `{${parts.join(", ")}}`;
}
