# PRD: updater-v2 — opencode-style hybrid auto-update

## Why
Full 150MB downloads on every update are slow; size-only checks are weak.
opencode proves electron-updater (latest.yml + .blockmap + sha512) is the
fast, secure standard. ABxAG keeps its unique powers (any-version switch,
mirror fallback) by going hybrid instead of replacing everything.

## What
- PRIMARY (latest, packaged builds): electron-updater differential
  download (only changed blocks) with built-in sha512 verification and
  `quitAndInstall` (silent for installed builds).
- KEEP: custom full-download for older versions + mirror fallback +
  portable wizard flow. Renderer contract (`updates:event`, `updates:*`)
  unchanged — no UI work.
- Build emits `latest.yml` + `.blockmap` via `publish: github` config.
- `releases.json` stays (website + mirror metadata).

## Not in scope
Code-signing cert, portable auto-update, NSIS setting changes.

## Verify
9 updater tests (incl. differential stage, fallback, silent install),
tsc, full suites, CI. Differential end-to-end proven at next release
smoke test (needs a published latest.yml).
