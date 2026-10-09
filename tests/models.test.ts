import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRegistry } from "../models/registry";
import { ModelRouter } from "../models/router";
import { NetworkMonitor } from "../models/network";
import { withRetry } from "../models/retry";
import { classifyGeminiError } from "../models/providers/gemini/errors";
import { ModelError, type GenerateRequest, type GenerateResponse, type ModelDefinition, type ModelProvider, type ProviderConfig } from "../models/types";
import { parseModelJson, validateJson } from "../shared/jsonSchema";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "abxag-models-"));
}

class FakeProvider implements ModelProvider {
  calls: string[] = [];
  failures = new Map<string, ModelError[]>();
  constructor(readonly config: ProviderConfig) {}
  isConfigured() { return true; }
  async listModels() { return ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-flash-live-preview", "gemini-3.8-live", "gemini-embedding-001"]; }
  async generate(model: ModelDefinition, request: GenerateRequest): Promise<GenerateResponse> {
    this.calls.push(model.id);
    const queue = this.failures.get(model.id);
    if (queue?.length) throw queue.shift();
    return { text: "ok", toolCalls: [], json: request.responseSchema ? { ok: true } : undefined, usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 }, finishReason: "STOP", modelId: model.id, latencyMs: 5 };
  }
}

async function setup(selection?: Record<string, unknown>) {
  const dir = tempDir();
  if (selection) {
    fs.mkdirSync(path.join(dir, "models"), { recursive: true });
    fs.writeFileSync(path.join(dir, "models", "selection.json"), JSON.stringify(selection));
  }
  const registry = new ModelRegistry(dir, () => "test-key");
  await registry.initialize({});
  const fake = new FakeProvider(registry.getProviderConfig("gemini")!);
  registry.registerAdapter("gemini", fake);
  await registry.refreshAvailability();
  const network = new NetworkMonitor("example.invalid", async () => ({}));
  const router = new ModelRouter(registry, network);
  return { dir, registry, router, fake, network };
}

const ask = (text = "hi"): GenerateRequest => ({ purpose: "test", messages: [{ role: "user", parts: [{ type: "text", text }] }] });

test("AUTO routes by capability and task tier, not by model name", async () => {
  const { router } = await setup({ brain: "auto" });
  assert.equal(router.candidates("conversation")[0].tier, "fast");
  assert.equal(router.candidates("planning")[0].tier, "balanced");
  assert.equal(router.candidates("coding")[0].tier, "deep");
  assert.equal(router.candidates("planning", { complexity: 0.9 })[0].tier, "deep");
  for (const model of router.candidates("vision")) assert.equal(model.capabilities.vision, true);
  assert.equal(router.candidates("live_voice")[0].capabilities.liveAudio, true);
  assert.equal(router.candidates("embedding")[0].capabilities.embedding, true);
  // Live and embedding models never serve chat.
  assert.ok(router.candidates("conversation").every((m) => !m.capabilities.liveAudio && !m.capabilities.embedding));
});

test("explicit selection is respected and never silently replaced without fallback permission", async () => {
  const { router, fake } = await setup({ brain: "gemini-3.8-flash", fallbackAllowed: false });
  assert.deepEqual(router.candidates("conversation").map((m) => m.id), ["gemini-3.8-flash"]);
  fake.failures.set("gemini-3.8-flash", [new ModelError("UNAVAILABLE", "down"), new ModelError("UNAVAILABLE", "down")]);
  await assert.rejects(router.generate("conversation", ask(), { maxAttempts: 2 }), (error: ModelError) => error.code === "UNAVAILABLE");
  assert.ok(fake.calls.every((id) => id === "gemini-3.8-flash"));
});

test("fallback switches models only when allowed and reports it", async () => {
  const { router, fake } = await setup({ brain: "gemini-3.8-flash", fallbackAllowed: true });
  fake.failures.set("gemini-3.8-flash", [new ModelError("SERVER", "boom"), new ModelError("SERVER", "boom")]);
  const response = await router.generate("conversation", ask(), { maxAttempts: 2 });
  assert.notEqual(response.modelId, "gemini-3.8-flash");
  assert.equal(fake.calls.filter((id) => id === "gemini-3.8-flash").length, 2, "bounded retries on the selected model first");
});

test("auth and safety errors are not retried or routed around", async () => {
  const { router, fake } = await setup({ brain: "gemini-3.5-flash", fallbackAllowed: true });
  fake.failures.set("gemini-3.5-flash", [new ModelError("AUTH", "bad key")]);
  await assert.rejects(router.generate("conversation", ask()), (error: ModelError) => error.code === "AUTH");
  assert.equal(fake.calls.length, 1);
});

test("offline: cloud models are skipped and the user is told why", async () => {
  const { router, network } = await setup({ brain: "gemini-3.5-flash" });
  network["set"]("offline");
  assert.throws(() => router.candidates("conversation"), (error: ModelError) => error.code === "NETWORK");
});

test("a text-only selected model gets a visible capability substitution for vision", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "models.json"), JSON.stringify({
    models: [{ id: "text-only", displayName: "Text only", provider: "gemini", modelName: "gemini-3.5-flash-lite", apiType: "gemini", capabilities: { vision: false, tools: true, structuredOutput: true, reasoning: false, streaming: true, liveAudio: false, embedding: false }, contextLength: 1000, tier: "fast", locality: "cloud", cost: {}, recommendedTasks: ["conversation"], enabled: true }],
  }));
  fs.writeFileSync(path.join(dir, "models", "selection.json"), JSON.stringify({ brain: "text-only", fallbackAllowed: false }));
  const registry = new ModelRegistry(dir, () => "k");
  await registry.initialize({});
  registry.registerAdapter("gemini", new FakeProvider(registry.getProviderConfig("gemini")!));
  await registry.refreshAvailability();
  const router = new ModelRouter(registry, new NetworkMonitor("x", async () => ({})));
  assert.equal(router.candidates("conversation")[0].id, "text-only");
  const vision = router.candidates("vision");
  assert.equal(vision.length, 1);
  assert.equal(vision[0].capabilities.vision, true);
});

test("adding a model is configuration only (models.json)", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "models.json"), JSON.stringify({
    providers: [{ id: "local", enabled: true }],
    models: [{ id: "local-vision", enabled: true }],
  }));
  const registry = new ModelRegistry(dir, () => undefined);
  await registry.initialize({});
  const local = registry.publicCatalogue().models.find((m) => m.id === "local-vision")!;
  assert.equal(local.locality, "local");
  assert.notEqual(local.availability, "disabled");
});

test("legacy env model routes migrate into the new selection", async () => {
  const registry = new ModelRegistry(tempDir(), () => "k");
  await registry.initialize({ ABxAG_REASONING_MODEL: "gemini-3.8-flash", ABxAG_SPEECH_MODEL: "gemini-3.8-live" });
  assert.equal(registry.getSelection().brain, "gemini-3.8-flash");
  assert.equal(registry.getSelection().live, "gemini-3.8-live");
});

test("retry is bounded and honours cancellation", async () => {
  let attempts = 0;
  await assert.rejects(withRetry(async () => { attempts += 1; throw new ModelError("SERVER", "x"); }, { maxAttempts: 3, baseDelayMs: 1 }));
  assert.equal(attempts, 3);
  const controller = new AbortController();
  const pending = withRetry(async () => { throw new ModelError("RATE_LIMIT", "x", { retryAfterMs: 5_000 }); }, { maxAttempts: 3, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error: ModelError) => error.code === "CANCELLED");
  // A server-requested delay beyond the cap ends retries (router may fall back).
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new ModelError("RATE_LIMIT", "x", { retryAfterMs: 120_000 }); }, { maxAttempts: 3 }));
  assert.equal(calls, 1);
});

test("Gemini errors classify into actionable codes", () => {
  const status = (s: number, m = "x") => Object.assign(new Error(m), { status: s });
  assert.equal(classifyGeminiError(status(429, "RESOURCE_EXHAUSTED retry in 7s"), "m", false, false).code, "RATE_LIMIT");
  assert.equal(classifyGeminiError(status(429, "retry in 7s"), "m", false, false).options.retryAfterMs, 7000);
  assert.equal(classifyGeminiError(status(400, "API key not valid"), "m", false, false).code, "AUTH");
  assert.equal(classifyGeminiError(status(400, "input token count exceeds the maximum"), "m", false, false).code, "CONTEXT_LIMIT");
  assert.equal(classifyGeminiError(status(503), "m", false, false).code, "UNAVAILABLE");
  assert.equal(classifyGeminiError(new TypeError("fetch failed"), "m", false, false).code, "NETWORK");
  assert.equal(classifyGeminiError(new Error("x"), "m", true, false).code, "CANCELLED");
  assert.equal(classifyGeminiError(new Error("x"), "m", false, true).code, "TIMEOUT");
});

test("free-tier quota errors teach the limiter the real per-minute budget", async () => {
  const error = classifyGeminiError(Object.assign(new Error("Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.5-flash. Please retry in 33.4s."), { status: 429 }), "gemini-3.5-flash", false, false);
  assert.equal(error.code, "RATE_LIMIT");
  assert.equal(error.options.quotaPerMinute, 5);
  assert.equal(Math.round((error.options.retryAfterMs || 0) / 1000), 33);
  const { router, fake } = await setup({ brain: "auto", fallbackAllowed: true });
  fake.failures.set(router.candidates("conversation")[0].id, [error]);
  const first = router.candidates("conversation")[0].id;
  const response = await router.generate("conversation", ask());
  assert.notEqual(response.modelId, first, "an exhausted model is routed around when fallback is allowed");
  assert.ok(router.limiter.waitEstimate(first) > 20_000);
  assert.equal(router.limiter.snapshot()[first].rpm, 5);
});

test("structured output parsing and validation reject malformed tool arguments", () => {
  assert.deepEqual(parseModelJson("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(parseModelJson("Sure! {\"a\":{\"b\":\"}\"}} trailing"), { a: { b: "}" } });
  assert.throws(() => parseModelJson("no json here"));
  const schema = { type: "object", required: ["x"], additionalProperties: false, properties: { x: { type: "integer", minimum: 0 }, mode: { type: "string", enum: ["a", "b"] } } };
  assert.equal(validateJson({ x: 3, mode: "a" }, schema).valid, true);
  const bad = validateJson({ x: -1, mode: "z", extra: 1 }, schema);
  assert.equal(bad.valid, false);
  assert.equal(bad.errors.length, 3);
});



