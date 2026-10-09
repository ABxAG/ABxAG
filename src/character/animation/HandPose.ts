import type { BoneMap } from '../config/types';
import type { PoseBuffer } from './PoseBuffer';

export type HandSide = 'left' | 'right';
export type HandPoseName = 'relaxed' | 'open' | 'delicate' | 'softFist' | 'point';

type FingerName = 'index' | 'middle' | 'ring' | 'little';

const fingerBone = (
  bones: BoneMap,
  side: HandSide,
  finger: FingerName,
  segment: 1 | 2 | 3
): string | undefined => {
  const suffix = side === 'left' ? 'L' : 'R';
  return bones[(finger + segment + suffix) as keyof BoneMap];
};

const thumbBone = (
  bones: BoneMap,
  side: HandSide,
  segment: 0 | 1 | 2
): string | undefined => {
  const suffix = side === 'left' ? 'L' : 'R';
  return bones[('thumb' + segment + suffix) as keyof BoneMap];
};

const CURLS: Record<HandPoseName, Record<FingerName, number>> = {
  relaxed: { index: 0.12, middle: 0.16, ring: 0.2, little: 0.24 },
  open: { index: 0.015, middle: 0.02, ring: 0.025, little: 0.03 },
  delicate: { index: 0.08, middle: 0.16, ring: 0.28, little: 0.38 },
  softFist: { index: 0.66, middle: 0.72, ring: 0.76, little: 0.8 },
  point: { index: 0.015, middle: 0.62, ring: 0.7, little: 0.76 },
};

/**
 * Apply an additive finger pose using standard MMD finger chains.
 * Rotations stay conservative because small bends already read clearly while
 * large offsets quickly make a skinned anime hand self-intersect.
 */
export function applyHandPose(
  pose: PoseBuffer,
  bones: BoneMap,
  side: HandSide,
  name: HandPoseName,
  weight = 1
): void {
  if (weight <= 0) return;
  const curls = CURLS[name];
  const handed = side === 'left' ? 1 : -1;
  const spread = name === 'open' ? 0.045 : name === 'delicate' ? 0.018 : 0;
  const fingers: FingerName[] = ['index', 'middle', 'ring', 'little'];

  fingers.forEach((finger, index) => {
    const curl = curls[finger];
    const fan = (index - 1.5) * spread * handed;
    pose.addEuler(fingerBone(bones, side, finger, 1), curl * 0.58, 0, fan, weight);
    pose.addEuler(fingerBone(bones, side, finger, 2), curl * 0.82, 0, 0, weight);
    pose.addEuler(fingerBone(bones, side, finger, 3), curl * 0.62, 0, 0, weight);
  });

  const thumbCurl =
    name === 'open' ? 0.02 : name === 'softFist' ? 0.5 : name === 'point' ? 0.42 : 0.16;
  pose.addEuler(thumbBone(bones, side, 0), thumbCurl * 0.28, handed * thumbCurl * 0.34, 0, weight);
  pose.addEuler(thumbBone(bones, side, 1), thumbCurl * 0.58, handed * thumbCurl * 0.16, 0, weight);
  pose.addEuler(thumbBone(bones, side, 2), thumbCurl * 0.42, 0, 0, weight);
}
