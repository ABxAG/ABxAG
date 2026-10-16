/**
 * ZORION-style HUD overlay settings (Settings → Overlay).
 *
 * The overlay must default OFF for old settings files (ZORION parity:
 * overlay.enabled is false), survive deep-partial patches, clamp opacity to
 * 0.4..1, validate the hotkey, and reject non-boolean values.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, patchSettings, DEFAULT_APP_SETTINGS } from "../settings/appSettings";

test("overlay defaults OFF for old settings files, all widgets on", () => {
  assert.equal(DEFAULT_APP_SETTINGS.overlay.enabled, false);
  assert.equal(DEFAULT_APP_SETTINGS.overlay.opacity, 0.94);
  assert.equal(DEFAULT_APP_SETTINGS.overlay.clickThrough, false);
  assert.equal(DEFAULT_APP_SETTINGS.overlay.hotkey, "Control+Alt+O");
  for (const value of Object.values(DEFAULT_APP_SETTINGS.overlay.widgets)) {
    assert.equal(value, true);
  }
  assert.equal(normalizeSettings({}).overlay.enabled, false);
  assert.equal(normalizeSettings({ autonomy: {} }).overlay.enabled, false);
});

test("patch enable + compact + widget off round-trips", () => {
  const on = patchSettings(DEFAULT_APP_SETTINGS, {
    overlay: { enabled: true, compact: true, widgets: { clock: false } },
  });
  assert.equal(on.overlay.enabled, true);
  assert.equal(on.overlay.compact, true);
  assert.equal(on.overlay.widgets.clock, false);
  // Unrelated overlay fields survive the patch.
  assert.equal(on.overlay.opacity, DEFAULT_APP_SETTINGS.overlay.opacity);
  assert.equal(on.overlay.widgets.status, true);
  const off = patchSettings(on, { overlay: { enabled: false } });
  assert.equal(off.overlay.enabled, false);
  assert.equal(off.overlay.compact, true);
});

test("non-boolean values fall back to the previous value", () => {
  const kept = patchSettings(DEFAULT_APP_SETTINGS, { overlay: { enabled: "yes" } });
  assert.equal(kept.overlay.enabled, false);
  const widgetsKept = patchSettings(DEFAULT_APP_SETTINGS, { overlay: { widgets: { task: 1 } } });
  assert.equal(widgetsKept.overlay.widgets.task, true);
});

test("opacity clamps to 0.4..1 and hotkey rejects garbage", () => {
  const hi = patchSettings(DEFAULT_APP_SETTINGS, { overlay: { opacity: 5 } });
  assert.equal(hi.overlay.opacity, 1);
  const lo = patchSettings(DEFAULT_APP_SETTINGS, { overlay: { opacity: 0 } });
  assert.equal(lo.overlay.opacity, 0.4);
  const nan = patchSettings(DEFAULT_APP_SETTINGS, { overlay: { opacity: "opaque" } });
  assert.equal(nan.overlay.opacity, DEFAULT_APP_SETTINGS.overlay.opacity);
  const badHotkey = patchSettings(DEFAULT_APP_SETTINGS, { overlay: { hotkey: "!!" } });
  assert.equal(badHotkey.overlay.hotkey, DEFAULT_APP_SETTINGS.overlay.hotkey);
  const goodHotkey = patchSettings(DEFAULT_APP_SETTINGS, { overlay: { hotkey: "Control+Alt+O" } });
  assert.equal(goodHotkey.overlay.hotkey, "Control+Alt+O");
});
