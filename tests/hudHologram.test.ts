/**
 * HologramAvatar helpers (HUD overlay 2D hologram).
 *
 * Pupil offsets must stay inside the travel circle (diagonals normalized,
 * garbage in → centred), blinks must be short and periodic, and mouth bars
 * must animate only while speaking/listening.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pupilOffset, isBlinking, mouthBars } from "../src/components/HologramAvatar";

test("pupilOffset passes small vectors through", () => {
  assert.deepEqual(pupilOffset(3, -4), { x: 3, y: -4 });
  assert.deepEqual(pupilOffset(0, 0), { x: 0, y: 0 });
});

test("pupilOffset clamps to the travel circle (diagonals normalized)", () => {
  const max = 9;
  const straight = pupilOffset(0, 40, max);
  assert.equal(straight.x, 0);
  assert.equal(straight.y, max);
  const diag = pupilOffset(30, 30, max);
  assert.ok(Math.abs(Math.hypot(diag.x, diag.y) - max) < 1e-9);
  assert.ok(diag.x > 0 && diag.y > 0);
});

test("pupilOffset centres non-finite input", () => {
  assert.deepEqual(pupilOffset(NaN, 5), { x: 0, y: 0 });
  assert.deepEqual(pupilOffset(5, Infinity), { x: 0, y: 0 });
});

test("isBlinking is short and periodic", () => {
  assert.equal(isBlinking(0), true);
  assert.equal(isBlinking(0.05), true);
  assert.equal(isBlinking(1), false);
  assert.equal(isBlinking(3.7), true); // next period
  assert.equal(isBlinking(NaN), false);
});

test("mouthBars animate per connection state", () => {
  const speaking = mouthBars("speaking", 1.3);
  assert.equal(speaking.length, 5);
  for (const h of speaking) assert.ok(h >= 0.35 && h <= 1);
  // Speaking actually moves over time.
  const later = mouthBars("speaking", 1.6);
  assert.ok(speaking.some((h, i) => Math.abs(h - later[i]) > 1e-6));
  const listening = mouthBars("listening", 2);
  for (const h of listening) assert.ok(h >= 0.2 && h <= 0.7);
  assert.deepEqual(mouthBars("connecting", 9), [0.18, 0.18, 0.18, 0.18, 0.18]);
  assert.deepEqual(mouthBars("disconnected", 9), [0.18, 0.18, 0.18, 0.18, 0.18]);
});
