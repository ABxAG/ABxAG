# PRD — About Links + In-App Updates + Version Switching

**Status:** approved for implementation · **App:** ABxAG 1.1.1 · **Date:** 2026-10-10

## 1. Goal

Settings → About becomes the user's home base for identity, web presence and
app updates:

1. Visible links to the website, mirror, source and releases.
2. Auto **or** manual updates (user's choice, persisted).
3. Switching between old and new versions at any time (upgrade + rollback).

## 2. About section (renderer, `SettingsPanel` → new `AboutUpdates` component)

| Row | Content |
|---|---|
| Version | `__APP_VERSION__` (build-time, from package.json) |
| Website | `https://abxag.absup.dev` — opens in the system browser |
| Mirror | `https://abxag.pages.dev` — opens in the system browser |
| Source | `https://github.com/ABxAG/ABxAG` |
| AI / PC control | existing rows, unchanged |

Links open via the main process (`shell.openExternal`), never inside the app
window.

## 3. Update model

### 3.1 Source of truth — GitHub Releases (`ABxAG/ABxAG`)

Each release carries two Windows assets:

- `ABxAG-Setup-<version>.exe` (NSIS installer — the install path)
- `ABxAG-Portable-<version>.exe` (informational; shown but not auto-installed)

The main process queries
`https://api.github.com/ABxAG/ABxAG/releases?per_page=20`
(User-Agent header required) and parses
`{ version(tag), name, notes(body), publishedAt, setupAsset{name,url,size} }`.

### 3.2 Preference — `settings.updates.mode`

```ts
updates: { mode: "auto" | "manual" }   // default: "auto"
```

Added to `settings/appSettings.ts` (+ normalize) and mirrored in
`src/lib/appApi.ts`. Rides the existing `/api/app-settings` plumbing, so no
new settings infrastructure.

### 3.3 Behaviour

| Mode | Behaviour |
|---|---|
| `auto` | Check on startup (after backend ready) + every 6h. A newer version downloads in the background; the user is notified and restarts/installs when ready. |
| `manual` | Nothing happens until the user presses **Check for updates**. |

States: `idle → checking → up-to-date | update-available → downloading(%) → downloaded → installing → error(message)`.
Events stream to the renderer over IPC (`updates:event`).

### 3.4 Install / switch

- **Install** = download the target version's `Setup` asset to the OS temp
  dir (progress %), then launch it and quit the app. The NSIS installer
  uninstalls the current copy first, so the same flow works for **upgrade
  and downgrade**.
- **Version list** = every release from the API with per-row **Switch**
  button (current version shows “current” badge, no button).
- Portable-mode installs are out of scope: the Setup installer is always the
  vehicle (noted in the UI note).

### 3.5 Failure & safety

- Offline / API errors → `error` state with retry; never blocks startup.
- Downloads are size-checked against the asset metadata; partial files are
  deleted.
- Asset URLs are restricted to `github.com` / `*.githubusercontent.com`.
- No silent downgrade: switching to an older version always shows an
  explicit confirm (“installs over the current copy, the app restarts”).
- Dev browser mode (`npm run dev`, no Electron bridge): update controls are
  hidden; the version list degrades to external GitHub download links.

## 4. Files

| File | Change |
|---|---|
| `settings/appSettings.ts` | `updates.mode` + default + normalize |
| `src/lib/appApi.ts` | mirror type |
| `electron/updates.cjs` | **new** — check/download/install state machine |
| `electron/main.cjs` | wire module, IPC handlers, auto-check hooks |
| `electron/preload.cjs` | `window.abxag.updates` bridge |
| `src/lib/updatesBridge.ts` | **new** — typed bridge + no-Electron fallback |
| `src/components/AboutUpdates.tsx` | **new** — About links + updater UI |
| `src/components/SettingsPanel.tsx` | about section renders `AboutUpdates` |

## 5. Acceptance

1. About shows Version + 4 links; links open externally.
2. Manual mode: Check → newer v1.1.2 (fixture/future) appears → Update → progress → installer launches, app quits.
3. Auto mode: same flow without pressing Check.
4. Version list shows old + new releases; Switch to older installs it.
5. Offline: friendly error + retry, app unaffected.
6. `npm run lint` clean; existing test suites green.
