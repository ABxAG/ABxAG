/**
 * Integrity check for the frozen desktop-control agent.
 *
 * The agent ships as a PyInstaller **onedir** bundle: `abxag.exe` next to an
 * `_internal` folder holding the embedded Python DLL, `base_library.zip` (every
 * pure-Python package) and hundreds of compiled extensions. An interrupted
 * update can copy only part of that — the exe plus a few binaries — and the
 * bootloader then fails with "Failed to start embedded python interpreter!",
 * a dialog that says nothing about what actually went wrong.
 *
 * Checking before we launch turns that into a diagnosable condition with a
 * fallback, instead of a fatal-looking error the user cannot act on.
 */
import fs from "node:fs";
import path from "node:path";

/** A complete bundle is comfortably into the hundreds of files. */
const MIN_BUNDLE_FILES = 50;

/** Files inside `_internal` that must exist for the interpreter to start. */
const REQUIRED_MARKERS = ["base_library.zip"];

/**
 * Why this bundle cannot run, or null when it looks intact.
 *
 * Deliberately conservative: an unexpected layout returns null so a future
 * bundle that is organised differently still launches, rather than being
 * refused on a guess.
 */
export function missingBundleParts(exe: string): string | null {
  const internal = path.join(path.dirname(exe), "_internal");
  if (!fs.existsSync(internal)) return `no _internal folder next to ${path.basename(exe)}`;

  let files = 0;
  try {
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else files += 1;
      }
    };
    walk(internal);
  } catch {
    return `could not read ${internal}`;
  }

  for (const marker of REQUIRED_MARKERS) {
    if (!fs.existsSync(path.join(internal, marker))) {
      return `${marker} is missing from ${internal} (an interrupted copy?)`;
    }
  }
  if (!fs.readdirSync(internal).some((name) => /^python3\d*\.dll$/i.test(name))) {
    return `${internal} holds no embedded Python runtime (python3XX.dll)`;
  }
  if (files < MIN_BUNDLE_FILES) {
    return `${internal} holds only ${files} files, a complete bundle has hundreds (an interrupted copy?)`;
  }
  return null;
}