/**
 * Procedural photo-studio environment for the realism shading path.
 *
 * Real characters look real largely because of what they reflect: soft boxes,
 * a bright ceiling, a darker floor, warm and cool sides. MeshToonMaterial has
 * no environment-map path, so AnimeMaterial samples this texture itself, by
 * the world-space normal (diffuse irradiance, from the blurriest level) and by
 * the reflection vector (glossy reflection, blur chosen by roughness).
 *
 * The map is an equirectangular RGBA8 texture whose values are scaled by
 * `ENV_RANGE` in the shader, so soft boxes can be brighter than 1 without
 * float textures. Its mip chain is built on the CPU with a separable blur that
 * widens per level, which approximates a roughness pre-filter well enough for
 * stylised characters and works on every WebGL2 GPU.
 */
import * as THREE from 'three';

/** Shader multiplier for the 0..1 texel values. */
export const ENV_RANGE = 4;

const WIDTH = 256;
const HEIGHT = 128;

interface SoftBox {
  /** Direction toward the light, world space (character faces +Z). */
  dir: THREE.Vector3;
  /** Angular radius in radians. */
  size: number;
  /** Linear colour × intensity, before ENV_RANGE packing. */
  color: THREE.Color;
}

function dirFromDegrees(azimuth: number, elevation: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuth);
  const el = THREE.MathUtils.degToRad(elevation);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

const SOFT_BOXES: SoftBox[] = [
  // Large warm key, front-left and above: the main window light.
  { dir: dirFromDegrees(38, 32), size: 0.42, color: new THREE.Color(1.0, 0.93, 0.84).multiplyScalar(3.2) },
  // Cool fill on the other side, broad and dim.
  { dir: dirFromDegrees(-62, 12), size: 0.6, color: new THREE.Color(0.72, 0.8, 1.0).multiplyScalar(1.1) },
  // Overhead strip: the sheen across hair and shoulders.
  { dir: dirFromDegrees(0, 78), size: 0.32, color: new THREE.Color(1.0, 0.98, 0.95).multiplyScalar(2.1) },
  // Two rim strips behind her: bright edges on the silhouette.
  { dir: dirFromDegrees(150, 18), size: 0.22, color: new THREE.Color(0.9, 0.94, 1.0).multiplyScalar(2.4) },
  { dir: dirFromDegrees(-150, 22), size: 0.2, color: new THREE.Color(1.0, 0.9, 0.86).multiplyScalar(1.8) },
];

/** Studio background radiance for a direction (before soft boxes). */
function base(dir: THREE.Vector3, out: THREE.Color): THREE.Color {
  const y = dir.y;
  // Ceiling a little brighter, walls mid grey with a warm-cool split, dark floor
  // with a faint warm bounce.
  const ceiling = new THREE.Color(0.42, 0.43, 0.46);
  const wallWarm = new THREE.Color(0.24, 0.215, 0.2);
  const wallCool = new THREE.Color(0.17, 0.19, 0.23);
  const floor = new THREE.Color(0.1, 0.085, 0.075);
  const wall = wallCool.clone().lerp(wallWarm, THREE.MathUtils.clamp(dir.x * 0.5 + 0.5, 0, 1));
  if (y >= 0) out.copy(wall).lerp(ceiling, Math.pow(y, 0.8));
  else out.copy(wall).lerp(floor, Math.min(1, -y * 2.2));
  return out;
}

function radiance(dir: THREE.Vector3, out: THREE.Color): THREE.Color {
  base(dir, out);
  for (const box of SOFT_BOXES) {
    const angle = Math.acos(THREE.MathUtils.clamp(dir.dot(box.dir), -1, 1));
    // Soft-edged disc: full inside, smooth falloff over the outer 40%.
    const t = 1 - THREE.MathUtils.smoothstep(angle, box.size * 0.6, box.size);
    if (t > 0) out.r += box.color.r * t, out.g += box.color.g * t, out.b += box.color.b * t;
  }
  return out;
}

function blurLevel(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  // Separable box blur, horizontal wraps (equirect seam), vertical clamps.
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < h; y++) {
    // Rows near the poles cover less solid angle: widen the horizontal kernel.
    const lat = ((y + 0.5) / h - 0.5) * Math.PI;
    const rx = Math.min(w / 2, Math.round(r / Math.max(0.15, Math.cos(lat))));
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0;
      for (let k = -rx; k <= rx; k++) {
        const i = (y * w + ((x + k + w) % w)) * 4;
        sr += src[i]; sg += src[i + 1]; sb += src[i + 2];
      }
      const n = 2 * rx + 1, o = (y * w + x) * 4;
      tmp[o] = sr / n; tmp[o + 1] = sg / n; tmp[o + 2] = sb / n; tmp[o + 3] = 1;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const i = (yy * w + x) * 4;
        sr += tmp[i]; sg += tmp[i + 1]; sb += tmp[i + 2]; n++;
      }
      const o = (y * w + x) * 4;
      out[o] = sr / n; out[o + 1] = sg / n; out[o + 2] = sb / n; out[o + 3] = 1;
    }
  }
  return out;
}

function downsample(src: Float32Array, w: number, h: number): Float32Array {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const o = (y * nw + x) * 4;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += src[((Math.min(h - 1, y * 2 + dy)) * w + Math.min(w - 1, x * 2 + dx)) * 4 + c];
        out[o + c] = s / 4;
      }
      out[o + 3] = 1;
    }
  }
  return out;
}

function pack(src: Float32Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = i % 4 === 3 ? 255 : Math.round(THREE.MathUtils.clamp(src[i] / ENV_RANGE, 0, 1) * 255);
  return out;
}

let shared: THREE.DataTexture | null = null;

/** The studio environment, built once and shared by every character material. */
export function getStudioEnvironment(): THREE.DataTexture {
  if (shared) return shared;
  const dir = new THREE.Vector3();
  const color = new THREE.Color();
  let level = new Float32Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    // Row 0 is the top of the texture after flipY=false: v=0 → +Y (up).
    const phi = ((y + 0.5) / HEIGHT) * Math.PI;
    for (let x = 0; x < WIDTH; x++) {
      const theta = ((x + 0.5) / WIDTH) * Math.PI * 2;
      // Matches the shader's direction→uv mapping (see envUv in AnimeMaterial).
      dir.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
      radiance(dir, color);
      const o = (y * WIDTH + x) * 4;
      level[o] = color.r; level[o + 1] = color.g; level[o + 2] = color.b; level[o + 3] = 1;
    }
  }

  // Level 0 keeps sharp soft-box edges for glossy surfaces (eyes, metal).
  const mipmaps: Array<{ data: Uint8Array; width: number; height: number }> = [];
  let w = WIDTH, h = HEIGHT;
  mipmaps.push({ data: pack(level), width: w, height: h });
  let blur = 1;
  while (w > 1 || h > 1) {
    level = downsample(level, w, h);
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    // Each level is blurred a little more than a plain downsample would be,
    // so the chain approximates increasing roughness rather than only scale.
    if (w > 2) level = blurLevel(level, w, h, blur);
    blur = Math.min(3, blur + 0.5);
    mipmaps.push({ data: pack(level), width: w, height: h });
  }

  const texture = new THREE.DataTexture(mipmaps[0].data, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.mipmaps = mipmaps as unknown as THREE.DataTexture['mipmaps'];
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace; // values are linear radiance
  texture.flipY = false;
  texture.needsUpdate = true;
  shared = texture;
  return texture;
}

/** Number of the last mip level (the blurriest, used for diffuse irradiance). */
export function studioEnvironmentMaxMip(): number {
  return Math.log2(Math.max(WIDTH, HEIGHT));
}
