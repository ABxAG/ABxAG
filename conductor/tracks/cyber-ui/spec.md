# Spec: cyber-ui (wave 2, complements PR #19)

## Deliberately NOT duplicated
PR #19 merged: boot overlay, Ctrl+K palette, `cyber-panel`,
`cyber-scanlines`, `neon-text-cyan`, gated keyframes. This track adds:

1. `src/lib/cyberpunk.ts` — pure helpers (unit-tested, zero shared symbols
   with `lib/commandPalette.ts`): `ACCENT_THEMES` (7 App theme colors),
   `accentGlow()`, `formatLogLine()` (string-only, React #31-safe),
   `SHORTCUTS` (incl. Ctrl+K).
2. `src/components/CyberFrame.tsx` — props `{ accent }`; HUD frame (corner
   brackets, hairlines, vignette, drifting grid); reuses existing
   `.cyber-scanlines`; pointer-transparent, aria-hidden.
3. `src/components/CommandDeck.tsx` — collapsed orb (default) → spring panel:
   live status, 7 quick actions delegating to existing App handlers, theme
   accent dots, SYS.LOG tail (runtime notices), shortcut hints.
4. `src/index.css` — only NEW unique class/keyframe names
   (`cyber-frame*`, `cyber-hline*`, `cyber-corner*`, `cyber-vignette`,
   `cyber-orb`, `cyber-frame-drift`, `cyber-orb-breathe`); motion gated
   behind `prefers-reduced-motion: no-preference` (+ explicit reduce block).
5. `tests/cyberpunk.test.ts`, wired into the `test:agent` script.
6. `src/App.tsx` — two mounts only (frame + deck); no handler/state changes.
