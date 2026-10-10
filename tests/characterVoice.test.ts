/**
 * Character voice-command helpers (voice/liveAgentTools.ts).
 *
 * These parse free user words ("jump", "laaf dao", "dress red karo") into
 * strict stage commands. Unknown words must return null / the valid list —
 * never a hallucinated action.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStageAction, parseStageColor, STAGE_ACTIONS } from "../voice/liveAgentTools";

test("stage actions cover the ten supported moves", () => {
  assert.deepEqual([...STAGE_ACTIONS], ["jump", "wave", "bow", "spin", "nod", "shake_head", "shrug", "dance", "stretch", "backflip"]);
});

test("normalizeStageAction accepts actions, aliases and Hindi words", () => {
  assert.equal(normalizeStageAction("jump"), "jump");
  assert.equal(normalizeStageAction("Wave"), "wave");
  assert.equal(normalizeStageAction("shake head"), "shake_head");
  assert.equal(normalizeStageAction("hi"), "wave");
  assert.equal(normalizeStageAction("laaf"), "jump");
  assert.equal(normalizeStageAction("no"), "shake_head");
  assert.equal(normalizeStageAction("backflip"), "backflip");
  assert.equal(normalizeStageAction("flip"), "backflip");
  assert.equal(normalizeStageAction("somersault"), "backflip");
});

test("normalizeStageAction rejects the impossible", () => {
  assert.equal(normalizeStageAction("fly"), null);
  assert.equal(normalizeStageAction(""), null);
  assert.equal(normalizeStageAction("become invisible"), null);
});

test("parseStageColor accepts hex and plain names", () => {
  assert.equal(parseStageColor("#e11d48"), "#e11d48");
  assert.equal(parseStageColor("E11D48"), "#e11d48");
  assert.equal(parseStageColor("red"), "#e11d48");
  assert.equal(parseStageColor(" Pink "), "#ec4899");
  assert.equal(parseStageColor("black"), "#1f2937");
});

test("parseStageColor rejects nonsense", () => {
  assert.equal(parseStageColor(""), null);
  assert.equal(parseStageColor("notacolor"), null);
  assert.equal(parseStageColor("#12345"), null);
});
