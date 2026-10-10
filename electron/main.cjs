/* ===========================================================================
 * ABxAG — Electron main process (Phase 1)
 * ---------------------------------------------------------------------------
 * Responsibilities in this phase:
 *   1. Enforce a single running instance.
 *   2. Launch the existing Node backend (server.ts, bundled to dist/server.cjs)
 *      silently as a child process — no console window, no browser tab.
 *   3. Show a splash window while the backend boots, then load the real UI
 *      (http://localhost:3000) into the main application window.
 *   4. Clean up the backend (and its child Python agent) on quit.
 *
 * Tray, window-state persistence, close-to-tray and notifications arrive in
 * Phase 2; installer/auto-update/PyInstaller in later phases. The backend and
 * AI logic are reused verbatim — nothing here reimplements chat/memory/voice.
 * ========================================================================= */

'use strict';

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, desktopCapturer, session, screen, Tray, nativeImage, globalShortcut, powerMonitor, Notification } = require('electron');
const { CompanionManager } = require('./companion.cjs');
const { createUpdater } = require('./updates.cjs');
const win32 = require('./win32.cjs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');

// --- Constants -------------------------------------------------------------
// The installed app uses its own uncommon port: 3000 is what Vite, Next,
// Remotion Studio etc. use, and with one of those running ABxAG's window
// opened *their* page. Development keeps 3000. If the port is taken anyway,
// the next free one is used (see choosePort).
const PREFERRED_PORT = Number(process.env.ABxAG_PORT) || (app.isPackaged ? 47130 : 3000);
let SERVER_PORT = PREFERRED_PORT;
// 127.0.0.1, not "localhost": the server listens on IPv4 loopback only, and
// "localhost" can resolve to ::1, where another app on the same port answers.
let SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

/** Can we listen on 127.0.0.1:port? */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function choosePort() {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + 20; port++) {
    if (await portFree(port)) return port;
  }
  return PREFERRED_PORT;
}

/** GET /api/config and check the answer really comes from ABxAG's backend. */
function askABxAG(timeoutMs, onResult) {
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    onResult(ok);
  };
  const req = http.get(`${SERVER_ORIGIN}/api/config`, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
    res.on('end', () => finish(res.statusCode === 200 && body.includes('"hasApiKey"')));
    res.on('error', () => finish(false));
  });
  req.on('error', () => finish(false));
  req.setTimeout(timeoutMs, () => { req.destroy(); finish(false); });
}
const SERVER_READY_TIMEOUT_MS = 40_000;

// In development we run from the repo root; when packaged the app files live in
// resources/app (asar-unpacked handling is added in the packaging phase).
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');
// Window/tray icon: prefer the PNG, fall back to the ICO. If neither exists
// Electron silently uses its own default icon (the "wrong logo" bug), so
// resolve loudly here instead of failing quietly at every window.
let APP_ICON = path.join(APP_ROOT, 'build', 'icon.png');
if (!fs.existsSync(APP_ICON)) {
  const fallback = path.join(APP_ROOT, 'build', 'icon.ico');
  if (fs.existsSync(fallback)) {
    console.warn('[shell] build/icon.png missing, using build/icon.ico for windows/tray.');
    APP_ICON = fallback;
  } else {
    console.warn('[shell] no app icon found under build/ — windows will show the default Electron icon!');
  }
}

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Self updater — GitHub Releases check/download/install (see updates.cjs).
// Auto mode starts ON; the renderer syncs the persisted mode
// (settings.updates.mode) once settings load via `updates:set-auto`.
// ---------------------------------------------------------------------------
const updater = createUpdater({
  app,
  shell,
  BrowserWindow,
  log: (...args) => console.log(...args),
});

// ---------------------------------------------------------------------------
// Single-instance guard — second launches focus the existing window instead of
// starting a second backend on the same port.
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap);
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
function startBackend() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Backend bundle not found at ${SERVER_ENTRY}. Run "npm run build" first.`,
    );
  }

  // Use the Node runtime bundled with Electron (ELECTRON_RUN_AS_NODE) so the
  // machine does not need a separate Node install once packaged.
  // Data (memories, settings, secrets, logs) must live in a writable per-user
  // folder — the install dir under Program Files is read-only.
  const dataDir = app.getPath('userData');

  // Frozen Python desktop agent (bundled as an extraResource when packaged).
  // In development this file won't exist, so the backend falls back to running
  // the agent from source with a local Python interpreter.
  const agentExe = app.isPackaged
    ? path.join(process.resourcesPath, 'agent', 'abxag.exe')
    : path.join(APP_ROOT, 'agent_dist', 'abxag', 'abxag.exe');

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    ABxAG_LAUNCHED_BY: 'electron',
    ABxAG_DATA_DIR: dataDir,
    ABxAG_APP_ROOT: APP_ROOT,
    ABxAG_PORT: String(SERVER_PORT),
  };
  if (app.isPackaged) {
    // The desktop agent uses this exact executable for the per-user Windows
    // auto-start entry. It must never point at source scripts or Python.
    env.ABxAG_EXECUTABLE = process.execPath;
  }
  if (fs.existsSync(agentExe)) {
    env.ABxAG_AGENT_EXE = agentExe;
  }

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    // The private IPC channel is used only for one-shot screen capture. It
    // avoids a localhost capture server and never broadcasts screen content.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on('data', (d) => {
    process.stderr.write(`[server] ${d}`);
    // Keep the tail of the backend's stderr: it is the only trace of a crash.
    backendStderr = (backendStderr + String(d)).slice(-8_000);
  });
  serverProcess.on('message', (message) => {
    if (message && typeof message.type === 'string' && message.type.startsWith('runtime:')) {
      handleRuntimeMessage(message);
      return;
    }
    if (!message || message.type !== 'screen-capture-request' || !message.id) return;
    void (async () => {
      try {
        const result = await captureDisplayForBackend(message.maxDim);
        serverProcess?.send?.({
          type: 'screen-capture-response',
          id: message.id,
          ok: true,
          result,
        });
      } catch (error) {
        serverProcess?.send?.({
          type: 'screen-capture-response',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
  const child = serverProcess;
  child.on('exit', (code, signal) => {
    if (serverProcess === child) serverProcess = null;
    if (isQuitting) return;
    // The backend died on its own: record why, then bring it back instead of
    // closing ABxAG. Bounded: after 4 crashes in 5 minutes, give up and tell
    // the user rather than restart-looping.
    logCrash(`backend exited (code ${code}, signal ${signal})\n${redact(backendStderr).slice(-4_000)}`);
    const now = Date.now();
    backendCrashes = backendCrashes.filter((at) => now - at < 5 * 60_000);
    backendCrashes.push(now);
    if (backendCrashes.length > 4) {
      dialog.showErrorBox(
        'ABxAG backend stopped',
        `The ABxAG backend keeps stopping (code ${code}, signal ${signal}). Details are in ${path.join(app.getPath('userData'), 'logs', 'crash.log')}.`,
      );
      isQuitting = true;
      app.quit();
      return;
    }
    setTimeout(() => void restartBackend(), 800 * backendCrashes.length);
  });
}

let backendStderr = '';
/** @type {number[]} */
let backendCrashes = [];

function redact(text) {
  return String(text || '').replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…').replace(/(key|token|secret)=([^&\s]+)/gi, '$1=…');
}

/** Append to %APPDATA%/ABxAG/logs/crash.log (best-effort, never throws). */
function logCrash(message) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'crash.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Watchdogs for states that are broken without anything crashing:
 *  - a window whose page has no content (blank) or does not answer for 8 s
 *    is reloaded;
 *  - a backend that stops answering HTTP for ~45 s is restarted.
 */
function startWatchdogs(reloadSoon) {
  const blank = new Map();
  setInterval(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || !win.isVisible() || win === splashWindow) continue;
      const contents = win.webContents;
      if (contents.isLoading() || !contents.getURL().startsWith(SERVER_ORIGIN)) continue;
      let answered = false;
      const timer = setTimeout(() => {
        if (answered || contents.isDestroyed()) return;
        logCrash(`page not answering: ${contents.getURL()}`);
        reloadSoon(contents, 'not answering');
      }, 8_000);
      contents.executeJavaScript('(() => { const r = document.getElementById("root"); return r ? r.childElementCount : -1; })()', true)
        .then((children) => {
          answered = true;
          clearTimeout(timer);
          const empty = Number(children) <= 0;
          const strikes = empty ? (blank.get(contents.id) || 0) + 1 : 0;
          blank.set(contents.id, strikes);
          if (strikes >= 2) {
            blank.set(contents.id, 0);
            logCrash(`blank page, reloading: ${contents.getURL()}`);
            reloadSoon(contents, 'blank');
          }
        })
        .catch(() => { answered = true; clearTimeout(timer); });
    }
  }, 15_000);

  let misses = 0;
  setInterval(() => {
    if (isQuitting || !serverProcess) return;
    const req = http.get(`${SERVER_ORIGIN}/api/app-settings`, (res) => {
      res.resume();
      misses = 0;
    });
    req.on('error', () => { misses += 1; });
    req.setTimeout(8_000, () => { misses += 1; req.destroy(); });
    if (misses >= 3) {
      misses = 0;
      logCrash('backend stopped answering; restarting it');
      const stuck = serverProcess;
      serverProcess = null;
      try {
        spawn('taskkill', ['/pid', String(stuck.pid), '/T', '/F']);
      } catch {
        /* already gone */
      }
      setTimeout(() => void restartBackend(), 1_500);
    }
  }, 15_000);
}

async function restartBackend() {
  if (isQuitting || serverProcess) return;
  try {
    backendStderr = '';
    startBackend();
    await waitForBackend(SERVER_READY_TIMEOUT_MS);
    logCrash('backend restarted');
    void backendRequest('GET', '/api/app-settings').then(applyShellSettings);
    sendToBackend({ type: 'shell.pids', pids: ownPids() });
    // The pages keep running; reload them only if they lost the connection
    // while the backend was down (a failed load shows an error page).
    for (const win of [mainWindow, companion?.win]) {
      if (win && !win.isDestroyed() && win.webContents.getURL().startsWith('chrome-error')) win.webContents.reload();
    }
  } catch (error) {
    logCrash(`backend restart failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Renderer and GPU crash recovery. A crashed or hung page is reloaded (at
 * most 3 times a minute per window, so a page that crashes on load cannot
 * spin); every event is logged to crash.log.
 */
function installCrashRecovery() {
  const reloads = new Map();
  const reloadSoon = (contents, why) => {
    if (contents.isDestroyed()) return;
    const now = Date.now();
    const recent = (reloads.get(contents.id) || []).filter((at) => now - at < 60_000);
    if (recent.length >= 3) {
      logCrash(`not reloading ${contents.getURL()} again (${why}): too many crashes`);
      return;
    }
    recent.push(now);
    reloads.set(contents.id, recent);
    setTimeout(() => { if (!contents.isDestroyed()) contents.reload(); }, 600);
  };
  app.on('render-process-gone', (_event, contents, details) => {
    logCrash(`renderer gone: ${details.reason} (exit ${details.exitCode}) ${contents.getURL()}`);
    // Out of memory / crashed while drawing her: Auto quality steps one
    // level down so the reload (and every later start) asks less of the PC.
    if (['crashed', 'oom', 'memory-eviction'].includes(details.reason) && contents.getURL().startsWith(SERVER_ORIGIN)) void stepDownGraphics(details.reason);
    if (details.reason !== 'clean-exit') reloadSoon(contents, details.reason);
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') logCrash(`${details.type} process gone: ${details.reason} (exit ${details.exitCode})${details.name ? ` ${details.name}` : ''}`);
  });
  app.on('web-contents-created', (_event, contents) => {
    let hangTimer = null;
    // Page errors go to crash.log too (rate-limited), so a blank window
    // leaves a trace of why.
    let logged = [];
    contents.on('console-message', (event) => {
      const level = event.level ?? event?.params?.level;
      if (!(level === 'error' || level === 3)) return;
      const now = Date.now();
      logged = logged.filter((at) => now - at < 60_000);
      if (logged.length >= 10) return;
      logged.push(now);
      logCrash(`page error (${contents.getURL()}): ${redact(String(event.message ?? '')).slice(0, 600)}`);
    });
    // A page that failed to load (backend restarting, out of memory) is
    // retried instead of staying blank.
    let failures = 0;
    contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted by a newer navigation
      failures += 1;
      logCrash(`load failed (${code} ${description}) ${url}`);
      if (failures <= 8) setTimeout(() => { if (!contents.isDestroyed()) contents.loadURL(url.startsWith('http') ? url : SERVER_ORIGIN); }, Math.min(10_000, 1_500 * failures));
    });
    contents.on('did-finish-load', () => { failures = 0; });
    contents.on('unresponsive', () => {
      logCrash(`page unresponsive: ${contents.getURL()}`);
      clearTimeout(hangTimer);
      // Give it 12 s to recover on its own before reloading.
      hangTimer = setTimeout(() => reloadSoon(contents, 'unresponsive'), 12_000);
    });
    contents.on('responsive', () => clearTimeout(hangTimer));
    contents.on('preload-error', (_e, preloadPath, error) => logCrash(`preload error in ${preloadPath}: ${error && error.message}`));
  });
  startWatchdogs(reloadSoon);
  process.on('uncaughtException', (error) => logCrash(`main process exception: ${redact(error && error.stack ? error.stack : String(error))}`));
  process.on('unhandledRejection', (reason) => logCrash(`main process rejection: ${redact(reason && reason.stack ? reason.stack : String(reason))}`));
}

/**
 * Take one privacy-scoped display snapshot for the backend's vision turn.
 * ABxAG's own window is hidden only while the frame is acquired, then restored
 * to the exact visible/focused state it had before capture.
 */
async function captureDisplayForBackend(requestedMaxDim) {
  const maxDim = Math.max(320, Math.min(1920, Number(requestedMaxDim) || 1440));
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
  const scaleFactor = Number(display.scaleFactor) || 1;
  const captureWidth = Math.max(1, Math.round(display.bounds.width * scaleFactor));
  const captureHeight = Math.max(1, Math.round(display.bounds.height * scaleFactor));

  const canRestore = Boolean(mainWindow && !mainWindow.isDestroyed());
  const wasVisible = canRestore && mainWindow.isVisible();
  const wasFocused = canRestore && mainWindow.isFocused();
  if (wasVisible) {
    mainWindow.hide();
    // Give Windows DWM one frame to expose the application underneath ABxAG.
    await new Promise((resolve) => setTimeout(resolve, 140));
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: captureWidth, height: captureHeight },
      fetchWindowIcons: false,
    });
    const source = sources.find((candidate) => String(candidate.display_id) === String(display.id)) || sources[0];
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
      throw new Error('Electron could not capture the selected display.');
    }

    let image = source.thumbnail;
    const original = image.getSize();
    if (Math.max(original.width, original.height) > maxDim) {
      const ratio = maxDim / Math.max(original.width, original.height);
      image = image.resize({
        width: Math.max(1, Math.round(original.width * ratio)),
        height: Math.max(1, Math.round(original.height * ratio)),
        quality: 'best',
      });
    }
    const payload = image.toJPEG(72);
    const size = image.getSize();
    if (!payload.length) throw new Error('Electron returned an empty screen image.');

    return {
      ok: true,
      result: `Captured display (${original.width}x${original.height}).`,
      width: original.width,
      height: original.height,
      payload_width: size.width,
      payload_height: size.height,
      image_base64: payload.toString('base64'),
      image_mime: 'image/jpeg',
      active_window: null,
      capture_backend: 'electron-desktopCapturer',
    };
  } finally {
    if (wasVisible && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      if (wasFocused) mainWindow.focus();
    }
  }
}

function stopBackend() {
  if (serverProcess && !serverProcess.killed) {
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree so the auto-spawned Python agent goes too.
        spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F']);
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch {
      /* best-effort */
    }
  }
  serverProcess = null;
}

/** Poll the backend until it answers, or reject on timeout. */
function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    // Only ABxAG's own answer counts: another app on the port must not be
    // mistaken for a ready backend (its page would open in ABxAG's window).
    const tryOnce = () => {
      askABxAG(2000, (ok) => {
        if (ok) resolve();
        else if (Date.now() > deadline) reject(new Error('Backend did not become ready in time.'));
        else setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => (splashWindow = null));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false, // revealed on ready-to-show to avoid a white flash
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'ABxAG',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  Menu.setApplicationMenu(null);

  // Open external links (http/https to non-local hosts) in the real browser
  // instead of navigating the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_ORIGIN)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow) splashWindow.close();
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.on('focus', () => mainWindow?.flashFrame(false));
  // With the desktop companion on, closing the main window keeps ABxAG in
  // the tray instead of quitting.
  mainWindow.on('close', (event) => {
    if (!isQuitting && shellSettings?.companion?.enabled) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow) startPhysicalInputSink(mainWindow);
  });

  // ---------------------------------------------------------------------------
  // Screen capture — getDisplayMedia() creates the MediaStream directly in the
  // renderer. This main-process handler selects the display without trying to
  // serialize a live MediaStream through contextBridge.
  // ---------------------------------------------------------------------------
  ipcMain.removeHandler('screen:get-sources');
  ipcMain.handle('screen:get-sources', async (_event, options) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 240, height: 140 },
        ...(options && typeof options === 'object' ? options : {}),
      });
      return sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null,
        display_id: s.display_id,
        appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
      }));
    } catch (err) {
      console.error('[screen:get-sources] failed:', err);
      return [];
    }
  });

  // Grant capture only to ABxAG's own local renderer and provide the display
  // nearest the cursor (falling back to the primary display).
  try {
    const ses = session.defaultSession;
    if (ses && typeof ses.setDisplayMediaRequestHandler === 'function') {
      ses.setDisplayMediaRequestHandler(async (request, callback) => {
        if (!request.videoRequested || !request.securityOrigin.startsWith(SERVER_ORIGIN)) {
          callback({});
          return;
        }

        try {
          const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
          });
          const source = sources.find((candidate) => String(candidate.display_id) === String(display.id)) || sources[0];
          callback(source ? { video: source } : {});
        } catch (error) {
          console.error('[display media handler] source selection failed:', error);
          callback({});
        }
      }, { useSystemPicker: false });
    }
    if (ses && typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler((_wc, permission, callback) => {
        // Allow mic (for voice) and media-related permissions for the app.
        if (permission === 'media' || permission === 'microphone' || permission === 'display-capture') {
          return callback(true);
        }
        return callback(false);
      });
    }
  } catch (err) {
    console.error('[permission handler] setup failed:', err);
  }

  // An opt-in packaged smoke test clicks the real SHARE SCREEN button and
  // confirms React reaches its SHARING state without a srcObject error. It is
  // completely inert during normal launches.
  if (process.env.ABxAG_SCREEN_SHARE_SMOKE_TEST === '1') {
    mainWindow.webContents.once('did-finish-load', async () => {
      const smokePath = path.join(app.getPath('temp'), 'abxag-screen-share-smoke.json');
      try {
        // Programmatic button clicks are never trusted capture gestures in a
        // packaged renderer. Exercise the button's exact media pipeline in a
        // real Electron user-gesture scope instead.
        const result = await mainWindow.webContents.executeJavaScript(`(async () => {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.srcObject = stream;
          await video.play();
          const track = stream.getVideoTracks()[0];
          const settings = track?.getSettings?.() || {};
          const ok = stream instanceof MediaStream && video.srcObject === stream && Boolean(track);
          stream.getTracks().forEach((item) => item.stop());
          video.srcObject = null;
          return { ok, label: 'SHARING', captureError: null, width: settings.width || null, height: settings.height || null };
        })()`, true);
        fs.writeFileSync(smokePath, JSON.stringify({ ...result, packaged: app.isPackaged }, null, 2));
      } catch (error) {
        fs.writeFileSync(smokePath, JSON.stringify({
          ok: false,
          packaged: app.isPackaged,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2));
      } finally {
        setTimeout(() => app.quit(), 300);
      }
    });
  }

  mainWindow.loadURL(SERVER_ORIGIN);
}

// ---------------------------------------------------------------------------
// Shell integration: settings sync, companion, tray, emergency shortcut,
// physical-input detection, power events, notifications.
// ---------------------------------------------------------------------------
/** @type {CompanionManager | null} */
let companion = null;
/** @type {import('electron').Tray | null} */
let tray = null;
let shellSettings = null;
let registeredShortcut = null;
let stopRawInput = () => undefined;

function sendToBackend(message) {
  try {
    if (serverProcess && serverProcess.connected) serverProcess.send(message);
  } catch {
    /* backend restarting */
  }
}

let lastStepDown = 0;
async function stepDownGraphics(reason) {
  if (Date.now() - lastStepDown < 20_000) return; // one crash, one step (both windows may die together)
  lastStepDown = Date.now();
  const settings = await backendRequest('GET', '/api/app-settings');
  if (!settings || (settings.graphics?.quality ?? 'auto') !== 'auto') return;
  const step = Math.min(3, (Number(settings.graphics?.autoStep) || 0) + 1);
  if (step === settings.graphics?.autoStep) return;
  await backendRequest('POST', '/api/app-settings', { graphics: { autoStep: step } });
  logCrash(`graphics: auto quality stepped down to level -${step} after ${reason}`);
}

function backendRequest(method, urlPath, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(`${SERVER_ORIGIN}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => req.destroy());
    if (payload) req.write(payload);
    req.end();
  });
}

function ownPids() {
  try {
    return app.getAppMetrics().map((m) => m.pid);
  } catch {
    return [process.pid];
  }
}

function applyShellSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  shellSettings = settings;
  companion?.applySettings(settings);
  // Emergency stop shortcut (always available, even when ABxAG is hidden).
  const accelerator = settings.autonomy?.emergencyShortcut || 'Control+Alt+Shift+S';
  if (accelerator !== registeredShortcut) {
    if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
    registeredShortcut = null;
    try {
      if (globalShortcut.register(accelerator, () => sendToBackend({ type: 'shortcut.emergency-stop' }))) {
        registeredShortcut = accelerator;
      } else {
        console.warn(`[shell] emergency shortcut ${accelerator} is taken by another app`);
      }
    } catch (error) {
      console.warn('[shell] invalid emergency shortcut:', error && error.message);
    }
  }
  updateTrayMenu();
}

function saveShellSettings(patch) {
  void backendRequest('POST', '/api/app-settings', patch).then((next) => {
    if (next && typeof next === 'object' && next.companion) applyShellSettings(next);
  });
}

function openMainWindow() {
  if (!mainWindow) createMainWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

function openStudio() {
  openMainWindow();
  mainWindow?.webContents.send('app:open-studio');
}

function emergencyStop() {
  sendToBackend({ type: 'shortcut.emergency-stop' });
}

function updateTrayMenu() {
  if (!tray) return;
  const companionOn = Boolean(shellSettings?.companion?.enabled);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ABxAG', click: openMainWindow },
    { label: companionOn ? 'Hide desktop companion' : 'Show desktop companion', click: () => saveShellSettings({ companion: { enabled: !companionOn } }) },
    ...(companionOn ? [{ label: 'Call her here', click: () => companion?.summon() }] : []),
    ...(companion?.hasMovedIcons ? [{ label: 'Put the desktop icons back', click: () => void companion?.restoreIcons() }] : []),
    { label: 'Character Studio…', click: openStudio },
    { type: 'separator' },
    { label: `Stop all tasks (${registeredShortcut || 'no shortcut'})`, click: emergencyStop },
    { type: 'separator' },
    { label: 'Quit ABxAG', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function startShell() {
  try {
    tray = new Tray(nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('ABxAG');
    tray.on('click', openMainWindow);
  } catch (error) {
    console.warn('[shell] tray unavailable:', error && error.message);
  }
  companion = new CompanionManager({
    origin: SERVER_ORIGIN,
    preload: path.join(__dirname, 'preload.cjs'),
    icon: APP_ICON,
    dataDir: app.getPath('userData'),
    backend: backendRequest,
    onMenusChanged: updateTrayMenu,
    sendToBackend,
    saveSettings: saveShellSettings,
    openMain: openMainWindow,
    openStudio,
    emergencyStop,
    ownPids,
  });
  updateTrayMenu();
  void backendRequest('GET', '/api/app-settings').then(applyShellSettings);

  // Power / session events feed presence (no away check-ins while locked).
  for (const event of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) {
    powerMonitor.on(event, () => sendToBackend({ type: 'power', event }));
  }

  // Our own process ids, so perception never treats ABxAG's windows as the target.
  const sendPids = () => sendToBackend({ type: 'shell.pids', pids: ownPids() });
  sendPids();
  setInterval(sendPids, 15_000);

  ipcMain.removeHandler('dialog:pick-character');
  ipcMain.handle('dialog:pick-character', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(owner, {
      title: 'Import a character model',
      properties: ['openFile'],
      filters: [{ name: 'Character model (.zip, .pmx, .pmd, .vrm, .glb, .gltf, .fbx, .obj)', extensions: ['zip', 'pmx', 'pmd', 'vrm', 'glb', 'gltf', 'fbx', 'obj'] }],
    });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  });

  // ---- self updater (see updates.cjs) -------------------------------------
  for (const name of ['updates:get-state', 'updates:check', 'updates:download', 'updates:install', 'updates:set-auto', 'updates:open-url']) {
    ipcMain.removeHandler(name);
  }
  ipcMain.handle('updates:get-state', () => updater.getState());
  ipcMain.handle('updates:check', () => updater.check('manual'));
  ipcMain.handle('updates:download', (_event, version) => updater.downloadVersion(String(version || '')));
  ipcMain.handle('updates:install', (_event, silent) => updater.installDownloaded(Boolean(silent)));
  ipcMain.handle('updates:set-auto', (_event, enabled) => {
    updater.setAuto(Boolean(enabled));
    return updater.getState();
  });
  ipcMain.handle('updates:open-url', (_event, url) => updater.openExternal(url));
}

/** Physical vs synthetic input, aggregated before it reaches the backend. */
function startPhysicalInputSink(win) {
  stopRawInput();
  let pending = { mouse: 0, keyboard: false, last: 0 };
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    const at = Date.now();
    if (pending.mouse > 0) sendToBackend({ type: 'input.physical', kind: 'mouse', at, distance: pending.mouse });
    if (pending.keyboard) sendToBackend({ type: 'input.physical', kind: 'keyboard', at, distance: 0 });
    pending = { mouse: 0, keyboard: false, last: at };
  };
  stopRawInput = win32.startRawInput(win, (input) => {
    if (!input.physical) return; // SendInput from ABxAG's own automation
    if (input.kind === 'mouse') pending.mouse += Math.hypot(input.dx, input.dy);
    else pending.keyboard = true;
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  });
}

function handleRuntimeMessage(message) {
  switch (message.type) {
    case 'runtime:settings':
      applyShellSettings(message.settings);
      break;
    case 'runtime:foreground':
      companion?.onForeground(message);
      break;
    case 'runtime:companion':
      companion?.handleCommand(String(message.command || ''));
      break;
    case 'runtime:notify':
      if (Notification.isSupported()) new Notification({ title: String(message.title || 'ABxAG'), body: String(message.body || ''), icon: APP_ICON }).show();
      break;
    case 'runtime:attention': {
      // A task waits for approval or an answer. The main window shows the
      // dialog itself; when it is hidden or unfocused, point the user to it.
      if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) break;
      mainWindow?.flashFrame(true);
      if (Notification.isSupported()) {
        const notice = new Notification({ title: String(message.title || 'ABxAG'), body: String(message.body || ''), icon: APP_ICON });
        notice.on('click', () => openMainWindow());
        notice.show();
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap sequence
// ---------------------------------------------------------------------------
async function bootstrap() {
  app.setAppUserModelId('dev.absup.abxag');
  installCrashRecovery();
  createSplashWindow();

  try {
    SERVER_PORT = await choosePort();
    SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
    startBackend();
    await waitForBackend(SERVER_READY_TIMEOUT_MS);
    createMainWindow();
    startShell();
    // Self-update: one quiet check at startup, then every 6h while auto is
    // on. The renderer syncs the persisted mode shortly after via
    // `updates:set-auto`; manual mode stops the interval.
    updater.setAuto(true);
    updater.check('auto').catch(() => {});
  } catch (err) {
    if (splashWindow) splashWindow.close();
    dialog.showErrorBox(
      'ABxAG failed to start',
      `${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopRawInput();
});

app.on('window-all-closed', () => {
  // Phase 2 introduces close-to-tray; for now quitting when all windows close
  // is the expected behaviour on Windows.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

process.on('exit', stopBackend);



