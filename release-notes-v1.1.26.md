## ABxAG v1.1.26

### New — Companion doll sleep/wake, hide/show & resize

- **Sleep / Wake**: The desktop companion doll can now go to sleep and wake up on command.
  - Voice: *"so jao"*, *"sleep"*, *"uto"*, *"wake up"*
  - Chat/REST: `companionAction(sleep)` / `companionAction(wake)`
  - When sleeping: she lies down, pauses autonomous behavior, and shows a sleep face.
  - When waking: she stands up, resumes her brain, and shows a happy wake face.

- **Hide Window / Show Window**: The companion window can be completely hidden and shown again.
  - Voice: *"chup jao"*, *"hide window"*, *"dekhao"*, *"show window"*
  - Chat/REST: `companionAction(hide_window)` / `companionAction(show_window)`
  - When hidden: the window disappears, all timers stop, and she pauses completely.
  - When shown: the window reappears, timers restart, and she resumes where she left off.

- **Resize (Size Control)**: Users can now make the companion doll smaller or larger by voice or text.
  - Voice: *"choto koro"* (smaller), *"boro koro"* (larger), *"reset size"* / *"normal size"*
  - Chat/REST: `companionResize(delta: -0.25)` for smaller, `companionResize(delta: 0.25)` for larger, `companionResize(reset: true)` to reset, `companionResize(absolute: 1.5)` for specific scale.
  - Scale range: 0.4× (tiny) to 2.5× (huge), persisted in settings.

### Fixed

- **Companion getter recursion bug fixed**: `sleeping` and `windowHidden` getters were recursively calling themselves, causing "Cannot set property sleeping of #<CompanionManager> which has only a getter" error on startup. Now uses internal backing properties (`_sleeping`, `_windowHidden`).

- **Embedded Python interpreter fix**: The frozen PC-control agent bundle is now verified before launch. A broken bundle is reported by name and falls back to running from source with local Python.

### Verified

- tsc clean - 129 agent tests (8 new), 8 character, 32 Python
- All companion sleep/wake/resize tests pass
- Public build: no bundled character models, users import their own on first run