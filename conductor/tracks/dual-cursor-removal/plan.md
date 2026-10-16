# Plan: dual-cursor-removal

## Steps (in order)

1. **Agent Python**: `git rm desktop_agent/tools_virtual_cursor.py
   desktop_agent/test_virtual_cursor.py`; `registry.py` −12 names −1 module;
   `desktop_agent.spec` −hiddenimport. Run `test:python`.
2. **Rebuild frozen agent** (runtime modules changed → routine §3.3):
   delete `agent_build/` + `agent_dist/`, `pyinstaller desktop_agent.spec
   --distpath agent_dist --workpath agent_build --noconfirm` (use
   `python -m PyInstaller` if bare `pyinstaller` is a broken shim).
   Verify: boot the exe briefly on :8765 (own PID, CommandLine-verified,
   kill after) → `Loaded 84 desktop tools` + `/tools` count 84.
3. **Backend** (`server.ts`): remove tool-name entries, `VIRTUAL_TOOLS` /
   `VIRTUAL_ACTION_TOOLS` / `isVirtualCursorEnabled`, kill-switch block,
   endpoint, pause-toggle handler, declarations; rewrite prompt rule.
4. **Shared/shell/CI**: delete `shared/virtualCursor.ts` +
   `electron/virtual-cursor.cjs`; `main.cjs` −block; `ci.yml` −check line.
5. **Settings/UI/tests**: `appSettings.ts` −field (3 spots), `appApi.ts`
   −field, SettingsPanel −toggle, App −props, CommandDeck −props/button,
   `uiPreview` −props, HudOverlay −fetch/block, delete
   `tests/virtualCursorSetting.test.ts` + deregister.
6. **Docs**: `PRD/dual-cursor-removal.md`, README row, HANDOFF state,
   tracks registry + dual-cursor index status.
7. **Verify**: lint, `node --check`, full suites, repo-wide grep per spec
   §4, PR via standing routine (DEV only — no release).

## Risks

- Installed user files keep `autonomy.virtualCursorEnabled`: normalize drops
  unknown keys — safe, no migration.
- Agent rebuild on this machine: PyInstaller +0985 needs `--noconfirm`;
  stale `agent_build` must go or removed modules linger in the exe.
- Parallel session has dirty website files: do NOT touch `website/`.
