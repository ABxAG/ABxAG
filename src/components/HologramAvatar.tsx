import { useEffect, useRef } from "react";
import type { LiveState } from "../lib/audio";

/**
 * HologramAvatar — ZORION-style 2D hologram (eye-track + speech animation).
 *
 * A self-contained canvas avatar: no 3D engine, no IPC frame relay, no
 * backend dependency. Eyes track the pointer (with idle wander + blinking);
 * the mouth animates while ABxAG speaks and pulses while listening.
 * Renders at ~40fps (ZORION hologram rate); static single frame under
 * prefers-reduced-motion.
 */

export const HOLO_FPS = 40;
const SIZE = 192;
const FACE = { x: 96, y: 84 };
const EYE_DX = 30;
const EYE_Y = 72;
const EYE_RX = 20;
const EYE_RY = 24;
const PUPIL_R = 7;
const PUPIL_MAX = 9;

/** Clamp a look-vector into the pupil travel circle (normalizes diagonals). */
export function pupilOffset(dx: number, dy: number, max: number = PUPIL_MAX): { x: number; y: number } {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { x: 0, y: 0 };
  const len = Math.hypot(dx, dy);
  if (len <= max || len === 0) return { x: dx, y: dy };
  return { x: (dx / len) * max, y: (dy / len) * max };
}

/** True while a blink is in progress (periodic, short). */
export function isBlinking(tSec: number, periodSec = 3.7, durationSec = 0.12): boolean {
  if (!Number.isFinite(tSec) || periodSec <= 0) return false;
  return tSec % periodSec < durationSec;
}

/** Mouth bar heights (0..1) for the speech visualiser. */
export function mouthBars(connection: LiveState, tSec: number, bars = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    if (connection === "speaking") {
      out.push(0.35 + 0.65 * Math.abs(Math.sin(tSec * 9 + i * 1.1)));
    } else if (connection === "listening") {
      out.push(0.45 + 0.25 * Math.sin(tSec * 3 + i * 0.7));
    } else {
      out.push(0.18);
    }
  }
  return out;
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  connection: LiveState,
  tSec: number,
  look: { x: number; y: number },
): void {
  const speaking = connection === "speaking";
  const listening = connection === "listening";
  const live = speaking || listening;
  const dim = connection === "disconnected" ? 0.45 : 1;

  ctx.clearRect(0, 0, SIZE, SIZE);

  // Hologram core glow.
  const core = ctx.createRadialGradient(FACE.x, FACE.y, 8, FACE.x, FACE.y, 86);
  core.addColorStop(0, `rgba(34,211,238,${0.22 * dim})`);
  core.addColorStop(1, "rgba(34,211,238,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Scan sweep.
  const sweepY = (tSec * 34) % (SIZE + 40) - 20;
  const sweep = ctx.createLinearGradient(0, sweepY - 14, 0, sweepY + 14);
  sweep.addColorStop(0, "rgba(34,211,238,0)");
  sweep.addColorStop(0.5, `rgba(34,211,238,${0.10 * dim})`);
  sweep.addColorStop(1, "rgba(34,211,238,0)");
  ctx.fillStyle = sweep;
  ctx.fillRect(0, sweepY - 14, SIZE, 28);

  // Eyes.
  const blink = isBlinking(tSec);
  const pupil = pupilOffset(look.x, look.y);
  for (const side of [-1, 1]) {
    const ex = FACE.x + side * EYE_DX;
    ctx.save();
    if (blink) {
      ctx.strokeStyle = `rgba(224,254,255,${0.9 * dim})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ex - EYE_RX + 4, EYE_Y);
      ctx.lineTo(ex + EYE_RX - 4, EYE_Y);
      ctx.stroke();
    } else {
      // Eye white (hologram style: faint shell).
      ctx.strokeStyle = `rgba(165,243,252,${0.55 * dim})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(ex, EYE_Y, EYE_RX, EYE_RY, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Pupil + glint, tracking the pointer.
      const px = ex + pupil.x;
      const py = EYE_Y + pupil.y;
      ctx.fillStyle = speaking ? `rgba(34,211,238,${0.95 * dim})` : `rgba(224,254,255,${0.9 * dim})`;
      ctx.shadowColor = "rgba(34,211,238,0.9)";
      ctx.shadowBlur = speaking ? 14 : 8;
      ctx.beginPath();
      ctx.arc(px, py, PUPIL_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = `rgba(255,255,255,${0.9 * dim})`;
      ctx.beginPath();
      ctx.arc(px - 2.5, py - 2.5, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Mouth.
  const my = 128;
  if (speaking) {
    const bars = mouthBars(connection, tSec);
    ctx.fillStyle = `rgba(34,211,238,${0.85 * dim})`;
    ctx.shadowColor = "rgba(34,211,238,0.8)";
    ctx.shadowBlur = 8;
    bars.forEach((h, i) => {
      const bw = 7;
      const bh = 4 + h * 22;
      const bx = FACE.x + (i - (bars.length - 1) / 2) * 12 - bw / 2;
      ctx.fillRect(bx, my - bh / 2, bw, bh);
    });
    ctx.shadowBlur = 0;
  } else if (listening) {
    const pulse = 0.5 + 0.5 * Math.sin(tSec * 3);
    ctx.strokeStyle = `rgba(52,211,153,${(0.5 + 0.4 * pulse) * dim})`;
    ctx.lineWidth = 3;
    ctx.shadowColor = "rgba(52,211,153,0.8)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(FACE.x, my - 6, 20, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    ctx.shadowBlur = 0;
  } else {
    ctx.strokeStyle = `rgba(148,197,255,${0.5 * dim})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(FACE.x - 16, my);
    ctx.lineTo(FACE.x + 16, my);
    ctx.stroke();
  }

  // Scanlines.
  ctx.fillStyle = `rgba(0,0,0,${0.16})`;
  for (let y = 0; y < SIZE; y += 4) ctx.fillRect(0, y, SIZE, 1);

  // Status ring.
  ctx.strokeStyle = live ? `rgba(34,211,238,${0.5 * dim})` : `rgba(100,116,139,${0.4 * dim})`;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.lineDashOffset = -tSec * (live ? 26 : 6);
  ctx.beginPath();
  ctx.arc(FACE.x, FACE.y + 8, 88, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function HologramAvatar({ connection }: { connection: LiveState }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lookRef = useRef({ x: 0, y: 0 });
  const targetRef = useRef({ x: 0, y: 0 });

  // Pointer eye-tracking (overlay-local) + idle wander fallback.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: PointerEvent) => {
      try {
        const rect = canvas.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height * 0.4;
        const scale = SIZE / Math.max(1, rect.width);
        targetRef.current = {
          x: Math.max(-22, Math.min(22, (e.clientX - cx) * scale * 0.35)),
          y: Math.max(-18, Math.min(18, (e.clientY - cy) * scale * 0.35)),
        };
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.scale(dpr, dpr);
    const t0 = performance.now();
    const tick = () => {
      const tSec = (performance.now() - t0) / 1000;
      // Ease pupils toward target; wander when the pointer is stale.
      const wander = {
        x: Math.sin(tSec * 0.6) * 7,
        y: Math.cos(tSec * 0.45) * 5,
      };
      const k = 0.12;
      lookRef.current.x += (targetRef.current.x + wander.x * 0.3 - lookRef.current.x) * k;
      lookRef.current.y += (targetRef.current.y + wander.y * 0.3 - lookRef.current.y) * k;
      drawFrame(ctx, connection, tSec, lookRef.current);
    };
    if (reduced) {
      drawFrame(ctx, connection, 1.0, { x: 0, y: 0 });
      return undefined;
    }
    tick();
    const timer = window.setInterval(tick, 1000 / HOLO_FPS);
    return () => window.clearInterval(timer);
  }, [connection]);

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      role="img"
      aria-label={connection === "speaking" ? "ABxAG speaking hologram" : connection === "listening" ? "ABxAG listening hologram" : "ABxAG idle hologram"}
      className="h-20 w-20 rounded-xl border border-cyan-300/25 bg-black/40"
      style={{ width: 80, height: 80 }}
    />
  );
}
