import { useEffect, useState } from "react";
import { motion } from "motion/react";

declare const __APP_VERSION__: string;

// The kernel line shows the real build version, not a frozen era. The constant
// is injected at build time by vite.config.ts (package.json version).
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__ ? __APP_VERSION__ : "";

const BOOT_LINES = [
  `ABxAG kernel ${APP_VERSION.startsWith("v") ? APP_VERSION : `v${APP_VERSION}`} … online`,
  "holographic stage … materialized",
  "neural link … established",
  "voice grid … listening",
  "memory core … restored",
];

const LINE_MS = 260;
const HOLD_MS = 700;

export function BootSequence({ onDone }: { onDone: () => void }) {
  const [visible, setVisible] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDone();
      return;
    }
    if (visible < BOOT_LINES.length) {
      const t = window.setTimeout(() => setVisible((v) => v + 1), LINE_MS);
      return () => window.clearTimeout(t);
    }
    const hold = window.setTimeout(() => {
      setLeaving(true);
      window.setTimeout(onDone, 420);
    }, HOLD_MS);
    return () => window.clearTimeout(hold);
  }, [visible, onDone]);

  useEffect(() => {
    const skip = () => {
      setLeaving(true);
      window.setTimeout(onDone, 180);
    };
    const onKey = () => skip();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  return (
    <motion.div
      role="status"
      aria-label="ABxAG is starting"
      onClick={() => {
        setLeaving(true);
        window.setTimeout(onDone, 180);
      }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[#020205]/95 backdrop-blur-md cursor-pointer"
      initial={{ opacity: 1 }}
      animate={{ opacity: leaving ? 0 : 1 }}
      transition={{ duration: 0.35 }}
    >
      <div className="absolute inset-0 pointer-events-none cyber-scanlines opacity-60" />
      <div className="w-[min(480px,86vw)] font-mono text-sm">
        <div className="mb-5 flex items-center gap-3">
          <span className="text-lg font-bold tracking-[0.45em] text-white neon-text-cyan">
            ABxAG
          </span>
          <span className="h-px flex-1 bg-gradient-to-r from-cyan-400/60 to-transparent" />
        </div>
        <div className="space-y-2 min-h-[10.5rem]">
          {BOOT_LINES.slice(0, visible).map((line) => (
            <motion.p
              key={line}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.22 }}
              className="text-cyan-200/90 tracking-wide"
            >
              <span className="mr-2 text-emerald-400">▸</span>
              {line}
            </motion.p>
          ))}
          {visible >= BOOT_LINES.length && (
            <motion.p
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              className="pt-2 text-base font-bold tracking-[0.25em] text-white neon-text-cyan"
            >
              SYSTEM ONLINE
            </motion.p>
          )}
        </div>
        <div className="mt-6 h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-violet-400 to-cyan-400 animate-boot-bar"
            style={{ width: `${Math.round((visible / BOOT_LINES.length) * 100)}%` }}
          />
        </div>
        <p className="mt-4 text-center text-[11px] tracking-[0.2em] text-white/30">
          CLICK OR PRESS ANY KEY TO SKIP
        </p>
      </div>
    </motion.div>
  );
}
