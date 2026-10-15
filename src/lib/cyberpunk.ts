/**
 * cyberpunk.ts — pure helpers for the wave-2 cyberpunk UI layer
 * (CyberFrame glow mapping, CommandDeck accents + log lines).
 * No React, no DOM: fully unit-testable (see tests/cyberpunk.test.ts).
 * Complements src/lib/commandPalette.ts (PR #19) — no shared symbols.
 */

export interface AccentTheme {
  id: string;
  label: string;
  /** Hex glow color used by the HUD frame + deck orb. */
  glow: string;
}

/** Must stay in sync with the theme colors accepted by App (validColors). */
export const ACCENT_THEMES: AccentTheme[] = [
  { id: "violet", label: "Violet", glow: "#8b5cf6" },
  { id: "crimson", label: "Crimson", glow: "#f43f5e" },
  { id: "emerald", label: "Emerald", glow: "#34d399" },
  { id: "celestial", label: "Celestial", glow: "#22d3ee" },
  { id: "gold", label: "Gold", glow: "#fbbf24" },
  { id: "rose", label: "Rose", glow: "#fb7185" },
  { id: "charcoal", label: "Charcoal", glow: "#64748b" },
];

export function accentGlow(themeId: string): string {
  return ACCENT_THEMES.find((t) => t.id === themeId)?.glow ?? "#22d3ee";
}

export interface LogNotice {
  kind: string;
  text: string;
  at: number;
}

/** Render a runtime notice as a single safe string (never an object). */
export function formatLogLine(notice: LogNotice): string {
  const time = new Date(notice.at).toLocaleTimeString([], { hour12: false });
  const kind = String(notice.kind || "sys").toUpperCase().slice(0, 12);
  return `[${time}] ${kind} :: ${String(notice.text ?? "")}`.slice(0, 160);
}

export interface ShortcutHint {
  keys: string;
  action: string;
}

export const SHORTCUTS: ShortcutHint[] = [
  { keys: "Ctrl+K", action: "Command palette" },
  { keys: "Ctrl+Alt+P", action: "Pause / resume AI cursor" },
  { keys: "Ctrl+Alt+Shift+S", action: "Emergency stop everything" },
  { keys: "Esc", action: "Close panels & dialogs" },
];
