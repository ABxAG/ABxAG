/**
 * Standalone character preview harness.
 *
 * Mounts the character on its own, with controls for activity and emotion and
 * a synthetic speech source for exercising lip sync. Runs without the Gemini
 * session, so the character can be tuned and reviewed without an API key,
 * microphone access, or any of the app shell.
 *
 *   npx vite --config vite.config.ts   ->  /character-preview.html
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { ABxAGCharacter } from '../ABxAGCharacter';
import type { CharacterActivity } from '../behaviour/behaviours';
import { listCharacters, listAllCharacters, DEFAULT_CHARACTER_ID } from '../config/registry';

const ACTIVITIES: CharacterActivity[] = ['idle', 'listening', 'thinking', 'talking'];
const EMOTIONS = [
  'idle', 'happy', 'excited', 'curious', 'thinking',
  'proud', 'sad', 'confused', 'surprised', 'embarrassed', 'playful',
];

/**
 * Synthesises a voice-like signal so lip sync can be exercised offline.
 * Two formant-ish bandpass-filtered noise bursts, gated by a speech-rate
 * envelope, produce a spectrum close enough to speech to drive the visemes.
 */
function useSyntheticSpeech(active: boolean): AnalyserNode | null {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!active) {
      setAnalyser(null);
      return;
    }

    const ctx = new AudioContext();
    ctxRef.current = ctx;

    // Noise source.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    // Two sweeping formants.
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 700;
    f1.Q.value = 6;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1800;
    f2.Q.value = 8;

    // Syllable-rate amplitude gate.
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4.2;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    lfo.connect(lfoGain).connect(gate.gain);
    gate.gain.value = 0.5;

    const node = ctx.createAnalyser();
    node.fftSize = 256;
    node.smoothingTimeConstant = 0.7;

    noise.connect(f1).connect(gate);
    noise.connect(f2).connect(gate);
    gate.connect(node);
    // Web Audio only guarantees processing for a graph pulled by an output.
    // Route through a muted sink so the analyser receives changing formants
    // while the preview remains completely silent.
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    node.connect(silentSink).connect(ctx.destination);
    void ctx.resume();

    noise.start();
    lfo.start();

    // Sweep the formants so the estimated vowel keeps changing.
    let raf = 0;
    const t0 = performance.now();
    const sweep = () => {
      const t = (performance.now() - t0) / 1000;
      f1.frequency.value = 500 + Math.sin(t * 1.3) * 320;
      f2.frequency.value = 1500 + Math.sin(t * 0.7 + 1.1) * 900;
      raf = requestAnimationFrame(sweep);
    };
    sweep();

    setAnalyser(node);

    return () => {
      cancelAnimationFrame(raf);
      noise.stop();
      lfo.stop();
      void ctx.close();
      setAnalyser(null);
    };
  }, [active]);

  return analyser;
}

const Preview: React.FC = () => {
  const [activity, setActivity] = useState<CharacterActivity>('idle');
  const [emotion, setEmotion] = useState('idle');
  const [characterId, setCharacterId] = useState(() => new URLSearchParams(location.search).get('character') || DEFAULT_CHARACTER_ID);
  // Built-in plus locally imported characters (needs the ABxAG backend).
  const [characters, setCharacters] = useState(listCharacters());
  useEffect(() => {
    void listAllCharacters().then((all) => setCharacters(all));
  }, []);
  // 50% maps to 1.0, preserving the renderer's carefully tuned default.
  const [shinePercent, setShinePercent] = useState(50);
  const analyser = useSyntheticSpeech(activity === 'talking');

  return (
    <div className="relative w-full h-screen bg-[#070914] text-white overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_34%,rgba(73,88,124,0.28)_0%,rgba(25,31,51,0.18)_34%,rgba(7,9,20,0)_68%)]" />
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-purple-800/18 rounded-full blur-[120px]" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-cyan-800/18 rounded-full blur-[150px]" />

      <ABxAGCharacter
        characterId={characterId}
        activity={activity}
        emotion={emotion}
        outputAnalyser={analyser}
        inputAnalyser={null}
        reflectionStrength={shinePercent / 50}
      />

      <div className="absolute top-4 left-4 z-50 flex flex-col gap-3 p-4 rounded-2xl bg-slate-950/70 border border-white/10 backdrop-blur-xl text-xs font-mono">
        <div className="flex gap-2 items-center">
          <span className="text-slate-500 w-16">CHARACTER</span>
          <select
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1"
          >
            {characters.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-1 items-center flex-wrap max-w-md">
          <span className="text-slate-500 w-16">ACTIVITY</span>
          {ACTIVITIES.map((a) => (
            <button
              key={a}
              onClick={() => setActivity(a)}
              className={`px-2 py-1 rounded border ${
                activity === a
                  ? 'bg-cyan-500/30 border-cyan-400 text-cyan-100'
                  : 'bg-white/5 border-white/10 text-slate-400'
              }`}
            >
              {a}
            </button>
          ))}
        </div>

        <div className="flex gap-1 items-center flex-wrap max-w-md">
          <span className="text-slate-500 w-16">EMOTION</span>
          {EMOTIONS.map((e) => (
            <button
              key={e}
              onClick={() => setEmotion(e)}
              className={`px-2 py-1 rounded border ${
                emotion === e
                  ? 'bg-fuchsia-500/30 border-fuchsia-400 text-fuchsia-100'
                  : 'bg-white/5 border-white/10 text-slate-400'
              }`}
            >
              {e}
            </button>
          ))}
        </div>

        <div className="flex gap-2 items-center">
          <label htmlFor="reflection-shine" className="text-slate-500 w-16">
            SHINE
          </label>
          <input
            id="reflection-shine"
            aria-label="Reflection shine"
            type="range"
            min="0"
            max="100"
            step="1"
            value={shinePercent}
            onInput={(event) => setShinePercent(Number(event.currentTarget.value))}
            title="Controls reflected highlights only, not brightness"
            className="h-1.5 w-44 cursor-pointer accent-cyan-400"
          />
          <output htmlFor="reflection-shine" className="w-9 text-right text-cyan-200">
            {shinePercent}%
          </output>
        </div>
      </div>
    </div>
  );
};

// Cache the root across HMR reloads; createRoot twice on one container warns.
const container = document.getElementById('root')!;
type RootHost = typeof container & { __root?: ReturnType<typeof createRoot> };
const host = container as RootHost;
host.__root ??= createRoot(container);
host.__root.render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>
);


