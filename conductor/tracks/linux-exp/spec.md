# Spec: Experimental Linux build (v1.1.15)

## Background
ABxAG is Windows-native: the Python desktop agent needs pywin32/pywinauto/
pycaw/winrt (see `desktop_agent/requirements.txt`), the Electron shell has
`win32.cjs` (koffi FFI) + a C# launcher, and releases are NSIS/Portable.
A full Linux port is out of scope. What ships here is a clearly labelled
EXPERIMENTAL build: chat/voice/memory UI + local backend work; **PC control
(desktop agent) is unavailable on Linux** and the backend must degrade
gracefully (it already tolerates an unreachable agent via
AGENT_UNREACHABLE paths).

## Requirements
1. `electron-builder.linux.yml`: AppImage x64, output `release-linux/`,
   same files as the public build (no character models), NO Windows agent
   blob, `build/icon.png` icon.
2. `server.ts` `spawnDesktopAgent()`: on `process.platform !== 'win32'`,
   skip spawning entirely, warn + `logError('AGENT_SPAWN_SKIPPED_LINUX...')`,
   return. Never attempt frozen `.exe` or uvicorn agent on Linux.
3. `package.json` script `dist:linux` for the Linux pack.
4. `.github/workflows/linux.yml` (GitHub-hosted `ubuntu-latest`,
   `workflow_dispatch` only): npm ci → lint → build → AppImage pack →
   headless smoke test under `xvfb-run` (backend :47130 responds, agent
   correctly skipped, zero page errors) → upload AppImage artifact.
5. Release: attach the AppImage to the EXISTING `v1.1.15` GitHub release as
   `ABxAG-1.1.15-experimental-linux.AppImage` with an EXPERIMENTAL note.
   NEVER touch `website/releases.json` / `latest.yml` (Windows updater).

## Non-goals
Porting the desktop agent, DEB/RPM repos, auto-update for Linux, version bump.
