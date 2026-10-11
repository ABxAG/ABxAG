# Plan: dual-cursor

1. `desktop_agent/tools_virtual_cursor.py` — virtual state + PostMessage + UIA invoke.
2. `registry.py` — register 10 tools, add module to _MODULE_NAMES.
3. `electron/virtual-cursor.cjs` — overlay window + update API.
4. `electron/main.cjs` — wire overlay (lazy require, no break if missing).
5. `shared/virtualCursor.ts` — types + event queue contract (TS side).
6. `server.ts` — VIRTUAL_TOOLS set (append-only patch via bridge file).
7. Tests: python unit + node smoke.
