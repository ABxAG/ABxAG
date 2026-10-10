/**
 * CharacterActions — one-shot body performances (jump, wave, bow, spin, nod,
 * shake-head, shrug, dance, stretch).
 *
 * Each action is a time-keyed overlay written into the PoseBuffer every frame
 * plus optional root motion (hop height, spin yaw). Rotation signs follow the
 * conventions in behaviour/behaviours.ts (right arm up = armR z −2.45, …),
 * and every write degrades silently when a bone is absent, so odd rigs and
 * generic models simply do a smaller version instead of crashing.
 *
 * One action runs at a time; performing a new one replaces the running one.
 * Mounted by CharacterSystem between behaviours and the pose-layer loop, so
 * idle breathing and gaze continue underneath.
 */
import type { BoneMap } from '../config/types';
import type { PoseBuffer } from './PoseBuffer';
import { easeInOut } from './noise';

export type CharacterActionName =
  | 'jump'
  | 'wave'
  | 'bow'
  | 'spin'
  | 'nod'
  | 'shake_head'
  | 'shrug'
  | 'dance'
  | 'stretch'
  | 'backflip';

export const CHARACTER_ACTIONS: readonly CharacterActionName[] = [
  'jump', 'wave', 'bow', 'spin', 'nod', 'shake_head', 'shrug', 'dance', 'stretch', 'backflip',
];

/** Words users actually say, mapped to actions (checked server-side too). */
export function normalizeActionName(raw: string): CharacterActionName | null {
  const k = raw.toLowerCase().trim().replace(/[\s-]+/g, '_');
  const aliases: Record<string, CharacterActionName> = {
    jump: 'jump', hop: 'jump', leap: 'jump', laaf: 'jump',
    wave: 'wave', hi: 'wave', hello: 'wave',
    bow: 'bow', greet: 'bow',
    spin: 'spin', twirl: 'spin', turn: 'spin',
    nod: 'nod', yes: 'nod',
    shake_head: 'shake_head', no: 'shake_head',
    shrug: 'shrug',
    dance: 'dance',
    stretch: 'stretch',
    backflip: 'backflip', flip: 'backflip', somersault: 'backflip',
  };
  if ((CHARACTER_ACTIONS as readonly string[]).includes(k)) return k as CharacterActionName;
  return aliases[k] ?? null;
}

export interface ActionRoot {
  /** Additive hop height in model units (restored automatically). */
  y: number;
  /** Additive yaw in radians (restored automatically). */
  yaw: number;
  /** Additive pitch in radians — backward flips (restored automatically). */
  pitch: number;
}

interface ActionDef {
  duration: number;
  update: (t: number, pose: PoseBuffer, bones: BoneMap, root: ActionRoot) => void;
}

/** 0..1 progress shaped as attack → hold → release. */
function envelope(t: number, attack = 0.25, release = 0.75): number {
  if (t < attack) return easeInOut(t / attack);
  if (t > release) return easeInOut((1 - t) / (1 - release));
  return 1;
}

const ACTIONS: Record<CharacterActionName, ActionDef> = {
  jump: {
    duration: 1.0,
    update: (t, pose, bones, root) => {
      // Crouch (0–0.3), launch + airborne (0.3–0.65), land + settle.
      const crouch = t < 0.3 ? easeInOut(t / 0.3) : t < 0.65 ? 1 - easeInOut((t - 0.3) / 0.35) : 0;
      const air = t < 0.3 ? 0 : t < 0.65 ? Math.sin(((t - 0.3) / 0.35) * Math.PI) : 0;
      pose.addEuler(bones.legL, crouch * 0.45, 0, 0);
      pose.addEuler(bones.legR, crouch * 0.45, 0, 0);
      pose.addEuler(bones.kneeL, crouch * 0.7, 0, 0);
      pose.addEuler(bones.kneeR, crouch * 0.7, 0, 0);
      pose.addEuler(bones.upperBody, -crouch * 0.25, 0, 0);
      // Arms fly up as she leaves the ground.
      pose.addEuler(bones.armL, 0, -0.35 * air, 2.2 * air);
      pose.addEuler(bones.armR, 0, 0.35 * air, -2.2 * air);
      root.y = air * 2.2 - crouch * 0.5;
    },
  },
  wave: {
    duration: 2.2,
    update: (t, pose, bones) => {
      const e = envelope(t, 0.15, 0.85);
      pose.addEuler(bones.armR, -0.25 * e, 0.55 * e, -2.2 * e);
      pose.addEuler(bones.elbowR, 0, 2.1 * e, -0.15 * e);
      pose.addEuler(bones.wristR, 0, 0, Math.sin(t * Math.PI * 2 * 3.2) * 0.45 * e);
      pose.addEuler(bones.head, 0, Math.sin(t * Math.PI * 2 * 1.1) * 0.06 * e, 0);
    },
  },
  bow: {
    duration: 1.6,
    update: (t, pose, bones) => {
      const e = envelope(t, 0.3, 0.7);
      pose.addEuler(bones.upperBody, -0.75 * e, 0, 0);
      pose.addEuler(bones.upperBody2, -0.5 * e, 0, 0);
      pose.addEuler(bones.head, -0.3 * e, 0, 0);
      pose.addEuler(bones.armL, 0, 0, 0.15 * e);
      pose.addEuler(bones.armR, 0, 0, -0.15 * e);
    },
  },
  spin: {
    duration: 1.3,
    update: (t, pose, bones, root) => {
      const e = easeInOut(Math.min(1, Math.max(0, t)));
      root.yaw = e * Math.PI * 2;
      pose.addEuler(bones.armL, 0, -0.3 * e, 1.1 * e);
      pose.addEuler(bones.armR, 0, 0.3 * e, -1.1 * e);
      pose.addEuler(bones.head, 0, -Math.sin(e * Math.PI * 2) * 0.2, 0);
    },
  },
  nod: {
    duration: 1.0,
    update: (t, pose, bones) => {
      const e = envelope(t, 0.2, 0.8);
      pose.addEuler(bones.head, Math.sin(t * Math.PI * 4) * 0.22 * e, 0, 0);
    },
  },
  shake_head: {
    duration: 1.2,
    update: (t, pose, bones) => {
      const e = envelope(t, 0.2, 0.8);
      pose.addEuler(bones.head, 0, Math.sin(t * Math.PI * 4) * 0.3 * e, 0);
    },
  },
  shrug: {
    duration: 1.2,
    update: (t, pose, bones) => {
      const e = envelope(t, 0.25, 0.7);
      pose.addEuler(bones.shoulderL, -0.35 * e, 0, 0.25 * e);
      pose.addEuler(bones.shoulderR, -0.35 * e, 0, -0.25 * e);
      pose.addEuler(bones.armL, 0, -0.15 * e, 0.55 * e);
      pose.addEuler(bones.armR, 0, 0.15 * e, -0.55 * e);
      pose.addEuler(bones.head, 0, 0, 0.1 * e);
    },
  },
  dance: {
    duration: 4.0,
    update: (t, pose, bones, root) => {
      const e = envelope(t, 0.08, 0.92);
      const beat = t * Math.PI * 2 * 2; // two bounces per second-ish
      root.y = Math.abs(Math.sin(beat)) * 0.55 * e;
      const sway = Math.sin(beat * 0.5);
      pose.addEuler(bones.upperBody, -0.08 * e, sway * 0.12 * e, 0);
      pose.addEuler(bones.head, 0, -sway * 0.15 * e, sway * 0.08 * e);
      const groove = Math.sin(beat);
      pose.addEuler(bones.armL, 0, -0.25 * e, (0.9 + groove * 0.5) * e);
      pose.addEuler(bones.armR, 0, 0.25 * e, (-0.9 + groove * 0.5) * e);
      pose.addEuler(bones.elbowL, 0, -0.5 * e, 0.3 * e);
      pose.addEuler(bones.elbowR, 0, 0.5 * e, -0.3 * e);
    },
  },
  stretch: {
    duration: 2.6,
    update: (t, pose, bones) => {
      const e = envelope(t, 0.3, 0.7);
      pose.addEuler(bones.armL, 0, -0.4 * e, 2.45 * e);
      pose.addEuler(bones.armR, 0, 0.4 * e, -2.45 * e);
      pose.addEuler(bones.elbowL, 0, -0.4 * e, 0.25 * e);
      pose.addEuler(bones.elbowR, 0, 0.4 * e, -0.25 * e);
      pose.addEuler(bones.upperBody, 0.18 * e, 0, 0);
      pose.addEuler(bones.head, 0.15 * e, 0, 0);
    },
  },
  backflip: {
    duration: 1.2,
    update: (t, pose, bones, root) => {
      // डिकबाज़ी: crouch (0–0.25), launch + full backward turn airborne
      // (0.25–0.8), land + settle. Tucked knees, arms sweeping back→in.
      const crouch = t < 0.25 ? easeInOut(t / 0.25) : t < 0.8 ? 1 - easeInOut((t - 0.25) / 0.55) : 0;
      const air = t < 0.25 ? 0 : t < 0.8 ? Math.sin(((t - 0.25) / 0.55) * Math.PI) : 0;
      const turn = t < 0.25 ? 0 : easeInOut(Math.min(1, (t - 0.25) / 0.55));
      pose.addEuler(bones.legL, crouch * 0.6, 0, 0);
      pose.addEuler(bones.legR, crouch * 0.6, 0, 0);
      pose.addEuler(bones.kneeL, (crouch * 0.8 + air * 1.1), 0, 0);
      pose.addEuler(bones.kneeR, (crouch * 0.8 + air * 1.1), 0, 0);
      pose.addEuler(bones.upperBody, -crouch * 0.3 + air * 0.25, 0, 0);
      pose.addEuler(bones.head, air * 0.3, 0, 0);
      pose.addEuler(bones.armL, -air * 1.2, -0.3 * air, 1.4 * air);
      pose.addEuler(bones.armR, -air * 1.2, 0.3 * air, -1.4 * air);
      root.y = air * 2.6 - crouch * 0.5;
      root.pitch = -turn * Math.PI * 2;
    },
  },
};

export class CharacterActions {
  private current: { name: CharacterActionName; elapsed: number; duration: number } | null = null;
  readonly root: ActionRoot = { y: 0, yaw: 0, pitch: 0 };

  get active(): CharacterActionName | null {
    return this.current?.name ?? null;
  }

  /** Start an action by user/model words ("jump", "laaf dao", "wave"…). */
  perform(raw: string): CharacterActionName | null {
    const name = normalizeActionName(raw);
    if (!name) return null;
    const def = ACTIONS[name];
    this.current = { name, elapsed: 0, duration: def.duration };
    this.root.y = 0;
    this.root.yaw = 0; this.root.pitch = 0;
    return name;
  }

  stop(): void {
    this.current = null;
    this.root.y = 0;
    this.root.yaw = 0; this.root.pitch = 0;
  }

  update(delta: number, pose: PoseBuffer, bones: BoneMap): void {
    this.root.y = 0;
    this.root.yaw = 0; this.root.pitch = 0;
    if (!this.current) return;
    this.current.elapsed += delta;
    const t = Math.min(1, this.current.elapsed / this.current.duration);
    ACTIONS[this.current.name].update(t, pose, bones, this.root);
    if (t >= 1) {
      this.current = null;
      this.root.y = 0;
      this.root.yaw = 0; this.root.pitch = 0;
    }
  }
}
