import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCENT_THEMES,
  SHORTCUTS,
  accentGlow,
  formatLogLine,
} from "../src/lib/cyberpunk.ts";

test("accent themes cover every App theme color", () => {
  const ids = ACCENT_THEMES.map((t) => t.id).sort();
  assert.deepEqual(ids, ["celestial", "charcoal", "crimson", "emerald", "gold", "rose", "violet"]);
  for (const t of ACCENT_THEMES) {
    assert.match(t.glow, /^#[0-9a-f]{6}$/i);
  }
});

test("accentGlow falls back to cyan for unknown themes", () => {
  assert.equal(accentGlow("violet"), "#8b5cf6");
  assert.equal(accentGlow("nope"), "#22d3ee");
});

test("formatLogLine renders a single safe string", () => {
  const line = formatLogLine({ kind: "fallback", text: "Switched to x.", at: 0 });
  assert.equal(typeof line, "string");
  assert.ok(line.includes("FALLBACK"));
  assert.ok(line.includes("Switched to x."));
  assert.ok(line.length <= 160);
});

test("deck shortcuts include the palette and safety keys", () => {
  const keys = SHORTCUTS.map((s) => s.keys);
  assert.ok(keys.includes("Ctrl+K"));
  assert.ok(keys.includes("Ctrl+Alt+Shift+S"));
});
