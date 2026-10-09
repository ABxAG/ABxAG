/**
 * Baked per-vertex ambient occlusion.
 *
 * AO is what stops a cel-shaded character reading as flat plastic: it puts
 * contact darkening under the chin and jaw, in the neck, inside clothing
 * folds, under the collar and hair, and between overlapping panels. Without it
 * every surface receives the same ambient term regardless of how enclosed it
 * is, which is exactly the "uniformly bright" look we're avoiding.
 *
 * This bakes it once at load rather than running SSAO every frame:
 *
 *   - SSAO needs an EffectComposer, and the character canvas is transparent so
 *     it can composite into ABxAG's backdrop - composer passes destroy alpha.
 *   - SSAO is view-dependent and famously haloes around silhouettes, which is
 *     very visible on a character against a dark stage.
 *   - Baked AO costs nothing per frame, which matters for a companion app
 *     sharing the GPU with everything else on the desktop.
 *
 * Method: voxelise the mesh into an occupancy grid, then for each vertex cast
 * a short cosine-weighted hemisphere of rays against that grid and measure how
 * many are blocked. Results are smoothed across connected vertices to remove
 * sampling noise, then written to a `aoValue` vertex attribute.
 */
import * as THREE from 'three';

export interface BakeAoOptions {
  /** Voxels along the longest axis. Higher = finer contact detail. */
  resolution?: number;
  /** Hemisphere rays per vertex. */
  samples?: number;
  /** How far a ray travels, as a fraction of the model's bounding size. */
  rayLength?: number;
  /** Smoothing passes over the vertex graph. */
  smoothPasses?: number;
  /** Remaps the raw result: higher darkens creases faster. */
  contrast?: number;
  /**
   * Floor for the darkest result. AO should describe contact, not act as a
   * second shadow pass - without a floor, deep creases go black and the
   * "avoid crushing dark details" requirement is lost.
   */
  minimum?: number;
}

/** Deterministic low-discrepancy hemisphere directions (cosine weighted). */
function hemisphereDirections(count: number): Float32Array {
  const dirs = new Float32Array(count * 3);
  // Golden-angle spiral gives an even distribution without clumping.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    // Cosine weighting: bias samples toward the pole (the surface normal).
    const z = Math.sqrt(1 - (i + 0.5) / count);
    const r = Math.sqrt(1 - z * z);
    const phi = i * golden;
    dirs[i * 3] = Math.cos(phi) * r;
    dirs[i * 3 + 1] = Math.sin(phi) * r;
    dirs[i * 3 + 2] = z;
  }
  return dirs;
}

/**
 * Compute per-vertex AO and attach it to `geometry` as `aoValue` (1 = open,
 * 0 = fully enclosed). Safe to call on any indexed BufferGeometry.
 */
export function bakeVertexAmbientOcclusion(
  geometry: THREE.BufferGeometry,
  options: BakeAoOptions = {}
): void {
  const resolution = options.resolution ?? 96;
  const sampleCount = options.samples ?? 24;
  // Short rays keep AO local to genuine contact. Long rays make every
  // slightly-concave surface dark, which reads as grime rather than depth.
  const rayLengthFrac = options.rayLength ?? 0.03;
  const smoothPasses = options.smoothPasses ?? 2;
  const contrast = options.contrast ?? 0.85;
  const minimum = options.minimum ?? 0.42;

  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const index = geometry.getIndex();
  if (!position || !normal || !index) return;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = new THREE.Vector3();
  box.getSize(size);
  const extent = Math.max(size.x, size.y, size.z) || 1;
  const voxel = extent / resolution;

  // Grid dimensions, padded by one voxel so surface cells are never clipped.
  const nx = Math.max(1, Math.ceil(size.x / voxel) + 2);
  const ny = Math.max(1, Math.ceil(size.y / voxel) + 2);
  const nz = Math.max(1, Math.ceil(size.z / voxel) + 2);
  const originX = box.min.x - voxel;
  const originY = box.min.y - voxel;
  const originZ = box.min.z - voxel;

  const grid = new Uint8Array(nx * ny * nz);
  const cell = (ix: number, iy: number, iz: number) => (iz * ny + iy) * nx + ix;

  const markPoint = (x: number, y: number, z: number) => {
    const ix = ((x - originX) / voxel) | 0;
    const iy = ((y - originY) / voxel) | 0;
    const iz = ((z - originZ) / voxel) | 0;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return;
    grid[cell(ix, iy, iz)] = 1;
  };

  // --- voxelise ------------------------------------------------------------
  // Vertices alone leave holes in large triangles, so each triangle is also
  // sampled across its interior at roughly voxel density.
  const triCount = index.count / 3;
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const i0 = index.getX(t * 3);
    const i1 = index.getX(t * 3 + 1);
    const i2 = index.getX(t * 3 + 2);
    ax.fromBufferAttribute(position, i0);
    bx.fromBufferAttribute(position, i1);
    cx.fromBufferAttribute(position, i2);

    markPoint(ax.x, ax.y, ax.z);
    markPoint(bx.x, bx.y, bx.z);
    markPoint(cx.x, cx.y, cx.z);

    // Subdivide proportionally to the triangle's longest edge.
    const longest = Math.max(ax.distanceTo(bx), bx.distanceTo(cx), cx.distanceTo(ax));
    const steps = Math.min(6, Math.ceil(longest / voxel));
    if (steps <= 1) continue;
    for (let u = 0; u <= steps; u++) {
      for (let v = 0; v + u <= steps; v++) {
        const w0 = u / steps;
        const w1 = v / steps;
        const w2 = 1 - w0 - w1;
        markPoint(
          ax.x * w0 + bx.x * w1 + cx.x * w2,
          ax.y * w0 + bx.y * w1 + cx.y * w2,
          ax.z * w0 + bx.z * w1 + cx.z * w2
        );
      }
    }
  }

  // --- sample --------------------------------------------------------------
  const dirs = hemisphereDirections(sampleCount);
  const rayLength = extent * rayLengthFrac;
  const raySteps = Math.max(3, Math.round(rayLength / voxel));
  const stepLength = rayLength / raySteps;

  const count = position.count;
  const ao = new Float32Array(count);

  const n = new THREE.Vector3();
  const p = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const helper = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(position, i);
    n.fromBufferAttribute(normal, i).normalize();

    // Build an orthonormal basis around the normal so the cosine-weighted
    // sample set can be oriented to the surface.
    helper.set(Math.abs(n.z) < 0.9 ? 0 : 1, Math.abs(n.z) < 0.9 ? 0 : 0, Math.abs(n.z) < 0.9 ? 1 : 0);
    tangent.crossVectors(helper, n);
    if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);
    tangent.normalize();
    bitangent.crossVectors(n, tangent);

    let blocked = 0;
    for (let s = 0; s < sampleCount; s++) {
      const dx = dirs[s * 3];
      const dy = dirs[s * 3 + 1];
      const dz = dirs[s * 3 + 2];
      // Transform the sample into world orientation.
      const rx = tangent.x * dx + bitangent.x * dy + n.x * dz;
      const ry = tangent.y * dx + bitangent.y * dy + n.y * dz;
      const rz = tangent.z * dx + bitangent.z * dy + n.z * dz;

      // March, starting slightly off the surface to avoid self-hits.
      let hit = 0;
      for (let step = 1; step <= raySteps; step++) {
        const d = stepLength * step + voxel * 0.75;
        const gx = ((p.x + rx * d - originX) / voxel) | 0;
        const gy = ((p.y + ry * d - originY) / voxel) | 0;
        const gz = ((p.z + rz * d - originZ) / voxel) | 0;
        if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) break;
        if (grid[cell(gx, gy, gz)] === 1) {
          // Nearer occluders darken more.
          hit = 1 - (step - 1) / raySteps;
          break;
        }
      }
      blocked += hit;
    }
    ao[i] = 1 - blocked / sampleCount;
  }

  // --- smooth --------------------------------------------------------------
  // Averaging across shared edges removes the speckle that voxel sampling
  // leaves behind, which would otherwise shimmer as the character animates.
  if (smoothPasses > 0) {
    const neighbourSum = new Float32Array(count);
    const neighbourCount = new Uint16Array(count);
    for (let pass = 0; pass < smoothPasses; pass++) {
      neighbourSum.fill(0);
      neighbourCount.fill(0);
      for (let t = 0; t < triCount; t++) {
        const i0 = index.getX(t * 3);
        const i1 = index.getX(t * 3 + 1);
        const i2 = index.getX(t * 3 + 2);
        neighbourSum[i0] += ao[i1] + ao[i2];
        neighbourCount[i0] += 2;
        neighbourSum[i1] += ao[i0] + ao[i2];
        neighbourCount[i1] += 2;
        neighbourSum[i2] += ao[i0] + ao[i1];
        neighbourCount[i2] += 2;
      }
      for (let i = 0; i < count; i++) {
        if (neighbourCount[i] === 0) continue;
        ao[i] = ao[i] * 0.45 + (neighbourSum[i] / neighbourCount[i]) * 0.55;
      }
    }
  }

  // --- shape ---------------------------------------------------------------
  for (let i = 0; i < count; i++) {
    const shaped = Math.pow(THREE.MathUtils.clamp(ao[i], 0, 1), contrast);
    // Remap into [minimum, 1] so creases darken without ever crushing.
    ao[i] = minimum + shaped * (1 - minimum);
  }

  geometry.setAttribute('aoValue', new THREE.BufferAttribute(ao, 1));
}

