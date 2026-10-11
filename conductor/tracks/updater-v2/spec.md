# Spec: updater-v2 (opencode-style auto-update)

## Goal
Auto-update that is faster (differential), more secure (hash-verified),
and keeps ABxAG's unique powers: any-version switching + mirror fallback.

## Design: hybrid (both bots + research agree)
- PRIMARY (latest version): `electron-updater` — `latest.yml` feed from
  GitHub Releases, `.blockmap` differential download, built-in sha512
  verification, `quitAndInstall()` (silent for installed build).
- KEEP (any older version + mirror fallback): existing custom
  full-download path (`downloadVersion`/`installDownloaded`) untouched.
- Renderer contract UNCHANGED: same `updates:event` snapshots, same
  `updates:*` IPC. No UI changes needed.
- `releases.json` stays as website feed + mirror metadata (not deleted).

## Non-goals
- Code signing cert (none configured; SmartScreen behavior unchanged).
- Portable auto-update (portable keeps wizard flow, as today).
- Changing NSIS oneClick/perMachine settings.

## Risks
- electron-builder/updater version skew → pin both, CI runs install tests.
- `/S` silent semantics differ → silent ONLY via electron-updater path
  for the installed build; custom path keeps explicit /S as today.
- No-cert differential updates still work on Windows NSIS; verified at
  next release smoke test (not in this change).
