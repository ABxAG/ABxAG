# Plan: zorion-overlay

## Steps (in order)

1. **Server settings** (`settings/appSettings.ts`): add `overlay` block to the
   `AppSettings` interface + `DEFAULT_APP_SETTINGS` + `normalizeSettings`
   (clamp opacity 0.4–1, validate hotkey regex, bool-coerce widgets) — mirror
   the `autonomy.virtualCursorEnabled` pattern. Mirror the type in
   `src/lib/appApi.ts` (`AppSettings` + patch type).
2. **Tests** (`tests/overlaySettings.test.ts`, mirror
   `virtualCursorSetting.test.ts`): defaults OFF for old files, patch
   round-trip, rejection of bad types, widget defaults all-true. Register in
   `package.json` `test:agent` script.
3. **Shell window** (`electron/hud-overlay.cjs`, new; structure mirrors
   `virtual-cursor.cjs`): `createHudOverlay(origin)` loads
   `SERVER_ORIGIN + '?hud=1'`; `destroyHudOverlay`, `setHudVisible`,
   `applyHudSettings` (opacity, alwaysOnTop, compact/full size, click-through
   flag); fullscreen auto-hide reusing companion's detection; `Ctrl+Alt+O`
   registration in `main.cjs` `startShell()` (conflict-safe) + apply in
   `applyShellSettings`; `hud:sync` relay (main window → overlay) and
   `hud:backend` relay (overlay → `sendToBackend`); destroy on quit.
4. **Renderer HUD** (`src/components/HudOverlay.tsx`, new): standalone root
   rendered by `App.tsx` when `?hud=1` (no main UI in that window). 9 widget
   subcomponents, 2–4s HTTP polling (`/api/config`, `/api/agent-health`,
   `/api/virtual-cursor`, `/api/goals`, `/api/cognition/status`), clock local,
   relay state via `window.require('electron').ipcRenderer` (same
   `nodeIntegration` posture as the virtual-cursor overlay). Compact mode
   renders status + avatar + emergency only.
5. **Main-window sync** (`App.tsx` + character canvas): `useHudSync` hook —
   every ~500ms POSTs `{ connection, notices tail }` and every ~2fps an
   avatar JPEG via `ipcRenderer.send('hud:sync', …)` (Electron only,
   no-op in browser dev). Enable `preserveDrawingBuffer: true` where the
   character WebGLRenderer is created.
6. **Settings UI** (`SettingsPanel.tsx`): `SettingsSection "overlay"`,
   SECTIONS entry + section panel (master switch, compact, always-on-top,
   hide-in-fullscreen, click-through, opacity choice, 9 widget toggles,
   hotkey display row).
7. **Verify**: `npm run lint`, `node --check` touched `.cjs`, full
   `test:agent` + `test:characters` + `test:python`, dev smoke per spec §6,
   PR via the standing routine (HANDOFF §6). No release bump.

## Risks

- Avatar capture blank without `preserveDrawingBuffer` → step 5 makes it
  explicit; overlay shows the character portrait fallback until the first
  frame arrives.
- `Ctrl+Alt+O` taken by another app → warn in console, Settings still
  toggles the window (same graceful pattern as emergency shortcut).
- Extra polling load → widgets share one 3s interval, paused when hidden.
