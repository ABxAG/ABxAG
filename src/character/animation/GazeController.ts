/**
 * Gaze: where the character is looking, and how her eyes, neck and head get
 * there.
 *
 * Three details do most of the work in making gaze look alive:
 *
 *   1. Eyes lead, head follows. Real eye movement is near-instant while the
 *      head catches up over a few hundred milliseconds. Driving both at the
 *      same speed is the single biggest giveaway of a puppet.
 *   2. Saccades. Eyes never hold perfectly still - they jitter between
 *      fixation points constantly. Without this the stare looks glassy.
 *   3. Blink on large re-fixations, which is what people actually do.
 *
 * The eye bones are not driven directly: rotating MMD's 両目 control bone
 * propagates to 左目/右目 through the grant system (see GrantSolver).
 */
import * as THREE from 'three';
import type { BoneMap, IdleConfig } from '../config/types';
import type { PmxModel } from '../loaders/pmxTypes';
import type { PoseBuffer } from './PoseBuffer';
import { fbm } from './noise';

export type GazeMode =
  /** Hold eye contact with the viewer. */
  | 'user'
  /** Drift around the scene, glancing back occasionally. */
  | 'wander'
  /** Deliberately look away, e.g. while thinking. */
  | 'away'
  /** Look at an explicit world-space point. */
  | 'point';

/** Angular limits in radians. Beyond these the look reads as unnatural. */
const LIMITS = {
  eyeYaw: THREE.MathUtils.degToRad(24),
  eyePitch: THREE.MathUtils.degToRad(14),
  headYaw: THREE.MathUtils.degToRad(34),
  headPitch: THREE.MathUtils.degToRad(20),
};

export class GazeController {
  private mode: GazeMode = 'user';
  /** Desired look point in world space. */
  private readonly target = new THREE.Vector3();
  /** Extra offset applied while wandering or looking away. */
  private readonly wanderOffset = new THREE.Vector3();
  private readonly wanderTarget = new THREE.Vector3();
  private wanderTimer = 0;
  private wanderNext = 0;

  /** Smoothed angles. Eyes and head are tracked separately on purpose. */
  private eyeYaw = 0;
  private eyePitch = 0;
  private headYaw = 0;
  private headPitch = 0;

  private saccadeTimer = 0;
  private saccadeNext = 0;
  private readonly saccade = new THREE.Vector2();
  private readonly saccadeTargetVec = new THREE.Vector2();

  private time = 0;
  private emotion = 'idle';
  private emotionTime = 0;
  private readonly emotionOffset = new THREE.Vector3();
  /** Set when a large re-fixation should trigger a blink. */
  private blinkRequested = false;

  private readonly _headWorld = new THREE.Vector3();
  private readonly _targetLocal = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _euler = new THREE.Euler();
  private readonly _quat = new THREE.Quaternion();

  constructor(
    private readonly model: PmxModel,
    private readonly bones: BoneMap,
    private readonly idle: IdleConfig
  ) {
    this.scheduleSaccade();
    this.scheduleWander();
  }

  setMode(mode: GazeMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.wanderTimer = this.wanderNext; // re-pick a destination immediately
  }

  get currentMode(): GazeMode {
    return this.mode;
  }

  /** Select the eye-acting pattern that belongs to the current emotion. */
  setEmotion(emotion: string): void {
    if (emotion === this.emotion) return;
    this.emotion = emotion;
    this.emotionTime = 0;
  }

  /** Look at an explicit world point and switch to 'point' mode. */
  lookAt(point: THREE.Vector3): void {
    this.target.copy(point);
    this.mode = 'point';
  }

  /** Consume a pending blink request raised by a large gaze shift. */
  consumeBlinkRequest(): boolean {
    const requested = this.blinkRequested;
    this.blinkRequested = false;
    return requested;
  }

  private scheduleSaccade(): void {
    this.saccadeTimer = 0;
    this.saccadeNext = THREE.MathUtils.randFloat(
      this.idle.saccadeIntervalMin,
      this.idle.saccadeIntervalMax
    );
  }

  private scheduleWander(): void {
    this.wanderTimer = 0;
    this.wanderNext = THREE.MathUtils.randFloat(2.5, 6.5);
  }

  /**
   * Advance gaze and write head, neck and eye rotations into `pose`.
   * `viewer` is the camera position, which is what 'user' mode looks at.
   */
  update(delta: number, pose: PoseBuffer, viewer: THREE.Vector3): void {
    this.time += delta;
    this.emotionTime += delta;

    // ---- choose a look point -------------------------------------------
    this.wanderTimer += delta;
    if (this.wanderTimer >= this.wanderNext) {
      this.scheduleWander();
      const spread = this.mode === 'away' ? 1 : 0.55;
      this.wanderTarget.set(
        THREE.MathUtils.randFloatSpread(14 * spread),
        THREE.MathUtils.randFloatSpread(7 * spread),
        THREE.MathUtils.randFloatSpread(6)
      );
      // A big change of fixation usually comes with a blink.
      if (this.wanderTarget.distanceTo(this.wanderOffset) > 4) this.blinkRequested = true;
    }
    // Ease toward the chosen wander destination rather than snapping.
    this.wanderOffset.lerp(this.wanderTarget, 1 - Math.exp(-2.2 * delta));

    const head = this.model.bones[this.model.boneIndexByName.get(this.bones.head) ?? -1];
    if (!head) return;
    head.getWorldPosition(this._headWorld);

    switch (this.mode) {
      case 'user':
        this.target.copy(viewer);
        break;
      case 'wander':
        this.target.copy(viewer).add(this.wanderOffset);
        break;
      case 'away':
        // Alternate shoulders over time instead of staring in one fixed
        // direction. The vertical offset keeps shy/thoughtful looks lowered.
        this.target.copy(viewer).add(this.wanderOffset);
        this.target.x += Math.sin(this.time * 0.38) * 6;
        this.target.y +=
          (this.emotion === 'thinking' ? 0.4 : -2.1) +
          Math.sin(this.time * 0.71) * 0.35;
        break;
      case 'point':
        break;
    }

    // Explicit emotions have their own changing fixation pattern. Mouse eye
    // tracking uses point mode and deliberately bypasses this art direction.
    if (this.mode !== 'point') {
      this.applyEmotionOffset();
      this.target.add(this.emotionOffset);
    }

    // ---- convert to yaw / pitch in model space --------------------------
    // Work in model space so yaw/pitch are independent of where the model
    // sits in the world.
    this._targetLocal.copy(this.target);
    this.model.mesh.worldToLocal(this._targetLocal);
    this._dir.subVectors(this._targetLocal, this.modelSpaceHeadPosition(head));

    const length = this._dir.length();
    if (length < 1e-4) return;
    this._dir.divideScalar(length);

    // The character faces +Z after the handedness conversion.
    const yaw = Math.atan2(this._dir.x, this._dir.z);
    const pitch = -Math.asin(THREE.MathUtils.clamp(this._dir.y, -1, 1));

    // ---- saccades --------------------------------------------------------
    this.saccadeTimer += delta;
    if (this.saccadeTimer >= this.saccadeNext) {
      this.scheduleSaccade();
      this.saccadeTargetVec.set(
        THREE.MathUtils.randFloatSpread(THREE.MathUtils.degToRad(6)),
        THREE.MathUtils.randFloatSpread(THREE.MathUtils.degToRad(3))
      );
    }
    // Saccades snap quickly; that abruptness is the point.
    this.saccade.lerp(this.saccadeTargetVec, 1 - Math.exp(-18 * delta));
    // A slow drift underneath keeps the eyes from ever being perfectly still.
    const drift = fbm(this.time * 0.35) * THREE.MathUtils.degToRad(1.4);

    // ---- eyes lead, head follows ----------------------------------------
    const eyeBlend = 1 - Math.exp(-14 * delta);
    const headBlend = 1 - Math.exp(-3.2 * delta);

    this.eyeYaw = THREE.MathUtils.lerp(
      this.eyeYaw,
      THREE.MathUtils.clamp(yaw + this.saccade.x + drift, -LIMITS.eyeYaw, LIMITS.eyeYaw),
      eyeBlend
    );
    this.eyePitch = THREE.MathUtils.lerp(
      this.eyePitch,
      THREE.MathUtils.clamp(pitch + this.saccade.y, -LIMITS.eyePitch, LIMITS.eyePitch),
      eyeBlend
    );
    // The head only takes up part of the angle; the eyes cover the rest.
    this.headYaw = THREE.MathUtils.lerp(
      this.headYaw,
      THREE.MathUtils.clamp(yaw * 0.55, -LIMITS.headYaw, LIMITS.headYaw),
      headBlend
    );
    this.headPitch = THREE.MathUtils.lerp(
      this.headPitch,
      THREE.MathUtils.clamp(pitch * 0.45, -LIMITS.headPitch, LIMITS.headPitch),
      headBlend
    );

    // ---- write to the pose ----------------------------------------------
    // Neck carries part of the head turn so the motion runs through the
    // spine instead of pivoting at a single joint.
    this._euler.set(this.headPitch * 0.35, this.headYaw * 0.4, 0, 'YXZ');
    pose.addQuaternion(this.bones.neck, this._quat.setFromEuler(this._euler));

    this._euler.set(this.headPitch * 0.65, this.headYaw * 0.6, 0, 'YXZ');
    pose.addQuaternion(this.bones.head, this._quat.setFromEuler(this._euler));

    this._euler.set(this.eyePitch, this.eyeYaw, 0, 'YXZ');
    pose.addQuaternion(this.bones.eyes, this._quat.setFromEuler(this._euler));
  }

  private applyEmotionOffset(): void {
    const t = this.emotionTime;
    this.emotionOffset.set(0, 0, 0);

    switch (this.emotion) {
      case 'embarrassed':
        this.emotionOffset.set(
          Math.sin(t * 0.72) * 2.6,
          -2.2 + Math.sin(t * 1.1) * 0.35,
          0
        );
        break;
      case 'thinking':
        this.emotionOffset.set(Math.sin(t * 0.34) * 3.2, 0.75, 0);
        break;
      case 'sad':
        this.emotionOffset.set(Math.sin(t * 0.36) * 0.9, -1.5, 0);
        break;
      case 'curious':
        this.emotionOffset.set(Math.sin(t * 0.58) * 1.8, 0.75, 0);
        break;
      case 'confused':
        this.emotionOffset.set(
          Math.sin(t * 0.82) * 2.1,
          Math.sin(t * 0.57) * 0.3,
          0
        );
        break;
      case 'playful':
        this.emotionOffset.set(Math.sin(t * 1.35) * 1.6, 0.45, 0);
        break;
      case 'excited':
        this.emotionOffset.set(
          Math.sin(t * 1.2) * 1.2,
          0.4 + Math.sin(t * 1.8) * 0.2,
          0
        );
        break;
      case 'happy':
      case 'proud':
        this.emotionOffset.set(Math.sin(t * 0.55) * 0.65, 0.2, 0);
        break;
      default:
        break;
    }
  }

  /** Head rest position in model space (bones store absolute rest positions). */
  private modelSpaceHeadPosition(head: THREE.Bone): THREE.Vector3 {
    const index = this.model.boneIndexByName.get(this.bones.head);
    const info = index !== undefined ? this.model.boneInfos[index] : undefined;
    return info ? info.position : head.position;
  }
}
