# Spec: lightfast (lightweight & fast)

User order (2026-10-16): make ABxAG as lightweight & fast as possible.

## 1. Measured baseline (v1.1.17 installer, win-unpacked)

- `resources/app/node_modules` = **141MB** — ships build-only trees:
  `tailwindcss`, `@tailwindcss/*`, `@vitejs/*`, `lightningcss`,
  `@babel/*`, `browserslist`, `jiti`, `@types/*`. Pruning works (pure
  devDeps like `typescript`/`esbuild` are absent); these are present only
  because `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite` sit in
  `dependencies`, yet the packaged backend (`NODE_ENV=production`) never
  executes the lazy `import("vite")` (server.ts dev-guard + main.cjs env).
- `locales/` = **49MB / 55 files** (~1.5MB per locale pak). App UI is
  English-only; Chromium falls back to en-US.
- Rest: agent 50MB (frozen Python, out of scope), dist 6MB (already
  code-split: three/character/FBX/GLTF chunks), assets 6.5MB, server.cjs
  0.84MB, Electron core (~85MB, untouched).
- Boot: `apiHub.initialize()` reads local JSON only (no boot network);
  backend `listen` precedes agent spawn. Baseline production boot timed in
  plan step 4 and compared after.

## 2. Changes

1. **Deps → devDeps**: `vite` (drop from `dependencies`, keep dev),
   `@vitejs/plugin-react`, `@tailwindcss/vite` via
   `npm install --save-dev` (correct lockfile bookkeeping). Nothing at
   runtime requires them (`vite.config.ts` + CSS build only).
2. **Strip locales in `afterPack`** (runs for every pack): delete all
   `*.pak` under `<appOutDir>/locales` except `en-US.pak`. Expected ≈ −47MB.
3. **Boot**: measure `node dist/server.cjs` (NODE_ENV=production) time to
   `server started` before/after; fix only an obvious blocker if one shows
   (time-boxed — no refactor).

## 3. Non-goals

- No asar change, no UPX, no dependency upgrades, no model/asset
  recompression, no Linux change, no release/feed change in this track.
- No behaviour change: same tools, same UI, same updater. Packaged prod
  boot smoke (`/api/config`) must pass after the dep move.

## 4. Acceptance

- `npm run lint` clean; full suites green.
- `npm run dist:public` succeeds; Setup exe ≥30% smaller than 1.1.17’s
  156MB; `node_modules` in the package no longer contains
  `tailwindcss`/`@vitejs`/`@tailwindcss`/`lightningcss`; `locales/` holds
  only `en-US.pak`.
- Packaged `dist/server.cjs` boots under plain node (no vite present) and
  answers `/api/config`; production boot time not regressed vs baseline.
