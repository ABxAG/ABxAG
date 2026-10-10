/**
 * Shared stage-command routing (src/character/applyStageCommand.ts).
 *
 * Both windows (main stage + desktop-companion doll) own a CharacterSystem.
 * Action/outfit commands must reach both — this is the single router they
 * share, so the doll and the stage never drift apart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyStageCommand, isStageCommand } from "../src/character/applyStageCommand";

function fakeSystem() {
  const calls: Array<{ method: string; args: unknown }> = [];
  return {
    calls,
    performAction: (action: string) => {
      calls.push({ method: "performAction", args: action });
      return action;
    },
    setOutfitTint: (tint: { cloth?: string | null; hair?: string | null }) => {
      calls.push({ method: "setOutfitTint", args: tint });
      return true;
    },
  };
}

test("isStageCommand accepts action/outfit and rejects the rest", () => {
  assert.equal(isStageCommand({ kind: "action", action: "jump" }), true);
  assert.equal(isStageCommand({ kind: "outfit", cloth: "#e11d48" }), true);
  assert.equal(isStageCommand({ kind: "switch", id: "abc" }), false);
  assert.equal(isStageCommand(null), false);
  assert.equal(isStageCommand("jump"), false);
});

test("action commands reach performAction (main + doll share this path)", () => {
  const system = fakeSystem();
  assert.equal(applyStageCommand(system, { kind: "action", action: "dance" }), true);
  assert.deepEqual(system.calls, [{ method: "performAction", args: "dance" }]);
});

test("outfit commands reach setOutfitTint with cloth/hair/reset", () => {
  const system = fakeSystem();
  assert.equal(applyStageCommand(system, { kind: "outfit", cloth: "#2563eb" }), true);
  assert.equal(applyStageCommand(system, { kind: "outfit", cloth: null, hair: null }), true);
  assert.deepEqual(system.calls, [
    { method: "setOutfitTint", args: { cloth: "#2563eb", hair: undefined } },
    { method: "setOutfitTint", args: { cloth: null, hair: null } },
  ]);
});

test("missing system never throws", () => {
  assert.equal(applyStageCommand(null, { kind: "action", action: "jump" }), false);
  assert.equal(applyStageCommand(undefined, { kind: "outfit", cloth: "#fff" }), false);
});
