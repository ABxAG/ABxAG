# Plan: zorion-overlay

## Steps (in order)

1. **Server settings** (`settings/appSettings.ts`): add `overlay` block to the
   `AppSettings` interface + `DEFAULT_APP_SETTINGS` + `normalizeSettings`
   (clamp opacity 0.4–1, validate hotkey regex, bool-coerce widgets) — same
   validation-helper pattern as the other server-side blocks. Mirror the
   type in `src/lib/appApi.ts` (`AppSettings` + patch type).
2. **Tests** (`tests/overlaySettings.test.ts`, same style as the other
   settings tests): defaults OFF for old files, patch
   round-trip, rejection of bad types, widget defaults all-true. Register in
   `package.json` `test:agent` script.
3. **Shell window** (`electron/hud-overlay.cjs`, new; same frameless
   always-on-top BrowserWindow pattern as the other shell windows):
   `createHudOverlay(origin)` loads
   `SERVER_ORIGIN + '?hud=1'`; `destroyHudOverlay`, `setHudVisible`,
   `applyHudSettings` (opacity, alwaysOnTop, compact/full size, click-through
   flag); fullscreen auto-hide reusing companion's detection; `Ctrl+Alt+O`
   registration in `main.cjs` `startShell()` (conflict-safe) + apply in
   `applyShellSettings`; `hud:sync` relay (main window → overlay) and
   `hud:backend` relay (overlay → `sendToBackend`); destroy on quit.
4. **Renderer HUD** (`src/components/HudOverlay.tsx`, new): standalone root
   rendered by `App.tsx` when `?hud=1` (no main UI in that window). 9 widget
   subcomponents, 3s HTTP polling (`/api/config`, `/api/agent-health`,
   `/api/tasks`, `/api/logs/commands`), clock local, relay state via the
   `abxag.hud` preload bridge (contextIsolation, no nodeIntegration).
   Compact mode renders status + avatar + emergency only.
5. **Main-window sync** (`App.tsx`): `useHudSync` hook — every 2s pushes
   `{ connection, notices tail }` via `ipcRenderer.send('hud:sync', …)`
   (Electron only, no-op in browser dev). Mic widget shows LINK IDLE with a
   staleness note until the relay arrives; conversation falls back to
   `GET /api/logs/commands` (no new endpoint).
6. **Settings UI** (`SettingsPanel.tsx`): `SettingsSection "overlay"`,
   SECTIONS entry + section panel (master switch, compact, always-on-top,
   hide-in-fullscreen, click-through, opacity choice, 9 widget toggles,
   hotkey display row).
7. **Verify**: `npm run lint`, `node --check` touched `.cjs`, full
   `test:agent` + `test:characters` + `test:python`, dev smoke per spec §6,
   PR via the standing routine (HANDOFF §6). No release bump.

## Risks

- Hologram is fully local canvas: renders even with no backend link and no
  character loaded; conversation degrades to `/api/logs/commands`, mic to
  LINK IDLE.
- `Ctrl+Alt+O` taken by another app → warn in console, Settings still
  toggles the window (same graceful pattern as emergency shortcut).
- Extra polling load → widgets share one 3s interval, paused when hidden.
