'use strict';

/**
 * The machine-local address ABxAG serves on.
 *
 * One definition, shared by the Electron main process and the backend, so the
 * window, the tray, the startup line and the documentation cannot drift apart.
 * Plain CJS on purpose: electron/main.cjs cannot load the TypeScript sources.
 *
 * `abxag` is mapped to 127.0.0.1 in the hosts file (npm run setup:host). The
 * server binds IPv4 loopback only, and "localhost" is avoided because it can
 * resolve to ::1, where another app on the same port would answer.
 */
const dns = require('dns');

/** The friendly name, without scheme or port. */
const LOCAL_HOSTNAME = 'abxag';

/** The port the installed app serves on. */
const LOCAL_PORT = 369;

/**
 * Whether the friendly name actually resolves here. Without the hosts entry
 * `abxag` does not resolve at all, and the app must fall back to 127.0.0.1
 * rather than showing a blank window.
 */
function hostNameResolves(hostname) {
  try {
    dns.lookupSync(hostname);
    return true;
  } catch {
    return false;
  }
}

module.exports = { LOCAL_HOSTNAME, LOCAL_PORT, hostNameResolves };