/**
 * Real Gemini integration checks. Opt-in: ABxAG_LIVE_TESTS=1 (uses the
 * configured API key and a handful of very small requests).
 */
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { ModelRegistry } from "../models/registry";
import { ModelRouter } from "../models/router";
import { ModelError } from "../models/types";
import { getGeminiApiKey } from "../server_paths";

const enabled = process.env.ABxAG_LIVE_TESTS === "1" && Boolean(getGeminiApiKey());
const skip = enabled ? false : "set ABxAG_LIVE_TESTS=1 with a Gemini key";

async function router(brain = "gemini-3.5-flash") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abxag-live-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "selection.json"), JSON.stringify({ brain, fallbackAllowed: false }));
  const registry = new ModelRegistry(dir, (name) => (name === "provider:gemini" ? getGeminiApiKey() : undefined));
  await registry.initialize({});
  await registry.refreshAvailability();
  return new ModelRouter(registry);
}

/** 64x64 PNG: left half red, right half blue. */
function testPng(): string {
  const width = 64, height = 64;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      if (x < 32) { raw[offset] = 230; raw[offset + 1] = 20; raw[offset + 2] = 20; }
      else { raw[offset] = 20; raw[offset + 1] = 40; raw[offset + 2] = 230; }
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

test("live: normal conversation", { skip }, async () => {
  const r = await router();
  const response = await r.generate("conversation", { purpose: "live.test", messages: [{ role: "user", parts: [{ type: "text", text: "Reply with the single word: pong" }] }], maxOutputTokens: 256 });
  assert.match(response.text.toLowerCase(), /pong/);
  assert.ok(response.usage.inputTokens > 0);
});

test("live: vision input + structured output", { skip }, async () => {
  const r = await router();
  const response = await r.generate("vision", {
    purpose: "live.vision",
    messages: [{ role: "user", parts: [{ type: "image", mimeType: "image/png", data: testPng() }, { type: "text", text: "What colour is the left half and the right half?" }] }],
    responseSchema: { type: "object", required: ["left", "right"], properties: { left: { type: "string" }, right: { type: "string" } } },
    maxOutputTokens: 512,
  }, { maxQuotaWaitMs: 75_000 });
  const json = response.json as { left: string; right: string };
  assert.match(json.left.toLowerCase(), /red/);
  assert.match(json.right.toLowerCase(), /blue/);
});

test("live: tool call with schema-valid arguments", { skip }, async () => {
  const r = await router();
  const response = await r.generate("planning", {
    purpose: "live.tools",
    messages: [{ role: "user", parts: [{ type: "text", text: "Open the Pictures folder." }] }],
    tools: [{ name: "open_folder", description: "Open a known folder", parameters: { type: "object", required: ["folder"], properties: { folder: { type: "string", enum: ["pictures", "downloads", "documents"] } } } }],
    toolChoice: "required",
    maxOutputTokens: 512,
  }, { maxQuotaWaitMs: 75_000 });
  assert.equal(response.toolCalls[0]?.name, "open_folder");
  assert.equal(response.toolCalls[0]?.args.folder, "pictures");
});

test("live: streaming yields incremental text", { skip }, async () => {
  const r = await router();
  let text = "";
  let chunks = 0;
  for await (const chunk of r.stream("conversation", { purpose: "live.stream", messages: [{ role: "user", parts: [{ type: "text", text: "Count from 1 to 15 separated by spaces." }] }] })) {
    text += chunk.textDelta;
    if (chunk.textDelta) chunks += 1;
  }
  assert.match(text, /15/);
  assert.ok(chunks >= 1);
});

test("live: cancellation and timeout surface as CANCELLED / TIMEOUT", { skip }, async () => {
  const r = await router();
  const controller = new AbortController();
  const pending = r.generate("conversation", { purpose: "live.cancel", messages: [{ role: "user", parts: [{ type: "text", text: "Write a long story about a robot." }] }] }, { signal: controller.signal, maxAttempts: 1 });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, (error: ModelError) => error.code === "CANCELLED");
  await assert.rejects(
    r.generate("conversation", { purpose: "live.timeout", messages: [{ role: "user", parts: [{ type: "text", text: "Write a long story about a dragon." }] }] }, { timeoutMs: 50, maxAttempts: 1 }),
    (error: ModelError) => error.code === "TIMEOUT",
  );
});

test("live: an unavailable model ID fails cleanly", { skip }, async () => {
  const r = await router();
  r.registry.upsertModel({ ...r.registry.getModel("gemini-3.5-flash")!, id: "ghost", modelName: "gemini-does-not-exist-9" });
  const result = await r.test("ghost");
  assert.equal(result.ok, false);
});



