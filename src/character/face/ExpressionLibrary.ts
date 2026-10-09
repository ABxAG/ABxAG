/**
 * Model-independent facial expression library.
 *
 * Each expression combines several small, semantically meaningful controls.
 * Anime faces read best from coordinated eyes, brows and mouth corners; driving
 * one large morph by itself is what creates the stiff or exaggerated result.
 */
import type { MorphMap } from '../config/types';

export type ExpressionShape = Partial<Record<keyof MorphMap, number>>;

export type ExpressionName =
  | 'neutral'
  | 'happy'
  | 'excited'
  | 'curious'
  | 'thinking'
  | 'proud'
  | 'sad'
  | 'confused'
  | 'surprised'
  | 'embarrassed'
  | 'playful'
  | 'listening';

/** Mouth channels yield smoothly to visemes while ABxAG is speaking. */
export const MOUTH_SLOTS: ReadonlySet<keyof MorphMap> = new Set([
  'visemeA', 'visemeI', 'visemeU', 'visemeE', 'visemeO', 'visemeTalk',
  'mouthSmile', 'mouthCornerUpL', 'mouthCornerUpR',
  'mouthCornerDownL', 'mouthCornerDownR',
  'mouthWiden', 'mouthNarrow', 'mouthShiftRight', 'mouthShiftLeft',
  'mouthUp', 'mouthDown', 'mouthWidenL', 'mouthWidenR',
  'mouthNarrowL', 'mouthNarrowR', 'teethUp', 'teethDown',
]);

export const EXPRESSIONS: Record<ExpressionName, ExpressionShape> = {
  neutral: {
    lowerLidUp: 0.07,
    mouthCornerUpL: 0.04,
    mouthCornerUpR: 0.04,
    browUp: 0.025,
  },

  happy: {
    // A full Duchenne-style anime smile: cheeks lift the lower lids and the
    // brows open warmly instead of leaving a smiling mouth under a blank face.
    smileEyes: 0.18,
    lowerLidUp: 0.4,
    mouthSmile: 0.2,
    mouthCornerUpL: 0.72,
    mouthCornerUpR: 0.72,
    mouthWiden: 0.18,
    browUp: 0.3,
  },

  excited: {
    eyesWideL: 0.62,
    eyesWideR: 0.62,
    lowerLidUp: 0.12,
    mouthSmile: 0.24,
    mouthCornerUpL: 0.8,
    mouthCornerUpR: 0.8,
    mouthWiden: 0.28,
    visemeA: 0.22,
    browUp: 0.82,
  },

  curious: {
    // One brow and one eye lead so this reads as a question, not surprise.
    eyesWideL: 0.2,
    eyesWideR: 0.42,
    lowerLidUp: 0.1,
    browUp: 0.45,
    browAngryR: 0.22,
    mouthNarrow: 0.2,
    mouthShiftLeft: 0.1,
    mouthCornerUpR: 0.08,
  },

  thinking: {
    eyesHalf: 0.34,
    browTroubled: 0.62,
    browSerious: 0.18,
    browUp: 0.08,
    mouthNarrow: 0.35,
    mouthShiftLeft: 0.16,
    mouthCornerDownR: 0.16,
  },

  proud: {
    eyesHalf: 0.26,
    lowerLidUp: 0.22,
    browSerious: 0.55,
    browDown: 0.08,
    mouthSmile: 0.3,
    mouthCornerUpL: 0.44,
    mouthCornerUpR: 0.32,
    mouthShiftRight: 0.04,
  },

  sad: {
    eyesSad: 0.75,
    eyeOuterDown: 0.18,
    lowerLidUp: 0.08,
    browSad: 0.88,
    browTroubled: 0.2,
    mouthCornerDownL: 0.55,
    mouthCornerDownR: 0.55,
    mouthNarrow: 0.14,
  },

  confused: {
    eyesWideL: 0.3,
    eyesHalf: 0.24,
    browTroubled: 0.78,
    browUp: 0.18,
    browAngryR: 0.32,
    mouthNarrow: 0.28,
    mouthShiftRight: 0.2,
    mouthCornerDownL: 0.28,
    mouthCornerUpR: 0.06,
  },

  surprised: {
    eyesWideL: 0.92,
    eyesWideR: 0.92,
    browUp: 1,
    visemeO: 0.55,
    mouthNarrow: 0.12,
  },

  embarrassed: {
    // Shy and uncertain rather than generically happy: brows pinch upward,
    // eyes soften and avert, and the mouth is an asymmetric restrained smile.
    eyesHalf: 0.48,
    eyesSad: 0.32,
    eyeOuterDown: 0.08,
    lowerLidUp: 0.3,
    browTroubled: 0.7,
    browSad: 0.28,
    browUp: 0.1,
    mouthSmile: 0.04,
    mouthCornerUpL: 0.09,
    mouthCornerDownR: 0.05,
    mouthNarrow: 0.27,
    mouthShiftLeft: 0.1,
  },

  playful: {
    // A clear wink with a moving single-brow smirk.
    blinkL: 0.92,
    lowerLidUp: 0.26,
    mouthSmile: 0.5,
    mouthCornerUpL: 0.68,
    mouthCornerUpR: 0.36,
    mouthShiftRight: 0.13,
    browUp: 0.34,
    browAngryR: 0.24,
  },

  listening: {
    eyesWideL: 0.14,
    eyesWideR: 0.14,
    lowerLidUp: 0.17,
    browUp: 0.3,
    mouthSmile: 0.05,
    mouthCornerUpL: 0.1,
    mouthCornerUpR: 0.1,
  },
};

export function expressionForEmotion(emotion: string): ExpressionName {
  return (emotion in EXPRESSIONS ? emotion : 'neutral') as ExpressionName;
}

