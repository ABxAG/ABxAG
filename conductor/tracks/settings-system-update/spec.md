# Spec — settings-system-update

Full PRD: `PRD/settings-system-update.md` (approved, 2026-10-16). Summary:

## Goal

Updates belong with system-level concerns, not About. Users look for
"update my app" under system maintenance, not an About page.

## UX

- **Settings › System › Update** — first group, above "Desktop control agent":
  - Update mode radio (Auto / Manual)
  - Status + Check button, download progress, latest-version Update button
  - Downloaded → Install now
  - Switch version (old or new) collapsible
  - Browser fallback: read-only release list with external download links
- **Settings › About** keeps version + links + AI/PC-control rows only, no
  updater UI.
- Command palette: `Settings: System` gains `update` / `upgrade` keywords.

## Hard constraints

- **Move-only, zero logic change.** No changes to `src/lib/updatesBridge`,
  the main-process updater, release parsing, or `updates.mode` semantics.
- Parallel-session safety: website/ + tracks.md deletions in the same
  worktree belong to ANOTHER session — never stage them.
