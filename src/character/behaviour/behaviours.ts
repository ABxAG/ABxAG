/**
 * Behaviour library.
 *
 * A behaviour is a short, self-contained performance: a nod, a wave, a glance
 * away, a stretch. Each one describes its own pose animation over normalised
 * time, an optional facial overlay, and an optional gaze mode.
 *
 * Behaviours never touch the skeleton directly - they write into the shared
 * `PoseBuffer` scaled by a `weight` the director controls. Because the
 * director ramps that weight from 0 and back to 0, every behaviour blends in
 * and out of whatever else is happening with no snapping, and two behaviours
 * overlapping simply sum.
 *
 * Poses are written against SEMANTIC bone slots, so this whole library works
 * unchanged on any character that fills in a `BoneMap`.
 */
import * as THREE from 'three';
import type { BoneMap } from '../config/types';
import type { ExpressionShape } from '../face/ExpressionLibrary';
import type { PoseBuffer } from '../animation/PoseBuffer';
import type { GazeMode } from '../animation/GazeController';
import { easeInOut, easeOutBack } from '../animation/noise';
import { applyHandPose } from '../animation/HandPose';

/** What the character is currently doing, which gates behaviour selection. */
export type CharacterActivity = 'idle' | 'thinking' | 'talking' | 'listening';

export interface Behaviour {
  name: string;
  /** Total play time in seconds. */
  duration: number;
  /** Relative likelihood of being chosen. */
  weight: number;
  /** Activities this behaviour may play during. Defaults to idle only. */
  allowedIn?: CharacterActivity[];
  /** Facial overlay held for the behaviour's duration. */
  expression?: ExpressionShape;
  /** Gaze mode adopted while playing, restored afterward. */
  gaze?: GazeMode;
  /** How far to fade idle motion down while playing. 1 = unchanged. */
  idleIntensity?: number;
  /** Blink once as the behaviour starts. */
  blinkOnStart?: boolean;
  /**
   * Pose animation. `t` is 0..1 progress, `weight` is the director's blend
   * envelope and must scale every contribution.
   */
  pose?: (t: number, weight: number, pose: PoseBuffer, bones: BoneMap) => void;
}

const TAU = Math.PI * 2;

/** Smooth 0 -> 1 -> 0 bell over normalised time, for one-shot gestures. */
const bell = (t: number): number => Math.sin(THREE.MathUtils.clamp(t, 0, 1) * Math.PI);

export const BEHAVIOURS: Behaviour[] = [
  {
    name: 'nod',
    duration: 1.5,
    weight: 10,
    allowedIn: ['idle', 'listening', 'talking'],
    pose: (t, w, pose, bones) => {
      // Two nods, the second smaller - a single nod reads as a twitch.
      const decay = 1 - t * 0.45;
      const swing = Math.sin(t * TAU * 1.75) * decay;
      pose.addEuler(bones.head, swing * 0.085, 0, 0, w);
      pose.addEuler(bones.neck, swing * 0.035, 0, 0, w);
    },
  },

  {
    name: 'headTilt',
    duration: 3.2,
    weight: 9,
    allowedIn: ['idle', 'listening', 'thinking'],
    expression: { browUp: 0.2 },
    pose: (t, w, pose, bones) => {
      const amount = bell(t);
      pose.addEuler(bones.head, 0, 0, amount * 0.13, w);
      pose.addEuler(bones.neck, 0, 0, amount * 0.05, w);
    },
  },

  {
    name: 'lookAround',
    duration: 3.6,
    weight: 8,
    gaze: 'wander',
    blinkOnStart: true,
    expression: { browUp: 0.15 },
    pose: (t, w, pose, bones) => {
      // A slow sweep of the head accompanying the wandering gaze.
      const sweep = Math.sin(t * Math.PI) * Math.sin(t * TAU * 0.5);
      pose.addEuler(bones.upperBody2, 0, sweep * 0.05, 0, w);
    },
  },

  {
    name: 'lookAtUser',
    duration: 2.8,
    weight: 11,
    allowedIn: ['idle', 'listening', 'talking', 'thinking'],
    gaze: 'user',
    blinkOnStart: true,
    expression: { lowerLidUp: 0.2, mouthCornerUpL: 0.15, mouthCornerUpR: 0.15 },
  },

  {
    name: 'smile',
    duration: 3,
    weight: 10,
    allowedIn: ['idle', 'listening', 'talking'],
    expression: {
      smileEyes: 0.4,
      lowerLidUp: 0.28,
      mouthCornerUpL: 0.5,
      mouthCornerUpR: 0.5,
      browUp: 0.15,
    },
    pose: (t, w, pose, bones) => {
      pose.addEuler(bones.head, bell(t) * 0.02, 0, bell(t) * 0.03, w);
    },
  },

  {
    name: 'happy',
    duration: 2.6,
    weight: 6,
    allowedIn: ['idle', 'talking'],
    expression: {
      smileEyes: 0.5,
      mouthCornerUpL: 0.65,
      mouthCornerUpR: 0.65,
      browUp: 0.3,
    },
    pose: (t, w, pose, bones) => {
      // A small bounce through the spine.
      const bounce = Math.sin(t * TAU * 1.5) * (1 - t);
      pose.addTranslation(bones.center, 0, bounce * 0.06, 0, w);
      pose.addEuler(bones.upperBody, -bounce * 0.02, 0, 0, w);
    },
  },

  {
    name: 'curious',
    duration: 3.4,
    weight: 8,
    allowedIn: ['idle', 'listening'],
    expression: { browUp: 0.45, eyesWideL: 0.2, eyesWideR: 0.2, mouthNarrow: 0.15 },
    pose: (t, w, pose, bones) => {
      const amount = bell(t);
      // Lean in slightly, head cocked: the shape of curiosity.
      pose.addEuler(bones.head, -amount * 0.03, amount * 0.05, amount * 0.15, w);
      pose.addEuler(bones.upperBody2, -amount * 0.025, 0, 0, w);
    },
  },

  {
    name: 'think',
    duration: 4.5,
    weight: 9,
    allowedIn: ['idle', 'thinking'],
    gaze: 'away',
    expression: { eyesHalf: 0.3, browTroubled: 0.35, mouthNarrow: 0.25 },
    idleIntensity: 0.7,
    pose: (t, w, pose, bones) => {
      const amount = bell(t);
      // Look up and off to one side, the universal "thinking" posture.
      pose.addEuler(bones.head, -amount * 0.06, amount * 0.12, -amount * 0.08, w);
      pose.addEuler(bones.neck, -amount * 0.02, amount * 0.04, 0, w);
    },
  },

  {
    name: 'wave',
    duration: 3.4,
    weight: 5,
    allowedIn: ['idle'],
    gaze: 'user',
    expression: {
      smileEyes: 0.35,
      mouthCornerUpL: 0.55,
      mouthCornerUpR: 0.55,
      browUp: 0.25,
    },
    idleIntensity: 0.55,
    pose: (t, w, pose, bones) => {
      // Raise over the first 25%, wave, lower over the last 25%.
      const raise =
        t < 0.25
          ? easeOutBack(t / 0.25)
          : t > 0.75
            ? easeInOut((1 - t) / 0.25)
            : 1;

      // The left arm extends along +X, so a positive Z rotation lifts it.
      pose.addEuler(bones.armL, 0, -0.25 * raise, 1.02 * raise, w);
      pose.addEuler(bones.elbowL, 0, -0.55 * raise, 0.32 * raise, w);

      // The wave itself lives in the forearm and wrist, not the shoulder.
      const swing = Math.sin(t * TAU * 3.2) * raise;
      pose.addEuler(bones.elbowL, 0, swing * 0.3, 0, w);
      pose.addEuler(bones.wristL, 0, swing * 0.38, swing * 0.12, w);
      applyHandPose(pose, bones, 'left', 'open', w * raise);

      // The body leans very slightly into the gesture.
      pose.addEuler(bones.upperBody2, 0, -0.035 * raise, 0.02 * raise, w);
      pose.addEuler(bones.head, 0, 0, 0.04 * raise, w);
    },
  },

  {
    name: 'handGesture',
    duration: 2.4,
    weight: 7,
    allowedIn: ['idle', 'talking'],
    pose: (t, w, pose, bones) => {
      // A small, unconscious hand movement - the sort of thing people do
      // constantly without noticing.
      const amount = bell(t);
      const flick = Math.sin(t * TAU * 1.6);
      pose.addEuler(bones.armL, 0, 0, amount * 0.09, w);
      pose.addEuler(bones.elbowL, 0, amount * 0.16, amount * 0.1, w);
      pose.addEuler(bones.wristL, flick * 0.13 * amount, amount * 0.12, 0, w);
      applyHandPose(pose, bones, 'left', 'delicate', w * amount);
    },
  },

  {
    name: 'stretch',
    duration: 5,
    weight: 3,
    allowedIn: ['idle'],
    expression: { smileEyes: 0.35, browUp: 0.3 },
    idleIntensity: 0.4,
    blinkOnStart: true,
    pose: (t, w, pose, bones) => {
      // Rise, extend, hold, release. Slow and luxurious.
      const amount = t < 0.35 ? easeInOut(t / 0.35) : t > 0.6 ? easeInOut((1 - t) / 0.4) : 1;

      pose.addEuler(bones.armL, 0, -0.2 * amount, 0.75 * amount, w);
      pose.addEuler(bones.armR, 0, 0.2 * amount, -0.75 * amount, w);
      pose.addEuler(bones.elbowL, 0, -0.3 * amount, 0.2 * amount, w);
      pose.addEuler(bones.elbowR, 0, 0.3 * amount, -0.2 * amount, w);

      // Extend through the spine and tip the head back.
      pose.addEuler(bones.upperBody, -0.06 * amount, 0, 0, w);
      pose.addEuler(bones.upperBody2, -0.05 * amount, 0, 0, w);
      pose.addEuler(bones.head, -0.07 * amount, 0, 0, w);
      pose.addTranslation(bones.center, 0, 0.09 * amount, 0, w);
      pose.addEuler(bones.shoulderL, 0, 0, 0.09 * amount, w);
      pose.addEuler(bones.shoulderR, 0, 0, -0.09 * amount, w);
      applyHandPose(pose, bones, 'left', 'open', w * amount);
      applyHandPose(pose, bones, 'right', 'open', w * amount);
    },
  },

  {
    // The lazy one: arms all the way up over her head, rising onto her toes,
    // a big yawn, then flopping back down. Plays rarely.
    name: 'stretchUp',
    duration: 4.6,
    weight: 3,
    allowedIn: ['idle'],
    expression: { blink: 0.82, visemeO: 0.75, browSad: 0.25 },
    idleIntensity: 0.25,
    pose: (t, w, pose, bones) => {
      const up = t < 0.3 ? easeInOut(t / 0.3) : t > 0.72 ? easeInOut((1 - t) / 0.28) : 1;
      // Lean a little to one side and back mid-stretch.
      const lean = Math.sin(THREE.MathUtils.clamp((t - 0.25) / 0.5, 0, 1) * Math.PI);
      pose.addEuler(bones.armL, 0, -0.35 * up, 2.45 * up, w);
      pose.addEuler(bones.armR, 0, 0.35 * up, -2.45 * up, w);
      pose.addEuler(bones.elbowL, 0, -0.4 * up, 0.25 * up, w);
      pose.addEuler(bones.elbowR, 0, 0.4 * up, -0.25 * up, w);
      pose.addEuler(bones.wristL, 0, 0, 0.35 * up, w);
      pose.addEuler(bones.wristR, 0, 0, -0.35 * up, w);
      pose.addEuler(bones.shoulderL, 0, 0, 0.22 * up, w);
      pose.addEuler(bones.shoulderR, 0, 0, -0.22 * up, w);
      pose.addEuler(bones.upperBody, -0.08 * up, 0, 0.06 * lean, w);
      pose.addEuler(bones.upperBody2, -0.06 * up, 0, 0.05 * lean, w);
      pose.addEuler(bones.head, -0.16 * up, 0, -0.05 * lean, w);
      applyHandPose(pose, bones, 'left', 'open', w * up);
      applyHandPose(pose, bones, 'right', 'open', w * up);
    },
  },

  {
    // A sleepy yawn behind her hand.
    name: 'yawn',
    duration: 3.4,
    weight: 3,
    allowedIn: ['idle'],
    expression: { blink: 0.75, visemeA: 0.55, visemeO: 0.35, browSad: 0.3 },
    idleIntensity: 0.5,
    pose: (t, w, pose, bones) => {
      const raise = t < 0.22 ? easeInOut(t / 0.22) : t > 0.75 ? easeInOut((1 - t) / 0.25) : 1;
      // Right hand comes up in front of the mouth.
      pose.addEuler(bones.armR, -0.25 * raise, 0.55 * raise, -0.55 * raise, w);
      pose.addEuler(bones.elbowR, 0, 2.1 * raise, -0.15 * raise, w);
      pose.addEuler(bones.wristR, 0.25 * raise, 0.2 * raise, 0, w);
      pose.addEuler(bones.head, -0.1 * raise, -0.05 * raise, 0.06 * raise, w);
      pose.addEuler(bones.upperBody2, -0.03 * raise, 0, 0, w);
      applyHandPose(pose, bones, 'right', 'delicate', w * raise);
    },
  },

  {
    // Hands clasped behind her back, rocking gently heel to toe.
    name: 'handsBehind',
    duration: 5.5,
    weight: 4,
    allowedIn: ['idle', 'listening'],
    gaze: 'user',
    expression: { mouthCornerUpL: 0.3, mouthCornerUpR: 0.3, smileEyes: 0.2 },
    idleIntensity: 0.6,
    pose: (t, w, pose, bones) => {
      const hold = t < 0.18 ? easeInOut(t / 0.18) : t > 0.8 ? easeInOut((1 - t) / 0.2) : 1;
      const rock = Math.sin(t * TAU * 2) * hold;
      pose.addEuler(bones.armL, 0, 0.55 * hold, 0.12 * hold, w);
      pose.addEuler(bones.armR, 0, -0.55 * hold, -0.12 * hold, w);
      pose.addEuler(bones.elbowL, 0, 0.75 * hold, 0, w);
      pose.addEuler(bones.elbowR, 0, -0.75 * hold, 0, w);
      pose.addEuler(bones.upperBody, -0.03 * hold + rock * 0.02, 0, 0, w);
      pose.addEuler(bones.head, 0, 0, 0.08 * hold, w);
    },
  },

  {
    // Tucks a strand of hair behind her ear.
    name: 'fixHair',
    duration: 2.8,
    weight: 4,
    allowedIn: ['idle', 'listening'],
    blinkOnStart: true,
    pose: (t, w, pose, bones) => {
      const raise = t < 0.3 ? easeInOut(t / 0.3) : t > 0.7 ? easeInOut((1 - t) / 0.3) : 1;
      pose.addEuler(bones.armL, 0, -0.35 * raise, 1.25 * raise, w);
      pose.addEuler(bones.elbowL, 0, -1.65 * raise, 0.2 * raise, w);
      pose.addEuler(bones.wristL, 0, -0.2 * raise, 0.3 * raise, w);
      pose.addEuler(bones.head, 0, 0.06 * raise, -0.1 * raise, w);
      applyHandPose(pose, bones, 'left', 'delicate', w * raise);
    },
  },

  {
    // A little giggle: shoulders bounce, eyes squeeze, hand near the mouth.
    name: 'giggle',
    duration: 2.2,
    weight: 3,
    allowedIn: ['idle'],
    expression: { smileEyes: 0.8, mouthCornerUpL: 0.7, mouthCornerUpR: 0.7, visemeI: 0.25 },
    pose: (t, w, pose, bones) => {
      const amount = bell(t);
      const bounce = Math.abs(Math.sin(t * TAU * 3)) * amount;
      pose.addEuler(bones.upperBody2, 0.04 * amount, 0, 0, w);
      pose.addEuler(bones.shoulderL, 0, 0, 0.05 * bounce, w);
      pose.addEuler(bones.shoulderR, 0, 0, -0.05 * bounce, w);
      pose.addEuler(bones.head, 0.06 * amount, 0, 0.1 * amount, w);
      pose.addEuler(bones.armR, -0.2 * amount, 0.5 * amount, -0.45 * amount, w);
      pose.addEuler(bones.elbowR, 0, 1.8 * amount, 0, w);
      applyHandPose(pose, bones, 'right', 'delicate', w * amount);
    },
  },

  // Face-only overlays, never picked at random (weight 0): the desktop
  // companion plays them alongside solved body poses.
  { name: 'yawnFace', duration: 2.6, weight: 0, allowedIn: ['idle', 'listening', 'thinking', 'talking'], expression: { blink: 0.8, visemeA: 0.5, visemeO: 0.4, browSad: 0.3 } },
  { name: 'curiousFace', duration: 3, weight: 0, allowedIn: ['idle', 'listening', 'thinking', 'talking'], expression: { browUp: 0.5, eyesWideL: 0.25, eyesWideR: 0.25, mouthNarrow: 0.2 } },
  { name: 'happyFace', duration: 2.5, weight: 0, allowedIn: ['idle', 'listening', 'thinking', 'talking'], expression: { smileEyes: 0.7, mouthCornerUpL: 0.7, mouthCornerUpR: 0.7, browUp: 0.25 } },
  { name: 'heldFace', duration: 2.2, weight: 0, allowedIn: ['idle', 'listening', 'thinking', 'talking'], expression: { eyesWideL: 0.35, eyesWideR: 0.35, browUp: 0.55, visemeO: 0.25 } },
  { name: 'effortFace', duration: 3, weight: 0, allowedIn: ['idle', 'listening', 'thinking', 'talking'], expression: { eyesAngry: 0.3, blink: 0.35, mouthNarrow: 0.3, browTroubled: 0.3, teethUp: 0.3 } },

  {
    name: 'shiftWeight',
    duration: 4.2,
    weight: 8,
    allowedIn: ['idle', 'listening', 'thinking'],
    pose: (t, w, pose, bones) => {
      const amount = bell(t);
      pose.addTranslation(bones.center, amount * 0.14, 0, 0, w);
      pose.addEuler(bones.waist, 0, amount * 0.03, amount * 0.035, w);
      pose.addEuler(bones.upperBody, 0, 0, -amount * 0.025, w);
      pose.addEuler(bones.head, 0, 0, -amount * 0.02, w);
    },
  },

  {
    name: 'relaxedPose',
    duration: 5.5,
    weight: 6,
    allowedIn: ['idle'],
    expression: { eyesHalf: 0.15, mouthCornerUpL: 0.2, mouthCornerUpR: 0.2 },
    idleIntensity: 0.8,
    pose: (t, w, pose, bones) => {
      const amount = bell(t);
      // Shoulders drop, spine softens: visibly at ease.
      pose.addEuler(bones.shoulderL, 0, 0, -amount * 0.05, w);
      pose.addEuler(bones.shoulderR, 0, 0, amount * 0.05, w);
      pose.addEuler(bones.upperBody, amount * 0.022, 0, 0, w);
      pose.addEuler(bones.head, amount * 0.028, 0, 0, w);
    },
  },

  {
    name: 'glanceAside',
    duration: 2.2,
    weight: 7,
    allowedIn: ['idle', 'thinking'],
    gaze: 'wander',
    blinkOnStart: true,
    pose: (t, w, pose, bones) => {
      const amount = bell(t);
      const dir = 1;
      pose.addEuler(bones.head, 0, amount * 0.14 * dir, amount * 0.03 * dir, w);
      pose.addEuler(bones.neck, 0, amount * 0.05 * dir, 0, w);
    },
  },
];
