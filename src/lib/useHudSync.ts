import { useEffect, useRef, type RefObject } from "react";
import type { LiveState } from "./audio";
import type { ModelNotice } from "./useAppEvents";
import type { CharacterSystem } from "../character/core/CharacterSystem";

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
  /** Ref holding the live character system (wired via onSystem). */
  systemRef: RefObject<CharacterSystem | null>;
  /** Only push while the overlay is enabled (avoids wasted captures). */
  enabled: boolean;
}

/**
 * Main-window side of the HUD overlay relay. Every 2s pushes connection +
 * recent notices; every 4s captures the loaded 3D character canvas
 * (CharacterSystem.captureAvatar) as a small JPEG. No-ops outside Electron.
 */
export function useHudSync({ connection, notices, systemRef, enabled }: HudSyncInput): void {
  const connRef = useRef(connection);
  connRef.current = connection;
  const noticesRef = useRef(notices);
  noticesRef.current = notices;

  useEffect(() => {
    if (!enabled) return;
    const bridge = hudBridge();
    if (!bridge?.pushSync) return; // browser dev: nothing to relay to
    const push = bridge.pushSync.bind(bridge);
    let frames = 0;
    const timer = window.setInterval(() => {
      frames += 1;
      let avatar: string | null = null;
      if (frames % 2 === 0) {
        try {
          avatar = systemRef.current?.captureAvatar(192) ?? null;
        } catch {
          avatar = null;
        }
      }
      push({
        connection: connRef.current,
        at: Date.now(),
        notices: noticesRef.current.slice(-5).map((n) => ({
          text: String(n.text ?? n.kind ?? "").slice(0, 160),
          kind: String(n.kind ?? "info"),
        })),
        ...(avatar ? { avatar } : {}),
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [enabled, systemRef]);
}
