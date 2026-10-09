/**
 * MMD toon ramp -> three.js gradient map.
 *
 * MMD toon textures are square images whose shading ramp runs *vertically*
 * (bright at the top, dark at the bottom). three.js `MeshToonMaterial`
 * samples its `gradientMap` *horizontally* at `dot(N,L) * 0.5 + 0.5`.
 * This module reads the vertical ramp out of the source image and rebuilds
 * it as a 1D horizontal gradient with the correct orientation.
 *
 * Two art controls are applied while rebuilding:
 *
 *   softness  - lifts the whole ramp toward fully-lit. 1 keeps the author's
 *               original ramp, 0 produces flat unshaded colour. Values around
 *               0.5-0.6 give the gentle anime shading we want, with no
 *               crushed black shadow.
 *   terminator- blurs the ramp so the light/shadow boundary is a soft band
 *               instead of MMD's hard step.
 */
import * as THREE from 'three';

const RAMP_RESOLUTION = 128;

export interface ToonRampOptions {
  /**
   * Width of the light/shadow transition. 0 gives MMD's hard cel step, 1 a
   * broad painterly falloff. This controls the SHAPE of the terminator.
   */
  softness: number;
  /**
   * How dark the shadow side gets, 0..1. This controls the DEPTH of the
   * shading and is what actually gives the character form.
   *
   * It exists because this model's authored ramps (skin.bmp, hair.bmp) are
   * almost pure white - they span roughly 0.90 to 1.00 - so relying on them
   * alone produces a completely flat, unshaded character. The authored ramp
   * is still multiplied in, preserving any tint the artist put there, but the
   * form comes from here.
   */
  shadowStrength?: number;
  /** Blur width applied to the sampled image ramp, in samples. */
  terminator?: number;
}

const cache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  let pending = cache.get(url);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load toon ramp: ${url}`));
      img.src = url;
    });
    cache.set(url, pending);
  }
  return pending;
}

/**
 * Ramp for materials with no toon texture (and the placeholder used until an
 * async one decodes). The authored contribution is a flat 1.0, so the shape
 * comes entirely from `finalise`.
 */
export function createDefaultRamp(options: ToonRampOptions): THREE.DataTexture {
  const samples = new Float32Array(RAMP_RESOLUTION).fill(1);
  return finalise(samples, { ...options, terminator: 0 });
}

/**
 * Read `url` and convert its vertical ramp into a horizontal gradient map.
 * Falls back to a synthetic ramp if the image cannot be read.
 */
export async function createToonRamp(
  url: string | null,
  options: ToonRampOptions
): Promise<THREE.DataTexture> {
  if (!url) return createDefaultRamp(options);

  let img: HTMLImageElement;
  try {
    img = await loadImage(url);
  } catch {
    return createDefaultRamp(options);
  }

  const w = img.naturalWidth || 32;
  const h = img.naturalHeight || 32;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return createDefaultRamp(options);

  ctx.drawImage(img, 0, 0);
  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return createDefaultRamp(options);
  }

  const samples = new Float32Array(RAMP_RESOLUTION);
  for (let i = 0; i < RAMP_RESOLUTION; i++) {
    // i = 0 is the fully-shadowed end (dot(N,L) = -1), which lives at the
    // BOTTOM of an MMD toon texture, so the vertical lookup is inverted.
    const t = i / (RAMP_RESOLUTION - 1);
    const y = Math.min(h - 1, Math.round((1 - t) * (h - 1)));

    // Average a few columns for robustness against noisy or bordered ramps.
    let sum = 0;
    let count = 0;
    for (let s = 0; s < 5; s++) {
      const x = Math.min(w - 1, Math.round(((s + 0.5) / 5) * (w - 1)));
      const o = (y * w + x) * 4;
      // Luminance of the ramp colour.
      sum += (pixels[o] * 0.2126 + pixels[o + 1] * 0.7152 + pixels[o + 2] * 0.0722) / 255;
      count++;
    }
    samples[i] = sum / count;
  }

  return finalise(samples, options);
}

/** Apply softness + terminator blur and upload as a 1D-style DataTexture. */
function finalise(samples: Float32Array, options: ToonRampOptions): THREE.DataTexture {
  const n = samples.length;
  const blurRadius = Math.max(0, Math.round(options.terminator ?? 6));

  let ramp = samples;
  if (blurRadius > 0) {
    const blurred = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let weight = 0;
      for (let k = -blurRadius; k <= blurRadius; k++) {
        const j = THREE.MathUtils.clamp(i + k, 0, n - 1);
        // Gaussian-ish falloff.
        const w = Math.exp(-(k * k) / (2 * (blurRadius / 2) ** 2 || 1));
        sum += ramp[j] * w;
        weight += w;
      }
      blurred[i] = sum / weight;
    }
    ramp = blurred;
  }

  // The ramp encodes SHAPE ONLY: 0 = fully shadowed, 1 = fully lit.
  //
  // How dark the shadow gets, and what colour it shifts to, are decided later
  // by the material's shadow tint and the normalised light level. Baking depth
  // in here as well would apply it twice and crush the shadows.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (ramp[i] < lo) lo = ramp[i];
    if (ramp[i] > hi) hi = ramp[i];
  }
  const span = hi - lo;

  const softness = THREE.MathUtils.clamp(options.softness, 0, 1);
  const halfWidth = 0.06 + softness * 0.34;

  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Normalise the authored ramp to full 0..1 contrast. MMD toon textures are
    // often nearly flat (this model's span barely 0.09), which would otherwise
    // produce no visible terminator at all.
    const authored = span > 0.02 ? (ramp[i] - lo) / span : 1;
    const synthetic = THREE.MathUtils.smoothstep(t, 0.5 - halfWidth, 0.5 + halfWidth);
    // Blend toward the synthetic curve when the authored ramp is featureless.
    const v = span > 0.02 ? authored * 0.65 + synthetic * 0.35 : synthetic;
    const b = Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255);
    data[i * 4] = b;
    data[i * 4 + 1] = b;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }

  const texture = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
