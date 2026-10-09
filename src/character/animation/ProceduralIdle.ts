/**
 * Procedural idle motion.
 *
 * The character must never be still, but she also must never look like she is
 * playing a loop. Rather than authoring idle clips, this composes four
 * independent, non-commensurate motion sources so the combined result never
 * repeats:
 *
 *   breathing      - asymmetric respiratory curve through the spine
 *   weight sway    - slow lateral shift of the hips, as when standing
 *   posture shifts - occasional deliberate re-settles, eased in and out
 *   micro-motion   - low-amplitude fractal noise on the head and shoulders
 *
 * Amplitudes are expressed in radians (rotation) and model units (translation)
 * and are scaled by the character's `IdleConfig`, so the same code produces
 * appropriately-sized motion on a differently-proportioned model.
 */
import * as THREE from 'three';
import type { BoneMap, IdleConfig } from '../config/types';
import type { PoseBuffer } from './PoseBuffer';
import { breathCurve, easeInOut, fbm } from './noise';

/** Base amplitudes, before IdleConfig scaling. Radians unless noted. */
const AMP = {
  breathChest: 0.0135,
  breathUpperChest: 0.009,
  breathNeckCounter: 0.0055,
  breathShoulder: 0.011,
  /** Model units. */
  breathRise: 0.035,

  swayHipRoll: 0.019,
  swayHipYaw: 0.011,
  /** Model units. */
  swayLateral: 0.09,
  swayChestCounter: 0.012,

  postureHipRoll: 0.028,
  postureChestRoll: 0.017,
  postureHeadRoll: 0.021,
  /** Model units. */
  postureLateral: 0.11,

  microHead: 0.016,
  microShoulder: 0.008,
};

interface PostureShift {
  /** Current eased strength, 0..1. */
  weight: number;
  /** Direction and character of this particular shift. */
  roll: number;
  yaw: number;
  lateral: number;
  /** Seconds spent in the shift so far, and its total planned duration. */
  elapsed: number;
  duration: number;
  active: boolean;
}

export class ProceduralIdle {
  private time = 0;
  private breathPhase = 0;
  private postureTimer = 0;
  private postureNext = 0;

  private readonly posture: PostureShift = {
    weight: 0,
    roll: 0,
    yaw: 0,
    lateral: 0,
    elapsed: 0,
    duration: 4,
    active: false,
  };

  /** Scales all idle motion; behaviours dial this down while they play. */
  private intensity = 1;
  private intensityTarget = 1;

  constructor(
    private readonly bones: BoneMap,
    private config: IdleConfig
  ) {
    this.scheduleposture();
  }

  setConfig(config: IdleConfig): void {
    this.config = config;
  }

  /** Fade idle motion down (0) or back up (1), e.g. during a big gesture. */
  setIntensity(target: number): void {
    this.intensityTarget = THREE.MathUtils.clamp(target, 0, 1);
  }

  /** Current breathing phase 0..1, so other systems can sync to the breath. */
  get breath(): number {
    return breathCurve(this.breathPhase);
  }

  private scheduleposture(): void {
    this.postureTimer = 0;
    this.postureNext = THREE.MathUtils.randFloat(
      this.config.postureIntervalMin,
      this.config.postureIntervalMax
    );
  }

  private updatePosture(delta: number): void {
    if (!this.posture.active) {
      this.postureTimer += delta;
      if (this.postureTimer >= this.postureNext) {
        this.posture.active = true;
        this.posture.elapsed = 0;
        this.posture.duration = THREE.MathUtils.randFloat(3.5, 8);
        // Sign is random so she does not always settle the same way.
        const dir = Math.random() < 0.5 ? -1 : 1;
        this.posture.roll = dir * THREE.MathUtils.randFloat(0.5, 1);
        this.posture.yaw = dir * THREE.MathUtils.randFloat(0.2, 0.8);
        this.posture.lateral = dir * THREE.MathUtils.randFloat(0.4, 1);
      }
      return;
    }

    this.posture.elapsed += delta;
    const t = this.posture.elapsed / this.posture.duration;

    if (t >= 1) {
      this.posture.active = false;
      this.posture.weight = 0;
      this.scheduleposture();
      return;
    }

    // Ease in over the first third, hold, ease out over the last third, so
    // the shift arrives and leaves without any visible snap.
    if (t < 0.33) this.posture.weight = easeInOut(t / 0.33);
    else if (t > 0.67) this.posture.weight = easeInOut((1 - t) / 0.33);
    else this.posture.weight = 1;
  }

  /** Advance idle motion and write it into `pose`. */
  update(delta: number, pose: PoseBuffer): void {
    this.time += delta;
    this.intensity = THREE.MathUtils.lerp(
      this.intensity,
      this.intensityTarget,
      1 - Math.exp(-4 * delta)
    );

    const k = this.intensity;
    const b = this.config.breathDepth * k;
    const s = this.config.swayAmount * k;

    // ---- breathing --------------------------------------------------------
    this.breathPhase += delta * this.config.breathRate;
    const breath = breathCurve(this.breathPhase);
    // Centre the curve so the rest pose sits mid-breath, not at full exhale.
    const breathCentred = breath - 0.5;

    pose.addEuler(this.bones.upperBody, -breathCentred * AMP.breathChest * b, 0, 0);
    pose.addEuler(this.bones.upperBody2, breathCentred * AMP.breathUpperChest * b, 0, 0);
    // Counter-rotate the neck so the head stays level while the chest moves.
    pose.addEuler(this.bones.neck, -breathCentred * AMP.breathNeckCounter * b, 0, 0);
    pose.addTranslation(this.bones.center, 0, breathCentred * AMP.breathRise * b, 0);

    // Shoulders rise and fall slightly out of phase with the chest.
    const shoulderBreath = breathCurve(this.breathPhase - 0.08) - 0.5;
    pose.addEuler(this.bones.shoulderL, 0, 0, -shoulderBreath * AMP.breathShoulder * b);
    pose.addEuler(this.bones.shoulderR, 0, 0, shoulderBreath * AMP.breathShoulder * b);

    // ---- weight sway ------------------------------------------------------
    // Two incommensurable frequencies, so the lateral drift never loops.
    const swayT = this.time * this.config.swayRate;
    const sway = Math.sin(swayT * Math.PI * 2) * 0.6 + fbm(swayT * 1.7) * 0.4;
    const swaySlow = fbm(swayT * 0.6 + 31.7);

    pose.addTranslation(this.bones.center, sway * AMP.swayLateral * s, 0, 0);
    pose.addEuler(this.bones.waist, 0, swaySlow * AMP.swayHipYaw * s, sway * AMP.swayHipRoll * s);
    // The chest counter-rotates against the hips, as a real body does when
    // shifting weight - this is what stops it looking like a rigid statue.
    pose.addEuler(this.bones.upperBody, 0, 0, -sway * AMP.swayChestCounter * s);

    // ---- posture shifts ---------------------------------------------------
    this.updatePosture(delta);
    if (this.posture.weight > 0) {
      const w = this.posture.weight * k;
      pose.addTranslation(this.bones.center, this.posture.lateral * AMP.postureLateral * w, 0, 0);
      pose.addEuler(
        this.bones.waist,
        0,
        this.posture.yaw * AMP.postureHipRoll * 0.5 * w,
        this.posture.roll * AMP.postureHipRoll * w
      );
      pose.addEuler(this.bones.upperBody2, 0, 0, -this.posture.roll * AMP.postureChestRoll * w);
      pose.addEuler(this.bones.head, 0, 0, -this.posture.roll * AMP.postureHeadRoll * w);
    }

    // ---- micro-motion -----------------------------------------------------
    // Tiny fractal drift so no joint is ever perfectly frozen.
    pose.addEuler(
      this.bones.head,
      fbm(this.time * 0.31 + 11.3) * AMP.microHead * k,
      fbm(this.time * 0.27 + 4.1) * AMP.microHead * k,
      fbm(this.time * 0.23 + 71.9) * AMP.microHead * 0.6 * k
    );
    pose.addEuler(this.bones.shoulderL, 0, 0, fbm(this.time * 0.19 + 5.5) * AMP.microShoulder * k);
    pose.addEuler(this.bones.shoulderR, 0, 0, fbm(this.time * 0.21 + 47.2) * AMP.microShoulder * k);
  }
}
