/**
 * Outfit-tint safety (shared/character/appearance.ts).
 *
 * Regression: "dress red" dyed the WHOLE body because body parts (arm, leg,
 * head…) matched no rule and fell back to "cloth", which the tint treated
 * as clothing. Body parts must classify as skin, and the tint guard must
 * refuse anything that is not explicitly clothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyMaterialRole, isHairTintable, isOutfitTintable } from "../shared/character/appearance";

test("body parts classify as skin, never cloth", () => {
  for (const name of ["腕", "足", "頭", "体", "LeftArm", "RightLeg", "Head", "Torso", "首", "肩", "手指", "手首", "膝"]) {
    assert.equal(classifyMaterialRole(name), "skin", name);
  }
});

test("real clothes still classify as cloth", () => {
  for (const name of ["ドレス", "スカート", "dress", "skirt", "shirt", "手套", "靴", "sleeve"]) {
    const role = classifyMaterialRole(name);
    assert.ok(role === "cloth" || role === "lightCloth" || role === "leather", `${name} -> ${role}`);
  }
});

test("unmatched gibberish keeps the shading fallback", () => {
  assert.equal(classifyMaterialRole("zzzqxj123"), null);
});

test("tint guard: clothes yes, body/face/hair no", () => {
  assert.equal(isOutfitTintable("ドレス", {}), true);
  assert.equal(isOutfitTintable("腕", {}), false);
  assert.equal(isOutfitTintable("Head", {}), false);
  assert.equal(isOutfitTintable("zzzqxj123", {}), false);
  assert.equal(isOutfitTintable("髪", {}), false);
  assert.equal(isHairTintable("髪", {}), true);
  assert.equal(isHairTintable("ドレス", {}), false);
  assert.equal(isHairTintable("腕", {}), false);
});

test("tint guard: explicit user mapping wins", () => {
  const roles = { cloth: ["MysticRobe"], skin: ["ドレス"] } as Record<string, string[]>;
  assert.equal(isOutfitTintable("MysticRobe", roles), true);
  assert.equal(isOutfitTintable("ドレス", roles), false);
});
