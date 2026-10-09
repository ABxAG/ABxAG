import * as THREE from 'three';
import type { BoneMap } from '../config/types';
import type { CharacterActivity } from '../behaviour/behaviours';
import type { PoseBuffer } from './PoseBuffer';
import { applyHandPose } from './HandPose';

const ACTIVITIES: CharacterActivity[] = ['idle', 'listening', 'thinking', 'talking'];
const EMOTIONS = [
  'happy', 'excited', 'curious', 'thinking', 'proud', 'sad',
  'confused', 'surprised', 'embarrassed', 'playful',
] as const;
type PerformanceEmotion = typeof EMOTIONS[number];

export interface PerformanceUpdateContext {
  delta: number;
  activity: CharacterActivity;
  emotion: string;
  pose: PoseBuffer;
  bones: BoneMap;
}

/**
 * Persistent character acting for app states and emotions.
 *
 * Random behaviours create spontaneity, but an explicit app state must read
 * immediately and continuously. This layer supplies that body language while
 * remaining additive with idle, gaze and one-shot behaviours.
 */
export class PerformanceController {
  private time = 0;
  private readonly activityWeights: Record<CharacterActivity, number> = {
    idle: 1,
    listening: 0,
    thinking: 0,
    talking: 0,
  };
  private readonly emotionWeights = Object.fromEntries(
    EMOTIONS.map((emotion) => [emotion, 0])
  ) as Record<PerformanceEmotion, number>;

  update({ delta, activity, emotion, pose, bones }: PerformanceUpdateContext): void {
    this.time += delta;
    const activityBlend = 1 - Math.exp(-5.2 * delta);
    const emotionBlend = 1 - Math.exp(-4.6 * delta);

    for (const name of ACTIVITIES) {
      this.activityWeights[name] = THREE.MathUtils.lerp(
        this.activityWeights[name],
        name === activity ? 1 : 0,
        activityBlend
      );
    }
    for (const name of EMOTIONS) {
      this.emotionWeights[name] = THREE.MathUtils.lerp(
        this.emotionWeights[name],
        name === emotion ? 1 : 0,
        emotionBlend
      );
    }

    // Natural hands are never ruler-straight, even at rest.
    applyHandPose(pose, bones, 'left', 'relaxed', 0.7);
    applyHandPose(pose, bones, 'right', 'relaxed', 0.7);

    this.applyListening(this.activityWeights.listening, pose, bones);
    // The thinking emotion must carry the iconic hand-to-chin silhouette even
    // when the app activity itself is still idle.
    const thinkingPresence = Math.max(
      this.activityWeights.thinking,
      this.emotionWeights.thinking * 0.82
    );
    this.applyThinking(thinkingPresence, pose, bones);
    this.applyTalking(this.activityWeights.talking, pose, bones);

    for (const name of EMOTIONS) {
      const weight = this.emotionWeights[name];
      if (weight > 0.001) this.applyEmotion(name, weight, pose, bones);
    }
  }

  private applyListening(weight: number, pose: PoseBuffer, bones: BoneMap): void {
    if (weight <= 0.001) return;
    const attentive = 0.82 + Math.sin(this.time * 1.25) * 0.04;
    pose.addEuler(bones.upperBody2, -0.025 * attentive, 0, 0, weight);
    pose.addEuler(bones.head, -0.015, Math.sin(this.time * 0.55) * 0.018, 0.035, weight);
    pose.addEuler(bones.neck, 0, 0, 0.012, weight);
    pose.addEuler(bones.shoulderL, 0, 0, 0.018, weight);
    pose.addEuler(bones.shoulderR, 0, 0, -0.018, weight);
  }

  private applyThinking(weight: number, pose: PoseBuffer, bones: BoneMap): void {
    if (weight <= 0.001) return;
    const settle = 0.94 + Math.sin(this.time * 0.7) * 0.025;
    pose.addEuler(bones.head, -0.045, 0.11, -0.065, weight);
    pose.addEuler(bones.neck, -0.015, 0.035, -0.018, weight);
    pose.addEuler(bones.upperBody2, 0.018, 0.035, 0, weight);

    // This model's elbow twist chain cannot reach the chin cleanly without
    // breaking the upper-arm silhouette. Fold the forearm inward across the
    // waist instead and let the pointed index plus upward gaze carry thought.
    pose.addEuler(bones.shoulderR, 0, 0, -0.055, weight);
    pose.addEuler(bones.armR, 0.05, -0.28, -0.3 * settle, weight);
    pose.addEuler(bones.elbowR, 0.1, 0.18, 2.35, weight);
    pose.addEuler(bones.wristR, 0.12, -0.16, -0.22, weight);
    applyHandPose(pose, bones, 'right', 'point', weight * 0.95);
  }

  private applyTalking(weight: number, pose: PoseBuffer, bones: BoneMap): void {
    if (weight <= 0.001) return;
    const cycleLength = 2.8;
    const cycle = this.time / cycleLength;
    const phase = cycle - Math.floor(cycle);
    const gesture = Math.pow(Math.sin(phase * Math.PI), 2);
    const leftLeads = Math.floor(cycle) % 2 === 0;
    const emphasis = gesture * weight;
    const pulse = Math.sin(this.time * 8.4) * 0.5 + 0.5;

    pose.addEuler(bones.head, pulse * 0.012, Math.sin(this.time * 0.8) * 0.012, 0, weight);
    pose.addEuler(bones.upperBody2, -0.012, Math.sin(this.time * 0.65) * 0.018, 0, weight);

    if (leftLeads) {
      pose.addEuler(bones.armL, 0, -0.16, 0.28, emphasis);
      pose.addEuler(bones.elbowL, 0.04, -0.3, 0.11, emphasis);
      pose.addEuler(bones.wristL, -0.08, 0.13, Math.sin(phase * Math.PI * 2) * 0.06, emphasis);
      applyHandPose(pose, bones, 'left', 'delicate', emphasis);
    } else {
      pose.addEuler(bones.armR, 0, 0.16, -0.28, emphasis);
      pose.addEuler(bones.elbowR, 0.04, 0.3, -0.11, emphasis);
      pose.addEuler(bones.wristR, -0.08, -0.13, -Math.sin(phase * Math.PI * 2) * 0.06, emphasis);
      applyHandPose(pose, bones, 'right', 'delicate', emphasis);
    }
  }

  private applyEmotion(
    emotion: PerformanceEmotion,
    weight: number,
    pose: PoseBuffer,
    bones: BoneMap
  ): void {
    const slow = Math.sin(this.time * 1.35);
    const side = Math.sin(this.time * 0.62);
    const bounce = Math.sin(this.time * 3.1);
    const soften = 0.5 + 0.5 * Math.sin(this.time * 0.9);

    switch (emotion) {
      case 'happy':
        pose.addEuler(bones.head, -0.015 + bounce * 0.004, side * 0.028, side * 0.035, weight);
        pose.addEuler(bones.neck, 0, side * 0.01, side * 0.012, weight);
        pose.addEuler(bones.upperBody2, -0.02, -side * 0.015, -side * 0.008, weight);
        pose.addEuler(bones.shoulderL, 0, 0, 0.016 + bounce * 0.006, weight);
        pose.addEuler(bones.shoulderR, 0, 0, -0.016 - bounce * 0.006, weight);
        break;

      case 'excited':
        pose.addTranslation(bones.center, 0, bounce * 0.03 + 0.025, 0, weight);
        pose.addEuler(bones.head, -0.018 + bounce * 0.012, side * 0.045, side * 0.02, weight);
        pose.addEuler(bones.upperBody2, -0.025 + bounce * 0.008, side * 0.03, 0, weight);
        pose.addEuler(bones.shoulderL, 0, 0, 0.055 + bounce * 0.014, weight);
        pose.addEuler(bones.shoulderR, 0, 0, -0.055 - bounce * 0.014, weight);
        pose.addEuler(bones.armL, 0, -0.05, 0.12 + bounce * 0.025, weight);
        pose.addEuler(bones.armR, 0, 0.05, -0.12 - bounce * 0.025, weight);
        applyHandPose(pose, bones, 'left', 'open', weight);
        applyHandPose(pose, bones, 'right', 'open', weight);
        break;

      case 'curious':
        pose.addEuler(bones.head, -0.03 + slow * 0.006, -side * 0.055, side * 0.13, weight);
        pose.addEuler(bones.neck, -0.006, -side * 0.018, side * 0.045, weight);
        pose.addEuler(bones.upperBody2, -0.025, side * 0.025, -side * 0.012, weight);
        break;

      case 'thinking':
        pose.addEuler(bones.head, -0.02, side * 0.055, -side * 0.04, weight);
        pose.addEuler(bones.neck, -0.008, side * 0.018, -side * 0.012, weight);
        break;

      case 'proud':
        pose.addEuler(bones.head, -0.06 + slow * 0.004, side * 0.018, -side * 0.015, weight);
        pose.addEuler(bones.neck, -0.018, side * 0.008, 0, weight);
        pose.addEuler(bones.upperBody2, -0.035, -side * 0.012, 0, weight);
        pose.addEuler(bones.shoulderL, 0, 0, 0.035, weight);
        pose.addEuler(bones.shoulderR, 0, 0, -0.035, weight);
        break;

      case 'sad':
        pose.addEuler(bones.head, 0.085 + slow * 0.008, side * 0.02, side * 0.025, weight);
        pose.addEuler(bones.neck, 0.025, side * 0.008, side * 0.01, weight);
        pose.addEuler(bones.upperBody2, 0.05, -side * 0.012, 0, weight);
        pose.addEuler(bones.shoulderL, 0, 0, -0.045, weight);
        pose.addEuler(bones.shoulderR, 0, 0, 0.045, weight);
        applyHandPose(pose, bones, 'left', 'softFist', weight * 0.35);
        applyHandPose(pose, bones, 'right', 'softFist', weight * 0.35);
        break;

      case 'confused': {
        const tilt = Math.sin(this.time * 0.75);
        const leftShrug = 0.025 + (0.5 + 0.5 * tilt) * 0.035;
        const rightShrug = 0.025 + (0.5 - 0.5 * tilt) * 0.035;
        pose.addEuler(bones.head, 0.015, -tilt * 0.07, -tilt * 0.12, weight);
        pose.addEuler(bones.neck, 0, -tilt * 0.02, -tilt * 0.035, weight);
        pose.addEuler(bones.shoulderL, 0, 0, leftShrug, weight);
        pose.addEuler(bones.shoulderR, 0, 0, -rightShrug, weight);
        break;
      }

      case 'surprised':
        pose.addEuler(bones.head, 0.035 + bounce * 0.005, side * 0.018, 0, weight);
        pose.addEuler(bones.upperBody2, 0.045, -side * 0.015, 0, weight);
        pose.addEuler(bones.shoulderL, 0, 0, 0.065 + soften * 0.01, weight);
        pose.addEuler(bones.shoulderR, 0, 0, -0.065 - soften * 0.01, weight);
        pose.addEuler(bones.armL, 0, -0.04, 0.09, weight);
        pose.addEuler(bones.armR, 0, 0.04, -0.09, weight);
        applyHandPose(pose, bones, 'left', 'open', weight);
        applyHandPose(pose, bones, 'right', 'open', weight);
        break;

      case 'embarrassed': {
        const shySide = Math.sin(this.time * 0.48);
        pose.addTranslation(bones.center, shySide * 0.02, 0, 0, weight);
        pose.addEuler(bones.head, 0.075 + soften * 0.008, shySide * 0.095, -shySide * 0.055, weight);
        pose.addEuler(bones.neck, 0.024, shySide * 0.028, -shySide * 0.018, weight);
        pose.addEuler(bones.upperBody2, 0.032, -shySide * 0.025, 0, weight);
        pose.addEuler(bones.shoulderL, 0, 0, -0.052, weight);
        pose.addEuler(bones.shoulderR, 0, 0, 0.052, weight);
        pose.addEuler(bones.armL, 0.015, -0.1, -0.08, weight);
        pose.addEuler(bones.armR, 0.015, 0.1, 0.08, weight);
        pose.addEuler(bones.elbowL, 0, -0.12, -0.06, weight);
        pose.addEuler(bones.elbowR, 0, 0.12, 0.06, weight);
        applyHandPose(pose, bones, 'left', 'delicate', weight * 0.8);
        applyHandPose(pose, bones, 'right', 'delicate', weight * 0.8);
        break;
      }

      case 'playful': {
        const tease = Math.sin(this.time * 0.9);
        pose.addEuler(bones.head, -0.025, -0.04 + tease * 0.035, 0.08 + tease * 0.04, weight);
        pose.addEuler(bones.neck, -0.006, -0.015 + tease * 0.012, 0.022 + tease * 0.01, weight);
        pose.addEuler(bones.upperBody2, -0.018, -tease * 0.028, tease * 0.018, weight);
        pose.addEuler(bones.armL, 0, -0.09, 0.1 + tease * 0.025, weight);
        pose.addEuler(bones.wristL, 0, 0.1, 0.1 + tease * 0.04, weight);
        applyHandPose(pose, bones, 'left', 'delicate', weight * 0.8);
        break;
      }
    }
  }

}
