/**
 * Character configuration contract.
 *
 * Everything model-specific lives in a `CharacterConfig`. The runtime systems
 * (rendering, physics, face, animation, behaviour) read semantic names from
 * here and never reference a bone, morph or material by literal string.
 * Adding a new character means adding one config file - no engine changes.
 */

/** Semantic skeleton slots the animation systems drive. */
export interface BoneMap {
  root: string;
  center: string;
  groove?: string;
  waist?: string;
  lowerBody: string;
  upperBody: string;
  upperBody2?: string;
  neck: string;
  head: string;
  /** MMD's combined eye-control bone, if present. */
  eyes?: string;
  eyeL?: string;
  eyeR?: string;
  shoulderL: string;
  shoulderR: string;
  armL: string;
  armR: string;
  elbowL: string;
  elbowR: string;
  wristL: string;
  wristR: string;
  /** Optional finger chains used by expressive hand poses. */
  thumb0L?: string;
  thumb1L?: string;
  thumb2L?: string;
  index1L?: string;
  index2L?: string;
  index3L?: string;
  middle1L?: string;
  middle2L?: string;
  middle3L?: string;
  ring1L?: string;
  ring2L?: string;
  ring3L?: string;
  little1L?: string;
  little2L?: string;
  little3L?: string;
  thumb0R?: string;
  thumb1R?: string;
  thumb2R?: string;
  index1R?: string;
  index2R?: string;
  index3R?: string;
  middle1R?: string;
  middle2R?: string;
  middle3R?: string;
  ring1R?: string;
  ring2R?: string;
  ring3R?: string;
  little1R?: string;
  little2R?: string;
  little3R?: string;
  legL: string;
  legR: string;
  kneeL: string;
  kneeR: string;
  ankleL: string;
  ankleR: string;
}

/** Semantic morph slots. Any slot may be absent on a given model. */
export interface MorphMap {
  blink?: string;
  blinkL?: string;
  blinkR?: string;
  /** Happy, closed-arc "^^" eyes. */
  smileEyes?: string;
  eyesWideL?: string;
  eyesWideR?: string;
  eyesHalf?: string;
  eyesAngry?: string;
  eyesAngry2?: string;
  eyesSad?: string;
  eyeOuterDown?: string;
  lowerLidUp?: string;

  /** Vowel visemes used by the lip-sync engine. */
  visemeA?: string;
  visemeI?: string;
  visemeU?: string;
  visemeE?: string;
  visemeO?: string;
  /** Relaxed conversational mouth shape, softer than a full A. */
  visemeTalk?: string;

  mouthSmile?: string;
  mouthCornerUpL?: string;
  mouthCornerUpR?: string;
  mouthCornerDownL?: string;
  mouthCornerDownR?: string;
  mouthWiden?: string;
  mouthNarrow?: string;
  mouthShiftRight?: string;
  mouthShiftLeft?: string;
  mouthUp?: string;
  mouthDown?: string;
  mouthWidenL?: string;
  mouthWidenR?: string;
  mouthNarrowL?: string;
  mouthNarrowR?: string;
  teethUp?: string;
  teethDown?: string;

  browAngry?: string;
  browSerious?: string;
  browSad?: string;
  browTroubled?: string;
  browUp?: string;
  browDown?: string;
  browAngryR?: string;
}

/** How a material group should be shaded. */
export type MaterialRole =
  | 'skin'
  | 'face'
  | 'eyeWhite'
  | 'iris'
  | 'catchlight'
  | 'eyeShadow'
  | 'lash'
  | 'brow'
  | 'mouth'
  | 'teeth'
  | 'tongue'
  | 'hair'
  | 'frontHair'
  | 'lightCloth'
  | 'cloth'
  | 'leather'
  | 'metal'
  | 'jewelry'
  | 'accessory';

/**
 * Assigns materials to shading roles by exact PMX material name.
 * Anything unlisted falls back to `cloth`.
 */
export type MaterialRoleMap = Partial<Record<MaterialRole, string[]>>;

/**
 * How a material participates in depth and blending.
 *
 * 'opaque' - drawn in the opaque pass with an alpha-test cutout and depth
 *            writes. Correct for anything solid, including hair and lashes
 *            whose textures have alpha; depth sorting is then exact.
 * 'blend'  - drawn in the transparent pass without writing depth. Only for
 *            true overlays (eye catchlights, eye shadow) which must composite
 *            over the surface beneath them.
 *
 * Making everything 'blend' is the classic mistake: the transparent pass has
 * no reliable ordering between material groups of a single mesh, so the face,
 * brows, lashes and eye layers end up fighting each other.
 */
export type MaterialBlendMode = 'opaque' | 'blend';

/** Per-role shading parameters, layered on top of the engine defaults. */
export interface MaterialTuning {
  blend?: MaterialBlendMode;
  /** Cutout threshold. Lower values preserve thin shapes like eyelashes. */
  alphaTest?: number;
  /** Width of the light/shadow transition. 0 = hard cel step, 1 = painterly. */
  shadingSoftness?: number;
  /** How far the shadow side moves toward the shadow tint, 0..1. */
  shadowStrength?: number;
  /**
   * Colour the albedo is multiplied by in shadow.
   *
   * This is the heart of the anime look. Shadow is a HUE SHIFT, not just a
   * darkening: skin shadow goes warm and rosy, hair shadow goes deeper and
   * more saturated. Multiplying by a grey value instead is exactly what makes
   * a render read as a raw model import.
   */
  shadowTint?: number;
  /** Colour the albedo is multiplied by in full light. Usually near white. */
  lightTint?: number;
  /** Where the terminator sits on half-lambert, 0..1. Lower = more lit. */
  shadowMid?: number;
  /**
   * How much of each rig light's hue reaches this material, 0..1.
   *
   * Deliberately small. A light's colour is applied as a TINT, never as a
   * direct multiply, so a warm key can warm the image without stripping blue
   * out of the texture. Raising these trades colour accuracy for mood.
   */
  keyTint?: number;
  fillTint?: number;
  ambientTint?: number;
  rimTint?: number;
  hairTint?: number;
  /**
   * How white this material's specular and rim highlights may go, 0..1.
   *
   * 0 tints the highlight entirely by the surface colour; 1 makes it pure
   * white regardless of what it is sitting on. This is the main lever for
   * making materials respond differently: metal and jewellery reflect white,
   * cloth and skin keep their own colour. It is also a colour-accuracy
   * safeguard - a white highlight on near-black fabric is an albedo
   * independent floor, and lifts dark textures toward grey.
   */
  specularWhiteness?: number;
  rimWhiteness?: number;
  /**
   * How much cast shadow this material receives, 0..1.
   *
   * The face-priority control. Anime renderers deliberately shield the face
   * from full cast shadow, because bangs geometrically cover the eyes and at
   * full strength black out the character's focal point. Lowering this for
   * face and eyes keeps hair shadowing the body correctly while the face
   * stays legible - without altering the hairstyle or mesh.
   */
  shadowReceive?: number;
  /** Indirect light rising from below - lifts chin, jaw, neck and cheeks. */
  bounceStrength?: number;
  bounceColor?: number;
  bounceTint?: number;
  /**
   * Illumination floor this material can never fall below. On the face this
   * guarantees it never disappears into darkness.
   */
  minLight?: number;
  /** Gentle push toward a warm hue. Warms skin without lightening it. */
  warmth?: number;
  warmColor?: number;
  /** How much of the front fill's hue this material picks up. */
  frontFillTint?: number;
  /** Multiplies the camera-facing studio softbox for this material. */
  viewFillStrength?: number;
  /** Adds a camera-relative overhead softbox, useful for hair and shoulders. */
  viewTopStrength?: number;
  /**
   * Moves the material onto its lit toon tone using a camera-facing key.
   *
   * Unlike viewFillStrength, this changes the light/shadow ramp rather than
   * merely lifting the exposure. Primarily intended for front hair.
   */
  viewKeyStrength?: number;
  /**
   * Which lighting rig shades this material.
   *
   * 'face' switches to the dedicated camera-relative portrait rig, so the head
   * is lit by its own key, fill, overhead, rim and chin bounce rather than by
   * the body's world-space lights. This is how the face is kept beautiful from
   * every angle while the body stays grounded in the scene.
   */
  lightingRig?: 'body' | 'face';
  /** Extra darkening in the deepest part of the shadow, giving a third tone. */
  secondShadow?: number;
  rimStrength?: number;
  rimPower?: number;
  rimColor?: number;
  specularStrength?: number;
  specularPower?: number;
  /**
   * Adds a pair of camera-relative corneal reflections.
   *
   * Intended for irises only. Unlike the ordinary material specular, these
   * reflections are supplied by the face softboxes and remain visible inside
   * the bangs' cast shadow.
   */
  eyeReflectionStrength?: number;
  /** Scales an additive MMD sphere map (spa) contribution. */
  sphereStrength?: number;
  /** How strongly baked ambient occlusion darkens this role, 0..1. */
  aoStrength?: number;
  /**
   * Scales the material's base colour before lighting.
   *
   * Needed because toon shading applies nearly the full rig intensity to every
   * surface regardless of orientation, so a rig tuned for skin over-lights
   * small dark features - irises especially, which wash out to pale grey and
   * lose their colour entirely.
   */
  brightness?: number;
  /**
   * Saturation trim. Defaults to 1.0 - the texture's own colour is the
   * reference and is reproduced, not repainted.
   */
  saturation?: number;
  /**
   * Local-contrast S-curve strength, 0..1.
   *
   * Deepens darks and lifts lights about the midpoint WITHOUT moving overall
   * exposure. This is how depth is added; raising brightness only flattens
   * surfaces together.
   */
  localContrast?: number;
  /** Anisotropic strand highlight, used for hair. */
  anisotropicStrength?: number;
  anisotropicShift?: number;
  /** Emissive lift, used to keep eye catchlights bright under any lighting. */
  emissiveStrength?: number;
  /** Renders unlit at full texture colour. */
  unlit?: boolean;
  /** Subsurface-style warm bleed into the shadow terminator. */
  subsurfaceStrength?: number;
  subsurfaceColor?: number;
  outlineWidth?: number;
  outlineColor?: number;
}

/** A physics chain discovered from the model's rigid bodies. */
export interface PhysicsGroupTuning {
  /** Bone-name prefixes that belong to this group. */
  match: string[];
  /** Overall motion scale. Lower = more restrained. */
  amplitude?: number;
  stiffness?: number;
  damping?: number;
  /** How strongly the chain resists leaving its rest pose. */
  restPull?: number;
  /** Max degrees any joint may deviate from rest. Keeps motion tasteful. */
  maxAngleDeg?: number;
  gravityScale?: number;
  /** Multiplies inertia picked up from parent-bone movement. */
  inertiaScale?: number;
  enabled?: boolean;
}

export interface PhysicsConfig {
  /** Simulation rate in Hz. Fixed timestep for stability. */
  frequency: number;
  maxSubSteps: number;
  gravity: number;
  /** Global multiplier applied on top of every group's amplitude. */
  globalAmplitude: number;
  groups: Record<string, PhysicsGroupTuning>;
  /** Default tuning for dynamic bones matching no group. */
  fallback: PhysicsGroupTuning;
}

export interface CameraFraming {
  /** Bone the camera orbits and looks at. */
  targetBone: string;
  /** Vertical offset from that bone, in model units. */
  targetOffset: number;
  distance: number;
  fov: number;
  /** Camera height offset relative to the target. */
  heightOffset: number;
  /** Gentle parallax the camera applies to pointer movement, in radians. */
  parallax: number;
  minDistance: number;
  maxDistance: number;
}

/**
 * Dedicated face lighting rig - a portrait studio for the head alone.
 *
 * Defined entirely in VIEW SPACE, which is the point. A world-space rig lights
 * the face well from one angle only, and the bangs decide how much of it lands
 * on the eyes. Anchoring the face key to the camera means the portrait setup
 * travels with the viewer: whatever angle the character is seen from, the face
 * receives the same flattering three-quarter key, camera-axis fill, overhead
 * sheen and under-chin bounce. The front view is always the best view.
 *
 * The body keeps the world-space rig, so hair still casts real shadows and the
 * character still sits in a coherent environment - the face simply gets a
 * better-designed set of lights, as it does on a real shoot.
 */
export interface FaceLightingConfig {
  /** Key angle relative to the CAMERA, in degrees. */
  keyAzimuth: number;
  keyElevation: number;
  keyIntensity: number;
  keyColor: number;
  /** Camera-axis fill: guarantees the visible face is never in darkness. */
  fillIntensity: number;
  fillColor: number;
  /** Soft overhead light for forehead and cheekbone sheen. */
  topIntensity: number;
  topColor: number;
  /** Gentle edge light separating cheek and jaw from the background. */
  rimIntensity: number;
  rimColor: number;
  /** Bounce rising under the chin and jaw. */
  bounceIntensity: number;
  bounceColor: number;
}

export interface LightingConfig {
  keyIntensity: number;
  keyColor: number;
  /** Key light direction in spherical degrees around the character. */
  keyAzimuth: number;
  keyElevation: number;
  fillIntensity: number;
  fillColor: number;
  fillAzimuth: number;
  fillElevation: number;
  rimIntensity: number;
  rimColor: number;
  rimAzimuth: number;
  rimElevation: number;
  hairLightIntensity: number;
  hairLightColor: number;
  /**
   * Camera-relative front fill.
   *
   * A light permanently aimed along the view direction, so nothing the viewer
   * can see is ever in darkness. Being co-axial with the eye, it produces no
   * terminator, no cast shadow and no directional falloff - it is never
   * perceived as a light, it simply removes frontal darkness. It also re-aims
   * itself automatically as the camera orbits.
   */
  frontFillIntensity: number;
  frontFillColor: number;
  /** Dedicated portrait rig for the face and eyes. */
  face: FaceLightingConfig;
  ambientIntensity: number;
  ambientSkyColor: number;
  ambientGroundColor: number;
  /** Strength of the procedurally generated studio environment map. */
  environmentIntensity: number;
  shadow: {
    enabled: boolean;
    mapSize: number;
    radius: number;
    bias: number;
    normalBias: number;
    /** Shadow darkness; anime lighting wants these soft, never black. */
    opacity: number;
  };
}

export interface RenderConfig {
  exposure: number;
  /** Neutral tone mapping preserves anime flat colour better than ACES. */
  toneMapping: 'none' | 'neutral' | 'aces' | 'reinhard' | 'cineon';
  bloom: {
    enabled: boolean;
    strength: number;
    radius: number;
    threshold: number;
  };
  antialias: boolean;
  /** Upper bound on devicePixelRatio, to cap GPU cost on HiDPI screens. */
  maxPixelRatio: number;
  /** Frames per second target. The loop throttles to this. */
  targetFps: number;
}

export interface IdleConfig {
  breathRate: number;
  breathDepth: number;
  swayRate: number;
  swayAmount: number;
  /** Seconds between spontaneous posture shifts. */
  postureIntervalMin: number;
  postureIntervalMax: number;
  blinkIntervalMin: number;
  blinkIntervalMax: number;
  /** Chance a blink comes as a rapid double. */
  doubleBlinkChance: number;
  saccadeIntervalMin: number;
  saccadeIntervalMax: number;
}

export interface BehaviourConfig {
  /** Seconds between spontaneous behaviours while idle. */
  intervalMin: number;
  intervalMax: number;
  /** Behaviours are not repeated until this many others have played. */
  noRepeatWindow: number;
  /** Multiplies interval while the character is speaking or thinking. */
  busyIntervalScale: number;
}

export interface LipSyncConfig {
  /** Smoothing applied to the mouth opening, 0..1 per frame. */
  attack: number;
  release: number;
  /** Overall mouth openness scale. */
  gain: number;
  /** Below this normalised energy the mouth closes. */
  noiseFloor: number;
  /** Maximum morph weight any single viseme may reach. */
  maxWeight: number;
  /** How quickly visemes cross-fade into each other. */
  visemeBlendRate: number;
}

/** A rotation offset in radians about the bone's local axes. */
export interface PoseOffset {
  x?: number;
  y?: number;
  z?: number;
}

/**
 * Neutral standing pose, applied once at load.
 *
 * PMX models are authored in an A-pose with the arms held out, which is a
 * modelling convention, not a pose anyone stands in. MMD normally fixes this
 * with an animation clip; we bake a relaxed standing pose into the rest state
 * instead, so every later system (idle, behaviours, physics rest directions)
 * is expressed relative to a natural pose rather than a T-shape.
 */
export type BasePose = Partial<Record<keyof BoneMap, PoseOffset>>;

export interface CharacterConfig {
  id: string;
  displayName: string;
  /** URL of the staged model file (model.pmx / model.vrm / model.glb / …), served by the app. */
  modelUrl: string;
  /** URL of the textures.json map emitted by tools/stage-character.mjs. */
  textureMapUrl: string;
  /** Uniform scale applied to the loaded model. */
  scale: number;
  /** Y offset so the character's feet sit on the stage floor. */
  groundOffset: number;

  bones: BoneMap;
  /** Relaxed standing pose baked over the model's authored A-pose. */
  basePose?: BasePose;
  /**
   * Back-face expanded ink outline.
   *
   * Disabled by default. The technique assumes closed, consistently-wound
   * geometry; MMD models are largely single-sided (hair cards, coat panels,
   * face shell), so the expanded back faces land on top of the character and
   * paint over her instead of ringing her. Neither a depth bias nor draw
   * ordering reliably separates them. The implementation is kept because it
   * works on closed meshes and is worth revisiting per-material.
   */
  outline?: { enabled: boolean; scale?: number };
  morphs: MorphMap;
  materialRoles: MaterialRoleMap;
  materialTuning: Partial<Record<MaterialRole, MaterialTuning>>;

  camera: CameraFraming;
  lighting: LightingConfig;
  render: RenderConfig;
  physics: PhysicsConfig;
  idle: IdleConfig;
  behaviour: BehaviourConfig;
  lipSync: LipSyncConfig;

  /** Material names to hide entirely (props the companion shouldn't hold). */
  hiddenMaterials?: string[];
}
