# Companion Resize Control (Hardened) — Track Index

## Track Information
- **Track ID:** `companion-resize-v29`
- **Target Version:** `v1.1.29`
- **Status:** `planned` → `in-progress` → `review` → `done`
- **Created:** 2026-10-25
- **Conductor:** @conductor-agent

## Files
- [Specification](spec.md) — Functional requirements, commands, acceptance criteria
- [Implementation Plan](plan.md) — File changes, test cases, verification checklist
- [Metadata](metadata.json) — Track metadata

## Scope
Hardened resize implementation for the desktop companion doll, replacing v1.1.26/27 logic with debounced, metrics-synced, boundary-safe, fully-tested code on v1.1.28 codebase.

## Key Improvements Over v1.1.26/27
1. **500ms debounce** — prevents rapid-fire resize spam
2. **Metrics-sync guarantee** — waits for renderer `floorY`/`halfWidthPx` before settle
3. **Atomic persistence** — ack animation only after `saveSettings` resolves
4. **Boundary logging** — clamp events logged at 0.4/2.5
5. **Bengali number parsing** — "১.৫" → 1.5
6. **Comprehensive tests** — 12 new test cases including debounce, boundaries, failure modes
7. **Cleanup on destroy** — no memory leaks

## Commands Supported
| Voice/Text | Command String | Effect |
|------------|----------------|--------|
| "boro koro" / "make larger" | `resize:+0.25` | +0.25 scale (max 2.5) |
| "choto koro" / "make smaller" | `resize:-0.25` | -0.25 scale (min 0.4) |
| "size 1.5" / "scale 150%" | `resize:1.5` | Absolute scale |
| "reset size" / "normal size" | `resize:reset` | Reset to 1.0 |

## Dependencies
- `electron/companion.cjs` — Core logic
- `voice/liveAgentTools.ts` — Voice command parsing
- `src/companion/CompanionApp.tsx` — Renderer metrics sync
- `electron/main.cjs` — Settings flow (no changes)
- `tests/companionResizeHardened.test.ts` — New test file

## Verification
- `npm run lint` clean
- `npm run test:agent` — all tests pass (129+ existing + 12 new)
- `npm run test:characters` — 8 pass + 1 skipped
- `npm run test:python` — 32 pass
- Manual smoke test via dev server + tray menu

## Next Steps
1. Implement per plan.md
2. Run full test suite
3. Create PRD
4. Release routine for v1.1.29