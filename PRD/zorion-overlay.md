# PRD: ZORION-style interactive overlay for ABxAG

## Problem
ZORION (`D:\ZORION`) has an always-on-top interactive widget dashboard
(status, mic, task, hologram, system, clock, emergency, conversation, quick +
`Ctrl+Alt+O`). ABxAG only has a non-interactive neon cursor overlay plus
in-app panels — nothing floating, interactive, and always visible.

## Proposal
Add a fully interactive HUD overlay window (Electron shell) with the same
9 widgets, mapped to ABxAG systems. Avatar widget mirrors the **loaded 3D
character** (live low-fps canvas relay, no second three.js instance).
All controls live in **Settings → Overlay** (default OFF, ZORION parity),
toggle hotkey `Ctrl+Alt+O`.

## Scope
- Shell: `electron/hud-overlay.cjs` + `main.cjs` wiring (show/hide,
  fullscreen hide, opacity, IPC relays).
- Renderer: `src/components/HudOverlay.tsx` (`?hud=1` standalone root) +
  main-window sync hook + `preserveDrawingBuffer` for avatar capture.
- Settings: server-side `overlay` block + Settings → Overlay section.
- Tests: `tests/overlaySettings.test.ts`.

## Non-goals
No ZORION brain/voice/memory port; no new backend endpoints; no hotkey
editing UI; virtual-cursor overlay untouched.
