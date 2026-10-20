# Companion Resize via Voice/Text — Implementation Plan

## Overview
Add `resize` command handling to `CompanionManager.handleCommand` in `electron/companion.cjs`. The command adjusts `companion.scale` setting and persists it via `saveSettings`. Existing `applySettings` → `resize()` flow handles window resize.

---

## File Changes

### 1. `electron/companion.cjs` — Core Logic

#### `handleCommand` — Add `resize` Case
```javascript
case 'resize':
  // Payload formats:
  // - { delta: +0.25 } or { delta: -0.25 }  (relative)
  // - { absolute: 1.5 }                      (absolute)
  // - { reset: true }                        (reset to 1.0)
  // Also accept string shorthand: "resize:+0.25", "resize:1.5", "resize:reset"
  if (typeof command === 'string' && command.startsWith('resize:')) {
    const payload = command.slice('resize:'.length).trim();
    // Parse string payload
    if (payload === 'reset') {
      void this.resize({ reset: true });
    } else if (payload.startsWith('+') || payload.startsWith('-')) {
      const delta = Number(payload);
      if (Number.isFinite(delta)) void this.resize({ delta });
    } else {
      const absolute = Number(payload);
      if (Number.isFinite(absolute)) void this.resize({ absolute });
    }
    return;
  }
  // Object payload (from backend)
  if (command && typeof command === 'object') {
    if (command.delta !== undefined) void this.resize({ delta: command.delta });
    else if (command.absolute !== undefined) void this.resize({ absolute: command.absolute });
    else if (command.reset) void this.resize({ reset: true });
  }
  break;
```

#### New Method: `resize(options)`
```javascript
/**
 * @param {{ delta?: number, absolute?: number, reset?: boolean }} options
 */
async resize({ delta, absolute, reset } = {}) {
  if (!this.win) return;
  const current = Number(this.settings?.companion?.scale) || 1;
  let next = current;

  if (reset) {
    next = 1.0;
  } else if (Number.isFinite(absolute)) {
    next = absolute;
  } else if (Number.isFinite(delta)) {
    next = current + delta;
  } else {
    return; // no valid operation
  }

  // Clamp to allowed range (matches size() method)
  next = Math.max(0.4, Math.min(2.5, next));
  if (next === current) return; // no change

  // Persist setting
  this.options.saveSettings({ companion: { scale: next } });
  // applySettings will be called automatically by main.cjs settings watcher
  // and will call this.resize() (the existing method) which updates window bounds

  // Visual acknowledgement
  this.command({ act: 'perform', name: 'happyFace' });
  // or 'fixHair' for a more subtle acknowledgement
}
```

> **Note:** The existing `resize()` method (line 327) is called by `applySettings` when settings change. It reads `this.settings.companion.scale` and updates window bounds. Our new `resize(options)` method saves the setting; the settings watcher triggers `applySettings` which calls the existing `resize()`.

#### Rename Conflict Avoidance
The existing method at line 327 is called `resize()` (no args). Rename our new method to `adjustScale()` or handle via different name:
```javascript
// In handleCommand:
case 'resize':
  // ...
  void this.adjustScale({ delta, absolute, reset });
  break;

// New method:
async adjustScale({ delta, absolute, reset } = {}) { ... }
```

---

### 2. `electron/main.cjs` — No Changes Needed

The existing settings flow handles it:
1. `saveSettings({ companion: { scale } })` writes to store
2. Settings watcher (line 838) calls `applyShellSettings(next)`
3. `applyShellSettings` calls `companion.applySettings(settings)`
4. `CompanionManager.applySettings` (line 135) calls `this.resize()` (existing)
5. `resize()` reads new scale and updates window bounds

---

### 3. `src/companion/companionCommands.ts` — String Command Mapping (Optional)

If direct renderer→actor commands are needed:
```typescript
if (command.startsWith('resize:')) {
  const payload = command.slice('resize:'.length).trim();
  // Return a special ActorCommand or handle via bridge
  return { act: 'resize', payload }; // Would need ActorCommand extension
}
```
> **Not required** — main path is `runtime:companion` from backend → `CompanionManager.handleCommand`.

---

### 4. Tests — `tests/companionResize.test.ts`

Add to `package.json` `test:agent` script:
```json
"test:companionResize": "node --import tsx --test tests/companionResize.test.ts"
```

Test cases:
- `adjustScale({ delta: 0.25 })` increases scale by 0.25, clamps at 2.5
- `adjustScale({ delta: -0.25 })` decreases scale by 0.25, clamps at 0.4
- `adjustScale({ absolute: 1.5 })` sets scale to 1.5
- `adjustScale({ absolute: 3.0 })` clamps to 2.5
- `adjustScale({ reset: true })` sets scale to 1.0
- `saveSettings` called with correct `companion.scale` value
- Acknowledgement animation triggered

---

## Implementation Order

1. **Add `adjustScale()` method** in `electron/companion.cjs`
2. **Add `resize` case** in `handleCommand`
3. **Test manually** via tray menu → right-click companion → "Call her here" → backend sends `runtime:companion` with resize command
4. **Add tests** in `tests/companionResize.test.ts`
5. **Lint & verify**: `npm run lint`, `npm run test:agent`

---

## References

- `electron/companion.cjs` line 135: `applySettings` → calls `this.resize()`
- `electron/companion.cjs` line 152: `size()` method reads `this.settings.companion.scale`
- `electron/companion.cjs` line 327: existing `resize()` method (window bounds update)
- `electron/main.cjs` line 838: settings watcher calls `applyShellSettings`
- `electron/main.cjs` line 816: `companion?.applySettings(settings)`
- `src/components/SettingsPanel.tsx` line 650: UI slider for scale