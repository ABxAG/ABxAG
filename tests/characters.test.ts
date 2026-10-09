/**
 * Character pipeline tests: skeleton normalisation across naming conventions,
 * chain classification, the ZIP reader, and (when present locally) the real
 * archives the user supplied. Run: node --import tsx --test tests/characters.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mapHumanoid, parseBoneName, REQUIRED_BODY_SLOTS } from "../shared/character/humanoid";
import { analyzeRig } from "../shared/character/profile";
import type { RigBone, RigDescription, Vec3 } from "../shared/character/rig";
import { importCharacter } from "../character_import/importer";

/** Build a tiny humanoid skeleton with a naming function. */
function skeleton(name: (part: string, side?: "L" | "R") => string): RigBone[] {
  const bones: RigBone[] = [];
  const add = (n: string, parent: number, position: Vec3) => {
    bones.push({ index: bones.length, name: n, englishName: "", parent, position, flags: 0x1b });
    return bones.length - 1;
  };
  const hips = add(name("hips"), -1, [0, 10, 0]);
  const spine = add(name("spine"), hips, [0, 11, 0]);
  const chest = add(name("chest"), spine, [0, 13, 0]);
  const neck = add(name("neck"), chest, [0, 15, 0]);
  add(name("head"), neck, [0, 16, 0]);
  for (const side of ["L", "R"] as const) {
    const s = side === "L" ? 1 : -1;
    const shoulder = add(name("shoulder", side), chest, [s * 0.8, 14.5, 0]);
    const arm = add(name("upperarm", side), shoulder, [s * 1.6, 14.4, 0]);
    const fore = add(name("forearm", side), arm, [s * 4, 12.5, 0]);
    const hand = add(name("hand", side), fore, [s * 6, 10.8, 0]);
    for (const [fi, finger] of ["thumb", "index", "middle", "ring", "little"].entries()) {
      let parent = hand;
      for (let j = 1; j <= 3; j += 1) parent = add(name(`${finger}${j}`, side), parent, [s * (6.4 + j * 0.3), 10.6 - fi * 0.05, 0.2 - fi * 0.1]);
    }
    const thigh = add(name("thigh", side), hips, [s * 0.9, 9.5, 0]);
    const calf = add(name("calf", side), thigh, [s * 0.95, 5, 0]);
    const foot = add(name("foot", side), calf, [s * 1, 0.8, 0]);
    add(name("toe", side), foot, [s * 1, 0.1, 0.9]);
  }
  return bones;
}

const CONVENTIONS: Record<string, (part: string, side?: "L" | "R") => string> = {
  mixamo: (p, s) => {
    const sideWord = s === "L" ? "Left" : s === "R" ? "Right" : "";
    const map: Record<string, string> = { hips: "Hips", spine: "Spine", chest: "Spine1", neck: "Neck", head: "Head", shoulder: "Shoulder", upperarm: "Arm", forearm: "ForeArm", hand: "Hand", thigh: "UpLeg", calf: "Leg", foot: "Foot", toe: "ToeBase" };
    const finger = /^(thumb|index|middle|ring|little)(\d)$/.exec(p);
    if (finger) return `mixamorig:${sideWord}Hand${finger[1] === "little" ? "Pinky" : finger[1][0].toUpperCase() + finger[1].slice(1)}${finger[2]}`;
    return `mixamorig:${sideWord}${map[p]}`;
  },
  vroid: (p, s) => {
    const map: Record<string, string> = { hips: "Hips", spine: "Spine", chest: "Chest", neck: "Neck", head: "Head", shoulder: "Shoulder", upperarm: "UpperArm", forearm: "LowerArm", hand: "Hand", thigh: "UpperLeg", calf: "LowerLeg", foot: "Foot", toe: "ToeBase" };
    const finger = /^(thumb|index|middle|ring|little)(\d)$/.exec(p);
    const part = finger ? `${finger[1][0].toUpperCase()}${finger[1].slice(1)}${finger[2]}` : map[p];
    return `J_Bip_${s ?? "C"}_${part}`;
  },
  blender: (p, s) => {
    const map: Record<string, string> = { hips: "hips", spine: "spine", chest: "chest", neck: "neck", head: "head", shoulder: "shoulder", upperarm: "upper_arm", forearm: "forearm", hand: "hand", thigh: "thigh", calf: "shin", foot: "foot", toe: "toe" };
    const finger = /^(thumb|index|middle|ring|little)(\d)$/.exec(p);
    const part = finger ? `${finger[1] === "little" ? "pinky" : finger[1]}.0${finger[2]}` : map[p];
    return s ? `${part}.${s}` : part;
  },
  biped: (p, s) => {
    const map: Record<string, string> = { hips: "Pelvis", spine: "Spine", chest: "Spine1", neck: "Neck", head: "Head", shoulder: "Clavicle", upperarm: "UpperArm", forearm: "Forearm", hand: "Hand", thigh: "Thigh", calf: "Calf", foot: "Foot", toe: "Toe0" };
    const finger = /^(thumb|index|middle|ring|little)(\d)$/.exec(p);
    if (finger) return `Bip01 ${s} Finger${["thumb", "index", "middle", "ring", "little"].indexOf(finger[1])}${finger[2] === "1" ? "" : Number(finger[2]) - 1}`;
    return s ? `Bip01 ${s} ${map[p]}` : `Bip01 ${map[p]}`;
  },
  mmdEnglish: (p, s) => {
    const map: Record<string, string> = { hips: "center", spine: "upper body", chest: "upper body2", neck: "neck", head: "head", shoulder: "shoulder", upperarm: "arm", forearm: "elbow", hand: "wrist", thigh: "leg", calf: "knee", foot: "ankle", toe: "toe" };
    const finger = /^(thumb|index|middle|ring|little)(\d)$/.exec(p);
    const part = finger ? `${finger[1] === "index" ? "fore" : finger[1] === "ring" ? "third" : finger[1]}${finger[1] === "thumb" ? Number(finger[2]) - 1 : finger[2]}` : map[p];
    return s ? `${part}_${s}` : part;
  },
};

for (const [convention, namer] of Object.entries(CONVENTIONS)) {
  test(`humanoid mapping: ${convention} names map every core bone and finger`, () => {
    const bones = skeleton(namer);
    const mapping = mapHumanoid(bones);
    const missing = REQUIRED_BODY_SLOTS.filter((slot) => !mapping.slots[slot]);
    assert.deepEqual(missing, [], `${convention}: missing ${missing.join(", ")}`);
    assert.equal(mapping.slots.LEFT_UPPER_LEG.bone, namer("thigh", "L"));
    assert.equal(mapping.slots.LEFT_LOWER_LEG.bone, namer("calf", "L"));
    assert.equal(mapping.slots.RIGHT_HAND.bone, namer("hand", "R"));
    const fingerSlots = Object.keys(mapping.slots).filter((s) => /(THUMB|INDEX|MIDDLE|RING|LITTLE)_/.test(s));
    assert.equal(fingerSlots.length, 30, `${convention}: ${fingerSlots.length} finger joints`);
  });
}

test("geometry fallback maps a skeleton with meaningless names", () => {
  let n = 0;
  const bones = skeleton(() => `bone_${n++}`);
  const mapping = mapHumanoid(bones);
  for (const slot of ["LEFT_UPPER_LEG", "RIGHT_LOWER_LEG", "LEFT_UPPER_ARM", "RIGHT_HAND", "HEAD"]) {
    assert.ok(mapping.slots[slot], `${slot} should be inferred`);
    assert.equal(mapping.slots[slot].method, "geometry");
  }
  // Left must really be the +X side.
  assert.ok(bones[mapping.slots.LEFT_HAND.index].position[0] > 0);
});

test("side parsing handles common conventions", () => {
  assert.deepEqual(parseBoneName("左腕"), { side: "LEFT", core: "腕" });
  assert.equal(parseBoneName("mixamorig:RightForeArm").side, "RIGHT");
  assert.equal(parseBoneName("upper_arm.L").side, "LEFT");
  assert.equal(parseBoneName("J_Bip_R_Hand").side, "RIGHT");
  assert.equal(parseBoneName("Bip01 L Calf").side, "LEFT");
  assert.equal(parseBoneName("Hand_R").side, "RIGHT");
});

test("missing fingers are reported, not faked", () => {
  const bones = skeleton(CONVENTIONS.mixamo).filter((b) => !/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(b.name));
  bones.forEach((b, i) => (b.index = i));
  // Re-link parents after filtering.
  const names = skeleton(CONVENTIONS.mixamo);
  for (const bone of bones) {
    const original = names.find((b) => b.name === bone.name)!;
    bone.parent = original.parent >= 0 ? bones.findIndex((b) => b.name === names[original.parent].name) : -1;
  }
  const rig: RigDescription = { format: "pmx", modelName: "t", englishModelName: "t", vertexCount: 0, bones, bodies: [], joints: [], morphs: [], materials: [], weightedBones: [] };
  const analysis = analyzeRig(rig);
  const fingers = analysis.items.find((i) => i.feature === "Individual fingers")!;
  assert.equal(fingers.status, "unsupported");
  assert.match(fingers.detail, /does not contain finger bones/);
});

// ---- the user's real archives (local only; skipped when absent) -------------
const ARCHIVES = ["ZSHCchUKIw.zip", "xPIr9pYwoU.zip", "RoL6mVzkCH.zip", "1745385427487.zip", "9y5Huh14gN.zip", "1737477261288 (1).zip", "1737513796662.zip"]
  .map((name) => path.join(os.homedir(), "Downloads", name))
  .filter((file) => fs.existsSync(file));

test("imports every supplied archive with a full humanoid and physics", { skip: ARCHIVES.length === 0 ? "archives not present" : false, timeout: 300_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abxag-chars-"));
  try {
    for (const archive of ARCHIVES) {
      const { profile } = await importCharacter({ source: archive, charactersRoot: root });
      const body = profile.report.items.find((i) => i.feature === "Humanoid body")!;
      assert.equal(body.status, "supported", `${profile.displayName}: ${body.detail}`);
      const fingers = profile.report.items.find((i) => i.feature === "Individual fingers")!;
      assert.equal(fingers.status, "supported", `${profile.displayName}: ${fingers.detail}`);
      assert.ok(profile.physics.chains.some((c) => c.class === "hair"), `${profile.displayName}: no hair chain`);
      assert.ok(profile.physics.colliders.length > 10, `${profile.displayName}: colliders`);
      assert.ok(fs.existsSync(path.join(root, profile.id, profile.model.file)));
      assert.ok(profile.source.restrictions.includes("No redistribution"));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

