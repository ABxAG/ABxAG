# Plan: cyber-ui

1. Helpers + tests + package.json script entry.
2. CyberFrame + CommandDeck components.
3. index.css additions (unique names only).
4. App.tsx mounts (frame after boot block, deck with existing handlers).
5. Verify: `npm run lint`, `test:agent` (full), `test:characters`,
   `test:python`, `npm run build`, ui-preview screenshots
   (`/ui-preview.html?boot=1`, `?palette=1` still work; deck orb visible).
6. Land via PR #20 (base DEV), merge on CI green.
