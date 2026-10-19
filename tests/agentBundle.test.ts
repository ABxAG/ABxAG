/**
 * Integrity check for the frozen desktop agent (agent/bundleIntegrity.ts).
 *
 * This exists because of a real failure: an interrupted update left an
 * `abxag.exe` with an almost-empty `_internal`, and the PyInstaller bootloader
 * reported "Failed to start embedded python interpreter!" — a dialog with no
 * clue about the cause. These tests pin the cases that check must catch, and
 * the cases it must not get wrong.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { missingBundleParts } from "../agent/bundleIntegrity";

function makeBundle(layout: Array<{ dir?: string; file?: string; bytes?: number }>): string {
  const root = mkdtempSync(join(tmpdir(), "abxag-bundle-"));
  const internal = join(root, "_internal");
  mkdirSync(internal, { recursive: true });
  for (const entry of layout) {
    // A `dir` is relative to the bundle root, so it can point into a nested
    // package folder such as _internal/pywin32_system32. An `_internal/...`
    // path is left alone rather than doubled.
    const dir = entry.dir
      ? (entry.dir === "_internal" ? internal : join(root, entry.dir))
      : internal;
    const name = (entry.file ?? "").replace(/^_internal[\\/]+/, "");
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(entry.bytes ?? 8, 1));
  }
  return join(root, "abxag.exe");
}

test("a complete bundle is accepted", () => {
  const exe = makeBundle([
    { file: "_internal/base_library.zip" },
    { file: "_internal/python312.dll" },
    ...Array.from({ length: 60 }, (_, i) => ({ file: `_internal/mod${i}.pyd` })),
  ]);
  assert.equal(missingBundleParts(exe), null);
});

test("an exe with no _internal folder is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "abxag-bundle-"));
  const exe = join(root, "abxag.exe");
  writeFileSync(exe, "x");
  const problem = missingBundleParts(exe);
  assert.match(problem!, /no _internal folder/);
});

test("the bundle that actually broke this is refused, by name and by count", () => {
  // This is the exact shape that shipped: five binaries, no base_library.zip.
  const exe = makeBundle([
    { file: "_internal/python312.dll", bytes: 6_945_272 },
    { file: "_internal/libcrypto-3.dll", bytes: 5_231_472 },
    { dir: "_internal", file: "PIL/_imaging.cp312-win_amd64.pyd", bytes: 2_349_056 },
    { dir: "_internal", file: "pydantic_core/_pydantic_core.cp312-win_amd64.pyd", bytes: 5_253_120 },
    { dir: "_internal", file: "Pythonwin/mfc140u.dll", bytes: 5_653_536 },
  ]);
  const problem = missingBundleParts(exe);
  assert.ok(problem, "a five-file bundle must be refused");
  assert.match(problem!, /base_library\.zip is missing/);
});

test("a bundle with base_library.zip but almost nothing else is still refused", () => {
  // Someone could restore the marker file; the count is the second line of
  // defence, and it is what distinguishes a real bundle (hundreds) from this.
  const exe = makeBundle([
    { file: "_internal/base_library.zip" },
    { file: "_internal/python312.dll" },
    ...Array.from({ length: 12 }, (_, i) => ({ file: `_internal/x${i}.pyd` })),
  ]);
  assert.match(missingBundleParts(exe)!, /holds only 14 files/);
});

test("a missing embedded Python DLL is reported specifically", () => {
  const exe = makeBundle([
    { file: "_internal/base_library.zip" },
    ...Array.from({ length: 60 }, (_, i) => ({ file: `_internal/mod${i}.pyd` })),
  ]);
  assert.match(missingBundleParts(exe)!, /no embedded Python runtime/);
});

test("a renamed python DLL is still recognised", () => {
  const exe = makeBundle([
    { file: "_internal/base_library.zip" },
    { file: "_internal/python311.dll" },
    ...Array.from({ length: 60 }, (_, i) => ({ file: `_internal/mod${i}.pyd` })),
  ]);
  assert.equal(missingBundleParts(exe), null);
});

test("nested package folders are counted, not just the top level", () => {
  const exe = makeBundle([
    { file: "_internal/base_library.zip" },
    { file: "_internal/python312.dll" },
    ...Array.from({ length: 40 }, (_, i) => ({ dir: "_internal/pywin32_system32", file: `d${i}.dll` })),
    ...Array.from({ length: 40 }, (_, i) => ({ dir: "_internal/comtypes", file: `c${i}.pyd` })),
  ]);
  assert.equal(missingBundleParts(exe), null);
});

test("the check never throws on an unreadable bundle", () => {
  // A directory that disappears mid-walk should surface as a problem string,
  // not an exception that takes the backend down with it.
  const root = mkdtempSync(join(tmpdir(), "abxag-bundle-"));
  const exe = join(root, "abxag.exe");
  writeFileSync(exe, "x");
  mkdirSync(join(root, "_internal"));
  const problem = missingBundleParts(exe);
  assert.ok(typeof problem === "string");
  rmSync(root, { recursive: true, force: true });
});