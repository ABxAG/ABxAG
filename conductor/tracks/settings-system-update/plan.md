# Plan — settings-system-update

## Steps (done in the recovered worktree session)

1. **AboutUpdates.tsx** — extract the Updates `<section>` tree into a new
   exported `UpdatesSection({ app, onPatch })` in the same file. All bridge
   hooks move with it unchanged (`useUpdatesBridge`, auto-mode sync, web
   fallback fetch, run/install helpers). `AboutUpdates` keeps version +
   links only; signature unchanged ( About call site untouched ).
   ✅
2. **SettingsPanel.tsx** — `SystemSection` renders `<Group title="Update">`
   wrapping `<UpdatesSection>` as the FIRST group. About call site
   unchanged. ✅
3. **App.tsx** — palette entry `Settings: System` gains `update` /
   `upgrade` keywords (hint unchanged). ✅
4. **Verify** — `npm run lint` clean ✅; `npm run test:agent` 99/99 ✅;
   manual flow unchanged (mode toggle → Check → download → Install now;
   About shows version + links only).
5. **Land** — branch `chore/settings-system-update` off DEV, stage ONLY:
   `src/App.tsx`, `src/components/AboutUpdates.tsx`,
   `src/components/SettingsPanel.tsx`, `PRD/settings-system-update.md`,
   `conductor/tracks/settings-system-update/*`, and tracks.md via index
   surgery (staged = HEAD + this track's registry line, NOT the other
   session's hunk). PR → CI green → merge.
6. **Release** — v1.1.19 via the standing release routine.
