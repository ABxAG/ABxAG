# Spec: animated-ui

## 1. BootSequence (`src/components/BootSequence.tsx`)
- Full-screen `z-100` overlay, `bg-[#020205]/95` + backdrop blur.
- Staggered boot lines (each ~260ms): kernel, holographics, neural link,
  voice grid, memory core, `SYSTEM ONLINE` (cyan).
- Neon progress bar 0→100% over the sequence; total ~2.4s then fade out.
- Dismiss early on click or any key. `onDone` callback to unmount.
- Under `prefers-reduced-motion`: render `null` immediately (no flash).

## 2. CommandPalette (`src/components/CommandPalette.tsx`)
- Props: `{ open: boolean; onClose(): void; commands: CommandDef[] }`.
- Floating centered glass panel (`cyber-panel`), input with mono font,
  filtered rows with icon + title + hint, active row highlighted.
- Keys: ArrowUp/Down move, Enter runs `cmd.run()` + closes, Esc closes.
- Rendered inside `AnimatePresence` by the parent; uses `motion.div`
  scale/fade (0.16s). Click on backdrop closes.
- `CommandDef = { id, title, hint?, keywords?, run(): void }` lives in the
  pure lib so tests import zero React.

## 3. Pure logic (`src/lib/commandPalette.ts`)
- `fuzzyScore(query, text)`: subsequence match, higher score for prefix and
  consecutive runs, word-boundary bonus. Empty query scores 0 (keep order).
- `filterCommands(query, commands)`: score title + keywords, drop misses,
  stable sort by score desc.
- `moveSelection(index, delta, length)`: clamped/wrapping navigation
  (wraps around, safe on length 0 → -1).

## 4. CSS system (`src/index.css`)
- Keyframes: `cyber-scan` (vertical light sweep), `grid-drift`
  (background-position pan), `neon-pulse` (text/box glow), `boot-bar`
  (width 0→100%), `caret-blink`.
- Utilities: `.cyber-panel` (glass + neon edge), `.cyber-scanlines`
  (repeating gradient overlay), `.neon-text-cyan`, `.animate-grid-drift`.
- Everything animated gated behind
  `@media (prefers-reduced-motion: no-preference)`.

## 5. App wiring
- `showBoot` state true on mount → `<BootSequence onDone={...}/>`; global
  `keydown`: `Ctrl/Cmd+K` toggles palette (ignore when typing in inputs).
- Commands (~10): Character Studio, Settings sections (general/ai/character/
  voice?), Recalls, Topics, Share screen toggle, API keys, pause/resume
  sharing. Only existing setters — verify section ids against
  `SettingsPanel` before wiring.
