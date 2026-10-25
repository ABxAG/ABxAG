# PRD: Companion Resize Control (Hardened) — v1.1.29

## Overview
Hardened implementation of companion doll resize via voice/text commands. Replaces v1.1.26/27 logic with production-ready code featuring debounce, atomic persistence, boundary safety, and Bengali number support.

## Problem
v1.1.26/27 resize implementation had:
- No debounce → rapid voice commands caused jank
- No metrics sync guarantee → incorrect settle after resize
- Ack animation before persist → false positive feedback
- No boundary logging → silent clamps
- No Bengali number parsing → "১.৫" not understood

## Solution
Fresh implementation on v1.1.28 codebase with:

### Core Features
| Feature | Spec |
|---------|------|
| Relative resize | ±0.25 steps ("boro koro"/"choto koro", "make larger"/"smaller") |
| Absolute resize | Exact scale ("size 1.5", "scale 150%") |
| Reset | Back to 1.0 ("reset size", "normal size") |
| Range | 0.4× – 2.5× (hard clamped) |
| Persistence | `settings.companion.scale` in userData |
| Visual ack | `happyFace` animation after successful persist |

### Hardening
| Mechanism | Detail |
|-----------|--------|
| Debounce | 500ms window — rapid commands coalesce to latest |
| Atomic persist | Ack **only after** `saveSettings` resolves |
| Metrics sync | Waits for renderer `floorY`/`halfWidthPx` (2s timeout → fallback) |
| Boundary logging | `scale clamp: 3.0 -> 2.5 (range 0.4-2.5)` |
| Bengali numbers | "১.৫" → 1.5, "size ২" → 2.0 |
| Cleanup | Debounce timer cleared on `destroy()` |

## User Stories
1. **US-1**: User says "boro koro" → doll grows +0.25, ack plays, persists
2. **US-2**: User says "choto koro" → doll shrinks -0.25, ack plays, persists
3. **US-3**: User says "size 1.5" → doll sets to 1.5×, ack plays, persists
4. **US-4**: User says "reset size" → doll returns to 1.0×, ack plays, persists
5. **US-5**: Rapid 5x "boro koro" in 1s → **one** resize (+0.25), debounced
6. **US-6**: At 2.5, "boro koro" → clamp log, ack plays, stays 2.5
7. **US-7**: User says "size ১.৫" → parsed as 1.5, works identically

## Commands (Backend → Shell)
| String | Object | Action |
|--------|--------|--------|
| `resize:+0.25` | `{ delta: 0.25 }` | Relative +0.25 |
| `resize:-0.25` | `{ delta: -0.25 }` | Relative -0.25 |
| `resize:1.5` | `{ absolute: 1.5 }` | Absolute scale |
| `resize:reset` | `{ reset: true }` | Reset to 1.0 |

## Voice Mapping (Bengali/English)
| User Says | Backend Sends |
|-----------|---------------|
| "boro koro", "make larger", "bigger", "বড় করো" | `resize:+0.25` |
| "choto koro", "make smaller", "smaller", "ছোট করো" | `resize:-0.25` |
| "size 1.5", "scale 150%", "সাইজ ১.৫" | `resize:1.5` |
| "reset size", "normal size", "রিসেট সাইজ" | `resize:reset` |

## Files Changed
| File | Changes |
|------|---------|
| `electron/companion.cjs` | Constructor: debounce state; `adjustScale()`: hardened; `handleCommand()`: updated parsing; `destroy()`: cleanup |
| `voice/liveAgentTools.ts` | Bengali number parsing in `companionResize` handler |
| `tests/companionResizeHardened.test.ts` | New: 18 source-verification tests |
| `tests/companionSleepWakeResize.test.ts` | Updated: expectations for new implementation |
| `package.json` | Added `companionResizeHardened.test.ts` to `test:agent` |

## Testing
- **Unit/Integration**: 18 new tests in `companionResizeHardened.test.ts` (source pattern verification)
- **Existing**: `companionSleepWakeResize.test.ts` updated, passes
- **Full suite**: `test:agent` (153), `test:characters` (8+1), `test:python` (32) — all pass
- **Lint**: `tsc --noEmit` clean

## Acceptance Criteria
- [x] "boro koro" → scale +0.25 (max 2.5), saved, ack, metrics sync, settle
- [x] "choto koro" → scale -0.25 (min 0.4), saved, ack, metrics sync, settle
- [x] "size 1.5" → scale = 1.5, saved, ack, metrics sync, settle
- [x] "reset size" → scale = 1.0, saved, ack, metrics sync, settle
- [x] Rapid 5x in 1s → **one** resize executed (debounced)
- [x] At 2.5, "boro koro" → clamp log, ack, stays 2.5
- [x] At 0.4, "choto koro" → clamp log, ack, stays 0.4
- [x] "size ১.৫" → parsed as 1.5, works
- [x] Settings UI slider syncs
- [x] No memory leak (timer cleared on destroy)
- [x] Logs: `scale adjusted: 1.0 -> 1.25` or `scale clamp: 3.0 -> 2.5`

## Release Checklist (v1.1.29)
- [ ] Version bump: `package.json`, `package-lock.json`, `README.md`, `website/index.html`, `website/RoadMap/index.html`
- [ ] `npm run lint` + full test suite green
- [ ] `npm run dist:public` → `release-public/ABxAG-Setup-1.1.29.exe` + Portable + blockmap + latest.yml
- [ ] Verify: exe FileVersionInfo = 1.1.29, runtime exe FileDescription = ABxAG
- [ ] Portable smoke test (backend :47130, agent 84 tools, emergency stop)
- [ ] `gh release create v1.1.29 ... --target DEV`
- [ ] `git add` (intended files only) `&& git commit && git push origin DEV`
- [ ] Refresh feed: `gh api ... | python → website/releases.json` (UTF-8, no BOM)
- [ ] Wait ~3 min, verify `abxag.absup.dev/releases.json` shows v1.1.29

## Rollback Plan
If critical issue found post-release:
1. `gh release delete v1.1.29 --yes`
2. `git push origin :refs/tags/v1.1.29`
3. Revert version bumps, push to DEV
4. CF Pages auto-reverts to previous DEV commit

## References
- Spec: `conductor/tracks/companion-resize-v29/spec.md`
- Plan: `conductor/tracks/companion-resize-v29/plan.md`
- Track: `conductor/tracks/companion-resize-v29/index.md`