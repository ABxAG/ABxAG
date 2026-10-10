/**
 * Regression test for the "ABxAG hit a problem and is reloading…" crash loop.
 *
 * Root cause: agent/loop.ts sets task.result to {success, summary} objects
 * and TaskHud rendered task.result raw → React error #31 (objects are not
 * valid as a React child) → CrashGuard → reload → same finished task → crash.
 * asText() must turn every result shape into a render-safe string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { asText } from "../src/components/TaskHud";

test("asText unwraps agent {success, summary} results (React #31 regression)", () => {
  assert.equal(asText({ success: true, summary: "Opened Notepad." }), "Opened Notepad.");
  assert.equal(asText({ success: false, summary: "App not found." }), "App not found.");
});

test("asText keeps strings and primitives render-safe", () => {
  assert.equal(asText("plain result"), "plain result");
  assert.equal(asText(null), "");
  assert.equal(asText(undefined), "");
  assert.equal(asText(42), "42");
});

test("asText never returns a non-string (unknown shapes stringify)", () => {
  const out = asText({ unexpected: { nested: [1, 2] } });
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
});
