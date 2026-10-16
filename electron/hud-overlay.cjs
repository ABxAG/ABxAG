'use strict';
/* ABxAG HUD overlay — ZORION-style fully interactive widget dashboard.
 *
 * Separate always-on-top BrowserWindow loading the same app with `?hud=1`
 * (standalone HudOverlay React root). Unlike the virtual-cursor overlay
 * (transparent, click-through, non-interactive), this window is interactive
 * by default and hosts 9 widgets + a live 3D-avatar mirror relayed from the
 * main window via `hud:sync` IPC.
 */

const { BrowserWindow, ipcMain, screen } = require('electron');

const HUD_QUERY = '?hud=1';
const SIZE_FULL = { width: 384, height: 660 };
const SIZE_COMPACT = { width: 256, height: 420 };

let overlay = null;
let origin = null;
let hooks = { sendToBackend: () => undefined, openMain: () => undefined };
let ipcInstalled = false;
let userVisible = false;
let hiddenForFullscreen = false;
let lastCompact = null;

/** Shell callbacks (backend relay + open-main). Called once from main.cjs. */
function initHudIpc(callbacks) {
  if (callbacks && typeof callbacks === 'object') hooks = { ...hooks, ...callbacks };
  if (ipcInstalled) return;
  ipcInstalled = true;
  // Main window → overlay relay.
  ipcMain.on('hud:sync', (event, payload) => {
    if (event.sender.isDestroyed()) return;
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send('hud:sync', payload || {});
  });
  // Overlay → backend runtime message (quick actions use HTTP; this covers
  // anything that needs the socket channel).
  ipcMain.on('hud:backend', (event, message) => {
    if (event.sender.isDestroyed()) return;
    try {
      hooks.sendToBackend(message || {});
    } catch {}
  });
  // Overlay chrome buttons.
  ipcMain.on('hud:close', () => setHudVisible(false));
  ipcMain.on('hud:show-main', () => {
    try {
      hooks.openMain();
    } catch {}
  });
}

function currentSettings() {
  return {
    enabled: false,
    alwaysOnTop: true,
    opacity: 0.94,
    clickThrough: false,
    hideInFullscreen: true,
    compact: false,
  };
}

let pendingSettings = currentSettings();

function createHudOverlay(serverOrigin) {
  if (overlay && !overlay.isDestroyed()) return overlay;
  origin = serverOrigin;
  const size = pendingSettings.compact ? SIZE_COMPACT : SIZE_FULL;
  const area = screen.getPrimaryDisplay().workArea;
  overlay = new BrowserWindow({
    x: Math.round(area.x + area.width - size.width - 24),
    y: Math.round(area.y + 48),
    width: size.width,
    height: size.height,
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: require('path').join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  overlay.loadURL(origin + HUD_QUERY);
  overlay.once('ready-to-show', () => {
    applyHudSettings(pendingSettings);
    if (userVisible && !hiddenForFullscreen) overlay.showInactive();
  });
  overlay.on('closed', () => {
    overlay = null;
  });
  lastCompact = pendingSettings.compact;
  return overlay;
}

function destroyHudOverlay() {
  try {
    overlay?.close();
  } catch {}
  overlay = null;
  userVisible = false;
  hiddenForFullscreen = false;
  lastCompact = null;
}

function isHudOpen() {
  return Boolean(overlay && !overlay.isDestroyed());
}

function setHudVisible(visible) {
  userVisible = Boolean(visible);
  if (!isHudOpen()) {
    if (userVisible && origin) {
      createHudOverlay(origin);
      // showInactive fires on ready-to-show
    }
    return userVisible;
  }
  if (userVisible && !hiddenForFullscreen) overlay.showInactive();
  else overlay.hide();
  return userVisible;
}

function isHudVisibleNow() {
  try {
    return Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());
  } catch {
    return false;
  }
}

/** Global hotkey: flip between shown and hidden. */
function toggleHudVisible() {
  return setHudVisible(!isHudVisibleNow());
}

/** Apply server-side overlay settings (also called before first show). */
function applyHudSettings(settings) {
  const next = {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : pendingSettings.enabled,
    alwaysOnTop: typeof settings?.alwaysOnTop === 'boolean' ? settings.alwaysOnTop : pendingSettings.alwaysOnTop,
    opacity: Number.isFinite(Number(settings?.opacity)) ? Math.max(0.4, Math.min(1, Number(settings.opacity))) : pendingSettings.opacity,
    clickThrough: typeof settings?.clickThrough === 'boolean' ? settings.clickThrough : pendingSettings.clickThrough,
    hideInFullscreen: typeof settings?.hideInFullscreen === 'boolean' ? settings.hideInFullscreen : pendingSettings.hideInFullscreen,
    compact: typeof settings?.compact === 'boolean' ? settings.compact : pendingSettings.compact,
  };
  pendingSettings = next;
  if (!isHudOpen()) return next;
  try {
    overlay.setOpacity(next.opacity);
    overlay.setAlwaysOnTop(next.alwaysOnTop, 'screen-saver');
    overlay.setIgnoreMouseEvents(next.clickThrough, { forward: true });
    if (lastCompact !== next.compact) {
      lastCompact = next.compact;
      const size = next.compact ? SIZE_COMPACT : SIZE_FULL;
      overlay.setSize(size.width, size.height);
    }
  } catch {}
  return next;
}

/** Hide for fullscreen apps (driven by the same runtime:foreground feed as the companion). */
function onHudForeground(info) {
  if (!isHudOpen()) return;
  const hide = Boolean(info?.fullscreen) && pendingSettings.hideInFullscreen;
  if (hide && !hiddenForFullscreen) {
    hiddenForFullscreen = true;
    overlay.hide();
  } else if (!hide && hiddenForFullscreen) {
    hiddenForFullscreen = false;
    if (userVisible) overlay.showInactive();
  }
}

module.exports = {
  initHudIpc,
  createHudOverlay,
  destroyHudOverlay,
  isHudOpen,
  isHudVisibleNow,
  setHudVisible,
  toggleHudVisible,
  applyHudSettings,
  onHudForeground,
};
