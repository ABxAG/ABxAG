# Spec — alarm-ring

Full PRD: `PRD/alarm-ring.md` (approved, 2026-10-17). Summary:

## Goal

An alarm/reminder ring must be a **fully visible attention moment**, even
when no voice session is connected: alarm card in the app, both dolls wave,
and the desktop-companion (taskbar) doll grows big for a moment — plus an
alarms management list in Settings › System.

## Behaviour

### Ring (runtime/ABxAGRuntime.ts `onUtilityFired`)

Publish side effects (existing ones unchanged) plus:
- `characterCommand({ kind: "action", action: "wave", target: "both" })` —
  fans out via `/events` `character.command`; main stage performs it
  (existing `abxag:character-command` path) and the companion doll performs
  the same wave via the `abxag-character-state` BroadcastChannel.
- `companionCommand("alarm_attention")` — server → Electron shell ipc
  (`runtime:companion` → `companion.cjs handleCommand`).

### Frontend

- `src/lib/useAppEvents.ts`: `utility.fired` dispatches a window event
  `abxag:alarm-fired` (same pattern as `character.command`).
- `src/App.tsx`: mounts a small **AlarmCard** (new
  `src/components/AlarmCard.tsx`): kind label, the reminder text, optional
  "missed while ABxAG was off" badge, Snooze 5 min / Dismiss buttons
  (existing endpoints), auto-clear after 90 s.
- `src/components/SettingsPanel.tsx` › SystemSection: new
  **"Alarms & reminders"** group (below Update): add row (kind, time, label)
  and upcoming list (due local time, repeat tag, Cancel). New component
  `src/components/AlarmsSection.tsx` using new `appApi.ts` helpers.

### Electron shell (electron/companion.cjs)

`alarmMoment()`:
- Guards out (wave-only fallback handled by the broadcast wave): no win,
  fullscreen-hidden, hanging (`anchor.kind === 'window'`), lying, not
  standing/sitting, or already held.
- Effects: remember exact bounds; `fade()` into a ~2.2× window (clamped to
  the work area, feet on `surfaceY()`), ~9 s hold with `this.alarmHold = true`
  (the `think()` brain tick pauses), then `fade()` back to the exact saved
  bounds and clear the hold.
- Follows the file's existing conventions: no forever-throwing timers, no
  `&&`, DIP bounds only, never touch other processes.

### Prompt (voice/liveAgentTools.ts)

Nudge the reminder instruction's text so typed Bengali/Hindi clock phrases
convert into `time` args reliably (no logic change; declarations untouched).

## Hard constraints

- Scheduler semantics unchanged (snooze / missed / repeat / persistence).
- No autonomous execution of labelled tasks at ring time.
- Backend responses unchanged except the richer ring side effects.
- Parallel-session safety: only stage this track's files.

## Verify

`node --check` on companion.cjs · `npm run lint` · 99 agent + 32 python +
8 character tests · secret scan · manual dev smoke (1-min reminder).
