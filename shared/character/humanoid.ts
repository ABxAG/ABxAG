/**
 * Skeleton normalisation: maps any model's bone names onto ABxAG's common
 * humanoid representation while keeping the original bone names.
 *
 * Different exporters name the same bone very differently:
 *
 *   MMD (JP)   左腕          MMD (EN)  arm_L
 *   Mixamo     mixamorig:LeftArm        VRoid     J_Bip_L_UpperArm
 *   Unity      UpperArm_L               Blender   upper_arm.L
 *   3ds Max    Bip01 L UpperArm
 *
 * all of which become LEFT_UPPER_ARM. Matching is name-first (with side
 * detection and exporter prefixes stripped), validated against the hierarchy,
 * then gaps are filled from the hierarchy and, as a last resort, from the
 * skeleton's geometry. Every mapped slot records HOW it was found so the
 * compatibility report can be honest about guesses.
 */
import { type RigBone, type Vec3, boneGraph, isAncestor, v3 } from "./rig";

export type Side = "LEFT" | "RIGHT";
export type FingerName = "THUMB" | "INDEX" | "MIDDLE" | "RING" | "LITTLE";
export type FingerJoint = "METACARPAL" | "PROXIMAL" | "INTERMEDIATE" | "DISTAL";

export const FINGERS: FingerName[] = ["THUMB", "INDEX", "MIDDLE", "RING", "LITTLE"];
export const THUMB_JOINTS: FingerJoint[] = ["METACARPAL", "PROXIMAL", "DISTAL"];
export const FINGER_JOINTS: FingerJoint[] = ["PROXIMAL", "INTERMEDIATE", "DISTAL"];

const CORE_SLOTS = [
  "ROOT", "CENTER", "GROOVE", "WAIST", "HIPS", "LOWER_BODY", "SPINE", "CHEST", "UPPER_CHEST", "NECK", "HEAD",
  "EYES", "LEFT_EYE", "RIGHT_EYE", "JAW",
] as const;
const LIMB_PARTS = ["SHOULDER", "UPPER_ARM", "LOWER_ARM", "HAND", "UPPER_LEG", "LOWER_LEG", "FOOT", "TOES"] as const;
type LimbPart = (typeof LIMB_PARTS)[number];

export type HumanoidSlot = string;

/** Every slot ABxAG understands, in hierarchy-friendly order. */
export const HUMANOID_SLOTS: HumanoidSlot[] = [
  ...CORE_SLOTS,
  ...(["LEFT", "RIGHT"] as Side[]).flatMap((side) => [
    ...LIMB_PARTS.map((part) => `${side}_${part}`),
    ...FINGERS.flatMap((finger) =>
      (finger === "THUMB" ? THUMB_JOINTS : FINGER_JOINTS).map((joint) => `${side}_${finger}_${joint}`)
    ),
  ]),
];

/** Slots without which the body cannot be posed as a humanoid. */
export const REQUIRED_BODY_SLOTS: HumanoidSlot[] = [
  "SPINE", "NECK", "HEAD",
  "LEFT_UPPER_ARM", "LEFT_LOWER_ARM", "LEFT_HAND", "RIGHT_UPPER_ARM", "RIGHT_LOWER_ARM", "RIGHT_HAND",
  "LEFT_UPPER_LEG", "LEFT_LOWER_LEG", "LEFT_FOOT", "RIGHT_UPPER_LEG", "RIGHT_LOWER_LEG", "RIGHT_FOOT",
];

export function fingerSlots(side: Side): HumanoidSlot[] {
  return FINGERS.flatMap((finger) =>
    (finger === "THUMB" ? THUMB_JOINTS : FINGER_JOINTS).map((joint) => `${side}_${finger}_${joint}`)
  );
}

export function mirrorSlot(slot: HumanoidSlot): HumanoidSlot {
  if (slot.startsWith("LEFT_")) return `RIGHT_${slot.slice(5)}`;
  if (slot.startsWith("RIGHT_")) return `LEFT_${slot.slice(6)}`;
  return slot;
}

export type MappingMethod = "name" | "hierarchy" | "geometry" | "manual";

export interface SlotMapping {
  bone: string;
  index: number;
  method: MappingMethod;
}

export interface HumanoidMapping {
  slots: Record<HumanoidSlot, SlotMapping>;
  /** Warnings worth showing in the compatibility report. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Name parsing
// ---------------------------------------------------------------------------

interface ParsedName {
  side: Side | null;
  core: string;
}

const PREFIXES = [/^mixamorig\d*[:_]/i, /^j_bip_[clr]_/i, /^j_sec_[clr]_/i, /^j_adj_[clr]_/i, /^bip0?1[\s_]?/i, /^def[-_]/i, /^org[-_]/i, /^armature[|:_]/i, /^b_/i, /^bone_/i, /^valvebiped\.bip01_/i];

/** Split a bone name into side and a normalised core token. */
export function parseBoneName(raw: string): ParsedName {
  let name = raw.trim();
  let side: Side | null = null;
  // Prefix-encoded side (VRoid J_Bip_L_, 3ds Max "Bip01 L ").
  const vroid = /^j_(?:bip|sec|adj)_([lr])_/i.exec(name);
  if (vroid) side = vroid[1].toLowerCase() === "l" ? "LEFT" : "RIGHT";
  const biped = /^bip0?1[\s_]([lr])[\s_]/i.exec(name);
  if (biped) {
    side = biped[1].toLowerCase() === "l" ? "LEFT" : "RIGHT";
    name = name.replace(/^bip0?1[\s_][lr][\s_]/i, "");
  }
  for (const prefix of PREFIXES) name = name.replace(prefix, "");
  // CJK side markers.
  const cjk = /^(左|右)/.exec(name);
  if (cjk) {
    side = cjk[1] === "左" ? "LEFT" : "RIGHT";
    name = name.slice(1);
  }
  // Words.
  const word = /(^|[^a-z])(left|right)(?=$|[^a-z]|[A-Z])/i.exec(name) || /^(left|right)/i.exec(name);
  if (!side && word) {
    const w = (word[2] ?? word[1]).toLowerCase();
    side = w === "left" ? "LEFT" : "RIGHT";
    name = name.replace(/left|right/i, "");
  }
  // Suffix / infix single letters: arm_L, upper_arm.L, Hand.R, UpperArm_L, L_Hand, Hand L.
  if (!side) {
    const suffix = /[\s._-]([lr])$/i.exec(name);
    const prefix = /^([lr])[\s._-]/i.exec(name);
    const infix = /[\s._-]([lr])[\s._-]/i.exec(name);
    const hit = suffix || prefix || infix;
    if (hit) {
      side = hit[1].toLowerCase() === "l" ? "LEFT" : "RIGHT";
      name = suffix ? name.slice(0, -2) : prefix ? name.slice(2) : name.replace(infix![0], "_");
    }
  }
  const core = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s._:|-]+/g, "");
  return { side, core };
}

/** Bones that exist for rig mechanics rather than as body parts. */
export function isHelperBoneName(raw: string): boolean {
  const n = raw.normalize("NFKC").toLowerCase();
  if (n === "全ての親" || n === "全親") return false;
  return (
    /捩|twist|roll|補|补|helper|aux|dummy|ダミー|キャンセル|cancel|錘|锤|nub|_end$|tip$|先$|親$|^操作中心|viewcnt|ex$/.test(n) ||
    /(^|[^a-z])ik([^a-z]|$)/.test(n) ||
    /^(左|右)?(肩|足|ひざ|足首)(p|c|d)$/.test(n) ||
    /^(左|右)(足|ひざ|足首)d\d*$/.test(n)
  );
}

/** Name tables: normalised core token → slot part. Order within a list matters. */
const CORE_NAMES: Array<[RegExp, (typeof CORE_SLOTS)[number]]> = [
  [/^(全ての親|全親|master|root|armature)$/, "ROOT"],
  [/^(センター|center|centre)$/, "CENTER"],
  [/^(グルーブ|groove)$/, "GROOVE"],
  [/^(腰|waist)$/, "WAIST"],
  [/^(下半身|lowerbody|下半身1)$/, "LOWER_BODY"],
  [/^(hips|hip|pelvis|骨盆|cog)$/, "HIPS"],
  [/^(上半身|upperbody|spine|spine0|脊椎|上身)$/, "SPINE"],
  [/^(上半身1|上半身2|upperbody2|spine1|chest|胸部)$/, "CHEST"],
  [/^(上半身3|upperbody3|spine2|upperchest)$/, "UPPER_CHEST"],
  [/^(首|neck|脖子|颈)$/, "NECK"],
  [/^(頭|头|head)$/, "HEAD"],
  [/^(両目|eyes|両眼)$/, "EYES"],
  [/^(あご|顎|jaw|jawjoint|下巴)$/, "JAW"],
];

const LIMB_NAMES: Array<[RegExp, LimbPart]> = [
  [/^(肩|shoulder|clavicle|collar|collarbone|锁骨)$/, "SHOULDER"],
  [/^(腕|arm|upperarm|uparm|上臂|上腕|大臂)$/, "UPPER_ARM"],
  [/^(ひじ|肘|elbow|forearm|lowerarm|前腕|小臂|手肘)$/, "LOWER_ARM"],
  [/^(手首|手|wrist|hand|手腕)$/, "HAND"],
  [/^(足|leg|upperleg|upleg|thigh|大腿|太もも)$/, "UPPER_LEG"],
  [/^(ひざ|膝|knee|lowerleg|calf|shin|小腿)$/, "LOWER_LEG"],
  [/^(足首|ankle|foot|脚踝|脚)$/, "FOOT"],
  [/^(足先ex|つま先ex|toe|toes|toebase|toe0|脚趾|つま先)$/, "TOES"],
];

/** Finger name → (finger, segment number as written). */
const FINGER_NAMES: Array<[RegExp, FingerName]> = [
  [/^(親指|拇指|thumb|handthumb|finger0)([0-9]?)$/, "THUMB"],
  [/^(人指|人差指|人差し指|食指|index|fore|handindex|finger1)([0-9]?)$/, "INDEX"],
  [/^(中指|middle|handmiddle|finger2)([0-9]?)$/, "MIDDLE"],
  [/^(薬指|无名指|無名指|ring|third|handring|finger3)([0-9]?)$/, "RING"],
  [/^(小指|little|pinky|handpinky|finger4)([0-9]?)$/, "LITTLE"],
];

/** 3ds Max style Finger01/Finger02 (finger index + joint digit). */
const BIPED_FINGER = /^finger([0-4])([0-2]?)$/;

interface Candidate {
  slot: HumanoidSlot;
  index: number;
  score: number;
}

function nameCandidates(bones: RigBone[]): Candidate[] {
  const out: Candidate[] = [];
  const fingerHits: Array<{ index: number; side: Side; finger: FingerName; num: number }> = [];

  for (const bone of bones) {
    for (const [label, weight] of [[bone.name, 1], [bone.englishName, 0.8]] as Array<[string, number]>) {
      if (!label) continue;
      const { side, core } = parseBoneName(label);
      const helper = isHelperBoneName(label);
      if (!side) {
        for (const [pattern, slot] of CORE_NAMES) {
          if (pattern.test(core)) out.push({ slot, index: bone.index, score: weight * (helper ? 0.2 : 1) });
        }
        // Eyes are side-specific but often unprefixed in English ("eye_L" handled above).
        continue;
      }
      if (/^(目|eye|眼)$/.test(core)) out.push({ slot: `${side}_EYE`, index: bone.index, score: weight });
      for (const [pattern, part] of LIMB_NAMES) {
        if (!pattern.test(core)) continue;
        // MMD: 足先EX is the deforming toe; つま先 is usually an IK tip marker.
        const score = part === "TOES" ? (core.endsWith("ex") ? 1 : 0.7) : helper ? 0.15 : 1;
        out.push({ slot: `${side}_${part}`, index: bone.index, score: weight * score });
      }
      // Fingers: digits may be full-width (親指０) — NFKC normalised already.
      const biped = BIPED_FINGER.exec(core);
      if (biped) {
        fingerHits.push({ index: bone.index, side, finger: FINGERS[Number(biped[1])], num: biped[2] === "" ? 0 : Number(biped[2]) });
        continue;
      }
      for (const [pattern, finger] of FINGER_NAMES) {
        const m = pattern.exec(core);
        if (m && !helper) fingerHits.push({ index: bone.index, side, finger, num: m[2] === "" ? -1 : Number(m[2]) });
      }
    }
  }

  // Finger segment numbering differs by convention (MMD thumb 0-2 others 1-3,
  // Mixamo 1-3, VRoid 1-3). Rank each finger's segments by their written
  // number, then hierarchy depth, and assign joints in order.
  const groups = new Map<string, Array<{ index: number; num: number }>>();
  for (const hit of fingerHits) {
    const key = `${hit.side}_${hit.finger}`;
    const list = groups.get(key) ?? [];
    if (!list.some((item) => item.index === hit.index)) list.push({ index: hit.index, num: hit.num });
    groups.set(key, list);
  }
  const { depth } = boneGraph(bones);
  for (const [key, list] of groups) {
    const finger = key.split("_")[1] as FingerName;
    const joints = finger === "THUMB" ? THUMB_JOINTS : FINGER_JOINTS;
    // Ignore zero-length tip markers (they have no children and sit at the tip).
    const sorted = list.sort((a, b) => (a.num - b.num) || (depth[a.index] - depth[b.index]));
    const usable = sorted.length > joints.length ? sorted.slice(0, joints.length) : sorted;
    // With only two thumb bones, they are proximal + distal.
    const assign = finger === "THUMB" && usable.length === 2 ? (["PROXIMAL", "DISTAL"] as FingerJoint[]) : joints;
    usable.forEach((item, i) => {
      if (assign[i]) out.push({ slot: `${key}_${assign[i]}`, index: item.index, score: 1 });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function mapHumanoid(bones: RigBone[]): HumanoidMapping {
  const slots: Record<HumanoidSlot, SlotMapping> = {};
  const notes: string[] = [];
  const used = new Set<number>();
  const assign = (slot: HumanoidSlot, index: number, method: MappingMethod) => {
    if (index < 0 || slots[slot] || used.has(index)) return false;
    slots[slot] = { bone: bones[index].name, index, method };
    used.add(index);
    return true;
  };

  // 1. Best name candidate per slot (prefer non-helper, then shallower).
  const { depth, children } = boneGraph(bones);
  const candidates = nameCandidates(bones).sort((a, b) => b.score - a.score || depth[a.index] - depth[b.index]);
  const best = new Map<HumanoidSlot, Candidate[]>();
  for (const candidate of candidates) {
    const list = best.get(candidate.slot) ?? [];
    list.push(candidate);
    best.set(candidate.slot, list);
  }
  // Mixamo/Unity call the CALF "Leg" and the thigh "UpLeg": when an explicit
  // up-leg exists, "leg" means the lower leg.
  for (const side of ["LEFT", "RIGHT"] as Side[]) {
    const upper = best.get(`${side}_UPPER_LEG`) ?? [];
    const explicitUp = upper.filter((c) => /up(per)?leg|thigh|大腿|太もも/i.test(parseBoneName(bones[c.index].name).core + parseBoneName(bones[c.index].englishName).core));
    if (explicitUp.length > 0 && upper.length > explicitUp.length) {
      const plainLeg = upper.filter((c) => !explicitUp.includes(c));
      best.set(`${side}_UPPER_LEG`, explicitUp);
      best.set(`${side}_LOWER_LEG`, [...plainLeg, ...(best.get(`${side}_LOWER_LEG`) ?? [])]);
    }
  }
  for (const slot of HUMANOID_SLOTS) {
    for (const candidate of best.get(slot) ?? []) {
      if (candidate.score < 0.5) continue;
      if (assign(slot, candidate.index, "name")) break;
    }
  }

  // 2. Hierarchy validation: limb chains must descend in order.
  for (const side of ["LEFT", "RIGHT"] as Side[]) {
    const order: LimbPart[][] = [["SHOULDER", "UPPER_ARM", "LOWER_ARM", "HAND"], ["UPPER_LEG", "LOWER_LEG", "FOOT", "TOES"]];
    for (const chain of order) {
      for (let i = 1; i < chain.length; i += 1) {
        const parentSlot = `${side}_${chain[i - 1]}`;
        const childSlot = `${side}_${chain[i]}`;
        const parent = slots[parentSlot];
        const child = slots[childSlot];
        if (parent && child && !isAncestorOrGrant(bones, parent.index, child.index)) {
          notes.push(`${childSlot} (${child.bone}) is not below ${parentSlot} (${parent.bone}); mapping dropped.`);
          used.delete(child.index);
          delete slots[childSlot];
        }
      }
    }
  }

  // 3. Fill gaps from the hierarchy.
  const firstRealAncestor = (index: number, stop?: number): number => {
    let cursor = bones[index].parent;
    for (let guard = 0; cursor >= 0 && guard < 64; guard += 1) {
      if (cursor === stop) return -1;
      const bone = bones[cursor];
      if (!isHelperBoneName(bone.name) && !isHelperBoneName(bone.englishName || "x")) return cursor;
      cursor = bone.parent;
    }
    return -1;
  };
  for (const side of ["LEFT", "RIGHT"] as Side[]) {
    const hand = slots[`${side}_HAND`];
    if (hand && !slots[`${side}_LOWER_ARM`]) assign(`${side}_LOWER_ARM`, firstRealAncestor(hand.index), "hierarchy");
    const lower = slots[`${side}_LOWER_ARM`];
    if (lower && !slots[`${side}_UPPER_ARM`]) assign(`${side}_UPPER_ARM`, firstRealAncestor(lower.index), "hierarchy");
    const foot = slots[`${side}_FOOT`];
    if (foot && !slots[`${side}_LOWER_LEG`]) assign(`${side}_LOWER_LEG`, firstRealAncestor(foot.index), "hierarchy");
    const knee = slots[`${side}_LOWER_LEG`];
    if (knee && !slots[`${side}_UPPER_LEG`]) assign(`${side}_UPPER_LEG`, firstRealAncestor(knee.index), "hierarchy");
  }
  // Spine intermediates: deforming bones strictly between SPINE and NECK.
  const spine = slots.SPINE;
  const neck = slots.NECK;
  if (spine && neck && isAncestor(bones, spine.index, neck.index)) {
    const between: number[] = [];
    let cursor = bones[neck.index].parent;
    while (cursor >= 0 && cursor !== spine.index) {
      if (!isHelperBoneName(bones[cursor].name)) between.unshift(cursor);
      cursor = bones[cursor].parent;
    }
    // Rebuild CHEST / UPPER_CHEST from the actual chain so "上半身1 → 上半身2"
    // and "Spine1 → Spine2" both come out right.
    for (const slot of ["CHEST", "UPPER_CHEST"]) {
      const current = slots[slot];
      if (current && !between.includes(current.index)) {
        used.delete(current.index);
        delete slots[slot];
      }
    }
    if (between[0] !== undefined && !slots.CHEST) assign("CHEST", between[0], "hierarchy");
    if (between[1] !== undefined && !slots.UPPER_CHEST) assign("UPPER_CHEST", between[between.length - 1], "hierarchy");
  }
  if (!slots.HEAD && neck) {
    const kid = children[neck.index].find((c) => !isHelperBoneName(bones[c].name));
    if (kid !== undefined) assign("HEAD", kid, "hierarchy");
  }
  // HIPS: the bone whose rotation turns the whole body. For MMD rigs that is
  // センター (or グルーブ/腰 below it); otherwise the common ancestor of the
  // spine and the legs.
  if (!slots.HIPS) {
    const pick = slots.WAIST ?? slots.GROOVE ?? slots.CENTER;
    if (pick) {
      slots.HIPS = { ...pick };
    } else if (spine && slots.LEFT_UPPER_LEG) {
      let cursor = bones[spine.index].parent;
      while (cursor >= 0 && !isAncestor(bones, cursor, slots.LEFT_UPPER_LEG.index)) cursor = bones[cursor].parent;
      if (cursor >= 0) assign("HIPS", cursor, "hierarchy");
    }
  }

  // 4. Geometry fallback for rigs with meaningless names.
  if (REQUIRED_BODY_SLOTS.filter((slot) => !slots[slot]).length >= 6) {
    const guessed = geometryFallback(bones, slots, used);
    if (guessed > 0) notes.push(`${guessed} body bones were inferred from skeleton shape because their names were not recognised.`);
  }

  // Fingers by hierarchy when names failed but the hand has 4-5 child chains.
  for (const side of ["LEFT", "RIGHT"] as Side[]) {
    const hand = slots[`${side}_HAND`];
    if (!hand) continue;
    const named = fingerSlots(side).filter((slot) => slots[slot]).length;
    if (named > 0) continue;
    inferFingers(bones, children, hand.index, side, slots, used);
  }

  return { slots, notes };
}

/**
 * Ancestry that also follows MMD grant ("D") bones: 足先EX hangs below
 * 足首D, which copies 足首 through a full-strength grant, so it is
 * effectively below 足首.
 */
function isAncestorOrGrant(bones: RigBone[], ancestor: number, child: number): boolean {
  let cursor = bones[child]?.parent ?? -1;
  for (let guard = 0; cursor >= 0 && guard < 512; guard += 1) {
    if (cursor === ancestor) return true;
    const grant = bones[cursor].grant;
    if (grant && grant.rotation && grant.ratio > 0.5 && (grant.parent === ancestor || isAncestor(bones, ancestor, grant.parent))) return true;
    cursor = bones[cursor].parent;
  }
  return false;
}

/** Infer finger chains below a hand from geometry. */
function inferFingers(
  bones: RigBone[],
  children: number[][],
  hand: number,
  side: Side,
  slots: Record<HumanoidSlot, SlotMapping>,
  used: Set<number>
): void {
  const chains: number[][] = [];
  for (const kid of children[hand]) {
    const chain = [kid];
    let cursor = kid;
    while (children[cursor].length === 1 && chain.length < 4) {
      cursor = children[cursor][0];
      chain.push(cursor);
    }
    if (chain.length >= 2) chains.push(chain);
  }
  if (chains.length < 4 || chains.length > 6) return;
  // Thumb: the chain whose base sits furthest forward (-Z) relative to the hand.
  const handPos = bones[hand].position;
  const sorted = [...chains].sort((a, b) => bones[a[0]].position[2] - bones[b[0]].position[2]);
  const thumb = sorted[0];
  const rest = chains
    .filter((c) => c !== thumb)
    .sort((a, b) => v3.dist(bones[a[0]].position, bones[thumb[0]].position) - v3.dist(bones[b[0]].position, bones[thumb[0]].position));
  void handPos;
  const ordered: Array<[FingerName, number[]]> = [["THUMB", thumb], ...rest.slice(0, 4).map((c, i) => [FINGERS[i + 1], c] as [FingerName, number[]])];
  for (const [finger, chain] of ordered) {
    const joints = finger === "THUMB" ? THUMB_JOINTS : FINGER_JOINTS;
    chain.slice(0, joints.length).forEach((index, i) => {
      const slot = `${side}_${finger}_${joints[i]}`;
      if (!slots[slot] && !used.has(index)) {
        slots[slot] = { bone: bones[index].name, index, method: "geometry" };
        used.add(index);
      }
    });
  }
}

/**
 * Topology fallback: find limbs as long chains leaving the spine sideways
 * (arms) or downward (legs). Only fills slots still empty.
 */
function geometryFallback(bones: RigBone[], slots: Record<HumanoidSlot, SlotMapping>, used: Set<number>): number {
  const { children } = boneGraph(bones);
  let count = 0;
  const set = (slot: HumanoidSlot, index: number | undefined) => {
    if (index === undefined || index < 0 || slots[slot] || used.has(index)) return;
    slots[slot] = { bone: bones[index].name, index, method: "geometry" };
    used.add(index);
    count += 1;
  };
  // Longest descending chain from a bone, following the child with most descendants.
  const descendants = (i: number): number => children[i].reduce((sum, c) => sum + 1 + descendants(c), 0);
  const chainFrom = (start: number, max: number): number[] => {
    const chain = [start];
    let cursor = start;
    while (chain.length < max && children[cursor].length > 0) {
      cursor = children[cursor].reduce((a, b) => (descendants(a) >= descendants(b) ? a : b));
      chain.push(cursor);
    }
    return chain;
  };
  // Find the bone with the most descendants that branches into >=3 large subtrees (pelvis).
  let pelvis = -1;
  let bestScore = 0;
  for (const bone of bones) {
    const big = children[bone.index].filter((c) => descendants(c) >= 3);
    if (big.length >= 3 && descendants(bone.index) > bestScore) {
      bestScore = descendants(bone.index);
      pelvis = bone.index;
    }
  }
  if (pelvis < 0) return 0;
  const p = bones[pelvis].position;
  const branches = children[pelvis].filter((c) => descendants(c) >= 3).map((c) => chainFrom(c, 12));
  const tipOf = (chain: number[]): Vec3 => bones[chain[chain.length - 1]].position;
  const legs = branches.filter((chain) => tipOf(chain)[1] < p[1] - 0.2).sort((a, b) => tipOf(b)[0] - tipOf(a)[0]);
  const spineBranch = branches.find((chain) => tipOf(chain)[1] > p[1] + 0.2);
  set("HIPS", pelvis);
  if (legs.length >= 2) {
    const [left, right] = [legs[0], legs[legs.length - 1]];
    for (const [side, chain] of [["LEFT", left], ["RIGHT", right]] as Array<[Side, number[]]>) {
      set(`${side}_UPPER_LEG`, chain[0]);
      set(`${side}_LOWER_LEG`, chain[1]);
      set(`${side}_FOOT`, chain[2]);
      set(`${side}_TOES`, chain[3]);
    }
  }
  if (spineBranch) {
    // Arms branch off the upper spine sideways.
    let armRoot = -1;
    for (const index of spineBranch) {
      const sideways = children[index].filter((c) => Math.abs(bones[c].position[0] - bones[index].position[0]) > 0.05 && descendants(c) >= 3);
      if (sideways.length >= 2) {
        armRoot = index;
        break;
      }
    }
    set("SPINE", spineBranch[0]);
    if (armRoot >= 0) {
      const spineChain = spineBranch.slice(0, spineBranch.indexOf(armRoot) + 1);
      if (spineChain.length > 1) set("CHEST", spineChain[1]);
      if (spineChain.length > 2) set("UPPER_CHEST", spineChain[spineChain.length - 1]);
      // The neck leaves the arm root upward, near the centre line.
      const neckIndex = children[armRoot]
        .filter((c) => Math.abs(bones[c].position[0] - bones[armRoot].position[0]) <= 0.05 || bones[c].position[1] > bones[armRoot].position[1] + 0.3)
        .sort((a, b) => Math.abs(bones[a].position[0]) - Math.abs(bones[b].position[0]) || bones[b].position[1] - bones[a].position[1])[0];
      set("NECK", neckIndex);
      if (neckIndex !== undefined) set("HEAD", children[neckIndex][0]);
      const arms = children[armRoot]
        .filter((c) => Math.abs(bones[c].position[0] - bones[armRoot].position[0]) > 0.05 && descendants(c) >= 3)
        .sort((a, b) => bones[b].position[0] - bones[a].position[0]);
      for (const [side, start] of [["LEFT", arms[0]], ["RIGHT", arms[arms.length - 1]]] as Array<[Side, number]>) {
        const chain = chainFrom(start, 5);
        // Shoulder is short relative to the upper arm.
        const hasShoulder = chain.length >= 4 && v3.dist(bones[chain[0]].position, bones[chain[1]].position) < 0.6 * v3.dist(bones[chain[1]].position, bones[chain[2]].position);
        const arm = hasShoulder ? chain.slice(1) : chain;
        if (hasShoulder) set(`${side}_SHOULDER`, chain[0]);
        set(`${side}_UPPER_ARM`, arm[0]);
        set(`${side}_LOWER_ARM`, arm[1]);
        set(`${side}_HAND`, arm[2]);
      }
    }
  }
  return count;
}

