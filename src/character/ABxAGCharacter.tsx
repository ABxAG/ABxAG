/**
 * React host for the 3D character.
 *
 * Owns the canvas and the CharacterSystem lifecycle, and forwards application
 * state into the render loop. Deliberately re-renders as little as possible:
 * per-frame data is pushed through a ref into the running loop rather than
 * through React state, so the animation never depends on React's scheduler.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, TriangleAlert } from 'lucide-react';
import { CharacterSystem } from './core/CharacterSystem';
import { applyStageCommand, isStageCommand, targetMatches } from './applyStageCommand';
import { setCharacterRealism } from './materials/AnimeMaterial';
import { NO_CHARACTER, resolveCharacter } from './config/registry';
import { qualityProfile, reportGraphicsTrouble, withQuality } from './core/quality';
import type { CharacterActivity } from './behaviour/behaviours';

export interface ABxAGCharacterProps {
  /** Which character to display. Defaults to the registry default. */
  characterId?: string;
  /** What she is currently doing, which drives gaze and behaviour selection. */
  activity: CharacterActivity;
  /** Emotional expression to hold. */
  emotion: string;
  /** ABxAG's voice output, used for lip sync. */
  outputAnalyser: AnalyserNode | null;
  /** The user's microphone, used for listening reactions. */
  inputAnalyser: AnalyserNode | null;
  className?: string;
  /**
   * Enable the WASD / Q / E / L / F / R / 1-4 camera and gaze controls.
   * Defaults on; turn it off if the host app needs those keys.
   */
  controlsEnabled?: boolean;
  /** Show the on-screen control hint overlay. */
  showControlHint?: boolean;
  /** Reflected-highlight scale from 0 (matte) to 2 (strong). Defaults to 1. */
  reflectionStrength?: number;
  /** Receives the live system once loaded (and null on unload), for editors. */
  onSystem?: (system: CharacterSystem | null) => void;
  /** Drag on her clothes to grab the fabric. Off where the host owns the mouse. */
  clothInteraction?: boolean;
  /** Free the character while the page is hidden (default on; off for the desktop companion). */
  unloadWhenHidden?: boolean;
  /** Main screen only: in Potato mode with the desktop companion on, skip this copy. */
  desktopOnlyWhenPotato?: boolean;
}

/** Apply the renderer-relevant part of the server settings to a system. */
function applyAppSettings(system: CharacterSystem, settings: { graphics?: { realism?: number }; physics?: { clothEnabled?: boolean; clothLooseness?: number } } | null | undefined): void {
  const realism = Number(settings?.graphics?.realism);
  if (Number.isFinite(realism)) setCharacterRealism(realism);
  const physics = settings?.physics;
  if (physics) {
    system.setClothSettings({
      ...(typeof physics.clothEnabled === 'boolean' ? { enabled: physics.clothEnabled } : {}),
      ...(Number.isFinite(Number(physics.clothLooseness)) ? { looseness: Number(physics.clothLooseness) } : {}),
    });
  }
}

/**
 * Public build, nothing imported yet: the installer ships no character
 * (the models' licences forbid redistribution), so the user brings their own.
 */
const ImportFirstCharacter: React.FC = () => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pick = async () => {
    const bridge = (window as unknown as { abxag?: { pickCharacterSource?: () => Promise<string | null> } }).abxag;
    if (!bridge?.pickCharacterSource) {
      setMessage('Open Settings → Character → Character Studio to import a model.');
      return;
    }
    const source = await bridge.pickCharacterSource();
    if (!source) return;
    setBusy(true);
    setMessage('Importing your character… this can take a minute.');
    try {
      const response = await fetch('/api/characters/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || `Import failed (${response.status}).`);
      await fetch('/api/app-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ character: { activeCharacterId: result.profile.id } }) });
      window.location.reload();
    } catch (error) {
      setBusy(false);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="absolute inset-x-0 top-[16%] z-20 flex justify-center p-4">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-white/10 bg-[#07080d]/90 px-6 py-5 text-center shadow-2xl backdrop-blur-md">
      <div className="font-display text-lg text-white">Bring your character</div>
      <p className="max-w-sm text-xs leading-relaxed text-slate-300">
        ABxAG doesn't come with a 3D model. Import any character you're allowed to use (.pmx/.pmd/.vrm/.glb/.gltf/.fbx/.obj, or a .zip / folder that contains one). It stays on your PC.
      </p>
      <button type="button" disabled={busy} onClick={() => void pick()}
        className="pointer-events-auto rounded-xl border border-cyan-300/40 bg-cyan-400/20 px-5 py-2.5 text-sm font-medium text-cyan-50 hover:bg-cyan-400/30 disabled:opacity-50 cursor-pointer">
        {busy ? 'Importing…' : 'Import my character'}
      </button>
      {message && <p className="max-w-sm text-[11px] text-slate-400">{message}</p>}
      </div>
    </div>
  );
};

/** Potato mode with the desktop companion on: the app window skips its own copy. */
const DESKTOP_ONLY = 'DESKTOP_ONLY';

interface LoadState {
  phase: string;
  ratio: number;
  error: string | null;
}

export const ABxAGCharacter: React.FC<ABxAGCharacterProps> = ({
  characterId,
  activity,
  emotion,
  outputAnalyser,
  inputAnalyser,
  className,
  controlsEnabled = true,
  showControlHint = true,
  reflectionStrength = 1,
  onSystem,
  clothInteraction = true,
  unloadWhenHidden = true,
  desktopOnlyWhenPotato = false,
}) => {
  const onSystemRef = useRef(onSystem);
  onSystemRef.current = onSystem;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const systemRef = useRef<CharacterSystem | null>(null);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);

  const [load, setLoad] = useState<LoadState>({ phase: 'Starting', ratio: 0, error: null });
  const reflectionStrengthRef = useRef(reflectionStrength);
  reflectionStrengthRef.current = reflectionStrength;
  const [viewLocked, setViewLocked] = useState(false);
  const [eyeTracking, setEyeTracking] = useState(false);
  /** Bumped when the GPU drops the WebGL context: the system is rebuilt. */
  const [contextGeneration, setContextGeneration] = useState(0);
  /**
   * While the page is hidden (main window in the tray) the character is
   * unloaded after a short grace period: a loaded PMX with textures, physics
   * and cloth holds hundreds of MB, and the desktop companion already shows
   * her. She is rebuilt as soon as the page is visible again.
   */
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    if (!unloadWhenHidden) return;
    let timer = 0;
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (document.hidden) timer = window.setTimeout(() => setSuspended(true), 20_000);
      else setSuspended(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [unloadWhenHidden]);

  // ---- system lifecycle ---------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container || suspended) return;

    // The canvas is created per system instance rather than rendered by React.
    // A WebGLRenderer takes ownership of its canvas' GL context, so reusing one
    // canvas across mounts means a second renderer inherits a context whose
    // programs the first renderer already disposed - which silently corrupts
    // shader compilation. React StrictMode mounts twice in development, so this
    // is the normal path, not an edge case.
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 w-full h-full';
    canvas.style.opacity = '0';
    canvas.style.transition = 'opacity 1s ease';
    container.appendChild(canvas);
    canvasElRef.current = canvas;

    // The GPU can drop a WebGL context (driver reset, another app hogging
    // VRAM, sleep/resume). Rebuild the whole character on a fresh canvas
    // instead of leaving a blank or frozen window.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      console.warn('[ABxAGCharacter] WebGL context lost; rebuilding');
      // Usually the GPU ran out of memory: Auto quality asks for less next time.
      reportGraphicsTrouble();
      window.setTimeout(() => setContextGeneration((n) => n + 1), 1_000);
    };
    canvas.addEventListener('webglcontextlost', onContextLost, false);

    let cancelled = false;
    let system: CharacterSystem | null = null;
    setLoad({ phase: 'Resolving character', ratio: 0, error: null });

    // Settings first: graphics quality decides resolution, anti-aliasing and
    // shadow size, which are fixed when the GPU context is created.
    const settingsReady = fetch('/api/app-settings')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    Promise.all([resolveCharacter(characterId), settingsReady])
      .then(([{ config, profile }, appSettings]) => {
        if (cancelled) return;
        const quality = qualityProfile(appSettings?.graphics?.quality, appSettings?.graphics?.autoStep);
        // Potato PC: with the desktop companion on, draw her only once (on
        // the desktop); the app window shows a note instead of a 2nd copy.
        if (quality.level === 'potato' && desktopOnlyWhenPotato && appSettings?.companion?.enabled) {
          setLoad({ phase: 'Ready', ratio: 1, error: DESKTOP_ONLY });
          return;
        }
        system = new CharacterSystem({
          canvas,
          config: withQuality(config, quality),
          profile,
          quality,
          onProgress: (phase, ratio) => {
            if (!cancelled) setLoad({ phase, ratio, error: null });
          },
          onError: (error) => {
            console.error('[ABxAGCharacter]', error);
            if (!cancelled) setLoad((prev) => ({ ...prev, error: error.message }));
          },
        });
        systemRef.current = system;
        // Dev-only handle for inspecting the live character from the console.
        if (import.meta.env.DEV) {
          (window as unknown as { __abxag?: CharacterSystem }).__abxag = system;
        }
        system.resize(container.clientWidth, container.clientHeight);
        // Realism and cloth are server settings so every window renders alike.
        applyAppSettings(system, appSettings);
        return system.load().then(() => {
          if (cancelled || !system) return;
          system.setReflectionStrength(reflectionStrengthRef.current);
          system.start();
          onSystemRef.current?.(system);
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setLoad((prev) => ({ ...prev, error: message }));
      });

    return () => {
      cancelled = true;
      systemRef.current = null;
      onSystemRef.current?.(null);
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      system?.dispose();
      canvas.remove();
      if (canvasElRef.current === canvas) canvasElRef.current = null;
    };
  }, [characterId, contextGeneration, suspended]);

  // Fade the canvas in once the character is ready to be seen.
  useEffect(() => {
    const canvas = canvasElRef.current;
    if (canvas) canvas.style.opacity = load.ratio >= 1 && !load.error ? '1' : '0';
  }, [load.ratio, load.error]);

  // ---- responsive sizing --------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      systemRef.current?.resize(width, height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Live settings changes from the main window (Settings panel).
  useEffect(() => {
    const onSettings = (event: Event) => {
      const system = systemRef.current;
      if (system) applyAppSettings(system, (event as CustomEvent).detail);
    };
    window.addEventListener('abxag:app-settings', onSettings);
    return () => window.removeEventListener('abxag:app-settings', onSettings);
  }, []);

  // Stage directions from voice/tools ("jump", "dress red", …) via
  // useAppEvents → window event. Switches are handled by the host App.
  // Commands targeted at the companion doll are ignored here.
  useEffect(() => {
    const onCommand = (event: Event) => {
      const system = systemRef.current;
      const cmd = (event as CustomEvent).detail as unknown;
      if (!isStageCommand(cmd) || !targetMatches(cmd, 'stage')) return;
      applyStageCommand(system, cmd);
    };
    window.addEventListener('abxag:character-command', onCommand);
    return () => window.removeEventListener('abxag:character-command', onCommand);
  }, []);

  // ---- grab her clothes ----------------------------------------------------
  // Press on the fabric and drag: the cloth is pulled (within its slack - it
  // stays on her) and swings back when released.
  useEffect(() => {
    const container = containerRef.current;
    if (!clothInteraction || !container) return;
    let grabbing = false;
    const ndc = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      return { x: ((event.clientX - rect.left) / rect.width) * 2 - 1, y: -(((event.clientY - rect.top) / rect.height) * 2 - 1) };
    };
    const onDown = (event: PointerEvent) => {
      const system = systemRef.current;
      if (event.button !== 0 || !system) return;
      const { x, y } = ndc(event);
      if (!system.grabClothAt(x, y)) return;
      grabbing = true;
      container.setPointerCapture?.(event.pointerId);
      container.style.cursor = 'grabbing';
      event.preventDefault();
    };
    const onMove = (event: PointerEvent) => {
      if (!grabbing) return;
      const { x, y } = ndc(event);
      systemRef.current?.dragClothTo(x, y);
    };
    const onUp = () => {
      if (!grabbing) return;
      grabbing = false;
      container.style.cursor = '';
      systemRef.current?.releaseCloth();
    };
    container.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      container.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [clothInteraction]);

  // ---- pointer parallax + eye tracking ------------------------------------
  const handlePointerMove = useCallback((event: PointerEvent) => {
    const x = (event.clientX / window.innerWidth) * 2 - 1;
    const y = -((event.clientY / window.innerHeight) * 2 - 1);
    systemRef.current?.setPointer(x, y);
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, [handlePointerMove]);

  // ---- camera + gaze keyboard controls ------------------------------------
  //
  // WASD orbits freely (so any angle, including her back and either side),
  // Q/E dolly, L locks the view in place, F toggles eye tracking, R resets,
  // and 1-4 snap to fixed viewpoints. Held keys are integrated per frame so
  // movement is smooth rather than key-repeat steppy.
  useEffect(() => {
    if (!controlsEnabled) return;
    const held = new Set<string>();
    let raf = 0;
    let last = performance.now();

    const ORBIT_SPEED = 1.9; // radians per second
    const ZOOM_SPEED = 14; // model units per second

    const step = () => {
      raf = requestAnimationFrame(step);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      const system = systemRef.current;
      if (!system) return;

      let yaw = 0;
      let pitch = 0;
      if (held.has('a')) yaw -= ORBIT_SPEED * dt;
      if (held.has('d')) yaw += ORBIT_SPEED * dt;
      if (held.has('w')) pitch += ORBIT_SPEED * 0.6 * dt;
      if (held.has('s')) pitch -= ORBIT_SPEED * 0.6 * dt;
      if (yaw || pitch) system.orbitBy(yaw, pitch);

      let zoom = 0;
      if (held.has('q')) zoom += ZOOM_SPEED * dt;
      if (held.has('e')) zoom -= ZOOM_SPEED * dt;
      if (zoom) system.zoomBy(zoom);
    };
    raf = requestAnimationFrame(step);

    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const system = systemRef.current;
      if (!system) return;

      if ('wasdqe'.includes(key)) {
        held.add(key);
        event.preventDefault();
        return;
      }

      switch (key) {
        case 'l':
          system.setViewLocked(!system.isViewLocked);
          setViewLocked(system.isViewLocked);
          break;
        case 'f':
          system.setEyeTracking(!system.isEyeTracking);
          setEyeTracking(system.isEyeTracking);
          break;
        case 'r':
          system.resetView();
          break;
        case '1':
          system.setView('front');
          break;
        case '2':
          system.setView('threeQuarter');
          break;
        case '3':
          system.setView('right');
          break;
        case '4':
          system.setView('back');
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    const onKeyUp = (event: KeyboardEvent) => held.delete(event.key.toLowerCase());
    // Held keys must not stick if the window loses focus mid-press.
    const onBlur = () => held.clear();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [controlsEnabled]);

  // ---- pause while hidden -------------------------------------------------
  // A desktop companion should not burn GPU while its window is in the
  // background.
  useEffect(() => {
    const onVisibility = () => {
      const system = systemRef.current;
      if (!system?.isLoaded) return;
      if (document.hidden) system.stop();
      else system.start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // ---- per-frame inputs ---------------------------------------------------
  useEffect(() => {
    systemRef.current?.setFrameInput({ activity, emotion, outputAnalyser, inputAnalyser });
  }, [activity, emotion, outputAnalyser, inputAnalyser]);

  useEffect(() => {
    systemRef.current?.setReflectionStrength(reflectionStrength);
  }, [characterId, reflectionStrength]);

  const toggleViewLock = () => {
    const system = systemRef.current;
    if (!system) return;
    system.setViewLocked(!system.isViewLocked);
    setViewLocked(system.isViewLocked);
  };

  const toggleEyeTracking = () => {
    const system = systemRef.current;
    if (!system) return;
    system.setEyeTracking(!system.isEyeTracking);
    setEyeTracking(system.isEyeTracking);
  };

  const selectView = (view: 'front' | 'threeQuarter' | 'right' | 'back') => {
    systemRef.current?.setView(view);
  };

  const ready = load.ratio >= 1 && !load.error;

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full overflow-hidden ${className ?? ''}`}
    >
      {/* The WebGL canvas is appended imperatively by the effect above. */}

      {!ready && !load.error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <Sparkles className="text-cyan-400 animate-pulse" size={28} />
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-200/70">
            {load.phase}
          </div>
          <div className="h-px w-40 bg-white/10 overflow-hidden rounded-full">
            <div
              className="h-full bg-cyan-400/70 transition-[width] duration-300"
              style={{ width: `${Math.round(load.ratio * 100)}%` }}
            />
          </div>
        </div>
      )}

      {ready && controlsEnabled && showControlHint && (
        <div className="absolute bottom-3 right-3 z-40 flex flex-col items-end gap-1.5 select-none">
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={toggleViewLock}
              aria-pressed={viewLocked}
              title="Lock or unlock the current camera view (L)"
              className={`px-2 py-0.5 rounded-md border text-[9px] font-mono tracking-widest uppercase transition ${
                viewLocked
                  ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                  : 'border-white/10 bg-white/5 text-slate-400 hover:border-amber-400/40 hover:text-amber-200'
              }`}
            >
              {viewLocked ? 'View locked' : 'View free'}
            </button>
            <button
              type="button"
              onClick={toggleEyeTracking}
              aria-pressed={eyeTracking}
              title="Toggle eyes following the mouse (F)"
              className={`px-2 py-0.5 rounded-md border text-[9px] font-mono tracking-widest uppercase transition ${
                eyeTracking
                  ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                  : 'border-white/10 bg-white/5 text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200'
              }`}
            >
              {eyeTracking ? 'Eyes tracking' : 'Eyes auto'}
            </button>
          </div>
          <div className="flex gap-1 pointer-events-auto">
            {(
              [
                ['Front', 'front'],
                ['¾', 'threeQuarter'],
                ['Side', 'right'],
                ['Back', 'back'],
              ] as const
            ).map(([label, view]) => (
              <button
                key={view}
                type="button"
                onClick={() => selectView(view)}
                disabled={viewLocked}
                title={`${label} camera preset`}
                className="min-w-9 px-1.5 py-0.5 rounded border border-white/10 bg-slate-950/60 text-[9px] font-mono uppercase tracking-wider text-slate-400 transition hover:border-fuchsia-400/40 hover:text-fuchsia-200 disabled:cursor-not-allowed disabled:opacity-35"
              >
                {label}
              </button>
            ))}
          </div>
          <div className="pointer-events-none px-2.5 py-1 rounded-md border border-white/5 bg-slate-950/50 backdrop-blur-sm text-[9px] font-mono tracking-wider text-slate-500">
            WASD rotate · Q/E zoom · L lock · F eyes · R reset · 1-4 views
          </div>
        </div>
      )}

      {load.error === NO_CHARACTER && <ImportFirstCharacter />}

      {load.error === DESKTOP_ONLY && (
        <div className="pointer-events-none absolute inset-x-0 top-[22%] flex justify-center p-4">
          <p className="rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-center text-[11px] text-slate-400">
            Potato PC mode: she is on your desktop. (Settings → Character → Graphics quality)
          </p>
        </div>
      )}

      {load.error && load.error !== NO_CHARACTER && load.error !== DESKTOP_ONLY && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <TriangleAlert className="text-amber-400" size={26} />
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber-200/80">
            Character failed to load
          </div>
          <p className="max-w-sm text-xs text-slate-400 leading-relaxed">{load.error}</p>
        </div>
      )}
    </div>
  );
};


