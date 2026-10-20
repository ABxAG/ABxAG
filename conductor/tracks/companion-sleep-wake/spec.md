# Companion Sleep/Wake & Hide/Show — Spec

## Context
The desktop companion (the 3D doll on screen) currently supports:
- `hide` — walks off-screen, peeks back later
- `summon` / `come_here` — calls her back if hidden
- `sit` / `stand` — pose changes
- `perform:<action>` — full-body animations

**Missing:** Explicit **sleep/wake** cycle and **show/hide** window control via voice/command.

---

## User Stories

| ID | Story |
|----|-------|
| US-1 | As a user, I can say "sleep" / "go to sleep" so the companion lies down, closes her eyes, and stops all autonomous behavior (walking, peeking, icon play) until woken. |
| US-2 | As a user, I can say "wake up" / "good morning" so the companion stands up, opens her eyes, and resumes normal autonomous behavior. |
| US-3 | As a user, I can say "hide" / "go away" so the companion window is truly hidden (not just walked off-screen) and stops consuming resources. |
| US-4 | As a user, I can say "show" / "come back" so the companion window reappears at its last position (or default) and resumes. |
| US-5 | Tray menu and context menu get matching items for Sleep/Wake and Hide/Show. |

---

## Functional Requirements (EARS)

### Sleep/Wake
- **REQ-SW-1** WHEN the user issues `sleep` command THEN the companion SHALL transition to `sleeping` mode: lie down on current surface, play `sleepFace` behaviour, stop idle behaviours, stop brain timer, stop walk/peek/icon timers.
- **REQ-SW-2** WHILE in `sleeping` mode THE companion SHALL NOT respond to cursor, NOT walk, NOT peek, NOT play with icons, NOT auto-sit.
- **REQ-SW-3** WHEN the user issues `wake` command THEN the companion SHALL transition from `sleeping` to `standing`: stand up, play `wakeFace`/`happyFace`, resume idle behaviours, restart brain timer.
- **REQ-SW-4** IF the companion is `sleeping` AND the user drags her THEN she SHALL wake up automatically (treated as interaction).

### Hide/Show (Window Level)
- **REQ-HS-1** WHEN the user issues `hide_window` command THEN the companion window SHALL be hidden (`win.hide()`), physics/brain timers stopped, mode set to `window_hidden`.
- **REQ-HS-2** WHEN the user issues `show_window` command THEN the companion window SHALL be shown (`win.showInactive()`), timers restarted, mode restored to `standing` at last known position.
- **REQ-HS-3** `hide_window` is distinct from `hide` (walk off-screen peek). `hide_window` = window hidden; `hide` = peek behavior.
- **REQ-HS-4** Tray menu "Hide desktop companion" toggles `enabled` setting (existing). New: "Sleep" / "Wake" and "Hide window" / "Show window" items when enabled.

---

## Commands (Backend → Shell)

| Command | Action |
|---------|--------|
| `sleep` | Enter sleep mode (lie down, pause brain) |
| `wake` | Exit sleep mode (stand up, resume brain) |
| `hide_window` | Hide the companion window entirely |
| `show_window` | Show the companion window |

---

## Voice Command Mapping (Backend Responsibility)

| User says | Backend sends |
|-----------|---------------|
| "sleep", "go to sleep", "good night" | `runtime:companion` → `sleep` |
| "wake up", "good morning", "wake" | `runtime:companion` → `wake` |
| "hide", "go away", "disappear" (window level) | `runtime:companion` → `hide_window` |
| "show", "come back", "appear" (window level) | `runtime:companion` → `show_window` |
| "hide and peek", "peek" (existing) | `runtime:companion` → `hide` |

> **Note:** Voice intent classification lives in the backend (server.ts / cognition). This spec only covers the shell side.

---

## State Machine (CompanionManager.mode)

```
standing ←→ sitting ←→ lying ←→ hanging ←→ walking ←→ peeking ←→ hidden (peek)
    ↓                                              ↓
sleeping (NEW)                              window_hidden (NEW)
```

- `sleeping`: lie down on current surface, brain paused, render loop continues (breathing idle)
- `window_hidden`: `win.hide()` called, all timers stopped, no render

---

## Acceptance Criteria

1. `sleep` → doll lies down, eyes closed, no autonomous movement, no peek timer.
2. `wake` → doll stands up, eyes open, autonomous behavior resumes.
3. `hide_window` → window gone, no CPU/GPU for companion, tray says "Show window".
4. `show_window` → window back at last position, doll standing, brain running.
5. Drag while sleeping → wakes up.
6. Tray/context menus have Sleep/Wake and Hide window/Show window items.
7. Settings persist: `companion.sleeping` (session only), `companion.windowHidden` (session only).
8. Full test coverage: `test:agent` adds tests for new commands and state transitions.