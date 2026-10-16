# Spec: site-hud-content (HUD overlay on the website)

## Problem
`website/` (abxag.pages.dev + abxag.absup.dev) describes v1.1.16 by version
pill only. The headline v1.1.16 feature — the interactive HUD overlay
(9 widgets, live 3D avatar mirror, Ctrl+Alt+O, Settings → Overlay) — appears
nowhere: no spotlight, Era 6 still says dual-cursor only, no FAQ entry.

## Changes (content-only, existing CSS classes, no new styles/scripts)
1. `website/index.html`: new `#hud-overlay` spotlight after `#dual-cursor`
   (3 cards + terminal strip reusing `.card/.num/.term` classes); nav link
   `HUD overlay` with `data-spy` (scrollspy is automatic); one-line touch to
   the "You stay in charge" card (overlay stop button).
2. `website/RoadMap/index.html`: Era 6 stays "latest" (no renumber, no
   ACCENTS change); card text + `DETAILS[6]` gain the HUD overlay point.
   Nav gains `HUD overlay` link (`../#hud-overlay`).
3. `website/DownLoad/index.html`: new FAQ entry "What's new in the latest
   version?" (v1.1.16 HUD overlay + differential updates) linking home
   spotlight; nav gains Versions-anchored HUD link.
4. No feed/shape changes; Linux AppImage stays pinned to v1.1.15 (no newer
   Linux build exists — never fake it).

## Acceptance
Serve `website/` locally; screenshot desktop (1280) + mobile (390);
console errors 0; pills intact; anchor `#hud-overlay` reachable from all
three navs; PR → CI green → merge.
