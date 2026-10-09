/**
 * Professional anime lighting rig.
 *
 * A classic portrait setup adapted for cel shading:
 *
 *   key    - soft three-quarter front light, the only shadow caster
 *   fill   - cool opposing light that opens the shadow side without flattening
 *   rim    - back light that draws a bright edge around the silhouette
 *   hair   - dedicated overhead-rear light for the anisotropic hair band
 *   ambient- hemisphere term: cool sky above, warm bounce below
 *   bounce - low front-up light standing in for environment light
 *
 * MeshToonMaterial has no envMap path, so "environment lighting" is expressed
 * physically-plausibly as hemisphere ambient plus a soft bounce light rather
 * than an IBL probe that the shading model would simply ignore.
 *
 * The rig also republishes its key and rim directions into
 * `animeShaderGlobals` every frame in view space, which is what drives rim,
 * specular and subsurface inside the character shader.
 */
import * as THREE from 'three';
import type { LightingConfig } from '../config/types';
import { animeShaderGlobals } from '../materials/AnimeMaterial';

/**
 * Convert azimuth/elevation in degrees to a unit direction.
 *
 * The character faces +Z after the PMX handedness conversion, and the camera
 * sits on the +Z side. Azimuth 0 therefore places a light directly in FRONT
 * of her, increasing toward camera-left; azimuth 180 puts it behind her for
 * rim and hair lighting.
 */
function direction(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el)
  ).normalize();
}

export class AnimeLightingRig {
  readonly group = new THREE.Group();

  private readonly key: THREE.DirectionalLight;
  private readonly fill: THREE.DirectionalLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly hair: THREE.DirectionalLight;
  private readonly ambient: THREE.HemisphereLight;
  private readonly bounce: THREE.DirectionalLight;
  private readonly target = new THREE.Object3D();

  private readonly keyDirWorld = new THREE.Vector3();
  private readonly rimDirWorld = new THREE.Vector3();
  private readonly fillDirWorld = new THREE.Vector3();
  private readonly hairDirWorld = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  constructor(private config: LightingConfig) {
    this.group.name = 'AnimeLightingRig';
    this.group.add(this.target);

    this.key = new THREE.DirectionalLight(config.keyColor, config.keyIntensity);
    this.fill = new THREE.DirectionalLight(config.fillColor, config.fillIntensity);
    this.rim = new THREE.DirectionalLight(config.rimColor, config.rimIntensity);
    this.hair = new THREE.DirectionalLight(config.hairLightColor, config.hairLightIntensity);
    this.bounce = new THREE.DirectionalLight(config.ambientGroundColor, config.environmentIntensity);
    this.ambient = new THREE.HemisphereLight(
      config.ambientSkyColor,
      config.ambientGroundColor,
      config.ambientIntensity
    );

    for (const light of [this.key, this.fill, this.rim, this.hair, this.bounce]) {
      light.target = this.target;
      this.group.add(light);
    }
    this.group.add(this.ambient);

    this.key.name = 'keyLight';
    this.fill.name = 'fillLight';
    this.rim.name = 'rimLight';
    this.hair.name = 'hairLight';

    this.applyConfig();
    this.applyFaceRig();
  }

  /** Reposition every light from the current config. */
  private applyConfig(): void {
    const c = this.config;
    // Lights are directional, so only the direction matters; the distance
    // just needs to sit outside the character for a sane shadow frustum.
    const radius = 40;

    this.keyDirWorld.copy(direction(c.keyAzimuth, c.keyElevation));
    this.rimDirWorld.copy(direction(c.rimAzimuth, c.rimElevation));
    this.fillDirWorld.copy(direction(c.fillAzimuth, c.fillElevation));
    this.hairDirWorld.copy(direction(c.keyAzimuth + 180, 62));

    this.key.position.copy(this.keyDirWorld).multiplyScalar(radius);
    this.fill.position.copy(direction(c.fillAzimuth, c.fillElevation)).multiplyScalar(radius);
    this.rim.position.copy(this.rimDirWorld).multiplyScalar(radius);
    // Hair light sits behind and well above, opposite the key horizontally.
    this.hair.position.copy(direction(c.keyAzimuth + 180, 62)).multiplyScalar(radius);
    // Bounce comes from low and in front, imitating light off the floor.
    this.bounce.position.copy(direction(0, -28)).multiplyScalar(radius);

    this.key.color.set(c.keyColor);
    this.key.intensity = c.keyIntensity;
    this.fill.color.set(c.fillColor);
    this.fill.intensity = c.fillIntensity;
    this.rim.color.set(c.rimColor);
    this.rim.intensity = c.rimIntensity;
    this.hair.color.set(c.hairLightColor);
    this.hair.intensity = c.hairLightIntensity;
    this.bounce.color.set(c.ambientGroundColor);
    this.bounce.intensity = c.environmentIntensity;
    this.ambient.color.set(c.ambientSkyColor);
    this.ambient.groundColor.set(c.ambientGroundColor);
    this.ambient.intensity = c.ambientIntensity;

    // Only the key casts shadows; multiple shadow casters read as messy and
    // cost far more than they add on a stylised character.
    this.key.castShadow = c.shadow.enabled;
    const shadow = this.key.shadow;
    shadow.mapSize.setScalar(c.shadow.mapSize);
    shadow.radius = c.shadow.radius;
    shadow.bias = c.shadow.bias;
    shadow.normalBias = c.shadow.normalBias;
    // Keeps contact shadows present but never black - harsh shadow is the
    // fastest way to make a stylised character look cheap.
    shadow.intensity = c.shadow.opacity;
    shadow.blurSamples = 16;
  }

  /**
   * Aim the rig at the character and size the shadow frustum to fit it.
   * `center` and `radius` describe the character's world bounds.
   */
  frame(center: THREE.Vector3, radius: number): void {
    this.target.position.copy(center);
    this.group.position.set(0, 0, 0);

    const cam = this.key.shadow.camera;
    const extent = radius * 1.15;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 120;
    cam.updateProjectionMatrix();

    // Directional lights orbit the target, so re-offset from the new center.
    const radiusScale = 40;
    this.key.position.copy(center).addScaledVector(this.keyDirWorld, radiusScale);
    this.fill.position
      .copy(center)
      .addScaledVector(direction(this.config.fillAzimuth, this.config.fillElevation), radiusScale);
    this.rim.position.copy(center).addScaledVector(this.rimDirWorld, radiusScale);
    this.hair.position
      .copy(center)
      .addScaledVector(direction(this.config.keyAzimuth + 180, 62), radiusScale);
    this.bounce.position.copy(center).addScaledVector(direction(0, -28), radiusScale);
  }

  /**
   * Publish light directions into the shared shader uniforms, in view space.
   * Must run after the camera's world matrix is up to date.
   */
  /**
   * Publish every light into the shared shader uniforms, in view space.
   *
   * The character shader does its own light accumulation (see AnimeMaterial),
   * so each light contributes a DIRECTION plus an intensity-weighted COLOUR.
   * The three.js lights themselves remain in the scene: they still drive the
   * shadow map and keep the rig inspectable with standard tooling.
   *
   * Must run after the camera's world matrix is up to date.
   */
  update(camera: THREE.Camera): void {
    const toView = (out: THREE.Vector3, world: THREE.Vector3) =>
      out.copy(world).transformDirection(camera.matrixWorldInverse).normalize();

    toView(animeShaderGlobals.uKeyDirView.value, this.keyDirWorld);
    toView(animeShaderGlobals.uRimDirView.value, this.rimDirWorld);
    toView(animeShaderGlobals.uFillDirView.value, this.fillDirWorld);
    toView(animeShaderGlobals.uHairDirView.value, this.hairDirWorld);
    toView(animeShaderGlobals.uUpView.value, this.scratch.set(0, 1, 0));

    // HUE and LEVEL are published separately, and colours are never scaled by
    // intensity here.
    //
    // Multiplying a light's colour by its intensity and then multiplying the
    // texture by the result is what previously skewed the whole render: the
    // key's linear colour is (1.00, 0.87, 0.72), so every lit pixel lost more
    // than a quarter of its blue. The shader now scales brightness with the
    // scalar levels and applies these hues only as a light tint.
    animeShaderGlobals.uKeyColor.value.copy(this.key.color);
    animeShaderGlobals.uFillColor.value.copy(this.fill.color);
    animeShaderGlobals.uRimLightColor.value.copy(this.rim.color);
    animeShaderGlobals.uHairLightColor.value.copy(this.hair.color);
    animeShaderGlobals.uAmbientSky.value.copy(this.ambient.color);
    animeShaderGlobals.uAmbientGround.value.copy(this.ambient.groundColor);

    // Levels are fractions relative to the key, which is defined as 1.0.
    const key = Math.max(this.key.intensity, 0.001);
    animeShaderGlobals.uFillLevel.value = this.fill.intensity / key;
    animeShaderGlobals.uAmbientLevel.value = this.ambient.intensity / key;
    animeShaderGlobals.uRimLevel.value = this.rim.intensity / key;
    animeShaderGlobals.uHairLevel.value = this.hair.intensity / key;

    // The front fill has no scene light: it is defined in view space by the
    // shader, so only its level and hue are published.
    animeShaderGlobals.uFrontFillLevel.value = this.config.frontFillIntensity / key;
    animeShaderGlobals.uFrontFillColor.value.set(this.config.frontFillColor);
  }

  /**
   * Publish the dedicated face rig.
   *
   * Its directions are VIEW-SPACE CONSTANTS, so unlike the body rig they need
   * no per-frame camera transform - a view-space direction is camera-relative
   * by definition. That is precisely the property we want: the portrait key,
   * overhead and rim travel with the viewer, so the face is lit the same
   * flattering way from every angle and the front view is always the best one.
   *
   * Called once at construction; nothing here changes per frame.
   */
  private applyFaceRig(): void {
    const f = this.config.face;
    const g = animeShaderGlobals;

    // View space: +X camera-right, +Y camera-up, +Z toward the camera.
    // Positive azimuth places the key to camera-LEFT, the classic portrait
    // position - off-axis enough to model the nose and cheekbone, close
    // enough to the lens that the bangs cannot mask the eyes.
    const az = THREE.MathUtils.degToRad(f.keyAzimuth);
    const el = THREE.MathUtils.degToRad(f.keyElevation);
    g.uFaceKeyDirView.value
      .set(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
      .normalize();

    // Overhead, tipped slightly toward the lens: forehead and cheekbone sheen.
    g.uFaceTopDirView.value.set(0, 0.94, 0.34).normalize();
    // Behind and above camera-right: separates cheek and jaw from the stage.
    g.uFaceRimDirView.value.set(0.52, 0.36, -0.78).normalize();

    g.uFaceKeyColor.value.set(f.keyColor);
    g.uFaceFillColor.value.set(f.fillColor);
    g.uFaceTopColor.value.set(f.topColor);
    g.uFaceRimColor.value.set(f.rimColor);
    g.uFaceBounceColor.value.set(f.bounceColor);

    // Unlike the body rig, these are a self-contained portrait exposure. They
    // stay absolute so tuning one light never silently rescales every other
    // face light.
    g.uFaceKeyLevel.value = f.keyIntensity;
    g.uFaceFillLevel.value = f.fillIntensity;
    g.uFaceTopLevel.value = f.topIntensity;
    g.uFaceRimLevel.value = f.rimIntensity;
    g.uFaceBounceLevel.value = f.bounceIntensity;
  }

  /** Swap in new lighting values at runtime (used by the settings panel). */
  setConfig(config: LightingConfig): void {
    this.config = config;
    this.applyConfig();
    this.applyFaceRig();
  }

  dispose(): void {
    this.key.shadow.map?.dispose();
    this.group.removeFromParent();
  }
}
