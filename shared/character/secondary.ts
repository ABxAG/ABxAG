/**
 * Secondary-motion discovery: physics chains (hair, skirt, coat, sleeves,
 * ribbons, accessories, tails...) and body colliders, derived from what the
 * model actually contains.
 *
 * Sources, in order of trust:
 *   1. The author's rigid bodies: dynamic bodies mark simulated bones,
 *      kinematic bodies on body bones become colliders.
 *   2. Bone names (any language) and English names, to classify chains.
 *   3. Geometry (where a chain hangs from and which way it points), for
 *      chains with meaningless names such as "Q_3_7" or "W_1_2".
 *
 * When a model has no rigid bodies at all, chains are generated from bone
 * names and colliders from the humanoid mapping; the report says so.
 */
import type { HumanoidMapping } from "./humanoid";
import { isHelperBoneName } from "./humanoid";
import { type RigBody, type RigDescription, type Vec3, boneGraph, v3 } from "./rig";

export type ChainClass =
  | "hair" | "ponytail" | "skirt" | "jacket" | "sleeve" | "ribbon" | "accessory" | "tail" | "chest" | "body" | "other";

export type PhysicsMaterial =
  | "LIGHT_FABRIC" | "MEDIUM_FABRIC" | "HEAVY_FABRIC" | "HAIR" | "RIBBON" | "ACCESSORY" | "SOFT_BODY" | "TAIL";

export interface PhysicsMaterialParams {
  /** Spring pull toward the animated rest direction, per 60 Hz step. */
  stiffness: number;
  /** Velocity loss per step, 0..1. */
  drag: number;
  /** Gravity multiplier. */
  gravity: number;
  /** How much of the tail's own velocity is kept (inertia). */
  inertia: number;
  /** Extra direct blend back to rest per step (keeps long idles tidy). */
  restPull: number;
  /** Hard maximum deviation from the animated direction, degrees. */
  maxAngleDeg: number;
  /** Collision radius of each simulated point, metres-ish model units. */
  radius: number;
}

/**
 * Material presets. Values were tuned on the 7 reference models so that
 * walking, turning and window drags produce visible but believable motion.
 */
export const PHYSICS_MATERIALS: Record<PhysicsMaterial, PhysicsMaterialParams> = {
  LIGHT_FABRIC: { stiffness: 0.05, drag: 0.12, gravity: 1, inertia: 1, restPull: 0.02, maxAngleDeg: 55, radius: 0.18 },
  MEDIUM_FABRIC: { stiffness: 0.07, drag: 0.15, gravity: 1, inertia: 1, restPull: 0.03, maxAngleDeg: 45, radius: 0.2 },
  HEAVY_FABRIC: { stiffness: 0.09, drag: 0.2, gravity: 1.15, inertia: 0.95, restPull: 0.04, maxAngleDeg: 35, radius: 0.25 },
  HAIR: { stiffness: 0.07, drag: 0.14, gravity: 0.8, inertia: 1, restPull: 0.03, maxAngleDeg: 40, radius: 0.15 },
  RIBBON: { stiffness: 0.035, drag: 0.1, gravity: 1, inertia: 1, restPull: 0.015, maxAngleDeg: 70, radius: 0.1 },
  ACCESSORY: { stiffness: 0.1, drag: 0.16, gravity: 1, inertia: 1, restPull: 0.04, maxAngleDeg: 40, radius: 0.1 },
  SOFT_BODY: { stiffness: 0.3, drag: 0.4, gravity: 0.3, inertia: 0.45, restPull: 0.35, maxAngleDeg: 6, radius: 0 },
  TAIL: { stiffness: 0.06, drag: 0.12, gravity: 0.6, inertia: 1, restPull: 0.025, maxAngleDeg: 50, radius: 0.15 },
};

export const CHAIN_MATERIAL: Record<ChainClass, PhysicsMaterial> = {
  hair: "HAIR",
  ponytail: "HAIR",
  skirt: "LIGHT_FABRIC",
  jacket: "HEAVY_FABRIC",
  sleeve: "MEDIUM_FABRIC",
  ribbon: "RIBBON",
  accessory: "ACCESSORY",
  tail: "TAIL",
  chest: "SOFT_BODY",
  body: "SOFT_BODY",
  other: "MEDIUM_FABRIC",
};

export interface PhysicsChainProfile {
  id: string;
  label: string;
  class: ChainClass;
  material: PhysicsMaterial;
  /** Simulated bone names, root first (parents always before children). */
  bones: string[];
  /** Non-simulated bone the chain hangs from. */
  anchor: string | null;
  /** How the class was decided. */
  classifiedBy: "name" | "english-name" | "geometry" | "fallback";
  /** Source of the simulation data. */
  source: "rigid-bodies" | "generated";
  enabled: boolean;
  /** Optional per-chain overrides of the material parameters. */
  overrides?: Partial<PhysicsMaterialParams>;
}

export interface ColliderProfile {
  bone: string;
  shape: "sphere" | "capsule";
  radius: number;
  /** Capsule cylinder length (0 for spheres). */
  height: number;
  /** Offset from the bone head in the bone's rest frame (model space delta). */
  offset: Vec3;
  /** Capsule axis in model space at rest (unit). */
  axis: Vec3;
  group: number;
  mask: number;
  source: "rigid-body" | "generated";
}

export interface SecondaryAnalysis {
  chains: PhysicsChainProfile[];
  colliders: ColliderProfile[];
  /** Bone name → collision group/mask of its dynamic body. */
  nodeGroups: Record<string, { group: number; mask: number }>;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Ordered: the first matching rule wins, so specific words precede generic ones. */
const CLASS_RULES: Array<[RegExp, ChainClass]> = [
  [/尾|しっぽ|尻尾|tail/, "tail"],
  [/ponytail|ポニテ|ポニーテール|马尾|ツインテ|twintail|twin_?tail|辫|braid/, "ponytail"],
  [/ribbon|リボン|蝴蝶结|bowtie|bow|ネクタイ|领带|領帯|tie(?!r)|strap|tape|knot|belt|ベルト|带|帯|hairtie|headband|fashi|发饰|髪飾|scarf|マフラー|围巾|穗|tassel/, "ribbon"],
  [/髪|髮|发|hair|bang|前髪|刘海|ahoge|アホ毛|もみあげ/, "hair"],
  [/necklace|anklet|earring|耳坠|耳環|ピアス|pendant|pendent|pearl|珠|饰|飾|chain|链|鎖|ring(?!er)|jewel|宝石|glasses|眼镜|sunglass|weapon|武器|boots|鞋|shoe|靴|can|tube|ear(?!th)|耳|crystal|结晶/, "accessory"],
  [/袖|sleeve|xiuzi/, "sleeve"],
  [/スカート|skirt|裙|qun/, "skirt"],
  [/外套|coat|jacket|jac|cappa|cape|マント|斗篷|披风|yifu|衣|上着|ジャケット|コート|collar|领|襟|下摆|hem|cloth|服/, "jacket"],
  [/胸|おっぱい|breast|bust|boob/, "chest"],
  [/尻|臀|butt|hip|pelvis|腿|thigh|ひざ|足/, "body"],
];

export function classifyText(text: string): ChainClass | null {
  const n = text.normalize("NFKC").toLowerCase();
  if (!n) return null;
  for (const [pattern, cls] of CLASS_RULES) if (pattern.test(n)) return cls;
  return null;
}

/** Strip numbering and side so "Ctr_L_Hair03_05" → "ctr_hair" for labels. */
function chainLabel(name: string): string {
  return name
    .replace(/錘$/, "")
    .replace(/[_\s.-]?\d+([_\s.-]\d+)*$/g, "")
    .replace(/[_\s.-]+$/, "")
    .slice(0, 40) || name;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface SecondaryOptions {
  /** Also simulate cloth/hair-named bones the author left without rigid bodies. */
  includeUnsimulated?: boolean;
}

export function analyzeSecondary(rig: RigDescription, humanoid: HumanoidMapping, options: SecondaryOptions = {}): SecondaryAnalysis {
  const notes: string[] = [];
  const bones = rig.bones;
  const { children, depth } = boneGraph(bones);
  const humanoidIndex = new Map<number, string>();
  for (const [slot, mapping] of Object.entries(humanoid.slots)) humanoidIndex.set(mapping.index, slot);

  // Which bones are simulated, and with which body.
  const simulated = new Map<number, RigBody>();
  for (const body of rig.bodies) {
    if (body.type === "kinematic" || body.bone < 0 || body.bone >= bones.length) continue;
    // Never simulate the body's own skeleton even if a model marks it dynamic.
    const slot = humanoidIndex.get(body.bone);
    if (slot && !/EYE|JAW/.test(slot)) continue;
    if (!simulated.has(body.bone)) simulated.set(body.bone, body);
  }

  const authoredCount = simulated.size;
  const generatedBones = new Set<number>();
  if (authoredCount === 0 || options.includeUnsimulated) {
    for (const bone of bones) {
      if (simulated.has(bone.index) || humanoidIndex.has(bone.index) || isHelperBoneName(bone.name)) continue;
      // Bones the author pinned with a kinematic body are meant to stay rigid.
      if (rig.bodies.some((b) => b.bone === bone.index)) continue;
      const cls = classifyText(bone.name) ?? classifyText(bone.englishName);
      if (!cls || cls === "body" || cls === "chest") continue;
      // Only bones that are part of a chain (have a parent or child of the same kind).
      if (children[bone.index].length === 0 && !(bone.parent >= 0 && classifyText(bones[bone.parent].name))) continue;
      generatedBones.add(bone.index);
      simulated.set(bone.index, {
        index: -1, name: bone.name, bone: bone.index, type: "dynamic", shape: "sphere", size: [0.3, 0, 0],
        position: bone.position, rotation: [0, 0, 0, 1], mass: 1, linearDamping: 0.5, angularDamping: 0.5, group: 15, mask: 0xffff,
      });
    }
    if (authoredCount > 0 && generatedBones.size > 0) notes.push(`${generatedBones.size} bones without authored physics were added as generated chains (user option).`);
    if (authoredCount === 0 && simulated.size > 0) notes.push("This model has no physics rigid bodies; secondary chains were generated from bone names.");
  }

  // Group simulated bones into connected chains (tree components).
  const visited = new Set<number>();
  const components: number[][] = [];
  const sortedSim = [...simulated.keys()].sort((a, b) => depth[a] - depth[b]);
  for (const start of sortedSim) {
    if (visited.has(start)) continue;
    const component: number[] = [];
    const stack = [start];
    while (stack.length) {
      const i = stack.pop()!;
      if (visited.has(i) || !simulated.has(i)) continue;
      visited.add(i);
      component.push(i);
      for (const kid of children[i]) stack.push(kid);
    }
    components.push(component.sort((a, b) => depth[a] - depth[b]));
  }

  // Merge sibling strands that share an anchor and a name stem into one
  // chain group, so "skirt" is one entry with 15 strands, not 15 entries.
  const groups = new Map<string, { anchor: number; bones: number[]; stem: string; strands: number[][] }>();
  for (const component of components) {
    const root = component[0];
    const anchor = bones[root].parent;
    const stem = chainLabel(bones[root].name).replace(/_(l|r|f|b|m|bl|br|fl|fr)_/i, "_").replace(/^(左|右)/, "");
    const key = `${anchor}|${stem}`;
    const group = groups.get(key) ?? { anchor, bones: [], stem, strands: [] };
    group.bones.push(...component);
    group.strands.push(component);
    groups.set(key, group);
  }

  // MMD "D" bones (足D, ひざD…) copy a body bone through a grant; a strand
  // hanging from 左ひざD therefore belongs to the left knee, not the hips.
  const anchorSlot = (index: number): string | null => {
    let cursor = index;
    for (let guard = 0; cursor >= 0 && guard < 64; guard += 1) {
      const slot = humanoidIndex.get(cursor);
      if (slot) return slot;
      const grant = bones[cursor].grant;
      if (grant && grant.rotation && grant.ratio > 0.5 && humanoidIndex.has(grant.parent)) return humanoidIndex.get(grant.parent)!;
      cursor = bones[cursor].parent;
    }
    return null;
  };

  const frame = bodyFrame(rig, humanoid);
  const chains: PhysicsChainProfile[] = [];
  const nodeGroups: SecondaryAnalysis["nodeGroups"] = {};
  const usedIds = new Set<string>();
  for (const group of groups.values()) {
    const rootBone = bones[group.bones[0]];
    const slot = group.anchor >= 0 ? anchorSlot(group.anchor) : null;
    const geo = classifyByGeometry(rig, group.strands, slot, frame);
    let cls: ChainClass | null = classifyText(rootBone.name);
    let classifiedBy: PhysicsChainProfile["classifiedBy"] = "name";
    // PMX Editor's physics generators name every strand "Skirt_x_y" or
    // "Bone_x", whatever it really is: such English names carry no meaning.
    const englishUseful = rootBone.englishName && !/^(skirt|bone|joint|chain|physics)[_\s]?\d+([_\s]\d+)*$/i.test(rootBone.englishName.trim());
    if (!cls && englishUseful) {
      cls = classifyText(rootBone.englishName);
      classifiedBy = "english-name";
    }
    if (!cls) {
      cls = geo;
      classifiedBy = "geometry";
    } else if (cls === "body" && (geo === "skirt" || geo === "tail") && group.strands.length >= 6 && slot && !/LEG|FOOT/.test(slot)) {
      // "足"-named strands hanging in a ring from the hips are cloth, not flesh.
      cls = geo;
      classifiedBy = "geometry";
    }
    // Names can lie ("髮_0_1" hanging from the hips): hair hangs from the head.
    if (cls === "hair" && slot && !/HEAD|NECK|EYE|JAW/.test(slot)) {
      cls = geo ?? "other";
      classifiedBy = "geometry";
    }
    // Clothing words on a strand rooted on the head are hair (e.g. hood fringe).
    if (cls === "jacket" && slot && /HEAD/.test(slot) && !/collar|领|襟|hood|フード/.test(rootBone.name.toLowerCase())) cls = "hair";
    if (!cls) {
      cls = "other";
      classifiedBy = "fallback";
    }

    let id = `${cls}:${chainLabel(group.stem) || cls}`.toLowerCase().replace(/[^\p{L}\p{N}:_-]+/gu, "_");
    let n = 2;
    while (usedIds.has(id)) id = `${id.replace(/#\d+$/, "")}#${n++}`;
    usedIds.add(id);

    for (const index of group.bones) {
      const body = simulated.get(index)!;
      nodeGroups[bones[index].name] = { group: body.group, mask: body.mask };
    }
    chains.push({
      id,
      label: group.stem,
      class: cls,
      material: CHAIN_MATERIAL[cls],
      bones: group.bones.sort((a, b) => depth[a] - depth[b]).map((i) => bones[i].name),
      anchor: group.anchor >= 0 ? bones[group.anchor].name : null,
      classifiedBy,
      source: group.bones.some((i) => generatedBones.has(i)) ? "generated" : "rigid-bodies",
      enabled: true,
    });
  }
  chains.sort((a, b) => a.class.localeCompare(b.class) || a.id.localeCompare(b.id));

  const colliders = buildColliders(rig, humanoid, simulated, humanoidIndex);
  if (colliders.every((c) => c.source === "generated") && colliders.length > 0) {
    notes.push("No body collision shapes in the model; colliders were generated from the humanoid skeleton.");
  }
  return { chains, colliders, nodeGroups, notes };
}

interface BodyFrame {
  /** +1 when the character faces +Z in model space, -1 for -Z. */
  front: number;
  hipsY: number;
  neckY: number;
}

/** Facing and key heights, measured from the skeleton rather than assumed. */
export function bodyFrame(rig: RigDescription, humanoid: HumanoidMapping): BodyFrame {
  const pos = (slot: string) => (humanoid.slots[slot] ? rig.bones[humanoid.slots[slot].index].position : null);
  let front = 1;
  // Toes point forward; eyes sit in front of the head bone.
  const toe = pos("LEFT_TOES") ?? pos("RIGHT_TOES");
  const foot = pos("LEFT_FOOT") ?? pos("RIGHT_FOOT");
  const eye = pos("LEFT_EYE") ?? pos("RIGHT_EYE");
  const head = pos("HEAD");
  if (toe && foot && Math.abs(toe[2] - foot[2]) > 1e-3) front = Math.sign(toe[2] - foot[2]);
  else if (eye && head && Math.abs(eye[2] - head[2]) > 1e-3) front = Math.sign(eye[2] - head[2]);
  const hips = pos("LOWER_BODY") ?? pos("HIPS") ?? pos("LEFT_UPPER_LEG");
  const neck = pos("NECK") ?? pos("HEAD");
  return { front, hipsY: hips ? hips[1] : 0, neckY: neck ? neck[1] : 1 };
}

function classifyByGeometry(rig: RigDescription, strands: number[][], anchorSlot: string | null, frame: BodyFrame): ChainClass | null {
  const bones = rig.bones;
  // Per strand: root position and root→tip direction; then average, so a
  // ring of skirt strands reads as "down" rather than one strand's angle.
  let rootCentroid: Vec3 = [0, 0, 0];
  let meanDir: Vec3 = [0, 0, 0];
  for (const strand of strands) {
    const root = bones[strand[0]].position;
    const tip = bones[strand[strand.length - 1]].position;
    rootCentroid = v3.add(rootCentroid, root);
    meanDir = v3.add(meanDir, v3.norm(v3.sub(tip, root)));
  }
  rootCentroid = v3.scale(rootCentroid, 1 / strands.length);
  const dir = v3.norm(meanDir);
  const backward = -dir[2] * frame.front;
  if (!anchorSlot) return null;
  if (/HEAD|NECK|EYE|JAW/.test(anchorSlot)) return "hair";
  if (/ARM|HAND|SHOULDER/.test(anchorSlot)) return "sleeve";
  if (/FOOT|TOES|LOWER_LEG/.test(anchorSlot)) return "accessory";
  // A tail is a single centre-line strand leaving the body backwards.
  if (strands.length <= 2 && backward > 0.6 && Math.abs(rootCentroid[0]) < 0.6) return "tail";
  if (/SPINE|CHEST|HIPS|LOWER_BODY|CENTER|GROOVE|WAIST|UPPER_LEG/.test(anchorSlot)) {
    if (dir[1] > -0.3 && strands.length <= 2) return "accessory";
    // Hanging cloth: rooted near the waist it is a skirt, higher up a coat.
    const span = Math.max(1e-3, frame.neckY - frame.hipsY);
    return rootCentroid[1] < frame.hipsY + span * 0.35 ? "skirt" : "jacket";
  }
  return null;
}

function buildColliders(
  rig: RigDescription,
  humanoid: HumanoidMapping,
  simulated: Map<number, RigBody>,
  humanoidIndex: Map<number, string>
): ColliderProfile[] {
  const bones = rig.bones;
  const out: ColliderProfile[] = [];
  for (const body of rig.bodies) {
    if (body.type !== "kinematic" || body.bone < 0 || body.bone >= bones.length) continue;
    if (simulated.has(body.bone)) continue;
    // Colliders only make sense on the body itself (or helpers deforming it).
    const bone = bones[body.bone];
    const onBody = humanoidIndex.has(body.bone) || /足|ひざ|腕|ひじ|手首|上半身|下半身|頭|首|胸|尻/.test(bone.name);
    if (!onBody) continue;
    const axis = rotateVec([0, 1, 0], body.rotation);
    if (body.shape === "sphere") {
      out.push({ bone: bone.name, shape: "sphere", radius: body.size[0], height: 0, offset: v3.sub(body.position, bone.position), axis, group: body.group, mask: body.mask, source: "rigid-body" });
    } else if (body.shape === "capsule") {
      out.push({ bone: bone.name, shape: "capsule", radius: body.size[0], height: body.size[1], offset: v3.sub(body.position, bone.position), axis, group: body.group, mask: body.mask, source: "rigid-body" });
    } else {
      // Box → capsule along its longest axis; radius from the smaller extents.
      const [hx, hy, hz] = body.size;
      const longest = Math.max(hx, hy, hz);
      const localAxis: Vec3 = longest === hx ? [1, 0, 0] : longest === hy ? [0, 1, 0] : [0, 0, 1];
      const others = [hx, hy, hz].filter((_, i) => i !== localAxis.indexOf(1));
      const radius = Math.min(...others);
      out.push({ bone: bone.name, shape: "capsule", radius, height: Math.max(0, 2 * (longest - radius)), offset: v3.sub(body.position, bone.position), axis: rotateVec(localAxis, body.rotation), group: body.group, mask: body.mask, source: "rigid-body" });
    }
  }
  if (out.length > 0) return out;

  // Generated colliders from the humanoid mapping, scaled by body height.
  const slot = (name: string) => humanoid.slots[name];
  const pos = (name: string) => (slot(name) ? bones[slot(name).index].position : null);
  const head = pos("HEAD");
  const footL = pos("LEFT_FOOT");
  const height = head && footL ? Math.max(1, head[1] - footL[1]) : 15;
  const segment = (a: string, b: string, radiusRatio: number) => {
    const pa = pos(a);
    const pb = pos(b);
    if (!pa || !pb) return;
    const delta = v3.sub(pb, pa);
    const length = v3.len(delta);
    out.push({ bone: slot(a).bone, shape: "capsule", radius: height * radiusRatio, height: length, offset: v3.scale(delta, 0.5), axis: v3.norm(delta), group: 0, mask: 0xffff, source: "generated" });
  };
  if (head) out.push({ bone: slot("HEAD").bone, shape: "sphere", radius: height * 0.065, height: 0, offset: [0, height * 0.05, 0], axis: [0, 1, 0], group: 0, mask: 0xffff, source: "generated" });
  segment("SPINE", "NECK", 0.09);
  for (const side of ["LEFT", "RIGHT"]) {
    segment(`${side}_UPPER_LEG`, `${side}_LOWER_LEG`, 0.06);
    segment(`${side}_LOWER_LEG`, `${side}_FOOT`, 0.045);
    segment(`${side}_UPPER_ARM`, `${side}_LOWER_ARM`, 0.035);
    segment(`${side}_LOWER_ARM`, `${side}_HAND`, 0.03);
  }
  return out;
}

function rotateVec(v: Vec3, q: [number, number, number, number]): Vec3 {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}
