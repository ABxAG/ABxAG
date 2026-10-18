# ABxAG — Session Handoff Prompt (v1.1.18, DEV, updated 2026-10-17)

> Copy everything below the line into a new session. It contains the full
> project state, conventions, release routine, and hard-won gotchas.

---

You are continuing work on **ABxAG**, a private 3D AI desktop companion for
Windows. Repo root: `D:\ABxAG` (git, branch **DEV**, public
`github.com/ABxAG/ABxAG`). Current version **1.1.18**, feed
(`website/releases.json`) current with 18 releases. `gh` CLI is logged in as
**ABsUP**. Wrangler is logged in (account ABsUP.ORG); Cloudflare Pages
project `abxag` auto-deploys branch DEV (output dir `website/`, no build
command). Live site: `abxag.absup.dev` (+ mirror `abxag.pages.dev`).
Site pages (all PascalCase): `/DownLoad/`, `/RoadMap/` (+ `/`, static
`feed.js`/`anim.js`/`styles.css`, feed `releases.json`).
Recent history: PR #22 HUD overlay → v1.1.16 → PR #23 site docs (parallel
session) → PR #24 hologram fix → v1.1.17 → PR #25 dual-cursor removal →
PR #26 lightfast → v1.1.18.

## 0. Safety rules (violating these broke things before)

1. **NEVER kill the user's installed app.** It runs from `D:\APPs\ABxAG`.
   `Get-Process -Name "abxag"` on Windows is CASE-INSENSITIVE and matches
   `ABxAG` too. Always match by full path (`$_.Path -like 'D:\ABxAG\...'`
   for test processes, never touch `D:\APPs\*`). If you must free ports,
   ask first. Kill ONLY PIDs you spawned yourself (verify via
   `Win32_Process.CommandLine` first). Never touch `pyright-langserver`
   (editor tooling) or any process you don't recognise.
   NOTE (2026-10-16, twice): a fresh `ABxAG-Setup-<v>.exe` appears RUNNING
   (parent = explorer.exe) right after every `dist:public` build — the user
   launches it manually. It is NOT yours: never touch it.
2. **Test ports:** dev server `127.0.0.1:3000`, agent `:8765`, backend
   `369`, website previews `8901+` (pick a free one, kill YOUR server
   afterwards). Before any smoke test, confirm the port is free AND that
   the responder is YOUR process (stale agents on :8765 give false results
   — check `/tools` count or the startup log line `Loaded N desktop tools`).
   Portable smoke boots SLOW (up to ~4 min cold): poll, don't assume.
   Before killing a tree, enumerate descendants via ParentProcessId and
   verify EACH CommandLine (never `D:\APPs\*`, never `ABxAG-Setup*`).
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
  (note: `const { rcedit } = require('rcedit')` — named export). afterPack
  also strips non-en-US locales (~46MB) + non-win32_x64 koffi triplets
  (~24MB); gate any new prune on `electronPlatformName === 'win32'` so the
  Linux CI pack keeps everything.

## 2. Definition of done for every change

- `npm run lint` (tsc) clean; `node --check` any touched `.cjs`.
- Tests: `npm run test:agent` (99 tests: add new `tests/*.test.ts` files to
  the `test:agent` script in package.json — precedent: `overlaySettings`,
  `hudHologram`), `test:characters` (8 pass + 1 skipped),
  `test:python` (32 tests: `python -m unittest discover -s desktop_agent
  -p "test_*.py"`).
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
   with `python -m PyInstaller desktop_agent.spec --distpath agent_dist
   --workpath agent_build --noconfirm` (bare `pyinstaller` may be a broken
   shim — `python -m` always works; `pip show pyinstaller` to confirm).
   If tools are missing from the exe: ① add module to `hiddenimports` in
   `desktop_agent.spec`, ② delete `agent_build/`+`agent_dist/` and rebuild
   clean, ③ verify via `/tools` count AND the `Loaded N desktop tools`
   log — beware stale agents squatting on :8765. Current frozen agent:
   **84 tools, zero virtual names**.
4. `npm run dist:public` → `release-public/ABxAG-Setup-<v>.exe` (+ Portable)
   + `latest.yml` + `.blockmap` (auto-emitted by the `publish: github`
   config — REQUIRED for differential updates). Since v1.1.18 the Setup is
   ~130MB (was ~156MB): node_modules 141→33MB in the package.
5. Verify: exe FileVersionInfo = new version; runtime exe FileDescription =
   ABxAG; `electron-updater` present under `win-unpacked/.../node_modules`;
   fresh `dist/assets/index-*.js` newer than sources; portable smoke test by
   PID only (backend `:369` (`abxag:369`) OK, agent 84 tools, emergency stop OK via
   `POST /api/autonomy/stop`, kill ONLY your tree afterwards).
6. `gh release create v<V> <setup> <portable> latest.yml <setup>.blockmap
   --title "ABxAG v<V>" --notes "<New / Fixed sections>" --target DEV`;
   then `git add` (intended files only, NOT `-A`) `&& git commit && git push
   origin DEV`.
7. Refresh feed (NEVER via PowerShell `>` redirect — it writes UTF-16 and
   mojibakes non-ASCII!): fetch with `gh api ... | python` (subprocess bytes
   → decode UTF-8 → `json.dump(ensure_ascii=False)` → write UTF-8, no BOM),
   commit, push. Wait ~3 min, verify live
   (`abxag.absup.dev/releases.json` shows the new version; plain urllib may
   403 on bot protection — verify with the Playwright request API or the
   mirror). Pages redeploys automatically.
8. **Lockfile landmines (learned v1.1.18):** plain `npm install` can FAIL
   (eresolve: installed `@vitejs/plugin-react@5.2.0` vs registry drift to
   v6 wanting vite ^8) → use exact locked versions with
   `--legacy-peer-deps`. That re-resolution can SILENTLY DROP 13 optional
   entries (squirrel-windows, winstaller, windows-sign, …) → `npm ci` (CI)
   fails "Missing from lock file". After any `npm install`, run the
   lock-diff check (worktree lock vs base: 0 version changes expected) and
   `npm ci --dry-run --ignore-scripts` to prove sync BEFORE pushing.

## 4. Current feature state (v1.1.18, all shipped + verified)

- **Hands (physical mouse only):** dual-cursor is DELETED end to end (12
  tools, overlay, endpoint, setting, prompt rule — removal broke nothing;
  old `conductor/tracks/dual-cursor/` kept as history). Frozen agent: **84
  tools**. The AI uses clickText/exact labels, yields on user input,
  confirmations + emergency stop (`Ctrl+Alt+Shift+S`).
  Track: `conductor/tracks/dual-cursor-removal/`.
- **HUD overlay (ZORION-style, Settings → Overlay, default OFF,
  `Ctrl+Alt+O`):** 9 widgets (status, mic, task, hologram, system, clock,
  emergency, conversation, quick). Avatar is a local 40fps 2D hologram
  (pointer eye-track + wander + blink, speaking/listening mouth, static
  frame under reduced-motion) — the earlier 3D-canvas IPC mirror never
  delivered frames and was replaced. Conversation falls back to
  `GET /api/logs/commands`; mic shows LINK IDLE until the app links.
  Shell: `electron/hud-overlay.cjs` + preload `abxag.hud` bridge.
  Track: `conductor/tracks/zorion-overlay/`.
- **Lightweight installer (v1.1.18):** build-only + frontend-only trees
  moved to devDependencies (vite, @vitejs, @tailwindcss, react, three,
  motion, lucide, mmd-parser — NOTHING requires them at runtime; server
  externals are only express/ws/dotenv/koffi/@google/genai/electron-updater),
  locales en-US-only, koffi win32_x64-only. node_modules 141→33MB, Setup
  156→130MB, prod boot 7.3s→2.3s. Track: `conductor/tracks/lightfast/`.
- **updater-v2 hybrid:** `electron-updater` dep + `publish: github` in
  `electron-builder.public.yml`. Latest-version path = differential
  (sha512-verified, `quitAndInstall`); older-version/mirror/portable paths
  stay custom in `electron/updates.cjs` (renderer contract unchanged).
  `releases.json` kept as website + mirror feed. NO signing cert exists —
  SmartScreen behavior unchanged. Track: `conductor/tracks/updater-v2/`.
- **Website:** GDBx-style glass theme, live stats, versions preview,
  `/DownLoad/` + `/RoadMap/` pages, Read-more toggles, markdown-lite notes,
  `anim.js` (hero entrance, gradient shimmer, IO reveal + 2.5s backstop,
  count-up, tilt, hamburger), scrollspy. Dual-shape feed parser shared
  with the app (`website/feed.js`). OS auto-detect + `?os=` override.
  macOS card is Planned/disabled (no macOS build exists — never fake it).
  NOTE: a parallel session is actively rewriting site content (HUD section
  removed, dual-cursor wording in flux) — do NOT touch `website/` without
  checking `git status` + asking the user.
- **Linux experimental (v1.1.15 asset, NOT a release bump):**
  `ABxAG-1.1.15-experimental-linux.AppImage` attached to the v1.1.15
  GitHub release; feed/`latest.yml` untouched (Windows updater safety).
  Track: `conductor/tracks/linux-exp/`. Agent stays Win32-native.
- **App animated UI:** boot overlay, Ctrl+K palette + motion system;
  wave 2 HUD `CyberFrame` + floating `CommandDeck` orb. Preview:
  `/ui-preview.html?boot=1|palette=1|deck=1`. Tracks: `animated-ui/`,
  `cyber-ui/`.
- **README** big-OSS style; version line kept for the release routine.
- **Release assets (4 each, v1.1.16+):** Setup exe, Portable exe, Setup
  blockmap, latest.yml. Feed lists Windows builds only.

## 5. Known environment quirks

- Anonymous `api.github.com` returns 404 on this network (even for public
  repos) — use authenticated `gh api`. Asset downloads via `github.com`
  work fine.
- PowerShell 5.1 here: no `&&` (use `;`), NO `||`, NO `awk/sed/tail/head`
  (use `Select-Object`), quote paths with spaces. `>` redirect writes
  UTF-16 — never use it for JSON/site files (see §3.7). Bare `echo;`
  FAILS (needs an argument). `Out-File` writes UTF-16 — never use it for
  files a parser reads (fetch + python instead).
- `npx` is a broken shim for `Start-Process` — launch Node tools via
  `node` directly (`node .\node_modules\tsx\dist\cli.mjs server.ts`).
  Every bash call = FRESH PowerShell session: `Start-Process` children
  survive ONLY with a real binary path (python/node); verify with
  `Get-Process -Id` in the NEXT call. `npx tsx server.ts` needs 30–90s
  cold boot (dev); production `node dist/server.cjs` boots in ~3–7s.
- `node -e` with `$vars` and multi-arg `gh ... --jq` filters get mangled
  by PowerShell — stage temp `.js`/`.py` files in
  `C:\Users\abisl\AppData\Local\Temp\opencode` instead, then delete them.
- `Select-String -Path <dir>` FAILS on directories (use the `grep` tool
  or `-Recurse` from a parent with `-Include`).
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
- Dev-only console error (pre-existing, NOT a bug in your change):
  `[ABxAGCharacter] SyntaxError ... <!doctype ...` — the dev backend data
  dir has no `evelyn` character, so profile fetch falls into the SPA
  fallback. Production (built-in character) is unaffected.
- Voice brain identity: creator is AB (ABsUP); links github.com/ABsUP,
  absup.pages.dev, x.com/ABsUPx, t.me/absups, web3.bio/absup (see IDENTITY
  block in `server.ts` finalInstructions).
- Larger context docs: `README.md`, `docs/COGNITIVE_ARCHITECTURE.md`,
  `PRD/` (per-feature PRDs), `conductor/`.
- **PARALLEL SESSIONS share this working tree:** before ANY work, check
  `git log --oneline -5`, `git status`, and open PRs (`gh pr list`) — your
  task may already be done+merged. Never `git checkout -- .` blindly;
  inspect staged vs unstaged separately. Someone's `git rm`
  (staged deletions) once turned lint red — restore, don't pile on.
  If the tree is dirty with ANOTHER session's work: NEVER stage/commit
  their files. For shared files (e.g. `conductor/tracks.md`,
  website pills), stage ONLY your hunks — craft a split patch and
  `git apply --cached`, or do byte-level index surgery
  (`hash-object -w` + `update-index --cacheinfo`). Verify the staged set
  with `git diff --cached --name-only` and `gh pr view <n> --json files`.
- **Checkout blocked by dirt?** `git checkout <branch>` refuses when the
  worktree is dirty. Do NOT `-f` (destroys their work). Instead: update a
  non-checked-out ref with `git fetch origin DEV:DEV`; push a branch
  without switching via `git push origin HEAD:refs/heads/<new>`; build
  exact commits with plumbing (`read-tree` + `hash-object -w` +
  `update-index --cacheinfo` + `write-tree` + `commit-tree`) and push the
  SHA directly (`git push origin <sha>:DEV`, fast-forward only).
  Normalize CRLF→LF in plumbing blobs (repo stores LF).
- **Stale `git rm` diagnostics:** the TS server sometimes reports errors
  for already-deleted test files (e.g. `markfaceFallback.test.ts`) —
  `tsc --noEmit` is the source of truth, not the LSP popup.
- **Windows PID recycling is real:** a `Start-Process` PID was reused by
  Notepad within seconds. ALWAYS verify `Win32_Process.CommandLine` before
  kill; kill ONLY your own tree (enumerate via ParentProcessId, verify
  EACH entry, never `D:\APPs\*`, never `ABxAG-Setup*`).
- **Playwright screenshot races:** `scroll-behavior: smooth` + separate
  tool calls = screenshots of the WRONG section. Always scroll
  (`behavior: 'instant'`) + screenshot ATOMICALLY in one `run_code` block.
  `locator.click()` + smooth scroll can hit the WRONG card — use instant
  `scrollIntoView` + coordinate click for determinism.
- **File edits:** use the Edit tool ONLY. Shell `Set-Content` once collapsed
  a whole file to one line. The Write tool overwrites silently — a parallel
  session's file died this way; check `git log`/PRs first.
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
  Fresh `ABxAG-Setup-<v>.exe` running under explorer.exe right after a
  build = the user installing it manually, not your process.
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
