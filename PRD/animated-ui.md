# PRD: Animated cyberpunk UI (desktop app)

## Goal
Make the ABxAG desktop window feel alive on sight: a short cyberpunk boot
sequence, smooth floating-panel motion, and a developer-friendly command
palette — without touching voice/agent/cognition behavior.

## Scope (new files + thin wiring only)
1. `src/components/BootSequence.tsx` — full-screen overlay: staggered system
   lines, neon progress bar, `ABxAG // SYSTEM ONLINE`. Auto-dismiss ~2.4s,
   skippable (click / any key). Renders nothing under
   `prefers-reduced-motion`.
2. `src/components/CommandPalette.tsx` — floating glass palette (`Ctrl+K`):
   fuzzy-filtered quick actions (Character Studio, Settings sections,
   Recalls, Share screen, API keys, theme sways, pause/resume sharing).
   Keyboard: Up/Down/Enter/Esc. Read-only navigation — every command maps to
   an existing UI toggle, no new side effects.
3. `src/lib/commandPalette.ts` — framework-free pure logic (fuzzy filter +
   selection movement) so it is unit-testable under plain `node:test`.
4. `src/index.css` — cyberpunk keyframes (scan sweep, grid drift, neon pulse,
   boot bar, caret blink) + `.cyber-*` utilities. All motion lives under
   `@media (prefers-reduced-motion: no-preference)`; static styles by default.
5. `App.tsx` wiring only: mount boot overlay on launch, global `Ctrl+K`
   listener, pass ~10 commands from existing setters.

## Non-goals
No behavior change to voice, agent, updater, settings storage, or themes.
No new dependencies (`motion` + `lucide-react` already in use).

## Acceptance
- `npm run lint` clean; new `tests/commandPalette.test.ts` green and added
  to the `test:agent` script.
- Boot overlay dismisses by itself and on click/key; palette opens with
  Ctrl+K, filters as you type, Enter runs, Esc closes.
- Playwright screenshots (dev ui-preview states) with zero console errors.
- Reduced-motion: no boot overlay, no ambient animation, everything usable.
