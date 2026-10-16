/**
 * Character system orchestrator.
 *
 * Owns the stage, the loaded model and every animation subsystem, and runs
 * them in the one order that produces correct results:
 *
 *   1. reset the pose to rest and clear the morph accumulator
 *   2. procedural idle          -> pose
 *   3. behaviour director       -> pose
 *   4. gaze                     -> pose
 *   5. apply the composed pose to the skeleton
 *   6. face (expression, blink, visemes) -> morph accumulator
 *   7. commit vertex morphs, then bone morphs additively on top of the pose
 *   8. solve grants (append-parent inheritance)
 *   9. refresh world matrices
 *  10. simulate spring physics, which reads those matrices and writes back
 *  11. frame the camera, refresh lighting uniforms, render
 *
 * Steps 8 and 10 must come after the pose and morphs: grants inherit the
 * *animated* rotation of their source, and physics needs the fully-posed
 * skeleton to derive inertia from.
 */
import * as THREE from 'three';
import { limitedTextureLoader, type QualityProfile } from './quality';
import type { BasePose, CharacterConfig } from '../config/types';
import type { CharacterProfile, BoneEntry } from '@/shared/character/profile';
import { analyzeRig } from '@/shared/character/profile';
import { isHairTintable, isOutfitTintable } from '@/shared/character/appearance';
import type { PhysicsChainProfile, ColliderProfile } from '@/shared/character/secondary';
import { loadPmx } from '../loaders/PmxLoader';
import type { PmxModel } from '../loaders/pmxTypes';
import { CHARACTER_ACTIONS, CharacterActions, normalizeActionName, type CharacterActionName } from '../animation/CharacterActions';
import {
  detectGenericFormat,
  loadGenericModel,
  type GenericModelFormat,
  type UniversalModel,
} from '../loaders/UniversalLoader';
import {
  createAnimeMaterial,
  resolveMaterialRole,
  setAnimeMaterialReflectionStrength,
  setCharacterRealism,
} from '../materials/AnimeMaterial';
import { createOutlineMesh } from '../materials/OutlineMesh';
import { AnimeLightingRig } from '../lighting/AnimeLightingRig';
import { Stage } from './Stage';
import { MorphController } from '../face/MorphController';
import { FaceController } from '../face/FaceController';
import { LipSync, type VisemeWeights } from '../face/LipSync';
import { PoseBuffer } from '../animation/PoseBuffer';
import { ProceduralIdle } from '../animation/ProceduralIdle';
import { GazeController, type GazeMode } from '../animation/GazeController';
import { PerformanceController } from '../animation/PerformanceController';
import { GrantSolver } from '../animation/GrantSolver';
import { SecondaryMotion, type SecondaryMotionSettings } from '../physics/SecondaryMotion';
import { ClothLayer, type ClothSettings } from '../physics/ClothLayer';
import { PoseEditor, type PoseOwnership } from '../editor/PoseEditor';
import { BehaviourDirector } from '../behaviour/BehaviourDirector';
import type { CharacterActivity } from '../behaviour/behaviours';
import {
  buildSeatProp, planSeat, SEATED_LOCKED_SLOTS, STYLES_FOR_SEAT,
  type SeatKind, type SeatMeasures, type SeatPlan, type SitStyle,
} from '../scene/Seating';

export interface CharacterSystemOptions {
  canvas: HTMLCanvasElement;
  config: CharacterConfig;
  /** Imported characters carry their analysed profile. */
  profile?: CharacterProfile;
  /** GPU budget (texture size, anisotropy, cloth); render limits are already in `config`. */
  quality?: QualityProfile;
  onProgress?: (phase: string, ratio: number) => void;
  onError?: (error: Error) => void;
}

/** Per-frame inputs from the application. */
export interface CharacterFrameInput {
  activity: CharacterActivity;
  emotion: string;
  /** Analyser carrying ABxAG's voice, used for lip sync. */
  outputAnalyser: AnalyserNode | null;
  /** Analyser carrying the user's microphone, used for listening reactions. */
  inputAnalyser: AnalyserNode | null;
}

/** Longest frame the simulation will accept, to survive tab stalls. */
const MAX_DELTA = 1 / 20;

export class CharacterSystem {
  readonly stage: Stage;
  private readonly config: CharacterConfig;

  private model: PmxModel | null = null;
  /** Generic (VRM/GLB/glTF/FBX/OBJ) scene. Exactly one of `model` / `generic` is set. */
  private generic: UniversalModel | null = null;
  private genericMixer: THREE.AnimationMixer | null = null;
  private genericTime = 0;
  private genericBaseY = 0;
  private genericHead: THREE.Object3D | null = null;
  private lighting: AnimeLightingRig | null = null;
  private morphs: MorphController | null = null;
  private face: FaceController | null = null;
  private pose: PoseBuffer | null = null;
  private idle: ProceduralIdle | null = null;
  private performance: PerformanceController | null = null;
  private gaze: GazeController | null = null;
  private grants: GrantSolver | null = null;
  private physics: SecondaryMotion | null = null;
  /** Vertex-level cloth for every garment (stays worn). */
  private cloth: ClothLayer | null = null;
  private clothSettings: Partial<ClothSettings> = {};
  private clothGrab: { plane: THREE.Plane } | null = null;
  private editor: PoseEditor | null = null;
  private readonly profile?: CharacterProfile;
  private rigInfo: {
    humanoid: Record<string, { bone: string }>;
    bones: BoneEntry[];
    chains: PhysicsChainProfile[];
    colliders: ColliderProfile[];
    facing: number;
    height: number;
  } | null = null;
  private physicsSettings: Partial<SecondaryMotionSettings> = {};
  private physicsDebug: THREE.Group | null = null;
  private characterRoot: THREE.Group | null = null;
  private behaviours: BehaviourDirector | null = null;
  /** One-shot body performances (jump/wave/…); idle/gaze breathe underneath. */
  private readonly actions = new CharacterActions();
  private lastActionRoot = { y: 0, yaw: 0, pitch: 0 };
  /** Material role per PMX material index (for outfit tinting). */
  private materialRoles: string[] = [];
  /** Original diffuse colours, stashed on first tint (for reset). */
  private readonly originalColors = new Map<number, THREE.Color>();
  private readonly lipSync: LipSync;
  /** Current seat, its prop, and the seated idle's state. */
  private seating: {
    plan: SeatPlan;
    prop: THREE.Group | null;
    settleAt: number;
    time: number;
    base: Map<string, THREE.Quaternion> | null;
  } | null = null;
  private standUntil = 0;

  private readonly clock = new THREE.Clock();
  private rafHandle = 0;
  private running = false;
  private disposed = false;
  private lastFrameTime = 0;

  /** Smoothed 0..1 measure of how much the mouth should follow speech. */
  private speechAuthority = 0;
  private currentActivity: CharacterActivity = 'idle';
  /** 1.0 is the authored look; runtime UI may scale reflected light 0..2. */
  private reflectionStrength = 1;

  private readonly focusPoint = new THREE.Vector3();
  /** Latest pointer position in normalised device coordinates. */
  private readonly pointerNdc = new THREE.Vector2();
  private readonly gazePoint = new THREE.Vector3();
  private readonly _gazeForward = new THREE.Vector3();
  private eyeTracking = false;
  private readonly frameInput: CharacterFrameInput = {
    activity: 'idle',
    emotion: 'idle',
    outputAnalyser: null,
    inputAnalyser: null,
  };

  private readonly onProgress?: (phase: string, ratio: number) => void;
  private readonly onError?: (error: Error) => void;
  private readonly quality: QualityProfile | null;

  constructor(options: CharacterSystemOptions) {
    this.config = options.config;
    this.profile = options.profile;
    this.quality = options.quality ?? null;
    this.onProgress = options.onProgress;
    this.onError = options.onError;
    this.stage = new Stage(options.canvas, this.config.render, this.config.camera);
    this.lipSync = new LipSync(this.config.lipSync);
  }

  get isLoaded(): boolean {
    return this.model !== null || this.generic !== null;
  }

  /** True when the loaded character came through the generic three.js path. */
  get isGenericModel(): boolean {
    return this.generic !== null;
  }

  /**
   * Generic formats declare themselves via the staged profile first, falling
   * back to the model URL extension (built-in / legacy characters).
   */
  private detectGenericFormat(): GenericModelFormat | null {
    const fromProfile = (this.profile as unknown as { model?: { format?: string } } | undefined)?.model?.format;
    if (fromProfile) {
      const asGeneric = detectGenericFormat(`model.${fromProfile}`);
      if (asGeneric) return asGeneric;
      if (fromProfile === 'pmx' || fromProfile === 'pmd') return null;
    }
    return detectGenericFormat(this.config.modelUrl);
  }

  /**
   * Generic-model load path (VRM/GLB/glTF/FBX/OBJ): scene + lighting +
   * procedural idle sway. Face morphs, MMD physics and the pose editor stay
   * on the PMX path — generic models animate whole-body + head look.
   */
  private async loadGeneric(format: GenericModelFormat): Promise<void> {
    const model = await loadGenericModel(this.config.modelUrl, format, this.onProgress);
    if (this.disposed) return;
    this.generic = model;
    this.genericTime = 0;

    const root = new THREE.Group();
    root.name = `character:${this.config.id}`;
    root.scale.setScalar(this.config.scale);
    root.position.y = this.config.groundOffset;
    this.characterRoot = root;

    const shadows = this.config.lighting.shadow.enabled;
    for (const mesh of model.meshes) {
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
    }
    this.genericBaseY = root.position.y;
    root.add(model.root);
    this.stage.scene.add(root);

    this.lighting = new AnimeLightingRig(this.config.lighting);
    this.stage.scene.add(this.lighting.group);

    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
    this.lighting.frame(center, radius);

    // Head bone for a gentle look-around (best-effort name match).
    const headKeys = ['head', 'neck', 'neck1', 'neck_1', 'bip01 head', 'mixamorighead'];
    this.genericHead = null;
    for (const key of headKeys) {
      const hit = model.bonesByName.get(key);
      if (hit) {
        this.genericHead = hit;
        break;
      }
    }

    // Auto-play the first embedded clip if the model ships one (many FBX/GLB
    // downloads include an idle). Procedural sway layers on top harmlessly.
    if (model.animations.length > 0) {
      try {
        this.genericMixer = new THREE.AnimationMixer(model.root);
        const clip = model.animations[0];
        const action = this.genericMixer.clipAction(clip);
        action.play();
      } catch (error) {
        console.warn('[generic] could not play embedded animation:', error);
        this.genericMixer = null;
      }
    }

    const analysisHeight = this.profile?.height && this.profile.height > 0 ? this.profile.height : model.height;
    this.rigInfo = {
      humanoid: (this.profile?.skeleton.humanoid ?? {}) as Record<string, { bone: string }>,
      bones: this.profile?.skeleton.bones ?? [],
      chains: this.profile?.physics.chains ?? [],
      colliders: this.profile?.physics.colliders ?? [],
      facing: this.profile?.facing ?? 1,
      height: analysisHeight,
    };
    for (const warning of model.warnings) console.info(`[generic] ${warning}`);

    this.updateFocus();
    this.onProgress?.('Ready', 1);
  }

  /** Gentle whole-body idle for generic models (breathing + head sway). */
  private updateGeneric(delta: number): void {
    const generic = this.generic;
    const root = this.characterRoot;
    const lighting = this.lighting;
    if (!generic || !root || !lighting) return;
    this.genericTime += delta;
    const t = this.genericTime;
    this.genericMixer?.update(delta);
    root.position.y = this.genericBaseY + Math.sin(t * 1.4) * 0.02 * this.config.scale;
    root.rotation.y = Math.sin(t * 0.3) * 0.03;
    if (this.genericHead) {
      this.genericHead.rotation.y = Math.sin(t * 0.45) * 0.12;
      this.genericHead.rotation.x = Math.sin(t * 0.6 + 1) * 0.05;
    }
    this.updateFocus();
    this.stage.update(delta);
    lighting.update(this.stage.camera);
    this.stage.render();
  }

  /** Diagnostics for the settings panel / dev overlay. */
  get diagnostics(): Record<string, unknown> {
    if (this.generic) {
      return {
        character: this.config.displayName,
        loaded: this.isLoaded,
        genericFormat: this.generic.format,
        genericMeshes: this.generic.meshes.length,
        genericBones: this.generic.bonesByName.size,
        genericAnimations: this.generic.animations.length,
        genericWarnings: this.generic.warnings,
        bones: 0,
        vertexMorphs: 0,
        boneMorphs: 0,
        physicsNodes: 0,
        physicsColliders: 0,
        physicsGroups: {},
        physics: null,
        ownership: null,
        grants: 0,
        behaviour: this.behaviours?.currentName ?? null,
        expression: this.face?.expression ?? null,
        gaze: this.gaze?.currentMode ?? null,
        action: this.actions.active,
      };
    }
    return {
      character: this.config.displayName,
      loaded: this.isLoaded,
      bones: this.model?.bones.length ?? 0,
      vertexMorphs: this.model?.vertexMorphs.size ?? 0,
      boneMorphs: this.model?.boneMorphs.size ?? 0,
      physicsNodes: this.physics?.nodeCount ?? 0,
      physicsColliders: this.physics?.colliderCount ?? 0,
      physicsGroups: this.physics?.groupBreakdown ?? {},
      physics: this.physics?.stats ?? null,
      ownership: this.editor?.ownership ?? null,
      grants: this.grants?.count ?? 0,
      behaviour: this.behaviours?.currentName ?? null,
      expression: this.face?.expression ?? null,
      gaze: this.gaze?.currentMode ?? null,
      action: this.actions.active,
    };
  }

  async load(): Promise<void> {
    try {
      const genericFormat = this.detectGenericFormat();
      if (genericFormat) {
        await this.loadGeneric(genericFormat);
        return;
      }
      const model = await loadPmx({
        modelUrl: this.config.modelUrl,
        textureMapUrl: this.config.textureMapUrl,
        onProgress: this.onProgress,
        createMaterial: (raw, textureLoader) => {
          const role = resolveMaterialRole(raw.name, this.config.materialRoles);
          const tuning = this.config.materialTuning[role] ?? {};
          // Low/balanced quality: smaller textures and less anisotropic
          // filtering (most of her GPU memory is decoded textures).
          const loader = limitedTextureLoader(textureLoader, this.quality?.maxTextureSize ?? 0);
          const anisotropy = Math.min(this.stage.maxAnisotropy, this.quality?.maxAnisotropy ?? 16);
          return createAnimeMaterial(raw, role, tuning, loader, anisotropy);
        },
      });

      if (this.disposed) return;
      this.model = model;
      this.applyReflectionStrength();

      // ---- scene assembly -------------------------------------------------
      const root = new THREE.Group();
      root.name = `character:${this.config.id}`;
      root.scale.setScalar(this.config.scale);
      root.position.y = this.config.groundOffset;
      this.characterRoot = root;

      const shadows = this.config.lighting.shadow.enabled;
      model.mesh.castShadow = shadows;
      model.mesh.receiveShadow = shadows;
      root.add(model.mesh);

      if (this.config.outline?.enabled) {
        const outline = createOutlineMesh(
          model,
          (name) => resolveMaterialRole(name, this.config.materialRoles),
          (role) => this.config.materialTuning[role] ?? {},
          { scale: this.config.outline.scale ?? 1 }
        );
        if (outline) root.add(outline);
      }

      // Hide any materials the config asks to suppress.
      if (this.config.hiddenMaterials?.length) {
        const hidden = new Set(this.config.hiddenMaterials);
        const materials = model.mesh.material as THREE.Material[];
        model.materials.forEach((info, i) => {
          if (hidden.has(info.name)) materials[i].visible = false;
        });
      }

      this.stage.scene.add(root);

      // ---- lighting -------------------------------------------------------
      this.lighting = new AnimeLightingRig(this.config.lighting);
      this.stage.scene.add(this.lighting.group);

      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
      this.lighting.frame(center, radius);

      // ---- animation systems ---------------------------------------------
      // Order matters: PoseBuffer and GrantSolver capture the rest pose, so
      // they must be constructed before anything moves a bone.
      this.morphs = new MorphController(model);

      // Skeleton/physics analysis: imported characters bring it in their
      // profile (with the user's overrides); built-ins are analysed now.
      const analysis = this.profile
        ? { skeleton: this.profile.skeleton, physics: this.profile.physics, facing: this.profile.facing, height: this.profile.height }
        : analyzeRig(model.rig);
      this.rigInfo = {
        humanoid: analysis.skeleton.humanoid,
        bones: analysis.skeleton.bones,
        chains: analysis.physics.chains,
        colliders: analysis.physics.colliders,
        facing: analysis.facing,
        height: analysis.height,
      };
      // The runtime convention is "character faces +Z"; turn models that
      // were authored facing the other way.
      if (analysis.facing < 0) root.rotation.y = Math.PI;
      root.updateMatrixWorld(true);

      // Bind pose rotations, before anything is baked, for portable poses.
      const bindRotations = new Map<string, THREE.Quaternion>();
      for (const bone of model.bones) bindRotations.set(bone.name, bone.quaternion.clone());

      this.pose = new PoseBuffer(model);
      this.pose.registerAll(Object.values(this.config.bones));
      const basePose = this.config.basePose ?? this.computeRelaxedBasePose(model);

      // Replace the model's authored A-pose with a relaxed stance BEFORE
      // anything captures a rest state, so the natural pose becomes the
      // baseline every other system works relative to.
      if (basePose) {
        for (const [slot, offset] of Object.entries(basePose)) {
          const boneName = this.config.bones[slot as keyof typeof this.config.bones];
          this.pose.bakeIntoRest(boneName, offset.x ?? 0, offset.y ?? 0, offset.z ?? 0);
        }
      }

      // Constructed after the base pose so inherited rotations are measured
      // from the natural stance, not the A-pose.
      this.grants = new GrantSolver(model);

      // Bone morphs (eyebrows) and grant targets are written additively on top
      // of the pose each frame, so they must be reset each frame too.
      for (const bone of this.morphs.morphedBones) this.pose.register(bone.name);
      this.pose.registerAll(this.grants.affectedBoneNames);

      this.face = new FaceController(this.morphs, this.config.morphs, this.config.idle);
      this.idle = new ProceduralIdle(this.config.bones, this.config.idle);
      this.performance = new PerformanceController();
      this.gaze = new GazeController(model, this.config.bones, this.config.idle);
      this.behaviours = new BehaviourDirector(this.config.behaviour);

      model.mesh.updateMatrixWorld(true);
      this.physics = new SecondaryMotion(model, analysis.physics.chains, analysis.physics.colliders, analysis.physics.nodeGroups);
      this.physics.setSettings(this.physicsSettings);
      this.physics.reset();

      // Vertex cloth: every garment surface becomes simulated fabric that
      // stays attached to her (see ClothLayer). Built from the rest pose.
      const chainBones = new Set<number>();
      for (const chain of analysis.physics.chains) for (const name of chain.bones) {
        const index = model.boneIndexByName.get(name);
        if (index !== undefined) chainBones.add(index);
      }
      const roleOf = (materialIndex: number) => resolveMaterialRole(model.materials[materialIndex].name, this.config.materialRoles);
      this.materialRoles = model.materials.map((info) => roleOf(info.index));
      try {
        // Low quality skips vertex cloth entirely (bone physics still sways).
        this.cloth = this.quality && !this.quality.cloth ? null : ClothLayer.build(model, roleOf, this.physics.worldCapsules(), analysis.height, chainBones);
      } catch (error) {
        console.warn('[cloth] could not build the cloth layer:', error);
        this.cloth = null;
      }
      if (this.cloth) {
        const materials = model.mesh.material as THREE.Material[];
        model.materials.forEach((info, i) => {
          const role = roleOf(info.index);
          if ((role === 'cloth' || role === 'lightCloth' || role === 'leather') && materials[i] && !(materials[i] as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
            this.cloth!.patchMaterial(materials[i]);
          }
        });
        this.cloth.setSettings(this.clothSettings);
      }

      // Eyes keep their AI life even when the user owns the body.
      for (const eye of [this.config.bones.eyes, this.config.bones.eyeL, this.config.bones.eyeR]) if (eye) this.pose.aiExempt.add(eye);
      this.editor = new PoseEditor({
        model,
        pose: this.pose,
        catalog: analysis.skeleton.bones,
        humanoid: analysis.skeleton.humanoid,
        facing: 1,
        scene: this.stage.scene,
        camera: this.stage.camera,
        domElement: this.stage.renderer.domElement,
        physics: this.physics,
        bindRotations,
        secondaryClass: Object.fromEntries(analysis.physics.chains.flatMap((c) => c.bones.map((b) => [b, c.class]))),
      });

      this.updateFocus();
      this.onProgress?.('Ready', 1);
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // ---- sitting ---------------------------------------------------------------

  /** Leg measurements from the bind pose, in world space. */
  private seatMeasures(): SeatMeasures | null {
    const model = this.model;
    const humanoid = this.rigInfo?.humanoid;
    if (!model || !humanoid) return null;
    model.mesh.updateMatrixWorld(true);
    const bind = (slot: string) => {
      const name = humanoid[slot]?.bone;
      const index = name ? model.boneIndexByName.get(name) : undefined;
      return index === undefined ? null : model.boneInfos[index].position.clone().applyMatrix4(model.mesh.matrixWorld);
    };
    const hipL = bind('LEFT_UPPER_LEG'), hipR = bind('RIGHT_UPPER_LEG'), kneeL = bind('LEFT_LOWER_LEG'), ankleL = bind('LEFT_FOOT'), head = bind('HEAD');
    if (!hipL || !hipR || !kneeL || !ankleL || !head) return null;
    const floorY = this.footSoleY() ?? ankleL.y - (head.y - ankleL.y) * 0.05;
    const height = Math.max(1e-3, head.y - floorY);
    return {
      hipL, hipR, kneeL, ankleL,
      thigh: hipL.distanceTo(kneeL),
      shin: kneeL.distanceTo(ankleL),
      ankleHeight: Math.max(height * 0.02, ankleL.y - floorY),
      floorY,
      height,
    };
  }

  private soleCache: number | null | undefined;
  /** Bottom-of-shoe vertices per foot (see footSoleY). */
  private readonly soleVertices: Record<'LEFT' | 'RIGHT', number[]> = { LEFT: [], RIGHT: [] };

  /**
   * Floor height = the lowest bind-pose vertex skinned mainly to a foot bone
   * (foot, toes and their children). The whole mesh's bounding box is not
   * usable: hidden parts, long hair or ribbons often reach below the shoes.
   */
  private footSoleY(): number | null {
    if (this.soleCache !== undefined) return this.soleCache;
    const model = this.model, humanoid = this.rigInfo?.humanoid;
    if (!model || !humanoid) return null;
    const feet = new Set<number>();
    const addTree = (bone: THREE.Object3D) => {
      const index = model.boneIndexByName.get(bone.name);
      if (index !== undefined) feet.add(index);
      for (const child of bone.children) if ((child as THREE.Bone).isBone) addTree(child);
    };
    for (const slot of ['LEFT_FOOT', 'RIGHT_FOOT']) {
      const name = humanoid[slot]?.bone;
      const index = name ? model.boneIndexByName.get(name) : undefined;
      if (index !== undefined) addTree(model.bones[index]);
    }
    // MMD rigs skin the shoes to deform twins (足首D, 足先EX) that sit beside
    // the humanoid ankle in the hierarchy rather than under it: match those
    // by name too, below knee height.
    const kneeY = Math.max(
      ...['LEFT_LOWER_LEG', 'RIGHT_LOWER_LEG'].map((slot) => {
        const index = humanoid[slot]?.bone ? model.boneIndexByName.get(humanoid[slot].bone) : undefined;
        return index === undefined ? -Infinity : model.boneInfos[index].position.y;
      }),
    );
    const footName = /足首|足先|つま先|爪先|toe|foot|ankle|shoe|靴/i;
    model.bones.forEach((bone, index) => {
      if (footName.test(bone.name) && (!Number.isFinite(kneeY) || model.boneInfos[index].position.y < kneeY)) addTree(bone);
    });
    // Which foot each bone belongs to: by name (左/右, L/R), else by side of
    // the body in the bind pose.
    const sideOf = new Map<number, 'LEFT' | 'RIGHT'>();
    const footX = (slot: string) => {
      const index = humanoid[slot]?.bone ? model.boneIndexByName.get(humanoid[slot].bone) : undefined;
      return index === undefined ? null : model.boneInfos[index].position.x;
    };
    const leftX = footX('LEFT_FOOT'), rightX = footX('RIGHT_FOOT');
    for (const index of feet) {
      const name = model.bones[index].name;
      let side: 'LEFT' | 'RIGHT' | null = /左|left|(^|[_.\s-])l([_.\s-]|$)/i.test(name) ? 'LEFT' : /右|right|(^|[_.\s-])r([_.\s-]|$)/i.test(name) ? 'RIGHT' : null;
      if (!side && leftX !== null && rightX !== null) {
        const x = model.boneInfos[index].position.x;
        side = Math.abs(x - leftX) <= Math.abs(x - rightX) ? 'LEFT' : 'RIGHT';
      }
      if (side) sideOf.set(index, side);
    }
    const geometry = model.mesh.geometry;
    const position = geometry.getAttribute('position');
    const skinIndex = geometry.getAttribute('skinIndex');
    const skinWeight = geometry.getAttribute('skinWeight');
    let minY = Infinity;
    const perSide: Record<'LEFT' | 'RIGHT', Array<{ i: number; y: number; z: number }>> = { LEFT: [], RIGHT: [] };
    if (feet.size && position && skinIndex && skinWeight) {
      for (let i = 0; i < position.count; i++) {
        let best = -1, bestW = 0;
        for (let k = 0; k < 4; k++) {
          const w = skinWeight.getComponent(i, k);
          if (w > bestW) { bestW = w; best = skinIndex.getComponent(i, k); }
        }
        if (feet.has(best)) {
          minY = Math.min(minY, position.getY(i));
          const side = sideOf.get(best);
          if (side) perSide[side].push({ i, y: position.getY(i), z: position.getZ(i) });
        }
      }
    }
    // Sole points per foot: the lowest vertex plus the heel and toe ends of
    // the bottom band, so a raised heel or tiptoe still finds the contact.
    if (Number.isFinite(minY)) {
      for (const side of ['LEFT', 'RIGHT'] as const) {
        const all = perSide[side];
        if (!all.length) continue;
        const sideMin = all.reduce((a, b) => Math.min(a, b.y), Infinity);
        const sideMax = all.reduce((a, b) => Math.max(a, b.y), -Infinity);
        const band = (sideMax - sideMin) * 0.12;
        const low = all.filter((v) => v.y <= sideMin + band);
        const lowest = low.reduce((a, b) => (b.y < a.y ? b : a));
        const heel = low.reduce((a, b) => (b.z < a.z ? b : a));
        const toe = low.reduce((a, b) => (b.z > a.z ? b : a));
        this.soleVertices[side] = [...new Set([lowest.i, heel.i, toe.i])];
      }
    }
    model.mesh.updateMatrixWorld(true);
    this.soleCache = Number.isFinite(minY) ? new THREE.Vector3(0, minY, 0).applyMatrix4(model.mesh.matrixWorld).y : null;
    return this.soleCache;
  }

  /**
   * Sit down on a real seat. The seat is built to fit her legs and placed
   * under her; the pose is solved with IK against it and eased in. While
   * seated, hips and legs stay put while breathing, gaze and the upper body
   * stay alive, and dangling legs swing.
   */
  sit(options: { seat: SeatKind; style?: SitStyle; side?: 1 | -1; duration?: number }): SeatPlan | null {
    const editor = this.editor, pose = this.pose, root = this.characterRoot, model = this.model;
    if (!editor || !pose || !root || !model) return null;
    this.removeSeat();
    const measures = this.seatMeasures();
    if (!measures) return null;
    const style = options.style && STYLES_FOR_SEAT[options.seat].includes(options.style) ? options.style : STYLES_FOR_SEAT[options.seat][0];
    const plan = planSeat(options.seat, style, measures, options.side ?? 1);
    const prop = buildSeatProp(plan, measures);
    if (prop) {
      this.stage.scene.add(prop);
      root.attach(prop); // keeps its world placement, then follows the character
    }
    const seated = editor.solveSeated(plan);
    editor.blendAmount = 0.6;
    editor.setOwnership('BLENDED');
    const duration = options.duration ?? 1.1;
    editor.apply(seated, { duration });
    pose.aiSuppressed.clear();
    for (const slot of SEATED_LOCKED_SLOTS) {
      const name = this.rigInfo?.humanoid[slot]?.bone;
      if (name) pose.aiSuppressed.add(name);
    }
    this.standUntil = 0;
    this.seating = { plan, prop, settleAt: duration, time: 0, base: null };
    return plan;
  }

  /** Stand back up and remove the seat. */
  stand(duration = 0.9): void {
    const editor = this.editor;
    if (!editor || !this.seating) return;
    this.removeSeat();
    editor.apply({ version: 2, space: 'bind', bones: {} }, { duration });
    // Hand the body back to the AI once the transition has finished.
    this.standUntil = duration;
  }

  get seat(): { seat: SeatKind; style: SitStyle } | null {
    return this.seating ? { seat: this.seating.plan.seat, style: this.seating.plan.style } : null;
  }

  private removeSeat(): void {
    if (!this.seating) return;
    const prop = this.seating.prop;
    if (prop) {
      prop.removeFromParent();
      prop.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
      });
    }
    this.pose?.aiSuppressed.clear();
    this.seating = null;
  }

  /**
   * Seated idle: small, continuous motion layered on the solved pose so she
   * never looks frozen - dangling legs swing out of phase, a crossed top foot
   * bobs. Runs after the editor's transition, on the user layer.
   */
  private updateSeated(delta: number): void {
    const seating = this.seating, pose = this.pose, humanoid = this.rigInfo?.humanoid;
    if (!seating || !pose || !humanoid) return;
    seating.time += delta;
    if (seating.time < seating.settleAt + 0.05) return;
    const name = (slot: string) => humanoid[slot]?.bone;
    const plan = seating.plan;
    const swing = plan.dangling ? plan.swing ?? 'alternate' : 'none';
    const moving = swing !== 'none'
      ? ['LEFT_LOWER_LEG', 'RIGHT_LOWER_LEG', 'LEFT_FOOT', 'RIGHT_FOOT']
      : plan.style === 'crossed' ? ['LEFT_FOOT', 'RIGHT_FOOT'] : [];
    if (!moving.length) return;
    if (!seating.base) {
      seating.base = new Map();
      for (const slot of moving) {
        const bone = name(slot);
        const q = bone ? pose.getUserRotation(bone) : undefined;
        if (bone && q) seating.base.set(slot, q.clone());
      }
    }
    const axis = new THREE.Vector3(1, 0, 0);
    const t = seating.time;
    // Kicking comes in bursts: a slow envelope between lazy and lively, so
    // the legs never tick like a metronome.
    const burst = 0.35 + 0.65 * Math.max(0, Math.sin(t * 0.23 + 1.3)) * (0.7 + 0.3 * Math.sin(t * 0.61));
    for (const [slot, base] of seating.base) {
      const bone = name(slot);
      if (!bone) continue;
      const left = slot.startsWith('LEFT');
      const knee = slot.endsWith('LOWER_LEG');
      let degrees = 0;
      if (swing === 'alternate') {
        const phase = left ? 0 : Math.PI * 0.92;
        const s = Math.sin(t * 2.4 + phase) * 0.75 + Math.sin(t * 0.83 + phase * 1.7) * 0.25;
        degrees = (knee ? s * 16 : s * -9) * burst;
      } else if (swing === 'together') {
        const s = Math.sin(t * 1.7) * 0.8 + Math.sin(t * 0.57) * 0.2;
        degrees = (knee ? s * 7 : s * -4) * burst;
      } else if (swing === 'front') {
        if (slot !== `${plan.frontLeg ?? 'LEFT'}_LOWER_LEG` && slot !== `${plan.frontLeg ?? 'LEFT'}_FOOT`) continue;
        const s = Math.sin(t * 1.9) * 0.8 + Math.sin(t * 0.7) * 0.2;
        degrees = (knee ? s * 20 : s * -10) * burst;
      } else {
        // Crossed knees: only the top foot bobs, in short bursts.
        const top = plan.legs.LEFT.target.y > plan.legs.RIGHT.target.y ? 'LEFT' : 'RIGHT';
        if (slot !== `${top}_FOOT`) continue;
        degrees = Math.max(0, Math.sin(t * 0.35)) * Math.sin(t * 5.2) * 7;
      }
      pose.setUserRotation(bone, base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees))));
    }
  }

  /** Push the latest application state. Cheap; safe to call every render. */
  setFrameInput(input: Partial<CharacterFrameInput>): void {
    Object.assign(this.frameInput, input);
  }

  setPointer(x: number, y: number): void {
    this.pointerNdc.set(x, y);
    this.stage.setPointer(x, y);
  }

  // ---- user camera control (forwarded to the stage) -----------------------

  orbitBy(deltaYaw: number, deltaPitch: number): void {
    this.stage.orbitBy(deltaYaw, deltaPitch);
  }

  zoomBy(delta: number): void {
    this.stage.zoomBy(delta);
  }

  setViewLocked(locked: boolean): void {
    this.stage.setLocked(locked);
  }

  get isViewLocked(): boolean {
    return this.stage.isLocked;
  }

  /**
   * Blend between the art-directed anime look (0) and physically based shading
   * with skin subsurface, fabric sheen and studio reflections (1). Shared by
   * every character in this window.
   */
  setRealism(amount: number): void {
    setCharacterRealism(amount);
  }

  /**
   * Scale only additive material reflections (specular, hair bands, sphere-map
   * shine and rim). Diffuse illumination, shadows and exposure stay untouched.
   */
  setReflectionStrength(strength: number): void {
    this.reflectionStrength = THREE.MathUtils.clamp(strength, 0, 2);
    this.applyReflectionStrength();
  }

  private applyReflectionStrength(): void {
    if (!this.model) return;
    const materials = this.model.mesh.material;
    for (const material of Array.isArray(materials) ? materials : [materials]) {
      setAnimeMaterialReflectionStrength(material, this.reflectionStrength);
    }
  }

  resetView(): void {
    this.stage.resetView();
  }

  /** Snap to a named viewpoint around the character. */
  setView(preset: 'front' | 'back' | 'left' | 'right' | 'threeQuarter'): void {
    const yaw = {
      front: 0,
      threeQuarter: Math.PI * 0.22,
      right: Math.PI * 0.5,
      back: Math.PI,
      left: -Math.PI * 0.5,
    }[preset];
    this.stage.setOrbit(yaw, 0);
  }

  /**
   * When enabled, her eyes (and a little head follow) track the mouse pointer
   * instead of running the automatic gaze behaviour.
   */
  setEyeTracking(enabled: boolean): void {
    this.eyeTracking = enabled;
  }

  get isEyeTracking(): boolean {
    return this.eyeTracking;
  }

  resize(width: number, height: number): void {
    this.stage.resize(width, height);
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.clock.start();
    this.lastFrameTime = performance.now();
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private tick = (stamp?: number): void => {
    if (!this.running || this.disposed) return;
    this.rafHandle = requestAnimationFrame(this.tick);

    // The vsync timestamp, not "now": deltas then step in whole refresh
    // intervals and motion does not micro-stutter.
    const now = typeof stamp === 'number' ? stamp : performance.now();
    // Throttle to the configured target frame rate. A companion app shares
    // the GPU with everything else on the desktop; there is no reason to
    // render faster than the character can be perceived to move. The 15%
    // slack keeps whole-vsync pacing (75/144 Hz screens would otherwise skip
    // to every other or third refresh, unevenly).
    const minInterval = (1000 / (this.fpsCap ?? this.config.render.targetFps)) * 0.85;
    if (now - this.lastFrameTime < minInterval) return;

    const delta = Math.min((now - this.lastFrameTime) / 1000, MAX_DELTA);
    this.lastFrameTime = now;

    try {
      this.update(delta);
      this.frameErrors = 0;
    } catch (error) {
      // One bad frame must not freeze her for good: log it and carry on.
      // Only a persistent failure (every frame for ~2 s) stops the loop.
      this.frameErrors += 1;
      if (this.frameErrors === 1) console.error('[CharacterSystem] frame failed:', error);
      if (this.frameErrors >= 120) {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
        this.stop();
      }
    }
  };
  private frameErrors = 0;
  private fpsCap: number | null = null;

  /** Cap the frame rate (null: the character's configured rate). */
  setFrameRateCap(fps: number | null): void {
    this.fpsCap = fps && fps > 0 ? Math.min(fps, this.config.render.targetFps) : null;
  }

  /** Resolve the camera focus point from the configured bone. */
  private focusBoneOverride: string | null = null;

  /**
   * Point the camera at another bone (editor framing: hands, feet, full
   * body). `null` returns to the configured face framing.
   */
  setCameraFocus(boneName: string | null, distance?: number): void {
    this.focusBoneOverride = boneName;
    if (distance !== undefined) this.stage.setDistance(distance);
    else if (!boneName) this.stage.resetView();
  }

  private updateFocus(): void {
    if (this.generic && this.characterRoot) {
      if (this.fixedFocus) {
        this.focusPoint.copy(this.fixedFocus);
        this.stage.setFocus(this.focusPoint);
        return;
      }
      const target = this.genericHead ?? this.characterRoot;
      target.getWorldPosition(this.focusPoint);
      if (!this.focusBoneOverride) this.focusPoint.y += this.config.camera.targetOffset;
      this.stage.setFocus(this.focusPoint);
      return;
    }
    const model = this.model;
    if (!model) return;
    if (this.fixedFocus) {
      // Desktop companion: the camera must not follow a bone. If it tracked
      // the hips, every weight shift, bounce or sit would slide her feet off
      // the surface she stands on.
      this.focusPoint.copy(this.fixedFocus);
      this.stage.setFocus(this.focusPoint);
      return;
    }
    const target = this.focusBoneOverride ?? this.config.camera.targetBone;
    const index = model.boneIndexByName.get(target);
    const bone = index !== undefined ? model.bones[index] : undefined;
    if (bone) {
      bone.getWorldPosition(this.focusPoint);
    } else {
      model.mesh.getWorldPosition(this.focusPoint);
    }
    if (!this.focusBoneOverride) this.focusPoint.y += this.config.camera.targetOffset;
    this.stage.setFocus(this.focusPoint);
  }

  private update(delta: number): void {
    if (this.generic) {
      this.updateGeneric(delta);
      return;
    }
    const {
      model, pose, morphs, face, idle, performance, gaze, grants,
      physics, behaviours, lighting,
    } = this;
    if (
      !model || !pose || !morphs || !face || !idle || !performance ||
      !gaze || !grants || !physics || !behaviours || !lighting
    ) {
      return;
    }

    const input = this.frameInput;
    this.currentActivity = input.activity;

    // ---- speech authority -------------------------------------------------
    // How much the lip-sync engine owns the mouth, eased so the mouth does not
    // pop between talking and not talking.
    const wantsSpeech = input.activity === 'talking';
    this.speechAuthority = THREE.MathUtils.lerp(
      this.speechAuthority,
      wantsSpeech ? 1 : 0,
      1 - Math.exp(-8 * delta)
    );

    const visemes: VisemeWeights = this.lipSync.update(
      wantsSpeech ? input.outputAnalyser : null,
      delta,
      wantsSpeech
    );

    // ---- 1. reset ---------------------------------------------------------
    pose.begin();
    morphs.begin();

    // ---- 2-4. pose layers -------------------------------------------------
    // A selected emotion is a deliberate performance. Random idle behaviours
    // fade away so a cheerful overlay cannot turn embarrassed or sad into a
    // generic smile.
    const explicitEmotion = input.emotion !== 'idle';
    behaviours.setEnabled(!explicitEmotion);

    idle.setIntensity(behaviours.idleIntensity);
    idle.update(delta, pose);

    performance.update({
      delta,
      activity: this.currentActivity,
      emotion: input.emotion,
      pose,
      bones: this.config.bones,
    });

    behaviours.update({
      delta,
      activity: this.currentActivity,
      pose,
      bones: this.config.bones,
    });
    for (const layer of this.poseLayers) {
      try {
        layer(delta, pose, this.config.bones);
      } catch (error) {
        console.warn('[CharacterSystem] pose layer failed:', error);
      }
    }

    // One-shot body performances (jump/wave/…): full-body overrides that
    // compose over idle, so she keeps breathing mid-action.
    try {
      this.actions.update(delta, pose, this.config.bones);
    } catch (error) {
      console.warn('[CharacterSystem] action layer failed:', error);
      this.actions.stop();
    }

    gaze.setEmotion(input.emotion);

    if (this.eyeTracking) {
      // Project the pointer into the world at roughly the character's depth,
      // so her eyes converge on where the cursor actually appears on screen.
      // Treat the cursor as lying on a plane halfway between the viewer and
      // her face, so screen edges read as "over there" rather than as a point
      // beside her ear (or, with an NDC depth, right on the camera lens).
      const camera = this.stage.camera;
      this.gazePoint.set(this.pointerNdc.x, this.pointerNdc.y, 0.5).unproject(camera).sub(camera.position).normalize();
      const depth = camera.position.distanceTo(this.focusPoint) * 0.5;
      const forward = this._gazeForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      const along = Math.max(1e-3, this.gazePoint.dot(forward));
      this.gazePoint.multiplyScalar(depth / along).add(camera.position);
      gaze.lookAt(this.gazePoint);
    } else {
      // Explicit emotions own gaze direction. Shy and sad performances look
      // away, curious/confused eyes explore, and confident emotions reconnect
      // with the viewer. Each mode still contains changing fixation points.
      const emotionalGaze: GazeMode | undefined =
        input.emotion === 'embarrassed' ||
        input.emotion === 'sad' ||
        input.emotion === 'thinking'
          ? 'away'
          : input.emotion === 'curious' || input.emotion === 'confused'
            ? 'wander'
            : input.emotion === 'idle'
              ? undefined
              : 'user';
      const behaviourGaze = explicitEmotion ? undefined : behaviours.gazeOverride;
      const gazeMode: GazeMode =
        behaviourGaze ??
        emotionalGaze ??
        (this.currentActivity === 'thinking'
          ? 'away'
          : this.currentActivity === 'idle'
            ? 'wander'
            : 'user');
      gaze.setMode(gazeMode);
    }
    gaze.update(delta, pose, this.stage.camera.position);

    // ---- 5. commit the pose ----------------------------------------------
    // The editor eases ownership weights (AI / USER / BLENDED) first.
    this.editor?.update(delta);
    this.updateSeated(delta);
    if (this.standUntil > 0) {
      this.standUntil -= delta;
      if (this.standUntil <= 0) {
        this.standUntil = 0;
        this.editor?.setOwnership('AI');
      }
    }
    pose.apply();

    // One-shot root motion (hop height, spin yaw, flip pitch): applied as a
    // delta each frame so it composes with seating/grounding and nets to
    // zero at rest.
    if (this.characterRoot && (this.actions.root.y !== 0 || this.actions.root.yaw !== 0 || this.actions.root.pitch !== 0 || this.lastActionRoot.y !== 0 || this.lastActionRoot.yaw !== 0 || this.lastActionRoot.pitch !== 0)) {
      const scale = this.config.scale || 1;
      this.characterRoot.position.y += (this.actions.root.y - this.lastActionRoot.y) * scale;
      this.characterRoot.rotation.y += this.actions.root.yaw - this.lastActionRoot.yaw;
      this.characterRoot.rotation.x += this.actions.root.pitch - this.lastActionRoot.pitch;
      this.lastActionRoot.y = this.actions.root.y;
      this.lastActionRoot.yaw = this.actions.root.yaw;
      this.lastActionRoot.pitch = this.actions.root.pitch;
    }

    // ---- 6. face ----------------------------------------------------------
    const targetExpression =
      input.emotion === 'idle' && this.currentActivity === 'listening'
        ? 'listening'
        : input.emotion === 'idle' && this.currentActivity === 'thinking'
          ? 'thinking'
          : input.emotion;
    const expressionBlend =
      targetExpression === 'surprised' || targetExpression === 'excited'
        ? 0.24
        : targetExpression === 'embarrassed' || targetExpression === 'sad'
          ? 0.38
          : 0.32;
    face.setExpression(targetExpression, expressionBlend);
    if (gaze.consumeBlinkRequest() || behaviours.consumeBlinkRequest()) face.triggerBlink();

    face.update({
      delta,
      visemes,
      speechAuthority: this.speechAuthority,
      overlay: explicitEmotion ? undefined : behaviours.overlay,
      overlayWeight: explicitEmotion ? 0 : behaviours.overlayWeight,
    });

    // ---- 7. morphs --------------------------------------------------------
    morphs.commitVertexMorphs();
    // Bone morphs stack on top of the pose that was just applied.
    morphs.commitBoneMorphs();

    // ---- 8. grants --------------------------------------------------------
    grants.solve();

    // ---- 9. world matrices ------------------------------------------------
    model.mesh.updateMatrixWorld(true);

    // ---- 10. physics ------------------------------------------------------
    this.feedScreenMotion();
    physics.update(delta);
    // Vertex cloth follows the final skeleton (after strand physics).
    if (this.cloth) {
      this.cloth.setColliders(physics.worldCapsules());
      this.cloth.update(delta);
    }
    this.editor?.afterPose();
    if (this.physicsDebug) this.updatePhysicsDebug();

    // ---- 11. camera, lighting, render -------------------------------------
    this.updateFocus();
    this.stage.update(delta);
    lighting.update(this.stage.camera);
    this.stage.render();
  }

  // ---- character customisation API -------------------------------------------

  /** Pose editor for the loaded character (null until loaded). */
  get poseEditor(): PoseEditor | null {
    return this.editor;
  }

  /** Skeleton/physics analysis the runtime is using. */
  get rig() {
    return this.rigInfo;
  }

  get loadedModel(): PmxModel | null {
    return this.model;
  }

  get root(): THREE.Group | null {
    return this.characterRoot;
  }

  /** Names of the body actions she can perform on request. */
  get supportedActions(): readonly CharacterActionName[] {
    return CHARACTER_ACTIONS;
  }

  /** Currently running one-shot action, if any. */
  get currentAction(): CharacterActionName | null {
    return this.actions.active;
  }

  /**
   * Perform a body action ("jump", "wave", …). A new action replaces a
   * running one. Returns the canonical name, or null for unknown words.
   */
  performAction(raw: string): CharacterActionName | null {
    // Bone-driven performances need the PMX pose buffer; other models get a
    // null so the caller can say so honestly instead of faking it.
    if (!this.model || !this.pose) return null;
    // A replaced mid-hop action must not leave its root offset behind.
    this.revertActionRoot();
    const started = this.actions.perform(raw);
    return started;
  }

  stopAction(): void {
    this.actions.stop();
    this.revertActionRoot();
  }

  /** Return any applied hop/spin/flip offset to the character root. */
  private revertActionRoot(): void {
    if (this.characterRoot && (this.lastActionRoot.y !== 0 || this.lastActionRoot.yaw !== 0 || this.lastActionRoot.pitch !== 0)) {
      const scale = this.config.scale || 1;
      this.characterRoot.position.y -= this.lastActionRoot.y * scale;
      this.characterRoot.rotation.y -= this.lastActionRoot.yaw;
      this.characterRoot.rotation.x -= this.lastActionRoot.pitch;
    }
    this.lastActionRoot.y = 0;
    this.lastActionRoot.yaw = 0;
    this.lastActionRoot.pitch = 0;
  }

  /**
   * Tint her outfit / hair ("#e11d48", "red", null to reset). ONLY materials
   * explicitly classified as clothing/hair are touched — skin, face, eyes
   * and unmapped parts are never tinted (that fallback exists for shading,
   * and tinting it dyes the whole body). In-memory only. PMX models only.
   */
  setOutfitTint(tint: { cloth?: string | null; hair?: string | null }): boolean {
    const model = this.model;
    if (!model) return false;
    const parse = (value: string | null | undefined): THREE.Color | null | undefined => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      const hex = /^#?([0-9a-f]{6})$/i.exec(value.trim());
      if (!hex) return undefined;
      return new THREE.Color(`#${hex[1]}`);
    };
    const cloth = parse(tint.cloth);
    const hair = parse(tint.hair);
    if (cloth === undefined && hair === undefined) return false;
    const materials = model.mesh.material as THREE.Material[];
    let touched = 0;
    model.materials.forEach((info, i) => {
      const english = (info as { englishName?: string }).englishName;
      const target =
        cloth !== undefined && isOutfitTintable(info.name, this.config.materialRoles, english) ? cloth
        : hair !== undefined && isHairTintable(info.name, this.config.materialRoles, english) ? hair
        : undefined;
      if (target === undefined) return;
      const mat = materials[i] as THREE.Material & { color?: THREE.Color };
      if (!mat || !mat.color) return;
      if (!this.originalColors.has(i)) this.originalColors.set(i, mat.color.clone());
      if (target === null) {
        const original = this.originalColors.get(i);
        if (original) mat.color.copy(original);
      } else {
        const original = this.originalColors.get(i) ?? mat.color;
        mat.color.copy(original).multiply(target);
      }
      touched += 1;
    });
    return touched > 0;
  }

  get secondaryMotion(): SecondaryMotion | null {
    return this.physics;
  }

  setOwnership(mode: PoseOwnership): void {
    this.editor?.setOwnership(mode);
  }

  setPhysicsSettings(settings: Partial<SecondaryMotionSettings>): void {
    this.physicsSettings = { ...this.physicsSettings, ...settings };
    this.physics?.setSettings(this.physicsSettings);
  }

  setChainEnabled(id: string, enabled: boolean): void {
    this.physics?.setChainEnabled(id, enabled);
  }

  /**
   * The character's window moved on screen by (dx, dy) CSS pixels (desktop
   * companion drag). Converted to world units at the character's depth and
   * fed to secondary motion as inertial frame movement.
   */
  addScreenMotion(dxPx: number, dyPx: number): void {
    if (!this.physics) return;
    const camera = this.stage.camera;
    const distance = camera.position.distanceTo(this.focusPoint);
    const height = this.stage.renderer.domElement.clientHeight || 1;
    const unitsPerPx = (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const motion = right.multiplyScalar(dxPx * unitsPerPx).addScaledVector(up, -dyPx * unitsPerPx);
    // Collected per frame; update() feeds physics only the CHANGE in this
    // motion (acceleration). A body moving at a steady pace does not wobble -
    // feeding raw displacement made her jiggle like jelly while walking.
    this.screenMotion.add(motion);
  }

  private readonly screenMotion = new THREE.Vector3();
  private readonly smoothedMotion = new THREE.Vector3();
  private readonly lastMotion = new THREE.Vector3();

  /** Turn the frame's window motion into an inertial impulse (velocity change only). */
  private feedScreenMotion(): void {
    if (!this.physics) return;
    // Smooth: window moves arrive on their own clock, not once per render frame.
    this.smoothedMotion.lerp(this.screenMotion, 0.45);
    this.screenMotion.set(0, 0, 0);
    const impulse = this.smoothedMotion.clone().sub(this.lastMotion);
    this.lastMotion.copy(this.smoothedMotion);
    // A little extra so a drop or a sudden yank still reads strongly, plus a
    // touch of air drag: at speed, hair and skirts trail slightly.
    impulse.multiplyScalar(1.6).addScaledVector(this.smoothedMotion, 0.06);
    if (impulse.lengthSq() < 1e-12) return;
    this.physics.addFrameMotion(impulse);
    this.cloth?.addFrameMotion(impulse);
  }

  // ---- cloth -------------------------------------------------------------------

  get clothLayer(): ClothLayer | null {
    return this.cloth;
  }

  setClothSettings(settings: Partial<ClothSettings>): void {
    this.clothSettings = { ...this.clothSettings, ...settings };
    this.cloth?.setSettings(this.clothSettings);
  }

  /**
   * Grab the fabric under a screen point (NDC). Returns true when cloth was
   * hit; drag with dragClothTo and let go with releaseCloth.
   */
  grabClothAt(ndcX: number, ndcY: number): boolean {
    const cloth = this.cloth;
    if (!cloth) return false;
    const camera = this.stage.camera;
    const index = cloth.pick(ndcX, ndcY, camera);
    if (index === null) return false;
    const point = cloth.particlePosition(index);
    const normal = new THREE.Vector3();
    camera.getWorldDirection(normal);
    this.clothGrab = { plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point) };
    cloth.grabParticle(index, point);
    return true;
  }

  dragClothTo(ndcX: number, ndcY: number): void {
    if (!this.cloth || !this.clothGrab) return;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.stage.camera);
    const hit = ray.ray.intersectPlane(this.clothGrab.plane, new THREE.Vector3());
    if (hit) this.cloth.dragParticle(hit);
  }

  releaseCloth(): void {
    this.clothGrab = null;
    this.cloth?.release();
  }

  /** Pan the camera (world units along camera right / world up). */
  panBy(dx: number, dy: number): void {
    this.stage.panBy(dx, dy);
  }

  /** Character height in world units (for framing and drag scaling). */
  get worldHeight(): number {
    const scale = this.characterRoot?.scale.y ?? 1;
    return (this.rigInfo?.height ?? 20) * scale;
  }

  /**
   * Alpha of the rendered character at a canvas pixel (CSS px), 0..255.
   * Renders a fresh frame and reads one pixel, so the result is valid even
   * without preserveDrawingBuffer. Used for click-through hit testing.
   */
  alphaAt(x: number, y: number): number {
    const renderer = this.stage.renderer;
    const canvas = renderer.domElement;
    const ratio = renderer.getPixelRatio();
    const px = Math.round(x * ratio);
    const py = Math.round((canvas.clientHeight - y) * ratio);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return 0;
    this.stage.render();
    const gl = renderer.getContext();
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out[3];
  }

  /** Screen-space (CSS px, from canvas top) of a humanoid slot, or null. */
  slotScreenY(slot: string): number | null {
    const name = this.rigInfo?.humanoid[slot]?.bone;
    const index = name && this.model ? this.model.boneIndexByName.get(name) : undefined;
    if (index === undefined || !this.model) return null;
    const v = this.model.bones[index].getWorldPosition(new THREE.Vector3()).project(this.stage.camera);
    return ((1 - v.y) / 2) * this.stage.renderer.domElement.clientHeight;
  }

  /**
   * Pan the view so a humanoid slot lands at a given canvas y (CSS px), e.g.
   * the companion's feet exactly on the window's bottom edge.
   */
  alignSlotToScreenY(slot: string, targetY: number): void {
    this.updateFocus();
    this.stage.update(1); // settle any easing first
    const current = this.slotScreenY(slot);
    if (current === null) return;
    const camera = this.stage.camera;
    const distance = camera.position.distanceTo(this.focusPoint);
    const height = this.stage.renderer.domElement.clientHeight || 1;
    const unitsPerPx = (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;
    // Character too high on screen → move the view up so she appears lower.
    this.stage.panBy(0, (targetY - current) * unitsPerPx);
    this.stage.update(1);
  }

  /** Frame the whole body in view. */
  frameFullBody(options: { top?: number; bottom?: number; width?: number } = {}): void {
    const hips = this.rigInfo?.humanoid.LOWER_BODY?.bone ?? this.rigInfo?.humanoid.HIPS?.bone ?? null;
    const fov = THREE.MathUtils.degToRad(this.stage.camera.fov);
    const tan = Math.tan(fov / 2);
    const h = this.worldHeight;
    // Fit both the body's height (with margins) and its width in this aspect.
    const vertical = (h * (1 + (options.top ?? 0.08) + (options.bottom ?? 0.03))) / 2 / tan;
    const horizontal = (h * (options.width ?? 0.3)) / (tan * Math.max(0.2, this.stage.camera.aspect));
    const distance = Math.max(vertical, horizontal) * 1.04;
    this.stage.clearPan();
    this.setCameraFocus(hips, distance);
    // Centre the frame between the top of the head and the feet, not on the hips.
    const model = this.model;
    const bone = (slot: string) => {
      const name = this.rigInfo?.humanoid[slot]?.bone;
      const index = name && model ? model.boneIndexByName.get(name) : undefined;
      return index === undefined || !model ? null : model.bones[index];
    };
    const hipBone = bone('LOWER_BODY') ?? bone('HIPS');
    const head = bone('HEAD');
    const foot = bone('LEFT_FOOT') ?? bone('RIGHT_FOOT');
    if (hipBone && head && foot) {
      const top = head.getWorldPosition(new THREE.Vector3()).y + this.worldHeight * (options.top ?? 0.08);
      const bottom = foot.getWorldPosition(new THREE.Vector3()).y - this.worldHeight * (options.bottom ?? 0.03);
      this.stage.panBy(0, (top + bottom) / 2 - hipBone.getWorldPosition(new THREE.Vector3()).y);
    }
  }

  // ---- desktop companion support ------------------------------------------------

  private fixedFocus: THREE.Vector3 | null = null;
  private readonly poseLayers: Array<(delta: number, pose: PoseBuffer, bones: CharacterConfig['bones']) => void> = [];
  private baseYaw: number | null = null;

  /** Extra procedural pose layer (AI layer, after behaviours). Returns a remover. */
  addPoseLayer(layer: (delta: number, pose: PoseBuffer, bones: CharacterConfig['bones']) => void): () => void {
    this.poseLayers.push(layer);
    return () => {
      const i = this.poseLayers.indexOf(layer);
      if (i >= 0) this.poseLayers.splice(i, 1);
    };
  }

  /** Random idle behaviours on/off (triggered ones still play). */
  setIdleBehaviours(enabled: boolean): void {
    this.behaviours?.setAutoPick(enabled);
  }

  /** +1 when the model's own front is +Z in its bone space, -1 when it was turned around. */
  get frontSign(): number {
    return (this.rigInfo?.facing ?? 1) < 0 ? -1 : 1;
  }

  /** Model-space units per world unit (bone translations are in model space). */
  get modelUnitsPerWorld(): number {
    return 1 / (this.characterRoot?.scale.y || 1);
  }

  /** Seat measurements (bind pose, world space). */
  get legMeasures(): SeatMeasures | null {
    return this.seatMeasures();
  }

  /** Ease out the behaviour that is playing, if any. */
  stopBehaviour(): void {
    this.behaviours?.cancel();
  }

  /** Play a named behaviour from the library now. */
  playBehaviour(name: string): boolean {
    return this.behaviours?.trigger(name) ?? false;
  }

  get behaviourName(): string | null {
    return this.behaviours?.currentName ?? null;
  }

  /** Semantic bone map of this character. */
  get boneMap(): CharacterConfig['bones'] {
    return this.config.bones;
  }

  get poseBuffer(): PoseBuffer | null {
    return this.pose;
  }

  /** Turn her about the vertical axis (radians, 0 = facing the viewer). */
  setTurn(radians: number): void {
    const root = this.characterRoot;
    if (!root) return;
    if (this.baseYaw === null) this.baseYaw = root.rotation.y;
    root.rotation.y = this.baseYaw + radians;
    root.updateMatrixWorld(true);
  }

  /**
   * Run pose solving in her own frame: planners and IK work in world space
   * assuming she faces the viewer, so any turn is taken out while solving
   * and put back afterwards (the solved local rotations turn with her).
   */
  inNeutralTurn<T>(work: () => T): T {
    const turn = this.turn;
    if (Math.abs(turn) < 1e-6) return work();
    this.setTurn(0);
    try {
      return work();
    } finally {
      this.setTurn(turn);
    }
  }

  get turn(): number {
    return this.characterRoot && this.baseYaw !== null ? this.characterRoot.rotation.y - this.baseYaw : 0;
  }

  /** World units per CSS pixel at the character's depth. */
  worldPerPixel(): number {
    const camera = this.stage.camera;
    const distance = camera.position.distanceTo(this.focusPoint);
    const height = this.stage.renderer.domElement.clientHeight || 1;
    return (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;
  }

  /** World point -> canvas CSS px (top-left origin). */
  worldToCanvas(point: THREE.Vector3): { x: number; y: number } {
    const v = point.clone().project(this.stage.camera);
    const el = this.stage.renderer.domElement;
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
  }

  /** Canvas CSS px -> world point on the camera-facing plane through `depthPoint`. */
  canvasToWorld(x: number, y: number, depthPoint: THREE.Vector3 = this.focusPoint): THREE.Vector3 {
    const el = this.stage.renderer.domElement;
    const ndc = new THREE.Vector2((x / (el.clientWidth || 1)) * 2 - 1, -((y / (el.clientHeight || 1)) * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.stage.camera);
    const normal = new THREE.Vector3();
    this.stage.camera.getWorldDirection(normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, depthPoint);
    return ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? depthPoint.clone();
  }

  /** Current world position of a humanoid slot's bone, or null. */
  slotWorld(slot: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    const name = this.rigInfo?.humanoid[slot]?.bone;
    const index = name && this.model ? this.model.boneIndexByName.get(name) : undefined;
    if (index === undefined || !this.model) return null;
    return this.model.bones[index].getWorldPosition(out);
  }

  /** Floor height (soles in the rest pose), world units. */
  get floorY(): number | null {
    return this.footSoleY();
  }

  /**
   * Current world positions of the bottom of each shoe (heel, toe, lowest
   * point), following the animated skeleton.
   */
  solePoints(): THREE.Vector3[] {
    const mesh = this.model?.mesh;
    if (!mesh) return [];
    this.footSoleY();
    const out: THREE.Vector3[] = [];
    for (const side of ['LEFT', 'RIGHT'] as const) {
      for (const i of this.soleVertices[side]) {
        const v = mesh.getVertexPosition(i, new THREE.Vector3());
        out.push(v.applyMatrix4(mesh.matrixWorld));
      }
    }
    return out;
  }

  /** Lowest current sole height in world units (her contact with the ground). */
  lowestSoleY(): number | null {
    const points = this.solePoints();
    return points.length ? Math.min(...points.map((p) => p.y)) : this.footSoleY();
  }

  /**
   * Frame her for the desktop companion window: whole body visible, camera
   * fixed in world space (never following a bone), and the floor - the soles
   * of her rest stance - exactly `floorPx` CSS px above the canvas bottom.
   */
  frameCompanion(options: { top?: number; width?: number; floorPx?: number } = {}): void {
    const model = this.model;
    const floor = this.footSoleY();
    const head = this.slotWorld('HEAD');
    const hips = this.slotWorld('LOWER_BODY') ?? this.slotWorld('HIPS');
    if (!model || floor === null || !head || !hips) return;
    const h = this.worldHeight;
    const fov = THREE.MathUtils.degToRad(this.stage.camera.fov);
    const tan = Math.tan(fov / 2);
    const top = head.y + h * (options.top ?? 0.16);
    const span = top - floor;
    const vertical = span / 2 / tan;
    const horizontal = (h * (options.width ?? 0.3)) / (tan * Math.max(0.2, this.stage.camera.aspect));
    const distance = Math.max(vertical, horizontal) * 1.02;
    this.focusBoneOverride = null;
    this.stage.clearPan();
    // Unclamped: a character's own zoom limits are for the main window and
    // would crop her (Evelyn's cap is closer than her full height needs).
    this.stage.setDistance(distance, { unclamped: true });
    this.fixedFocus = new THREE.Vector3(hips.x, (top + floor) / 2, hips.z);
    this.updateFocus();
    this.stage.update(10); // settle the eased distance and pan
    // Put the floor exactly `floorPx` above the canvas bottom.
    const el = this.stage.renderer.domElement;
    const target = el.clientHeight - (options.floorPx ?? 1);
    for (let pass = 0; pass < 3; pass++) {
      const current = this.worldToCanvas(new THREE.Vector3(hips.x, floor, hips.z)).y;
      // Raising the camera moves the floor down the canvas.
      this.fixedFocus.y += (target - current) * this.worldPerPixel();
      this.updateFocus();
      this.stage.update(10);
    }
  }

  /** Roll her about the view axis (radians): +PI/2 lays her down, head to screen-left. */
  setRoll(radians: number): void {
    const root = this.characterRoot;
    if (!root) return;
    // Turn first (about her own vertical), then roll in screen space.
    root.rotation.order = 'ZYX';
    root.rotation.z = radians;
    root.updateMatrixWorld(true);
  }

  /**
   * Fixed-camera framing around arbitrary world points (a lying pose): all
   * points fit with a margin, and the lowest one sits `floorPx` above the
   * canvas bottom (that row is where she rests on the ledge).
   */
  frameAround(points: THREE.Vector3[], options: { margin?: number; floorPx?: number } = {}): number | null {
    if (!points.length) return null;
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of points) { min.min(p); max.max(p); }
    const margin = (options.margin ?? 0.08) * this.worldHeight;
    const width = max.x - min.x + margin * 2;
    const height = max.y - min.y + margin * 2;
    const fov = THREE.MathUtils.degToRad(this.stage.camera.fov);
    const tan = Math.tan(fov / 2);
    const distance = Math.max(height / 2 / tan, width / 2 / (tan * Math.max(0.2, this.stage.camera.aspect))) * 1.02;
    this.focusBoneOverride = null;
    this.stage.clearPan();
    this.stage.setDistance(distance, { unclamped: true });
    this.fixedFocus = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    this.updateFocus();
    this.stage.update(10);
    const el = this.stage.renderer.domElement;
    const target = el.clientHeight - (options.floorPx ?? 6);
    const lowest = new THREE.Vector3((min.x + max.x) / 2, min.y, (min.z + max.z) / 2);
    for (let pass = 0; pass < 3; pass++) {
      const current = this.worldToCanvas(lowest).y;
      this.fixedFocus.y += (target - current) * this.worldPerPixel();
      this.updateFocus();
      this.stage.update(10);
    }
    return target;
  }

  /** Canvas y of the floor (rest-stance soles), or null. */
  floorCanvasY(): number | null {
    const floor = this.footSoleY();
    const hips = this.slotWorld('LOWER_BODY') ?? this.slotWorld('HIPS');
    if (floor === null || !hips) return null;
    return this.worldToCanvas(new THREE.Vector3(hips.x, floor, hips.z)).y;
  }

  /** The seat surface's canvas y while seated, or null. */
  seatLineCanvasY(): number | null {
    const plan = this.seating?.plan;
    if (!plan) return null;
    return this.worldToCanvas(new THREE.Vector3(plan.hipCenter.x, plan.seatTopY, plan.hipCenter.z)).y;
  }

  get seatPlan(): SeatPlan | null {
    return this.seating?.plan ?? null;
  }

  /** Teleport rebase (window jumped): settle hair/cloth without a whip. */
  rebasePhysics(): void {
    this.physics?.rebase();
    this.cloth?.reset();
    this.screenMotion.set(0, 0, 0);
    this.smoothedMotion.set(0, 0, 0);
    this.lastMotion.set(0, 0, 0);
  }

  /** Which configured expression morphs exist in the model, by kind. */
  morphReport(): { mapped: number; vertex: number; bone: number; broken: string[] } {
    const model = this.model;
    const names = Object.values(this.config.morphs).filter((n): n is string => !!n);
    const unique = [...new Set(names)];
    if (!model) return { mapped: 0, vertex: 0, bone: 0, broken: unique };
    return {
      mapped: unique.length,
      vertex: unique.filter((n) => model.vertexMorphs.has(n)).length,
      bone: unique.filter((n) => model.boneMorphs.has(n)).length,
      broken: unique.filter((n) => !model.vertexMorphs.has(n) && !model.boneMorphs.has(n) && !model.groupMorphs.has(n)),
    };
  }

  /** Total morph weight applied in the last frame. */
  morphActivity(): number {
    return this.morphs?.totalWeight ?? 0;
  }

  /** Run frames synchronously (tests and offline checks). */
  stepFrames(count: number, delta = 1 / 60): void {
    for (let i = 0; i < count; i += 1) this.update(delta);
  }

  setPhysicsDebug(enabled: boolean): void {
    if (enabled && !this.physicsDebug) {
      this.physicsDebug = new THREE.Group();
      this.physicsDebug.name = 'physics-debug';
      this.stage.scene.add(this.physicsDebug);
    } else if (!enabled && this.physicsDebug) {
      this.stage.scene.remove(this.physicsDebug);
      this.physicsDebug.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (m.material as THREE.Material).dispose();
      });
      this.physicsDebug = null;
    }
  }

  private updatePhysicsDebug(): void {
    const group = this.physicsDebug;
    if (!group || !this.physics) return;
    const geometry = this.physics.debugGeometry();
    let lines = group.getObjectByName('strands') as THREE.LineSegments | undefined;
    if (!lines) {
      lines = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x22d3ee, depthTest: false, transparent: true, opacity: 0.9 })
      );
      lines.name = 'strands';
      lines.renderOrder = 997;
      group.add(lines);
    }
    lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(geometry.strands, 3));
    lines.geometry.computeBoundingSphere();
    let spheres = group.getObjectByName('colliders') as THREE.Group | undefined;
    if (!spheres) {
      spheres = new THREE.Group();
      spheres.name = 'colliders';
      for (let i = 0; i < geometry.colliders.length; i += 1) {
        spheres.add(new THREE.Mesh(
          new THREE.SphereGeometry(1, 10, 6),
          new THREE.MeshBasicMaterial({ color: 0xf97316, wireframe: true, depthTest: false, transparent: true, opacity: 0.35 })
        ));
      }
      group.add(spheres);
    }
    const up = new THREE.Vector3(0, 1, 0);
    geometry.colliders.forEach((c, i) => {
      const mesh = spheres!.children[i] as THREE.Mesh | undefined;
      if (!mesh) return;
      mesh.position.set(c.center[0], c.center[1], c.center[2]);
      // Capsules are drawn as spheres stretched along their axis.
      mesh.quaternion.setFromUnitVectors(up, new THREE.Vector3(c.axis[0], c.axis[1], c.axis[2]));
      mesh.scale.set(c.radius, c.radius + c.halfHeight, c.radius);
    });
  }

  /**
   * Bring an A-posed model's arms down to a relaxed stance, measured from
   * this model's own arm angle (authors use anything from 30 to 45 degrees).
   * PMX bones have no rest rotation, so rotations are about model axes.
   */
  private computeRelaxedBasePose(model: PmxModel): BasePose | undefined {
    const bones = this.config.bones;
    const pos = (name: string) => {
      const index = model.boneIndexByName.get(name);
      return index === undefined ? null : model.boneInfos[index].position;
    };
    const pose: BasePose = {};
    const targetBelow = THREE.MathUtils.degToRad(70);
    for (const side of ['L', 'R'] as const) {
      const arm = pos(side === 'L' ? bones.armL : bones.armR);
      const elbow = pos(side === 'L' ? bones.elbowL : bones.elbowR);
      if (!arm || !elbow) continue;
      const dx = elbow.x - arm.x;
      const below = Math.atan2(-(elbow.y - arm.y), Math.abs(dx));
      const lower = THREE.MathUtils.clamp(targetBelow - below, 0, THREE.MathUtils.degToRad(80));
      // An arm along +X lowers with a negative Z rotation, one along -X with positive.
      const sign = dx >= 0 ? -1 : 1;
      const fwd = sign < 0 ? 1 : -1;
      const keys = side === 'L'
        ? ({ arm: 'armL', elbow: 'elbowL', wrist: 'wristL', shoulder: 'shoulderL' } as const)
        : ({ arm: 'armR', elbow: 'elbowR', wrist: 'wristR', shoulder: 'shoulderR' } as const);
      pose[keys.arm] = { z: sign * lower, y: fwd * 0.1 };
      pose[keys.elbow] = { z: sign * 0.14, y: fwd * 0.22 };
      pose[keys.wrist] = { z: sign * 0.05, y: fwd * 0.1 };
      pose[keys.shoulder] = { z: sign * 0.04 };
    }
    return Object.keys(pose).length ? pose : undefined;
  }


  dispose(): void {
    this.removeSeat();
    this.cloth?.dispose();
    if (this.disposed) return;
    this.disposed = true;
    this.stop();

    this.editor?.dispose();
    this.physics?.dispose();
    this.lighting?.dispose();
    this.genericMixer?.stopAllAction();
    this.genericMixer = null;
    this.generic = null;
    this.genericHead = null;

    if (this.model) {
      this.model.mesh.geometry.dispose();
      const materials = this.model.mesh.material;
      for (const material of Array.isArray(materials) ? materials : [materials]) {
        const m = material as THREE.Material & {
          map?: THREE.Texture | null;
          gradientMap?: THREE.Texture | null;
        };
        m.map?.dispose();
        m.gradientMap?.dispose();
        m.dispose();
      }
      this.stage.scene.clear();
      this.model = null;
    }

    this.stage.dispose();
  }
}

