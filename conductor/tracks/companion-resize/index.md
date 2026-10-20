# Companion Resize via Voice/Text

- [Specification](./spec.md)
- [Implementation Plan](./plan.md)
- [Metadata](./metadata.json)

## Summary
Allow users to resize the desktop companion doll via voice commands or text input.

### Commands (Shell Side)
| Command | Payload | Description |
|---------|---------|-------------|
| `resize` | `{ delta: +0.25 }` | Relative: make bigger |
| `resize` | `{ delta: -0.25 }` | Relative: make smaller |
| `resize` | `{ absolute: 1.5 }` | Absolute: set to 150% |
| `resize` | `{ reset: true }` | Reset to 100% (1.0×) |

### Voice Command Mapping (Backend)
| User says | Backend sends |
|-----------|---------------|
| "bigger", "make her bigger" | `resize` + `{ delta: 0.25 }` |
| "smaller", "make her smaller" | `resize` + `{ delta: -0.25 }` |
| "size 150%", "scale 1.5" | `resize` + `{ absolute: 1.5 }` |
| "reset size", "default size" | `resize` + `{ reset: true }` |

### Settings
- Key: `companion.scale` (number, default `1.0`)
- Range: `0.4` – `2.5` (clamped)
- Persisted via existing `saveSettings` → triggers `applySettings` → `resize()`

### Acceptance
- Relative/absolute/reset commands work
- Clamping at boundaries (0.4, 2.5)
- Settings UI slider stays in sync
- Visual acknowledgement animation