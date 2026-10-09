/**
 * Render stage: WebGL renderer, scene, camera and framing.
 *
 * The canvas is intentionally TRANSPARENT. ABxAG already renders an ambient
 * holographic backdrop (CSS gradients plus a particle overlay canvas), and the
 * character has to composite into it. That rules out an EffectComposer bloom
 * chain, whose passes do not preserve alpha - so "glow" is delivered instead
 * by emissive catchlights and jewellery plus the existing backdrop layers.
 * Everything else in the pipeline (colour space, tone mapping, exposure, soft
 * shadows, anisotropic filtering) is configured here.
 */
import * as THREE from 'three';
import type { CameraFraming, RenderConfig } from '../config/types';

const TONE_MAPPING: Record<RenderConfig['toneMapping'], THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  neutral: THREE.NeutralToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
};

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** Point the camera looks at, in world space. */
  private readonly focus = new THREE.Vector3();
  /** Smoothed pointer position in normalised [-1, 1] screen coordinates. */
  private readonly pointer = new THREE.Vector2();
  private readonly pointerTarget = new THREE.Vector2();
  private readonly _panned = new THREE.Vector3();

  /**
   * User-driven orbit around the character, in radians. Yaw 0 faces her from
   * the front (+Z); PI shows her back. Smoothed toward the target so keyboard
   * input glides instead of snapping.
   */
  private orbitYaw = 0;
  private orbitPitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private orbitDistance = 0;
  private targetDistance = 0;
  /** When locked, pointer parallax is suspended so the view holds exactly. */
  private locked = false;

  private framing: CameraFraming;
  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderConfig: RenderConfig,
    framing: CameraFraming
  ) {
    this.framing = framing;
    this.orbitDistance = framing.distance;
    this.targetDistance = framing.distance;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: renderConfig.antialias,
      powerPreference: 'high-performance',
      // Depth precision matters: hair, lashes and eye layers sit very close
      // together on the face.
      logarithmicDepthBuffer: false,
      stencil: false,
    });

    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = TONE_MAPPING[renderConfig.toneMapping] ?? THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = renderConfig.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(framing.fov, 1, 0.1, 500);
    // After the handedness conversion the character faces +Z, so the camera
    // sits on the +Z side looking back toward her.
    this.camera.position.set(0, 0, framing.distance);
    this.scene.add(this.camera);
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  /** Point the camera at `focus`, derived from a bone each frame. */
  setFocus(focus: THREE.Vector3): void {
    this.focus.copy(focus);
  }

  /** Pointer position in normalised device coordinates, for parallax. */
  setPointer(x: number, y: number): void {
    this.pointerTarget.set(
      THREE.MathUtils.clamp(x, -1, 1),
      THREE.MathUtils.clamp(y, -1, 1)
    );
  }

  setFraming(framing: CameraFraming): void {
    this.framing = framing;
    this.camera.fov = framing.fov;
    this.camera.updateProjectionMatrix();
  }

  // ---- user camera control ------------------------------------------------

  /** Nudge the orbit. Angles in radians; pitch is clamped to stay upright. */
  orbitBy(deltaYaw: number, deltaPitch: number): void {
    if (this.locked) return;
    this.targetYaw += deltaYaw;
    this.targetPitch = THREE.MathUtils.clamp(
      this.targetPitch + deltaPitch,
      -Math.PI / 3,
      Math.PI / 3
    );
  }

  /** Jump to an absolute orbit angle, e.g. for a view preset. */
  setOrbit(yaw: number, pitch = this.targetPitch): void {
    if (this.locked) return;
    this.targetYaw = yaw;
    this.targetPitch = THREE.MathUtils.clamp(pitch, -Math.PI / 3, Math.PI / 3);
  }

  /** Dolly in or out, clamped to the configured range. */
  zoomBy(delta: number): void {
    if (this.locked) return;
    this.targetDistance = THREE.MathUtils.clamp(
      this.targetDistance + delta,
      this.framing.minDistance,
      this.framing.maxDistance
    );
  }

  /** Camera-relative pan applied on top of the focus point (editor/free view). */
  private readonly pan = new THREE.Vector3();
  private readonly panTarget = new THREE.Vector3();

  /** Pan the view: dx/dy in world units along the camera's right/up axes. */
  panBy(dx: number, dy: number): void {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.panTarget.addScaledVector(right, dx).add(new THREE.Vector3(0, dy, 0));
  }

  get framingHeightOffset(): number {
    return this.framing.heightOffset;
  }

  clearPan(): void {
    this.panTarget.set(0, 0, 0);
  }

  /** Set the orbit distance directly (editor framing), bypassing the zoom range. */
  setDistance(distance: number, options: { unclamped?: boolean } = {}): void {
    this.targetDistance = options.unclamped ? Math.max(0.5, distance) : THREE.MathUtils.clamp(distance, 0.5, this.framing.maxDistance * 4);
  }

  /** Freeze the current view: pointer parallax stops influencing the camera. */
  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Current orbit, for UI readouts. */
  get orbit(): { yaw: number; pitch: number; distance: number } {
    return { yaw: this.targetYaw, pitch: this.targetPitch, distance: this.targetDistance };
  }

  /** Return to the character's configured default framing. */
  resetView(): void {
    if (this.locked) return;
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.targetDistance = this.framing.distance;
    this.panTarget.set(0, 0, 0);
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.renderConfig.maxPixelRatio);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Ease the camera toward its framed position. Called once per frame before
   * rendering so pointer parallax stays smooth and frame-rate independent.
   */
  update(delta: number): void {
    // Critically damped follow; independent of frame rate.
    const smoothing = 1 - Math.exp(-6 * delta);
    this.pointer.lerp(this.pointerTarget, smoothing);

    // Ease the orbit toward its target so keyboard input glides.
    const orbitSmoothing = 1 - Math.exp(-8 * delta);
    this.orbitYaw = THREE.MathUtils.lerp(this.orbitYaw, this.targetYaw, orbitSmoothing);
    this.orbitPitch = THREE.MathUtils.lerp(this.orbitPitch, this.targetPitch, orbitSmoothing);
    this.orbitDistance = THREE.MathUtils.lerp(
      this.orbitDistance,
      this.targetDistance,
      orbitSmoothing
    );

    const { heightOffset, parallax } = this.framing;

    // Parallax is a small additive sway on top of the user's orbit, and is
    // suspended entirely while the view is locked.
    const swayYaw = this.locked ? 0 : this.pointer.x * parallax;
    const swayPitch = this.locked ? 0 : this.pointer.y * parallax * 0.6;

    this.pan.lerp(this.panTarget, orbitSmoothing);
    const focus = this._panned.copy(this.focus).add(this.pan);

    const yaw = this.orbitYaw + swayYaw;
    const pitch = this.orbitPitch + swayPitch;
    const d = this.orbitDistance;

    // Spherical orbit around the focus point. Yaw 0 is directly in front of
    // the character (+Z); PI puts the camera behind her.
    this.camera.position.set(
      focus.x + Math.sin(yaw) * Math.cos(pitch) * d,
      focus.y + heightOffset + Math.sin(pitch) * d,
      focus.z + Math.cos(yaw) * Math.cos(pitch) * d
    );
    this.camera.lookAt(focus);
    this.camera.updateMatrixWorld();
  }

  render(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  /** True while the WebGL context is usable. */
  get isValid(): boolean {
    return !this.disposed && !this.renderer.getContext().isContextLost();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // NOTE: deliberately no forceContextLoss(). It permanently poisons the
    // canvas element, so any later attempt to create a context on it fails -
    // which breaks React StrictMode's mount/unmount/remount cycle in dev.
    // renderer.dispose() already releases the GPU resources we allocated.
    this.renderer.dispose();
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  get element(): HTMLCanvasElement {
    return this.canvas;
  }
}

