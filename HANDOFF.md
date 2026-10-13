# ABxAG — Session Handoff Prompt (v1.1.12, DEV clean)

> Copy everything below the line into a new session. It contains the full
> project state, conventions, release routine, and hard-won gotchas.

---

You are continuing work on **ABxAG**, a private 3D AI desktop companion for
Windows. Repo root: `D:\ABxAG` (git, branch **DEV**, public
`github.com/ABxAG/ABxAG`). Current version **1.1.12**, tree clean, feed
(`website/releases.json`) current with 12 releases. `gh` CLI is logged in as
**ABsUP**. Wrangler is logged in (account ABsUP.ORG); Cloudflare Pages
project `abxag` auto-deploys branch DEV (output dir `website/`, no build
command). Live site: `https://abxAG.absup.dev` — always write it lowercase:
`abxag.absup.dev` (+ mirror `abxag.pages.dev`, download page `/download/`).

## 0. Safety rules (violating these broke things before)

1. **NEVER kill the user's installed app.** It runs from `D:\APPs\ABxAG`.
   `Get-Process -Name "abxag"` on Windows is CASE-INSENSITIVE and matches
   `ABxAG` too. Always match by full path (`$_.Path -like 'D:\ABxAG\...'` for
   test processes, never touch `D:\APPs\*`). If you must free ports, ask first.
2. **Test ports:** dev server `127.0.0.1:3000`, agent `:8765`, backend
   `47130+`. Before any smoke test, confirm the port is free AND that the
   responder is YOUR process (stale agents on :8765 give false results —
   check `/tools` count or the startup log line `Loaded N desktop tools`).
3. **Never commit secrets.** `.pfx`/`.p12`/`csc-*.txt` are gitignored — keep
   it that way. No API keys in code (only test fixtures). `MODELS FOR ABxAG/`
   (licensed MMD zips) stays gitignored and local-only.
4. `D:\MarkLV` is a SEPARATE user project outside this repo — never `git add`
   it. `release-public/`, `agent_dist/`, `agent_build/`, `dist/`,
   `node_modules/`, `logs/` are gitignored build outputs.

## 1. Branding (exact)

- Display name everywhere (UI, titles, docs): exactly `ABxAG`.
- npm package name stays lowercase `abxag`; env prefix `ABxAG_`;
  Electron `appId: dev.absup.abxag`; agent exe `agent_dist/abxag/abxag.exe`;
  wake phrase default `"hey ab"`; logo `assets/ABxAG.jpg` (+ `build/icon.*`
  regenerated from it via PIL if missing).
- afterPack stamps `ABxAG-runtime.exe` via the `rcedit` devDependency
  (note: `const { rcedit } = require('rcedit')` — named export).

## 2. Definition of done for every change

- `npm run lint` (tsc) clean; `node --check` any touched `.cjs`.
- Tests: `npm run test:agent` (add new `tests/*.test.ts` files to the
  `test:agent` script in package.json), `test:characters`, `test:python`
  (`python -m unittest discover -s desktop_agent -p "test_*.py"`).
- Python tool modules: import-safe (no side effects), covered by
  `desktop_agent/test_*.py`.
- Commit messages describe the change; push to `origin DEV` (default branch).
- Feature work gets a short PRD in `D:\ABxAG\PRD\`.

## 3. Release routine (patch version X.Y.Z — every step, in order)

1. Bump: `package.json` + `package-lock.json` (TWO spots: root + `packages.""`)
   + `README.md` header + `website/index.html` (pill + `ver` span).
2. `npm run lint` + full tests (above).
3. If `desktop_agent/` changed: `pyinstaller desktop_agent.spec
   --distpath agent_dist --workpath agent_build` (use `--noconfirm`; if new
   tools are missing from the exe: ① add module to `hiddenimports` in
   `desktop_agent.spec`, ② delete `agent_build/`+`agent_dist/` and rebuild
   clean, ③ verify via `/tools` count AND the `Loaded N desktop tools` log —
   beware stale agents squatting on :8765).
4. `npm run dist:public` → `release-public/ABxAG-Setup-<v>.exe` (+ Portable).
5. Verify: exe FileVersionInfo = new version; runtime exe FileDescription =
   ABxAG; fresh `dist/assets/index-*.js` newer than sources; portable smoke
   test by PID only (kill ONLY that PID afterwards).
6. `gh release create v<V> <setup> <portable> --title "ABxAG v<V>" --notes
   "<what changed>" --target DEV`; `git add -A && git commit && git push
   origin DEV`.
7. Refresh feed: `gh api repos/ABxAG/ABxAG/releases --paginate --jq '<fields>'`
   → `website/releases.json` (strip UTF-8 BOM! PowerShell `Set-Content`
   writes BOM and breaks parsers — always rewrite with UTF8NoBOM), commit,
   push. Pages redeploys automatically.

## 4. Known environment quirks

- Anonymous `api.github.com` returns 404 on this network (even for public
  repos) — use authenticated `gh api`. The in-app updater + website already
  fall back to `abxag.absup.dev/releases.json`; asset downloads via
  `github.com` work fine.
- PowerShell 5.1 here: no `&&` (use `;`), quote paths with spaces.
- Windows file renames that change ONLY case need a two-step rename via a
  temp name, or TypeScript reports phantom case-conflict errors.
- Website is dependency-free static HTML/CSS/JS in `website/` (+ `_redirects`
  maps `/DownLoad` → `/download/`).
- Installed user data (logs to read for crash diagnosis):
  `%APPDATA%\ABxAG\logs\` (`crash.log`, `errors.log`). Known fixed crash:
  React #31 from rendering `task.result` objects raw — always render via
  `asText()` (`src/components/TaskHud.tsx`).
- Voice brain identity: creator is AB (ABsUP); links github.com/ABsUP,
  absup.pages.dev, x.com/ABsUPx, t.me/absups, web3.bio/absup (see IDENTITY
  block in `server.ts` finalInstructions).
- Larger context docs: `README.md`, `docs/COGNITIVE_ARCHITECTURE.md`,
  `PRD/about-updates.md`, `PRD/character-autonomy.md`, `conductor/`.

Start by confirming: version, `git status`, and restating what you will do.
Never start the release routine without explicit user approval for that version.

## 5. Standing auto-routine (user order, every fix)
After EVERY fix, automatically — no need to ask:
1. Verify (`npm run lint`, touched `.cjs` via `node --check`, `test:python`).
2. Secret-scan the diff, then land via PULL REQUEST (no direct pushes):
   branch `feat/<x>` or `fix/<x>` or `chore/<x>` off DEV → `git add`
   (intended files only) → commit (message describes the change,
   `Co-authored-by: ABsUP <ABsUP@users.noreply.github.com>` trailer) →
   `git push -u origin <branch>` → `gh pr create --base DEV --fill` →
   wait for CI green → `gh pr merge --merge --delete-branch`.
   Direct push to DEV only for release-routine commits (bump/feed).
3. When applicable, use Actions/workflows: ABxAG's own `CI`
   (`.github/workflows/ci.yml`) runs on every PR and every push to DEV —
   merge only on green; after merging, check
   `gh run list --branch DEV --limit 3` and report green/red.
   Use `github.com/OpenCodeWEB/AiA` Actions only if the fix touches AiA.
4. Issues: file real bugs as GitHub issues and close them with the PR
   (`Fixes #n`) — real activity grows achievements, noise does not.
