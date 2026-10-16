# PRD: Remove dual-cursor (virtual mouse)

## Problem
Dual-cursor breaks ABxAG/tools working properly. The virtual pointer path
(12 agent tools, overlay, endpoint, kill switch, prompt rule) adds failure
modes; the user wants everything to work reliably, every time.

## Decision
Delete the virtual mouse end to end. The AI uses the physical mouse path
only (`clickText` exact text labels, raw coordinates for unlabeled canvas),
gated by confirmations, the permission board, and emergency stop.

## Scope
- Agent: delete `tools_virtual_cursor.py` + its test, registry entries,
  spec hiddenimport; clean rebuild of the frozen agent (96 → 84 tools).
- Backend: tool-name lists, VIRTUAL_* sets, kill-switch gate, endpoint,
  pause-toggle handler, declarations, DUAL-CURSOR prompt rule → physical rule.
- Shell/UI/settings/tests/docs per track spec. No release in this track.
