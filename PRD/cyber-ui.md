# PRD: Cyberpunk UI, wave 2 (complements PR #19)

## Context
PR #19 already merged: boot overlay, Ctrl+K command palette, motion system
(`cyber-panel`, `cyber-scanlines`, `neon-text-cyan`, gated keyframes).
This wave adds ONLY what is missing — no duplicates, no rewrites:

1. **CyberFrame** — HUD frame overlay (corner brackets, hairlines, vignette,
   slow drifting grid). Reuses the existing `.cyber-scanlines` class.
2. **CommandDeck** — persistent floating orb panel (bottom-left, collapsed by
   default): live status, quick actions delegating to existing handlers,
   theme accent dots, SYS.LOG tail (runtime notices), shortcut hints.
   Complements the modal Ctrl+K palette; delegates, never duplicates logic.

## Non-goals
Second boot overlay, second palette, new backend endpoints, new dependencies,
any change to existing behavior.

## Acceptance
- `npm run lint` clean; `test:agent` (incl. new cyberpunk tests),
  `test:characters`, `test:python` green; `npm run build` succeeds.
- Reduced-motion users get a static frame + instant panel (no drift/pulse).
- Zero regressions: full suites run before/after.
