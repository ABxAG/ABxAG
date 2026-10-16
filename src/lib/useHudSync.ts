import { useEffect, useRef, type RefObject } from "react";
import type { LiveState } from "./audio";
import type { ModelNotice } from "./useAppEvents";

/** Minimal shape of the Electron HUD bridge exposed via preload. */
export interface HudPushBridge {
  pushSync?: (payload: Record<string, unknown>) => void;
}

function hudBridge(): HudPushBridge | null {
  try {
    const w = window as unknown as { abxag?: { hud?: HudPushBridge } };
    return w.abxag?.hud ?? null;
  } catch {
    return null;
  }
}

export interface HudSyncInput {
  connection: LiveState;
  notices: ModelNotice[];
  /** Only push while the overlay is enabled (avoids wasted traffic). */
  enabled: boolean;
  /** Kept for call-site compatibility; unused. */
  systemRef?: RefObject<unknown | null>;
}

/**
 * Main-window side of the HUD overlay relay. Every 2s pushes voice
 * connection state + recent notices. No-ops outside Electron. The hologram
 * avatar renders locally in the overlay, so no pixel capture crosses IPC.
 */
export function useHudSync({ connection, notices, enabled }: HudSyncInput): void {
  const connRef = useRef(connection);
  connRef.current = connection;
  const noticesRef = useRef(notices);
  noticesRef.current = notices;

  useEffect(() => {
    if (!enabled) return;
    const bridge = hudBridge();
    if (!bridge?.pushSync) return; // browser dev: nothing to relay to
    const push = bridge.pushSync.bind(bridge);
    const timer = window.setInterval(() => {
      push({
        connection: connRef.current,
        at: Date.now(),
        notices: noticesRef.current.slice(-5).map((n) => ({
          text: String(n.text ?? n.kind ?? "").slice(0, 160),
          kind: String(n.kind ?? "info"),
        })),
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [enabled]);
}
