# PRD — Settings › System › Update (move-only)

**Status:** approved · **Date:** 2026-10-16

## 1. Goal

Updates belong with system-level concerns, not About. Move the updater UI out
of Settings › About into a new **Update** group at the top of
Settings › System, so users find update mode, check/download/install and
version switching where they expect system maintenance. About keeps version +
links only.

## 2. UX path

Settings › **System** › **Update** (first group, above Desktop control agent):

- Update mode radio (Auto / Manual)
- Status + Check button, download progress, latest-version Update button
- Downloaded → Install now
- Switch version (old or new) collapsible
- Browser fallback: read-only release list with external download links

Settings › **About** keeps: Version row, Website / Mirror / Source /
All-releases links, AI + PC control rows, homepage note. No updater UI.

Command palette: `Settings: System` entry gains `update` / `upgrade` keywords
(hint `startup · updates` unchanged).

## 3. Scope — move-only, no logic change

- `src/components/AboutUpdates.tsx`: extract the Updates `<section>` into a
  new exported `UpdatesSection({ app, onPatch })` in the same file. All bridge
  hooks (`useUpdatesBridge`, auto-mode sync, web fallback fetch, run/install
  helpers) move with it unchanged. `AboutUpdates` keeps version + links only.
- `src/components/SettingsPanel.tsx`: `SystemSection` renders
  `<Group title="Update">` + `<UpdatesSection>` as its first group. About call
  site unchanged.
- `src/App.tsx`: palette keywords only.

No changes to `src/lib/updatesBridge`, main-process updater, release parsing,
or persisted `updates.mode` semantics.

## 4. Verify

1. `npm run lint` (tsc --noEmit) clean.
2. `npm run test:agent` — expect 99 pass.
3. Manual: Settings › System shows Update on top; mode toggle persists;
   Check → download → Install now flow unchanged; About shows version + links
   with no updater rows; palette `update`/`upgrade` opens System.
4. Secret scan: `git diff` for touched files contains no keys/secrets.
