# Companion Sleep/Wake & Hide/Show — Implementation Plan

## Overview
Add four new commands to `CompanionManager.handleCommand` and corresponding state handling in `electron/companion.cjs`. Update tray/context menus. Add tests.

---

## File Changes

### 1. `electron/companion.cjs` — Core Logic

#### New State Properties (constructor)
```javascript
this.sleeping = false;
this.windowHidden = false;
this.preSleepMode = null; // to restore mode after wake
```

#### `handleCommand` — Add Cases
```javascript
case 'sleep':
  if (!this.sleeping && this.win) void this.sleep();
  break;
case 'wake':
  if (this.sleeping) void this.wake();
  break;
case 'hide_window':
  if (!this.windowHidden && this.win) void this.hideWindow();
  break;
case 'show_window':
  if (this.windowHidden && this.win) void this.showWindow();
  break;
```

#### New Methods

**`sleep()`**
- If `mode === 'sitting'` → `standUp()` first
- If `mode === 'lying'` → `getUp()` first
- `this.interrupt()` to stop any ongoing action
- `this.preSleepMode = this.mode`
- `this.mode = 'sleeping'`
- `this.sleeping = true`
- `this.command({ act: 'lie', side: 1 })` — lie down facing viewer
- `await this.waitFor('lie', 3000)`
- `this.settleOnSurface(0)`
- Stop brain timer: `clearInterval(this.brainTimer); this.brainTimer = null`
- Stop anchor timer (optional, keep for position retention)
- Play `sleepFace` behaviour
- `this.system.setIdleBehaviours(false)` (renderer side via command)

**`wake()`**
- `this.sleeping = false`
- `this.mode = this.preSleepMode ?? 'standing'`
- `this.preSleepMode = null`
- `await this.getUp()` (handles lie→stand transition with fade)
- `this.settleOnSurface(0)`
- Restart brain timer: `this.brainTimer = setInterval(() => this.think(), 1000)`
- `this.nextThought = Date.now() + rand(3000, 7000)`
- Play `wakeFace` or `happyFace` behaviour
- `this.system.setIdleBehaviours(true)` (renderer side)

**`hideWindow()`**
- `this.interrupt()`
- `this.windowHidden = true`
- `this.preSleepMode = this.mode`
- `this.mode = 'window_hidden'`
- Stop all timers: `this.stopTimers()` (but keep cursorTimer?)
- `this.win.hide()`

**`showWindow()`**
- `this.windowHidden = false`
- `this.mode = this.preSleepMode ?? 'standing'`
- `this.preSleepMode = null`
- `this.win.showInactive()`
- Restart timers: `this.startCursorFeed()`, `this.anchorTimer = setInterval(...)`, `this.brainTimer = setInterval(...)`
- `this.nextThought = Date.now() + rand(3000, 7000)`
- `this.keepOnScreen()`
- `this.startFall(0, 0)` to settle on surface

#### `beginDrag()` — Wake on Interaction
```javascript
if (this.sleeping) {
  void this.wake();
  // continue with drag after wake
}
```

#### `followAnchor()` — Skip if sleeping or window_hidden
```javascript
if (this.sleeping || this.mode === 'window_hidden') return;
```

#### `think()` — Skip if sleeping or window_hidden
```javascript
if (this.sleeping || this.mode === 'window_hidden') return;
```

#### `updateMenus()` — Add Menu Items
```javascript
{ label: this.sleeping ? 'Wake up' : 'Sleep', click: () => this.handleCommand(this.sleeping ? 'wake' : 'sleep') },
{ type: 'separator' },
{ label: this.windowHidden ? 'Show window' : 'Hide window', click: () => this.handleCommand(this.windowHidden ? 'show_window' : 'hide_window') },
```

#### `showMenu()` — Context Menu Updates
Add the same items to the right-click context menu on the companion window.

---

### 2. `electron/main.cjs` — Tray Menu

Update `updateTrayMenu()` to add Sleep/Wake and Hide window/Show window items when companion is enabled:

```javascript
...(companionOn ? [
  { label: companion.sleeping ? 'Wake companion' : 'Sleep companion', click: () => companion?.handleCommand(companion.sleeping ? 'wake' : 'sleep') },
  { label: companion.windowHidden ? 'Show companion window' : 'Hide companion window', click: () => companion?.handleCommand(companion.windowHidden ? 'show_window' : 'hide_window') },
  { label: 'Call her here', click: () => companion?.summon() },
] : []),
```

Expose `sleeping` and `windowHidden` getters on `CompanionManager`:
```javascript
get sleeping() { return this.sleeping; }
get windowHidden() { return this.windowHidden; }
```

---

### 3. `src/companion/companionCommands.ts` — String Command Mapping (Optional)

Add string mappings for direct renderer commands (used by BroadcastChannel from main window):

```typescript
if (command === 'sleep') return { act: 'sleep' };
if (command === 'wake') return { act: 'wake' };
if (command === 'hide_window') return { act: 'hide_window' };
if (command === 'show_window') return { act: 'show_window' };
```

> Note: The main path is `runtime:companion` from backend → `CompanionManager.handleCommand`. This is for direct renderer→actor commands if needed.

---

### 4. `src/companion/CompanionActor.ts` — Sleep/Wake Poses (Optional Enhancement)

Add `sleep` and `wake` acts to `ActorCommand` type and handle them:
- `sleep` → lie down + `sleepFace` behaviour + slow breathing idle
- `wake` → stand up + `wakeFace`/`happyFace` behaviour

> Minimal approach: reuse existing `lie` + `stand` with behaviour triggers from shell.

---

### 5. Tests — `tests/core.test.ts` (or new `tests/companionSleepWake.test.ts`)

Add to `package.json` `test:agent` script:
```json
"test:companionSleepWake": "node --import tsx --test tests/companionSleepWake.test.ts"
```

Test cases:
- `sleep` command transitions mode to `sleeping`, calls `lie`, stops brain timer
- `wake` command transitions from `sleeping` to `standing`, calls `getUp`, restarts brain timer
- `hide_window` hides window, stops timers, sets `windowHidden`
- `show_window` shows window, restarts timers, clears `windowHidden`
- Drag while sleeping → wakes up
- `think()` no-op when sleeping
- `followAnchor()` no-op when sleeping/window_hidden

---

## Implementation Order

1. **Core state & commands** in `electron/companion.cjs` (sleep, wake, hideWindow, showWindow)
2. **Menu integration** in `electron/companion.cjs` (context menu) and `electron/main.cjs` (tray menu)
3. **Drag wake** in `beginDrag()`
4. **Timer guards** in `think()` and `followAnchor()`
5. **Tests** in `tests/companionSleepWake.test.ts`
6. **Lint & verify**: `npm run lint`, `npm run test:agent`

---

## References

- `electron/companion.cjs` lines 1406–1446: `handleCommand`
- `electron/companion.cjs` lines 226–242: `lieDown()`
- `electron/companion.cjs` lines 245–259: `getUp()`
- `electron/companion.cjs` lines 1261–1330: `think()`
- `electron/companion.cjs` lines 858–904: `followAnchor()`
- `electron/companion.cjs` lines 600–631: `beginDrag()`
- `electron/main.cjs` lines 857–871: `updateTrayMenu()`