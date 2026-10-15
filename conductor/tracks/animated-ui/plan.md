# Plan: animated-ui

1. `src/lib/commandPalette.ts` (pure) + `tests/commandPalette.test.ts`;
   register the test file in `package.json` `test:agent`.
2. `src/components/BootSequence.tsx` + `src/components/CommandPalette.tsx`.
3. `src/index.css`: keyframes + utilities (reduced-motion gated).
4. `App.tsx`: mount boot, Ctrl+K listener, command list from existing
   setters (check `SettingsSection` ids first).
5. Verify: `npm run lint`, `npm run test:agent` (new file green),
   Playwright screenshots of dev preview states (`#boot`, `#palette`
   hash states in `ui-preview.html` flow) with zero console errors.
6. Land via PR (base DEV), merge on CI green.
