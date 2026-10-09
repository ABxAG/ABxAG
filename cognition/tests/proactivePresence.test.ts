import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProactivePresence,
  nextPresenceDelayMs,
  shouldRepeatIdlePresence,
} from "../proactivePresence";

test("presence speaks first within the requested 10-15 second window", () => {
  assert.equal(nextPresenceDelayMs(0, () => 0), 10_000);
  assert.equal(nextPresenceDelayMs(0, () => 1), 15_000);
  assert.ok(nextPresenceDelayMs(0, () => 0.5) >= 10_000);
  assert.ok(nextPresenceDelayMs(0, () => 0.5) <= 15_000);
});

test("presence backs off across continued silence instead of spamming", () => {
  assert.equal(nextPresenceDelayMs(1, () => 0), 18_000);
  assert.equal(nextPresenceDelayMs(2, () => 0), 35_000);
  assert.equal(nextPresenceDelayMs(3, () => 0), 90_000);
});

test("idle is overridden by recent meaningful screen movement", () => {
  const now = 100_000;
  assert.equal(classifyProactivePresence({ userIdleSeconds: 12, lastMeaningfulScreenChangeAt: 0, now }), "idle_away");
  assert.equal(classifyProactivePresence({ userIdleSeconds: 20, lastMeaningfulScreenChangeAt: now - 5_000, now }), "active_task");
  assert.equal(classifyProactivePresence({ userIdleSeconds: 2, lastMeaningfulScreenChangeAt: 0, now }), "active_task");
});

test("idle check-in has a two-minute repetition guard", () => {
  assert.equal(shouldRepeatIdlePresence(0, 100_000), true);
  assert.equal(shouldRepeatIdlePresence(50_000, 100_000), false);
  assert.equal(shouldRepeatIdlePresence(50_000, 170_000), true);
});
