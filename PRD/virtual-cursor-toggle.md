# PRD: Virtual AI cursor OFF switch (Settings → PC control & safety)

## Ask
A toggle in Settings → PC control & safety to turn the virtual mouse off.

## Behavior
- ON (default, including for old settings files): dual-cursor as today —
  red AI cursor works in the background, physical mouse stays the user's.
- OFF: all 9 virtual action tools are refused in `callDesktopAgent` before
  any agent call, with a message telling the model to use physical tools
  and tell the user plainly. `virtualStatus`/`pauseVirtual`/`resumeVirtual`
  keep working (read-only / harmless). The Electron overlay hides itself
  while OFF and reappears when re-enabled. Ctrl+Alt+P still pauses.
- The model prompt includes the OFF instruction so it never retries
  virtual tools in a loop.

## Files
`settings/appSettings.ts` (field + default + normalize),
`src/lib/appApi.ts` (type), `src/components/SettingsPanel.tsx` (toggle),
`server.ts` (gate + endpoint `enabled` + prompt),
`electron/virtual-cursor.cjs` (hide/show), `tests/virtualCursorSetting.test.ts`.
