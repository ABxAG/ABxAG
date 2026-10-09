/**
 * Turn an imported CharacterProfile into a runnable CharacterConfig.
 *
 * Everything model-specific (bones, morphs, material roles, scale) comes from
 * the profile the importer generated; the look (lighting, shading, camera
 * feel, idle timing) is inherited from the built-in character so every
 * imported model gets the same polished anime rendering without hand tuning.
 */
import type { CharacterProfile } from '@/shared/character/profile';
import type { BoneMap, CharacterConfig, MaterialRoleMap, MorphMap } from './types';
import { evelynConfig } from './characters/evelyn';

const BONE_SLOTS: Record<keyof BoneMap, string> = {
  root: 'ROOT', center: 'CENTER', groove: 'GROOVE', waist: 'WAIST', lowerBody: 'LOWER_BODY', upperBody: 'SPINE',
  upperBody2: 'CHEST', neck: 'NECK', head: 'HEAD', eyes: 'EYES', eyeL: 'LEFT_EYE', eyeR: 'RIGHT_EYE',
  shoulderL: 'LEFT_SHOULDER', shoulderR: 'RIGHT_SHOULDER', armL: 'LEFT_UPPER_ARM', armR: 'RIGHT_UPPER_ARM',
  elbowL: 'LEFT_LOWER_ARM', elbowR: 'RIGHT_LOWER_ARM', wristL: 'LEFT_HAND', wristR: 'RIGHT_HAND',
  thumb0L: 'LEFT_THUMB_METACARPAL', thumb1L: 'LEFT_THUMB_PROXIMAL', thumb2L: 'LEFT_THUMB_DISTAL',
  index1L: 'LEFT_INDEX_PROXIMAL', index2L: 'LEFT_INDEX_INTERMEDIATE', index3L: 'LEFT_INDEX_DISTAL',
  middle1L: 'LEFT_MIDDLE_PROXIMAL', middle2L: 'LEFT_MIDDLE_INTERMEDIATE', middle3L: 'LEFT_MIDDLE_DISTAL',
  ring1L: 'LEFT_RING_PROXIMAL', ring2L: 'LEFT_RING_INTERMEDIATE', ring3L: 'LEFT_RING_DISTAL',
  little1L: 'LEFT_LITTLE_PROXIMAL', little2L: 'LEFT_LITTLE_INTERMEDIATE', little3L: 'LEFT_LITTLE_DISTAL',
  thumb0R: 'RIGHT_THUMB_METACARPAL', thumb1R: 'RIGHT_THUMB_PROXIMAL', thumb2R: 'RIGHT_THUMB_DISTAL',
  index1R: 'RIGHT_INDEX_PROXIMAL', index2R: 'RIGHT_INDEX_INTERMEDIATE', index3R: 'RIGHT_INDEX_DISTAL',
  middle1R: 'RIGHT_MIDDLE_PROXIMAL', middle2R: 'RIGHT_MIDDLE_INTERMEDIATE', middle3R: 'RIGHT_MIDDLE_DISTAL',
  ring1R: 'RIGHT_RING_PROXIMAL', ring2R: 'RIGHT_RING_INTERMEDIATE', ring3R: 'RIGHT_RING_DISTAL',
  little1R: 'RIGHT_LITTLE_PROXIMAL', little2R: 'RIGHT_LITTLE_INTERMEDIATE', little3R: 'RIGHT_LITTLE_DISTAL',
  legL: 'LEFT_UPPER_LEG', legR: 'RIGHT_UPPER_LEG', kneeL: 'LEFT_LOWER_LEG', kneeR: 'RIGHT_LOWER_LEG',
  ankleL: 'LEFT_FOOT', ankleR: 'RIGHT_FOOT',
};

export function boneMapFromHumanoid(humanoid: Record<string, { bone: string }>): BoneMap {
  const map = {} as Record<keyof BoneMap, string>;
  for (const [key, slot] of Object.entries(BONE_SLOTS) as Array<[keyof BoneMap, string]>) {
    // Absent bones become '' — every animation layer ignores unknown names.
    map[key] = humanoid[slot]?.bone ?? (slot === 'LOWER_BODY' ? humanoid.HIPS?.bone ?? '' : '');
  }
  return map as unknown as BoneMap;
}

export function configFromProfile(profile: CharacterProfile, base: CharacterConfig = evelynConfig): CharacterConfig {
  const bones = boneMapFromHumanoid(profile.skeleton.humanoid);
  return {
    ...base,
    id: profile.id,
    displayName: profile.displayName,
    modelUrl: `/user-characters/${encodeURIComponent(profile.id)}/${profile.model.file}`,
    textureMapUrl: `/user-characters/${encodeURIComponent(profile.id)}/${profile.model.textureMap}`,
    scale: profile.scale,
    groundOffset: profile.groundOffset,
    bones,
    // The relaxed stance is computed from this model's own arm angles at load.
    basePose: undefined,
    outline: { enabled: false, scale: 1 },
    morphs: profile.morphs.map as MorphMap,
    materialRoles: profile.materials.roles as MaterialRoleMap,
    hiddenMaterials: [],
    // Same framing as the built-in character: aim at the upper chest so the
    // face is large and the character sits centred, not pushed off the bottom.
    camera: {
      ...base.camera,
      targetBone: profile.skeleton.humanoid.UPPER_CHEST?.bone || bones.upperBody2 || bones.upperBody || bones.neck || base.camera.targetBone,
    },
  };
}
