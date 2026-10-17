# PRD — Alarm ring: the big attention moment

**Status:** approved · **Date:** 2026-10-17
**User order:** alarm/reminder set via typed chat ("সকাল ৬টায় মনে করিয়ে দিও");
when the time comes and the device is on, the desktop-companion doll **grows
big** and reminds (or does) the thing. "Do everything properly."

## 1. What already ships (discovered in the codebase)

- `UtilityScheduler` (companion/utilities.ts): alarm/reminder/timer, clock
  times + repeat + snooze + persist; missed pieces (≤12h) reported on boot.
- Typed + spoken chat both ride the Gemini **Live** session; `setReminder` /
  `listUpcoming` Live tools exist (`voice/liveAgentTools.ts`) → the text path
  can already set alarms. Small prompt nudge for Bengali time words.
- Ring path (`runtime/ABxAGRuntime.onUtilityFired`) voices the line (when a
  voice session is connected, bypasses DND), posts Windows notification and
  publishes `utility.fired` + `character.cue` on `/events`.
- APIs: GET/POST/DELETE `/api/utilities`, `/dismiss`, `/snooze`.

## 2. The real gaps

1. `utility.fired` / `character.cue` reach the frontends but **nobody
   consumes them** — no main-app card, no 3D reaction. Without a connected
   voice session the ring is nearly invisible.
2. The desktop companion (taskbar doll) does nothing special on ring: it has
   a manual size setting (scale 0.4–2.5) but no attention moment.
3. No UI to see/schedule/cancel alarms (APIs unused by the renderer).

## 3. The feature

### A. Ring moment (always visible, even without voice)

- **Main window:** `utility.fired` (via `/events`) opens an **alarm card**:
  kind (Alarm / Reminder / Timer done), the label as text, a "missed while
  ABxAG was off" badge when applicable, and Snooze 5 min / Dismiss buttons
  (existing endpoints). Auto-clears 90 s after appearing if untouched.
- **3D attention:** runtime publishes
  `characterCommand({ kind: "action", action: "wave", target: "both" })` — the
  main-stage doll waves (already consumed via `abxag:character-command`) and
  the companion doll performs it too (stage-command broadcast).
- **Desktop companion grows (the user's ask):**
  `runtime.companionCommand("alarm_attention")` → `companion.cjs`
  `handleCommand` → `alarmMoment()`: when she is on the ground standing, the
  shell fades the window to ~2.2× its size (feet stay on the surface,
  clamped to the work area), waves, holds ~9 s, then fades back to the exact
  saved bounds. Guards: not while hanging on a ledge, lying, walking, hidden
  for fullscreen, or already in an alarm moment (wave-only fallback there);
  the 1-s brain tick (`think()`) is paused while held so she isn't walked off
  mid-moment.

### B. Typed reminders — confirm, don't rebuild

Keep the existing Live `setReminder` tool. Improve its instruction line so
typed Bengali/Hindi time phrases ("সকাল ৬টা", "শাম ৯টা") convert to clock
time reliably and reminders can be typed in the chat box exactly like spoken.

### C. Alarm management in Settings › System

New "Alarms & reminders" group (below Update): upcoming list (kind badge,
label, due local time, repeat tag, Cancel button) + a compact add row
(kind select, time input, label text, Add). Backed by the existing APIs via
new `src/lib/appApi.ts` helpers.

### D. Explicit non-goals

- No autonomous agent-task execution at ring time (kept voice + visual +
  label text; safety first). The label/purpose is spoken and shown.
- No new sound design; no changed scheduler semantics (snooze, missed,
  repeat untouched — backend contract unchanged except richer ring side
  effects).

## 4. Verify

1. `node --check electron/companion.cjs` (touched Electron module).
2. `npm run lint` clean; `npm run test:agent` 99 pass; `test:python` 32;
   `test:characters` 8 (+1 skip). Agent EXE unchanged (no runtime python).
3. `npm run test:agent` unchanged count → no new frozen-agent build.
4. Secret scan the diff.
5. Manual (dev): POST /api/utilities with a 1-min reminder → card appears,
   both dolls wave, companion grows ~2.2× then restores; Snooze/Dismiss work;
   Settings list shows upcoming item and Cancel removes it.

## 5. Track

`conductor/tracks/alarm-ring/` (registered in `conductor/tracks.md`).
