/** Shared HTTP plumbing for REST-based providers. */
import { ModelError } from "../types";
import { composeSignal } from "./gemini/client";

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  context: { signal?: AbortSignal; timeoutMs?: number },
  modelId: string,
): Promise<Response> {
  const { signal, timedOut, cleanup, cancelledByCaller } = composeSignal(context);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await httpError(response, modelId);
    return response;
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (cancelledByCaller()) throw new ModelError("CANCELLED", "Cancelled.", { retryable: false, modelId });
    if (timedOut()) throw new ModelError("TIMEOUT", "Model request timed out.", { modelId });
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelError("NETWORK", `Could not reach ${new URL(url).host}: ${message}`, { modelId });
  } finally {
    cleanup();
  }
}

export async function getJson<T>(url: string, headers: Record<string, string>, context: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  const { signal, cleanup } = composeSignal({ timeoutMs: 10_000, ...context });
  try {
    const response = await fetch(url, { headers, signal });
    if (!response.ok) throw await httpError(response, "list");
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw new ModelError("NETWORK", error instanceof Error ? error.message : String(error));
  } finally {
    cleanup();
  }
}

export async function httpError(response: Response, modelId: string): Promise<ModelError> {
  const text = (await response.text().catch(() => "")).slice(0, 400);
  const retryAfterHeader = Number(response.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : undefined;
  const status = response.status;
  if (status === 401 || status === 403) return new ModelError("AUTH", "API key rejected.", { status, modelId, retryable: false });
  if (status === 404) return new ModelError("NOT_FOUND", `Model or endpoint not found (${modelId}).`, { status, modelId, retryable: false });
  if (status === 429) return new ModelError("RATE_LIMIT", "Rate limited.", { status, modelId, retryAfterMs });
  if (status === 413 || (status === 400 && /context|too long|token/i.test(text))) {
    return new ModelError("CONTEXT_LIMIT", "Request too large for the model.", { status, modelId, retryable: false });
  }
  if (status >= 500) return new ModelError(status === 503 ? "UNAVAILABLE" : "SERVER", `Server error ${status}.`, { status, modelId, retryAfterMs });
  return new ModelError("BAD_REQUEST", `Request rejected (${status}): ${text}`, { status, modelId, retryable: false });
}

/** Parse a text/event-stream body into `data:` payloads. */
export async function* sseEvents(response: Response): AsyncIterable<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data) yield data;
    }
  }
}
