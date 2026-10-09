import assert from "node:assert/strict";
import test from "node:test";
import {
  ScreenVisionPipeline,
  detectScreenVisionIntent,
  type ScreenVisionFrame,
} from "./server_screenVision";

const IMAGE = Buffer.from("screen-frame").toString("base64");

function payload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: "Captured screen.",
    width: 1920,
    height: 1080,
    image_base64: IMAGE,
    image_mime: "image/jpeg",
    active_window: "Example",
    ...overrides,
  };
}

test("detects explicit typed and spoken screen requests", () => {
  const requests = [
    "ABxAG, what can you see on my screen?",
    "Can you see this?",
    "What's this?",
    "Read this.",
    "What error is showing on my screen?",
    "Explain what I have opened.",
    "What should I click here?",
    "Look at my screen and tell me what is wrong.",
  ];
  for (const request of requests) {
    assert.equal(detectScreenVisionIntent(request), true, request);
  }
});

test("does not capture for ordinary conversation", () => {
  const messages = [
    "How is the weather?",
    "Explain recursion to me.",
    "Show me a pasta recipe.",
    "What should I click in a multiple-choice quiz?",
  ];
  for (const message of messages) {
    assert.equal(detectScreenVisionIntent(message), false, message);
  }
});

test("captures without injecting so callers can build one ordered multimodal turn", async () => {
  const states: string[] = [];
  let pushes = 0;
  const pipeline = new ScreenVisionPipeline({
    callAgent: async () => ({ ok: true, result: payload() }),
    pushFrameToSession: () => { pushes += 1; },
    onStateChange: (state) => states.push(state),
  });

  const frame = await pipeline.capture("intent");
  assert.equal(frame?.imageBase64, IMAGE);
  assert.equal(pushes, 0);
  assert.deepEqual(states, ["capturing"]);

  pipeline.markFrameDelivered(frame as ScreenVisionFrame);
  assert.deepEqual(states, ["capturing", "ready"]);
  pipeline.dispose();
  assert.equal(pipeline.getRecentFrame(), null);
});

test("falls back to takeScreenshot when viewScreen returns an invalid payload", async () => {
  const calls: string[] = [];
  const pipeline = new ScreenVisionPipeline({
    callAgent: async (tool) => {
      calls.push(tool);
      if (tool === "viewScreen") return { ok: true, result: payload({ ok: false, error: "blocked" }) };
      return { ok: true, result: payload() };
    },
    pushFrameToSession: () => {},
  });

  const frame = await pipeline.capture();
  assert.equal(frame?.source, "takeScreenshot");
  assert.deepEqual(calls, ["viewScreen", "takeScreenshot"]);
  pipeline.dispose();
});

test("shares one capture between concurrent callers", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pipeline = new ScreenVisionPipeline({
    callAgent: async () => {
      calls += 1;
      await gate;
      return { ok: true, result: payload() };
    },
    pushFrameToSession: () => {},
  });

  const first = pipeline.capture();
  const second = pipeline.capture();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  pipeline.dispose();
});

test("reports realtime injection failure without crashing", async () => {
  const states: Array<{ state: string; error?: string }> = [];
  const pipeline = new ScreenVisionPipeline({
    callAgent: async () => ({ ok: true, result: payload() }),
    pushFrameToSession: () => { throw new Error("model does not accept images"); },
    onStateChange: (state, info) => states.push({ state, error: info?.error }),
  });

  const frame = await pipeline.capture();
  assert.ok(frame);
  assert.equal(pipeline.injectFrame(frame as ScreenVisionFrame), false);
  assert.equal(states.at(-1)?.state, "error");
  assert.match(states.at(-1)?.error || "", /does not accept images/);
  pipeline.dispose();
});

