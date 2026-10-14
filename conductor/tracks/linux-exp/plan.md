# Plan: linux-exp

1. `server.ts`: platform guard at top of `spawnDesktopAgent()` (warn + log + return).
2. `electron-builder.linux.yml`: AppImage config (no agent extraResource).
3. `package.json`: add `dist:linux` script.
4. `.github/workflows/linux.yml`: ubuntu build + xvfb smoke + artifact upload.
5. Local verify: `npm run lint`, `node --check` touched `.cjs` (none), YAML
   sanity via python; full AppImage pack happens on the runner (cannot pack
   Linux targets from Windows).
6. Land via PR (base DEV), merge on CI green.
7. `gh workflow run linux.yml` on DEV, monitor to success, download artifact.
8. `gh release upload v1.1.15 <AppImage>` + append EXPERIMENTAL note to the
   release body (ASCII only), verify public download URL.
9. Register this track in `conductor/tracks.md`.
