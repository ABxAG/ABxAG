/**
 * Virtual AI cursor kill switch (Settings → PC control & safety).
 *
 * The setting must default ON (old settings files have no such key),
 * survive a deep-partial patch OFF/ON, and reject non-boolean values.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, patchSettings, DEFAULT_APP_SETTINGS } from "../settings/appSettings";

test("virtual cursor defaults ON for old settings files", () => {
  assert.equal(DEFAULT_APP_SETTINGS.autonomy.virtualCursorEnabled, true);
  assert.equal(normalizeSettings({}).autonomy.virtualCursorEnabled, true);
  assert.equal(normalizeSettings({ autonomy: {} }).autonomy.virtualCursorEnabled, true);
});

test("patch OFF then ON round-trips", () => {
  const off = patchSettings(DEFAULT_APP_SETTINGS, { autonomy: { virtualCursorEnabled: false } });
  assert.equal(off.autonomy.virtualCursorEnabled, false);
  // Unrelated autonomy fields survive the patch.
  assert.equal(off.autonomy.maxSteps, DEFAULT_APP_SETTINGS.autonomy.maxSteps);
  const on = patchSettings(off, { autonomy: { virtualCursorEnabled: true } });
  assert.equal(on.autonomy.virtualCursorEnabled, true);
});

test("non-boolean values fall back to the previous value", () => {
  const kept = patchSettings(DEFAULT_APP_SETTINGS, { autonomy: { virtualCursorEnabled: "yes" } });
  assert.equal(kept.autonomy.virtualCursorEnabled, true);
  const off = patchSettings(DEFAULT_APP_SETTINGS, { autonomy: { virtualCursorEnabled: false } });
  const stillOff = patchSettings(off, { autonomy: { virtualCursorEnabled: 1 } });
  assert.equal(stillOff.autonomy.virtualCursorEnabled, false);
});
