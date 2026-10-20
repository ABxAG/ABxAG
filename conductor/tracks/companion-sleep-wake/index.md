# Companion Sleep/Wake & Hide/Show

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- [Metadata](./metadata.json)

## Summary
Add explicit **sleep/wake** cycle and **window-level hide/show** control for the desktop companion doll.

### Commands
| Command | Description |
|---------|-------------|
| `sleep` | Lie down, close eyes, pause autonomous brain |
| `wake` | Stand up, open eyes, resume autonomous brain |
| `hide_window` | Hide the companion window entirely (`win.hide()`) |
| `show_window` | Show the companion window (`win.showInactive()`) |

### User Stories
- "Sleep" / "Go to sleep" → doll sleeps
- "Wake up" / "Good morning" → doll wakes
- "Hide" / "Go away" (window level) → window hidden
- "Show" / "Come back" (window level) → window shown

### Menus
- Tray menu: Sleep/Wake, Hide window/Show window
- Context menu (right-click doll): Sleep/Wake, Hide window/Show window