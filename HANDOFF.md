# ABxAG — Session Handoff Prompt (v1.1.15, DEV, updated 2026-10-15)

> Copy everything below the line into a new session. It contains the full
> project state, conventions, release routine, and hard-won gotchas.

---

You are continuing work on **ABxAG**, a private 3D AI desktop companion for
Windows. Repo root: `D:\ABxAG` (git, branch **DEV**, public
`github.com/ABxAG/ABxAG`). Current version **1.1.15**, feed
(`website/releases.json`) current with 15 releases. `gh` CLI is logged in as
**ABsUP**. Wrangler is logged in (account ABsUP.ORG); Cloudflare Pages
project `abxag` auto-deploys branch DEV (output dir `website/`, no build
command). Live site: `abxag.absup.dev` (+ mirror `abxag.pages.dev`).
Site pages (all PascalCase): `/DownLoad/`, `/RoadMap/` (+ `/`, static
`feed.js`/`anim.js`/`styles.css`, feed `releases.json`).

## 0. Safety rules (violating these broke things before)

1. **NEVER kill the user's installed app.** It runs from `D:\APPs\ABxAG`.
   `Get-Process -Name "abxag"` on Windows is CASE-INSENSITIVE and matches
   `ABxAG` too. Always match by full path (`$_.Path -like 'D:\ABxAG\...'`
   for test processes, never touch `D:\APPs\*`). If you must free ports,
   ask first. Kill ONLY PIDs you spawned yourself (verify via
   `Win32_Process.CommandLine` first). Never touch `pyright-langserver`
   (editor tooling) or any process you don't recognise.
2. **Test ports:** dev server `127.0.0.1:3000`, agent `:8765`, backend
   `47130+`, website previews `8901+` (pick a free one, kill YOUR server
   afterwards). Before any smoke test, confirm the port is free AND that
   the responder is YOUR process (stale agents on :8765 give false results
   — check `/tools` count or the startup log line `Loaded N desktop tools`).
3. **Never commit secrets.** `.pfx`/`.p12`/`csc-*.txt` are gitignored — keep
   it that way. No API keys in code (only test fixtures). `MODELS FOR ABxAG/`
   (licensed MMD zips) stays gitignored and local-only.
4. `D:\MarkLV` is a SEPARATE user project outside this repo — never `git add`
   it. `release-public/`, `agent_dist/`, `agent_build/`, `dist/`,
   `node_modules/`, `logs/` are gitignored build outputs.
5. `git status` shows ~200 phantom `M` files (line-ending stat noise,
   `core.autocrlf=true`). Verify reality with `git diff --numstat 2>$null`
   (empty = clean) and stage ONLY intended files explicitly — never `-A`.

## 1. Branding (exact)

- Display name everywhere (UI, titles, docs): exactly `ABxAG`.
- npm package name stays lowercase `abxag`; env prefix `ABxAG_`;
  Electron `appId: dev.absup.abxag`; agent exe `agent_dist/abxag/abxag.exe`;
  wake phrase default `"hey ab"`; logo `assets/ABxAG.jpg` (+ `build/icon.*`
  regenerated from it via PIL if missing).
- Site version pills live in `website/index.html` AND
  `website/RoadMap/index.html` — bump BOTH on release.
- afterPack stamps `ABxAG-runtime.exe` via the `rcedit` devDependency
  (note: `const { rcedit } = require('rcedit')` — named export).

## 2. Definition of done for every change

- `npm run lint` (tsc) clean; `node --check` any touched `.cjs`.
- Tests: `npm run test:agent` (add new `tests/*.test.ts` files to the
  `test:agent` script in package.json), `test:characters`, `test:python`
  (`python -m unittest discover -s desktop_agent -p "test_*.py"`).
- Python tool modules: import-safe (no side effects), covered by
  `desktop_agent/test_*.py`.
- Website changes: serve `website/` locally, screenshot desktop (1280) +
  mobile (390) via Playwright, console errors must be 0.
- Feature work gets a short PRD in `D:\ABxAG\PRD\` + a conductor track
  (`conductor/tracks/<id>/spec.md`, `plan.md`, registered in
  `conductor/tracks.md`).

## 3. Release routine (patch version X.Y.Z — every step, in order)

1. Bump: `package.json` + `package-lock.json` (TWO spots: root + `packages.""`)
   + `README.md` header + `website/index.html` (pill + `ver` span) +
   `website/RoadMap/index.html` (pill).
2. `npm run lint` + full tests (above).
3. If `desktop_agent/` RUNTIME modules changed (not just `test_*`): rebuild
   with `pyinstaller desktop_agent.spec --distpath agent_dist --workpath
   agent_build` (use `--noconfirm`; if new tools are missing from the exe:
   ① add module to `hiddenimports` in `desktop_agent.spec`, ② delete
   `agent_build/`+`agent_dist/` and rebuild clean, ③ verify via `/tools`
   count AND the `Loaded N desktop tools` log — beware stale agents
   squatting on :8765).
4. `npm run dist:public` → `release-public/ABxAG-Setup-<v>.exe` (+ Portable)
   + `latest.yml` + `.blockmap` (auto-emitted by the `publish: github`
   config — REQUIRED for differential updates).
5. Verify: exe FileVersionInfo = new version; runtime exe FileDescription =
   ABxAG; `electron-updater` present under `win-unpacked/.../node_modules`;
   fresh `dist/assets/index-*.js` newer than sources; portable smoke test by
   PID only (backend `:47130` OK, agent 84 tools, kill ONLY your tree
   afterwards).
6. `gh release create v<V> <setup> <portable> latest.yml <setup>.blockmap
   --title "ABxAG v<V>" --notes "<New / Fixed sections>" --target DEV`;
   then `git add` (intended files only, NOT `-A`) `&& git commit && git push
   origin DEV`.
7. Refresh feed (NEVER via PowerShell `>` redirect — it writes UTF-16 and
   mojibakes non-ASCII!): fetch with `gh api ... | python` (subprocess bytes
   → decode UTF-8 → `json.dump(ensure_ascii=False)` → write UTF-8, no BOM),
   commit, push. Wait ~3 min, verify live
   (`abxag.absup.dev/releases.json` shows the new version). Pages redeploys
   automatically.

## 4. Current feature state (v1.1.15, all shipped + verified)

- **Dual-cursor REMOVED (DEV after v1.1.17):** the virtual mouse is deleted
  end to end (12 tools, overlay, endpoint, setting, prompt rule) — it broke
  reliable working. Frozen agent now carries **84 tools**; the AI uses the
  physical mouse with confirmations + emergency stop.
  Track: `conductor/tracks/dual-cursor-removal/` (old
  `conductor/tracks/dual-cursor/` kept as history).
- **updater-v2 hybrid:** `electron-updater` dep + `publish: github` in
  `electron-builder.public.yml`. Latest-version path = differential
  (sha512-verified, `quitAndInstall`); older-version/mirror/portable paths
  stay custom in `electron/updates.cjs` (renderer contract unchanged).
  `releases.json` kept as website + mirror feed. NO signing cert exists —
  SmartScreen behavior unchanged. Track: `conductor/tracks/updater-v2/`.
- **Website:** GDBx-style glass theme, live stats, versions preview,
  dual-cursor spotlight, `/DownLoad/` + `/RoadMap/` pages, Read-more
  toggles, markdown-lite notes, `anim.js` (hero entrance, gradient shimmer,
  IO reveal + 2.5s backstop, count-up, tilt, hamburger), scrollspy.
  Dual-shape feed parser shared with the app (`website/feed.js`).
  Since v1.1.15: hamburger works under Reduce Motion (PR #3 — menu IIFE
  must NEVER sit behind the reduced-motion gate); RoadMap redesigned
  (hero stats, alternating spine timeline with scroll-progress fill,
  era detail modals, per-era accent colors, rainbow spine — PRs #4,5,6,7);
  DownLoad redesigned (hero, 4 platform cards, requirements strip,
  install steps, FAQ accordion, feed-wired buttons — PR #11) + automatic
  OS detection (green glow + DETECTED badge + primary button, `?os=`
  override for testing, Android/iOS map to nothing — PR #13).
  macOS card is Planned/disabled (no macOS build exists — never fake it).
- **Linux experimental (v1.1.15 asset, NOT a release bump):**
  `ABxAG-1.1.15-experimental-linux.AppImage` (~170MB) attached to the
  existing v1.1.15 GitHub release. Built on ubuntu-latest via
  `.github/workflows/linux.yml` (manual dispatch): lint → AppImage pack →
  xvfb smoke (backend :47130 up, agent skipped, no agent blob/process).
  `server.ts spawnDesktopAgent()` refuses non-win32 with
  `AGENT_SPAWN_SKIPPED_NONWINDOWS`. `website/releases.json` + `latest.yml`
  deliberately UNTOUCHED (Windows updater safety). Track:
  `conductor/tracks/linux-exp/`. Agent stays Win32-native — no Linux port.
- **App animated UI (PR #19 other session + PR #20 here):** boot overlay,
  Ctrl+K command palette + motion system (`cyber-panel`, `cyber-scanlines`,
  `neon-text-cyan`); wave 2 adds HUD `CyberFrame` + floating `CommandDeck`
  orb (status, quick actions delegating to existing handlers, theme dots,
  SYS.LOG, shortcuts). Preview: `/ui-preview.html?boot=1|palette=1|deck=1`.
  Tracks: `conductor/tracks/animated-ui/`, `conductor/tracks/cyber-ui/`.
- **README** is big-OSS style now (badges, feature table, download matrix,
  contributing — PR #18). Version line kept for the release routine.
- **v1.1.15 release assets (5):** Setup exe, Portable exe, Setup blockmap,
  latest.yml, + experimental AppImage. Feed still lists Windows builds only.

## 5. Known environment quirks

- Anonymous `api.github.com` returns 404 on this network (even for public
  repos) — use authenticated `gh api`. The in-app updater + website already
  fall back to `abxag.absup.dev/releases.json`; asset downloads via
  `github.com` work fine.
- PowerShell 5.1 here: no `&&` (use `;`), quote paths with spaces.
  `>` redirect writes UTF-16 — never use it for JSON/site files (see §3.7).
- Windows file renames that change ONLY case need a two-step rename via a
  temp name (`git mv a a-tmp; git mv a-tmp A`), or TypeScript reports
  phantom case-conflict errors.
- Chrome auto-translate replaces DOM nodes: `anim.js` IO observers can lose
  their targets — the 2.5s backstop sweep covers it; never ship
  opacity:0 content without a non-IO fallback.
- Installed user data (logs to read for crash diagnosis):
  `%APPDATA%\ABxAG\logs\` (`crash.log`, `errors.log`). Known fixed crash:
  React #31 from rendering `task.result` objects raw — always render via
  `asText()` (`src/components/TaskHud.tsx`).
- Voice brain identity: creator is AB (ABsUP); links github.com/ABsUP,
  absup.pages.dev, x.com/ABsUPx, t.me/absups, web3.bio/absup (see IDENTITY
  block in `server.ts` finalInstructions).
- Larger context docs: `README.md`, `docs/COGNITIVE_ARCHITECTURE.md`,
  `PRD/` (per-feature PRDs), `conductor/`.
- **PARALLEL SESSIONS share this working tree** (learned 2026-10-14/15 the
  hard way): before ANY work, check `git log --oneline -5`, `git status`,
  and open PRs (`gh pr list`) — your task may already be done+merged
  (happened with animated UI = PR #19, roadmap color = PR #7, download
  redesign = PR #11: branches + PRs pre-existed). Never `git checkout -- .`
  blindly; inspect staged vs unstaged separately. Someone's `git rm`
  (staged deletions) once turned lint red — restore, don't pile on.
- **Windows PID recycling is real:** a `Start-Process` PID was reused by
  Notepad within seconds. ALWAYS verify `Win32_Process.CommandLine` before
  kill; kill ONLY your own (npx/tsx/python http.server YOU spawned).
- **Tool-harness limits:** every bash call = FRESH PowerShell session
  (`Start-Job` children die with it). `-RedirectStandard*` and
  `cmd /c start /b` get killed (`ChildProcess.kill`) — launch with plain
  `Start-Process` (no redirect) and poll in later calls. `npx tsx server.ts`
  needs 30–90s cold boot: poll in ONE loop call, don't assume 15s is enough.
- **Playwright screenshot races:** `scroll-behavior: smooth` + separate
  tool calls = screenshots of the WRONG section. Always scroll
  (`behavior: 'instant'`) + screenshot ATOMICALLY in one `run_code` block.
  `locator.click()` + smooth scroll can hit the WRONG card — use instant
  `scrollIntoView` + coordinate click for determinism.
- **File edits:** use the Edit tool ONLY. Shell `Set-Content` once collapsed
  a whole file to one line. The Write tool overwrites silently — a parallel
  session's file died this way; check `git log`/PRs first.
- **Shell quoting:** PowerShell mangles `node -e` with `$vars` and multi-arg
  `gh ... --jq` filters — stage temp `.js` files in
  `C:\Users\abisl\AppData\Local\Temp\opencode` instead.
- **Dev server writes runtime data to repo ROOT** (`secrets.json`,
  `secrets.v2.json`, `settings.json`, `memories.json`) — untracked AND not
  gitignored. NEVER `git add -A`; never commit them (a real Gemini key may
  sit inside). Proposed: add them to `.gitignore` (needs user approval).
- **Release/CI gotchas:** electron-builder defaults to `--publish always`
  → CI pack scripts need `-p never` (publish via `gh release upload`
  instead). AppImage CI needs `libfuse2` + `xvfb` + PIL-regenerated
  `build/icon.png` (gitignored). Dummy API keys get HTTP 400 from the
  backend (format-validated). `color-mix()` in site CSS is fine.
  `.ver-card > div { min-width: 0 }` fixes mobile grid-blowout overflow.
- Research chats (user-logged-in browser, read-only unless asked to post):
  Gemini `gemini.google.com/app/1739557deec52888` (ABxAG audit + site
  features), ChatGPT `chatgpt.com/c/6acbd4d2-c318-83e8-9884-d49b2a8438cb`
  (security audit + product-hub plan). Full improvement backlog was
  delivered in chat on 2026-10-11 — ask the user for it if planning new
  work (candidates: interactive demo, Security Center, SHA-256 download
  guide, docs hub, P0 IPC-auth hardening).

Start by confirming: version, `git status` (via `git diff --numstat`,
see §0.5), and restating what you will do.
Never start the release routine without explicit user approval for that version.

## 6. Standing auto-routine (user order, every fix)
After EVERY fix, automatically — no need to ask:
1. Verify (`npm run lint`, touched `.cjs` via `node --check`, `test:python`,
   website screenshots if touched).
2. Secret-scan the diff, then land via PULL REQUEST (no direct pushes):
   branch `feat/<x>` or `fix/<x>` or `chore/<x>` off DEV → `git add`
   (intended files only) → commit (repo identity ABsUP, message describes
   the change) → `git push -u origin <branch>` →
   `gh pr create --base DEV --fill` → wait for CI green →
   `gh pr merge --merge --delete-branch`.
   Direct push to DEV only for release-routine commits (bump/feed).
3. When applicable, use Actions/workflows: ABxAG's own `CI`
   (`.github/workflows/ci.yml`) runs on every PR and every push to DEV —
   merge only on green; after merging, check
   `gh run list --branch DEV --limit 3` and report green/red.
   Use `github.com/OpenCodeWEB/AiA` Actions only if the fix touches AiA.
4. Issues: file real bugs as GitHub issues and close them with the PR
   (`Fixes #n`) — real activity grows achievements, noise does not.
