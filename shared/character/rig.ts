/**
 * Format-neutral description of a character rig.
 *
 * Both the importer (Node, reading the file with mmd-parser) and the renderer
 * (reading a loaded PmxModel) produce this shape, so the same analysis code
 * maps skeletons, physics chains, colliders and morphs in both places.
 *
 * Coordinates are in three.js space after the PMX handedness flip: the
 * character faces -Z, character-left is +X, up is +Y.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface RigBone {
  index: number;
  name: string;
  englishName: string;
  parent: number;
  /** Rest head position in model space. */
  position: Vec3;
  /** PMX bone flags (rotatable 0x2, translatable 0x4, visible 0x8, IK 0x20...). */
  flags: number;
  /** Bone this one is connected to as its tail, if any. */
  tailBone?: number;
  /** Offset tail when not connected to a bone. */
  tailOffset?: Vec3;
  ik?: { effector: number; links: number[] };
  grant?: { parent: number; ratio: number; rotation: boolean; translation: boolean };
}

export type RigBodyType = "kinematic" | "dynamic" | "dynamicBonePosition";

export interface RigBody {
  index: number;
  name: string;
  bone: number;
  type: RigBodyType;
  shape: "sphere" | "box" | "capsule";
  /** PMX size: sphere [r], capsule [r, height], box [hx, hy, hz]. */
  size: Vec3;
  position: Vec3;
  rotation: Quat;
  mass: number;
  linearDamping: number;
  angularDamping: number;
  group: number;
  /** Bitmask of groups this body collides WITH (three.js MMDPhysics convention). */
  mask: number;
}

export interface RigJoint {
  bodyA: number;
  bodyB: number;
}

export type RigMorphType = "group" | "vertex" | "bone" | "uv" | "material" | "flip" | "impulse" | "other";

export interface RigMorph {
  name: string;
  englishName: string;
  type: RigMorphType;
  /** PMX panel: 1 brow, 2 eye, 3 mouth, 4 other. */
  panel: number;
}

export interface RigMaterial {
  name: string;
  englishName: string;
  texture: string | null;
  faceCount: number;
}

export interface RigDescription {
  format: "pmx";
  modelName: string;
  englishModelName: string;
  vertexCount: number;
  bones: RigBone[];
  bodies: RigBody[];
  joints: RigJoint[];
  morphs: RigMorph[];
  materials: RigMaterial[];
  /** Indices of bones that carry vertex weights (deform the mesh). */
  weightedBones: number[];
}

export const PMX_BONE_FLAG = {
  connected: 0x0001,
  rotatable: 0x0002,
  translatable: 0x0004,
  visible: 0x0008,
  enabled: 0x0010,
  ik: 0x0020,
  grantRotation: 0x0100,
  grantTranslation: 0x0200,
  fixedAxis: 0x0400,
} as const;

const MORPH_TYPES: RigMorphType[] = ["group", "vertex", "bone", "uv", "uv", "uv", "uv", "uv", "material", "flip", "impulse"];

/**
 * Build a RigDescription from raw mmd-parser output. Works in Node and the
 * browser; only plain data is touched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rigFromMmdParser(pmx: any): RigDescription {
  const flip = (p: number[]): Vec3 => [p[0], p[1], -p[2]];
  const weighted = new Set<number>();
  for (const vertex of pmx.vertices as Array<{ skinIndices: number[]; skinWeights: number[] }>) {
    const indices = vertex.skinIndices;
    const weights = vertex.skinWeights;
    for (let k = 0; k < indices.length; k += 1) {
      // BDEF1 stores a single index with an implied weight of 1.
      const weight = weights.length > k ? weights[k] : indices.length === 1 ? 1 : 0;
      if (weight > 1e-4) weighted.add(indices[k]);
    }
  }
  const bones: RigBone[] = pmx.bones.map((b: any, index: number) => {
    const connected = (b.flag & PMX_BONE_FLAG.connected) !== 0;
    return {
      index,
      name: String(b.name ?? ""),
      englishName: String(b.englishName ?? ""),
      parent: typeof b.parentIndex === "number" ? b.parentIndex : -1,
      position: flip(b.position),
      flags: b.flag | 0,
      tailBone: connected && typeof b.connectIndex === "number" && b.connectIndex >= 0 ? b.connectIndex : undefined,
      tailOffset: !connected && Array.isArray(b.offsetPosition) ? flip(b.offsetPosition) : undefined,
      ik: b.ik ? { effector: b.ik.effector, links: (b.ik.links ?? []).map((l: any) => l.index) } : undefined,
      grant: b.grant
        ? {
            parent: b.grant.parentIndex,
            ratio: b.grant.ratio,
            rotation: !!b.grant.affectRotation,
            translation: !!b.grant.affectPosition,
          }
        : undefined,
    };
  });
  const bodyTypes: RigBodyType[] = ["kinematic", "dynamic", "dynamicBonePosition"];
  const shapes = ["sphere", "box", "capsule"] as const;
  const bodies: RigBody[] = pmx.rigidBodies.map((r: any, index: number) => ({
    index,
    name: String(r.name ?? ""),
    bone: r.boneIndex,
    type: bodyTypes[r.type] ?? "kinematic",
    shape: shapes[r.shapeType] ?? "capsule",
    size: [r.width, r.height, r.depth],
    position: flip(r.position),
    rotation: eulerToQuatFlipped(r.rotation),
    mass: r.weight,
    linearDamping: r.positionDamping,
    angularDamping: r.rotationDamping,
    group: r.groupIndex,
    mask: r.groupTarget,
  }));
  return {
    format: "pmx",
    modelName: String(pmx.metadata?.modelName ?? ""),
    englishModelName: String(pmx.metadata?.englishModelName ?? ""),
    vertexCount: pmx.metadata?.vertexCount ?? pmx.vertices.length,
    bones,
    bodies,
    joints: pmx.constraints.map((c: any) => ({ bodyA: c.rigidBodyIndex1, bodyB: c.rigidBodyIndex2 })),
    morphs: pmx.morphs.map((m: any) => ({
      name: String(m.name ?? ""),
      englishName: String(m.englishName ?? ""),
      type: MORPH_TYPES[m.type] ?? "other",
      panel: m.panel,
    })),
    materials: pmx.materials.map((m: any) => ({
      name: String(m.name ?? ""),
      englishName: String(m.englishName ?? ""),
      texture: m.textureIndex >= 0 ? (pmx.textures[m.textureIndex] ?? null) : null,
      faceCount: m.faceCount,
    })),
    weightedBones: [...weighted].sort((a, b) => a - b),
  };
}

/** PMX XYZ euler (left-handed) → quaternion in three.js space. */
function eulerToQuatFlipped(rot: number[]): Quat {
  const [x, y, z] = rot;
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  // three.js Euler order 'XYZ'.
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;
  return [-qx, -qy, qz, qw];
}

// ---- small vector helpers shared by the analysers -------------------------

export const v3 = {
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  dist: (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

/** Children lists and depth for a bone array. */
export function boneGraph(bones: RigBone[]): { children: number[][]; depth: number[] } {
  const children: number[][] = bones.map(() => []);
  for (const bone of bones) if (bone.parent >= 0 && bone.parent < bones.length) children[bone.parent].push(bone.index);
  const depth = bones.map(() => -1);
  const depthOf = (i: number, guard = 0): number => {
    if (depth[i] >= 0) return depth[i];
    const parent = bones[i].parent;
    depth[i] = parent >= 0 && parent < bones.length && guard < 512 ? depthOf(parent, guard + 1) + 1 : 0;
    return depth[i];
  };
  bones.forEach((_, i) => depthOf(i));
  return { children, depth };
}

export function isAncestor(bones: RigBone[], ancestor: number, child: number): boolean {
  let cursor = bones[child]?.parent ?? -1;
  for (let guard = 0; cursor >= 0 && guard < 512; guard += 1) {
    if (cursor === ancestor) return true;
    cursor = bones[cursor].parent;
  }
  return false;
}
