/**
 * Facial animation: expression blending, blinking, and viseme application.
 *
 * Everything here writes into the shared `MorphController` accumulator, so the
 * face is composed additively from independent sources each frame rather than
 * any one system owning it:
 *
 *   expression  - slow, smoothly cross-faded emotional base
 *   blink       - fast, procedural, on its own random schedule
 *   lip sync    - mouth only, and only while speaking
 *   behaviours  - transient overlays pushed in by the behaviour director
 *
 * The one place these genuinely conflict is the mouth, so expressions yield
 * mouth authority to lip sync while the character is talking instead of the
 * two fighting for the same morphs.
 */
import * as THREE from 'three';
import type { IdleConfig, MorphMap } from '../config/types';
import {
  EXPRESSIONS,
  MOUTH_SLOTS,
  expressionForEmotion,
  type ExpressionName,
  type ExpressionShape,
} from './ExpressionLibrary';
import type { MorphController } from './MorphController';
import type { VisemeWeights } from './LipSync';

/** Blink phase timings in seconds. A real blink is fast down, slower up. */
const BLINK_CLOSE = 0.055;
const BLINK_HOLD = 0.032;
const BLINK_OPEN = 0.115;
const BLINK_TOTAL = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;

export interface FaceUpdateContext {
  delta: number;
  visemes: VisemeWeights;
  /** 0..1 - how much the lip-sync engine should own the mouth. */
  speechAuthority: number;
  /** Transient overlay pushed by the behaviour director. */
  overlay?: ExpressionShape;
  overlayWeight?: number;
}

export class FaceController {
  /** Currently displayed expression weights, per semantic slot. */
  private readonly currentShape = new Map<keyof MorphMap, number>();
  private targetShape: ExpressionShape = EXPRESSIONS.neutral;
  private targetName: ExpressionName = 'neutral';
  /** Time since the current emotional performance began. */
  private expressionTime = 0;
  /** Seconds to cross-fade into the target expression. */
  private blendDuration = 0.45;

  private blinkTimer = 0;
  private blinkNext = 0;
  private blinkPhase = -1;
  private pendingDoubleBlink = false;
  /** Externally forced blink weight, used by behaviours like a wink. */
  private blinkOverride: { left: number; right: number } | null = null;

  constructor(
    private readonly morphs: MorphController,
    private readonly morphMap: MorphMap,
    private readonly idleConfig: IdleConfig
  ) {
    this.scheduleBlink();
    for (const [slot, weight] of Object.entries(EXPRESSIONS.neutral)) {
      this.currentShape.set(slot as keyof MorphMap, weight as number);
    }
  }

  /** Request an expression. Ignored if it is already the target. */
  setExpression(name: ExpressionName | string, blendDuration = 0.45): void {
    const resolved = expressionForEmotion(name);
    if (resolved === this.targetName) return;
    this.targetName = resolved;
    this.targetShape = EXPRESSIONS[resolved];
    this.expressionTime = 0;
    this.blendDuration = Math.max(0.01, blendDuration);
  }

  get expression(): ExpressionName {
    return this.targetName;
  }

  /** Force a blink now (used by behaviours). */
  triggerBlink(): void {
    if (this.blinkPhase < 0) {
      this.blinkPhase = 0;
      this.blinkTimer = 0;
    }
  }

  /** Hold one or both eyes closed, e.g. for a wink. Pass null to release. */
  setBlinkOverride(override: { left: number; right: number } | null): void {
    this.blinkOverride = override;
  }

  private scheduleBlink(): void {
    const { blinkIntervalMin, blinkIntervalMax } = this.idleConfig;
    this.blinkNext = THREE.MathUtils.randFloat(blinkIntervalMin, blinkIntervalMax);
    this.blinkTimer = 0;
    this.blinkPhase = -1;
  }

  /** Advance the blink state machine and return its 0..1 closure amount. */
  private updateBlink(delta: number): number {
    if (this.blinkPhase < 0) {
      this.blinkTimer += delta;
      if (this.blinkTimer >= this.blinkNext) {
        this.blinkPhase = 0;
        this.blinkTimer = 0;
        // Humans often blink twice in quick succession.
        this.pendingDoubleBlink = Math.random() < this.idleConfig.doubleBlinkChance;
      }
      return 0;
    }

    this.blinkPhase += delta;
    const t = this.blinkPhase;

    if (t >= BLINK_TOTAL) {
      if (this.pendingDoubleBlink) {
        this.pendingDoubleBlink = false;
        this.blinkPhase = 0;
        return 0;
      }
      this.scheduleBlink();
      return 0;
    }

    if (t < BLINK_CLOSE) return THREE.MathUtils.smoothstep(t / BLINK_CLOSE, 0, 1);
    if (t < BLINK_CLOSE + BLINK_HOLD) return 1;
    return 1 - THREE.MathUtils.smoothstep((t - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN, 0, 1);
  }

  update(ctx: FaceUpdateContext): void {
    const { delta, visemes, speechAuthority } = ctx;
    this.expressionTime += delta;

    // ---- expression cross-fade -----------------------------------------
    const blend = 1 - Math.exp(-(delta / this.blendDuration) * 3);
    const slots = new Set<keyof MorphMap>([
      ...this.currentShape.keys(),
      ...(Object.keys(this.targetShape) as (keyof MorphMap)[]),
    ]);
    for (const slot of slots) {
      const from = this.currentShape.get(slot) ?? 0;
      const to = this.targetShape[slot] ?? 0;
      const next = THREE.MathUtils.lerp(from, to, blend);
      if (next < 1e-4 && to === 0) this.currentShape.delete(slot);
      else this.currentShape.set(slot, next);
    }

    // ---- emit expression -------------------------------------------------
    const mouthAuthority = 1 - THREE.MathUtils.clamp(speechAuthority, 0, 1);
    for (const [slot, weight] of this.currentShape) {
      const scaled = MOUTH_SLOTS.has(slot) ? weight * mouthAuthority : weight;
      this.morphs.add(this.morphMap[slot], scaled);
    }

    // Small secondary beats stop a held expression from becoming a frozen
    // mask. They are intentionally strongest in brows and lids; the underlying
    // expression still owns the face.
    this.emitExpressionMotion(mouthAuthority);

    // ---- behaviour overlay ----------------------------------------------
    if (ctx.overlay && (ctx.overlayWeight ?? 0) > 0) {
      const w = ctx.overlayWeight!;
      for (const [slot, weight] of Object.entries(ctx.overlay) as [keyof MorphMap, number][]) {
        const scaled = MOUTH_SLOTS.has(slot) ? weight * mouthAuthority : weight;
        this.morphs.add(this.morphMap[slot], scaled * w);
      }
    }

    // ---- blink ------------------------------------------------------------
    const blinkAmount = this.updateBlink(delta);
    if (this.blinkOverride) {
      // An explicit wink replaces the automatic blink entirely.
      this.morphs.add(this.morphMap.blinkL, this.blinkOverride.left);
      this.morphs.add(this.morphMap.blinkR, this.blinkOverride.right);
    } else if (blinkAmount > 0) {
      // A closed-arc smile already shuts the eyes, so a full blink on top
      // would double up and look wrong. Scale it back instead.
      const smileEyes = this.currentShape.get('smileEyes') ?? 0;
      this.morphs.add(this.morphMap.blink, blinkAmount * (1 - smileEyes * 0.75));
    }

    // ---- visemes ----------------------------------------------------------
    if (speechAuthority > 0) {
      const s = speechAuthority;
      this.morphs.add(this.morphMap.visemeA, visemes.a * s);
      this.morphs.add(this.morphMap.visemeI, visemes.i * s);
      this.morphs.add(this.morphMap.visemeU, visemes.u * s);
      this.morphs.add(this.morphMap.visemeE, visemes.e * s);
      this.morphs.add(this.morphMap.visemeO, visemes.o * s);
      this.morphs.add(this.morphMap.visemeTalk, visemes.talk * s);
      // Teeth follow the jaw so an open mouth is not a black hole.
      this.morphs.add(this.morphMap.teethUp, visemes.openness * 0.35 * s);
    }
  }

  /** Subtle, expression-specific eyebrow/lid motion plus a short arrival beat. */
  private emitExpressionMotion(mouthAuthority: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(this.expressionTime * 1.7);
    const arrival =
      Math.exp(-this.expressionTime * 1.7) *
      Math.sin(Math.min(1, this.expressionTime / 0.42) * Math.PI);
    const add = (slot: keyof MorphMap, amount: number) => {
      const scaled = MOUTH_SLOTS.has(slot) ? amount * mouthAuthority : amount;
      this.morphs.add(this.morphMap[slot], scaled);
    };

    switch (this.targetName) {
      case 'happy':
        add('browUp', 0.035 * pulse + 0.08 * arrival);
        add('lowerLidUp', 0.025 * pulse);
        break;
      case 'excited':
        add('browUp', 0.05 * pulse + 0.12 * arrival);
        add('eyesWideL', 0.04 * pulse);
        add('eyesWideR', 0.04 * pulse);
        break;
      case 'curious':
        add('browAngryR', 0.07 * pulse + 0.1 * arrival);
        break;
      case 'thinking':
        add('browTroubled', 0.06 * pulse + 0.08 * arrival);
        break;
      case 'proud':
        add('browSerious', 0.045 * pulse);
        add('mouthCornerUpL', 0.035 * pulse);
        break;
      case 'sad':
        add('browSad', 0.055 * pulse + 0.1 * arrival);
        break;
      case 'confused':
        add('browAngryR', 0.08 * pulse + 0.12 * arrival);
        add('browTroubled', 0.04 * pulse);
        break;
      case 'surprised':
        add('browUp', 0.06 * pulse + 0.18 * arrival);
        add('eyesWideL', 0.1 * arrival);
        add('eyesWideR', 0.1 * arrival);
        break;
      case 'embarrassed':
        add('browTroubled', 0.08 * pulse + 0.18 * arrival);
        add('browSad', 0.05 * pulse);
        add('eyesHalf', 0.045 * pulse);
        break;
      case 'playful':
        add('browAngryR', 0.08 * pulse);
        add('mouthCornerUpL', 0.05 * pulse);
        break;
      default:
        break;
    }
  }
}
