# Companion Resize Control (Hardened) — Implementation Plan v1.1.29

## Overview
Hardened resize implementation replacing v1.1.26/27 logic with **debounced, metrics-synced, boundary-safe, fully-tested** code. Built on v1.1.28 codebase (current DEV branch).

---

## File Changes

### 1. `electron/companion.cjs` — Core Logic (NEW `adjustScale` + hardened `handleCommand`)

#### A. Add Debounce State (in `constructor`, after line 81)
```javascript
this._resizeDebounceTimer = null;
this._resizePending = null; // { delta?, absolute?, reset? }
```

#### B. Replace `adjustScale` (lines 1558-1585) with Hardened Version
```javascript
/**
 * Adjust companion scale (size) — hardened with debounce, clamp logging, atomic persist.
 * @param {{ delta?: number, absolute?: number, reset?: boolean }} options
 */
async adjustScale({ delta, absolute, reset } = {}) {
  if (!this.win) return;

  // Debounce: if a resize is pending within 500ms, overwrite and restart timer
  if (this._resizeDebounceTimer) {
    this._resizePending = { delta, absolute, reset };
    return;
  }

  this._resizePending = { delta, absolute, reset };
  this._resizeDebounceTimer = setTimeout(async () => {
    const pending = this._resizePending;
    this._resizePending = null;
    this._resizeDebounceTimer = null;

    if (!this.win || !pending) return;

    const current = Number(this.settings?.companion?.scale) || 1;
    let next = current;

    if (pending.reset) {
      next = 1.0;
    } else if (Number.isFinite(pending.absolute)) {
      next = pending.absolute;
    } else if (Number.isFinite(pending.delta)) {
      next = current + pending.delta;
    } else {
      return; // no valid operation
    }

    // Clamp with logging
    const clamped = Math.max(0.4, Math.min(2.5, next));
    if (clamped !== next) {
      this.log(`scale clamp: ${next} -> ${clamped} (range 0.4-2.5)`);
    }
    next = clamped;

    if (next === current) {
      this.log(`scale unchanged: ${current}`);
      return;
    }

    // Persist setting — wait for confirmation before ack
    try {
      await this.options.saveSettings({ companion: { scale: next } });
      // applySettings will be called automatically by main.cjs settings watcher
      // and will call this.resize() (existing method) which updates window bounds
      // and waits for renderer metrics before settleOnSurface()

      // Visual acknowledgement (only after successful persist)
      this.command({ act: 'perform', name: 'happyFace' });
      this.log(`scale adjusted: ${current} -> ${next}`);
    } catch (error) {
      this.log(`scale persist failed: ${error && error.message}`);
      // No ack on failure
    }
  }, 500); // 500ms debounce window
}
```

#### C. Update `handleCommand` Resize Parsing (lines 1596-1616) — Simplified & Robust
```javascript
// Resize command: "resize:+0.25", "resize:1.5", "resize:reset" or object payload
if (typeof command === 'string' && command.startsWith('resize:')) {
  const payload = command.slice('resize:'.length).trim();
  if (payload === 'reset') {
    void this.adjustScale({ reset: true });
  } else if (payload.startsWith('+') || payload.startsWith('-')) {
    const delta = Number(payload);
    if (Number.isFinite(delta)) void this.adjustScale({ delta });
  } else {
    const absolute = Number(payload);
    if (Number.isFinite(absolute)) void this.adjustScale({ absolute });
  }
  return;
}
// Object payload (from backend, future-proof)
if (command && typeof command === 'object' && (command.delta !== undefined || command.absolute !== undefined || command.reset)) {
  if (command.delta !== undefined) void this.adjustScale({ delta: command.delta });
  else if (command.absolute !== undefined) void this.adjustScale({ absolute: command.absolute });
  else if (command.reset) void this.adjustScale({ reset: true });
  return;
}
```

#### D. Cleanup on Destroy (in `destroy()`, after line 337)
```javascript
if (this._resizeDebounceTimer) {
  clearTimeout(this._resizeDebounceTimer);
  this._resizeDebounceTimer = null;
}
this._resizePending = null;
```

---

### 2. `electron/main.cjs` — No Changes Needed ✅
Existing settings flow handles it:
1. `saveSettings({ companion: { scale } })` writes to store
2. Settings watcher (line 838) calls `applyShellSettings(next)`
3. `applyShellSettings` calls `companion.applySettings(settings)`
4. `CompanionManager.applySettings` (line 135) calls `this.resize()` (existing)
5. `resize()` (line 339) reads new scale, updates bounds, waits for metrics, settles.

---

### 3. `voice/liveAgentTools.ts` — Verify/Enhance Voice Parsing (Lines 307-324)

**Current:** Already handles `delta`, `absolute`, `reset` → builds command string.
**Enhancement:** Add Bengali number parsing (e.g., "সাইজ ১.৫" → 1.5).

```typescript
// In handleLiveAgentTool, case "companionResize":
// Add before building command string:
const parseBengaliNumber = (str: string): number | null => {
  const bengaliDigits = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
  let normalized = str;
  for (let i = 0; i < 10; i++) {
    normalized = normalized.replaceAll(bengaliDigits[i], String(i));
  }
  const match = normalized.match(/([0-9]*\.?[0-9]+)/);
  return match ? Number(match[1]) : null;
};

// When absolute is provided but not a number, try parsing from string
if (typeof absolute !== 'number' && typeof args.absolute === 'string') {
  const parsed = parseBengaliNumber(args.absolute);
  if (Number.isFinite(parsed)) absolute = parsed;
}
```

---

### 4. `src/companion/CompanionApp.tsx` — Verify Metrics Sync (Lines 191-210)

**Current:** `setInterval(checkSize, 250)` detects canvas resize → sends `bridge.metrics(actor.metrics())`.
**Verify:** Ensure `actor.metrics()` returns updated `floorY` and `halfWidthPx` after scale change.
**No code change needed** if `CompanionActor.metrics()` reads from `system` which updates on frame.

---

### 5. Tests — `tests/companionResizeHardened.test.ts` (NEW FILE)

Add to `package.json` `test:agent` script:
```json
"test:companionResizeHardened": "node --import tsx --test tests/companionResizeHardened.test.ts"
```

**Test Cases:**

| Test | Description |
|------|-------------|
| `adjustScale({ delta: 0.25 })` | Increases scale by 0.25, clamps at 2.5 |
| `adjustScale({ delta: -0.25 })` | Decreases scale by 0.25, clamps at 0.4 |
| `adjustScale({ absolute: 1.5 })` | Sets scale to 1.5 |
| `adjustScale({ absolute: 3.0 })` | Clamps to 2.5, logs clamp event |
| `adjustScale({ reset: true })` | Sets scale to 1.0 |
| `saveSettings called` | With correct `companion.scale` value |
| `Ack animation triggered` | `command({ act: 'perform', name: 'happyFace' })` called |
| `Debounce: rapid calls` | 5 calls in 100ms → only 1 executes (latest params) |
| `Debounce: sequential` | Call, wait 600ms, call → both execute |
| `No ack on save failure` | Mock `saveSettings` reject → no `happyFace` command |
| `Boundary logs` | Clamp at 0.4/2.5 logs `scale clamp:` |
| `Cleanup on destroy` | Debounce timer cleared, no leak |

**Test Structure:**
```typescript
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { CompanionManager } from '../electron/companion.cjs';

describe('Companion Resize Hardened', () => {
  let companion;
  let mockOptions;

  beforeEach(async () => {
    mockOptions = {
      sendToShell: () => {},
      backend: async () => {},
      saveSettings: mock.fn(async () => {}),
      openMain: () => {},
      openStudio: () => {},
      emergencyStop: () => {},
      ownPids: () => [],
      onMenusChanged: () => {},
    };
    const mod = await import('../electron/companion.cjs');
    companion = new mod.CompanionManager(mockOptions);
    // Mock win, settings, etc.
  });

  afterEach(() => {
    companion?.destroy();
  });

  // ... test cases
});
```

---

### 6. Documentation Updates

| File | Change |
|------|--------|
| `PRD/companion-resize-v29.md` | New PRD documenting the hardened feature |
| `README.md` | Update version badge to v1.1.29, mention resize in features |
| `website/index.html` | Version pill → v1.1.29 |
| `website/RoadMap/index.html` | Version pill → v1.1.29 |
| `website/releases.json` | Add v1.1.29 entry (after release) |

---

## Implementation Order

1. **Step 1:** Edit `electron/companion.cjs` — add debounce state, replace `adjustScale`, update `handleCommand`, add cleanup
2. **Step 2:** Edit `voice/liveAgentTools.ts` — add Bengali number parsing
3. **Step 3:** Verify `src/companion/CompanionApp.tsx` metrics sync (no change expected)
4. **Step 4:** Create `tests/companionResizeHardened.test.ts` with all test cases
5. **Step 5:** Add test to `package.json` `test:agent` script
6. **Step 6:** Run `npm run lint` + `npm run test:agent` + `npm run test:characters` + `npm run test:python`
7. **Step 7:** Manual smoke test: dev server → tray → right-click → send `runtime:companion` resize commands
8. **Step 8:** Create PRD, update docs
9. **Step 9:** Release routine (version bump, build, GitHub Release, feed refresh)

---

## Verification Checklist (Definition of Done)

- [ ] `npm run lint` clean
- [ ] `npm run test:agent` — all 129+ existing + 12 new resize tests pass
- [ ] `npm run test:characters` — 8 pass + 1 skipped
- [ ] `npm run test:python` — 32 pass
- [ ] Manual test: "boro koro" → scale +0.25, ack, persist, survives restart
- [ ] Manual test: rapid 5x "boro koro" → only 1 resize, debounced
- [ ] Manual test: at 2.5, "boro koro" → clamp log, ack, scale stays 2.5
- [ ] Manual test: resize during sleep → executes on wake
- [ ] Settings UI slider syncs
- [ ] No memory leak (debounce timer cleared on destroy)
- [ ] Logs show: `scale adjusted: 1.0 -> 1.25` or `scale clamp: 3.0 -> 2.5`

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Debounce breaks rapid legitimate commands | 500ms is short; user can't speak faster. Sequential distinct commands (600ms apart) work. |
| Metrics timeout causes wrong settle | Fallback `settleOnSurface(0)` uses current best estimate (contactY from last metrics). |
| Settings save race condition | `saveSettings` is async; ack only after resolve. Watcher triggers `applySettings` once. |
| Old v1.1.26/27 bugs regress | This plan replaces those code paths entirely; tests cover regression cases. |

---

## References

- Spec: `conductor/tracks/companion-resize-v29/spec.md`
- Current implementation: `electron/companion.cjs` lines 1558-1616, 339-355
- Renderer metrics: `src/companion/CompanionApp.tsx` lines 191-210
- Voice tool: `voice/liveAgentTools.ts` lines 129-140, 307-324
- Settings flow: `electron/main.cjs` lines 816, 838, 843
- Existing tests: `tests/companionSleepWakeResize.test.ts`