/**
 * Companion doll string-command mapping (src/companion/companionCommands.ts).
 *
 * Voice "companionPerform" reaches the doll as "perform:<action>" strings.
 * Every stage action must pass through untouched so the doll has full body
 * control (dance, backflip, …), while legacy words keep their meaning.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mapCompanionStringCommand } from "../src/companion/companionCommands";

test("legacy words keep their meaning", () => {
  assert.deepEqual(mapCompanionStringCommand("sit"), { act: "sit" });
  assert.deepEqual(mapCompanionStringCommand("stand"), { act: "stand" });
  assert.deepEqual(mapCompanionStringCommand("wave"), { act: "perform", name: "wave" });
});

test("perform:<action> passes any stage move to the doll", () => {
  for (const name of ["dance", "backflip", "jump", "spin", "nod", "bow", "shrug", "stretch", "shake_head"]) {
    assert.deepEqual(mapCompanionStringCommand(`perform:${name}`), { act: "perform", name });
  }
});

test("garbage maps to null (doll ignores it)", () => {
  assert.equal(mapCompanionStringCommand("fly"), null);
  assert.equal(mapCompanionStringCommand(""), null);
  assert.equal(mapCompanionStringCommand("perform:"), null);
  assert.equal(mapCompanionStringCommand("perform:  "), null);
});
