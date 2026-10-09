/**
 * ABxAG's holographic stage.
 *
 * Composites three layers:
 *   0  ambient backdrop glow (CSS)
 *   10 the live 3D character
 *   20 foreground holographic particles (2D canvas)
 *
 * The character itself is entirely owned by `ABxAGCharacter`; this component
 * only handles the surrounding presentation and translates the app's state
 * vocabulary into the character system's.
 */
import React, { useEffect, useMemo, useRef } from "react";
import { ABxAGAudioSession, LiveState } from "../lib/audio";
import { ABxAGCharacter } from "../character/ABxAGCharacter";
import type { CharacterActivity } from "../character/behaviour/behaviours";

export type ABxAGEmotion =
  | "idle"
  | "happy"
  | "excited"
  | "curious"
  | "thinking"
  | "proud"
  | "sad"
  | "confused"
  | "surprised"
  | "embarrassed"
  | "playful";

interface ABxAGCoreVisualizerProps {
  session: ABxAGAudioSession | null;
  state: LiveState;
  themeColor: string;
  activeEmotion?: ABxAGEmotion;
  characterState: "idle" | "thinking" | "talking";
  /** Reflected material highlights, mapped from the user setting (0..2). */
  reflectionStrength?: number;
  /** Character to show (built-in or imported); undefined = default. */
  characterId?: string;
}

/** Cinematic accent colours per theme. */
function getGlowColors(themeColor: string) {
  switch (themeColor) {
    case "violet":
      return { primary: "rgba(147, 51, 234, 1)", secondary: "rgba(192, 38, 211, 0.8)" };
    case "crimson":
      return { primary: "rgba(225, 29, 72, 1)", secondary: "rgba(234, 88, 12, 0.8)" };
    case "emerald":
      return { primary: "rgba(5, 150, 105, 1)", secondary: "rgba(13, 148, 136, 0.8)" };
    case "celestial":
      return { primary: "rgba(2, 132, 199, 1)", secondary: "rgba(8, 145, 178, 0.8)" };
    case "gold":
      return { primary: "rgba(202, 138, 4, 1)", secondary: "rgba(217, 119, 6, 0.8)" };
    case "rose":
      return { primary: "rgba(219, 39, 119, 1)", secondary: "rgba(236, 72, 153, 0.8)" };
    default:
      return { primary: "rgba(34, 211, 238, 1)", secondary: "rgba(79, 70, 229, 0.8)" };
  }
}

export const ABxAGCoreVisualizer: React.FC<ABxAGCoreVisualizerProps> = ({
  session,
  state,
  themeColor,
  activeEmotion = "idle",
  characterState,
  reflectionStrength = 1,
  characterId,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const speechVolumeRef = useRef<number>(0);
  const particlesRef = useRef<
    Array<{ x: number; y: number; speed: number; size: number; opacity: number }>
  >([]);

  // The character listens whenever the mic is live and she is not busy.
  const activity: CharacterActivity = useMemo(() => {
    if (characterState === "talking") return "talking";
    if (characterState === "thinking") return "thinking";
    return state === "listening" ? "listening" : "idle";
  }, [characterState, state]);

  // Mirror state to the desktop companion window (same origin).
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("abxag-character-state");
    channel.postMessage({ activity, emotion: activeEmotion, characterId });
    return () => channel.close();
  }, [activity, activeEmotion, characterId]);

  // Analysers live on the session object and are recreated when it reconnects.
  const outputAnalyser = session?.outputAnalyser ?? null;
  const inputAnalyser = session?.inputAnalyser ?? null;

  // ---- foreground particle overlay ---------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = (canvas.width = canvas.offsetWidth);
    let height = (canvas.height = canvas.offsetHeight);

    const generateParticles = () => {
      const count = Math.min(60, Math.floor(width / 24));
      particlesRef.current = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height + height * 0.1,
        speed: Math.random() * 0.35 + 0.12,
        size: Math.random() * 1.5 + 0.5,
        opacity: Math.random() * 0.6 + 0.2,
      }));
    };
    generateParticles();

    const handleResize = () => {
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
      generateParticles();
    };
    window.addEventListener("resize", handleResize);

    const spectrum = new Uint8Array(64);

    const render = () => {
      ctx.clearRect(0, 0, width, height);
      const colors = getGlowColors(themeColor);

      // Particles react to whichever side of the conversation is active.
      const analyser =
        state === "speaking" ? outputAnalyser : state === "listening" ? inputAnalyser : null;
      let audioLevel = 0;
      if (analyser) {
        try {
          analyser.getByteFrequencyData(spectrum);
          let sum = 0;
          for (let i = 0; i < spectrum.length; i++) sum += spectrum[i];
          audioLevel = sum / spectrum.length;
        } catch {
          /* analyser detached mid-frame */
        }
      }
      speechVolumeRef.current += (audioLevel / 255 - speechVolumeRef.current) * 0.2;

      const scale = Math.max(0.95, Math.min(1.85, height / 440));
      const centerX = width / 2;

      // Volumetric projector beam rising from the stage floor.
      ctx.save();
      const beam = ctx.createLinearGradient(centerX, height * 0.25, centerX, height);
      beam.addColorStop(0, "rgba(0,0,0,0)");
      beam.addColorStop(0.4, colors.primary.replace("1)", "0.03)"));
      beam.addColorStop(0.75, colors.primary.replace("1)", "0.08)"));
      beam.addColorStop(1, colors.secondary.replace("0.8)", "0.18)"));
      ctx.fillStyle = beam;
      const baseX = 280 * scale;
      ctx.beginPath();
      ctx.moveTo(centerX - baseX * 0.35, height - 105);
      ctx.lineTo(centerX + baseX * 0.35, height - 105);
      ctx.lineTo(centerX + baseX * 1.5, height);
      ctx.lineTo(centerX - baseX * 1.5, height);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Rising stardust, excited by speech.
      for (const p of particlesRef.current) {
        p.y -= p.speed * (1 + speechVolumeRef.current * 1.8);
        p.x += Math.sin(p.y * 0.015 + p.size) * 0.4;
        const opacity = p.opacity * Math.max(0, p.y / height);
        if (p.y < height * 0.12) {
          p.y = height + Math.random() * 30;
          p.x = Math.random() * width;
        }
        ctx.fillStyle = colors.primary.replace("1)", `${opacity * 0.45})`);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * scale, 0, Math.PI * 2);
        ctx.fill();
      }

      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [state, themeColor, outputAnalyser, inputAnalyser]);

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      {/* 1. Ambient backlight glow */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
        <div
          className={`w-[500px] h-[500px] rounded-full blur-[140px] opacity-25 bg-gradient-to-tr transition-all duration-1000 ${
            themeColor === "violet"
              ? "from-purple-600/30 to-fuchsia-600/5"
              : themeColor === "crimson"
                ? "from-rose-600/30 to-orange-600/5"
                : themeColor === "emerald"
                  ? "from-emerald-600/30 to-teal-600/5"
                  : themeColor === "celestial"
                    ? "from-sky-600/30 to-cyan-600/5"
                    : themeColor === "gold"
                      ? "from-amber-600/30 to-yellow-600/5"
                      : themeColor === "rose"
                        ? "from-rose-600/30 to-pink-600/5"
                        : "from-indigo-600/30 to-cyan-600/5"
          }`}
        />
      </div>

      {/* 2. The character */}
      <div className="absolute inset-0 z-10">
        <ABxAGCharacter
          desktopOnlyWhenPotato
          characterId={characterId}
          activity={activity}
          emotion={activeEmotion}
          outputAnalyser={outputAnalyser}
          inputAnalyser={inputAnalyser}
          reflectionStrength={reflectionStrength}
        />
      </div>

      {/* 3. Foreground holographic particles */}
      <canvas
        id="abxag-hologram-living-canvas"
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-20"
      />
    </div>
  );
};


