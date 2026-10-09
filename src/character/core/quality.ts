/**
 * Graphics quality presets (Settings → Graphics quality).
 *
 * The character's GPU cost is dominated by the drawing buffer (resolution x
 * MSAA), the key light's shadow map and the decoded textures. Two windows
 * (the app and the desktop companion) each pay it, so low-end PCs need all
 * three turned down. "auto" picks low on integrated / low-memory machines.
 */
import * as THREE from 'three';
import type { CharacterConfig } from '../config/types';

/** Shown as: High / Medium (balanced) / Optimized (low) / Potato PC. */
export type GraphicsQuality = 'auto' | 'potato' | 'low' | 'balanced' | 'high';
const LEVELS = ['potato', 'low', 'balanced', 'high'] as const;

export interface QualityProfile {
  level: Exclude<GraphicsQuality, 'auto'>;
  maxPixelRatio: number;
  antialias: boolean;
  shadowMapSize: number;
  /** Largest texture edge kept on the GPU (0 = unlimited). */
  maxTextureSize: number;
  maxAnisotropy: number;
  targetFps: number;
  /** Vertex cloth simulation (CPU, plus a vertex-shader patch). */
  cloth: boolean;
  /** Real-time shadows from the key light. */
  shadows: boolean;
}

const PROFILES: Record<QualityProfile['level'], QualityProfile> = {
  // Renders below screen resolution and upscales; no shadows; tiny textures.
  potato: { level: 'potato', maxPixelRatio: 0.75, antialias: false, shadowMapSize: 512, maxTextureSize: 512, maxAnisotropy: 1, targetFps: 24, cloth: false, shadows: false },
  low: { level: 'low', maxPixelRatio: 1, antialias: false, shadowMapSize: 1024, maxTextureSize: 1024, maxAnisotropy: 2, targetFps: 30, cloth: false, shadows: true },
  balanced: { level: 'balanced', maxPixelRatio: 1.25, antialias: true, shadowMapSize: 1024, maxTextureSize: 2048, maxAnisotropy: 4, targetFps: 60, cloth: true, shadows: true },
  high: { level: 'high', maxPixelRatio: 2, antialias: true, shadowMapSize: 4096, maxTextureSize: 0, maxAnisotropy: 16, targetFps: 60, cloth: true, shadows: true },
};

let detected: QualityProfile['level'] | null = null;

/** Best guess for this PC: integrated GPUs and small machines get "low". */
export function detectQuality(): QualityProfile['level'] {
  if (detected) return detected;
  let level: QualityProfile['level'] = 'balanced';
  try {
    const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    const cores = navigator.hardwareConcurrency || 4;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    let renderer = '';
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    const integrated = /intel|uhd|iris|microsoft basic|swiftshader|llvmpipe|mali|adreno|vega \d+ graphics|radeon\(tm\) graphics|radeon graphics/i.test(renderer);
    if (!gl || integrated || (memory !== undefined && memory <= 4) || cores <= 2) level = 'low';
  } catch {
    level = 'balanced';
  }
  detected = level;
  return level;
}

/**
 * `autoStep`: how many levels Auto has stepped down after crashes / lost GPU
 * contexts on this PC (the shell and the renderer raise it, see
 * reportGraphicsTrouble). A fixed choice is never changed behind the user.
 */
export function qualityProfile(quality: GraphicsQuality | undefined | null, autoStep = 0): QualityProfile {
  if (quality && quality !== 'auto' && quality in PROFILES) return PROFILES[quality as QualityProfile['level']];
  const base = LEVELS.indexOf(detectQuality());
  const level = LEVELS[Math.max(0, base - Math.max(0, Math.floor(autoStep) || 0))];
  return PROFILES[level];
}

/** Auto quality: step one level down for next time (after a crash or lost GPU context). */
export function reportGraphicsTrouble(): void {
  void fetch('/api/app-settings')
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (!s || (s.graphics?.quality ?? 'auto') !== 'auto') return;
      const step = Math.min(3, (Number(s.graphics?.autoStep) || 0) + 1);
      return fetch('/api/app-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graphics: { autoStep: step } }) });
    })
    .catch(() => undefined);
}

/** The character config with render cost limited to the profile (never raised). */
export function withQuality(config: CharacterConfig, profile: QualityProfile): CharacterConfig {
  return {
    ...config,
    render: {
      ...config.render,
      maxPixelRatio: Math.min(config.render.maxPixelRatio, profile.maxPixelRatio),
      antialias: config.render.antialias && profile.antialias,
      targetFps: Math.min(config.render.targetFps, profile.targetFps),
    },
    lighting: {
      ...config.lighting,
      shadow: {
        ...config.lighting.shadow,
        enabled: config.lighting.shadow.enabled && profile.shadows,
        mapSize: Math.min(config.lighting.shadow.mapSize, profile.shadowMapSize),
      },
    },
  };
}

/** Shrink a loaded texture so its longest edge is at most `max` px. */
export function limitTextureSize(texture: THREE.Texture, max: number): void {
  if (!max) return;
  const image = texture.image as { width?: number; height?: number } | undefined;
  const w = image?.width ?? 0;
  const h = image?.height ?? 0;
  if (!w || !h || Math.max(w, h) <= max) return;
  const scale = max / Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(texture.image as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  texture.image = canvas;
  texture.needsUpdate = true;
}

/** A TextureLoader that shrinks every texture it loads to the profile's limit. */
export function limitedTextureLoader(loader: THREE.TextureLoader, max: number): THREE.TextureLoader {
  if (!max) return loader;
  const limited = Object.create(loader) as THREE.TextureLoader;
  limited.load = (url, onLoad, onProgress, onError) =>
    loader.load(
      url,
      (texture) => {
        limitTextureSize(texture, max);
        onLoad?.(texture);
      },
      onProgress,
      onError,
    );
  return limited;
}
