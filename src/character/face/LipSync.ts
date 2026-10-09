/**
 * Real-time lip sync.
 *
 * ABxAG's voice arrives as streamed PCM with no phoneme track, so visemes are
 * estimated from the live spectrum of `ABxAGAudioSession.outputAnalyser`.
 *
 * This is a formant-band estimator, not a phoneme recogniser. It reads two
 * cues that map well onto the Japanese five-vowel morph set every PMX model
 * ships (あ/い/う/え/お):
 *
 *   openness  - broadband energy, driving how far the mouth opens
 *   F1 proxy  - low vs. low-mid energy; high F1 means an open vowel (a, e)
 *   F2 proxy  - high-band share; high F2 means a front vowel (i, e)
 *
 * Two things keep it from looking robotic:
 *
 *   - a fast-attack / slow-release envelope on openness, matching how a jaw
 *     actually moves (it drops open quickly and closes lazily), and
 *   - co-articulation: visemes cross-fade toward their target rather than
 *     switching, so the mouth is always mid-transition like real speech.
 */
import * as THREE from 'three';
import type { LipSyncConfig } from '../config/types';

/** Normalised viseme weights produced each frame. */
export interface VisemeWeights {
  a: number;
  i: number;
  u: number;
  e: number;
  o: number;
  /** Relaxed conversational shape, mixed in to soften pure vowels. */
  talk: number;
  /** Overall mouth openness, 0..1. */
  openness: number;
}

/** Frequency band edges in Hz, chosen around typical female formants. */
const BANDS = {
  low: [180, 620],
  lowMid: [620, 1150],
  mid: [1150, 1900],
  high: [1900, 3400],
} as const;

export class LipSync {
  private spectrum: Uint8Array = new Uint8Array(0);
  private envelope = 0;
  private speechClock = 0;
  private readonly current: VisemeWeights = {
    a: 0, i: 0, u: 0, e: 0, o: 0, talk: 0, openness: 0,
  };
  private readonly target: VisemeWeights = {
    a: 0, i: 0, u: 0, e: 0, o: 0, talk: 0, openness: 0,
  };
  /** Cached bin ranges, recomputed when the analyser changes. */
  private binRanges: Record<keyof typeof BANDS, [number, number]> | null = null;
  private cachedFftSize = -1;
  private cachedSampleRate = -1;

  constructor(private config: LipSyncConfig) {}

  setConfig(config: LipSyncConfig): void {
    this.config = config;
  }

  /** Fade the mouth shut, e.g. when speech ends. */
  silence(delta: number): VisemeWeights {
    return this.update(null, delta);
  }

  /**
   * Advance the estimator. Pass the active output analyser while speaking,
   * or null to let the mouth close naturally.
   */
  update(
    analyser: AnalyserNode | null,
    delta: number,
    speaking = analyser !== null
  ): VisemeWeights {
    if (analyser && analyser.context.state === 'running') {
      this.analyse(analyser);
    } else if (speaking) {
      // Activity can switch to talking one or two frames before a streamed
      // analyser is ready. Keep the lips articulating during that hand-off.
      this.synthesiseSpeech(delta);
    } else {
      this.target.openness = 0;
      this.target.a = this.target.i = this.target.u = 0;
      this.target.e = this.target.o = this.target.talk = 0;
    }

    // Frame-rate independent smoothing toward the target shape.
    const blend = 1 - Math.exp(-(this.config.visemeBlendRate * 60) * delta);
    this.current.a = THREE.MathUtils.lerp(this.current.a, this.target.a, blend);
    this.current.i = THREE.MathUtils.lerp(this.current.i, this.target.i, blend);
    this.current.u = THREE.MathUtils.lerp(this.current.u, this.target.u, blend);
    this.current.e = THREE.MathUtils.lerp(this.current.e, this.target.e, blend);
    this.current.o = THREE.MathUtils.lerp(this.current.o, this.target.o, blend);
    this.current.talk = THREE.MathUtils.lerp(this.current.talk, this.target.talk, blend);

    // A jaw opens faster than it closes; separate rates avoid the flat,
    // buzzing look of a symmetric filter.
    const rate = this.target.openness > this.current.openness
      ? this.config.attack
      : this.config.release;
    const openBlend = 1 - Math.exp(-(rate * 60) * delta);
    this.current.openness = THREE.MathUtils.lerp(
      this.current.openness,
      this.target.openness,
      openBlend
    );

    return this.current;
  }

  /**
   * Natural fallback articulation used while a real analyser is unavailable.
   * It cycles smoothly through the same five vowel controls instead of merely
   * opening and closing the jaw, so preview talking remains representative.
   */
  private synthesiseSpeech(delta: number): void {
    this.speechClock += delta;
    const syllable = Math.pow(
      Math.max(0, Math.sin(this.speechClock * Math.PI * 2 * 3.7)),
      1.45
    );
    const phrase = 0.78 + Math.sin(this.speechClock * 0.82) * 0.18;
    const envelope = THREE.MathUtils.clamp((0.12 + syllable * 0.62) * phrase, 0, 0.78);
    const openVowel = Math.sin(this.speechClock * 2.15 + 0.7) * 0.5 + 0.5;
    const frontVowel = Math.sin(this.speechClock * 1.57 + 2.1) * 0.5 + 0.5;

    const a = openVowel * (1 - frontVowel);
    const e = openVowel * frontVowel;
    const o = (1 - openVowel) * (1 - frontVowel) * 0.64;
    const u = (1 - openVowel) * (1 - frontVowel) * 0.36;
    const i = (1 - openVowel) * frontVowel;
    const sum = a + e + o + u + i || 1;
    const scale = envelope * this.config.maxWeight / sum;

    this.target.a = a * scale;
    this.target.e = e * scale;
    this.target.o = o * scale;
    this.target.u = u * scale;
    this.target.i = i * scale;
    this.target.talk = envelope * 0.2 * this.config.maxWeight;
    this.target.openness = envelope;
  }

  private ensureBins(analyser: AnalyserNode): void {
    const sampleRate = analyser.context.sampleRate;
    if (this.cachedFftSize === analyser.fftSize && this.cachedSampleRate === sampleRate) return;

    this.cachedFftSize = analyser.fftSize;
    this.cachedSampleRate = sampleRate;
    const binCount = analyser.frequencyBinCount;
    const hzPerBin = sampleRate / 2 / binCount;

    const toRange = ([lo, hi]: readonly [number, number]): [number, number] => [
      THREE.MathUtils.clamp(Math.floor(lo / hzPerBin), 0, binCount - 1),
      THREE.MathUtils.clamp(Math.ceil(hi / hzPerBin), 1, binCount),
    ];

    this.binRanges = {
      low: toRange(BANDS.low),
      lowMid: toRange(BANDS.lowMid),
      mid: toRange(BANDS.mid),
      high: toRange(BANDS.high),
    };

    if (this.spectrum.length !== binCount) this.spectrum = new Uint8Array(binCount);
  }

  private analyse(analyser: AnalyserNode): void {
    this.ensureBins(analyser);
    if (!this.binRanges) return;

    try {
      analyser.getByteFrequencyData(this.spectrum);
    } catch {
      return;
    }

    const bandEnergy = (range: [number, number]): number => {
      let sum = 0;
      for (let i = range[0]; i < range[1]; i++) sum += this.spectrum[i];
      const n = Math.max(1, range[1] - range[0]);
      return sum / n / 255;
    };

    const low = bandEnergy(this.binRanges.low);
    const lowMid = bandEnergy(this.binRanges.lowMid);
    const mid = bandEnergy(this.binRanges.mid);
    const high = bandEnergy(this.binRanges.high);

    const total = low + lowMid + mid + high;
    const { noiseFloor, gain, maxWeight } = this.config;

    if (total < noiseFloor) {
      this.target.openness = 0;
      this.target.a = this.target.i = this.target.u = 0;
      this.target.e = this.target.o = this.target.talk = 0;
      this.envelope *= 0.9;
      return;
    }

    // Openness from broadband energy, curved so quiet speech still moves the
    // mouth a little instead of sitting shut.
    const loudness = THREE.MathUtils.clamp((total / 2) * gain, 0, 1);
    this.envelope = Math.pow(loudness, 0.7);
    this.target.openness = THREE.MathUtils.clamp(this.envelope, 0, 1);

    // Formant proxies, normalised into 0..1.
    const f1 = THREE.MathUtils.clamp(low / (low + lowMid + 1e-5), 0, 1);
    const f2 = THREE.MathUtils.clamp((mid + high) / (total + 1e-5), 0, 1);

    // openVowel: how far the jaw is dropped (a > e > o > i,u)
    // frontVowel: tongue position (i,e front; u,o back)
    const openVowel = THREE.MathUtils.smoothstep(f1, 0.25, 0.75);
    const frontVowel = THREE.MathUtils.smoothstep(f2, 0.12, 0.45);

    // Bilinear blend across the vowel quadrilateral. Weights always sum to 1
    // before scaling, so the mouth never over-drives.
    const a = openVowel * (1 - frontVowel);
    const e = openVowel * frontVowel;
    const o = (1 - openVowel) * (1 - frontVowel) * 0.6;
    const u = (1 - openVowel) * (1 - frontVowel) * 0.4;
    const i = (1 - openVowel) * frontVowel;

    const sum = a + e + o + u + i || 1;
    const scale = (this.envelope * maxWeight) / sum;

    this.target.a = a * scale;
    this.target.e = e * scale;
    this.target.o = o * scale;
    this.target.u = u * scale;
    this.target.i = i * scale;
    // A constant undercurrent of the relaxed talk shape keeps the mouth from
    // looking like it is enunciating every single vowel.
    this.target.talk = this.envelope * 0.25 * maxWeight;
  }

  /** Current weights without advancing the simulation. */
  get weights(): Readonly<VisemeWeights> {
    return this.current;
  }
}


