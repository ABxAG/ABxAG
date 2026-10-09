/**
 * PMX -> three.js loader.
 *
 * three.js removed MMDLoader in r168-r180, so this builds the SkinnedMesh
 * directly from `mmd-parser` output. Doing it ourselves also gets us two
 * things MMDLoader never supported: bone morphs (which is how this model
 * drives its eyebrows) and full control over material construction.
 *
 * See `pmxTypes.ts` for the coordinate-handedness contract.
 */
import * as THREE from 'three';
import { Parser as MmdParser } from 'mmd-parser';
import { bakeVertexAmbientOcclusion } from '../materials/AmbientOcclusion';
import { rigFromMmdParser } from '@/shared/character/rig';
import {
  BoneFlag,
  type PmxBoneInfo,
  type PmxConstraint,
  type PmxMaterialInfo,
  type PmxModel,
  type PmxRigidBody,
  type PmxRigidBodyType,
} from './pmxTypes';

/** Raw material description handed to the material factory. */
export interface RawPmxMaterial {
  index: number;
  name: string;
  diffuse: [number, number, number, number];
  specular: [number, number, number];
  shininess: number;
  ambient: [number, number, number];
  flag: number;
  edgeColor: [number, number, number, number];
  edgeSize: number;
  /** Resolved texture URLs, or null when the slot is unused. */
  mapUrl: string | null;
  toonUrl: string | null;
  sphereUrl: string | null;
  /** 0 = none, 1 = multiply, 2 = add, 3 = additional UV. */
  sphereMode: number;
}

export type MaterialFactory = (
  raw: RawPmxMaterial,
  textureLoader: THREE.TextureLoader
) => THREE.Material;

export interface LoadPmxOptions {
  modelUrl: string;
  textureMapUrl: string;
  createMaterial: MaterialFactory;
  onProgress?: (phase: string, ratio: number) => void;
}

const RIGID_BODY_TYPES: PmxRigidBodyType[] = ['kinematic', 'dynamic', 'dynamicBonePosition'];
const SHAPES = ['sphere', 'box', 'capsule'] as const;

/** Resolve `relative` against the directory containing `baseUrl`. */
function resolveFrom(baseUrl: string, relative: string): string {
  const dir = baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
  return dir + relative.split(/[\\/]/).map(encodeURIComponent).join('/');
}

/**
 * Convert a PMX euler rotation (left-handed, XYZ radians) into a three.js
 * quaternion under the z-negation handedness flip.
 */
function eulerToQuaternion(rot: number[]): THREE.Quaternion {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
  return new THREE.Quaternion(-q.x, -q.y, q.z, q.w);
}

export async function loadPmx(options: LoadPmxOptions): Promise<PmxModel> {
  const { modelUrl, textureMapUrl, createMaterial, onProgress } = options;
  const report = (phase: string, ratio: number) => onProgress?.(phase, ratio);

  report('Fetching model', 0);
  const [modelBuffer, textureMap] = await Promise.all([
    fetch(modelUrl).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch model: ${r.status} ${modelUrl}`);
      return r.arrayBuffer();
    }),
    fetch(textureMapUrl).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch texture map: ${r.status} ${textureMapUrl}`);
      return r.json() as Promise<{ textures: Record<string, string> }>;
    }),
  ]);

  report('Parsing model', 0.15);
  // PMD (legacy MMD) files start with the magic "Pmd"; PMX starts with "PMX ".
  // Both parse through mmd-parser — PMD simply exposes fewer optional
  // sections (grants, groups), which the guards below default to empty.
  const magic = new TextDecoder().decode(modelBuffer.slice(0, 3));
  const parser = new MmdParser() as unknown as {
    parsePmx: (buf: ArrayBuffer) => any;
    parsePmd?: (buf: ArrayBuffer) => any;
  };
  let pmx: any;
  if (magic === 'Pmd') {
    if (typeof parser.parsePmd !== 'function') {
      throw new Error('This is a legacy .pmd model and the bundled parser cannot read it — please convert it to .pmx (PMX Editor) and re-import.');
    }
    pmx = parser.parsePmd(modelBuffer);
  } else {
    pmx = parser.parsePmx(modelBuffer);
  }
  pmx.textures = pmx.textures ?? [];
  pmx.materials = pmx.materials ?? [];
  pmx.bones = pmx.bones ?? [];
  pmx.morphs = pmx.morphs ?? [];
  pmx.rigidBodies = pmx.rigidBodies ?? [];
  pmx.constraints = pmx.constraints ?? [];

  const vertexCount: number = pmx.metadata.vertexCount;
  const faceCount: number = pmx.metadata.faceCount;

  // ---------------------------------------------------------------- geometry
  report('Building geometry', 0.3);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const skinIndices = new Uint16Array(vertexCount * 4);
  const skinWeights = new Float32Array(vertexCount * 4);

  for (let i = 0; i < vertexCount; i++) {
    const v = pmx.vertices[i];
    positions[i * 3] = v.position[0];
    positions[i * 3 + 1] = v.position[1];
    positions[i * 3 + 2] = -v.position[2];

    normals[i * 3] = v.normal[0];
    normals[i * 3 + 1] = v.normal[1];
    normals[i * 3 + 2] = -v.normal[2];

    // PMX UVs use a top-left origin; WebGL uses bottom-left.
    uvs[i * 2] = v.uv[0];
    uvs[i * 2 + 1] = 1 - v.uv[1];

    // BDEF1/2/4 and SDEF all expose skinIndices/skinWeights; SDEF's extra
    // spherical data is ignored and it degrades to linear blending, which is
    // what every real-time MMD viewer does.
    const idx = v.skinIndices;
    const wgt = v.skinWeights;
    for (let k = 0; k < 4; k++) {
      skinIndices[i * 4 + k] = k < idx.length ? idx[k] : 0;
      skinWeights[i * 4 + k] = k < wgt.length ? wgt[k] : 0;
    }
    // Guard against models whose weights do not sum to 1.
    const sum =
      skinWeights[i * 4] + skinWeights[i * 4 + 1] + skinWeights[i * 4 + 2] + skinWeights[i * 4 + 3];
    if (sum > 0 && Math.abs(sum - 1) > 1e-4) {
      for (let k = 0; k < 4; k++) skinWeights[i * 4 + k] /= sum;
    }
  }

  // Triangle winding is deliberately preserved. Two flips cancel out:
  // negating Z reverses triangle orientation, but PMX (DirectX) treats
  // CLOCKWISE faces as front-facing while WebGL treats COUNTER-CLOCKWISE as
  // front-facing. Reversing the indices here would leave the whole model
  // inside-out and invisible to a FrontSide material.
  const indices = new Uint32Array(faceCount * 3);
  for (let i = 0; i < faceCount; i++) {
    const f = pmx.faces[i].indices;
    indices[i * 3] = f[0];
    indices[i * 3 + 1] = f[1];
    indices[i * 3 + 2] = f[2];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // --------------------------------------------------------------- materials
  report('Loading textures', 0.45);
  const textureLoader = new THREE.TextureLoader();
  const textureUrls: (string | null)[] = pmx.textures.map((internal: string) => {
    const mapped = textureMap.textures[internal];
    return mapped ? resolveFrom(textureMapUrl, mapped) : null;
  });
  const urlAt = (i: number) => (i >= 0 && i < textureUrls.length ? textureUrls[i] : null);

  const materialInfos: PmxMaterialInfo[] = [];
  const materials: THREE.Material[] = [];
  let indexOffset = 0;

  pmx.materials.forEach((m: any, i: number) => {
    geometry.addGroup(indexOffset, m.faceCount * 3, i);
    materialInfos.push({
      index: i,
      name: m.name,
      start: indexOffset,
      count: m.faceCount * 3,
      edgeSize: m.edgeSize,
      edgeColor: new THREE.Color(m.edgeColor[0], m.edgeColor[1], m.edgeColor[2]),
      flag: m.flag,
    });
    indexOffset += m.faceCount * 3;

    materials.push(
      createMaterial(
        {
          index: i,
          name: m.name,
          diffuse: m.diffuse,
          specular: m.specular,
          shininess: m.shininess,
          ambient: m.ambient,
          flag: m.flag,
          edgeColor: m.edgeColor,
          edgeSize: m.edgeSize,
          mapUrl: urlAt(m.textureIndex),
          // toonFlag 1 means a shared built-in toon; this model uses 0
          // (its own texture table) for every material.
          toonUrl: m.toonFlag === 0 ? urlAt(m.toonIndex) : null,
          sphereUrl: urlAt(m.envTextureIndex),
          sphereMode: m.envFlag,
        },
        textureLoader
      )
    );
  });

  // ---------------------------------------------------------------- skeleton
  report('Building skeleton', 0.6);
  const boneInfos: PmxBoneInfo[] = [];
  const bones: THREE.Bone[] = [];
  const boneIndexByName = new Map<string, number>();

  pmx.bones.forEach((b: any, i: number) => {
    const position = new THREE.Vector3(b.position[0], b.position[1], -b.position[2]);
    boneInfos.push({
      index: i,
      name: b.name,
      parentIndex: b.parentIndex,
      position,
      flag: b.flag,
      transformationClass: b.transformationClass ?? 0,
      ik: b.ik
        ? {
            effectorIndex: b.ik.effector,
            iteration: b.ik.iteration,
            maxAngle: b.ik.maxAngle,
            links: b.ik.links.map((l: any) => ({
              boneIndex: l.index,
              limited: l.angleLimitation === 1,
              // Angle limits are also mirrored by the handedness flip: a
              // rotation about X or Y reverses sign, Z is unchanged.
              lower: l.lowerLimitationAngle
                ? new THREE.Vector3(
                    -l.upperLimitationAngle[0],
                    -l.upperLimitationAngle[1],
                    l.lowerLimitationAngle[2]
                  )
                : undefined,
              upper: l.upperLimitationAngle
                ? new THREE.Vector3(
                    -l.lowerLimitationAngle[0],
                    -l.lowerLimitationAngle[1],
                    l.upperLimitationAngle[2]
                  )
                : undefined,
            })),
          }
        : undefined,
      grant: b.grant
        ? {
            parentIndex: b.grant.parentIndex,
            ratio: b.grant.ratio,
            affectRotation: !!b.grant.affectRotation,
            affectPosition: !!b.grant.affectPosition,
            isLocal: !!b.grant.isLocal,
          }
        : undefined,
    });

    const bone = new THREE.Bone();
    bone.name = b.name;
    bones.push(bone);
    // First declaration wins; duplicate bone names are rare but possible.
    if (!boneIndexByName.has(b.name)) boneIndexByName.set(b.name, i);
  });

  // PMX bone positions are absolute; three.js wants parent-relative locals.
  const root = new THREE.Object3D();
  boneInfos.forEach((info, i) => {
    const bone = bones[i];
    if (info.parentIndex >= 0 && info.parentIndex < bones.length) {
      bones[info.parentIndex].add(bone);
      bone.position.subVectors(info.position, boneInfos[info.parentIndex].position);
    } else {
      root.add(bone);
      bone.position.copy(info.position);
    }
  });
  root.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(bones);

  // ------------------------------------------------------------------ morphs
  report('Building morphs', 0.75);
  const vertexMorphs = new Map<string, import('./pmxTypes').PmxVertexMorph>();
  const boneMorphs = new Map<string, import('./pmxTypes').PmxBoneMorph>();
  const groupMorphs = new Map<string, import('./pmxTypes').PmxGroupMorph>();
  const morphAttributes: THREE.BufferAttribute[] = [];

  pmx.morphs.forEach((morph: any) => {
    switch (morph.type) {
      case 1: {
        // Vertex morph -> three.js morph target. Stored as relative offsets.
        const offsets = new Float32Array(vertexCount * 3);
        for (const el of morph.elements) {
          offsets[el.index * 3] = el.position[0];
          offsets[el.index * 3 + 1] = el.position[1];
          offsets[el.index * 3 + 2] = -el.position[2];
        }
        const attr = new THREE.BufferAttribute(offsets, 3);
        attr.name = morph.name;
        vertexMorphs.set(morph.name, {
          name: morph.name,
          panel: morph.panel,
          morphTargetIndex: morphAttributes.length,
        });
        morphAttributes.push(attr);
        break;
      }
      case 2: {
        // Bone morph - applied manually each frame by MorphController.
        boneMorphs.set(morph.name, {
          name: morph.name,
          panel: morph.panel,
          elements: morph.elements.map((el: any) => ({
            boneIndex: el.index,
            position: new THREE.Vector3(el.position[0], el.position[1], -el.position[2]),
            rotation: new THREE.Quaternion(
              -el.rotation[0],
              -el.rotation[1],
              el.rotation[2],
              el.rotation[3]
            ),
          })),
        });
        break;
      }
      case 0: {
        groupMorphs.set(morph.name, {
          name: morph.name,
          panel: morph.panel,
          elements: morph.elements.map((el: any) => ({
            morphName: pmx.morphs[el.index]?.name ?? '',
            ratio: el.ratio,
          })),
        });
        break;
      }
      default:
        // UV and material morphs are not used by this model.
        break;
    }
  });

  if (morphAttributes.length > 0) {
    geometry.morphAttributes.position = morphAttributes;
    geometry.morphTargetsRelative = true;
  }

  // ------------------------------------------------------------------- mesh
  const mesh = new THREE.SkinnedMesh(geometry, materials);
  mesh.name = pmx.metadata.modelName || 'character';
  mesh.normalizeSkinWeights();
  mesh.add(root);
  mesh.bind(skeleton);
  mesh.frustumCulled = false;

  // Expose morph targets by name for convenience.
  mesh.morphTargetDictionary = {};
  mesh.morphTargetInfluences = new Array(morphAttributes.length).fill(0);
  vertexMorphs.forEach((m) => {
    mesh.morphTargetDictionary![m.name] = m.morphTargetIndex;
  });

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Bake contact shading into the mesh. Done once here rather than per frame:
  // see AmbientOcclusion.ts for why baked beats SSAO for this character.
  report('Baking ambient occlusion', 0.85);
  bakeVertexAmbientOcclusion(geometry);

  // ---------------------------------------------------------------- physics
  report('Reading physics', 0.9);
  const rigidBodies: PmxRigidBody[] = pmx.rigidBodies.map((r: any, i: number) => ({
    index: i,
    name: r.name,
    boneIndex: r.boneIndex,
    groupIndex: r.groupIndex,
    groupTarget: r.groupTarget,
    shape: SHAPES[r.shapeType] ?? 'capsule',
    size: new THREE.Vector3(r.width, r.height, r.depth),
    position: new THREE.Vector3(r.position[0], r.position[1], -r.position[2]),
    rotation: eulerToQuaternion(r.rotation),
    mass: r.weight,
    positionDamping: r.positionDamping,
    rotationDamping: r.rotationDamping,
    restitution: r.restitution,
    friction: r.friction,
    type: RIGID_BODY_TYPES[r.type] ?? 'kinematic',
  }));

  const constraints: PmxConstraint[] = pmx.constraints.map((c: any, i: number) => ({
    index: i,
    name: c.name,
    bodyA: c.rigidBodyIndex1,
    bodyB: c.rigidBodyIndex2,
    position: new THREE.Vector3(c.position[0], c.position[1], -c.position[2]),
    rotation: eulerToQuaternion(c.rotation),
    rotationLower: new THREE.Vector3(
      -c.rotationLimitation2[0],
      -c.rotationLimitation2[1],
      c.rotationLimitation1[2]
    ),
    rotationUpper: new THREE.Vector3(
      -c.rotationLimitation1[0],
      -c.rotationLimitation1[1],
      c.rotationLimitation2[2]
    ),
    springRotation: new THREE.Vector3(
      c.springRotation[0],
      c.springRotation[1],
      c.springRotation[2]
    ),
  }));

  const iks = boneInfos
    .filter((b) => b.ik && (b.flag & BoneFlag.IK) !== 0)
    .map((b) => ({ boneIndex: b.index, info: b.ik! }));

  const grants = boneInfos
    .filter((b) => b.grant)
    .map((b) => ({ boneIndex: b.index, info: b.grant! }));

  report('Ready', 1);

  return {
    name: pmx.metadata.modelName,
    mesh,
    skeleton,
    bones,
    boneInfos,
    boneIndexByName,
    materials: materialInfos,
    vertexMorphs,
    boneMorphs,
    groupMorphs,
    rigidBodies,
    constraints,
    iks,
    grants,
    boundingBox: geometry.boundingBox ?? new THREE.Box3(),
    rig: rigFromMmdParser(pmx),
  };
}
