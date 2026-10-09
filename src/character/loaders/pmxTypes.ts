/**
 * Types describing a parsed PMX model after conversion into three.js space.
 *
 * Coordinate handedness
 * ---------------------
 * PMX is a LEFT-handed coordinate system in which the character faces +Z.
 * three.js is right-handed. We convert by negating Z on every position,
 * normal and translation, reversing triangle winding, and mapping rotation
 * quaternions (x, y, z, w) -> (-x, -y, z, w). This is a true handedness
 * conversion, not a mirror: asymmetric designs stay correct. The side effect
 * is that the character ends up facing -Z, so the stage camera sits on the
 * -Z side looking back toward +Z.
 */
import type * as THREE from 'three';
import type { RigDescription } from '@/shared/character/rig';

/** PMX bone flag bits we care about. */
export const BoneFlag = {
  ConnectToBone: 0x0001,
  Rotatable: 0x0002,
  Translatable: 0x0004,
  Visible: 0x0008,
  Enabled: 0x0010,
  IK: 0x0020,
  GrantRotation: 0x0100,
  GrantTranslation: 0x0200,
  FixedAxis: 0x0400,
  LocalAxis: 0x0800,
  PhysicsAfterDeform: 0x1000,
  ExternalParentDeform: 0x2000,
} as const;

/** A bone's static description, in three.js space. */
export interface PmxBoneInfo {
  index: number;
  name: string;
  parentIndex: number;
  /** Rest position in model space (converted). */
  position: THREE.Vector3;
  flag: number;
  /** Deform order; bones with a higher value are solved later. */
  transformationClass: number;
  ik?: PmxIkInfo;
  grant?: PmxGrantInfo;
}

/** MMD "append parent" (付与親): a bone inherits part of another's transform. */
export interface PmxGrantInfo {
  parentIndex: number;
  ratio: number;
  affectRotation: boolean;
  affectPosition: boolean;
  isLocal: boolean;
}

export interface PmxIkLink {
  boneIndex: number;
  limited: boolean;
  lower?: THREE.Vector3;
  upper?: THREE.Vector3;
}

export interface PmxIkInfo {
  /** Bone driven toward the IK bone's position. */
  effectorIndex: number;
  iteration: number;
  maxAngle: number;
  links: PmxIkLink[];
}

/** A morph that displaces vertices - exposed as a three.js morph target. */
export interface PmxVertexMorph {
  name: string;
  panel: number;
  /** Index into `mesh.morphTargetInfluences`. */
  morphTargetIndex: number;
}

/** A morph that transforms bones (this model drives its eyebrows this way). */
export interface PmxBoneMorph {
  name: string;
  panel: number;
  elements: Array<{
    boneIndex: number;
    position: THREE.Vector3;
    rotation: THREE.Quaternion;
  }>;
}

/** A morph that combines other morphs at fixed ratios. */
export interface PmxGroupMorph {
  name: string;
  panel: number;
  elements: Array<{ morphName: string; ratio: number }>;
}

export type PmxRigidBodyType = 'kinematic' | 'dynamic' | 'dynamicBonePosition';

export interface PmxRigidBody {
  index: number;
  name: string;
  boneIndex: number;
  groupIndex: number;
  /** Bitmask of collision groups this body does NOT collide with. */
  groupTarget: number;
  shape: 'sphere' | 'box' | 'capsule';
  size: THREE.Vector3;
  /** Rest position in model space (converted). */
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  mass: number;
  positionDamping: number;
  rotationDamping: number;
  restitution: number;
  friction: number;
  type: PmxRigidBodyType;
}

export interface PmxConstraint {
  index: number;
  name: string;
  bodyA: number;
  bodyB: number;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  rotationLower: THREE.Vector3;
  rotationUpper: THREE.Vector3;
  springRotation: THREE.Vector3;
}

export interface PmxMaterialInfo {
  index: number;
  name: string;
  /** Index of the first vertex index in the geometry group. */
  start: number;
  count: number;
  edgeSize: number;
  edgeColor: THREE.Color;
  /** PMX material flag bits (0x01 = double sided, 0x10 = draw edge). */
  flag: number;
}

/** Everything the runtime needs from a loaded character model. */
export interface PmxModel {
  name: string;
  mesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  bones: THREE.Bone[];
  boneInfos: PmxBoneInfo[];
  boneIndexByName: Map<string, number>;
  materials: PmxMaterialInfo[];
  vertexMorphs: Map<string, PmxVertexMorph>;
  boneMorphs: Map<string, PmxBoneMorph>;
  groupMorphs: Map<string, PmxGroupMorph>;
  rigidBodies: PmxRigidBody[];
  constraints: PmxConstraint[];
  iks: Array<{ boneIndex: number; info: PmxIkInfo }>;
  grants: Array<{ boneIndex: number; info: PmxGrantInfo }>;
  /** Bounding box of the rest pose, in model space. */
  boundingBox: THREE.Box3;
  /** Format-neutral rig description used by skeleton/physics analysis. */
  rig: RigDescription;
}
