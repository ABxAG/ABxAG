# Plan: lightfast

## Steps (in order)

1. **Baseline boot**: `node dist/server.cjs` (NODE_ENV=production,
   own PIDs on :47130/:8765, kill after) → record time-to-listen.
2. **Dep move**: `npm install --save-dev vite @vitejs/plugin-react
   @tailwindcss/vite` (off DEV? no — same tree, commit with the track).
   Sanity: `npm run build` still works; grep no runtime `require` of them
   outside `vite.config.ts`/CSS pipeline.
3. **afterPack locale strip**: keep `en-US.pak`, delete the rest (win32
   only, after the rcedit stamp; log bytes saved).
4. **Rebuild + measure**: `npm run dist:public` → compare Setup size vs
   156MB; assert pruned trees/locales absent; packaged-server boot smoke
   (`/api/config` 200, no `vite` resolvable) + boot-time comparison.
5. **Suites + PR** (DEV only, no release).

## Risks

- electron-builder dep tracing could still pull a moved tree if something
  requires it — step 4 asserts absence, build fails the track otherwise.
- Locale strip: only Chromium UI language packs; app content, spellcheck
  dictionaries (separate), and notifications unaffected. Reversible.
- `npm install` may churn the lockfile — review `git diff
  package-lock.json` before committing; keep only the move hunks if it
  explodes (hand-edit fallback).
