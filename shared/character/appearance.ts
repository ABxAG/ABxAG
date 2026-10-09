/**
 * Morph (expression) and material-role mapping by name, for any model.
 *
 * MMD's de-facto standard Japanese morph names are matched first, then
 * English / VRoid / ARKit style names. Unmatched slots are simply absent;
 * the face controller already copes with missing morphs.
 */
import type { RigDescription, RigMorph } from "./rig";

/** Mirror of src/character/config/types.ts MorphMap keys. */
export const MORPH_SLOTS = [
  "blink", "blinkL", "blinkR", "smileEyes", "eyesWideL", "eyesWideR", "eyesHalf", "eyesAngry", "eyesAngry2", "eyesSad",
  "eyeOuterDown", "lowerLidUp", "visemeA", "visemeI", "visemeU", "visemeE", "visemeO", "visemeTalk", "mouthSmile",
  "mouthCornerUpL", "mouthCornerUpR", "mouthCornerDownL", "mouthCornerDownR", "mouthWiden", "mouthNarrow",
  "mouthShiftRight", "mouthShiftLeft", "mouthUp", "mouthDown", "mouthWidenL", "mouthWidenR", "mouthNarrowL",
  "mouthNarrowR", "teethUp", "teethDown", "browAngry", "browSerious", "browSad", "browTroubled", "browUp", "browDown",
  "browAngryR",
] as const;
export type MorphSlot = (typeof MORPH_SLOTS)[number];

const MORPH_NAMES: Record<MorphSlot, Array<string | RegExp>> = {
  blink: ["まばたき", "瞬き", "blink", "Blink", "Fcl_EYE_Close", "eyeBlink", "闭眼", "眨眼"],
  blinkL: ["ウィンク", "ウインク", "wink", "Fcl_EYE_Close_L", "eyeBlinkLeft", "blink_l", "Blink_L"],
  blinkR: ["ウィンク右", "ウインク右", "wink_r", "Fcl_EYE_Close_R", "eyeBlinkRight", "blink_r", "Blink_R"],
  smileEyes: ["笑い", "smile_eye", "Fcl_EYE_Joy", "eyeSmile", "笑眼"],
  eyesWideL: ["びっくり左", "びっくり", "Fcl_EYE_Surprised", "eyeWideLeft", "surprised"],
  eyesWideR: ["びっくり右", "びっくり", "Fcl_EYE_Surprised", "eyeWideRight", "surprised"],
  eyesHalf: ["じと目", "ジト目", "half_eye", "jitome"],
  eyesAngry: ["怒り目", "Fcl_EYE_Angry", "angry_eye"],
  eyesAngry2: ["怒り目２", "怒り目2"],
  eyesSad: ["悲しむ", "悲しい目", "Fcl_EYE_Sorrow", "sad_eye"],
  eyeOuterDown: ["眼角下", "目尻下げ"],
  lowerLidUp: ["下眼上", "下瞼上げ", "下まぶた上げ"],
  visemeA: ["あ", "a", "A", "aa", "Fcl_MTH_A", "mouth_a", "vrc.v_aa"],
  visemeI: ["い", "i", "I", "ih", "Fcl_MTH_I", "mouth_i", "vrc.v_ih"],
  visemeU: ["う", "u", "U", "ou", "Fcl_MTH_U", "mouth_u", "vrc.v_ou"],
  visemeE: ["え", "e", "E", "ee", "Fcl_MTH_E", "mouth_e", "vrc.v_e"],
  visemeO: ["お", "o", "O", "oh", "Fcl_MTH_O", "mouth_o", "vrc.v_oh"],
  visemeTalk: ["ワ", "ω", "talk"],
  mouthSmile: ["にやり", "にっこり", "にやり２", "にやり３", "mouthSmile", "Fcl_MTH_Joy", "smile"],
  mouthCornerUpL: ["口角上げ左", "mouthSmileLeft"],
  mouthCornerUpR: ["口角上げ右", "mouthSmileRight"],
  mouthCornerDownL: ["口角下げ左", "mouthFrownLeft"],
  mouthCornerDownR: ["口角下げ右", "mouthFrownRight"],
  mouthWiden: ["口横広げ", "mouthStretch"],
  mouthNarrow: ["口横狭め", "mouthPucker"],
  mouthShiftRight: ["口右", "mouthRight"],
  mouthShiftLeft: ["口左", "mouthLeft"],
  mouthUp: ["口上"],
  mouthDown: ["口下"],
  mouthWidenL: ["口横広げ左", "mouthStretchLeft"],
  mouthWidenR: ["口横広げ右", "mouthStretchRight"],
  mouthNarrowL: ["口横狭め左"],
  mouthNarrowR: ["口横狭め右"],
  teethUp: ["齒上", "歯上", "齿上"],
  teethDown: ["齒下", "歯下", "齿下"],
  browAngry: ["怒り", "Fcl_BRW_Angry", "browDown_angry", "brow_angry"],
  browSerious: ["真面目", "Fcl_BRW_Fun", "brow_serious"],
  browSad: ["悲しい", "Fcl_BRW_Sorrow", "brow_sad"],
  browTroubled: ["困る", "browInnerUp", "brow_troubled"],
  browUp: ["上", "眉上", "browOuterUp", "brow_up"],
  browDown: ["下", "眉下", "browDown", "brow_down"],
  browAngryR: ["怒り右"],
};

export interface MorphAnalysis {
  map: Partial<Record<MorphSlot, string>>;
  available: Array<{ name: string; type: string; panel: number }>;
}

export function mapMorphs(rig: RigDescription): MorphAnalysis {
  const usable = rig.morphs.filter((m) => m.type === "vertex" || m.type === "bone" || m.type === "group");
  const byName = new Map<string, RigMorph>();
  for (const morph of usable) {
    if (!byName.has(morph.name)) byName.set(morph.name, morph);
  }
  const byEnglish = new Map<string, RigMorph>();
  for (const morph of usable) if (morph.englishName && !byEnglish.has(morph.englishName.toLowerCase())) byEnglish.set(morph.englishName.toLowerCase(), morph);
  const map: Partial<Record<MorphSlot, string>> = {};
  for (const slot of MORPH_SLOTS) {
    for (const wanted of MORPH_NAMES[slot]) {
      let hit: RigMorph | undefined;
      if (typeof wanted === "string") {
        hit = byName.get(wanted) ?? (wanted.length > 1 ? byEnglish.get(wanted.toLowerCase()) : undefined);
      } else {
        hit = usable.find((m) => wanted.test(m.name) || wanted.test(m.englishName));
      }
      // Brow "上"/"下" only count when on the brow panel, never a mouth morph.
      if (hit && (slot === "browUp" || slot === "browDown") && hit.panel !== 1 && hit.type !== "bone") hit = undefined;
      if (hit) {
        map[slot] = hit.name;
        break;
      }
    }
  }
  return { map, available: usable.map((m) => ({ name: m.name, type: m.type, panel: m.panel })) };
}

/** Mirror of src/character/config/types.ts MaterialRole. */
export type MaterialRoleName =
  | "skin" | "face" | "eyeWhite" | "iris" | "catchlight" | "eyeShadow" | "lash" | "brow" | "mouth" | "teeth" | "tongue"
  | "hair" | "frontHair" | "lightCloth" | "cloth" | "leather" | "metal" | "jewelry" | "accessory";

/** Ordered: the first rule matching a material name wins. */
const MATERIAL_RULES: Array<[RegExp, MaterialRoleName]> = [
  [/眼镜|眼鏡|メガネ|glasses|墨镜/i, "accessory"],
  // Fabric words first: "胸口布" (chest cloth) must not become a mouth
  // because it contains 口, nor "手套" (gloves) skin because it contains 手.
  [/手套|布|裙|裤|褲|袖|袜|襪|鞋|靴|glove|cloth|dress|skirt|sleeve|sock|shoe|boot/i, "cloth"],
  [/白目|眼白|eyewhite|sclera|eye_?white/i, "eyeWhite"],
  [/目光|ハイライト|highlight|eye_?hi|catchlight|星/i, "catchlight"],
  [/目影|眼影|eye_?shadow|二重影/i, "eyeShadow"],
  [/眉睫影|睫|まつ毛|まつげ|lash|二重|口线|口線|line/i, "lash"],
  [/眉|brow/i, "brow"],
  [/^(目|瞳|眼)|iris|pupil|^eye/i, "iris"],
  [/齿|歯|齒|teeth|tooth/i, "teeth"],
  [/^舌|tongue/i, "tongue"],
  [/口|mouth/i, "mouth"],
  [/颜|顔|脸|臉|表情|face|フェイス|痣/i, "face"],
  [/前髮|前髪|前发|bangs|fringe/i, "frontHair"],
  [/髮|髪|发|hair|ヘア/i, "hair"],
  [/肌|skin|皮肤|皮膚|身体|身體|^手\d*$|指甲|nail/i, "skin"],
  [/金属|metal|メタル/i, "metal"],
  [/宝石|珠宝|jewel|gem|结晶|crystal|水晶/i, "jewelry"],
  [/皮|leather|レザー/i, "leather"],
  [/墨镜|眼镜|glass|头饰|飾|饰|acc/i, "accessory"],
  [/衬衣|shirt|blouse|ブラウス/i, "lightCloth"],
];

export function mapMaterialRoles(rig: RigDescription): Partial<Record<MaterialRoleName, string[]>> {
  const roles: Partial<Record<MaterialRoleName, string[]>> = {};
  for (const material of rig.materials) {
    let role: MaterialRoleName = "cloth";
    for (const [pattern, candidate] of MATERIAL_RULES) {
      if (pattern.test(material.name) || (material.englishName && pattern.test(material.englishName))) {
        role = candidate;
        break;
      }
    }
    (roles[role] ??= []).push(material.name);
  }
  return roles;
}
