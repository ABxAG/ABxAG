# Plan: updater-v2

1. `package.json`: add `electron-updater` (v6, matches electron 43).
2. `electron-builder.public.yml`: `publish: {provider: github, owner: ABxAG,
   repo: ABxAG}` → build emits `latest.yml` + `.blockmap` automatically.
3. `electron/updates.cjs`:
   - lazy-require electron-updater (custom path works without the dep);
   - `check()`: after feed parse, if latest newer AND packaged AND
     electron-updater present → differential path with progress events;
     on any updater error → fall back to custom full download;
   - `installDownloaded()`: if differential staged → `quitAndInstall()`;
     else existing NSIS flow;
   - `createUpdater()` accepts injected `autoUpdater` for tests.
4. `tests/updaterInstall.test.ts`: fast-path (mock), fallback on updater
   error, custom path unchanged.
5. `PRD/updater-v2.md`. Verify: lint, tests, node --check, commit, push, CI.
