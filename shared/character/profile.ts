/**
 * CharacterProfile: everything ABxAG remembers about an imported model, and
 * the honest compatibility report generated from it.
 *
 * Import once → the profile is stored next to the staged model and reused on
 * every launch. Users can override mappings, physics and companion settings;
 * re-analysis never discards those overrides.
 */
import { mapMaterialRoles, mapMorphs, type MaterialRoleName, type MorphSlot } from "./appearance";
import {
  FINGERS, FINGER_JOINTS, REQUIRED_BODY_SLOTS, THUMB_JOINTS, isHelperBoneName, mapHumanoid,
  type HumanoidSlot, type MappingMethod, type Side,
} from "./humanoid";
import { PMX_BONE_FLAG, type RigDescription, boneGraph, v3 } from "./rig";
import { analyzeSecondary, bodyFrame, classifyText, type ColliderProfile, type PhysicsChainProfile, type PhysicsMaterialParams } from "./secondary";

export const PROFILE_SCHEMA = 1;

export type BoneCategory =
  | "control" | "body" | "finger" | "face" | "twist" | "helper" | "ik" | "secondary" | "prop" | "other";

export interface BoneEntry {
  name: string;
  englishName: string;
  parent: string | null;
  category: BoneCategory;
  slot?: HumanoidSlot;
  /** Rotation can be edited (PMX rotatable flag). */
  rotatable: boolean;
  /** Translation can be edited (PMX translatable flag). */
  translatable: boolean;
  /** Who drives the bone at runtime when the user is not editing it. */
  drivenBy: "animation" | "physics" | "grant" | "ik-target" | "none";
  /** Whether the bone deforms vertices. */
  deforms: boolean;
}

export type FeatureStatus = "supported" | "partial" | "unsupported";
export type TestStatus = "pass" | "fail" | "not-run";

export interface CompatibilityItem {
  feature: string;
  status: FeatureStatus;
  detail: string;
}

export interface RuntimeTestResult {
  status: TestStatus;
  detail: string;
  at?: string;
}

export interface CharacterProfile {
  schema: number;
  id: string;
  displayName: string;
  importedAt: string;
  updatedAt: string;
  source: {
    kind: "zip" | "folder" | "pmx" | "pmd" | "vrm" | "glb" | "gltf" | "fbx" | "obj" | "model";
    originalPath: string;
    originalName: string;
    sha256: string;
    /** Other model files shipped in the same archive (weapons, props). */
    companionModels: string[];
    licenseFile?: string;
    licenseText?: string;
    /** Plain-language restrictions found in the readme. */
    restrictions: string[];
  };
  model: {
    format: "pmx" | "pmd" | "vrm" | "glb" | "gltf" | "fbx" | "obj";
    file: string;
    textureMap: string;
    modelName: string;
    englishName: string;
    vertexCount: number;
    boneCount: number;
    morphCount: number;
    materialCount: number;
    rigidBodyCount: number;
    jointCount: number;
    textures: { referenced: number; staged: number; converted: number; missing: string[] };
  };
  /** +1: character faces +Z in model space; -1: faces -Z. */
  facing: number;
  /** Rest height head-top-ish to feet, model units. */
  height: number;
  scale: number;
  groundOffset: number;
  skeleton: {
    humanoid: Record<HumanoidSlot, { bone: string; method: MappingMethod }>;
    bones: BoneEntry[];
    notes: string[];
  };
  morphs: {
    map: Partial<Record<MorphSlot, string>>;
    available: Array<{ name: string; type: string; panel: number }>;
  };
  materials: { roles: Partial<Record<MaterialRoleName, string[]>> };
  physics: {
    chains: PhysicsChainProfile[];
    colliders: ColliderProfile[];
    nodeGroups: Record<string, { group: number; mask: number }>;
    notes: string[];
  };
  report: {
    generatedAt: string;
    items: CompatibilityItem[];
    tests: Record<string, RuntimeTestResult>;
  };
  companion: { scale: number; anchor: "free" | "taskbar" | "window" | "screen-edge"; sitOffset: number };
  persona: { voiceName?: string; personalityId?: string };
  /** User edits that survive re-analysis. */
  overrides: {
    humanoid?: Partial<Record<HumanoidSlot, string>>;
    chains?: Record<string, { enabled?: boolean; material?: PhysicsChainProfile["material"]; params?: Partial<PhysicsMaterialParams> }>;
    morphs?: Partial<Record<MorphSlot, string>>;
    /** Simulate cloth/hair-named bones that have no authored rigid bodies. */
    generateMissingPhysics?: boolean;
  };
}

export const RUNTIME_TESTS = [
  "renders", "textures", "skeleton", "bodyPose", "handIk", "footIk", "fingers", "expressions", "animations",
  "hairPhysics", "clothPhysics", "companionRender", "dragging", "sitting", "cursorLookAt",
] as const;
export type RuntimeTestName = (typeof RUNTIME_TESTS)[number];

export interface AnalysisResult {
  facing: number;
  height: number;
  skeleton: CharacterProfile["skeleton"];
  morphs: CharacterProfile["morphs"];
  materials: CharacterProfile["materials"];
  physics: CharacterProfile["physics"];
  items: CompatibilityItem[];
}

/** Analyse a rig. `overrides` (manual mappings) are applied on top. */
export function analyzeRig(rig: RigDescription, overrides: CharacterProfile["overrides"] = {}): AnalysisResult {
  const humanoid = mapHumanoid(rig.bones);
  const indexByName = new Map(rig.bones.map((b) => [b.name, b.index] as const));
  for (const [slot, boneName] of Object.entries(overrides.humanoid ?? {})) {
    const index = boneName ? indexByName.get(boneName) : undefined;
    if (index === undefined) {
      delete humanoid.slots[slot];
      continue;
    }
    humanoid.slots[slot] = { bone: boneName!, index, method: "manual" };
  }
  const secondary = analyzeSecondary(rig, humanoid, { includeUnsimulated: !!overrides.generateMissingPhysics });
  for (const chain of secondary.chains) {
    const override = overrides.chains?.[chain.id];
    if (!override) continue;
    if (override.enabled !== undefined) chain.enabled = override.enabled;
    if (override.material) chain.material = override.material;
    if (override.params) chain.overrides = override.params;
  }
  const morphs = mapMorphs(rig);
  Object.assign(morphs.map, overrides.morphs ?? {});
  const materials = { roles: mapMaterialRoles(rig) };
  const frame = bodyFrame(rig, humanoid);

  // Bone catalogue for the advanced pose editor.
  const slotByIndex = new Map<number, HumanoidSlot>();
  for (const [slot, m] of Object.entries(humanoid.slots)) slotByIndex.set(m.index, slot);
  const chainBones = new Set(secondary.chains.flatMap((c) => c.bones));
  const weighted = new Set(rig.weightedBones);
  const ikTargets = new Set(rig.bones.filter((b) => b.ik).map((b) => b.index));
  const headIndex = humanoid.slots.HEAD?.index ?? -1;
  const { depth } = boneGraph(rig.bones);
  const underHead = (index: number): boolean => {
    let cursor = rig.bones[index].parent;
    for (let guard = 0; cursor >= 0 && guard < 64; guard += 1) {
      if (cursor === headIndex) return true;
      cursor = rig.bones[cursor].parent;
    }
    return false;
  };
  const bones: BoneEntry[] = rig.bones.map((bone) => {
    const slot = slotByIndex.get(bone.index);
    const lower = `${bone.name} ${bone.englishName}`.toLowerCase();
    let category: BoneCategory;
    if (slot && /(THUMB|INDEX|MIDDLE|RING|LITTLE)_/.test(slot)) category = "finger";
    else if (slot && /^(ROOT|CENTER|GROOVE|WAIST)$/.test(slot)) category = "control";
    else if (slot) category = "body";
    else if (chainBones.has(bone.name)) category = "secondary";
    else if (ikTargets.has(bone.index) || /(^|[^a-z])ik([^a-z]|$)|ＩＫ/.test(lower)) category = "ik";
    else if (/捩|twist|roll/.test(lower)) category = "twist";
    else if (/^操作中心|view ?cnt|^全ての親|^master/.test(lower)) category = "control";
    else if (/weapon|武器|prop|barrel|trigger|gun|sword|umbrella|伞/.test(lower)) category = "prop";
    else if (headIndex >= 0 && underHead(bone.index)) category = "face";
    else if (isHelperBoneName(bone.name)) category = "helper";
    else category = "other";
    const grantDriven = !!bone.grant && bone.grant.ratio !== 0 && !(bone.flags & PMX_BONE_FLAG.rotatable);
    return {
      name: bone.name,
      englishName: bone.englishName,
      parent: bone.parent >= 0 ? rig.bones[bone.parent].name : null,
      category,
      slot,
      rotatable: (bone.flags & PMX_BONE_FLAG.rotatable) !== 0,
      translatable: (bone.flags & PMX_BONE_FLAG.translatable) !== 0,
      drivenBy: chainBones.has(bone.name) ? "physics" : bone.grant && bone.grant.ratio !== 0 ? "grant" : ikTargets.has(bone.index) ? "ik-target" : grantDriven ? "grant" : "animation",
      deforms: weighted.has(bone.index),
    };
  });
  void depth;

  // Height: head bone (plus a head's worth) down to the lowest foot/toe.
  const pos = (slot: string) => (humanoid.slots[slot] ? rig.bones[humanoid.slots[slot].index].position : null);
  const head = pos("HEAD");
  const feet = ["LEFT_FOOT", "RIGHT_FOOT", "LEFT_TOES", "RIGHT_TOES"].map(pos).filter(Boolean) as Array<[number, number, number]>;
  const floor = feet.length ? Math.min(...feet.map((p) => p[1])) : Math.min(...rig.bones.map((b) => b.position[1]));
  const neck = pos("NECK");
  const height = head ? head[1] - floor + (neck ? Math.max(0.5, (head[1] - neck[1]) * 2.2) : 2) : Math.max(...rig.bones.map((b) => b.position[1])) - floor;

  const skeleton: CharacterProfile["skeleton"] = {
    humanoid: Object.fromEntries(Object.entries(humanoid.slots).map(([slot, m]) => [slot, { bone: m.bone, method: m.method }])),
    bones,
    notes: humanoid.notes,
  };
  const physics: CharacterProfile["physics"] = {
    chains: secondary.chains,
    colliders: secondary.colliders,
    nodeGroups: secondary.nodeGroups,
    notes: secondary.notes,
  };
  const items = compatibilityItems(rig, skeleton, morphs, physics);
  return { facing: frame.front, height, skeleton, morphs, materials, physics, items };
}

function compatibilityItems(
  rig: RigDescription,
  skeleton: CharacterProfile["skeleton"],
  morphs: CharacterProfile["morphs"],
  physics: CharacterProfile["physics"]
): CompatibilityItem[] {
  const has = (slot: string) => !!skeleton.humanoid[slot];
  const items: CompatibilityItem[] = [];
  const missingBody = REQUIRED_BODY_SLOTS.filter((slot) => !has(slot));
  const guessed = Object.entries(skeleton.humanoid).filter(([, m]) => m.method === "geometry").map(([s]) => s);
  items.push({
    feature: "Humanoid body",
    status: missingBody.length === 0 ? "supported" : missingBody.length <= 3 ? "partial" : "unsupported",
    detail: missingBody.length === 0
      ? `All ${REQUIRED_BODY_SLOTS.length} core body bones mapped${guessed.length ? ` (${guessed.length} inferred from skeleton shape: ${guessed.slice(0, 6).join(", ")})` : " by name"}.`
      : `Missing core bones: ${missingBody.join(", ")}. These body parts cannot be posed or animated until mapped manually.`,
  });
  const editable = skeleton.bones.filter((b) => b.rotatable || b.translatable).length;
  items.push({
    feature: "Body pose editing",
    status: missingBody.length === 0 ? "supported" : "partial",
    detail: `${editable} of ${skeleton.bones.length} bones are user-editable (rotation${skeleton.bones.some((b) => b.translatable) ? "/translation where the rig allows it" : ""}).`,
  });
  for (const [feature, parts] of [
    ["Hand IK", ["UPPER_ARM", "LOWER_ARM", "HAND"]],
    ["Foot IK", ["UPPER_LEG", "LOWER_LEG", "FOOT"]],
  ] as Array<[string, string[]]>) {
    const missing = (["LEFT", "RIGHT"] as Side[]).flatMap((side) => parts.map((p) => `${side}_${p}`)).filter((s) => !has(s));
    items.push({
      feature,
      status: missing.length === 0 ? "supported" : missing.length < parts.length * 2 ? "partial" : "unsupported",
      detail: missing.length === 0 ? "Two-bone IK with hinge limits on both sides." : `Unavailable for: ${missing.join(", ")} (bones not present or not mapped).`,
    });
  }
  items.push({
    feature: "Head / look-at IK",
    status: has("HEAD") && has("NECK") ? "supported" : has("HEAD") ? "partial" : "unsupported",
    detail: has("HEAD") && has("NECK") ? "Look direction is distributed over neck and head with limits." : has("HEAD") ? "No neck bone: the head turns alone." : "No head bone was found.",
  });
  const fingerCounts = (["LEFT", "RIGHT"] as Side[]).map((side) =>
    FINGERS.flatMap((f) => (f === "THUMB" ? THUMB_JOINTS : FINGER_JOINTS).map((j) => `${side}_${f}_${j}`)).filter(has).length
  );
  const fingerTotal = fingerCounts[0] + fingerCounts[1];
  items.push({
    feature: "Individual fingers",
    status: fingerTotal === 30 ? "supported" : fingerTotal > 0 ? "partial" : "unsupported",
    detail: fingerTotal === 30
      ? "All 15 finger joints per hand are individually controllable."
      : fingerTotal > 0
        ? `Left hand ${fingerCounts[0]}/15 and right hand ${fingerCounts[1]}/15 finger joints found; the rest do not exist in this model.`
        : "Individual finger control unavailable because this source model does not contain finger bones.",
  });
  const eyes = has("LEFT_EYE") || has("RIGHT_EYE") || has("EYES");
  items.push({
    feature: "Eye look-at",
    status: eyes ? "supported" : "unsupported",
    detail: eyes ? "Eye bones present." : "No eye bones: gaze uses head and neck only.",
  });
  const visemes = ["visemeA", "visemeI", "visemeU", "visemeE", "visemeO"].filter((k) => morphs.map[k as MorphSlot]).length;
  const expressionSlots = Object.keys(morphs.map).length;
  items.push({
    feature: "Facial morphs",
    status: morphs.map.blink && expressionSlots >= 8 ? "supported" : expressionSlots > 0 ? "partial" : "unsupported",
    detail: expressionSlots > 0
      ? `${expressionSlots} expression slots mapped from ${morphs.available.length} morphs${morphs.map.blink ? "" : "; no blink morph"}.`
      : rig.morphs.length > 0
        ? `The model has ${rig.morphs.length} morphs but none use recognised names; map them manually.`
        : "Facial expressions unavailable because this model contains no morphs.",
  });
  items.push({
    feature: "Lip sync",
    status: visemes >= 3 ? "supported" : visemes > 0 ? "partial" : "unsupported",
    detail: visemes > 0 ? `${visemes}/5 vowel mouth shapes found.` : "No vowel mouth morphs (あいうえお / A I U E O) found.",
  });
  const byClass = (classes: string[]) => physics.chains.filter((c) => classes.includes(c.class));
  // Bones that look like cloth/hair but were given no physics by the author.
  const unsimulated = (classes: string[]) =>
    skeleton.bones.filter((b) => b.drivenBy !== "physics" && !b.slot && (b.category === "other" || b.category === "face") && classes.includes(classifyText(b.name) ?? classifyText(b.englishName) ?? "")).length;
  const chainItem = (feature: string, classes: string[], absentReason: string) => {
    const chains = byClass(classes);
    const idle = unsimulated(classes);
    if (chains.length === 0 && idle > 0) {
      absentReason = `${absentReason.replace(/\.$/, "")}. ${idle} matching bone(s) exist but the model gives them no rigid bodies, so they stay rigid; enable generated physics for them in Character → Physics.`;
    }
    const bonesCount = chains.reduce((n, c) => n + c.bones.length, 0);
    const generated = chains.some((c) => c.source === "generated");
    items.push({
      feature,
      status: chains.length > 0 ? "supported" : "unsupported",
      detail: chains.length > 0
        ? `${chains.length} chain group(s), ${bonesCount} simulated bones${generated ? " (generated from bone names; no authored rigid bodies)" : " (from the model's own rigid bodies)"}.`
        : absentReason,
    });
  };
  chainItem("Hair physics", ["hair", "ponytail"], "No hair bones with physics: this model's hair is part of the head mesh and cannot swing.");
  chainItem("Skirt physics", ["skirt"], "No skirt bones found (the outfit has no skirt, or it is not rigged).");
  chainItem("Clothing physics", ["jacket", "sleeve", "skirt"], "No simulated clothing bones found.");
  chainItem("Ribbons & accessories", ["ribbon", "accessory"], "No ribbon or accessory chains found.");
  if (byClass(["tail"]).length) chainItem("Tail physics", ["tail"], "");
  const colliderSource = physics.colliders.length === 0 ? "none" : physics.colliders.every((c) => c.source === "generated") ? "generated" : "authored";
  items.push({
    feature: "Body collision",
    status: colliderSource === "none" ? "unsupported" : "supported",
    detail: colliderSource === "authored"
      ? `${physics.colliders.length} collision shapes from the model's rigid bodies keep hair and cloth out of the body.`
      : colliderSource === "generated"
        ? `${physics.colliders.length} capsules generated from the skeleton (the model has none).`
        : "No collision shapes; cloth may pass through the body.",
  });
  items.push({
    feature: "Animations",
    status: missingBody.length === 0 ? "supported" : "partial",
    detail: "Procedural idle, gaze, gestures and IK-driven poses work through the humanoid mapping. Importing keyframed motion files (VMD/FBX clips) is not implemented.",
  });
  return items;
}

/** Find plain-language restrictions in a Chinese/Japanese/English readme. */
export function extractRestrictions(text: string): string[] {
  const rules: Array<[RegExp, string]> = [
    [/二次配布|再配布|redistribut|转载|二次分发/i, "No redistribution"],
    [/拆取部件|パーツ.*流用|部件/i, "Do not extract parts for other models"],
    [/商业|商用|commercial/i, "No commercial use"],
    [/18禁|R-?18|成人/i, "No adult (R-18) content"],
    [/宗教|血腥|恐怖|猎奇|人身攻击|政治/i, "No extreme religious, gore or defamatory use"],
  ];
  return rules.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

export function slugify(input: string, fallback: string): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ascii || fallback;
}

export { v3 };

