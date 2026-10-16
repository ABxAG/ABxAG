# Spec: dual-cursor-removal (drop the virtual mouse)

User order (2026-10-16): remove dual-cursor — it breaks ABxAG/tools working
properly. Goal: everything works reliably, every time.

## 1. Goal

Delete the virtual (AI) mouse end to end. After this track no virtual tool,
overlay, endpoint, setting, hotkey, or prompt rule remains. The AI drives the
PC through the **physical mouse path** (`clickText`/`click`/`typeText`/…),
gated by the existing confirmations, permission board, and emergency stop
(`Ctrl+Alt+Shift+S`).

## 2. Removal list

- Agent: `desktop_agent/tools_virtual_cursor.py` (12 tools:
  virtualMove/Click/RightClick/DoubleClick/Type/Scroll/Inspect/Find/UiAction/
  Status, pauseVirtual/resumeVirtual) + `test_virtual_cursor.py`;
  `registry.py` tool names + module entry; `desktop_agent.spec` hiddenimport.
  Frozen agent rebuilt clean → **84 tools**.
- Backend (`server.ts`): `DESKTOP_TOOL_NAMES` virtual entries, `VIRTUAL_TOOLS`,
  `VIRTUAL_ACTION_TOOLS`, `isVirtualCursorEnabled` + kill-switch block in
  `callDesktopAgent`, `GET /api/virtual-cursor`, `virtual.pause-toggle` shell
  handler, virtual tool declarations, DUAL-CURSOR prompt rule → rewritten to
  a physical-mouse rule (exact text labels via clickText, raw coordinates only
  for unlabeled canvas, pause on user input).
- Shared: `shared/virtualCursor.ts` deleted (no importers remain).
- Shell: `electron/virtual-cursor.cjs` deleted, `main.cjs` block +
  `Ctrl+Alt+P` removed, CI `node --check` line removed.
- Settings: `autonomy.virtualCursorEnabled` removed (type + default +
  normalize; old files auto-drop the unknown key). Renderer `AppSettings`
  mirror removed.
- UI: Settings “Virtual AI cursor” toggle removed; CommandDeck cursor switch
  removed (props `cursorOn`/`onCursor` deleted); `uiPreview` updated; HUD task
  widget drops the `/api/virtual-cursor` fetch (tasks only).
- Tests: `tests/virtualCursorSetting.test.ts` deleted + deregistered.
- Docs: `PRD/dual-cursor-removal.md`; `README` feature row rewritten;
  `HANDOFF.md` state updated (84 tools, no kill switch); `conductor/tracks.md`
  + `dual-cursor/index.md` marked removed. `website/releases.json` history and
  the parallel session’s dirty website files are NOT touched.

## 3. Non-goals

- No behaviour change to physical tools, permissions, TaskHud, HUD overlay,
  companion, or updater.
- No version bump, no release, no feed change in this track.

## 4. Acceptance

- `npm run lint` clean; `node --check` touched `.cjs`.
- `test:agent` (minus virtualCursorSetting), `test:characters`,
  `test:python` (minus test_virtual_cursor) green.
- Frozen agent rebuilt clean: boot log `Loaded 84 desktop tools`,
  `/tools` count 84, no `virtual*`/`pauseVirtual`/`resumeVirtual` names.
- grep `virtualCursor|virtual-cursor|virtual_cursor|virtualCursorEnabled|
  VIRTUAL_TOOLS|DUAL-CURSOR|Control+Alt+P` is empty outside history
  (`website/releases.json`, old PRDs/tracks) and this spec.
