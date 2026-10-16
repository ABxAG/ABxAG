# Spec: zorion-overlay (ZORION-style interactive HUD overlay)

Source: `D:\ZORION\_internal\config.default.yaml` (`overlay:` + `hologram:` +
`ui.hotkey_overlay`). ZORION is a PySide6/Qt desktop assistant; its QML is
compiled into the exe, so this spec re-implements the documented behaviour
natively in ABxAG (Electron + React) instead of porting code.

## 1. Goal

A **fully interactive, always-on-top HUD overlay window** (ZORION parity).
(The old non-interactive neon virtual-cursor overlay was removed entirely —
see `../dual-cursor-removal/`.)

## 2. Behaviour (ZORION parity, ABxAG-mapped)

- Separate `BrowserWindow`: frameless, `alwaysOnTop` (`screen-saver` level),
  `skipTaskbar`,movable/resizable by the user; **interactive** (`clickThrough:
  false` default).
- **9 widgets**, each independently toggleable, polling only while visible:
  `status` (backend `:47130` + agent `:8765` health/tools count),
  `mic` (voice LiveState relayed from the main window),
  `task` (`/api/tasks` active tasks with pause/stop),
  `avatar` (**live mirror of the loaded 3D character**, see §4),
  `system` (backend/agent round-trip latency + catalogue counts, no new endpoint),
  `clock` (local time, no polling),
  `emergency` (one-click emergency stop → same `shortcut.emergency-stop`
  backend message as `Ctrl+Alt+Shift+S`),
  `conversation` (recent notices relayed from the main window, no new endpoint),
  `quick` (ZORION's 4 quick actions mapped to existing backend messages).
- `compact` mode: collapses to status + avatar + emergency only.
- `hideInFullscreen`: overlay auto-hides while a fullscreen app is foreground
  (reuse companion's fullscreen detection), restores after.
- `opacity` 0.4–1.0 (default 0.94, ZORION value).
- Toggle hotkey **`Control+Alt+O`** (ZORION `ctrl+alt+o`), registered in the
  shell; conflict-safe (warn + keep working if taken, same pattern as the
  emergency shortcut).
- Master switch **default OFF** (ZORION `overlay.enabled: false`).

## 3. Settings (user requirement: inside Settings → Overlay)

New `SettingsSection "overlay"` ("Overlay", `MonitorSmartphone` icon) in
`SettingsPanel`, bound to a new server-side `overlay` block in
`settings/appSettings.ts` (so the Electron shell can read it via
`GET /api/app-settings`, same as `companion`/`autonomy`):

- `enabled` (default false), `alwaysOnTop` (true), `opacity` (0.94),
  `clickThrough` (false), `hideInFullscreen` (true), `compact` (false),
  `hotkey` ("Control+Alt+O", validated like `emergencyShortcut`),
  `widgets` (9 booleans, all default true).
- Old settings files (no `overlay` key) → defaults; non-boolean/non-number
  patches rejected, previous value kept (same contract as the other
  server-side settings).

## 4. Avatar = ZORION-style 2D hologram (user requirement, revised)

The 3D-canvas-mirror design was dropped after live repro proved the
main-window → IPC frame relay never delivers reliably (potato mode skips the
main character copy; capture timing + IPC size are fragile).
Instead: `HologramAvatar` — a self-contained 40fps canvas avatar rendered
locally in the overlay (ZORION `hologram.fps: 40` parity). Eyes track the
pointer (idle wander + blinking); the mouth animates while speaking and
pulses while listening (ZORION `eye_tracking` + `speech_animation`
equivalents). No 3D engine, no IPC pixels, no backend dependency; static
frame under prefers-reduced-motion.

## 5. Non-goals

- No port of ZORION's brain/voice/memory (Groq, llama-server, whisper-vulkan).
- No QML/Qt; no new backend endpoints (overlay reuses existing HTTP + the
  existing backend-message channel via `hud:backend` IPC).
- No editable hotkey UI (display only; same as emergency shortcut today).
- No Linux behaviour change (overlay is shell-level; on non-win32 the agent
  part is already skipped — overlay window itself is platform-neutral
  Electron and follows the `enabled` flag).

## 6. Acceptance

- `npm run lint` clean; `node --check` on new/changed `.cjs`.
- New `tests/overlaySettings.test.ts` green + registered in `test:agent`.
- Dev smoke (`npm run dev` + Electron): Overlay OFF by default; ON →
  window appears, widgets populate, `Ctrl+Alt+O` toggles, hologram avatar
  renders with eye-track + speech anim, emergency button stops tasks,
  fullscreen hides it, Settings → Overlay persists across restart.
