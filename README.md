# ABxAG 1.1.15 — source code

ABxAG is a private 3D AI companion for Windows: she talks with you by voice
(Google Gemini Live), can see your screen when you allow it, controls apps and
files on your PC, and lives on your desktop as a character you can drag onto
windows.

This pack is the full source. If you just want to use ABxAG, install the
setup .exe instead.

- 🌐 Website: https://abxag.absup.dev (Download · Roadmap · Versions)
- ⬇️ Download: https://abxag.absup.dev/DownLoad/
- 🗺️ Roadmap: https://abxag.absup.dev/RoadMap/
- 📦 All releases: https://github.com/ABxAG/ABxAG/releases

## What ABxAG does (v1.1.15)

- **Voice companion** — real-time conversation via Gemini Live, “Hey AB” wake
  word, reminders & alarms, quiet hours.
- **Eyes** — screen vision + OCR; screen text is always treated as untrusted data.
- **Hands** — 96 local PC tools (apps, files, input, browser, clipboard) gated
  by confirmations, an emergency stop and a permission board.
- **Dual-cursor co-pilot** — her own neon-red virtual cursor works in background
  windows while your mouse stays 100% yours (`Ctrl+Alt+P` pauses; Settings →
  PC control & safety → Virtual AI cursor turns her off completely).
- **Memory & mind** — local cognition runtime: episodic memory, goals, learned
  skills, curiosity and presence.
- **Body** — three.js character engine; import any `.pmx / .vrm / .glb / .fbx /
  .obj` model, `.zip` or folder (Character Studio included).
- **Auto-update** — hybrid updater: fast differential installs for the current
  version, one-click switch to any older version, mirror-feed fallback.

## What is NOT included (on purpose)

- **No API key.** You use your own free Gemini key from https://aistudio.google.com.
- **No 3D character model.** The models used while developing ABxAG have licences that forbid
  redistribution. Import your own MMD model (.pmx, or a .zip / folder containing one) in the app:
  the first screen offers **Import my character**, or use Settings → Character → Character Studio.
  Only use models whose licence allows your use.
- No personal data, logs, memories or settings.

## Requirements

- Windows 10 or 11 (64-bit)
- Node.js 20 or newer (https://nodejs.org)
- Python 3.11+ (only to run or rebuild the desktop agent from source)
- 🐧 Linux: experimental AppImage exists (v1.1.15 release asset, no PC control).
  macOS is planned, not available yet.

## Run it in development

```
npm install
pip install -r desktop_agent/requirements.txt
npm run dev
```

Open http://localhost:3000 in Chrome. The first screen asks for your Gemini API key
(stored encrypted with Windows DPAPI in your user data folder, never in the project).

Desktop app (Electron, with the desktop companion):

```
npm run app
```

Optional: copy `.env.example` to `.env` for development settings. Do not put a real key in a file
you share.

## Tests

```
npm run lint            # tsc --noEmit
npm run test:agent      # Node agent/character/presence/updater suites
npm run test:characters
npm run test:python     # python -m unittest discover -s desktop_agent -p "test_*.py"
```

CI (`.github/workflows/ci.yml`) runs lint + Electron syntax checks + Python
agent tests on every PR and every push to DEV — merge only on green. A manual
`Linux` workflow builds + smoke-tests the experimental AppImage.

## Build the installer

1. Build the desktop agent (PyInstaller):
   ```
   pip install pyinstaller
   pyinstaller desktop_agent.spec --distpath agent_dist --workpath agent_build --noconfirm
   ```
2. Build the public installer (no bundled character):
   ```
   npm run dist:public
   ```
   Output: `release-public/ABxAG-Setup-<version>.exe` (+ Portable, `latest.yml`,
   `.blockmap` for differential updates).

`npm run dist` (electron-builder.yml) expects a character in `assets/characters/`, which is not
included; use `dist:public`. `npm run dist:linux` packs the experimental Linux
AppImage (built on Ubuntu; the desktop agent stays Windows-only and is skipped).

Releases follow `HANDOFF.md` §3 (bump → lint/tests → rebuild → pack → verify →
`gh release` → feed refresh). Fixes land via pull request, never direct push
(see `HANDOFF.md` §6 and `.github/`).

## Project map

| Folder | What it is |
|---|---|
| `src/` | React UI, the 3D character engine (three.js, MMD/PMX), desktop companion renderer |
| `electron/` | Desktop shell: windows, tray, desktop companion brain, crash recovery, updater |
| `server.ts`, `runtime/` | Local backend (Express + WebSocket), Gemini Live bridge |
| `agent/` | PC-control agent: planner, actions, WhatsApp/chat helpers, safety checks |
| `desktop_agent/` | Python tool server (UI Automation, input, files, apps) |
| `models/` | Model router (Gemini and others) |
| `voice/` | Live voice tools |
| `settings/`, `permissions/`, `secrets/` | Settings, permission engine, DPAPI key store |
| `character_import/` | PMX importer and capability report |
| `cognition/`, `memory/`, `presence/` | Memory, initiative and presence |
| `api_hub/` | 2000+ provider catalogue + adapters |
| `website/` | Static site (Home, DownLoad, RoadMap) deployed to Cloudflare Pages |
| `PRD/`, `conductor/` | Per-feature PRDs, specs/plans/tracks registry |

## Graphics quality

Settings → Character → Graphics quality: Auto, High, Medium, Optimized, Potato PC.
Auto steps down by itself if the character crashes on a weak GPU.

## Safety

- The API key never reaches the web page; all Gemini calls go through the local backend.
- High-risk actions (sending messages, deleting, installing, purchases) ask for confirmation.
- Text from websites, documents and the screen is treated as untrusted data.
- Stop everything any time with the emergency shortcut (default Ctrl+Alt+Shift+S).
- The virtual AI cursor has its own kill switch (Settings → PC control & safety);
  OFF means off — enforced in the backend, overlay hidden too.
