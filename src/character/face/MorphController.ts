/**
 * Unified morph channel.
 *
 * PMX models express expressions through three different morph kinds, and this
 * model uses all three. Vertex morphs map cleanly onto three.js morph targets;
 * bone morphs (which is how Evelyn's eyebrows move) and group morphs have no
 * three.js equivalent and are resolved here.
 *
 * Every system that wants to influence the face - blinking, expressions, lip
 * sync, behaviours - writes into the same accumulator each frame:
 *
 *     begin();  ...many add(name, weight) calls...  commit(...)
 *
 * Weights accumulate additively and are clamped once at commit time, so
 * several systems can drive the same morph (a smile from an expression plus a
 * smile from a behaviour) without fighting over it.
 */
import * as THREE from 'three';
import type { PmxModel } from '../loaders/pmxTypes';

export class MorphController {
  /** Accumulated weight per vertex morph target index. */
  private readonly vertexWeights: Float32Array;
  /** Accumulated weight per bone morph name. */
  private readonly boneWeights = new Map<string, number>();
  /** Bones touched by bone morphs, so we only reset what we use. */
  private readonly boneMorphBones = new Set<THREE.Bone>();

  private readonly _quat = new THREE.Quaternion();
  private readonly _identity = new THREE.Quaternion();

  constructor(private readonly model: PmxModel) {
    this.vertexWeights = new Float32Array(model.vertexMorphs.size);
    for (const morph of model.boneMorphs.values()) {
      for (const el of morph.elements) {
        const bone = model.bones[el.boneIndex];
        if (bone) this.boneMorphBones.add(bone);
      }
    }
  }

  /** True if the model actually has this morph, under any morph kind. */
  has(name: string | undefined): name is string {
    if (!name) return false;
    return (
      this.model.vertexMorphs.has(name) ||
      this.model.boneMorphs.has(name) ||
      this.model.groupMorphs.has(name)
    );
  }

  /** Clear the accumulator. Call once per frame before any add(). */
  begin(): void {
    this.vertexWeights.fill(0);
    this.boneWeights.clear();
  }

  /**
   * Add `weight` to a morph by name. Unknown names are ignored so a config
   * can safely reference morphs a given model does not have.
   */
  add(name: string | undefined, weight: number): void {
    if (!name || weight === 0) return;

    const vertex = this.model.vertexMorphs.get(name);
    if (vertex) {
      this.vertexWeights[vertex.morphTargetIndex] += weight;
      return;
    }

    if (this.model.boneMorphs.has(name)) {
      this.boneWeights.set(name, (this.boneWeights.get(name) ?? 0) + weight);
      return;
    }

    const group = this.model.groupMorphs.get(name);
    if (group) {
      // Group morphs are just weighted references to other morphs.
      for (const el of group.elements) this.add(el.morphName, weight * el.ratio);
    }
  }

  /**
   * Push accumulated vertex weights to the mesh.
   * Safe to call at any point in the frame.
   */
  commitVertexMorphs(): void {
    const influences = this.model.mesh.morphTargetInfluences;
    if (!influences) return;
    for (let i = 0; i < this.vertexWeights.length; i++) {
      influences[i] = THREE.MathUtils.clamp(this.vertexWeights[i], 0, 1);
    }
  }

  /**
   * Apply bone morphs on top of the current pose.
   *
   * Must run AFTER the pose layers have set bone transforms and BEFORE the
   * world matrices are recomputed, because bone morphs are additive offsets
   * relative to whatever pose is already there.
   */
  commitBoneMorphs(): void {
    if (this.boneWeights.size === 0) return;

    for (const [name, rawWeight] of this.boneWeights) {
      const morph = this.model.boneMorphs.get(name);
      if (!morph) continue;
      const weight = THREE.MathUtils.clamp(rawWeight, 0, 1);
      if (weight <= 0) continue;

      for (const el of morph.elements) {
        const bone = this.model.bones[el.boneIndex];
        if (!bone) continue;
        bone.position.addScaledVector(el.position, weight);
        // Scale the rotation by slerping out from identity.
        this._quat.copy(this._identity).slerp(el.rotation, weight);
        bone.quaternion.multiply(this._quat);
      }
    }
  }

  /** Sum of this frame's morph weights (vertex + bone), for diagnostics. */
  get totalWeight(): number {
    let sum = 0;
    for (const w of this.vertexWeights) sum += Math.min(1, Math.max(0, w));
    for (const w of this.boneWeights.values()) sum += Math.min(1, Math.max(0, w));
    return sum;
  }

  /** Bones that bone morphs write to, so the pose system can reset them. */
  get morphedBones(): ReadonlySet<THREE.Bone> {
    return this.boneMorphBones;
  }

  /** Diagnostics: names of every morph the model exposes, by kind. */
  describe(): { vertex: string[]; bone: string[]; group: string[] } {
    return {
      vertex: [...this.model.vertexMorphs.keys()],
      bone: [...this.model.boneMorphs.keys()],
      group: [...this.model.groupMorphs.keys()],
    };
  }
}
