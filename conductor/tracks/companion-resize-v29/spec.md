# Companion Resize Control (Hardened) — Spec v1.1.29

## Context
The companion already supports resize via `companion.scale` setting (0.4×–2.5×) and has basic voice/text command handling implemented in v1.1.26/27. However, that implementation had bugs (getter recursion, resize timing, metrics sync) and lacks hardening for production use. This track **re-specifies and hardens** the feature for v1.1.29 with:

- **Zero reuse of buggy v1.1.26/27 logic** — fresh implementation on v1.1.28 codebase
- **Debounced commands** — prevent rapid-fire resize spam
- **Metrics-sync guarantee** — renderer reports new floorY/halfWidthPx before shell settles
- **Boundary safety** — hard clamp + logging at 0.4/2.5
- **Persistence atomicity** — settings save confirmed before visual ack
- **Comprehensive test coverage** — unit, integration, E2E

---

## User Stories

| ID | Story |
|----|-------|
| US-1 | As a user, I can say **"boro koro"** / **"make larger"** / **"bigger"** so the companion grows by +0.25 (clamped to 2.5). |
| US-2 | As a user, I can say **"choto koro"** / **"make smaller"** / **"smaller"** so the companion shrinks by -0.25 (clamped to 0.4). |
| US-3 | As a user, I can say **"size 1.5"** / **"scale 150%"** / **"set size to 1.2"** so the companion sets to an exact scale (clamped 0.4–2.5). |
| US-4 | As a user, I can say **"reset size"** / **"normal size"** / **"default size"** so the companion returns to 1.0×. |
| US-5 | Size changes **persist across restarts** (saved to `settings.companion.scale` in userData). |
| US-6 | Visual feedback: companion plays **acknowledgement animation** (`happyFace` or `fixHair`) after successful resize. |
| US-7 | Rapid repeated commands are **debounced** (min 500ms between executions) to prevent jank. |
| US-8 | Resize works correctly during **sleep/wake**, **hide/show window**, **drag/throw** states. |

---

## Functional Requirements (EARS)

- **REQ-RS-1** WHEN the user issues a relative resize command (`bigger`/`smaller`/`boro koro`/`choto koro`) THEN the system SHALL adjust `companion.scale` by **±0.25** (clamped to 0.4–2.5) AND persist the setting AND play acknowledgement animation.
- **REQ-RS-2** WHEN the user issues an absolute resize command (`size <value>`/`scale <value>`) THEN the system SHALL set `companion.scale` to the parsed value (clamped to 0.4–2.5) AND persist the setting AND play acknowledgement animation.
- **REQ-RS-3** WHEN the user issues `reset size` / `normal size` / `default size` THEN the system SHALL set `companion.scale = 1.0` AND persist the setting AND play acknowledgement animation.
- **REQ-RS-4** IF a resize command is received **within 500ms of the previous resize** THEN the system SHALL **queue and debounce** it (execute only the latest after quiet period).
- **REQ-RS-5** AFTER settings persist, THE shell SHALL wait for **renderer metrics update** (`floorY`, `halfWidthPx`) before calling `settleOnSurface()` — fallback to current estimate after 2s timeout.
- **REQ-RS-6** THE companion window SHALL resize smoothly via existing `applySettings` → `resize()` flow (no manual bounds manipulation).
- **REQ-RS-7** IF `companion.scale` setting save fails THEN the system SHALL **log error**, **not play acknowledgement**, and **report failure** to backend.
- **REQ-RS-8** AT boundaries (0.4, 2.5), THE system SHALL **log clamp event** and still play acknowledgement (user feedback that command was heard).

---

## Commands (Backend → Shell)

| Command String | Payload (Object) | Action |
|----------------|------------------|--------|
| `resize:+0.25` | `{ delta: 0.25 }` | Relative increase |
| `resize:-0.25` | `{ delta: -0.25 }` | Relative decrease |
| `resize:1.5` | `{ absolute: 1.5 }` | Absolute scale |
| `resize:reset` | `{ reset: true }` | Reset to 1.0 |

> **Parsing:** Backend (`runtime/ABxAGRuntime.ts`) sends **string shorthand** (`resize:+0.25`) for simplicity. `CompanionManager.handleCommand` parses both string and object formats.

---

## Voice Command Mapping (Backend Responsibility)

| User Says (Bengali/English) | Backend Sends (`runtime:companion`) |
|-----------------------------|-------------------------------------|
| "boro koro", "make larger", "bigger", "grow", "বড় করো" | `resize:+0.25` |
| "choto koro", "make smaller", "smaller", "shrink", "ছোট করো" | `resize:-0.25` |
| "size 1.5", "scale 150%", "set size to 1.2", "সাইজ ১.৫" | `resize:1.5` |
| "reset size", "normal size", "default size", "রিসেট সাইজ" | `resize:reset` |

> **Number parsing** (Bengali/English digits, "১.৫" → 1.5) lives in `voice/liveAgentTools.ts` → `handleLiveAgentTool` → `companionResize` tool.

---

## Settings Persistence

- **Setting key:** `companion.scale` (number, default `1.0`)
- **Range:** `0.4` – `2.5` (enforced in `CompanionManager.size()` and `adjustScale()`)
- **Persistence:** `saveSettings({ companion: { scale: newValue } })` → triggers `applySettings` → `resize()`
- **Atomicity:** Acknowledgement animation **only after** `saveSettings` promise resolves.

---

## Debounce & Concurrency Control

```javascript
// Internal guard
this._resizeDebounceTimer = null;
this._resizePending = null; // { delta, absolute, reset }

// In adjustScale():
if (this._resizeDebounceTimer) {
  // New command within 500ms: overwrite pending, restart timer
  this._resizePending = { delta, absolute, reset };
  return;
}
this._resizePending = { delta, absolute, reset };
this._resizeDebounceTimer = setTimeout(() => {
  this._executeResize(this._resizePending);
  this._resizePending = null;
  this._resizeDebounceTimer = null;
}, 500);
```

---

## Renderer Metrics Sync (Critical for Correct Settling)

1. Shell calls `saveSettings()` → `applySettings()` → `resize()` (existing method)
2. `resize()` (line 339) **waits for `metrics` event** from renderer (max 2s):
   ```javascript
   this.waitFor('metrics', 2000).then(() => this.settleOnSurface(0));
   ```
3. Renderer (`CompanionApp.tsx`) detects canvas size change via `setInterval(checkSize, 250)` and sends `bridge.metrics(actor.metrics())`.
4. If metrics timeout → fallback `settleOnSurface(0)` with current best estimate.

---

## Acceptance Criteria

1. ✅ `"boro koro"` → scale +0.25 (max 2.5), saved, ack animation, metrics sync, settle.
2. ✅ `"choto koro"` → scale -0.25 (min 0.4), saved, ack animation, metrics sync, settle.
3. ✅ `"size 1.5"` → scale = 1.5, saved, ack animation, metrics sync, settle.
4. ✅ `"reset size"` → scale = 1.0, saved, ack animation, metrics sync, settle.
5. ✅ Rapid 5x "boro koro" in 1s → **only ONE resize executed** (debounced), final scale +0.25.
6. ✅ At 2.5, "boro koro" → logs clamp, plays ack, scale stays 2.5.
7. ✅ At 0.4, "choto koro" → logs clamp, plays ack, scale stays 0.4.
8. ✅ Resize during sleep → executes on wake (queued).
9. ✅ Resize during drag → executes after drag ends.
10. ✅ Settings UI slider stays in sync (reactive via settings store).
11. ✅ **Test coverage:** `test:agent` includes 10+ resize tests (unit + integration).

---

## Non-Functional Requirements

| NFR | Target |
|-----|--------|
| Latency (voice → visual ack) | < 800ms (debounce 500ms + settings save + renderer metrics) |
| Settings write durability | `saveSettings` uses existing atomic write (tmp + rename) |
| Memory leak | Zero — debounce timer cleared on destroy |
| Log volume | One line per resize: `scale adjusted: 1.0 -> 1.25` |
| Backward compat | Existing `companion.scale` values read correctly |

---

## Out of Scope

- UI slider redesign (Settings panel already has it)
- New animations (reuse existing `happyFace`/`fixHair`)
- Multi-monitor scale per display (single global scale)
- Programmatic API for external apps (internal only)

---

## References

- Current implementation (to be hardened): `electron/companion.cjs` lines 1558-1585 (`adjustScale`), 1596-1616 (`handleCommand` resize parsing)
- Renderer metrics: `src/companion/CompanionApp.tsx` lines 191-210
- Voice tool: `voice/liveAgentTools.ts` lines 129-140, 307-324
- Settings flow: `electron/main.cjs` lines 816, 838, 843
- Existing tests: `tests/companionSleepWakeResize.test.ts` (resize section)