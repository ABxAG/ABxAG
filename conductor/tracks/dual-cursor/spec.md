# Spec: Dual-Cursor (Multi-Pointer) AI Co-pilot

## Goal
Same screen, two cursors:
- Physical mouse: user controls (already exists — pyautogui path, untouched).
- Virtual cursor: software controls, never moves physical cursor.

## Non-goals
- True OS-level second pointer (Windows does not allow it).
- RDP-loopback full isolation (future).

## Requirements
1. Virtual cursor state (x,y,visible,status) lives in backend, rendered as
   neon-red overlay in Electron transparent fullscreen window.
2. Actions use non-moving paths first:
   - UIA Invoke/Value/Toggle patterns (no mouse move)
   - PostMessage WM_* to background HWND (no focus steal)
   - Only as last resort: queued physical click with user-idle check.
3. Concurrent input: user can type/browse while AI acts on another window.
4. Event queue: one virtual action at a time, FIFO, cancellable.
5. Safety: pause hotkey Ctrl+Alt+P, stop Ctrl+Alt+Shift+S (existing).
   Overlay corner widget shows Active/Idle/Paused + current task text.
6. Latency: virtualMove+virtualClick < 500ms on same machine.

## Tools (Python) — 12 total, all verified
virtualMove, virtualClick, virtualRightClick, virtualDoubleClick,
virtualType, virtualScroll, virtualInspect, virtualFind,
virtualUiAction (v2: element_id OR query+window_title auto-find,
  pointer-free actions only, overlay glides to live rect,
  aborts if UIA falls back to pointer), virtualStatus,
pauseVirtual, resumeVirtual.

Verified live: virtualInspect(OpenCode)->10 controls,
virtualUiAction scroll_into_view via uia.scroll_into_view,
virtual cursor (325,168), physical cursor NOT moved.

## Overlay (Electron)
virtual-cursor.cjs: fullscreen transparent, click-through, always-on-top.
Renders SVG cursor at virtual x,y + status pill bottom-right.
IPC: `virtual-cursor:update`, `virtual-cursor:status`.
