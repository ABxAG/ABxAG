/**
 * Vertex-level cloth for any PMX character.
 *
 * Most garments in PMX models are skinned straight to body bones, so they
 * move like painted-on skin: only parts the author rigged with physics
 * strands (skirts, hair) ever swing. This layer turns every cloth surface
 * into simulated fabric while it stays WORN:
 *
 *   particles   cloth vertices are welded and clustered (per garment piece)
 *               into a few thousand particles, linked along the mesh's own
 *               edges so the fabric keeps its shape and does not stretch;
 *   attachment  each particle follows the place the body carries it (its
 *               skinned position) on a spring, inside a radius. Fabric that
 *               hugs the body (waistband, shoulders, cuffs) is held tightly;
 *               fabric that stands off the body (hems, flared sleeves,
 *               skirt panels) is loose and lags, swings and settles;
 *   inertia     simulated in world space, so fast moves, turns and drops make
 *               the fabric trail, flip up and fall back, as real cloth does;
 *   collision   the body's own capsules push fabric out of the legs, arms
 *               and torso (capsules a particle already sits inside at rest
 *               are ignored, as the strand solver does);
 *   grabbing    a particle can be held and pulled with the mouse; the fabric
 *               around it follows and swings back on release.
 *
 * Rendering: each cloth vertex blends the displacement (particle − target) of
 * up to four nearby particles, read from a float texture in the vertex shader
 * right after skinning. Undisturbed cloth therefore renders exactly as
 * authored; nothing is removed from the model and clothes cannot come off.
 */
import * as THREE from 'three';
import type { PmxModel } from '../loaders/pmxTypes';
import type { MaterialRole } from '../config/types';

export interface ClothSettings {
  enabled: boolean;
  /** 0..2 scale on how far fabric may move away from the body. */
  looseness: number;
  /** 0..2 scale on how strongly fabric returns to its worn shape. */
  hold: number;
}

export const DEFAULT_CLOTH_SETTINGS: ClothSettings = { enabled: true, looseness: 1, hold: 1 };

/** Material roles that are garments. */
const CLOTH_ROLES: ReadonlySet<MaterialRole> = new Set<MaterialRole>(['cloth', 'lightCloth', 'leather']);

export interface Capsule {
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
}

const TEX_WIDTH = 256;
/**
 * Slack: how far (fraction of character height) fully loose fabric may move
 * from where the body carries it. Body-skinned fabric gets at most a quarter.
 */
const SLACK = 0.05;
const STEP = 1 / 60;

export class ClothLayer {
  readonly count: number;
  private readonly rest: Float32Array;        // bind-space particle positions
  private readonly rep: Int32Array;           // representative vertex (skin weights)
  private readonly pos: Float32Array;         // world positions
  private readonly prev: Float32Array;
  private readonly target: Float32Array;
  private readonly loose: Float32Array;       // 0 (held) .. 1 (loose)
  private readonly edgesA: Int32Array;
  private readonly edgesB: Int32Array;
  private readonly edgeRest: Float32Array;
  private readonly neighbours: number[][];
  /**
   * Capsules each particle can actually reach (nearby at rest, and not one it
   * already sits inside at rest), flattened: candidates for particle i are
   * nearIdx[nearStart[i] .. nearStart[i + 1]).
   */
  private nearStart = new Int32Array(1);
  private nearIdx = new Int32Array(0);
  /** Link lengths in the current worn shape, refreshed every step. */
  private linkLength: Float32Array = new Float32Array(0);

  readonly texture: THREE.DataTexture;
  private readonly texData: Float32Array;
  /** World-space character height. */
  private readonly height: number;
  /** World units per model unit. */
  private readonly worldScale: number;
  private settings: ClothSettings = { ...DEFAULT_CLOTH_SETTINGS };
  private accumulator = 0;
  private initialised = false;
  private readonly pending = new THREE.Vector3();
  private grab: { index: number; point: THREE.Vector3; boost: Map<number, number> } | null = null;
  private stepMs = 0;
  private maxOffset = 0;

  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _t = new THREE.Vector3();
  private readonly _m3 = new THREE.Matrix3();
  private readonly _inv = new THREE.Matrix4();

  private constructor(
    private readonly model: PmxModel,
    data: {
      rest: Float32Array; rep: Int32Array; loose: Float32Array;
      edgesA: Int32Array; edgesB: Int32Array; edgeRest: Float32Array; neighbours: number[][];
    },
    height: number,
    worldScale: number
  ) {
    this.count = data.rep.length;
    this.rest = data.rest;
    this.rep = data.rep;
    this.loose = data.loose;
    this.edgesA = data.edgesA;
    this.edgesB = data.edgesB;
    this.edgeRest = data.edgeRest;
    this.neighbours = data.neighbours;
    this.height = height;
    this.worldScale = worldScale;
    this.pos = new Float32Array(this.count * 3);
    this.prev = new Float32Array(this.count * 3);
    this.target = new Float32Array(this.count * 3);
    const rows = Math.max(1, Math.ceil(this.count / TEX_WIDTH));
    this.texData = new Float32Array(TEX_WIDTH * rows * 4);
    this.texture = new THREE.DataTexture(this.texData, TEX_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  /**
   * Build the cloth layer for a model, or return null when it has no cloth.
   * `roleOf` maps a PMX material index to its shading role; `capsules` are
   * the body colliders in their current (rest) world placement; `height` is
   * the character height in model units; `chainBones` are bone indices the
   * author rigged as physics strands.
   */
  static build(model: PmxModel, roleOf: (materialIndex: number) => MaterialRole, capsules: Capsule[], height: number, chainBones: Set<number>): ClothLayer | null {
    const geometry = model.mesh.geometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const index = geometry.getIndex();
    const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
    const skinWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
    if (!position || !index || !skinIndex || !skinWeight) return null;
    const vertexCount = position.count;

    // 1. Cloth triangles and vertices.
    const isCloth = new Uint8Array(vertexCount);
    const triangles: number[] = [];
    for (const material of model.materials) {
      if (!CLOTH_ROLES.has(roleOf(material.index))) continue;
      for (let i = material.start; i < material.start + material.count; i += 3) {
        const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
        triangles.push(a, b, c);
        isCloth[a] = isCloth[b] = isCloth[c] = 1;
      }
    }
    if (triangles.length < 30) return null;

    // 2. Weld UV-seam duplicates so pieces stay closed.
    const eps = height * 2e-4;
    const weld = new Int32Array(vertexCount).fill(-1);
    const weldMap = new Map<string, number>();
    const key = (x: number, y: number, z: number) => `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    for (let v = 0; v < vertexCount; v++) {
      if (!isCloth[v]) continue;
      const k = key(position.getX(v), position.getY(v), position.getZ(v));
      const existing = weldMap.get(k);
      if (existing === undefined) { weldMap.set(k, v); weld[v] = v; } else weld[v] = existing;
    }

    // 3. Garment pieces = connected components of the welded cloth mesh.
    const parent = new Int32Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) parent[v] = v;
    const find = (v: number): number => { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; } return v; };
    const unite = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let t = 0; t < triangles.length; t += 3) {
      const a = weld[triangles[t]], b = weld[triangles[t + 1]], c = weld[triangles[t + 2]];
      unite(a, b); unite(b, c);
    }

    // 4. Cluster each piece on a grid into particles.
    const cell = height * 0.022;
    const clusterOf = new Int32Array(vertexCount).fill(-1);
    const clusterKey = new Map<string, number>();
    const sums: number[] = [];
    const counts: number[] = [];
    for (let v = 0; v < vertexCount; v++) {
      if (!isCloth[v] || weld[v] !== v) continue;
      const x = position.getX(v), y = position.getY(v), z = position.getZ(v);
      const k = `${find(v)}|${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      let c = clusterKey.get(k);
      if (c === undefined) { c = counts.length; clusterKey.set(k, c); counts.push(0); sums.push(0, 0, 0); }
      clusterOf[v] = c;
      counts[c] += 1;
      sums[c * 3] += x; sums[c * 3 + 1] += y; sums[c * 3 + 2] += z;
    }
    for (let v = 0; v < vertexCount; v++) if (isCloth[v] && weld[v] !== v) clusterOf[v] = clusterOf[weld[v]];
    const n = counts.length;
    const rest = new Float32Array(n * 3);
    for (let c = 0; c < n; c++) for (let k = 0; k < 3; k++) rest[c * 3 + k] = sums[c * 3 + k] / counts[c];

    // Representative vertex per particle (closest to its centre) for skinning.
    const rep = new Int32Array(n).fill(-1);
    const repDist = new Float32Array(n).fill(Infinity);
    for (let v = 0; v < vertexCount; v++) {
      const c = clusterOf[v];
      if (c < 0 || weld[v] !== v) continue;
      const d = (position.getX(v) - rest[c * 3]) ** 2 + (position.getY(v) - rest[c * 3 + 1]) ** 2 + (position.getZ(v) - rest[c * 3 + 2]) ** 2;
      if (d < repDist[c]) { repDist[c] = d; rep[c] = v; }
    }

    // 5. Particle edges from mesh edges that cross clusters.
    const edgeSet = new Set<string>();
    const ea: number[] = [], eb: number[] = [];
    const neighbours: number[][] = Array.from({ length: n }, () => []);
    const link = (p: number, q: number) => {
      if (p === q || p < 0 || q < 0) return;
      const k = p < q ? `${p}:${q}` : `${q}:${p}`;
      if (edgeSet.has(k)) return;
      edgeSet.add(k);
      ea.push(p); eb.push(q);
      neighbours[p].push(q); neighbours[q].push(p);
    };
    for (let t = 0; t < triangles.length; t += 3) {
      const a = clusterOf[triangles[t]], b = clusterOf[triangles[t + 1]], c = clusterOf[triangles[t + 2]];
      link(a, b); link(b, c); link(c, a);
    }
    const edgeRest = new Float32Array(ea.length);
    for (let e = 0; e < ea.length; e++) {
      const p = ea[e], q = eb[e];
      edgeRest[e] = Math.hypot(rest[p * 3] - rest[q * 3], rest[p * 3 + 1] - rest[q * 3 + 1], rest[p * 3 + 2] - rest[q * 3 + 2]);
    }

    // 6. Looseness: how far the fabric stands off the body at rest, and
    // whether the author rigged it with physics strands.
    model.mesh.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    const loose = new Float32Array(n);
    const scale = model.mesh.getWorldScale(new THREE.Vector3()).x || 1;
    for (let c = 0; c < n; c++) {
      world.set(rest[c * 3], rest[c * 3 + 1], rest[c * 3 + 2]).applyMatrix4(model.mesh.matrixWorld);
      let gap = Infinity;
      for (const capsule of capsules) gap = Math.min(gap, capsuleDistance(world, capsule) - capsule.radius);
      const off = THREE.MathUtils.smoothstep(gap, height * scale * 0.004, height * scale * 0.05);
      let onStrand = 0;
      const v = rep[c];
      for (let k = 0; k < 4; k++) if (skinWeight.getComponent(v, k) > 0.3 && chainBones.has(skinIndex.getComponent(v, k))) onStrand = 1;
      // Only fabric the author rigged with physics strands (skirt panels,
      // coat tails) is truly loose. Fabric skinned to the body (sleeves,
      // gloves, bodice) only sways: there is no body modelled underneath it,
      // so it must never pull away far enough to open a gap.
      // Body-hugging fabric (tights, bodysuits, fitted tops) barely moves on
      // a real body: a few millimetres of give, no wobble.
      loose[c] = onStrand ? 0.6 + 0.4 * off : 0.03 + 0.07 * off;
    }
    // Smooth looseness across the fabric so tight and loose zones blend.
    for (let pass = 0; pass < 3; pass++) {
      const next = loose.slice();
      for (let c = 0; c < n; c++) {
        let s = loose[c] * 2, w = 2;
        for (const q of neighbours[c]) { s += loose[q]; w += 1; }
        next[c] = s / w;
      }
      loose.set(next);
    }

    // 7. Per-vertex blend of up to four nearby particles, sent as attributes.
    const aIdx = new Float32Array(vertexCount * 4);
    const aW = new Float32Array(vertexCount * 4);
    const sigma2 = (cell * 0.9) ** 2;
    for (let v = 0; v < vertexCount; v++) {
      const own = clusterOf[v];
      if (own < 0) continue;
      const x = position.getX(v), y = position.getY(v), z = position.getZ(v);
      const candidates = [own, ...neighbours[own]].map((p) => {
        const d2 = (x - rest[p * 3]) ** 2 + (y - rest[p * 3 + 1]) ** 2 + (z - rest[p * 3 + 2]) ** 2;
        return { p, w: Math.exp(-d2 / sigma2) * (p === own ? 1.5 : 1) };
      }).sort((a, b) => b.w - a.w).slice(0, 4);
      const total = candidates.reduce((s, c) => s + c.w, 0) || 1;
      candidates.forEach((c, k) => { aIdx[v * 4 + k] = c.p; aW[v * 4 + k] = c.w / total; });
    }
    geometry.setAttribute('aClothIdx', new THREE.BufferAttribute(aIdx, 4));
    geometry.setAttribute('aClothW', new THREE.BufferAttribute(aW, 4));

    const layer = new ClothLayer(model, { rest, rep, loose, edgesA: Int32Array.from(ea), edgesB: Int32Array.from(eb), edgeRest, neighbours }, height * scale, scale);
    layer.setColliders(capsules, true);
    return layer;
  }

  // ---- shader ------------------------------------------------------------------

  /** Make a material read the cloth displacement after skinning. */
  patchMaterial(material: THREE.Material): void {
    const previous = material.onBeforeCompile.bind(material);
    const texture = this.texture;
    material.onBeforeCompile = (shader, renderer) => {
      previous(shader, renderer);
      shader.uniforms.uClothDisp = { value: texture };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aClothIdx;
          attribute vec4 aClothW;
          uniform highp sampler2D uClothDisp;
          vec3 clothDisp( float i ) {
            int k = int( i + 0.5 );
            return texelFetch( uClothDisp, ivec2( k % ${TEX_WIDTH}, k / ${TEX_WIDTH} ), 0 ).xyz;
          }`)
        .replace('#include <skinning_vertex>', `#include <skinning_vertex>
          if ( aClothW.x + aClothW.y + aClothW.z + aClothW.w > 0.0 ) {
            transformed += aClothW.x * clothDisp( aClothIdx.x ) + aClothW.y * clothDisp( aClothIdx.y )
              + aClothW.z * clothDisp( aClothIdx.z ) + aClothW.w * clothDisp( aClothIdx.w );
          }`);
    };
    const key = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${key()}|cloth`;
    material.needsUpdate = true;
  }

  // ---- runtime -----------------------------------------------------------------

  setSettings(settings: Partial<ClothSettings>): void {
    const wasEnabled = this.settings.enabled;
    this.settings = { ...this.settings, ...settings };
    if (!this.settings.enabled) { this.texData.fill(0); this.texture.needsUpdate = true; }
    else if (!wasEnabled) this.initialised = false;
  }

  get stats(): { particles: number; edges: number; stepMs: number; maxOffset: number } {
    return { particles: this.count, edges: this.edgesA.length, stepMs: +this.stepMs.toFixed(3), maxOffset: +(this.maxOffset / this.height).toFixed(4) };
  }

  private capsules: Capsule[] = [];

  /** Update collider placement; `atRest` also decides which capsules each particle can reach. */
  setColliders(capsules: Capsule[], atRest = false): void {
    this.capsules = capsules;
    if (!atRest) return;
    this.computeTargets();
    const start: number[] = [0];
    const idx: number[] = [];
    for (let i = 0; i < this.count; i++) {
      this._v.fromArray(this.target, i * 3);
      const reach = this.loose[i] * this.height * SLACK * 4 + this.height * 0.02;
      capsules.forEach((c, k) => {
        const d = capsuleDistance(this._v, c);
        // Inside at rest: the author overlapped fabric and collider on purpose.
        if (d < c.radius * 1.02) return;
        if (d < c.radius + reach) idx.push(k);
      });
      start.push(idx.length);
    }
    this.nearStart = Int32Array.from(start);
    this.nearIdx = Int32Array.from(idx);
  }

  /** The character's frame moved without the scene moving (window drag). */
  addFrameMotion(delta: THREE.Vector3): void {
    this.pending.add(delta);
  }

  /** Snap the fabric back to its worn shape (pose jumps, teleports). */
  reset(): void {
    this.computeTargets();
    this.pos.set(this.target);
    this.prev.set(this.target);
    this.pending.set(0, 0, 0);
    this.texData.fill(0);
    this.texture.needsUpdate = true;
    this.initialised = true;
  }

  private computeTargets(): void {
    const mesh = this.model.mesh;
    mesh.skeleton.update();
    for (let i = 0; i < this.count; i++) {
      this._v.fromArray(this.rest, i * 3);
      mesh.applyBoneTransform(this.rep[i], this._v);
      this._v.applyMatrix4(mesh.matrixWorld);
      this._v.toArray(this.target, i * 3);
    }
  }

  update(delta: number): void {
    if (!this.settings.enabled) return;
    const started = performance.now();
    if (!this.initialised) { this.reset(); return; }
    if (delta > 0.25) { this.reset(); return; }
    this.computeTargets();

    // Window drags: the world stays put, the character moved - so the fabric
    // stays behind for an instant, exactly as if she were carried.
    if (this.pending.lengthSq() > 0) {
      for (let i = 0; i < this.count; i++) {
        this.pos[i * 3] -= this.pending.x; this.pos[i * 3 + 1] -= this.pending.y; this.pos[i * 3 + 2] -= this.pending.z;
        this.prev[i * 3] -= this.pending.x; this.prev[i * 3 + 1] -= this.pending.y; this.prev[i * 3 + 2] -= this.pending.z;
      }
      this.pending.set(0, 0, 0);
    }

    this.accumulator = Math.min(this.accumulator + delta, STEP * 3);
    while (this.accumulator >= STEP) {
      this.step();
      this.accumulator -= STEP;
    }
    this.upload();
    this.stepMs = this.stepMs * 0.9 + (performance.now() - started) * 0.1;
  }

  private step(): void {
    const n = this.count, pos = this.pos, prev = this.prev, target = this.target, H = this.height;
    const looseScale = THREE.MathUtils.clamp(this.settings.looseness, 0, 2);
    const hold = THREE.MathUtils.clamp(this.settings.hold, 0.2, 2);
    const drag = 0.035;
    // Snap if the body jumped (pose reset, teleport): never fling fabric across.
    let jump = 0;
    for (let i = 0; i < n; i += 37) jump = Math.max(jump, Math.hypot(pos[i * 3] - target[i * 3], pos[i * 3 + 1] - target[i * 3 + 1], pos[i * 3 + 2] - target[i * 3 + 2]));
    if (jump > H * 0.35) { this.pos.set(target); this.prev.set(target); return; }

    // Integrate: inertia, plus a spring back to the worn position.
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const l = this.loose[i];
      const spring = THREE.MathUtils.lerp(0.3, 0.035, l) * hold;
      // Fabric that hugs the body moves WITH it (skin-tight clothes do not
      // wobble on a real person); only looser fabric keeps its own motion.
      const freedom = THREE.MathUtils.smoothstep(l, 0.1, 0.24);
      for (let k = 0; k < 3; k++) {
        const p = pos[o + k];
        const v = (p - prev[o + k]) * (1 - drag);
        prev[o + k] = p;
        const next = p + v + (target[o + k] - p) * spring;
        pos[o + k] = target[o + k] + (next - target[o + k]) * freedom;
      }
    }
    if (this.grab) {
      const g = this.grab;
      g.point.toArray(pos, g.index * 3);
    }

    // Links keep neighbours at the spacing the body gives them right now
    // (skinning reshapes sleeves at elbows and shoulders): fabric then rests
    // exactly in its worn shape and only moves when the body moves.
    if (this.linkLength.length !== this.edgesA.length) this.linkLength = new Float32Array(this.edgesA.length);
    for (let e = 0; e < this.edgesA.length; e++) {
      const a = this.edgesA[e] * 3, b = this.edgesB[e] * 3;
      this.linkLength[e] = Math.hypot(target[b] - target[a], target[b + 1] - target[a + 1], target[b + 2] - target[a + 2]);
    }

    for (let iteration = 0; iteration < 3; iteration++) {
      // Fabric does not stretch: keep neighbouring particles at their spacing.
      for (let e = 0; e < this.edgesA.length; e++) {
        const a = this.edgesA[e] * 3, b = this.edgesB[e] * 3;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-9) continue;
        const restLength = this.linkLength[e];
        const diff = (d - restLength) / d * 0.5 * 0.85;
        const wa = this.grab && this.grab.index * 3 === a ? 0 : 1;
        const wb = this.grab && this.grab.index * 3 === b ? 0 : 1;
        const sum = wa + wb || 1;
        pos[a] += dx * diff * (2 * wa / sum); pos[a + 1] += dy * diff * (2 * wa / sum); pos[a + 2] += dz * diff * (2 * wa / sum);
        pos[b] -= dx * diff * (2 * wb / sum); pos[b + 1] -= dy * diff * (2 * wb / sum); pos[b + 2] -= dz * diff * (2 * wb / sum);
      }
      // Stay on the body: each particle within its looseness radius of where
      // the body carries it (larger around a held point).
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        const boost = this.grab?.boost.get(i) ?? 1;
        const radius = this.loose[i] * looseScale * H * SLACK * boost + H * 0.002;
        const dx = pos[o] - target[o], dy = pos[o + 1] - target[o + 1], dz = pos[o + 2] - target[o + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d > radius) {
          // Inelastic: reaching the end of its slack stops the fabric rather
          // than bouncing it (the correction must not turn into velocity).
          const s = radius / d;
          const nx = target[o] + dx * s, ny = target[o + 1] + dy * s, nz = target[o + 2] + dz * s;
          prev[o] += nx - pos[o]; prev[o + 1] += ny - pos[o + 1]; prev[o + 2] += nz - pos[o + 2];
          pos[o] = nx; pos[o + 1] = ny; pos[o + 2] = nz;
        }
      }
      // Body collision, once per step (after the last constraint pass), and
      // only against the capsules this particle can reach.
      if (iteration < 2) {
        if (this.grab) this.grab.point.toArray(pos, this.grab.index * 3);
        continue;
      }
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        const from = this.nearStart[i], to = this.nearStart[i + 1];
        if (from === to) continue;
        this._v.fromArray(pos, o);
        let moved = false;
        for (let j = from; j < to; j++) {
          const c = this.capsules[this.nearIdx[j]];
          if (!c) continue;
          // Contact is relative to the worn shape: fabric may not sink deeper
          // toward this capsule's axis than where she wears it (the capsules
          // are rough and cut into garments, so their radius alone would
          // push worn fabric outward and fight the links).
          const wornAt = closestOnSegment(this._t.fromArray(target, o), c.a, c.b, this._w);
          const worn = this._t.distanceTo(wornAt);
          const closest = closestOnSegment(this._v, c.a, c.b, this._w);
          const dx = this._v.x - closest.x, dy = this._v.y - closest.y, dz = this._v.z - closest.z;
          const d = Math.hypot(dx, dy, dz);
          const min = Math.min(c.radius + H * 0.004, worn * 0.995);
          if (d < min && d > 1e-9) {
            const s = min / d;
            this._v.set(closest.x + dx * s, closest.y + dy * s, closest.z + dz * s);
            moved = true;
          }
        }
        if (moved) {
          // Fabric touching the body stops there instead of bouncing off.
          prev[o] += this._v.x - pos[o]; prev[o + 1] += this._v.y - pos[o + 1]; prev[o + 2] += this._v.z - pos[o + 2];
          this._v.toArray(pos, o);
        }
      }
      if (this.grab) this.grab.point.toArray(pos, this.grab.index * 3);
    }
  }

  /** Displacements → mesh-local space → texture. */
  private upload(): void {
    const mesh = this.model.mesh;
    this._inv.copy(mesh.matrixWorld).invert();
    this._m3.setFromMatrix4(this._inv);
    let max = 0;
    for (let i = 0; i < this.count; i++) {
      this._v.set(this.pos[i * 3] - this.target[i * 3], this.pos[i * 3 + 1] - this.target[i * 3 + 1], this.pos[i * 3 + 2] - this.target[i * 3 + 2]);
      max = Math.max(max, this._v.length());
      this._v.applyMatrix3(this._m3);
      this.texData[i * 4] = this._v.x; this.texData[i * 4 + 1] = this._v.y; this.texData[i * 4 + 2] = this._v.z;
    }
    this.maxOffset = max;
    this.texture.needsUpdate = true;
  }

  // ---- interaction ---------------------------------------------------------------

  /** Nearest particle to a screen point (NDC), within `radius` NDC units. */
  pick(ndcX: number, ndcY: number, camera: THREE.Camera, radius = 0.045): number | null {
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < this.count; i++) {
      this._v.fromArray(this.pos, i * 3).project(camera);
      if (this._v.z < -1 || this._v.z > 1) continue;
      const d = Math.hypot(this._v.x - ndcX, this._v.y - ndcY);
      if (d > radius) continue;
      // Prefer the front-most fabric under the cursor.
      const score = d + this._v.z * 0.05;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best >= 0 ? best : null;
  }

  particlePosition(index: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.fromArray(this.pos, index * 3);
  }

  /** Hold a particle at a world point; the surrounding fabric may stretch further from the body. */
  grabParticle(index: number, point: THREE.Vector3): void {
    const boost = new Map<number, number>();
    const frontier = [index];
    boost.set(index, 2.2);
    for (let ring = 1; ring <= 3; ring++) {
      const next: number[] = [];
      for (const p of frontier) for (const q of this.neighbours[p]) if (!boost.has(q)) { boost.set(q, 2.2 - ring * 0.35); next.push(q); }
      frontier.splice(0, frontier.length, ...next);
    }
    this.grab = { index, point: point.clone(), boost };
  }

  dragParticle(point: THREE.Vector3): void {
    if (!this.grab) return;
    // Fabric is attached: it can be pulled, but not torn away from her.
    const t = this._w.fromArray(this.target, this.grab.index * 3);
    // A tug, not a pull-off: the held point stays within its own (boosted) slack.
    const limit = this.height * (SLACK * this.loose[this.grab.index] * 2.2 + 0.004);
    this.grab.point.copy(point);
    if (point.distanceTo(t) > limit) this.grab.point.sub(t).setLength(limit).add(t);
  }

  release(): void {
    this.grab = null;
  }

  get grabbing(): boolean {
    return this.grab !== null;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 > 1e-12 ? THREE.MathUtils.clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2, 0, 1) : 0;
  return out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
}

function capsuleDistance(p: THREE.Vector3, c: Capsule): number {
  const q = closestOnSegment(p, c.a, c.b, new THREE.Vector3());
  return p.distanceTo(q);
}
