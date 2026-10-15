import type { CSSProperties } from "react";
import { accentGlow } from "../lib/cyberpunk";

/**
 * CyberFrame — futuristic HUD frame overlay for the assistant window:
 * corner brackets, hairline borders, vignette, drifting grid.
 * Reuses the existing `.cyber-scanlines` utility from the PR #19 motion
 * system. Purely decorative: pointer-transparent, aria-hidden.
 */
export function CyberFrame({ accent }: { accent: string }) {
  const edge: CSSProperties = {
    ["--cyber-glow" as string]: accentGlow(accent),
  };
  return (
    <div aria-hidden="true" className="cyber-frame pointer-events-none absolute inset-0 z-40" style={edge}>
      <div className="cyber-hline cyber-hline-top" />
      <div className="cyber-hline cyber-hline-bottom" />
      <span className="cyber-corner cyber-tl" />
      <span className="cyber-corner cyber-tr" />
      <span className="cyber-corner cyber-bl" />
      <span className="cyber-corner cyber-br" />
      <div className="cyber-scanlines opacity-40" />
      <div className="cyber-vignette" />
      <div className="cyber-frame-grid" />
    </div>
  );
}
