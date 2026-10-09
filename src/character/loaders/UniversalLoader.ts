/**
 * Universal generic-model loader for ABxAG.
 *
 * PMX/PMD keep using the dedicated MMD pipeline (`PmxLoader`, full morphs +
 * rigid-body physics). Everything else — VRM / GLB / glTF / FBX / OBJ —
 * loads here through three.js addons and is normalised to a plain
 * THREE.Group with a bone-name index, so `CharacterSystem` can drive it
 * with the same idle/gaze bone animation it uses for MMD models.
 *
 * VRM note: VRM 1.0 files are GLB containers, so they render through
 * GLTFLoader without any extra dependency. VRM spring-bones / expressions
 * are not auto-wired yet — bones still animate by name mapping.
 */
import * as THREE from 'three';

export type GenericModelFormat = 'vrm' | 'glb' | 'gltf' | 'fbx' | 'obj';

export interface UniversalModel {
  /** Staged model file, e.g. "model.glb". Used for progress/error messages. */
  file: string;
  format: GenericModelFormat;
  /** Scene root, already centred at origin with feet near y=0. */
  root: THREE.Group;
  /** Every bone/Object3D that looks like a joint, keyed by lower-cased name. */
  bonesByName: Map<string, THREE.Object3D>;
  /** Skinned meshes for material/lighting passes. */
  skinnedMeshes: THREE.SkinnedMesh[];
  /** All meshes (skinned or static) for bounds/material passes. */
  meshes: THREE.Mesh[];
  /** Embedded animation clips (GLB/FBX carry these; VRM/OBJ usually none). */
  animations: THREE.AnimationClip[];
  /** Non-fatal notes surfaced in the compatibility report. */
  warnings: string[];
  /** Rest height (head-top to feet) in model units, measured from bounds. */
  height: number;
}

export function detectGenericFormat(fileName: string): GenericModelFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(fileName);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === 'vrm' || ext === 'glb') return ext;
  if (ext === 'gltf') return 'gltf';
  if (ext === 'fbx') return 'fbx';
  if (ext === 'obj') return 'obj';
  return null;
}

export function isGenericModelFile(fileName: string): boolean {
  return detectGenericFormat(fileName) !== null;
}

async function fetchBytes(url: string, onProgress?: (ratio: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download model (${res.status} ${res.statusText})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || total === 0) {
    const buf = await res.arrayBuffer();
    onProgress?.(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(Math.min(1, received / total));
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

function indexBones(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const map = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone || o.type === 'Bone' || /bone|joint|hips|spine|head|arm|leg|hand|foot/i.test(o.name)) {
      const key = o.name.toLowerCase();
      if (key && !map.has(key)) map.set(key, o);
    }
  });
  // Fallback: index every named node so name mapping still finds hips/spine.
  if (map.size === 0) {
    root.traverse((o) => {
      const key = o.name.toLowerCase();
      if (key && !map.has(key)) map.set(key, o);
    });
  }
  return map;
}

function collectMeshes(root: THREE.Object3D): { skinned: THREE.SkinnedMesh[]; all: THREE.Mesh[] } {
  const skinned: THREE.SkinnedMesh[] = [];
  const all: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
      skinned.push(o as THREE.SkinnedMesh);
      all.push(o as unknown as THREE.Mesh);
    } else if ((o as THREE.Mesh).isMesh) {
      all.push(o as THREE.Mesh);
    }
  });
  return { skinned, all };
}

/** Centre on XZ, drop feet to y=0, return measured height. */
function groundAndMeasure(root: THREE.Group): number {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return 1.7;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  return Math.max(0.01, size.y);
}

export async function loadGenericModel(
  modelUrl: string,
  format: GenericModelFormat,
  onProgress?: (phase: string, ratio: number) => void,
): Promise<UniversalModel> {
  const warnings: string[] = [];
  const file = modelUrl.split('/').pop() ?? modelUrl;
  const report = (phase: string, ratio: number) => onProgress?.(phase, ratio);

  if (format === 'glb' || format === 'gltf' || format === 'vrm') {
    report('Loading model', 0.05);
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const bytes = await fetchBytes(modelUrl, (r) => report('Downloading model', 0.05 + r * 0.5));
    const gltf = await loader.parseAsync(bytes, modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1));
    const root = new THREE.Group();
    root.add(gltf.scene);
    if (format === 'vrm') {
      warnings.push('VRM loads as a GLB scene: mesh + textures render, spring-bones/expressions animate by generic bone mapping.');
    }
    const animations = gltf.animations ?? [];
    if (animations.length > 0) warnings.push(`${animations.length} embedded animation clip(s) found; ABxAG drives bones procedurally unless you play one.`);
    report('Indexing bones', 0.7);
    const bonesByName = indexBones(root);
    const { skinned, all } = collectMeshes(root);
    if (skinned.length === 0 && all.length === 0) throw new Error('No meshes found in the model.');
    if (bonesByName.size === 0) warnings.push('No named bones found — the model will stand still except for whole-body motion.');
    const height = groundAndMeasure(root);
    report('Ready', 1);
    return { file, format, root, bonesByName, skinnedMeshes: skinned, meshes: all, animations, warnings, height };
  }

  if (format === 'fbx') {
    report('Loading model', 0.05);
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    const loader = new FBXLoader();
    const bytes = await fetchBytes(modelUrl, (r) => report('Downloading model', 0.05 + r * 0.5));
    const root = loader.parse(bytes, modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1)) as unknown as THREE.Group;
    const animations: THREE.AnimationClip[] = ((root as unknown as { animations?: THREE.AnimationClip[] }).animations ?? []);
    report('Indexing bones', 0.7);
    const bonesByName = indexBones(root);
    const { skinned, all } = collectMeshes(root);
    if (all.length === 0) throw new Error('No meshes found in the FBX model.');
    if (bonesByName.size === 0) warnings.push('No named bones found — the model will stand still except for whole-body motion.');
    const height = groundAndMeasure(root);
    report('Ready', 1);
    return { file, format, root, bonesByName, skinnedMeshes: skinned, meshes: all, animations, warnings, height };
  }

  // OBJ (+ optional sibling .mtl resolved by three from the same directory).
  report('Loading model', 0.05);
  const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
  const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
  const base = modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1);
  let materials: import('three/examples/jsm/loaders/MTLLoader.js').MTLLoader.MaterialCreator | null = null;
  const mtlUrl = modelUrl.replace(/\.obj$/i, '.mtl');
  try {
    const mtlText = await (await fetch(mtlUrl)).text();
    if (mtlText && !/404|not found/i.test(mtlText.slice(0, 200))) {
      materials = new MTLLoader().parse(mtlText, base);
      materials.preload();
    }
  } catch {
    warnings.push('No .mtl material found next to the OBJ — a default material is used.');
  }
  const objLoader = new OBJLoader();
  if (materials) objLoader.setMaterials(materials);
  const bytes = await fetchBytes(modelUrl, (r) => report('Downloading model', 0.05 + r * 0.5));
  const text = new TextDecoder().decode(bytes);
  const root = objLoader.parse(text) as unknown as THREE.Group;
  const wrapped = new THREE.Group();
  wrapped.add(root);
  warnings.push('OBJ models are static meshes (no bones/morphs) — ABxAG poses the whole body; face/physics stay idle.');
  const bonesByName = indexBones(wrapped);
  const { skinned, all } = collectMeshes(wrapped);
  if (all.length === 0) throw new Error('No meshes found in the OBJ model.');
  const height = groundAndMeasure(wrapped);
  report('Ready', 1);
  return { file, format, root: wrapped, bonesByName, skinnedMeshes: skinned, meshes: all, animations: [], warnings, height };
}
