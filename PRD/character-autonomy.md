# PRD — Character Autonomy: Actions, Switching & Outfit

**Status:** approved for implementation · **App:** ABxAG 1.1.8+ · **Date:** 2026-10-10

## 1. Goal (user's words)

1. She can change her own CHARACTER by herself, automatically.
2. "CHARACTER change karo" → she changes it.
3. She moves/controls her own body as she wishes; when the user asks the
   character to do something ("jump!"), she performs it.
4. Outfit (clothing) colour can be changed by request — plus more.

## 2. Scope for this version

| # | Feature | Path |
|---|---|---|
| 1 | One-shot body actions: jump, wave, bow, spin, nod, shake-head, shrug, dance, stretch | New `CharacterActions` engine, driven through `PoseBuffer` + root motion |
| 2 | Voice tools: `characterPerform`, `switchCharacter`, `setOutfitColor` | `voice/liveAgentTools.ts` + `ABxAGRuntime.characterCommand()` |
| 3 | Server → stage bridge: `character.command` app event → window CustomEvent → `CharacterSystem` / App | `shared/appEvents.ts`, `useAppEvents.ts`, `ABxAGCharacter.tsx`, `App.tsx` |
| 4 | Outfit tint (cloth + hair, resettable) | `CharacterSystem.setOutfitTint()` via role colour multiplier |
| 5 | Autonomous switching: idle 45+ min, ≥2 characters, max 2/day, 6h apart | New `useCharacterAutonomy` hook in App |
| 6 | Voice instruction lines (EN/Hindi/Bengali examples) | `LIVE_AGENT_INSTRUCTIONS` |

Out of scope: face-morph spot expressions, generic (non-PMX) models for
actions/outfit (degrade gracefully, return false), companion-window body
(the desktop widget keeps its own behaviour set).

## 3. UX

- "Jump!" → she crouches, hops, lands; model says a short playful line.
- "Change character" → next imported character fades in; choice persists
  (`settings.character.activeCharacterId`); companion follows on next sync.
- "Make your dress red" → cloth roles tint red; "reset outfit" restores.
- Idle long enough → she may appear as a different character (max twice a
  day, never mid-conversation or mid-task).
- Unknown action/colour → tool returns the valid list; model asks, never
  pretends.

## 4. Technical design

### 4.1 `CharacterActions` (`src/character/animation/CharacterActions.ts`)

Keyframe overlays over one cycle: `perform(name)` validates bone presence
(via `BoneMap`, degrades silently), `update(delta, pose, bones, root)`
writes `addEuler`/`addTranslation` + root Y/yaw each frame, then completes.
One action at a time; a new one replaces the running one. Mounted in
`CharacterSystem.update()` between behaviours and the pose-layer loop, so
idle/gaze keep breathing underneath.

Supported: `jump | wave | bow | spin | nod | shake_head | shrug | dance | stretch`.

### 4.2 Command flow

```
voice tool (Node) → runtime.characterCommand({kind, ...})
  → appEvents.publish("character.command", payload)
  → /events WS → useAppEvents → window CustomEvent "abxag:character-command"
  → ABxAGCharacter: action/outfit → systemRef
  → App: switch → setActiveCharacterId (+ server already persisted it)
```

`switchCharacter` resolution (server): exact id → case-insensitive
displayName → `next` (cycle) → `random`. Needs ≥1 imported character;
built-in-only setups get "import one first".

### 4.3 Outfit tint

`setOutfitTint({ cloth?: hex|null, hair?: hex|null })`: resolves material
roles (`cloth|lightCloth|leather`, `hair|frontHair`), multiplies
`material.color`, stashes originals for reset. Invalid hex → false.

### 4.4 Autonomy (`src/lib/useCharacterAutonomy.ts`)

Tick every 60 s: needs `listAllCharacters ≥ 2`, 45 min since last
pointer/key/voice interaction, 6 h since last auto-switch, <2 switches
today (localStorage `abxag:auto-switch`). Fires `onSwitch(id)` → App
applies + persists via `api.updateAppSettings`. Never while a task runs,
audio is live-talking, or onboarding/settings is open — implemented as a
`canSwitchNow()` callback from App (conservative default).

## 5. Safety

- Actions are cosmetic only: no tools, no state changes, no physics writes.
- Outfit tint touches materials in memory only; re-import resets.
- Switching never deletes anything; active id validated `^[a-z0-9_-]{1,64}$`.
- Event payloads are plain JSON (no screenshots/secrets) per appEvents rule.

## 6. Acceptance

1. "Jump" → visible hop within a second; "wave" → right-hand wave.
2. "Change character" with 2 imports → different character + persists after restart.
3. "Dress blue" → clothes tint blue; "reset outfit" → original.
4. 45-min idle (simulated by seeding last-activity) → auto-switch, capped 2/day.
5. Unknown action ("fly") → lists valid actions, no crash.
6. `npm run lint` clean; suites green; no new console errors.
