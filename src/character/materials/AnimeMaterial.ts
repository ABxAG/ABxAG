/**
 * Anime character shading.
 *
 * Built on `MeshToonMaterial` so three.js keeps owning the parts that are
 * tedious and easy to break - skinning, morph targets, shadow receiving,
 * fog, tone mapping - while a shader injection adds the things that actually
 * make a character read as "anime" rather than "plastic Blender import":
 *
 *   - a proper MMD toon ramp with a lifted, softened terminator
 *   - Fresnel rim light biased toward the back light for silhouette separation
 *   - an art-directed Blinn-Phong specular driven by the key light
 *   - Kajiya-Kay anisotropic strand highlight for hair
 *   - warm subsurface bleed through the shadow terminator on skin
 *   - MMD sphere maps (spa additive / sph multiply)
 *
 * All light directions come from `animeShaderGlobals`, a single shared uniform
 * block the lighting rig refreshes once per frame, so every material stays in
 * sync with the lighting setup without per-material bookkeeping.
 */
import * as THREE from 'three';
import type { MaterialRole, MaterialTuning } from '../config/types';
import type { RawPmxMaterial } from '../loaders/PmxLoader';
import { createDefaultRamp, createToonRamp } from './ToonRamp';
import { ENV_RANGE, getStudioEnvironment, studioEnvironmentMaxMip } from './StudioEnvironment';

/**
 * Uniforms shared by every anime material, republished once per frame by the
 * lighting rig. The shader below does its own light accumulation, so these
 * carry direction AND intensity-weighted colour for each rig light.
 */
export const animeShaderGlobals = {
  uKeyDirView: { value: new THREE.Vector3(0, 0, 1) },
  uFillDirView: { value: new THREE.Vector3(0, 0, 1) },
  uRimDirView: { value: new THREE.Vector3(0, 0, -1) },
  uHairDirView: { value: new THREE.Vector3(0, 1, 0) },
  uUpView: { value: new THREE.Vector3(0, 1, 0) },

  // Light HUES, used only as gentle tints - never as direct multipliers.
  uKeyColor: { value: new THREE.Color(1, 1, 1) },
  uFillColor: { value: new THREE.Color(1, 1, 1) },
  uRimLightColor: { value: new THREE.Color(1, 1, 1) },
  uHairLightColor: { value: new THREE.Color(1, 1, 1) },
  uAmbientSky: { value: new THREE.Color(1, 1, 1) },
  uAmbientGround: { value: new THREE.Color(1, 1, 1) },

  // Light LEVELS, as scalar fractions relative to the key (which is 1.0).
  // Separating level from hue is what keeps the render colour-accurate: the
  // brightness maths happens in scalars, so a light's colour can never drag
  // the whole image toward its own hue.
  uFillLevel: { value: 0.2 },
  uAmbientLevel: { value: 0.15 },
  uRimLevel: { value: 0.14 },
  uHairLevel: { value: 0.1 },
  /**
   * Camera-relative front fill. Always aimed along the view direction, so it
   * guarantees nothing the viewer can see falls into darkness, while being
   * invisible as a light source (no terminator, no shadow, no falloff).
   */
  uFrontFillLevel: { value: 0.22 },
  uFrontFillColor: { value: new THREE.Color(1, 1, 1) },

  // ---- dedicated face rig, entirely in VIEW SPACE -------------------------
  //
  // These directions are camera-relative constants, so the portrait setup
  // travels with the viewer. The face is lit the same flattering way from
  // every angle, and the front view is always the best view.
  uFaceKeyDirView: { value: new THREE.Vector3(-0.36, 0.31, 0.88) },
  uFaceKeyColor: { value: new THREE.Color(1, 1, 1) },
  uFaceTopDirView: { value: new THREE.Vector3(0, 0.94, 0.33) },
  uFaceTopColor: { value: new THREE.Color(1, 1, 1) },
  uFaceRimDirView: { value: new THREE.Vector3(0.5, 0.35, -0.79) },
  uFaceRimColor: { value: new THREE.Color(1, 1, 1) },
  uFaceBounceColor: { value: new THREE.Color(1, 1, 1) },
  uFaceFillColor: { value: new THREE.Color(1, 1, 1) },
  uFaceKeyLevel: { value: 0.62 },
  uFaceFillLevel: { value: 0.4 },
  uFaceTopLevel: { value: 0.18 },
  uFaceRimLevel: { value: 0.16 },
  uFaceBounceLevel: { value: 0.2 },

  // ---- realism path ---------------------------------------------------------
  // 0 = the art-directed anime look; 1 = physically based shading with skin
  // subsurface, fabric sheen and studio reflections. Shared by every material
  // so one setting moves the whole character.
  uRealism: { value: 0 },
  uEnvMap: { value: null as THREE.Texture | null },
  uEnvMaxMip: { value: 8 },
  uEnvIntensity: { value: 1 },
  /** Key-light level in the realism path, relative to the environment. */
  uRealKey: { value: 1.05 },
};

/**
 * Physical surface description per role, used only by the realism path.
 * Roughness/F0/metalness follow common PBR references; sheen is the soft
 * grazing-angle glow of fabric fibres; sss is how far light bleeds through
 * the shadow edge (skin), from 0 (none) to 1 (strong).
 */
const SURFACE: Record<MaterialRole, { roughness: number; f0: number; metal: number; sheen: number; sheenRough: number; sss: number }> = {
  skin: { roughness: 0.5, f0: 0.028, metal: 0, sheen: 0.08, sheenRough: 0.6, sss: 1 },
  face: { roughness: 0.48, f0: 0.028, metal: 0, sheen: 0.06, sheenRough: 0.6, sss: 0.9 },
  eyeWhite: { roughness: 0.18, f0: 0.03, metal: 0, sheen: 0, sheenRough: 0.5, sss: 0.4 },
  iris: { roughness: 0.06, f0: 0.04, metal: 0, sheen: 0, sheenRough: 0.5, sss: 0 },
  catchlight: { roughness: 0.1, f0: 0.04, metal: 0, sheen: 0, sheenRough: 0.5, sss: 0 },
  eyeShadow: { roughness: 0.9, f0: 0.02, metal: 0, sheen: 0, sheenRough: 0.5, sss: 0.3 },
  lash: { roughness: 0.8, f0: 0.03, metal: 0, sheen: 0, sheenRough: 0.5, sss: 0 },
  brow: { roughness: 0.8, f0: 0.03, metal: 0, sheen: 0, sheenRough: 0.5, sss: 0 },
  mouth: { roughness: 0.32, f0: 0.03, metal: 0, sheen: 0, sheenRough: 0.5, sss: 0.7 },
  teeth: { roughness: 0.25, f0: 0.04, metal: 0, sheen: 0, sheenRough: 0.5, sss: 0.3 },
  tongue: { roughness: 0.3, f0: 0.03, metal: 0, sheen: 0, sheenRough: 0.5, sss: 0.7 },
  hair: { roughness: 0.42, f0: 0.046, metal: 0, sheen: 0.18, sheenRough: 0.45, sss: 0.15 },
  frontHair: { roughness: 0.42, f0: 0.046, metal: 0, sheen: 0.18, sheenRough: 0.45, sss: 0.15 },
  lightCloth: { roughness: 0.78, f0: 0.035, metal: 0, sheen: 0.55, sheenRough: 0.5, sss: 0.12 },
  cloth: { roughness: 0.72, f0: 0.04, metal: 0, sheen: 0.7, sheenRough: 0.42, sss: 0 },
  leather: { roughness: 0.36, f0: 0.05, metal: 0, sheen: 0.12, sheenRough: 0.4, sss: 0 },
  metal: { roughness: 0.26, f0: 0.9, metal: 1, sheen: 0, sheenRough: 0.5, sss: 0 },
  jewelry: { roughness: 0.14, f0: 0.95, metal: 1, sheen: 0, sheenRough: 0.5, sss: 0 },
  accessory: { roughness: 0.5, f0: 0.045, metal: 0, sheen: 0.25, sheenRough: 0.5, sss: 0 },
};

function ensureEnvironment(): void {
  if (animeShaderGlobals.uEnvMap.value) return;
  animeShaderGlobals.uEnvMap.value = getStudioEnvironment();
  animeShaderGlobals.uEnvMaxMip.value = studioEnvironmentMaxMip();
}

/** Set the shared realism amount (0..1) for every character material. */
export function setCharacterRealism(amount: number): void {
  ensureEnvironment();
  animeShaderGlobals.uRealism.value = THREE.MathUtils.clamp(amount, 0, 1);
}

/**
 * Build a colour that will be used as a MULTIPLIER on texture colour.
 *
 * three interprets `new THREE.Color(hex)` as sRGB and converts it to the
 * linear working space, which is right for a light's colour but wrong for a
 * multiplier: 0xd98f89 looks like a soft dusty rose but lands as
 * (0.70, 0.28, 0.25) in linear, crushing green and blue to a quarter.
 *
 * Declaring the hex as already-linear makes the authored value behave the way
 * it looks - 0xd98f89 multiplies by (0.851, 0.561, 0.537).
 */
function multiplierColor(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
}

const DEFAULTS: Required<
  Pick<
    MaterialTuning,
    | 'shadingSoftness'
    | 'shadowStrength'
    | 'rimStrength'
    | 'rimPower'
    | 'rimColor'
    | 'specularStrength'
    | 'specularPower'
    | 'emissiveStrength'
  >
> = {
  shadingSoftness: 0.6,
  shadowStrength: 0.38,
  rimStrength: 0.35,
  rimPower: 3,
  rimColor: 0xffffff,
  specularStrength: 0.1,
  specularPower: 24,
  emissiveStrength: 0,
};

/** PMX material flag bits. */
const MaterialFlag = { DoubleSided: 0x01, CastShadow: 0x04, ReceiveShadow: 0x08, DrawEdge: 0x10 };

export interface AnimeMaterialResult {
  material: THREE.Material;
  role: MaterialRole;
}

function configureTexture(texture: THREE.Texture, anisotropy: number): THREE.Texture {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

/**
 * Create the shaded material for one PMX material slot.
 *
 * Toon ramps load asynchronously; the material starts with a neutral ramp and
 * upgrades in place the moment the real one decodes.
 */
export function createAnimeMaterial(
  raw: RawPmxMaterial,
  role: MaterialRole,
  tuning: MaterialTuning,
  textureLoader: THREE.TextureLoader,
  maxAnisotropy: number,
  forceDoubleSided = true
): THREE.Material {
  // Render double-sided unless the config explicitly opts out.
  //
  // PMX exposes a per-material "double sided" flag, but honouring it strictly
  // does not work: MMD models are assembled from parts authored separately and
  // their triangle winding is not consistent between them. On this model the
  // body winds one way and much of the face the other, so single-sided culling
  // silently deletes the upper face - eyes, brows and all - leaving a dark
  // hole that the eye layers then draw into. Double-siding costs one extra
  // raster pass on a 32k-triangle mesh and makes the model render as authored.
  const side = forceDoubleSided
    ? THREE.DoubleSide
    : (raw.flag & MaterialFlag.DoubleSided) !== 0
      ? THREE.DoubleSide
      : THREE.FrontSide;

  const map = raw.mapUrl
    ? configureTexture(textureLoader.load(raw.mapUrl), maxAnisotropy)
    : null;

  const baseColor = new THREE.Color(raw.diffuse[0], raw.diffuse[1], raw.diffuse[2]);
  if (tuning.brightness !== undefined) baseColor.multiplyScalar(tuning.brightness);
  const opacity = raw.diffuse[3];

  // Every material is alpha-blended with a low cutout AND still writes depth.
  //
  // This is what MMD itself does, and it is the only configuration that
  // renders this model's face correctly. The face is built from near-coplanar
  // sheets (sclera, iris, catchlights, eye shadow, lashes, brows, teeth)
  // stacked a fraction of a millimetre apart. Two tempting alternatives both
  // fail badly here:
  //
  //   opaque + alphaTest 0.5  - the hard cutout eats soft lash and brow edges
  //                             and the coplanar layers z-fight into a smear
  //   blended + depthWrite off - inner geometry (teeth, eye shadow) is no
  //                             longer occluded and punches through the face
  //
  // Keeping depth writes on lets the layers occlude each other properly, while
  // the low alphaTest discards only genuinely empty texels. Only true overlays
  // that must composite over what is beneath them opt out of depth writing.
  const isOverlay = tuning.blend === 'blend';
  const depthSettings = {
    transparent: true,
    opacity,
    alphaTest: tuning.alphaTest ?? 0.02,
    depthWrite: !isOverlay,
  };

  // Catchlights and other unlit slots bypass shading entirely so they stay
  // bright and clean regardless of how the character is lit.
  if (tuning.unlit) {
    const basic = new THREE.MeshBasicMaterial({
      map: map ?? undefined,
      color: baseColor,
      side,
      toneMapped: false,
      ...depthSettings,
    });
    basic.name = raw.name;
    return basic;
  }

  const material = new THREE.MeshToonMaterial({
    map: map ?? undefined,
    color: baseColor,
    side,
    gradientMap: createDefaultRamp({
      softness: tuning.shadingSoftness ?? DEFAULTS.shadingSoftness,
      shadowStrength: tuning.shadowStrength ?? DEFAULTS.shadowStrength,
    }),
    ...depthSettings,
  });
  material.name = raw.name;

  // Swap in the model's authored ramp once it decodes.
  void createToonRamp(raw.toonUrl, {
    softness: tuning.shadingSoftness ?? DEFAULTS.shadingSoftness,
    shadowStrength: tuning.shadowStrength ?? DEFAULTS.shadowStrength,
    terminator: role === 'skin' || role === 'face' ? 10 : 6,
  }).then((ramp) => {
    material.gradientMap?.dispose();
    material.gradientMap = ramp;
    material.needsUpdate = true;
  });

  const sphereMap =
    raw.sphereUrl && raw.sphereMode > 0
      ? configureTexture(textureLoader.load(raw.sphereUrl), maxAnisotropy)
      : null;

  const useAnisotropic = (tuning.anisotropicStrength ?? 0) > 0;
  const useSubsurface = (tuning.subsurfaceStrength ?? 0) > 0;
  // Face and eyes run on the dedicated camera-relative portrait rig.
  const useFaceRig = tuning.lightingRig === 'face';
  const useEyeReflections = (tuning.eyeReflectionStrength ?? 0) > 0;
  const sphereMode = sphereMap ? raw.sphereMode : 0;

  const surface = SURFACE[role] ?? SURFACE.cloth;
  ensureEnvironment();
  const uniforms = {
    ...animeShaderGlobals,
    uRoughness: { value: surface.roughness },
    uF0: { value: surface.f0 },
    uMetalness: { value: surface.metal },
    uSheen: { value: surface.sheen },
    uSheenRough: { value: surface.sheenRough },
    uSss: { value: surface.sss },
    // Runtime art-direction control for reflected light only. A value of 1.0
    // preserves the authored look; diffuse light, shadows and exposure never
    // pass through this multiplier.
    uReflectionStrength: { value: 1 },
    uRimStrength: { value: tuning.rimStrength ?? DEFAULTS.rimStrength },
    uRimPower: { value: tuning.rimPower ?? DEFAULTS.rimPower },
    uRimColor: { value: new THREE.Color(tuning.rimColor ?? DEFAULTS.rimColor) },
    uSpecularStrength: { value: tuning.specularStrength ?? DEFAULTS.specularStrength },
    uSpecularPower: { value: tuning.specularPower ?? DEFAULTS.specularPower },
    uEyeReflectionStrength: { value: tuning.eyeReflectionStrength ?? 0 },
    uEmissiveStrength: { value: tuning.emissiveStrength ?? DEFAULTS.emissiveStrength },
    uAnisotropicStrength: { value: tuning.anisotropicStrength ?? 0 },
    uAnisotropicShift: { value: tuning.anisotropicShift ?? 0 },
    uSubsurfaceStrength: { value: tuning.subsurfaceStrength ?? 0 },
    uSubsurfaceColor: { value: new THREE.Color(tuning.subsurfaceColor ?? 0xff8f6b) },
    uSphereMap: { value: sphereMap },
    uSphereStrength: { value: tuning.sphereStrength ?? 0.45 },
    uAoStrength: { value: tuning.aoStrength ?? 0.55 },
    // Defaults to 1.0: the texture's colour is reproduced, not repainted.
    uSaturation: { value: tuning.saturation ?? 1 },
    uLocalContrast: { value: tuning.localContrast ?? 0.22 },
    // Two-tone shading controls. Built as MULTIPLIERS, so the authored hex
    // behaves the way it looks rather than being sRGB-decoded first.
    uShadowTint: { value: multiplierColor(tuning.shadowTint ?? 0xb9a2a6) },
    uLightTint: { value: multiplierColor(tuning.lightTint ?? 0xffffff) },
    // How much of each light's hue reaches the surface. Small by design.
    uKeyTint: { value: tuning.keyTint ?? 0.18 },
    uFillTint: { value: tuning.fillTint ?? 0.35 },
    uAmbientTint: { value: tuning.ambientTint ?? 0.25 },
    uRimTint: { value: tuning.rimTint ?? 0.3 },
    uHairTint: { value: tuning.hairTint ?? 0.3 },
    // How white a highlight is allowed to go, independent of the surface.
    // Metal and jewellery want near-white; cloth and skin want the highlight
    // to stay their own colour so dark fabric cannot be lifted to grey.
    uSpecWhiteness: { value: tuning.specularWhiteness ?? 0.4 },
    uRimWhiteness: { value: tuning.rimWhiteness ?? 0.3 },
    // Face-priority and bounce controls.
    uShadowReceive: { value: tuning.shadowReceive ?? 1 },
    uBounceLevel: { value: tuning.bounceStrength ?? 0.1 },
    uBounceColor: { value: multiplierColor(tuning.bounceColor ?? 0xffd9bb) },
    uBounceTint: { value: tuning.bounceTint ?? 0.4 },
    uMinLight: { value: tuning.minLight ?? 0 },
    uWarmColor: { value: multiplierColor(tuning.warmColor ?? 0xffd4b0) },
    uWarmth: { value: tuning.warmth ?? 0 },
    uFrontFillTint: { value: tuning.frontFillTint ?? 0.25 },
    uViewFillStrength: { value: tuning.viewFillStrength ?? 1 },
    uViewTopStrength: { value: tuning.viewTopStrength ?? 0 },
    // Every non-face material receives a camera-facing studio key by default.
    // The face has its own portrait rig; individual body roles may override.
    uViewKeyStrength: { value: tuning.viewKeyStrength ?? (useFaceRig ? 0 : 0.82) },
    uShadowMid: { value: tuning.shadowMid ?? 0.5 },
    uShadowSoft: { value: tuning.shadingSoftness ?? DEFAULTS.shadingSoftness },
    uShadowDepth: { value: tuning.shadowStrength ?? DEFAULTS.shadowStrength },
    uSecondShadow: { value: tuning.secondShadow ?? 0.35 },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // Carry the baked per-vertex AO through to the fragment stage.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aoValue;\nvarying float vBakedAo;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvBakedAo = aoValue;'
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform vec3 uKeyDirView;
        uniform vec3 uKeyColor;
        uniform vec3 uFillDirView;
        uniform vec3 uFillColor;
        uniform vec3 uRimDirView;
        uniform vec3 uRimLightColor;
        uniform vec3 uHairDirView;
        uniform vec3 uHairLightColor;
        uniform vec3 uAmbientSky;
        uniform vec3 uAmbientGround;
        uniform vec3 uUpView;
        uniform float uFillLevel;
        uniform float uAmbientLevel;
        uniform float uRimLevel;
        uniform float uHairLevel;
        uniform float uKeyTint;
        uniform float uFillTint;
        uniform float uAmbientTint;
        uniform float uRimTint;
        uniform float uHairTint;
        uniform float uSpecWhiteness;
        uniform float uRimWhiteness;
        uniform float uShadowReceive;
        uniform float uBounceLevel;
        uniform vec3 uBounceColor;
        uniform float uBounceTint;
        uniform float uMinLight;
        uniform vec3 uWarmColor;
        uniform float uWarmth;
        uniform float uFrontFillLevel;
        uniform vec3 uFrontFillColor;
        uniform float uFrontFillTint;
        uniform float uViewFillStrength;
        uniform float uViewTopStrength;
        uniform float uViewKeyStrength;
        #ifdef USE_FACE_RIG
          uniform vec3 uFaceKeyDirView;
          uniform vec3 uFaceKeyColor;
          uniform vec3 uFaceTopDirView;
          uniform vec3 uFaceTopColor;
          uniform vec3 uFaceRimDirView;
          uniform vec3 uFaceRimColor;
          uniform vec3 uFaceBounceColor;
          uniform vec3 uFaceFillColor;
          uniform float uFaceKeyLevel;
          uniform float uFaceFillLevel;
          uniform float uFaceTopLevel;
          uniform float uFaceRimLevel;
          uniform float uFaceBounceLevel;
        #endif
        uniform vec3 uShadowTint;
        uniform vec3 uLightTint;
        uniform float uShadowMid;
        uniform float uShadowSoft;
        uniform float uShadowDepth;
        uniform float uSecondShadow;
        uniform float uRimStrength;
        uniform float uRimPower;
        uniform vec3 uRimColor;
        uniform float uSpecularStrength;
        uniform float uSpecularPower;
        uniform float uEyeReflectionStrength;
        uniform float uEmissiveStrength;
        uniform float uAnisotropicStrength;
        uniform float uAnisotropicShift;
        uniform float uSubsurfaceStrength;
        uniform vec3 uSubsurfaceColor;
        uniform float uAoStrength;
        uniform float uSaturation;
        uniform float uLocalContrast;
        uniform float uReflectionStrength;
        uniform float uRealism;
        uniform sampler2D uEnvMap;
        uniform float uEnvMaxMip;
        uniform float uEnvIntensity;
        uniform float uRealKey;
        uniform float uRoughness;
        uniform float uF0;
        uniform float uMetalness;
        uniform float uSheen;
        uniform float uSheenRough;
        uniform float uSss;
        varying float vBakedAo;

        // Equirectangular lookup matching StudioEnvironment's layout.
        vec3 envSample( vec3 dirWorld, float lod ) {
          vec3 d = normalize( dirWorld );
          float u = atan( d.x, d.z ) * ( 0.5 / PI );
          float v = acos( clamp( d.y, -1.0, 1.0 ) ) / PI;
          return textureLod( uEnvMap, vec2( fract( u ), v ), lod ).rgb * ${ENV_RANGE.toFixed(1)};
        }
        #if SPHERE_MODE > 0
          uniform sampler2D uSphereMap;
          uniform float uSphereStrength;
        #endif
        `
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        {
          vec3 V = normalize( vViewPosition );
          float NdotV = clamp( dot( normal, V ), 0.0, 1.0 );

          // The face runs on its own portrait rig, anchored to the camera.
          // Everything downstream - terminator, specular, subsurface - is
          // driven from this one direction, so the face is shaped by its own
          // key rather than by the body's world-space light.
          #ifdef USE_FACE_RIG
            vec3 keyDir = uFaceKeyDirView;
            vec3 keyHue = uFaceKeyColor;
          #else
            vec3 keyDir = uKeyDirView;
            vec3 keyHue = uKeyColor;
          #endif

          vec3 H = normalize( keyDir + V );
          float NdotH = clamp( dot( normal, H ), 0.0, 1.0 );

          // ---- two-tone anime shading -------------------------------------
          //
          // This REPLACES three's toon accumulation rather than adding to it.
          // A grayscale ramp multiplied over albedo - which is what the toon
          // material does - is exactly what makes a model read as a flat PMX
          // import: the shadow is just a darker copy of the lit colour.
          //
          // Real anime shading shifts HUE into shadow. Skin shadow goes warm
          // and rosy, hair shadow goes deeper and more saturated. So the lit
          // and shadow sides are computed as separately tinted copies of the
          // albedo and cross-faded across a controlled terminator.
          vec3 albedo = diffuseColor.rgb;

          // Half-lambert keeps the unlit hemisphere readable instead of black.
          float NdotL = dot( normal, keyDir );
          float halfLambert = NdotL * 0.5 + 0.5;

          // Baked contact occlusion, and the cast shadow from the key light.
          //
          // MeshToonMaterial does not expose getShadowMask(), so the key
          // light's shadow map is sampled directly. The key is the rig's only
          // caster, so it is always directional shadow 0.
          float ao = mix( 1.0, clamp( vBakedAo, 0.0, 1.0 ), uAoStrength );
          float shadowMask = 1.0;
          #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
          {
            DirectionalLightShadow keyShadow = directionalLightShadows[ 0 ];
            shadowMask = getShadow(
              directionalShadowMap[ 0 ],
              keyShadow.shadowMapSize,
              keyShadow.shadowIntensity,
              keyShadow.shadowBias,
              keyShadow.shadowRadius,
              vDirectionalShadowCoord[ 0 ]
            );
          }
          #endif

          // Per-material shadow receive.
          //
          // The single most important control for face priority, and what
          // every anime game renderer does: the face does NOT take full cast
          // shadow. Bangs geometrically cover the eyes, so at full strength
          // they drop a hard mask over the most important part of the
          // character. Attenuating the shadow ON THE FACE ONLY keeps hair
          // casting properly onto the body while the face stays readable -
          // without touching the hairstyle or the mesh.
          shadowMask = mix( 1.0, shadowMask, uShadowReceive );

          // Primary terminator - the anime "line of light".
          //
          // Sampled from the model's OWN authored toon ramp (skin.bmp,
          // hair.bmp, toon_defo.bmp) where one exists, so the artist's
          // intended shading break is what drives the shading. Only when a
          // material ships no ramp do we synthesise one.
          float lightFactor;
          #ifdef USE_GRADIENTMAP
            float rampU = clamp(
              ( halfLambert - uShadowMid ) / max( uShadowSoft, 0.001 ) * 0.5 + 0.5,
              0.0, 1.0
            );
            lightFactor = texture2D( gradientMap, vec2( rampU, 0.5 ) ).r;
          #else
            lightFactor = smoothstep(
              uShadowMid - uShadowSoft * 0.5,
              uShadowMid + uShadowSoft * 0.5,
              halfLambert
            );
          #endif
          // Cast shadows and occlusion push a surface into the shadow tone.
          lightFactor *= shadowMask;
          lightFactor *= mix( 1.0, ao, 0.75 );

          // CAMERA-FACING BEAUTY KEY.
          //
          // This is different from adding fill after the fact. Fill can make a
          // dark shadow brighter, but it is still the shadow TONE. A frontal
          // anime hair light must move the visible bangs onto their authored
          // lit tone. It is slightly above and camera-left so the strands keep
          // a soft directional gradient rather than becoming a flat helmet.
          vec3 viewKeyDir = normalize( vec3( -0.16, 0.24, 0.96 ) );
          float viewHalfLambert = dot( normal, viewKeyDir ) * 0.5 + 0.5;
          float viewKeyFactor = smoothstep(
            uShadowMid - uShadowSoft * 0.55,
            uShadowMid + uShadowSoft * 0.55,
            viewHalfLambert
          );
          // A large frontal softbox wraps across every surface visible to the
          // camera. This prevents sideways-authored MMD normals from leaving
          // an entire bang, sleeve or torso panel in the world key's shadow.
          float viewWrap = 0.84 + 0.16 * pow( NdotV, 0.45 );
          viewKeyFactor = max( viewKeyFactor, viewWrap );
          // AO still separates layered strands, but the world key's shadow
          // cannot force the entire camera-facing fringe into darkness.
          viewKeyFactor *= mix( 1.0, ao, 0.22 );
          lightFactor = max(
            lightFactor,
            viewKeyFactor * uViewKeyStrength
          );

          // ---- illumination LEVEL (scalar) --------------------------------
          //
          // Brightness is computed entirely in scalars, and normalised so a
          // fully-lit surface receives exactly 1.0. That is the guarantee that
          // the texture is reproduced faithfully: never darkened, never
          // clipped, and - because no colour is involved here - never tinted.
          //
          // Keeping level and hue separate is the fix for the previous bug,
          // where each light's colour multiplied the texture directly. The key
          // light's linear colour was (1.00, 0.87, 0.72), so every lit pixel
          // lost 28% of its blue and the whole render skewed orange. Exposure
          // could not correct that; it scaled all three channels equally.
          float fillFactor = clamp( dot( normal, uFillDirView ) * 0.5 + 0.5, 0.0, 1.0 );
          float up = dot( normal, uUpView ) * 0.5 + 0.5;
          float rimFacing = clamp( dot( normal, uRimDirView ), 0.0, 1.0 );
          float hairFacing = clamp( dot( normal, uHairDirView ), 0.0, 1.0 );

          // Direct light from the key. Ambient occlusion must NOT attenuate
          // this: AO models self-occlusion of INDIRECT light. A direct light
          // is either blocked or it is not, and that is the shadow map's job,
          // which is already folded into lightFactor. Multiplying direct light
          // by AO darkened the entire character by roughly a fifth uniformly -
          // it was the main reason the render sat below its own texture.
          // A small amount is retained purely for contact darkening.
          float direct = lightFactor * mix( 1.0, ao, 0.25 );

          // Bounce light: soft indirect rising from below, as light reflecting
          // off the chest and floor would. Gated on downward-facing normals so
          // it lands exactly where a real bounce lands - under the chin, along
          // the jawline, the underside of the cheeks and the neck - lifting
          // those out of darkness without erasing the shadow shape above them.
          float bounceFacing = clamp( -dot( normal, uUpView ), 0.0, 1.0 );

          // CAMERA-RELATIVE FRONT FILL.
          //
          // A light that always points along the view direction, so whatever
          // the viewer can see is never in darkness. In view space the vector
          // toward the camera is simply +Z, so a surface's facing ratio is its
          // own view-space normal.z - no uniform direction needed, and it
          // re-aims itself for free as the camera orbits.
          //
          // Because it is perfectly co-axial with the eye it produces no
          // visible terminator, no cast shadow and no directional falloff, so
          // it is never perceived AS a light. It only removes front darkness.
          // NdotV is more reliable than normal.z on MMD faces. Their layered,
          // double-sided cards do not all share the same winding, while NdotV
          // always describes the surface actually visible to the camera.
          float frontFacing = clamp( NdotV, 0.0, 1.0 );
          // A large portrait softbox wraps rather than switching off at the
          // edge. Keep a small directional variation so the fill opens the
          // shadows without turning the face into a flat disc.
          frontFacing = 0.42 + 0.58 * pow( frontFacing, 0.45 );
          vec3 viewTopDir = normalize( vec3( 0.0, 0.82, 0.57 ) );
          float viewTopFacing = smoothstep(
            -0.12, 0.82, dot( normal, viewTopDir )
          );

          #ifdef USE_FACE_RIG
            // ---- portrait indirect, all camera-relative --------------------
            //
            // A photographer lighting a face does not rely on whatever the
            // room bounces back; they place a fill, a hair light and a
            // reflector under the chin. This does the same, in view space, so
            // the setup holds from any viewing angle:
            //
            //   fill   - broad camera-axis source, guarantees eyes, cheeks and
            //            forehead stay readable THROUGH the bangs' shadow
            //   top    - subtle overhead sheen on forehead and cheekbones
            //   rim    - gentle edge separating cheek and jaw from background
            //   bounce - reflector under the chin, lifting jaw and throat
            //
            // The hair shadow is deliberately still there; the fill simply
            // sits above the level at which it would swallow the face.
            float faceTopFacing = smoothstep(
              -0.18, 0.78, dot( normal, uFaceTopDirView )
            );
            float faceRimFacing = pow(
              clamp( dot( normal, uFaceRimDirView ) * 0.5 + 0.5, 0.0, 1.0 ),
              2.2
            ) * pow( 1.0 - NdotV, 1.35 );
            // The fill is deliberately strongest where the key's shadow map
            // says the bangs are blocking the face. It does not erase that
            // shadow: lightFactor still controls the anime shadow tone and
            // the face key. It merely keeps the shadow from swallowing the
            // forehead, eyes and cheeks.
            float shadowFill = mix( 1.0, 1.28, 1.0 - shadowMask );
            float indirect = uFaceFillLevel * frontFacing * shadowFill
              + uFaceTopLevel * faceTopFacing
              + uFaceRimLevel * faceRimFacing
              + uFaceBounceLevel * pow( bounceFacing, 0.65 )
              + uAmbientLevel * 0.38;
            // The face takes only light occlusion: creases should read as
            // softness, never as dirt.
            indirect *= mix( 1.0, ao, 0.28 );
          #else
            // Indirect light - fill, ambient, bounce and the wrap-around back
            // lights. This is what AO legitimately occludes.
            float indirect = uFillLevel * fillFactor * ( 1.0 - lightFactor )
              + uAmbientLevel
              + uBounceLevel * bounceFacing
              + uRimLevel * rimFacing
              + uHairLevel * hairFacing;
            indirect *= ao;
          #endif
          #ifdef USE_FACE_RIG
            // Face levels are authored as a self-contained studio exposure.
            // Do not add the body's front fill here: the dedicated camera
            // softbox above replaces it and keeps body lighting independent.
            float level = direct * uFaceKeyLevel + indirect;
            // The old implementation floored INDIRECT and then divided it,
            // so a requested 0.70 floor could become less than 0.60 on screen.
            // Floor the final face exposure instead. A soft ceiling protects
            // the original texture colours from clipping.
            level = clamp( level, uMinLight, 1.04 );
          #else
            // The body keeps its existing invisible front fill and its exact
            // normalization; none of the portrait changes alter body light.
            float beautyFill = frontFacing * uViewFillStrength
              + viewTopFacing * uViewTopStrength;
            indirect += uFrontFillLevel * beautyFill * mix( 1.0, ao, 0.28 );
            indirect = max( indirect, uMinLight );
            // Key + ambient is full body illumination by definition.
            float level = ( direct + indirect ) / ( 1.0 + uAmbientLevel );
          #endif

          // ---- illumination HUE -------------------------------------------
          //
          // Shadow is a hue shift of the texture, with a deeper core band so
          // the shading has three tones rather than a flat two-step. The lit
          // side stays neutral so the texture reads as authored.
          float coreFactor = smoothstep( 0.0, uShadowMid, halfLambert * shadowMask );
          vec3 shadeTint = uShadowTint * mix( 1.0 - uSecondShadow, 1.0, coreFactor );
          vec3 tint = mix( mix( vec3( 1.0 ), shadeTint, uShadowDepth ), uLightTint, lightFactor );

          // Rig colour enters ONLY as a gentle tint, never a full multiply, so
          // a warm key warms the image without draining its blues.
          tint *= mix( vec3( 1.0 ), keyHue, uKeyTint * lightFactor );
          #ifdef USE_FACE_RIG
            tint *= mix( vec3( 1.0 ), uFaceFillColor, uFillTint * frontFacing );
            tint *= mix( vec3( 1.0 ), uFaceTopColor, uHairTint * faceTopFacing );
            tint *= mix( vec3( 1.0 ), uFaceRimColor, uRimTint * faceRimFacing );
            tint *= mix( vec3( 1.0 ), uFaceBounceColor, uBounceTint * bounceFacing );
          #else
            tint *= mix( vec3( 1.0 ), uFillColor, uFillTint * ( 1.0 - lightFactor ) * fillFactor );
            tint *= mix( vec3( 1.0 ), mix( uAmbientGround, uAmbientSky, up ), uAmbientTint );
            tint *= mix( vec3( 1.0 ), uRimLightColor, uRimTint * rimFacing );
            tint *= mix( vec3( 1.0 ), uHairLightColor, uHairTint * hairFacing );
            tint *= mix( vec3( 1.0 ), uBounceColor, uBounceTint * bounceFacing );
          #endif
          // Warm bounce colour where the bounce actually lands.
          tint *= mix( vec3( 1.0 ), uFrontFillColor, uFrontFillTint * frontFacing );

          // Material warmth. A gentle push toward a warm hue that lifts skin
          // out of grey WITHOUT desaturating it or lightening it - the texture
          // keeps its own colour, it is simply lit by warmer light.
          tint *= mix( vec3( 1.0 ), uWarmColor, uWarmth );

          // Texture colour scaled by a neutral level and shaped by tint.
          outgoingLight = albedo * tint * level;

          #if SPHERE_MODE == 1
            // sph: multiplicative environment tint.
            vec2 sphereUv = normal.xy * 0.5 + 0.5;
            outgoingLight *= texture2D( uSphereMap, sphereUv ).rgb;
          #elif SPHERE_MODE == 2
            // spa: additive environment highlight, tinted by the texture.
            //
            // MMD sphere maps are authored bright, and this model applies them
            // to the trousers and corset - the darkest materials on her. Added
            // raw, the sphere map alone was most of those pixels' value, which
            // lifted near-black cloth to mid-grey. Tinting keeps the highlight
            // on the surface's own colour.
            vec2 sphereUv = normal.xy * 0.5 + 0.5;
            outgoingLight += texture2D( uSphereMap, sphereUv ).rgb
              * uSphereStrength * uReflectionStrength
              * mix( albedo, vec3( 1.0 ), 0.3 );
          #endif

          // Every additive highlight below is TINTED BY THE TEXTURE.
          //
          // This is what keeps dark materials dark. An albedo-independent
          // additive term is a constant floor: on near-black cloth (albedo
          // ~0.05) a rim of 0.26 IS the entire output, so blacks were being
          // lifted about 5x while lit surfaces stayed put, and the whole image
          // collapsed toward mid-grey. Tinting by albedo means a highlight
          // brightens a surface without ever inventing colour it does not have.
          //
          // A small white component is retained so genuine speculars still read
          // as light reflecting off the surface rather than as pure body colour.
          vec3 specTint = mix( albedo, vec3( 1.0 ), uSpecWhiteness );
          // Highlights both looks share (cornea glints, hair strand band) are
          // collected here and added after the realism blend.
          vec3 accent = vec3( 0.0 );
          vec3 rimTintCol = mix( albedo, vec3( 1.0 ), uRimWhiteness );

          // Art-directed specular from the key light only, gated by the same
          // light factor as the shading so a highlight can never appear on a
          // surface that is in shadow.
          float shadeMask = lightFactor;
          float spec = pow( NdotH, uSpecularPower ) * uSpecularStrength * shadeMask;
          outgoingLight += spec * keyHue * specTint * uReflectionStrength;

          #ifdef USE_EYE_REFLECTIONS
            // Two portrait-softbox reflections make the cornea read as curved
            // and wet. They are camera-relative and intentionally independent
            // of the cast-shadow mask: real reflections remain visible while
            // the bangs shade the iris underneath them.
            vec3 eyeKey = normalize( vec3( -0.24, 0.28, 0.93 ) );
            vec3 eyeFill = normalize( vec3( 0.32, 0.12, 0.94 ) );
            vec3 eyeKeyH = normalize( eyeKey + V );
            vec3 eyeFillH = normalize( eyeFill + V );
            float eyeGlint = pow(
              clamp( dot( normal, eyeKeyH ), 0.0, 1.0 ), 110.0
            );
            float eyeSoftbox = pow(
              clamp( dot( normal, eyeFillH ), 0.0, 1.0 ), 38.0
            ) * 0.32;
            accent += ( eyeGlint + eyeSoftbox )
              * uEyeReflectionStrength
              * mix( albedo, vec3( 1.0 ), 0.94 );
          #endif

          #ifdef USE_ANISOTROPIC
            // Kajiya-Kay banded highlight. The strand tangent is approximated
            // by world-up projected onto the surface, which produces the
            // horizontal highlight band that reads as anime hair.
            vec3 strand = uUpView - normal * dot( normal, uUpView );
            if ( length( strand ) > 1e-4 ) {
              strand = normalize( strand );
              vec3 shifted = normalize( strand + normal * uAnisotropicShift );
              float ToH = dot( shifted, H );
              float sinTH = sqrt( max( 0.0, 1.0 - ToH * ToH ) );
              accent += pow( sinTH, 48.0 ) * uAnisotropicStrength
                * shadeMask * keyHue * specTint * uReflectionStrength;
              // A second, camera-relative studio reflection keeps the hair's
              // highlight readable from front, back and arbitrary orbit views.
              vec3 beautyH = normalize(
                normalize( vec3( -0.22, 0.38, 0.90 ) ) + V
              );
              float beautyToH = dot( shifted, beautyH );
              float beautySinTH = sqrt(
                max( 0.0, 1.0 - beautyToH * beautyToH )
              );
              accent += pow( beautySinTH, 52.0 )
                * uAnisotropicStrength * 0.42
                * uViewFillStrength * uFrontFillLevel
                * uFrontFillColor * specTint * uReflectionStrength;
            }
          #endif

          // Fresnel rim, weighted toward the back light so it separates the
          // silhouette from the stage instead of glowing uniformly.
          float rim = pow( 1.0 - NdotV, uRimPower ) * uRimStrength;
          rim *= 0.5 + 0.5 * clamp( dot( normal, uRimDirView ) * 0.5 + 0.5, 0.0, 1.0 );
          outgoingLight += rim * uRimColor * rimTintCol * uReflectionStrength;

          #ifdef USE_SUBSURFACE
            // Warm bleed through the shadow terminator. On skin this is the
            // rosy band right at the light/shadow boundary that separates a
            // rendered face from a plastic one.
            float sss = smoothstep( 0.3, -0.2, NdotL ) * smoothstep( -0.65, -0.05, NdotL );
            outgoingLight += sss * uSubsurfaceStrength * uSubsurfaceColor * albedo * ao;
          #endif

          // ---- realism path -------------------------------------------------
          //
          // Physically based shading blended in by uRealism: wrapped diffuse
          // with per-channel subsurface bleed (skin glows warm at the shadow
          // edge instead of going grey), GGX key specular, studio-environment
          // reflections and irradiance, and Charlie sheen so fabric folds read
          // even on black cloth. The anime result above covers the rest.
          if ( uRealism > 0.001 ) {
            // MMD meshes mix triangle windings, so on double-sided materials
            // the shading normal of a visible face can point AWAY from the
            // viewer. Physically based terms treat that as a grazing angle and
            // add near-maximum Fresnel reflection - a grey veil over the whole
            // model. Orient the normal toward the viewer first.
            vec3 nR = dot( normal, V ) < 0.0 ? -normal : normal;
            float NdotL = dot( nR, keyDir );
            float NdotH = clamp( dot( nR, H ), 0.0, 1.0 );
            vec3 Nw = inverseTransformDirection( nR, viewMatrix );
            vec3 Vw = inverseTransformDirection( V, viewMatrix );
            vec3 Rw = reflect( -Vw, Nw );
            float rough = clamp( uRoughness, 0.045, 1.0 );
            float a2 = pow( rough, 4.0 );
            float nv = clamp( dot( nR, V ), 1e-3, 1.0 );
            // Keep only a third of the key's colour: authored texture colours
            // (lavender irises, black fabric) must not drift toward the warm key.
            vec3 keyTintR = mix( vec3( 1.0 ), keyHue, 0.35 );

            // Subsurface: red travels furthest under skin, blue least.
            vec3 wrap = vec3( 0.46, 0.24, 0.15 ) * uSss + 0.03;
            vec3 diffuseWrap = clamp( ( vec3( NdotL ) + wrap ) / ( 1.0 + wrap ), 0.0, 1.0 );
            // The cast-shadow penumbra also turns warm on skin.
            vec3 shadowColored = mix( vec3( shadowMask ),
              vec3( sqrt( shadowMask ), shadowMask, shadowMask * shadowMask ), uSss * 0.85 );
            vec3 keyLight = diffuseWrap * shadowColored * keyTintR * uRealKey;

            vec3 irradiance = envSample( Nw, uEnvMaxMip - 1.0 ) * uEnvIntensity;
            vec3 kd = albedo * ( 1.0 - uMetalness );
            vec3 real = kd * ( keyLight + irradiance * ao );

            vec3 F0r = mix( vec3( uF0 ), albedo, uMetalness );
            float nl = max( NdotL, 0.0 );
            float D = a2 / ( PI * pow( NdotH * NdotH * ( a2 - 1.0 ) + 1.0, 2.0 ) );
            float kG = pow( rough + 1.0, 2.0 ) / 8.0;
            float G = ( nl / ( nl * ( 1.0 - kG ) + kG ) ) * ( nv / ( nv * ( 1.0 - kG ) + kG ) );
            vec3 F = F0r + ( 1.0 - F0r ) * pow( 1.0 - clamp( dot( V, H ), 0.0, 1.0 ), 5.0 );
            vec3 keySpec = D * G * F / max( 4.0 * nl * nv, 1e-3 ) * nl * shadowMask * keyTintR * uRealKey;

            vec3 Fenv = F0r + ( max( vec3( 1.0 - rough ), F0r ) - F0r ) * pow( 1.0 - nv, 5.0 );
            float specOcc = clamp( pow( nv + ao, exp2( -16.0 * rough - 1.0 ) ) - 1.0 + ao, 0.0, 1.0 );
            vec3 envSpec = envSample( Rw, rough * uEnvMaxMip ) * uEnvIntensity * Fenv * specOcc;

            // Charlie sheen: fabric fibres catching light at grazing angles.
            float sheenA = max( uSheenRough, 0.07 );
            float sin2 = max( 1.0 - NdotH * NdotH, 0.0078125 );
            float sheenD = ( 2.0 + 1.0 / sheenA ) * pow( sin2, 0.5 / sheenA ) / ( 2.0 * PI );
            float sheenV = 1.0 / ( 4.0 * ( nl + nv - nl * nv ) + 1e-3 );
            // Fibre sheen is mostly the light's colour, faintly the dye's.
            vec3 sheenTint = mix( vec3( 0.92, 0.95, 1.0 ), albedo / max( max( albedo.r, albedo.g ), max( albedo.b, 0.04 ) ), 0.35 );
            vec3 sheen = uSheen * sheenTint * (
              sheenD * sheenV * nl * shadowMask * keyTintR * uRealKey
              + irradiance * pow( 1.0 - nv, 4.0 ) * 0.9 * ao
            );

            real += ( keySpec + envSpec ) * uReflectionStrength + sheen;
            outgoingLight = mix( outgoingLight, real, uRealism );
          }

          outgoingLight += accent;
          outgoingLight += albedo * uEmissiveStrength;

          // Local contrast, NOT global brightness.
          //
          // An S-curve about mid-grey pushes darks down and lights up while
          // leaving the midpoint fixed, so the image gains depth without the
          // overall exposure moving. This is what separates surfaces from each
          // other; raising brightness only flattens them together.
          vec3 clamped = clamp( outgoingLight, 0.0, 1.0 );
          vec3 sCurve = clamped * clamped * ( 3.0 - 2.0 * clamped );
          outgoingLight = mix( outgoingLight, sCurve, uLocalContrast );

          // Saturation is a trim, defaulting to 1.0 (untouched). The texture's
          // own colour is the reference and must not be repainted.
          float lum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
          outgoingLight = mix( vec3( lum ), outgoingLight, uSaturation );
        }
        #include <opaque_fragment>
        `
      );

    shader.defines = {
      ...(shader.defines ?? {}),
      SPHERE_MODE: sphereMode,
      ...(useAnisotropic ? { USE_ANISOTROPIC: '' } : {}),
      ...(useSubsurface ? { USE_SUBSURFACE: '' } : {}),
      ...(useFaceRig ? { USE_FACE_RIG: '' } : {}),
      ...(useEyeReflections ? { USE_EYE_REFLECTIONS: '' } : {}),
    };
  };

  // Variants differ by #define, so they must not share a compiled program.
  material.customProgramCacheKey = () =>
    `anime|${sphereMode}|${useAnisotropic ? 1 : 0}|${useSubsurface ? 1 : 0}|${useFaceRig ? 1 : 0}|${useEyeReflections ? 1 : 0}`;

  material.userData.animeUniforms = uniforms;
  return material;
}

/** Change only the material's reflected highlights, never its base lighting. */
export function setAnimeMaterialReflectionStrength(
  material: THREE.Material,
  strength: number
): void {
  const uniforms = material.userData.animeUniforms as
    | { uReflectionStrength?: { value: number } }
    | undefined;
  if (uniforms?.uReflectionStrength) {
    uniforms.uReflectionStrength.value = THREE.MathUtils.clamp(strength, 0, 2);
  }
}

/** Resolve which shading role a PMX material name belongs to. */
export function resolveMaterialRole(
  name: string,
  roles: Partial<Record<MaterialRole, string[]>>
): MaterialRole {
  for (const [role, names] of Object.entries(roles) as [MaterialRole, string[]][]) {
    if (names.includes(name)) return role;
  }
  return 'cloth';
}
