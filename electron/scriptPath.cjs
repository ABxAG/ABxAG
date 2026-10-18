'use strict';

/**
 * Shared location for the PowerShell helpers that ship with the app.
 *
 * In development the scripts live in <repo>\scripts; the packaged app receives
 * them as extraResources next to the Python agent. A missing script is not an
 * error here — it only means an optional behaviour (alarms that ring while the
 * app is closed, an update that restarts itself) is unavailable, and both
 * callers report that rather than failing.
 *
 * Plain CJS on purpose: electron/updates.cjs runs in the Electron main process,
 * which cannot load the TypeScript sources. The backend has its own resolver in
 * companion/alarmWatchdog.ts for the same reason.
 */
const fs = require('fs');
const path = require('path');

/** Absolute path to a shipped script, or null when it cannot be found. */
function resolveScriptPath(name) {
  const candidates = [
    process.env.ABxAG_SCRIPTS_DIR ? path.join(process.env.ABxAG_SCRIPTS_DIR, name) : undefined,
    process.resourcesPath ? path.join(process.resourcesPath, name) : undefined,
    path.join(process.cwd(), 'scripts', name),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

module.exports = { resolveScriptPath };