# PRD: Dual-Cursor Fix — virtual mouse actually works (v1.1.13 candidate)

## Problem
Virtual mouse tools existed in the frozen agent (96 tools) but never visibly
worked: (1) the task-engine model had no virtual tool declarations, so it
always used the physical mouse; (2) the Electron neon overlay never received
position updates, so it sat frozen at (500,400); (3) Ctrl+Alt+P only flipped
the overlay pill, not the agent's paused state.

## Changes
- `server.ts`: 11 virtual tool declarations for the model + DUAL-CURSOR
  prompt rule (prefer virtual tools when the user may be at the PC).
- `server.ts`: `GET /api/virtual-cursor` (provers virtualStatus for overlay).
- `server.ts`: `virtual.pause-toggle` IPC now toggles the agent's real
  paused state (fire-and-forget, overlay flips optimistically).
- `electron/virtual-cursor.cjs`: `startPolling(origin)` (1/s local poll,
  origin-validated to 127.0.0.1) + `stopPolling`.
- `electron/main.cjs`: overlay starts polling `SERVER_ORIGIN`.
- `desktop_agent/test_virtual_cursor.py`: 11 unit tests (state machine,
  pointer-safety guards, no-pyautogui rule).

## Safety
- Poll is localhost-only, 1/s, 8KB cap; overlay stays click-through/focusable=false.
- virtualUiAction still rejects pointer actions; aborts if UIA falls back to pointer.
- No changes to physical tools; no new permissions.

## Verify
- `npm run lint`, `node --check electron/virtual-cursor.cjs electron/main.cjs`
- `python -m unittest discover -s desktop_agent -p "test_*.py"`
- Live: startTask on a background window while moving the physical mouse —
  neon cursor glides, OS cursor stays with the user.
