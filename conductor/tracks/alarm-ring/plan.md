# Plan — alarm-ring

1. **useAppEvents.ts** — add `utility.fired` → `window.dispatchEvent`
   `abxag:alarm-fired`. ✅
2. **appApi.ts** — add `UtilityView` type + helpers `utilities`,
   `addUtility`, `cancelUtility`, `dismissUtility`, `snoozeUtility`. ✅
3. **AlarmCard.tsx** (new) — kind/label/missed card, Snooze 5 / Dismiss,
   90 s auto-clear; mount in `App.tsx` (listens `abxag:alarm-fired`). ✅
4. **ABxAGRuntime.ts** `onUtilityFired` — add wave (both) +
   `companionCommand("alarm_attention")`. ✅
5. **companion.cjs** — `alarmMoment()` + `handleCommand` case +
   `think()` hold guard. `node --check`. ✅
6. **liveAgentTools.ts** — prompt nudge for typed Bengali time words. ✅
7. **AlarmsSection.tsx** (new) — list + add + cancel; mount in
   SystemSection under "Alarms & reminders". ✅
8. **Verify** — node --check, lint, 99/32/8(+1) tests, secret scan. ✅
9. **Land** — branch `feat/alarm-ring` off DEV, stage ONLY this track's
   files (PRD + track + touched sources), PR → CI green → merge.
10. **Release** — v1.1.20 on user approval (frontend + Electron changed →
    full `dist:public` rebuild; agent EXE unchanged, no PyInstaller).
