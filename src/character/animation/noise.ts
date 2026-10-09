/**
 * Smooth 1D value noise.
 *
 * Idle motion built from pure sine waves reads as mechanical because the
 * period is perfectly predictable. Layering a couple of octaves of smooth
 * noise on top gives drift that never repeats but stays gentle and bounded,
 * which is what makes small movements look alive rather than looped.
 */

/** Deterministic hash -> [-1, 1]. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Smoothstep interpolation between integer lattice points. */
export function valueNoise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

/**
 * Fractal noise: several octaves of `valueNoise` at halving amplitude.
 * Returns roughly [-1, 1].
 */
export function fbm(x: number, octaves = 2): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Asymmetric breathing curve over a 0..1 phase.
 *
 * Real breathing is not sinusoidal: the inhale is quicker than the exhale and
 * there is a short pause at the bottom. Returns 0..1.
 */
export function breathCurve(phase: number): number {
  const p = phase - Math.floor(phase);
  const INHALE = 0.38;
  if (p < INHALE) {
    const t = p / INHALE;
    return t * t * (3 - 2 * t);
  }
  const t = (p - INHALE) / (1 - INHALE);
  // Ease out, with the last stretch nearly flat: the rest at the bottom.
  return 1 - (t * t * (3 - 2 * t)) ** 0.85;
}

/** Ease a 0..1 value with a soft start and stop. */
export function easeInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Overshoot ease, for gestures that should feel springy rather than linear. */
export function easeOutBack(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  const s = 1.35;
  const p = c - 1;
  return p * p * ((s + 1) * p + s) + 1;
}
