/**
 * Secondary-motion physics driven by the model's own authored rigid bodies.
 *
 * Why not a rigid-body engine
 * ---------------------------
 * MMD models are normally simulated with Bullet (via ammo.js). We deliberately
 * don't: it costs a ~1.5 MB WASM payload, is comparatively expensive on CPU for
 * a companion app that runs alongside everything else on the user's desktop,
 * and MMD rigs are notorious for exploding under it. Instead this is a
 * position-based spring-bone solver - the same family of technique VRM uses -
 * seeded from the data the model author already tuned: which bodies are
 * dynamic, their masses, and their damping.
 *
 * That gives believable, cheap and above all *stable* motion, and it makes the
 * "subtle, not exaggerated" requirement directly art-directable: every chain
 * has an amplitude and a hard maximum deviation angle, so nothing can ever
 * swing further than its group allows.
 *
 * Each dynamic bone is simulated as a single point mass at its tail. Per
 * substep the tail carries its own inertia, is pulled back toward its rest
 * direction by a spring, is dragged down by gravity, is re-projected onto the
 * bone's fixed length, and is finally angle-clamped. The bone rotation that
 * points at the resulting tail is then written back.
 */
import * as THREE from 'three';
import type { PhysicsConfig, PhysicsGroupTuning } from '../config/types';
import type { PmxModel } from '../loaders/pmxTypes';

interface SpringNode {
  bone: THREE.Bone;
  /** Rest direction to the tail, in bone-local space (unit length). */
  axis: THREE.Vector3;
  /** Distance from bone head to tail. */
  length: number;
  /** Simulated tail positions in world space. */
  currentTail: THREE.Vector3;
  prevTail: THREE.Vector3;
  /** Resolved per-node parameters. */
  stiffness: number;
  drag: number;
  gravityPower: number;
  restPull: number;
  maxAngle: number;
  amplitude: number;
  inertiaScale: number;
  /** Depth in the bone hierarchy, used to solve parents before children. */
  depth: number;
  groupName: string;
}

const GRAVITY_DIR = new THREE.Vector3(0, -1, 0);

export class SpringBonePhysics {
  private nodes: SpringNode[] = [];
  private accumulator = 0;
  private enabled = true;
  private initialised = false;

  /** Scratch objects, reused to keep the solver allocation-free per frame. */
  private readonly _center = new THREE.Vector3();
  private readonly _parentQuat = new THREE.Quaternion();
  private readonly _invParentQuat = new THREE.Quaternion();
  private readonly _restDir = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _next = new THREE.Vector3();
  private readonly _delta = new THREE.Vector3();
  private readonly _localDir = new THREE.Vector3();
  private readonly _quat = new THREE.Quaternion();
  private readonly _axisScratch = new THREE.Vector3();

  constructor(
    private readonly model: PmxModel,
    private readonly config: PhysicsConfig
  ) {
    this.build();
  }

  /** Number of simulated bones, for diagnostics. */
  get nodeCount(): number {
    return this.nodes.length;
  }

  /** Group name -> node count, for diagnostics. */
  get groupBreakdown(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of this.nodes) out[n.groupName] = (out[n.groupName] ?? 0) + 1;
    return out;
  }

  private resolveGroup(boneName: string): { name: string; tuning: PhysicsGroupTuning } {
    for (const [name, tuning] of Object.entries(this.config.groups)) {
      if (tuning.enabled === false) continue;
      if (tuning.match.some((prefix) => boneName.includes(prefix))) {
        return { name, tuning };
      }
    }
    return { name: 'fallback', tuning: this.config.fallback };
  }

  /** Discover simulated bones from the model's dynamic rigid bodies. */
  private build(): void {
    const boneDepth = new Map<number, number>();
    const depthOf = (index: number): number => {
      const cached = boneDepth.get(index);
      if (cached !== undefined) return cached;
      const info = this.model.boneInfos[index];
      const d = info && info.parentIndex >= 0 ? depthOf(info.parentIndex) + 1 : 0;
      boneDepth.set(index, d);
      return d;
    };

    // Bones that already carry a dynamic body, so we can find each bone's tail.
    const childrenOf = new Map<number, number[]>();
    this.model.boneInfos.forEach((info) => {
      if (info.parentIndex >= 0) {
        const list = childrenOf.get(info.parentIndex) ?? [];
        list.push(info.index);
        childrenOf.set(info.parentIndex, list);
      }
    });

    const seen = new Set<number>();

    for (const body of this.model.rigidBodies) {
      // 'kinematic' bodies follow their bone exactly - they are the anchors
      // the dynamic chains hang from, not things we simulate.
      if (body.type === 'kinematic') continue;
      if (body.boneIndex < 0 || body.boneIndex >= this.model.bones.length) continue;
      if (seen.has(body.boneIndex)) continue;
      seen.add(body.boneIndex);

      const bone = this.model.bones[body.boneIndex];
      const info = this.model.boneInfos[body.boneIndex];
      if (!bone || !info) continue;

      // Tail = first child bone. Falls back to the rigid body's own offset
      // from the bone for chain-end bones that have no child.
      const kids = childrenOf.get(body.boneIndex) ?? [];
      const tailInfo = kids.length > 0 ? this.model.boneInfos[kids[0]] : undefined;

      this._axisScratch.copy(
        tailInfo
          ? this._dir.subVectors(tailInfo.position, info.position)
          : this._dir.subVectors(body.position, info.position)
      );

      let length = this._axisScratch.length();
      // Degenerate tails would make the rotation undefined; skip them.
      if (length < 1e-4) continue;

      const axis = this._axisScratch.clone().divideScalar(length);
      const { name, tuning } = this.resolveGroup(info.name);

      // The model author's mass taper is what makes a long chain feel like a
      // chain: heavy near the root, light and whippy at the tip. Normalising
      // it into a 0..1 factor lets us reuse that authoring for free.
      const massFactor = THREE.MathUtils.clamp(Math.log10(body.mass + 1) / 1.7, 0.05, 1);
      // PMX damping is 0..1 where higher means more resistance.
      const authoredDrag = THREE.MathUtils.clamp(body.rotationDamping, 0, 0.999);

      this.nodes.push({
        bone,
        axis,
        length,
        currentTail: new THREE.Vector3(),
        prevTail: new THREE.Vector3(),
        // Lighter tips are springier, heavier roots hold their shape.
        stiffness: (tuning.stiffness ?? 0.15) * (1.35 - massFactor * 0.5),
        drag: THREE.MathUtils.clamp((tuning.damping ?? 0.2) + authoredDrag * 0.35, 0, 0.96),
        gravityPower: (tuning.gravityScale ?? 1) * this.config.gravity * 0.0016 * (0.5 + massFactor),
        restPull: tuning.restPull ?? 0.25,
        maxAngle: THREE.MathUtils.degToRad(tuning.maxAngleDeg ?? 15),
        amplitude:
          (tuning.amplitude ?? 0.7) * this.config.globalAmplitude,
        inertiaScale: tuning.inertiaScale ?? 1,
        depth: depthOf(body.boneIndex),
        groupName: name,
      });
    }

    // Parents must be solved before their children so each child sees an
    // up-to-date parent transform.
    this.nodes.sort((a, b) => a.depth - b.depth);
  }

  /** Snap every chain to its rest pose. Call after a load or a pose jump. */
  reset(): void {
    this.model.mesh.updateMatrixWorld(true);
    for (const node of this.nodes) {
      node.bone.updateWorldMatrix(true, false);
      node.bone.matrixWorld.decompose(this._center, this._parentQuat, this._dir);
      this._restDir.copy(node.axis).applyQuaternion(this._parentQuat).normalize();
      node.currentTail.copy(this._center).addScaledVector(this._restDir, node.length);
      node.prevTail.copy(node.currentTail);
    }
    this.accumulator = 0;
    this.initialised = true;
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled) this.reset();
    this.enabled = enabled;
  }

  /**
   * Advance the simulation. `delta` is real elapsed seconds; the solver runs
   * on a fixed timestep so behaviour is identical at any frame rate.
   */
  update(delta: number): void {
    if (!this.enabled || this.nodes.length === 0) return;
    if (!this.initialised) {
      this.reset();
      return;
    }

    const step = 1 / this.config.frequency;
    // A long stall (tab hidden, heavy GC) must not be replayed as a burst of
    // substeps - that is exactly how spring rigs blow up.
    this.accumulator = Math.min(this.accumulator + delta, step * this.config.maxSubSteps);

    let steps = 0;
    while (this.accumulator >= step && steps < this.config.maxSubSteps) {
      this.simulate(step);
      this.accumulator -= step;
      steps++;
    }
  }

  private simulate(dt: number): void {
    // Normalised against the reference 60 Hz the tuning values assume.
    const scale = dt * 60;

    for (const node of this.nodes) {
      const bone = node.bone;
      const parent = bone.parent;

      // Refresh this bone's world transform from its (already solved) parent.
      bone.updateWorldMatrix(false, false);
      this._center.setFromMatrixPosition(bone.matrixWorld);

      if (parent) {
        parent.getWorldQuaternion(this._parentQuat);
      } else {
        this._parentQuat.identity();
      }

      // Where the tail would sit with the bone at its rest rotation.
      this._restDir.copy(node.axis).applyQuaternion(this._parentQuat).normalize();

      // --- integrate -------------------------------------------------------
      // Inertia: the tail keeps its previous world velocity, so when the head
      // or body moves the chain lags behind and catches up. This is where the
      // motion actually comes from.
      this._delta
        .subVectors(node.currentTail, node.prevTail)
        .multiplyScalar((1 - node.drag) * node.inertiaScale);

      this._next
        .copy(node.currentTail)
        .add(this._delta)
        .addScaledVector(this._restDir, node.stiffness * node.length * scale)
        .addScaledVector(GRAVITY_DIR, node.gravityPower * node.length * scale);

      // --- constrain to bone length ---------------------------------------
      this._dir.subVectors(this._next, this._center);
      const len = this._dir.length();
      if (len < 1e-6) {
        this._dir.copy(this._restDir);
      } else {
        this._dir.divideScalar(len);
      }

      // --- reassert rest direction ----------------------------------------
      // A steady pull back toward rest keeps chains from drifting into
      // unnatural poses over long idle periods.
      if (node.restPull > 0) {
        this._dir
          .lerp(this._restDir, THREE.MathUtils.clamp(node.restPull * scale, 0, 1))
          .normalize();
      }

      // --- clamp deviation --------------------------------------------------
      // The hard guarantee that motion stays tasteful: no chain may ever
      // deviate further from rest than its group's maximum angle.
      const cosAngle = THREE.MathUtils.clamp(this._dir.dot(this._restDir), -1, 1);
      const angle = Math.acos(cosAngle);
      if (angle > node.maxAngle) {
        const t = node.maxAngle / angle;
        // Spherical interpolation back toward rest, preserving direction.
        this._dir
          .multiplyScalar(Math.sin(t * angle) / Math.sin(angle))
          .addScaledVector(this._restDir, Math.sin((1 - t) * angle) / Math.sin(angle))
          .normalize();
      }

      // --- commit -----------------------------------------------------------
      this._next.copy(this._center).addScaledVector(this._dir, node.length);
      node.prevTail.copy(node.currentTail);
      node.currentTail.copy(this._next);

      // Rotation that aims the bone's rest axis at the simulated tail.
      this._invParentQuat.copy(this._parentQuat).invert();
      this._localDir.copy(this._dir).applyQuaternion(this._invParentQuat).normalize();
      this._quat.setFromUnitVectors(node.axis, this._localDir);

      // Amplitude blends between the animated pose and full physics, so a
      // group can be dialled down without changing its dynamics.
      if (node.amplitude >= 0.999) {
        bone.quaternion.copy(this._quat);
      } else {
        bone.quaternion.slerp(this._quat, node.amplitude);
      }

      // Children read this immediately, so publish it now.
      bone.updateWorldMatrix(false, false);
    }
  }

  dispose(): void {
    this.nodes = [];
  }
}
