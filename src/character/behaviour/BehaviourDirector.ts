/**
 * Random behaviour scheduler.
 *
 * Picks spontaneous behaviours on a randomised interval so the character keeps
 * doing things on her own. Three rules keep it from feeling mechanical:
 *
 *   - intervals are random within a configured range, never fixed,
 *   - a behaviour cannot repeat until N others have played, so you don't see
 *     the same wave twice in a row,
 *   - selection is weighted and filtered by what she is currently doing, so
 *     she won't stretch mid-sentence or wave while thinking.
 *
 * Every behaviour is wrapped in a blend envelope that ramps its influence up
 * from zero and back down to zero. That envelope is the guarantee behind the
 * "no snapping" requirement: nothing a behaviour does is ever applied at full
 * strength instantaneously, and an interrupted behaviour releases smoothly
 * instead of being cut.
 */
import * as THREE from 'three';
import type { BehaviourConfig, BoneMap } from '../config/types';
import type { ExpressionShape } from '../face/ExpressionLibrary';
import type { PoseBuffer } from '../animation/PoseBuffer';
import type { GazeMode } from '../animation/GazeController';
import { BEHAVIOURS, type Behaviour, type CharacterActivity } from './behaviours';
import { easeInOut } from '../animation/noise';

interface ActiveBehaviour {
  behaviour: Behaviour;
  elapsed: number;
  /** Current blend weight, 0..1. */
  weight: number;
  /** Set when the behaviour is being cut short and should fade out now. */
  releasing: boolean;
}

export interface BehaviourUpdateContext {
  delta: number;
  activity: CharacterActivity;
  pose: PoseBuffer;
  bones: BoneMap;
}

export class BehaviourDirector {
  private active: ActiveBehaviour | null = null;
  private timer = 0;
  private next = 0;
  /** Names of recently played behaviours, most recent last. */
  private readonly recent: string[] = [];
  private blinkRequested = false;
  private enabled = true;

  constructor(
    private config: BehaviourConfig,
    private readonly library: Behaviour[] = BEHAVIOURS
  ) {
    this.schedule('idle');
  }

  setConfig(config: BehaviourConfig): void {
    this.config = config;
  }

  /** Ease out whatever is playing (a new activity takes over). */
  cancel(): void {
    if (this.active) this.active.releasing = true;
  }

  /** When false, nothing is picked at random; triggered behaviours still play. */
  setAutoPick(enabled: boolean): void {
    this.autoPick = enabled;
  }
  private autoPick = true;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.active) this.active.releasing = true;
  }

  /** Currently playing behaviour name, for diagnostics. */
  get currentName(): string | null {
    return this.active?.behaviour.name ?? null;
  }

  private schedule(activity: CharacterActivity): void {
    this.timer = 0;
    // Behaviours become rarer while she is busy speaking or thinking, so they
    // punctuate rather than compete with what she is doing.
    const scale = activity === 'idle' ? 1 : this.config.busyIntervalScale;
    this.next =
      THREE.MathUtils.randFloat(this.config.intervalMin, this.config.intervalMax) * scale;
  }

  /** Weighted random pick, excluding recently played behaviours. */
  private pick(activity: CharacterActivity): Behaviour | null {
    const candidates = this.library.filter((b) => {
      const allowed = b.allowedIn ?? ['idle'];
      if (!allowed.includes(activity)) return false;
      return !this.recent.includes(b.name);
    });

    // If the no-repeat window has excluded everything, fall back to any
    // behaviour valid for this activity rather than doing nothing.
    const pool =
      candidates.length > 0
        ? candidates
        : this.library.filter((b) => (b.allowedIn ?? ['idle']).includes(activity));

    if (pool.length === 0) return null;

    const total = pool.reduce((sum, b) => sum + b.weight, 0);
    let roll = Math.random() * total;
    for (const b of pool) {
      roll -= b.weight;
      if (roll <= 0) return b;
    }
    return pool[pool.length - 1];
  }

  /** Start a behaviour by name immediately, interrupting any current one. */
  trigger(name: string): boolean {
    const behaviour = this.library.find((b) => b.name === name);
    if (!behaviour) return false;
    this.begin(behaviour);
    return true;
  }

  private begin(behaviour: Behaviour): void {
    this.active = { behaviour, elapsed: 0, weight: 0, releasing: false };
    if (behaviour.blinkOnStart) this.blinkRequested = true;

    this.recent.push(behaviour.name);
    while (this.recent.length > this.config.noRepeatWindow) this.recent.shift();
  }

  /** Fade lengths, capped so short behaviours still fully express. */
  private static envelope(behaviour: Behaviour, elapsed: number, releasing: boolean): number {
    const fade = Math.min(0.45, behaviour.duration * 0.25);
    if (releasing) return 0; // handled by the caller's decay
    const inWeight = fade > 0 ? easeInOut(elapsed / fade) : 1;
    const remaining = behaviour.duration - elapsed;
    const outWeight = fade > 0 ? easeInOut(remaining / fade) : 1;
    return Math.min(inWeight, outWeight, 1);
  }

  update(ctx: BehaviourUpdateContext): void {
    const { delta, activity, pose, bones } = ctx;

    if (this.active) {
      const state = this.active;
      state.elapsed += delta;

      if (state.releasing) {
        // Smooth decay when interrupted, rather than a hard stop.
        state.weight = Math.max(0, state.weight - delta * 3);
        if (state.weight <= 0.001) {
          this.active = null;
          this.schedule(activity);
        }
      } else {
        // An activity change can invalidate the behaviour mid-play.
        const allowed = state.behaviour.allowedIn ?? ['idle'];
        if (!allowed.includes(activity) || !this.enabled) {
          state.releasing = true;
        } else if (state.elapsed >= state.behaviour.duration) {
          state.releasing = true;
        } else {
          state.weight = BehaviourDirector.envelope(state.behaviour, state.elapsed, false);
        }
      }

      if (this.active && state.weight > 0) {
        const t = THREE.MathUtils.clamp(state.elapsed / state.behaviour.duration, 0, 1);
        state.behaviour.pose?.(t, state.weight, pose, bones);
      }
      return;
    }

    if (!this.enabled || !this.autoPick) return;

    this.timer += delta;
    if (this.timer >= this.next) {
      const behaviour = this.pick(activity);
      if (behaviour) this.begin(behaviour);
      else this.schedule(activity);
    }
  }

  /** Facial overlay for the active behaviour, if any. */
  get overlay(): ExpressionShape | undefined {
    return this.active?.behaviour.expression;
  }

  get overlayWeight(): number {
    return this.active?.weight ?? 0;
  }

  /** Gaze mode requested by the active behaviour. */
  get gazeOverride(): GazeMode | undefined {
    // Only honour the gaze while the behaviour is meaningfully present, so
    // gaze doesn't flick back and forth at the edges of the envelope.
    if (this.active && this.active.weight > 0.25) return this.active.behaviour.gaze;
    return undefined;
  }

  /** Idle-motion scale requested by the active behaviour. */
  get idleIntensity(): number {
    if (!this.active) return 1;
    const target = this.active.behaviour.idleIntensity ?? 1;
    return THREE.MathUtils.lerp(1, target, this.active.weight);
  }

  /** Consume a one-shot blink request raised when a behaviour started. */
  consumeBlinkRequest(): boolean {
    const requested = this.blinkRequested;
    this.blinkRequested = false;
    return requested;
  }
}
