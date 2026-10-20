# Companion Resize via Voice/Text — Spec

## Context
The companion already has a `scale` setting (0.4× to 2.5×) adjustable via Settings UI (slider). Users want to change size via **voice command** ("make her bigger", "smaller", "size 150%") or **text input** in chat.

---

## User Stories

| ID | Story |
|----|-------|
| US-1 | As a user, I can say "make her bigger" / "bigger" so the companion grows by a step (e.g., +25%). |
| US-2 | As a user, I can say "make her smaller" / "smaller" so the companion shrinks by a step (e.g., -25%). |
| US-2 | As a user, I can say "size 150%" / "scale 1.5" so the companion sets to an exact scale. |
| US-3 | As a user, I can say "reset size" / "default size" so the companion returns to 100% (1.0×). |
| US-4 | Size changes persist across restarts (saved to settings). |
| US-5 | Visual feedback: companion acknowledges the change (e.g., `happyFace` or `fixHair` animation). |

---

## Functional Requirements (EARS)

- **REQ-RS-1** WHEN the user issues a relative resize command (`bigger`/`smaller`) THEN the companion SHALL adjust `companion.scale` by ±0.25 (clamped to 0.4–2.5) AND persist the setting.
- **REQ-RS-2** WHEN the user issues an absolute resize command (`size <value>` or `scale <value>`) THEN the companion SHALL set `companion.scale` to the parsed value (clamped to 0.4–2.5) AND persist the setting.
- **REQ-RS-3** WHEN the user issues `reset size` THEN the companion SHALL set `companion.scale = 1.0` AND persist the setting.
- **REQ-RS-4** AFTER any size change THE companion SHALL play a brief acknowledgement animation (`happyFace` or `fixHair`).
- **REQ-RS-5** THE companion window SHALL reload/resize smoothly via existing `applySettings` → `resize()` flow (no manual window manipulation needed).

---

## Commands (Backend → Shell)

| Command | Payload | Action |
|---------|---------|--------|
| `resize` | `{ delta: number }` | Relative change (e.g., +0.25, -0.25) |
| `resize` | `{ absolute: number }` | Absolute scale (e.g., 1.5) |
| `resize` | `{ reset: true }` | Reset to 1.0 |

> **Alternative:** Three separate commands: `resize_relative`, `resize_absolute`, `resize_reset`. Simpler to parse in backend.

---

## Voice Command Mapping (Backend Responsibility)

| User says | Backend sends (`runtime:companion`) |
|-----------|-------------------------------------|
| "bigger", "make her bigger", "grow" | `resize:+0.25` or `{ delta: 0.25 }` |
| "smaller", "make her smaller", "shrink" | `resize:-0.25` or `{ delta: -0.25 }` |
| "size 150%", "scale 1.5", "set size to 1.2" | `resize:1.5` or `{ absolute: 1.5 }` |
| "reset size", "default size", "normal size" | `resize:reset` or `{ reset: true }` |

> **Note:** Voice intent classification & number parsing lives in backend (server.ts / cognition). This spec only covers the shell side.

---

## Settings Persistence

- Setting key: `companion.scale` (number, default `1.0`)
- Range: `0.4` – `2.5` (enforced in `CompanionManager.size()`)
- Persisted via existing `saveSettings({ companion: { scale: newValue } })`
- Triggers `applySettings` → `resize()` → window bounds update

---

## Acceptance Criteria

1. "bigger" → scale increases by 0.25 (max 2.5), setting saved, companion acknowledges.
2. "smaller" → scale decreases by 0.25 (min 0.4), setting saved, companion acknowledges.
3. "size 150%" → scale = 1.5, setting saved, companion acknowledges.
4. "reset size" → scale = 1.0, setting saved, companion acknowledges.
5. Value clamping works at boundaries (0.4, 2.5).
6. Settings UI slider stays in sync (reactive via settings store).
7. Test coverage: `test:agent` adds tests for resize commands.