/**
 * Pose editor: direct, per-bone and IK posing of any imported character.
 *
 * The edited pose lives in PoseBuffer's USER layer (local offsets from the
 * relaxed rest pose). Ownership decides who drives the body:
 *
 *   AI       procedural animation only (user layer faded out)
 *   USER     the user's pose holds; AI motion is suppressed (eyes still live)
 *   BLENDED  the user's pose is the base; AI motion is layered on top
 *
 * Editing anything while in AI mode switches to USER automatically, so the
 * character never fights the user for a limb.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { BoneEntry } from '@/shared/character/profile';
import { FINGERS, FINGER_JOINTS, THUMB_JOINTS, type FingerName, type Side } from '@/shared/character/humanoid';
import type { PoseBuffer } from '../animation/PoseBuffer';
import type { PmxModel } from '../loaders/pmxTypes';
import type { SecondaryMotion } from '../physics/SecondaryMotion';
import { createLimb, rotateBoneWorld, solveLimb, solveLook, type LimbChain, type LimbSolveResult, type LookChain } from './IkSolver';
import type { LimbTarget, SeatPlan } from '../scene/Seating';

/**
 * A whole-body pose described by goals instead of joint angles: where the
 * hips go, how the torso and head lean, where the hands reach. Solved with
 * the same IK as sitting, so one description fits every character.
 * Angles are degrees; positions are world space.
 */
export interface BodyPoseSpec {
  /** Move the hip midpoint by this world offset (crouch: negative y). */
  hipOffset?: THREE.Vector3;
  /** Keep both feet where they stand (re-solve the legs after the hips move). */
  plantFeet?: boolean;
  /** Positive tips the torso forward. */
  spineLean?: number;
  chestLean?: number;
  /** Sideways lean, positive toward her left. */
  spineRoll?: number;
  /** Turn of the torso about the vertical, positive toward her left. */
  spineTurn?: number;
  /** Head roll (positive toward her left), turn and nod (positive down). */
  headTilt?: number;
  headTurn?: number;
  headNod?: number;
  shrug?: number;
  hands?: { LEFT?: LimbTarget | null; RIGHT?: LimbTarget | null };
  handPreset?: { LEFT?: HandPreset; RIGHT?: HandPreset };
}

export type PoseOwnership = 'AI' | 'USER' | 'BLENDED';
export type IkHandleId = 'LEFT_HAND' | 'RIGHT_HAND' | 'LEFT_FOOT' | 'RIGHT_FOOT' | 'LOOK';
export type LimbGroup = 'leftArm' | 'rightArm' | 'leftHand' | 'rightHand' | 'leftLeg' | 'rightLeg' | 'torso' | 'head';
export type HandPreset = 'open' | 'relaxed' | 'fist' | 'point';

export interface PoseData {
  version: 2;
  /** Rotations relative to the model's bind pose (portable across models). */
  space: 'bind';
  /** "slot:LEFT_UPPER_ARM" or "bone:<name>" → [x, y, z, w]. */
  bones: Record<string, [number, number, number, number]>;
  translations?: Record<string, [number, number, number]>;
}

export interface GrabInfo {
  bone: string;
  mode: 'ik' | 'look' | 'aim' | 'move' | 'finger';
  handle?: IkHandleId;
  label: string;
  point?: THREE.Vector3;
}

export interface FingerJointState {
  curl: number;
  splay: number;
  twist: number;
}

interface FingerAxes {
  bone: string;
  curl: THREE.Vector3;
  splay: THREE.Vector3;
  twist: THREE.Vector3;
}

export interface PoseEditorDeps {
  model: PmxModel;
  pose: PoseBuffer;
  catalog: BoneEntry[];
  humanoid: Record<string, { bone: string }>;
  /** +1 if the model faces +Z. */
  facing: number;
  scene: THREE.Scene;
  camera: THREE.Camera;
  domElement: HTMLElement;
  physics: SecondaryMotion | null;
  /** Bone name → physics chain class (hair, skirt…) for friendly labels. */
  secondaryClass?: Record<string, string>;
  /** Bind (PMX) rest rotation for each bone, before the relaxed base pose. */
  bindRotations: Map<string, THREE.Quaternion>;
  onChange?: () => void;
  onOwnershipChange?: (mode: PoseOwnership) => void;
}

const HAND_PRESETS: Record<HandPreset, { finger: number[]; thumb: number[]; spread: number; pointIndex?: boolean }> = {
  open: { finger: [0, 0, 0], thumb: [0, 0, 0], spread: 4 },
  relaxed: { finger: [14, 22, 12], thumb: [6, 12, 10], spread: 2 },
  fist: { finger: [78, 96, 62], thumb: [22, 38, 42], spread: 0 },
  point: { finger: [78, 96, 62], thumb: [18, 32, 34], spread: 0, pointIndex: true },
};

export class PoseEditor {
  private ownershipMode: PoseOwnership = 'AI';
  blendAmount = 0.5;
  private selectedBone: string | null = null;
  private readonly transform: TransformControls;
  private readonly proxy = new THREE.Object3D();
  private readonly overlay = new THREE.Group();
  private readonly marker: THREE.Mesh;
  private readonly handles = new Map<IkHandleId, THREE.Mesh>();
  private activeHandle: IkHandleId | null = null;
  private dragStartEnd: THREE.Quaternion | null = null;
  private gizmoMode: 'rotate' | 'translate' = 'rotate';
  private enabledFlag = false;
  private dragging = false;
  private readonly limbs = new Map<IkHandleId, LimbChain>();
  private look: LookChain | null = null;
  private readonly front: THREE.Vector3;
  private readonly fingerAxes = new Map<string, FingerAxes>();
  private readonly fingerState = new Map<string, FingerJointState>();
  private readonly mirrorOf = new Map<string, string>();
  private readonly byName = new Map<string, BoneEntry>();
  private transition: { from: Map<string, THREE.Quaternion>; to: Map<string, THREE.Quaternion>; fromT: Map<string, THREE.Vector3>; toT: Map<string, THREE.Vector3>; t: number; duration: number } | null = null;
  private readonly _v = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  /** Reported by the last IK solve, for tests and UI. */
  lastIk: (LimbSolveResult & { handle: IkHandleId }) | null = null;

  constructor(private readonly deps: PoseEditorDeps) {
    this.front = new THREE.Vector3(0, 0, deps.facing >= 0 ? 1 : -1);
    for (const entry of deps.catalog) this.byName.set(entry.name, entry);
    for (const entry of deps.catalog) deps.pose.register(entry.name);

    this.transform = new TransformControls(deps.camera, deps.domElement);
    this.transform.setSize(0.75);
    this.transform.addEventListener('dragging-changed', (event) => this.onDragging(Boolean((event as unknown as { value: boolean }).value)));
    this.transform.addEventListener('objectChange', () => this.onGizmoChange());
    const helper = this.transform.getHelper();
    helper.visible = false;
    this.overlay.add(helper);

    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x5eead4, depthTest: false, transparent: true, opacity: 0.85 })
    );
    this.marker.renderOrder = 999;
    this.marker.visible = false;
    this.overlay.add(this.marker);
    deps.scene.add(this.overlay);
    deps.scene.add(this.proxy);

    this.buildIk();
    this.buildFingerAxes();
    this.buildMirrorMap();
  }

  // ---- setup -----------------------------------------------------------------

  private boneBySlot(slot: string): THREE.Bone | undefined {
    const name = this.deps.humanoid[slot]?.bone;
    return name ? this.boneByName(name) : undefined;
  }

  boneByName(name: string): THREE.Bone | undefined {
    const index = this.deps.model.boneIndexByName.get(name);
    return index === undefined ? undefined : this.deps.model.bones[index];
  }

  private worldScale(): number {
    return this.deps.model.mesh.getWorldScale(this._v).x || 1;
  }

  private buildIk(): void {
    this.deps.model.mesh.updateMatrixWorld(true);
    const limbs: Array<[IkHandleId, string, string, string, 'arm' | 'leg']> = [
      ['LEFT_HAND', 'LEFT_UPPER_ARM', 'LEFT_LOWER_ARM', 'LEFT_HAND', 'arm'],
      ['RIGHT_HAND', 'RIGHT_UPPER_ARM', 'RIGHT_LOWER_ARM', 'RIGHT_HAND', 'arm'],
      ['LEFT_FOOT', 'LEFT_UPPER_LEG', 'LEFT_LOWER_LEG', 'LEFT_FOOT', 'leg'],
      ['RIGHT_FOOT', 'RIGHT_UPPER_LEG', 'RIGHT_LOWER_LEG', 'RIGHT_FOOT', 'leg'],
    ];
    const size = 0.022 * this.characterHeight();
    for (const [id, a, b, c, kind] of limbs) {
      const root = this.boneBySlot(a);
      const mid = this.boneBySlot(b);
      const end = this.boneBySlot(c);
      if (!root || !mid || !end) continue;
      this.limbs.set(id, createLimb(root, mid, end, kind, this.front));
      this.handles.set(id, this.makeHandle(kind === 'arm' ? 0xf472b6 : 0x60a5fa, size));
    }
    const neck = this.boneBySlot('NECK');
    const head = this.boneBySlot('HEAD');
    const chest = this.boneBySlot('UPPER_CHEST') ?? this.boneBySlot('CHEST');
    if (head) {
      const bones: LookChain['bones'] = [];
      if (chest && neck) bones.push({ bone: chest, weight: 0.15 });
      if (neck) bones.push({ bone: neck, weight: neck && chest ? 0.35 : 0.45 });
      bones.push({ bone: head, weight: 1 - bones.reduce((s, b) => s + b.weight, 0) });
      this.look = { bones, maxYaw: THREE.MathUtils.degToRad(80), maxPitch: THREE.MathUtils.degToRad(45) };
      this.handles.set('LOOK', this.makeHandle(0xfacc15, size * 0.8));
    }
  }

  private makeHandle(color: number, size: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(size),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })
    );
    mesh.renderOrder = 998;
    mesh.visible = false;
    this.overlay.add(mesh);
    return mesh;
  }

  private characterHeight(): number {
    const head = this.boneBySlot('HEAD');
    const foot = this.boneBySlot('LEFT_FOOT');
    if (!head || !foot) return 1;
    return Math.max(0.2, head.getWorldPosition(new THREE.Vector3()).y - foot.getWorldPosition(new THREE.Vector3()).y);
  }

  private buildFingerAxes(): void {
    for (const side of ['LEFT', 'RIGHT'] as Side[]) {
      const hand = this.boneBySlot(`${side}_HAND`);
      const middle = this.boneBySlot(`${side}_MIDDLE_PROXIMAL`);
      const index = this.boneBySlot(`${side}_INDEX_PROXIMAL`);
      const little = this.boneBySlot(`${side}_LITTLE_PROXIMAL`) ?? this.boneBySlot(`${side}_RING_PROXIMAL`);
      if (!hand || !middle || !index || !little) continue;
      const wp = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
      const handDir = wp(middle).sub(wp(hand)).normalize();
      const across = wp(index).sub(wp(little)).normalize();
      // Palm normal: see the derivation in the module docs; mirrored per side.
      const palm = new THREE.Vector3().crossVectors(handDir, across).normalize().multiplyScalar(side === 'LEFT' ? 1 : -1);
      for (const finger of FINGERS) {
        const joints = finger === 'THUMB' ? THUMB_JOINTS : FINGER_JOINTS;
        joints.forEach((joint, i) => {
          const bone = this.boneBySlot(`${side}_${finger}_${joint}`);
          if (!bone) return;
          const next = this.boneBySlot(`${side}_${finger}_${joints[i + 1]}`) ?? bone.children.find((c) => (c as THREE.Bone).isBone);
          const dir = next ? wp(next).sub(wp(bone)).normalize() : handDir.clone();
          const worldQ = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
          const toLocal = (v: THREE.Vector3) => v.clone().applyQuaternion(worldQ).normalize();
          // Fingers flex toward the palm normal. The thumb opposes: it folds
          // toward the palm centre (slightly in front of the knuckle line).
          let curl = new THREE.Vector3().crossVectors(dir, palm).normalize();
          if (finger === 'THUMB') {
            const knuckles = ['INDEX', 'MIDDLE', 'RING', 'LITTLE']
              .map((f) => this.boneBySlot(`${side}_${f}_PROXIMAL`))
              .filter((b): b is THREE.Bone => !!b)
              .map(wp);
            const centre = knuckles.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(Math.max(1, knuckles.length));
            centre.lerp(wp(hand), 0.35).addScaledVector(palm, wp(middle).distanceTo(wp(hand)) * 0.35);
            const toward = centre.sub(wp(bone)).normalize();
            const axis = new THREE.Vector3().crossVectors(dir, toward);
            if (axis.lengthSq() > 1e-6) curl = axis.normalize();
          }
          this.fingerAxes.set(`${side}_${finger}_${joint}`, {
            bone: bone.name,
            curl: toLocal(curl),
            splay: toLocal(palm),
            twist: toLocal(dir),
          });
        });
      }
    }
  }

  private buildMirrorMap(): void {
    const swaps: Array<[RegExp, (m: string) => string]> = [
      [/^左/, () => '右'], [/^右/, () => '左'],
      [/([_.\s-])L(?=$|[_.\s-])/, (m) => m.replace('L', 'R')], [/([_.\s-])R(?=$|[_.\s-])/, (m) => m.replace('R', 'L')],
      [/^L([_.\s-])/, (m) => m.replace('L', 'R')], [/^R([_.\s-])/, (m) => m.replace('R', 'L')],
      [/Left/, () => 'Right'], [/Right/, () => 'Left'], [/left/, () => 'right'], [/right/, () => 'left'],
    ];
    for (const entry of this.deps.catalog) {
      for (const [pattern, replace] of swaps) {
        if (!pattern.test(entry.name)) continue;
        const candidate = entry.name.replace(pattern, replace);
        if (candidate !== entry.name && this.byName.has(candidate)) {
          this.mirrorOf.set(entry.name, candidate);
          break;
        }
      }
    }
  }

  // ---- ownership -------------------------------------------------------------

  get ownership(): PoseOwnership {
    return this.ownershipMode;
  }

  /** True once ownership weights have fully reached the current mode. */
  get settled(): boolean {
    const pose = this.deps.pose;
    const targetUser = this.ownershipMode === 'AI' ? 0 : 1;
    const targetAi = this.ownershipMode === 'USER' ? 0 : this.ownershipMode === 'BLENDED' ? this.blendAmount : 1;
    return pose.userWeight === targetUser && pose.aiWeight === targetAi && !this.transition;
  }

  setOwnership(mode: PoseOwnership): void {
    if (mode === this.ownershipMode) return;
    this.ownershipMode = mode;
    this.deps.onOwnershipChange?.(mode);
    this.emit();
  }

  private readonly listeners = new Set<() => void>();

  /** UI subscription: called after any edit, selection or ownership change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.deps.onChange?.();
    for (const listener of this.listeners) listener();
  }

  /** User edits take the body away from the AI. */
  private claim(): void {
    if (this.ownershipMode === 'AI') this.setOwnership('USER');
  }

  // ---- selection & gizmo --------------------------------------------------

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
    this.transform.enabled = enabled;
    this.transform.getHelper().visible = enabled && this.gizmoAllowed && (!!this.selectedBone || !!this.activeHandle);
    for (const handle of this.handles.values()) handle.visible = enabled && this.gizmoAllowed;
    this.marker.visible = enabled && !!this.selectedBone;
    if (!enabled) this.transform.detach();
    else this.reattach();
  }

  get selection(): string | null {
    return this.selectedBone;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  select(boneName: string | null): void {
    if (this.selectedBone && this.deps.physics) this.deps.physics.setPinned(this.selectedBone, false);
    this.selectedBone = boneName && this.byName.has(boneName) ? boneName : null;
    this.activeHandle = null;
    this.reattach();
    this.emit();
  }

  selectHandle(id: IkHandleId | null): void {
    this.activeHandle = id && this.handles.has(id) ? id : null;
    if (this.activeHandle) this.selectedBone = null;
    this.reattach();
    this.emit();
  }

  get handle(): IkHandleId | null {
    return this.activeHandle;
  }

  get availableHandles(): IkHandleId[] {
    return [...this.handles.keys()];
  }

  setGizmoMode(mode: 'rotate' | 'translate'): void {
    this.gizmoMode = mode;
    this.reattach();
  }

  setGizmoSpace(space: 'local' | 'world'): void {
    this.transform.setSpace(space);
  }

  private reattach(): void {
    this.transform.detach();
    const helper = this.transform.getHelper();
    helper.visible = false;
    for (const handle of this.handles.values()) handle.visible = this.enabledFlag && this.gizmoAllowed;
    if (!this.enabledFlag || !this.gizmoAllowed) return;
    if (this.activeHandle) {
      this.transform.setMode('translate');
      this.transform.attach(this.handles.get(this.activeHandle)!);
      helper.visible = true;
      return;
    }
    if (!this.selectedBone) return;
    const entry = this.byName.get(this.selectedBone)!;
    const mode = this.gizmoMode === 'translate' && entry.translatable ? 'translate' : 'rotate';
    this.syncProxy();
    this.transform.setMode(mode);
    this.transform.attach(this.proxy);
    helper.visible = true;
  }

  private syncProxy(): void {
    const bone = this.selectedBone ? this.boneByName(this.selectedBone) : undefined;
    if (!bone) return;
    bone.updateWorldMatrix(true, false);
    bone.matrixWorld.decompose(this.proxy.position, this.proxy.quaternion, this._v);
    this.proxy.scale.setScalar(1);
    this.proxy.updateMatrixWorld(true);
  }

  private onDragging(value: boolean): void {
    this.dragging = value;
    if (value) {
      this.claim();
      if (this.selectedBone) this.deps.physics?.setPinned(this.selectedBone, true);
      if (this.activeHandle && this.activeHandle !== 'LOOK') {
        const limb = this.limbs.get(this.activeHandle);
        this.dragStartEnd = limb ? limb.end.getWorldQuaternion(new THREE.Quaternion()) : null;
      }
    } else {
      this.dragStartEnd = null;
    }
  }

  private onGizmoChange(): void {
    if (this.activeHandle) {
      const handle = this.handles.get(this.activeHandle)!;
      this.solveHandle(this.activeHandle, handle.position);
      return;
    }
    const name = this.selectedBone;
    const bone = name ? this.boneByName(name) : undefined;
    if (!name || !bone) return;
    const rest = this.deps.pose.restOf(name);
    if (!rest) return;
    const parentQ = bone.parent ? bone.parent.getWorldQuaternion(this._q) : this._q.identity();
    if (this.transform.mode === 'rotate') {
      const local = parentQ.clone().invert().multiply(this.proxy.quaternion);
      this.deps.pose.setUserRotation(name, rest.quaternion.clone().invert().multiply(local));
      this.fingerState.delete(this.fingerKeyOf(name) ?? '');
    } else {
      const local = this.proxy.position.clone();
      bone.parent?.worldToLocal(local);
      this.deps.pose.setUserTranslation(name, local.sub(rest.position));
    }
    this.emit();
  }

  // ---- direct manipulation (grab a body part and drag it) ----------------

  private readonly raycaster = new THREE.Raycaster();
  private grab: {
    info: GrabInfo;
    plane: THREE.Plane;
    start: THREE.Vector3;
    startWorld: THREE.Quaternion;
    startTranslation: THREE.Vector3;
    startCurl: number;
    handleStart: THREE.Vector3;
  } | null = null;
  private gizmoAllowed = false;

  /** Gizmos are an advanced tool; direct dragging is the default. */
  setGizmoAllowed(allowed: boolean): void {
    this.gizmoAllowed = allowed;
    this.reattach();
  }

  get gizmoEnabled(): boolean {
    return this.gizmoAllowed;
  }

  get grabbing(): GrabInfo | null {
    return this.grab?.info ?? null;
  }

  /** Which body part is under the pointer (raycast against the skinned mesh). */
  partAt(ndcX: number, ndcY: number): GrabInfo | null {
    const mesh = this.deps.model.mesh;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.deps.camera);
    // The skinned bounds change as she moves; refresh before testing.
    mesh.computeBoundingSphere();
    const hits = this.raycaster.intersectObject(mesh, false).slice(0, 12);
    if (hits.length === 0) return null;
    const resolve = (hit: THREE.Intersection): string | null => {
      if (!hit.face) return null;
      const skinIndex = mesh.geometry.getAttribute('skinIndex');
      const skinWeight = mesh.geometry.getAttribute('skinWeight');
      const weights = new Map<number, number>();
      for (const vertex of [hit.face.a, hit.face.b, hit.face.c]) {
        for (let k = 0; k < 4; k += 1) {
          const w = skinWeight.getComponent(vertex, k);
          const bone = skinIndex.getComponent(vertex, k);
          if (w > 0) weights.set(bone, (weights.get(bone) ?? 0) + w);
        }
      }
      const dominant = [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return dominant === undefined ? null : this.grabTarget(dominant);
    };
    let chosen: { name: string; point: THREE.Vector3 } | null = null;
    const first = resolve(hits[0]);
    if (first) chosen = { name: first, point: hits[0].point };
    // Cloth or hair just in front of a limb (a skirt over a hand): people
    // almost always mean the body part, so prefer a body hit right behind.
    if (!first || this.byName.get(first)?.category === 'secondary') {
      const depth = this.characterHeight() * 0.12;
      for (const hit of hits.slice(1)) {
        if (hit.distance - hits[0].distance > depth) break;
        const name = resolve(hit);
        const category = name ? this.byName.get(name)?.category : undefined;
        if (name && category !== 'secondary') {
          chosen = { name, point: hit.point };
          break;
        }
      }
    }
    if (!chosen) return null;
    // A hand that is small on screen is grabbed as a whole (arm IK); zoom in
    // to curl individual fingers.
    const entry = this.byName.get(chosen.name);
    if (entry?.category === 'finger') {
      const side = entry.slot?.startsWith('RIGHT') ? 'RIGHT' : 'LEFT';
      const wrist = this.boneBySlot(`${side}_HAND`);
      const tip = this.boneBySlot(`${side}_MIDDLE_DISTAL`) ?? this.boneBySlot(`${side}_INDEX_DISTAL`);
      if (wrist && tip) {
        const a = wrist.getWorldPosition(new THREE.Vector3()).project(this.deps.camera);
        const b = tip.getWorldPosition(new THREE.Vector3()).project(this.deps.camera);
        if (Math.hypot(a.x - b.x, a.y - b.y) < 0.16) chosen.name = wrist.name;
      }
    }
    return { ...this.describeGrab(chosen.name), point: chosen.point.clone() };
  }

  /** Map the bone that deforms a vertex to the bone a user means to move. */
  private grabTarget(boneIndex: number): string | null {
    const infos = this.deps.model.boneInfos;
    let cursor = boneIndex;
    for (let guard = 0; cursor >= 0 && guard < 32; guard += 1) {
      const info = infos[cursor];
      const entry = this.byName.get(info.name);
      // MMD "D" bones copy a body bone through a grant: grab the source.
      if (info.grant && info.grant.ratio >= 0.5 && info.grant.affectRotation) {
        cursor = info.grant.parentIndex;
        continue;
      }
      if (entry) {
        if (entry.category === 'face') return this.deps.humanoid.HEAD?.bone ?? null;
        if (entry.category === 'body' || entry.category === 'finger' || entry.category === 'secondary') return entry.name;
        if (entry.category === 'control' && entry.translatable) return entry.name;
      }
      cursor = info.parentIndex;
    }
    return null;
  }

  private describeGrab(name: string): GrabInfo {
    const entry = this.byName.get(name);
    const slot = entry?.slot ?? '';
    const pretty = (slot || name).replace(/_/g, ' ').toLowerCase().replace(/^left /, 'left ').replace(/^(.)/, (c) => c.toUpperCase());
    if (/^(LEFT|RIGHT)_(HAND|LOWER_ARM)$/.test(slot)) {
      const handle = slot.startsWith('LEFT') ? 'LEFT_HAND' : 'RIGHT_HAND';
      if (this.limbs.has(handle)) return { bone: name, mode: 'ik', handle, label: `${slot.startsWith('LEFT') ? 'Left' : 'Right'} hand — drag to move the arm` };
    }
    if (/^(LEFT|RIGHT)_(FOOT|TOES|LOWER_LEG)$/.test(slot)) {
      const handle = slot.startsWith('LEFT') ? 'LEFT_FOOT' : 'RIGHT_FOOT';
      if (this.limbs.has(handle)) return { bone: name, mode: 'ik', handle, label: `${slot.startsWith('LEFT') ? 'Left' : 'Right'} foot — drag to move the leg` };
    }
    if (/^(HEAD|NECK)$/.test(slot) && this.look) return { bone: name, mode: 'look', handle: 'LOOK', label: 'Head — drag to turn the head' };
    if (/^(ROOT|CENTER|GROOVE|WAIST|HIPS|LOWER_BODY)$/.test(slot) || (entry?.category === 'control' && entry.translatable)) {
      const center = this.deps.humanoid.CENTER?.bone ?? this.deps.humanoid.HIPS?.bone;
      if (center && this.byName.get(center)?.translatable) return { bone: center, mode: 'move', label: 'Hips — drag to move the whole body' };
    }
    if (entry?.category === 'finger') {
      const key = this.fingerKeyOf(name);
      if (key) return { bone: name, mode: 'finger', label: `${pretty} — drag to curl` };
    }
    if (entry?.category === 'secondary') {
      const kind = this.deps.secondaryClass?.[name] ?? 'cloth';
      return { bone: name, mode: 'aim', label: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} — pull it; it swings back when released` };
    }
    return { bone: name, mode: 'aim', label: `${pretty} — drag to rotate` };
  }

  /** Start dragging the part under the pointer. Returns null on empty space. */
  beginGrab(ndcX: number, ndcY: number): GrabInfo | null {
    const info = this.partAt(ndcX, ndcY);
    if (!info || !info.point) return null;
    this.claim();
    const bone = this.boneByName(info.bone);
    if (!bone) return null;
    const camera = this.deps.camera;
    const normal = new THREE.Vector3();
    camera.getWorldDirection(normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, info.point);
    const startTranslation = this.deps.pose.getUserTranslation(info.bone)?.clone() ?? new THREE.Vector3();
    const key = info.mode === 'finger' ? this.fingerKeyOf(info.bone) : undefined;
    let handleStart = new THREE.Vector3();
    if (info.handle) handleStart = this.handlePosition(info.handle);
    if (info.handle && info.handle !== 'LOOK') {
      const limb = this.limbs.get(info.handle);
      this.dragStartEnd = limb ? limb.end.getWorldQuaternion(new THREE.Quaternion()) : null;
    }
    if (this.byName.get(info.bone)?.drivenBy === 'physics') this.deps.physics?.setPinned(info.bone, true);
    this.grab = {
      info,
      plane,
      start: info.point.clone(),
      startWorld: bone.getWorldQuaternion(new THREE.Quaternion()),
      startTranslation,
      startCurl: key ? this.getFingerJoint(key).curl : 0,
      handleStart,
    };
    this.selectedBone = info.bone;
    this.emit();
    return info;
  }

  /** Continue a drag: the grabbed point follows the pointer on a camera-facing plane. */
  dragTo(ndcX: number, ndcY: number): void {
    const g = this.grab;
    if (!g) return;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.deps.camera);
    const point = this.raycaster.ray.intersectPlane(g.plane, new THREE.Vector3());
    if (!point) return;
    const delta = point.clone().sub(g.start);
    const bone = this.boneByName(g.info.bone)!;
    switch (g.info.mode) {
      case 'ik':
        this.solveHandle(g.info.handle!, g.handleStart.clone().add(delta));
        break;
      case 'look': {
        const toCamera = this.deps.camera.position.clone().sub(point).normalize();
        this.solveHandle('LOOK', point.clone().addScaledVector(toCamera, this.characterHeight() * 0.4));
        break;
      }
      case 'move': {
        // World delta → the bone's parent space (undo root scale/rotation).
        const parent = bone.parent!;
        const local = parent.worldToLocal(g.start.clone().add(delta)).sub(parent.worldToLocal(g.start.clone()));
        this.deps.pose.setUserTranslation(g.info.bone, g.startTranslation.clone().add(local));
        break;
      }
      case 'finger': {
        const key = this.fingerKeyOf(g.info.bone)!;
        const axes = this.fingerAxes.get(key)!;
        const head = bone.getWorldPosition(new THREE.Vector3());
        const axis = axes.curl.clone().applyQuaternion(g.startWorld).normalize();
        const a = g.start.clone().sub(head).projectOnPlane(axis);
        const b = point.clone().sub(head).projectOnPlane(axis);
        if (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10) break;
        const angle = Math.atan2(new THREE.Vector3().crossVectors(a, b).dot(axis), a.dot(b));
        this.setFingerJoint(key, { curl: g.startCurl + THREE.MathUtils.radToDeg(angle) }, false);
        break;
      }
      case 'aim': {
        const head = bone.getWorldPosition(new THREE.Vector3());
        const from = g.start.clone().sub(head);
        const to = point.clone().sub(head);
        if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) break;
        const swing = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
        // Keep edits within a natural range from where the drag began.
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(swing.w), 0, 1));
        const limit = THREE.MathUtils.degToRad(150);
        if (angle > limit) swing.slerp(new THREE.Quaternion(), 1 - limit / angle);
        const world = swing.multiply(g.startWorld);
        const parentQ = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
        const local = parentQ.invert().multiply(world);
        const rest = this.deps.pose.restOf(g.info.bone);
        if (rest) this.deps.pose.setUserRotation(g.info.bone, rest.quaternion.clone().invert().multiply(local));
        // Apply immediately so the next drag step measures from the new pose.
        bone.quaternion.copy(local);
        bone.updateWorldMatrix(false, true);
        break;
      }
    }
    this.emit();
  }

  endGrab(): void {
    const g = this.grab;
    if (!g) return;
    this.grab = null;
    this.dragStartEnd = null;
    if (this.byName.get(g.info.bone)?.drivenBy === 'physics') {
      // Let go of hair/cloth: it springs back under physics.
      this.deps.pose.clearUser([g.info.bone]);
      this.deps.physics?.setPinned(g.info.bone, false);
    }
    this.emit();
  }

  /** Highlight a part (hover) without grabbing it. */
  setHover(info: GrabInfo | null): void {
    this.hovered = info;
  }

  private hovered: GrabInfo | null = null;

  /** Nearest pickable bone to a point in normalised device coordinates. */
  pick(ndcX: number, ndcY: number, maxDistance = 0.05): string | null {
    let best: string | null = null;
    let bestScore = Infinity;
    const camera = this.deps.camera;
    for (const entry of this.deps.catalog) {
      if (!entry.rotatable && !entry.translatable) continue;
      if (entry.category === 'ik' || entry.category === 'helper' || entry.category === 'twist') continue;
      const bone = this.boneByName(entry.name);
      if (!bone) continue;
      bone.getWorldPosition(this._v).project(camera);
      if (this._v.z > 1) continue;
      const d = Math.hypot(this._v.x - ndcX, this._v.y - ndcY);
      const penalty = entry.category === 'body' ? 0 : entry.category === 'finger' ? 0.004 : 0.012;
      if (d < maxDistance && d + penalty < bestScore) {
        bestScore = d + penalty;
        best = entry.name;
      }
    }
    return best;
  }

  /** Nearest IK handle under the pointer, if any. */
  pickHandle(ndcX: number, ndcY: number, maxDistance = 0.04): IkHandleId | null {
    let best: IkHandleId | null = null;
    let bestD = maxDistance;
    for (const [id, mesh] of this.handles) {
      mesh.getWorldPosition(this._v).project(this.deps.camera);
      const d = Math.hypot(this._v.x - ndcX, this._v.y - ndcY);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  // ---- numeric edits -------------------------------------------------------

  /** Local rotation offset from rest as XYZ euler degrees. */
  getBoneEuler(name: string): [number, number, number] {
    const q = this.deps.pose.getUserRotation(name);
    if (!q) return [0, 0, 0];
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    return [e.x, e.y, e.z].map((v) => +THREE.MathUtils.radToDeg(v).toFixed(2)) as [number, number, number];
  }

  setBoneEuler(name: string, degrees: [number, number, number]): void {
    if (!this.byName.has(name)) return;
    this.claim();
    const [x, y, z] = degrees.map((d) => THREE.MathUtils.degToRad(d));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
    this.deps.pose.setUserRotation(name, q);
    this.fingerState.delete(this.fingerKeyOf(name) ?? '');
    this.emit();
  }

  getBoneTranslation(name: string): [number, number, number] {
    const t = this.deps.pose.getUserTranslation(name);
    return t ? [+t.x.toFixed(3), +t.y.toFixed(3), +t.z.toFixed(3)] : [0, 0, 0];
  }

  setBoneTranslation(name: string, offset: [number, number, number]): void {
    const entry = this.byName.get(name);
    if (!entry?.translatable) return;
    this.claim();
    this.deps.pose.setUserTranslation(name, new THREE.Vector3(...offset));
    this.emit();
  }

  resetBone(name: string): void {
    this.deps.pose.clearUser([name]);
    this.fingerState.delete(this.fingerKeyOf(name) ?? '');
    this.emit();
  }

  private descendants(rootName: string): string[] {
    const root = this.boneByName(rootName);
    if (!root) return [];
    const out: string[] = [];
    root.traverse((child) => {
      if ((child as THREE.Bone).isBone) out.push(child.name);
    });
    return out;
  }

  resetLimb(limb: LimbGroup): void {
    const slot = (s: string) => this.deps.humanoid[s]?.bone;
    let names: string[] = [];
    switch (limb) {
      case 'leftArm': names = this.descendants(slot('LEFT_SHOULDER') ?? slot('LEFT_UPPER_ARM') ?? ''); break;
      case 'rightArm': names = this.descendants(slot('RIGHT_SHOULDER') ?? slot('RIGHT_UPPER_ARM') ?? ''); break;
      case 'leftHand': names = this.descendants(slot('LEFT_HAND') ?? ''); break;
      case 'rightHand': names = this.descendants(slot('RIGHT_HAND') ?? ''); break;
      case 'leftLeg': names = this.descendants(slot('LEFT_UPPER_LEG') ?? ''); break;
      case 'rightLeg': names = this.descendants(slot('RIGHT_UPPER_LEG') ?? ''); break;
      case 'head': names = this.descendants(slot('NECK') ?? slot('HEAD') ?? ''); break;
      case 'torso': names = ['ROOT', 'CENTER', 'GROOVE', 'WAIST', 'HIPS', 'LOWER_BODY', 'SPINE', 'CHEST', 'UPPER_CHEST'].map(slot).filter(Boolean) as string[]; break;
    }
    this.deps.pose.clearUser(names);
    for (const key of [...this.fingerState.keys()]) {
      const axes = this.fingerAxes.get(key);
      if (axes && names.includes(axes.bone)) this.fingerState.delete(key);
    }
    this.emit();
  }

  resetBody(): void {
    this.deps.pose.clearUser();
    this.fingerState.clear();
    this.emit();
  }

  /** Copy one side onto the other ('leftToRight'/'rightToLeft') or swap both. */
  mirror(mode: 'leftToRight' | 'rightToLeft' | 'flip' = 'flip'): void {
    this.claim();
    const pose = this.deps.pose;
    const mirrorQ = (q: THREE.Quaternion) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
    const mirrorT = (t: THREE.Vector3) => new THREE.Vector3(-t.x, t.y, t.z);
    const snapshot = new Map(pose.userBones.map((name) => [name, { q: pose.getUserRotation(name)?.clone(), t: pose.getUserTranslation(name)?.clone() }]));
    const isLeft = (name: string) => /^左|([_.\s-])L($|[_.\s-])|^L[_.\s-]|Left|left/.test(name);
    const targets = new Set<string>();
    for (const entry of this.deps.catalog) {
      const counterpart = this.mirrorOf.get(entry.name);
      if (!counterpart) continue;
      if (mode === 'leftToRight' && !isLeft(entry.name)) continue;
      if (mode === 'rightToLeft' && isLeft(entry.name)) continue;
      const source = snapshot.get(entry.name);
      targets.add(counterpart);
      pose.setUserRotation(counterpart, source?.q ? mirrorQ(source.q) : null);
      pose.setUserTranslation(counterpart, source?.t ? mirrorT(source.t) : null);
    }
    if (mode === 'flip') {
      // Centre-line bones mirror onto themselves.
      for (const [name, value] of snapshot) {
        if (this.mirrorOf.has(name) || targets.has(name)) continue;
        if (value.q) pose.setUserRotation(name, mirrorQ(value.q));
        if (value.t) pose.setUserTranslation(name, mirrorT(value.t));
      }
    }
    this.fingerState.clear();
    this.emit();
  }

  // ---- fingers ---------------------------------------------------------------

  private fingerKeyOf(boneName: string): string | undefined {
    for (const [key, axes] of this.fingerAxes) if (axes.bone === boneName) return key;
    return undefined;
  }

  /** Bone catalogue entry (category, flags, who drives it). */
  entry(name: string): BoneEntry | undefined {
    return this.byName.get(name);
  }

  get catalog(): BoneEntry[] {
    return this.deps.catalog;
  }

  get humanoid(): Record<string, { bone: string }> {
    return this.deps.humanoid;
  }

  isEdited(name: string): boolean {
    return !!this.deps.pose.getUserRotation(name) || !!this.deps.pose.getUserTranslation(name);
  }

  /** Finger joints this model actually has, e.g. "LEFT_INDEX_PROXIMAL". */
  get fingerJoints(): string[] {
    return [...this.fingerAxes.keys()];
  }

  getFingerJoint(key: string): FingerJointState {
    return this.fingerState.get(key) ?? { curl: 0, splay: 0, twist: 0 };
  }

  /** Set one finger joint in degrees of curl (into the palm), splay and twist. */
  setFingerJoint(key: string, state: Partial<FingerJointState>, notify = true): void {
    const axes = this.fingerAxes.get(key);
    if (!axes) return;
    this.claim();
    const next = { ...this.getFingerJoint(key), ...state };
    next.curl = THREE.MathUtils.clamp(next.curl, -30, 120);
    next.splay = THREE.MathUtils.clamp(next.splay, -35, 35);
    next.twist = THREE.MathUtils.clamp(next.twist, -45, 45);
    this.fingerState.set(key, next);
    const q = new THREE.Quaternion()
      .setFromAxisAngle(axes.curl, THREE.MathUtils.degToRad(next.curl))
      .multiply(this._q2.setFromAxisAngle(axes.splay, THREE.MathUtils.degToRad(next.splay)))
      .multiply(this._q.setFromAxisAngle(axes.twist, THREE.MathUtils.degToRad(next.twist)));
    this.deps.pose.setUserRotation(axes.bone, q);
    if (notify) this.emit();
  }

  applyHandPreset(side: Side, preset: HandPreset, amount = 1): void {
    const spec = HAND_PRESETS[preset];
    FINGERS.forEach((finger: FingerName, fingerIndex) => {
      const joints = finger === 'THUMB' ? THUMB_JOINTS : FINGER_JOINTS;
      const curls = finger === 'THUMB' ? spec.thumb : spec.pointIndex && finger === 'INDEX' ? [0, 0, 0] : spec.finger;
      // Outer fingers curl a little more, like a real relaxed hand.
      const taper = finger === 'THUMB' ? 1 : 1 + (fingerIndex - 1) * (preset === 'relaxed' ? 0.12 : 0.02);
      joints.forEach((joint, i) => {
        const key = `${side}_${finger}_${joint}`;
        if (!this.fingerAxes.has(key)) return;
        const splay = i === 0 && finger !== 'THUMB' ? (fingerIndex - 2.5) * -spec.spread : 0;
        this.setFingerJoint(key, { curl: curls[i] * taper * amount, splay: splay * amount, twist: 0 }, false);
      });
    });
    this.emit();
  }

  // ---- IK ----------------------------------------------------------------------

  /** World position for a handle that matches the current pose. */
  handlePosition(id: IkHandleId, out = new THREE.Vector3()): THREE.Vector3 {
    if (id === 'LOOK') {
      const head = this.boneBySlot('HEAD');
      if (!head) return out.set(0, 0, 0);
      head.getWorldPosition(out);
      const q = head.getWorldQuaternion(this._q);
      return out.addScaledVector(this.front.clone().applyQuaternion(q), this.characterHeight() * 0.35);
    }
    const limb = this.limbs.get(id);
    return limb ? limb.end.getWorldPosition(out) : out.set(0, 0, 0);
  }

  private defaultPole(id: IkHandleId, limb: LimbChain): THREE.Vector3 {
    const root = limb.root.getWorldPosition(new THREE.Vector3());
    const length = (limb.upperLength + limb.lowerLength) * this.worldScale();
    const bodyQ = (this.boneBySlot('UPPER_CHEST') ?? this.boneBySlot('SPINE') ?? limb.root.parent ?? limb.root).getWorldQuaternion(new THREE.Quaternion());
    const front = this.front.clone().applyQuaternion(bodyQ);
    if (limb.kind === 'leg') return root.addScaledVector(front, length).addScaledVector(new THREE.Vector3(0, -1, 0), length * 0.5);
    const outward = new THREE.Vector3(id === 'LEFT_HAND' ? 1 : -1, 0, 0).applyQuaternion(bodyQ);
    return root.addScaledVector(front, -length * 0.6).addScaledVector(new THREE.Vector3(0, -1, 0), length * 0.6).addScaledVector(outward, length * 0.3);
  }

  /**
   * Move an IK handle to a world position and solve. The solved local
   * rotations are written into the user layer so the pose persists.
   */
  solveHandle(id: IkHandleId, target: THREE.Vector3, pole?: THREE.Vector3): LimbSolveResult | null {
    this.claim();
    const pose = this.deps.pose;
    const store = (bone: THREE.Bone) => {
      const rest = pose.restOf(bone.name);
      if (rest) pose.setUserRotation(bone.name, rest.quaternion.clone().invert().multiply(bone.quaternion));
    };
    if (id === 'LOOK') {
      if (!this.look) return null;
      const result = solveLook(this.look, target, this.front);
      for (const { bone } of this.look.bones) store(bone);
      this.handles.get('LOOK')?.position.copy(target);
      this.emit();
      return { reached: true, error: 0, bendDeg: Math.hypot(result.yawDeg, result.pitchDeg) };
    }
    const limb = this.limbs.get(id);
    if (!limb) return null;
    const keepEnd = this.dragStartEnd ?? limb.end.getWorldQuaternion(new THREE.Quaternion());
    const result = solveLimb(limb, target, pole ?? this.defaultPole(id, limb), keepEnd);
    store(limb.root);
    store(limb.mid);
    store(limb.end);
    this.handles.get(id)?.position.copy(target);
    this.lastIk = { ...result, handle: id };
    this.emit();
    return result;
  }

  /**
   * Solve a seated pose from a SeatPlan (see scene/Seating.ts) and return it
   * as pose data, without changing what is currently shown: the caller eases
   * from the current pose into the result. Order matters - hips first, then
   * pelvis and spine, then legs (which hang off the hips) and finally hands
   * (which hang off the spine).
   */
  solveSeated(plan: SeatPlan): PoseData {
    const pose = this.deps.pose;
    const before = this.capture();
    const weights = { user: pose.userWeight, ai: pose.aiWeight };
    pose.userWeight = 1;
    pose.aiWeight = 0;
    this.transition = null;
    pose.clearUser();
    this.fingerState.clear();
    const refresh = () => {
      pose.apply();
      this.deps.model.mesh.updateMatrixWorld(true);
    };
    const store = (bone: THREE.Bone) => {
      const rest = pose.restOf(bone.name);
      if (rest) pose.setUserRotation(bone.name, rest.quaternion.clone().invert().multiply(bone.quaternion));
    };
    const wp = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
    refresh();

    // 1. Lower the body until the hip joints sit at the planned height.
    const hipL = this.boneBySlot('LEFT_UPPER_LEG');
    const hipR = this.boneBySlot('RIGHT_UPPER_LEG');
    const mover = this.boneBySlot('CENTER') ?? this.boneBySlot('HIPS') ?? this.boneBySlot('LOWER_BODY');
    if (hipL && hipR && mover?.parent) {
      for (let pass = 0; pass < 2; pass++) {
        const current = wp(hipL).add(wp(hipR)).multiplyScalar(0.5);
        const delta = plan.hipCenter.clone().sub(current);
        const at = wp(mover);
        const local = mover.parent.worldToLocal(at.clone().add(delta)).sub(mover.parent.worldToLocal(at.clone()));
        const existing = pose.getUserTranslation(mover.name) ?? new THREE.Vector3();
        pose.setUserTranslation(mover.name, existing.clone().add(local));
        refresh();
      }
    }

    // 2. Pelvis tilt, spine lean and torso turn. Positive angles about
    // up × forward tip the top of a bone toward the front.
    const leanAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.front).normalize();
    const turn = (slot: string, axis: THREE.Vector3, degrees: number) => {
      const bone = this.boneBySlot(slot);
      if (!bone || Math.abs(degrees) < 0.01) return;
      rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees)));
      store(bone);
    };
    turn('LOWER_BODY', leanAxis, plan.pelvisTilt);
    turn('SPINE', leanAxis, plan.spineLean);
    turn('SPINE', new THREE.Vector3(0, 1, 0), plan.torsoTurn);
    turn(this.boneBySlot('UPPER_CHEST') ? 'UPPER_CHEST' : 'CHEST', leanAxis, plan.chestLean);
    // A small head tilt and shoulder lift: the details that make a seated
    // pose read as relaxed and feminine instead of stiff.
    turn('HEAD', this.front, -(plan.headTilt ?? 0));
    if (plan.shrug) {
      turn('LEFT_SHOULDER', this.front, -plan.shrug);
      turn('RIGHT_SHOULDER', this.front, plan.shrug);
    }
    refresh();

    // 3. Legs. Feet keep their flat rest orientation; hanging feet point
    // their toes down a little, as relaxed feet do.
    for (const side of ['LEFT', 'RIGHT'] as const) {
      const leg = plan.legs[side];
      this.dragStartEnd = null;
      this.solveHandle(`${side}_FOOT`, leg.target, leg.pole);
      if (plan.dangling) turn(`${side}_FOOT`, leanAxis, 22);
    }
    refresh();

    // 4. Hands, then aim the fingers along the surface they rest on.
    for (const side of ['LEFT', 'RIGHT'] as const) {
      const hand = plan.hands[side];
      if (!hand) continue;
      this.solveHandle(`${side}_HAND`, hand.target, hand.pole);
      const handBone = this.boneBySlot(`${side}_HAND`);
      const middle = this.boneBySlot(`${side}_MIDDLE_PROXIMAL`);
      if (hand.aim && handBone && middle) {
        const current = wp(middle).sub(wp(handBone)).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(current, hand.aim.clone().normalize());
        // Partial aim: wrists cannot bend fully, and the forearm already
        // carries most of the direction.
        rotateBoneWorld(handBone, new THREE.Quaternion().slerp(q, 0.75));
        store(handBone);
      }
      this.applyHandPreset(side, 'relaxed', 0.9);
    }
    refresh();

    const seated = this.capture();
    // Restore what was shown; the caller eases into `seated`.
    pose.clearUser();
    pose.userWeight = weights.user;
    pose.aiWeight = weights.ai;
    this.apply(before, { duration: 0 });
    return seated;
  }

  /**
   * Solve a BodyPoseSpec from the rest stance and return it as pose data,
   * leaving what is shown unchanged (the caller eases into the result).
   */
  solveBody(spec: BodyPoseSpec): PoseData {
    const pose = this.deps.pose;
    const before = this.capture();
    const weights = { user: pose.userWeight, ai: pose.aiWeight };
    pose.userWeight = 1;
    pose.aiWeight = 0;
    this.transition = null;
    pose.clearUser();
    this.fingerState.clear();
    const refresh = () => {
      pose.apply();
      this.deps.model.mesh.updateMatrixWorld(true);
    };
    const store = (bone: THREE.Bone) => {
      const rest = pose.restOf(bone.name);
      if (rest) pose.setUserRotation(bone.name, rest.quaternion.clone().invert().multiply(bone.quaternion));
    };
    const wp = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
    refresh();
    const feet = {
      LEFT: this.limbs.get('LEFT_FOOT') ? wp(this.limbs.get('LEFT_FOOT')!.end) : null,
      RIGHT: this.limbs.get('RIGHT_FOOT') ? wp(this.limbs.get('RIGHT_FOOT')!.end) : null,
    };

    const mover = this.boneBySlot('CENTER') ?? this.boneBySlot('HIPS') ?? this.boneBySlot('LOWER_BODY');
    if (spec.hipOffset && spec.hipOffset.lengthSq() > 0 && mover?.parent) {
      const at = wp(mover);
      const local = mover.parent.worldToLocal(at.clone().add(spec.hipOffset)).sub(mover.parent.worldToLocal(at.clone()));
      pose.setUserTranslation(mover.name, local);
      refresh();
    }
    const leanAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.front).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const turn = (slot: string, axis: THREE.Vector3, degrees: number | undefined) => {
      const bone = this.boneBySlot(slot);
      if (!bone || !degrees || Math.abs(degrees) < 0.01) return;
      rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees)));
      store(bone);
    };
    turn('SPINE', leanAxis, spec.spineLean);
    turn('SPINE', this.front, -(spec.spineRoll ?? 0));
    turn('SPINE', up, spec.spineTurn);
    turn(this.boneBySlot('UPPER_CHEST') ? 'UPPER_CHEST' : 'CHEST', leanAxis, spec.chestLean);
    turn('NECK', leanAxis, spec.headNod ? spec.headNod * 0.35 : 0);
    turn('HEAD', leanAxis, spec.headNod ? spec.headNod * 0.65 : 0);
    turn('HEAD', up, spec.headTurn);
    turn('HEAD', this.front, -(spec.headTilt ?? 0));
    if (spec.shrug) {
      turn('LEFT_SHOULDER', this.front, -spec.shrug);
      turn('RIGHT_SHOULDER', this.front, spec.shrug);
    }
    refresh();

    if (spec.plantFeet) {
      for (const side of ['LEFT', 'RIGHT'] as const) {
        const foot = feet[side];
        if (!foot) continue;
        this.dragStartEnd = null;
        this.solveHandle(`${side}_FOOT`, foot);
      }
      refresh();
    }
    for (const side of ['LEFT', 'RIGHT'] as const) {
      const hand = spec.hands?.[side];
      if (hand) {
        this.dragStartEnd = null;
        this.solveHandle(`${side}_HAND`, hand.target, hand.pole);
        const handBone = this.boneBySlot(`${side}_HAND`);
        const middle = this.boneBySlot(`${side}_MIDDLE_PROXIMAL`);
        if (hand.aim && handBone && middle) {
          const current = wp(middle).sub(wp(handBone)).normalize();
          const q = new THREE.Quaternion().setFromUnitVectors(current, hand.aim.clone().normalize());
          rotateBoneWorld(handBone, new THREE.Quaternion().slerp(q, 0.75));
          store(handBone);
        }
      }
      const preset = spec.handPreset?.[side];
      if (preset) this.applyHandPreset(side, preset, 0.9);
    }
    refresh();

    const solved = this.capture();
    // Where the solved pose puts the head and hands (callers place windows
    // and screen edges from these).
    this.solvedPositions.clear();
    for (const slot of ['HEAD', 'LEFT_HAND', 'RIGHT_HAND', 'LEFT_MIDDLE_DISTAL', 'RIGHT_MIDDLE_DISTAL', 'LEFT_MIDDLE_INTERMEDIATE', 'RIGHT_MIDDLE_INTERMEDIATE']) {
      const bone = this.boneBySlot(slot);
      if (bone) this.solvedPositions.set(slot, wp(bone));
    }
    pose.clearUser();
    pose.userWeight = weights.user;
    pose.aiWeight = weights.ai;
    this.apply(before, { duration: 0 });
    return solved;
  }

  /** World positions of key slots in the last solveBody result. */
  readonly solvedPositions = new Map<string, THREE.Vector3>();

  /** True while a pose transition is easing. */
  get transitioning(): boolean {
    return this.transition !== null;
  }

  // ---- whole poses -----------------------------------------------------------

  private keyFor(name: string): string {
    const entry = this.byName.get(name);
    return entry?.slot ? `slot:${entry.slot}` : `bone:${name}`;
  }

  private nameFor(key: string): string | undefined {
    if (key.startsWith('slot:')) return this.deps.humanoid[key.slice(5)]?.bone;
    if (key.startsWith('bone:')) return this.byName.has(key.slice(5)) ? key.slice(5) : undefined;
    // Legacy poses keyed by raw bone name or slot.
    return this.byName.has(key) ? key : this.deps.humanoid[key]?.bone;
  }

  /** Capture the user layer, relative to the bind pose (portable). */
  capture(): PoseData {
    const pose = this.deps.pose;
    const bones: PoseData['bones'] = {};
    const translations: NonNullable<PoseData['translations']> = {};
    for (const name of pose.userBones) {
      const rest = pose.restOf(name);
      const user = pose.getUserRotation(name);
      if (rest && user) {
        const bind = this.deps.bindRotations.get(name) ?? new THREE.Quaternion();
        // bind⁻¹ · rest · user = rotation relative to the original model pose.
        const q = bind.clone().invert().multiply(rest.quaternion).multiply(user);
        bones[this.keyFor(name)] = [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(6)) as [number, number, number, number];
      }
      const t = pose.getUserTranslation(name);
      if (t) translations[this.keyFor(name)] = [t.x, t.y, t.z].map((v) => +v.toFixed(4)) as [number, number, number];
    }
    return { version: 2, space: 'bind', bones, ...(Object.keys(translations).length ? { translations } : {}) };
  }

  /** Convert stored pose data into user-layer targets for this model. */
  private resolve(data: PoseData | { bones: Record<string, number[]> }): { rotations: Map<string, THREE.Quaternion>; translations: Map<string, THREE.Vector3> } {
    const rotations = new Map<string, THREE.Quaternion>();
    const translations = new Map<string, THREE.Vector3>();
    const bindSpace = (data as PoseData).space === 'bind';
    for (const [key, value] of Object.entries(data.bones || {})) {
      const name = this.nameFor(key);
      const rest = name ? this.deps.pose.restOf(name) : undefined;
      if (!name || !rest || !Array.isArray(value) || value.length !== 4) continue;
      const q = new THREE.Quaternion(value[0], value[1], value[2], value[3]).normalize();
      if (bindSpace) {
        const bind = this.deps.bindRotations.get(name) ?? new THREE.Quaternion();
        rotations.set(name, rest.quaternion.clone().invert().multiply(bind).multiply(q));
      } else {
        rotations.set(name, q);
      }
    }
    for (const [key, value] of Object.entries((data as PoseData).translations || {})) {
      const name = this.nameFor(key);
      if (name && Array.isArray(value) && value.length === 3) translations.set(name, new THREE.Vector3(...value));
    }
    return { rotations, translations };
  }

  /** Apply a pose, optionally easing from the current one over `duration` seconds. */
  apply(data: PoseData | { bones: Record<string, number[]> }, options: { duration?: number; replace?: boolean } = {}): number {
    this.claim();
    const { rotations, translations } = this.resolve(data);
    const pose = this.deps.pose;
    const names = new Set([...rotations.keys(), ...translations.keys(), ...(options.replace !== false ? pose.userBones : [])]);
    const from = new Map<string, THREE.Quaternion>();
    const fromT = new Map<string, THREE.Vector3>();
    for (const name of names) {
      from.set(name, pose.getUserRotation(name)?.clone() ?? new THREE.Quaternion());
      fromT.set(name, pose.getUserTranslation(name)?.clone() ?? new THREE.Vector3());
      if (!rotations.has(name)) rotations.set(name, options.replace !== false ? new THREE.Quaternion() : from.get(name)!.clone());
      if (!translations.has(name)) translations.set(name, options.replace !== false ? new THREE.Vector3() : fromT.get(name)!.clone());
    }
    this.fingerState.clear();
    const duration = options.duration ?? 0.35;
    if (duration <= 0) {
      for (const [name, q] of rotations) pose.setUserRotation(name, q);
      for (const [name, t] of translations) pose.setUserTranslation(name, t);
    } else {
      this.transition = { from, to: rotations, fromT, toT: translations, t: 0, duration };
    }
    this.emit();
    return rotations.size;
  }

  /** Blend two poses: t=0 → a, t=1 → b. */
  blend(a: PoseData, b: PoseData, t: number): void {
    const ra = this.resolve(a);
    const rb = this.resolve(b);
    const names = new Set([...ra.rotations.keys(), ...rb.rotations.keys()]);
    const out: PoseData = { version: 2, space: 'bind', bones: {} };
    const mixed = new Map<string, THREE.Quaternion>();
    for (const name of names) {
      const qa = ra.rotations.get(name) ?? new THREE.Quaternion();
      const qb = rb.rotations.get(name) ?? new THREE.Quaternion();
      mixed.set(name, qa.clone().slerp(qb, THREE.MathUtils.clamp(t, 0, 1)));
    }
    this.claim();
    this.deps.pose.clearUser();
    for (const [name, q] of mixed) this.deps.pose.setUserRotation(name, q);
    const tNames = new Set([...ra.translations.keys(), ...rb.translations.keys()]);
    for (const name of tNames) {
      const ta = ra.translations.get(name) ?? new THREE.Vector3();
      const tb = rb.translations.get(name) ?? new THREE.Vector3();
      this.deps.pose.setUserTranslation(name, ta.clone().lerp(tb, t));
    }
    void out;
    this.emit();
  }

  // ---- per frame -------------------------------------------------------------

  /** Ease ownership weights and pose transitions; keep gizmos on their bones. */
  update(delta: number): void {
    const pose = this.deps.pose;
    const targetUser = this.ownershipMode === 'AI' ? 0 : 1;
    const targetAi = this.ownershipMode === 'USER' ? 0 : this.ownershipMode === 'BLENDED' ? this.blendAmount : 1;
    const k = 1 - Math.exp(-6 * delta);
    pose.userWeight += (targetUser - pose.userWeight) * k;
    pose.aiWeight += (targetAi - pose.aiWeight) * k;
    if (Math.abs(pose.userWeight - targetUser) < 0.01) pose.userWeight = targetUser;
    if (Math.abs(pose.aiWeight - targetAi) < 0.01) pose.aiWeight = targetAi;

    if (this.transition) {
      const tr = this.transition;
      tr.t = Math.min(1, tr.t + delta / tr.duration);
      const e = tr.t * tr.t * (3 - 2 * tr.t);
      for (const [name, to] of tr.to) pose.setUserRotation(name, this._q.copy(tr.from.get(name) ?? new THREE.Quaternion()).slerp(to, e));
      for (const [name, to] of tr.toT) pose.setUserTranslation(name, this._v.copy(tr.fromT.get(name) ?? new THREE.Vector3()).lerp(to, e));
      if (tr.t >= 1) {
        // Drop bones that ended at rest. A bone with an identity rotation may
        // still carry a translation (the hips when sitting), so check both.
        const identity = new THREE.Quaternion();
        for (const [name, q] of tr.to) {
          const t = tr.toT.get(name);
          if (q.equals(identity) && (!t || t.lengthSq() < 1e-12)) pose.clearUser([name]);
        }
        this.transition = null;
      }
    }
  }

  /** After the skeleton is final for this frame: move markers and handles. */
  afterPose(): void {
    if (!this.enabledFlag) return;
    const height = this.characterHeight();
    const markerBone = this.hovered?.bone ?? this.selectedBone;
    if (markerBone) {
      const bone = this.boneByName(markerBone);
      if (bone) {
        bone.getWorldPosition(this.marker.position);
        this.marker.scale.setScalar(height * 0.008);
        this.marker.visible = true;
      }
      if (!this.dragging && this.selectedBone) this.syncProxy();
    } else {
      this.marker.visible = false;
    }
    for (const [id, mesh] of this.handles) {
      if (this.dragging && id === this.activeHandle) continue;
      this.handlePosition(id, mesh.position);
    }
  }

  dispose(): void {
    this.transform.detach();
    this.transform.dispose();
    this.deps.scene.remove(this.overlay);
    this.deps.scene.remove(this.proxy);
    this.overlay.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    });
  }
}
