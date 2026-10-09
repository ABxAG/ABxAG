/**
 * Additive pose accumulator.
 *
 * Every animation source (breathing, sway, gaze, behaviours) writes *offsets*
 * from the rest pose into this buffer rather than setting bone transforms
 * directly. At the end of the frame the buffer composes all contributions and
 * applies them once.
 *
 * That is what makes blending seamless: two layers touching the same bone
 * simply sum, so a nod during a weight shift produces both, and a behaviour
 * fading out never snaps because its contribution scales continuously to zero.
 *
 * Bones are reset to their captured rest transform each frame, so nothing
 * drifts over time no matter how long the app runs.
 */
import * as THREE from 'three';
import type { PmxModel } from '../loaders/pmxTypes';

interface RestTransform {
  bone: THREE.Bone;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export class PoseBuffer {
  /** Rest transforms for every bone this buffer is allowed to touch. */
  private readonly rest = new Map<string, RestTransform>();
  /** Accumulated rotation per bone for the current frame. */
  private readonly rotations = new Map<string, THREE.Quaternion>();
  /** Accumulated translation per bone for the current frame. */
  private readonly translations = new Map<string, THREE.Vector3>();

  private readonly _quat = new THREE.Quaternion();
  private readonly _euler = new THREE.Euler();
  private readonly _identity = new THREE.Quaternion();
  private readonly _user = new THREE.Quaternion();

  /**
   * The user's pose layer (pose editor / IK / saved poses): local rotation
   * and translation offsets from rest, owned by the user rather than the AI.
   */
  private readonly userRotations = new Map<string, THREE.Quaternion>();
  private readonly userTranslations = new Map<string, THREE.Vector3>();
  /** 0..1 weight of the user layer. */
  userWeight = 0;
  /** 0..1 weight of all procedural (AI) layers. */
  aiWeight = 1;
  /** Bones whose AI motion is never scaled away (eyes keep living). */
  readonly aiExempt = new Set<string>();
  /**
   * Bones the AI layer may not move at all (while seated: hips and legs, so
   * idle sway cannot slide her off the seat or drag her feet across the floor).
   */
  readonly aiSuppressed = new Set<string>();

  constructor(private readonly model: PmxModel) {}

  /**
   * Register a bone as driveable and capture its rest transform.
   * Safe to call repeatedly; the first call wins.
   */
  register(boneName: string | undefined): boolean {
    if (!boneName || this.rest.has(boneName)) return !!boneName && this.rest.has(boneName);
    const index = this.model.boneIndexByName.get(boneName);
    if (index === undefined) return false;
    const bone = this.model.bones[index];
    if (!bone) return false;
    this.rest.set(boneName, {
      bone,
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
    });
    return true;
  }

  /** Register many bones at once, ignoring any the model does not have. */
  registerAll(boneNames: (string | undefined)[]): void {
    for (const name of boneNames) this.register(name);
  }

  has(boneName: string | undefined): boolean {
    return !!boneName && this.rest.has(boneName);
  }

  /**
   * Fold a rotation offset into a bone's stored REST transform, so every
   * later layer treats it as the neutral pose rather than an animation on top
   * of one. Used to replace the model's authored A-pose with a natural stance.
   */
  bakeIntoRest(boneName: string | undefined, x = 0, y = 0, z = 0): void {
    if (!boneName) return;
    const rest = this.rest.get(boneName);
    if (!rest) return;
    this._euler.set(x, y, z, 'XYZ');
    this._quat.setFromEuler(this._euler);
    rest.quaternion.multiply(this._quat);
    // Publish immediately so callers can capture derived state from it.
    rest.bone.quaternion.copy(rest.quaternion);
  }

  /** Clear the frame's accumulated offsets. */
  begin(): void {
    this.rotations.clear();
    this.translations.clear();
  }

  /** Add a rotation offset, in radians, about the bone's local axes. */
  addEuler(
    boneName: string | undefined,
    x: number,
    y: number,
    z: number,
    weight = 1
  ): void {
    if (!boneName || weight === 0 || !this.rest.has(boneName)) return;
    if (x === 0 && y === 0 && z === 0) return;
    this._euler.set(x * weight, y * weight, z * weight, 'XYZ');
    this._quat.setFromEuler(this._euler);
    this.addQuaternion(boneName, this._quat);
  }

  /** Add a rotation offset as a quaternion. */
  addQuaternion(boneName: string | undefined, quat: THREE.Quaternion, weight = 1): void {
    if (!boneName || !this.rest.has(boneName)) return;
    let acc = this.rotations.get(boneName);
    if (!acc) {
      acc = new THREE.Quaternion();
      this.rotations.set(boneName, acc);
    }
    if (weight >= 0.999) {
      acc.multiply(quat);
    } else {
      this._quat.copy(this._identity).slerp(quat, weight);
      acc.multiply(this._quat);
    }
  }

  /** Add a translation offset in the bone's local space. */
  addTranslation(
    boneName: string | undefined,
    x: number,
    y: number,
    z: number,
    weight = 1
  ): void {
    if (!boneName || weight === 0 || !this.rest.has(boneName)) return;
    let acc = this.translations.get(boneName);
    if (!acc) {
      acc = new THREE.Vector3();
      this.translations.set(boneName, acc);
    }
    acc.x += x * weight;
    acc.y += y * weight;
    acc.z += z * weight;
  }

  // ---- user layer ---------------------------------------------------------

  setUserRotation(boneName: string, quat: THREE.Quaternion | null): void {
    if (!this.register(boneName)) return;
    if (!quat) this.userRotations.delete(boneName);
    else (this.userRotations.get(boneName) ?? this.userRotations.set(boneName, new THREE.Quaternion()).get(boneName)!).copy(quat).normalize();
  }

  setUserTranslation(boneName: string, offset: THREE.Vector3 | null): void {
    if (!this.register(boneName)) return;
    if (!offset) this.userTranslations.delete(boneName);
    else (this.userTranslations.get(boneName) ?? this.userTranslations.set(boneName, new THREE.Vector3()).get(boneName)!).copy(offset);
  }

  getUserRotation(boneName: string): THREE.Quaternion | undefined {
    return this.userRotations.get(boneName);
  }

  getUserTranslation(boneName: string): THREE.Vector3 | undefined {
    return this.userTranslations.get(boneName);
  }

  clearUser(boneNames?: Iterable<string>): void {
    if (!boneNames) {
      this.userRotations.clear();
      this.userTranslations.clear();
      return;
    }
    for (const name of boneNames) {
      this.userRotations.delete(name);
      this.userTranslations.delete(name);
    }
  }

  get userBones(): string[] {
    return [...new Set([...this.userRotations.keys(), ...this.userTranslations.keys()])];
  }

  /** Rest transform captured at load (after the base pose was baked). */
  restOf(boneName: string): { position: THREE.Vector3; quaternion: THREE.Quaternion } | undefined {
    const rest = this.rest.get(boneName);
    return rest ? { position: rest.position, quaternion: rest.quaternion } : undefined;
  }

  /**
   * Write rest pose + user layer + AI offsets onto the skeleton.
   * Call once per frame, after all layers have contributed.
   */
  apply(): void {
    const userW = this.userWeight;
    const aiW = this.aiWeight;
    for (const [name, rest] of this.rest) {
      const rotation = this.rotations.get(name);
      const translation = this.translations.get(name);
      const userRotation = userW > 0 ? this.userRotations.get(name) : undefined;
      const userTranslation = userW > 0 ? this.userTranslations.get(name) : undefined;
      const w = this.aiSuppressed.has(name) ? 0 : this.aiExempt.has(name) && !userRotation ? 1 : aiW;

      rest.bone.quaternion.copy(rest.quaternion);
      if (userRotation) {
        if (userW >= 0.999) rest.bone.quaternion.multiply(userRotation);
        else rest.bone.quaternion.multiply(this._user.copy(this._identity).slerp(userRotation, userW));
      }
      if (rotation && w > 0) {
        if (w >= 0.999) rest.bone.quaternion.multiply(rotation);
        else rest.bone.quaternion.multiply(this._quat.copy(this._identity).slerp(rotation, w));
      }

      rest.bone.position.copy(rest.position);
      if (userTranslation) rest.bone.position.addScaledVector(userTranslation, userW);
      if (translation && w > 0) rest.bone.position.addScaledVector(translation, w);
    }
  }

  /** Bone names this buffer drives, for diagnostics. */
  get drivenBones(): string[] {
    return [...this.rest.keys()];
  }
}
