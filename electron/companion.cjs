/* ===========================================================================
 * Desktop companion window — and her brain.
 *
 * A transparent, frameless, always-on-top window that shows only the
 * character. It is click-through everywhere except her silhouette (the
 * renderer hit-tests its own pixels and asks us to toggle mouse capture), so
 * it never blocks the desktop underneath.
 *
 * This module owns everything that needs the SCREEN:
 *   surfaces - she stands and sits only on things you can see: the taskbar
 *              and the top edges of visible, unoccluded windows
 *   contact  - the renderer reports which canvas row she rests on (the floor
 *              under her feet, or the seat line when sitting); the window is
 *              placed so that row lies exactly on the surface - no hovering
 *   drag / throw / fall / land, riding along with a moving window
 *   brain    - when left alone she lives on the desktop: walks along the
 *              surface, sits on the edge, stretches and yawns, hides behind a
 *              screen edge and peeks back in, and (if allowed) tugs a desktop
 *              icon out of place, which she puts back when asked
 * The renderer (CompanionActor) performs; it never moves the window itself.
 * Coordinates are Electron DIPs unless noted.
 * ========================================================================= */
'use strict';

const { BrowserWindow, screen, Menu, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const win32 = require('./win32.cjs');

const BASE_WIDTH = 300;
const BASE_HEIGHT = 560;
const GRAVITY = 2600; // DIP / s^2
const TICK_MS = 16;
/** Height of a window's title bar / tab strip she hangs from (DIP). */
const TITLE_BAR = 34;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (weighted) => {
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [value, w] of weighted) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return weighted.length ? weighted[weighted.length - 1][0] : null;
};

class CompanionManager {
  /**
   * @param {{ origin: string, preload: string, dataDir: string, sendToBackend: (m: object) => void,
   *   backend: (method: string, path: string, body?: object) => Promise<any>,
   *   saveSettings: (patch: object) => void, openMain: () => void, openStudio: () => void,
   *   emergencyStop: () => void, ownPids: () => number[] }} options
   */
  constructor(options) {
    this.options = options;
    /** @type {BrowserWindow | null} */
    this.win = null;
    this.settings = null;
    this.interactive = false;
    this.drag = null;
    this.motion = null; // { vx, vy } while thrown/falling
    this.anchor = { kind: 'ground', hwnd: 0, rect: null };
    /** What she is doing, as far as the window is concerned. */
    this.mode = 'standing';
    this.contactY = null; // canvas row she rests on (renderer)
    this.metrics = { walkSpeed: 160, heightPx: 500, halfWidthPx: 60, floorY: BASE_HEIGHT - 1 };
    this.hiddenForFullscreen = false;
    this.hiddenSide = null;
    this.timers = new Set();
    this.cursorTimer = null;
    this.physicsTimer = null;
    this.anchorTimer = null;
    this.brainTimer = null;
    this.moveTimer = null;
    this.nextThought = Date.now() + 8000;
    this.waiters = new Map(); // act -> resolve
    this.lastUserTouch = 0;
    this.iconFile = path.join(options.dataDir, 'companion', 'icon-positions.json');
    this.samples = [];
    this.registerIpc();
  }

  registerIpc() {
    const fromCompanion = (event) => this.win && event.sender === this.win.webContents;
    ipcMain.on('companion:interactive', (event, value) => {
      if (!fromCompanion(event)) return;
      this.setInteractive(Boolean(value));
      if (value) this.lastUserTouch = Date.now();
    });
    ipcMain.on('companion:drag-start', (event) => {
      if (!fromCompanion(event)) return;
      this.beginDrag();
    });
    ipcMain.on('companion:drag-end', (event) => {
      if (!fromCompanion(event)) return;
      this.endDrag();
    });
    ipcMain.on('companion:poke', (event, kind) => {
      if (!fromCompanion(event)) return;
      this.lastUserTouch = Date.now();
      this.options.sendToBackend({ type: 'companion.interaction', kind: kind === 'head_pat' ? 'head_pat' : 'poke' });
    });
    // Legacy: older renderers moved the window by a seat offset.
    ipcMain.on('companion:seat', () => undefined);
    ipcMain.on('companion:contact', (event, y, durationMs) => {
      if (!fromCompanion(event)) return;
      const row = Number(y);
      if (!Number.isFinite(row)) return;
      this.contactY = Math.max(0, Math.min(this.size().height, row));
      if (['standing', 'sitting', 'walking', 'busy', 'hanging'].includes(this.mode)) this.settleOnSurface(Math.max(0, Math.min(3000, Number(durationMs) || 0)));
    });
    ipcMain.on('companion:metrics', (event, metrics) => {
      if (!fromCompanion(event) || !metrics) return;
      this.metrics = { ...this.metrics, ...metrics };
      this.resolveWaiter('metrics');
    });
    ipcMain.on('companion:done', (event, act) => {
      if (!fromCompanion(event)) return;
      this.resolveWaiter(String(act));
    });
    ipcMain.on('companion:summon', (event) => {
      if (!fromCompanion(event)) return;
      this.summon();
    });
    ipcMain.on('companion:context-menu', (event) => {
      if (!fromCompanion(event)) return;
      this.showMenu();
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  applySettings(settings) {
    // A new graphics budget (quality / auto step-down) needs a fresh GPU
    // context: reload her page.
    const graphics = JSON.stringify({ q: settings?.graphics?.quality, s: settings?.graphics?.autoStep });
    if (this.win && !this.win.isDestroyed() && this.graphicsKey && graphics !== this.graphicsKey) this.win.webContents.reload();
    this.graphicsKey = graphics;
    this.settings = settings;
    const enabled = Boolean(settings?.companion?.enabled);
    if (enabled && !this.win) this.create();
    else if (!enabled && this.win) this.destroy();
    else if (this.win) this.resize();
  }

  get level() {
    return this.settings?.companion?.interactionLevel || 'normal';
  }

  size() {
    const scale = Math.max(0.4, Math.min(2.5, Number(this.settings?.companion?.scale) || 1));
    // Lying down she is as long as she is tall: a landscape window.
    if (this.lying) return { width: Math.round(BASE_HEIGHT * scale * 1.02), height: Math.round(BASE_HEIGHT * scale * 0.46) };
    return { width: Math.round(BASE_WIDTH * scale), height: Math.round(BASE_HEIGHT * scale) };
  }

  /** Room above a window ledge (px) and how she fits there. */
  ledgeFit(rect) {
    const H = this.metrics.heightPx || 500;
    const room = rect.y - this.area().y;
    return room >= H * 0.9 ? 'stand' : room >= H * 0.55 ? 'sit' : 'lie';
  }

  /** Fade the window out, run `work`, fade back in: hides a shape change. */
  async fade(work) {
    if (!this.win) return;
    const step = (from, to, ms) => new Promise((resolve) => {
      const started = Date.now();
      const t = setInterval(() => {
        const k = Math.min(1, (Date.now() - started) / ms);
        if (this.win && !this.win.isDestroyed()) this.win.setOpacity(from + (to - from) * k);
        if (k >= 1) { clearInterval(t); resolve(); }
      }, 16);
    });
    await step(1, 0, 140);
    try {
      await work();
    } finally {
      await step(0, 1, 220);
    }
  }

  /** Opacity back to 1 over `ms` (after a hidden re-pose). */
  fadeIn(ms) {
    if (!this.win || this.win.isDestroyed()) return;
    const from = this.win.getOpacity();
    if (from >= 1) return;
    const started = Date.now();
    const t = setInterval(() => {
      const k = Math.min(1, (Date.now() - started) / ms);
      if (this.win && !this.win.isDestroyed()) this.win.setOpacity(from + (1 - from) * k);
      if (k >= 1 || !this.win) clearInterval(t);
    }, 16);
  }

  /** Hang from a high window's title bar by both hands, legs dangling. */
  async hangOn(ledge) {
    if (!this.win) return;
    this.anchor = { kind: 'window', hwnd: ledge.hwnd, rect: { ...ledge.rect } };
    this.hanging = true;
    this.mode = 'hanging';
    // Glide over the bar (no sideways snap) while her hands reach up.
    const { x: wx } = this.pos();
    const half = this.size().width / 2;
    const cx = Math.min(Math.max(wx + half, ledge.rect.x + 40), ledge.rect.x + ledge.rect.width - 40);
    if (Math.abs(cx - (wx + half)) > 1) void this.slideTo(cx - half, 180);
    this.command({ act: 'hang' });
    this.log(`hang from "${String(ledge.title).slice(0, 40)}" line=${ledge.line}`);
    // She holds on for a while, then lets go and drops.
    const token = this.busyToken;
    this.later(rand(20000, 40000), () => {
      if (this.hanging && token === this.busyToken) this.letGo();
    });
  }

  letGo() {
    if (!this.hanging) return;
    this.hanging = false;
    this.anchor = { kind: 'none', hwnd: 0, rect: null };
    this.startFall(0, 60);
  }

  /** Lie down along the ledge she is on (no room above it to sit). */
  async lieDown() {
    if (!this.win || this.lying) return;
    const side = Math.random() < 0.5 ? 1 : -1;
    await this.fade(async () => {
      const before = this.win.getBounds();
      const centre = before.x + before.width / 2;
      this.lying = true;
      this.mode = 'lying';
      const { width, height } = this.size();
      const surface = this.surfaceY();
      this.win.setBounds({ x: Math.round(centre - width / 2), y: Math.round(surface - height + 6), width, height });
      this.command({ act: 'lie', side });
      await this.waitFor('lie', 2500);
      this.settleOnSurface(0);
    });
    this.log(`lie down on ${this.anchor.kind}${this.anchor.rect ? ` top=${this.anchor.rect.y}` : ''}`);
  }

  /** Back to the upright window shape (standing). */
  async getUp() {
    if (!this.win || !this.lying) return;
    await this.fade(async () => {
      const before = this.win.getBounds();
      const centre = before.x + before.width / 2;
      this.lying = false;
      const { width, height } = this.size();
      const surface = this.surfaceY();
      this.win.setBounds({ x: Math.round(centre - width / 2), y: Math.round(surface - height), width, height });
      this.mode = 'standing';
      this.command({ act: 'stand' });
      await this.waitFor('stand', 2500);
      this.settleOnSurface(0);
    });
  }

  create() {
    const { width, height } = this.size();
    const display = screen.getPrimaryDisplay();
    const saved = this.settings?.companion?.position;
    const work = display.workArea;
    const x = saved ? saved.x : work.x + work.width - width - 60;
    const y = saved ? saved.y : work.y + work.height - height;
    this.win = new BrowserWindow({
      x, y, width, height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      alwaysOnTop: true,
      fullscreenable: false,
      backgroundColor: '#00000000',
      title: 'ABxAG companion',
      ...(this.options.icon ? { icon: this.options.icon } : {}),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    // Above the taskbar so she can sit on it.
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.interactive = false;
    this.mode = 'standing';
    this.contactY = null;
    this.win.loadURL(`${this.options.origin}/?mode=companion`);
    this.win.on('closed', () => {
      this.win = null;
      this.stopTimers();
    });
    // A reloaded page (crash recovery) starts standing.
    this.win.webContents.on('did-finish-load', () => {
      this.mode = 'standing';
      this.contactY = null;
    });
    this.startCursorFeed();
    this.anchorTimer = setInterval(() => {
      try {
        this.followAnchor();
      } catch (error) {
        console.warn('[companion] follow:', error && error.message);
      }
    }, TICK_MS);
    this.brainTimer = setInterval(() => this.think(), 1000);
    // Land wherever the saved position was (kept on screen).
    this.later(600, () => {
      this.keepOnScreen();
      this.startFall(0, 0);
    });
  }

  destroy() {
    this.stopTimers();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  resize() {
    if (!this.win) return;
    const { width, height } = this.size();
    const [w, h] = this.win.getSize();
    if (w === width && h === height) return;
    const [x, y] = this.win.getPosition();
    this.win.setBounds({ x, y: y + h - height, width, height });
  }

  stopTimers() {
    clearInterval(this.cursorTimer);
    clearInterval(this.physicsTimer);
    clearInterval(this.anchorTimer);
    clearInterval(this.brainTimer);
    clearInterval(this.moveTimer);
    clearInterval(this.settleTimer);
    clearInterval(this.drag?.timer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.cursorTimer = this.physicsTimer = this.anchorTimer = this.brainTimer = this.moveTimer = null;
    this.drag = null;
    for (const resolve of this.waiters.values()) resolve(false);
    this.waiters.clear();
  }

  later(ms, run) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        run();
      } catch (error) {
        console.warn('[companion]', error && error.message);
      }
    }, ms);
    this.timers.add(t);
    return t;
  }

  sleep(ms) {
    return new Promise((resolve) => this.later(ms, resolve));
  }

  /** Move the window; never with a non-number (that throws inside a timer and freezes her). */
  place(x, y) {
    if (!this.win || this.win.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.fpos = { x, y };
    this.win.setPosition(Math.round(x), Math.round(y));
  }

  /**
   * Window position keeping the fraction of a pixel: Windows stores whole
   * pixels, and re-reading them each tick loses slow motion (a walk that
   * eases in stalls, then jumps; DPI scaling makes it judder).
   */
  pos() {
    const [x, y] = this.win.getPosition();
    const f = this.fpos;
    if (f && Math.abs(Math.round(f.x) - x) <= 1 && Math.abs(Math.round(f.y) - y) <= 1) return { x: f.x, y: f.y };
    return { x, y };
  }

  /** setInterval whose callback can't throw forever: an error stops that timer and settles her. */
  every(fn, ms) {
    const timer = setInterval(() => {
      try {
        fn();
      } catch (error) {
        clearInterval(timer);
        console.warn('[companion] timer stopped:', error && error.message);
        if (this.mode === 'walking' || this.mode === 'busy') {
          this.command({ act: 'stop' });
          this.mode = 'standing';
        }
      }
    }, ms);
    return timer;
  }

  setInteractive(value) {
    if (!this.win || this.interactive === value || this.drag) return;
    this.interactive = value;
    this.win.setIgnoreMouseEvents(!value, { forward: true });
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  command(payload) {
    this.send('companion:command', payload);
  }

  /** Wait for the renderer to report `act` done (or time out). */
  waitFor(act, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const previous = this.waiters.get(act);
      if (previous) previous(false);
      const timer = this.later(timeoutMs, () => {
        if (this.waiters.get(act) === done) this.waiters.delete(act);
        resolve(false);
      });
      const done = (ok = true) => {
        clearTimeout(timer);
        this.timers.delete(timer);
        resolve(ok);
      };
      this.waiters.set(act, done);
    });
  }

  resolveWaiter(act) {
    const resolve = this.waiters.get(act);
    if (resolve) {
      this.waiters.delete(act);
      resolve(true);
    }
  }

  /** Hide for fullscreen apps/games according to the user's setting. */
  onForeground(info) {
    if (!this.win) return;
    const behaviour = this.settings?.companion?.fullscreenBehavior ?? 'game_aware';
    const hide = Boolean(info?.fullscreen) && (behaviour === 'hide' || behaviour === 'game_aware');
    if (hide && !this.hiddenForFullscreen) {
      this.hiddenForFullscreen = true;
      this.win.hide();
    } else if (!hide && this.hiddenForFullscreen) {
      this.hiddenForFullscreen = false;
      this.win.showInactive();
    }
  }

  // ---- geometry ----------------------------------------------------------------

  /** Work area of the display she is on. */
  area() {
    const b = this.win.getBounds();
    const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    return display.workArea;
  }

  /** Canvas row of her contact line (feet or seat). */
  contact() {
    return this.contactY ?? this.metrics.floorY ?? this.size().height - 1;
  }

  /** Screen y of the surface she is on. */
  surfaceY() {
    if (this.anchor.kind === 'window' && this.anchor.rect) return this.anchor.rect.y + (this.hanging ? TITLE_BAR : 0);
    const area = this.area();
    return area.y + area.height;
  }

  /**
   * How far the window may hang past the screen edge while her body stays on
   * screen (the window is wider than she is).
   */
  sideMargin() {
    return Math.max(0, this.size().width / 2 - (this.metrics.halfWidthPx || 60) * 1.15);
  }

  clampX(x) {
    const area = this.area();
    const m = this.sideMargin();
    const { width } = this.size();
    return Math.max(area.x - m, Math.min(area.x + area.width - width + m, x));
  }

  /** Never accidentally off screen: pull the window back inside. */
  keepOnScreen() {
    if (!this.win || this.mode === 'hidden' || this.mode === 'peeking') return;
    const [x, y] = this.win.getPosition();
    const area = this.area();
    const { height } = this.size();
    const nx = this.clampX(x);
    const ny = Math.max(area.y - height * 0.2, Math.min(area.y + area.height - this.contact(), y));
    if (nx !== x || ny !== y) this.place(Math.round(nx), Math.round(ny));
  }

  /** Window top edges she could stand on, in z-order (top first), in DIPs. */
  windowsInZOrder() {
    if (!win32.available()) return [];
    const own = new Set(this.options.ownPids());
    return win32
      .listWindows()
      .filter((w) => !own.has(w.pid))
      .map((w) => {
        const rect = screen.screenToDipRect(null, { x: w.rect.left, y: w.rect.top, width: w.rect.right - w.rect.left, height: w.rect.bottom - w.rect.top });
        return { hwnd: w.hwnd, title: w.title, rect };
      });
  }

  /** Is point (x, y) on window `index` hidden by a window above it? */
  static covered(windows, index, x, y) {
    for (let i = 0; i < index; i++) {
      const r = windows[i].rect;
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return true;
    }
    return false;
  }

  /**
   * Visible top edges: not covered at the probe x by a window above, and low
   * enough that she fits on screen above them (a maximised window's top is
   * the top of the screen, which is not a ledge).
   */
  surfaces(probeX) {
    const windows = this.windowsInZOrder();
    const area = this.win ? this.area() : screen.getPrimaryDisplay().workArea;
    // Room for her seated upper body is enough: on a ledge too high to
    // stand on she sits instead (see the landing code).
    const headroom = (this.metrics.heightPx || 500) * 0.3;
    const out = [];
    windows.forEach((w, i) => {
      const top = w.rect.y;
      if (top < area.y + headroom || top > area.y + area.height - 40) return;
      if (probeX !== undefined && CompanionManager.covered(windows, i, probeX, top + 3)) return;
      out.push({ ...w, index: i });
    });
    return { list: out, windows };
  }

  // ---- placing the window on her surface ---------------------------------------------

  /** Ease the window vertically so her contact row lies on the surface. */
  settleOnSurface(durationMs) {
    if (!this.win) return;
    const targetY = Math.round(this.surfaceY() - this.contact());
    const y0 = this.pos().y;
    if (Math.abs(targetY - y0) < 1) return;
    clearInterval(this.settleTimer);
    const started = Date.now();
    const ease = (t) => t * t * (3 - 2 * t);
    if (durationMs <= 0) {
      this.place(this.pos().x, targetY);
      return;
    }
    this.settleTimer = this.every(() => {
      if (!this.win) return clearInterval(this.settleTimer);
      const t = Math.min(1, (Date.now() - started) / durationMs);
      this.place(this.pos().x, y0 + (targetY - y0) * ease(t));
      if (t >= 1) clearInterval(this.settleTimer);
    }, TICK_MS);
  }

  // ---- cursor awareness ----------------------------------------------------

  startCursorFeed() {
    let last = '';
    this.cursorTimer = setInterval(() => {
      if (!this.win || !this.win.isVisible()) return;
      const p = screen.getCursorScreenPoint();
      const b = this.win.getBounds();
      const msg = { x: p.x - b.x, y: p.y - b.y, width: b.width, height: b.height };
      const key = `${msg.x},${msg.y}`;
      if (key === last) return;
      last = key;
      this.send('companion:cursor', msg);
    }, 50);
  }

  // ---- drag, throw, fall, land ---------------------------------------------

  interrupt() {
    clearInterval(this.moveTimer);
    this.moveTimer = null;
    clearInterval(this.settleTimer);
    this.busyToken = (this.busyToken || 0) + 1;
    for (const resolve of this.waiters.values()) resolve(false);
    this.waiters.clear();
  }

  beginDrag() {
    if (!this.win) return;
    this.interrupt();
    this.hanging = false;
    if (this.lying) {
      // Picked up from lying: upright window shape under the cursor at once,
      // kept invisible until the renderer has re-posed and re-framed her
      // (otherwise a frame or two shows the lying pose squashed upright).
      const cursor = screen.getCursorScreenPoint();
      this.lying = false;
      const { width, height } = this.size();
      this.win.setOpacity(0);
      this.win.setBounds({ x: Math.round(cursor.x - width / 2), y: Math.round(cursor.y - height * 0.3), width, height });
      this.command({ act: 'stand' });
      void this.waitFor('stand', 900).then(() => this.fadeIn(140));
    }
    clearInterval(this.physicsTimer);
    this.physicsTimer = null;
    this.motion = null;
    this.mode = 'held';
    this.anchor = { kind: 'none', hwnd: 0, rect: null };
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = this.win.getPosition();
    this.samples = [{ t: Date.now(), x, y }];
    this.win.setIgnoreMouseEvents(false);
    this.drag = {
      offsetX: cursor.x - x,
      offsetY: cursor.y - y,
      timer: setInterval(() => this.dragTick(), TICK_MS),
    };
    this.send('companion:state', { state: 'held' });
  }

  dragTick() {
    if (!this.win || !this.drag) return;
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = this.win.getPosition();
    const nx = cursor.x - this.drag.offsetX;
    const ny = cursor.y - this.drag.offsetY;
    if (nx === x && ny === y) {
      this.samples.push({ t: Date.now(), x, y });
      return;
    }
    this.place(Math.round(nx), Math.round(ny));
    this.send('companion:moved', { dx: nx - x, dy: ny - y, kind: 'drag' });
    this.samples.push({ t: Date.now(), x: nx, y: ny });
    if (this.samples.length > 12) this.samples.shift();
    // Magnet: over a window's top edge she already takes a sitting shape,
    // so you can see she will sit there when you let go.
    const now = Date.now();
    if (now - (this.drag.ledgeCheckedAt || 0) > 120) {
      this.drag.ledgeCheckedAt = now;
      const found = this.ledgeUnderSeat();
      const over = found ? found.kind : '';
      if (over !== this.drag.overLedge) {
        this.drag.overLedge = over;
        this.command({ act: 'ledge', near: Boolean(found), kind: found ? found.kind : 'sit' });
      }
    }
  }

  /** Small diagnostic log of placement decisions (logs/companion.log). */
  log(message) {
    try {
      const dir = path.join(this.options.dataDir, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'companion.log');
      try {
        if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.old`);
      } catch {
        /* no file yet */
      }
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      /* best effort */
    }
  }

  endDrag() {
    if (!this.drag) return;
    clearInterval(this.drag.timer);
    this.drag = null;
    this.lastUserTouch = Date.now();
    // Release velocity from the last ~90 ms of motion.
    const now = Date.now();
    const recent = this.samples.filter((s) => now - s.t < 90);
    let vx = 0;
    let vy = 0;
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = Math.max(0.016, (b.t - a.t) / 1000);
      vx = (b.x - a.x) / dt;
      vy = (b.y - a.y) / dt;
    }
    const clampV = (v) => Math.max(-2600, Math.min(2600, v));
    this.interactive = true;
    // Placed, not thrown, with her seat over a window's top edge: she sits
    // right there (Desktop Mate style) instead of falling past it.
    const ledge = Math.hypot(vx, vy) < 1800 ? this.ledgeUnderSeat() : null;
    this.log(`release v=${Math.round(Math.hypot(vx, vy))} ledge=${ledge ? `"${ledge.title.slice(0, 40)}" top=${ledge.rect.y}` : 'none'}`);
    if (ledge && ledge.kind === 'hang') {
      void this.hangOn(ledge);
      return;
    }
    if (ledge) {
      const { x: wx } = this.pos();
      const half = this.size().width / 2;
      const cx = Math.min(Math.max(wx + half, ledge.rect.x + 40), ledge.rect.x + ledge.rect.width - 40);
      this.mode = 'standing';
      this.anchor = { kind: 'window', hwnd: ledge.hwnd, rect: { ...ledge.rect } };
      this.send('companion:state', { state: 'standing', anchor: 'window', title: ledge.title });
      this.nextThought = Date.now() + rand(15000, 25000);
      const style = pick([['perch', 3], ['handsOnKnees', 3], ['ankles', 2], ['crossed', 1.5], ['leanBack', 1]]);
      // Glide onto the ledge (no sideways snap), then sit; the seat line
      // eases onto the edge as she sits.
      void (async () => {
        if (Math.abs(cx - (wx + half)) > 1) await this.slideTo(cx - half, 160);
        if (this.mode === 'standing') await this.sitDown(style);
      })();
      return;
    }
    this.startFall(clampV(vx), clampV(vy), { fromUser: true });
  }

  /**
   * A visible window top edge around where her seat is right now: between a
   * quarter of her height above her hips and just below her feet.
   */
  ledgeUnderSeat() {
    if (!this.win) return null;
    const b = this.win.getBounds();
    const H = this.metrics.heightPx || 500;
    const half = (this.metrics.halfWidthPx || 60) * 1.2;
    const feet = b.y + this.contact();
    const seat = feet - H * 0.35;
    const centre = b.x + b.width / 2;
    const area = this.area();
    const windows = this.windowsInZOrder();
    let best = null;
    const headY = feet - H * 0.95;
    windows.forEach((w, index) => {
      const r = w.rect;
      const top = r.y;
      if (top > area.y + area.height - 30) return;
      // A window too close to the top of the screen to sit on (maximised
      // windows, tab strips at the top): she hangs from its title bar by her
      // hands, her body dangling inside the window, fully visible.
      if (top < area.y + H * 0.3) {
        const line = top + TITLE_BAR;
        if (headY < line - H * 0.4 || headY > line + H * 0.35) return;
        const left = Math.max(centre - half, r.x + 20);
        const right = Math.min(centre + half, r.x + r.width - 20);
        if (right - left < 10) return;
        const probe = Math.min(Math.max(centre, left), right);
        if (CompanionManager.covered(windows, index, probe, line - 4)) return;
        const score = Math.abs(headY - line) + H * 0.05;
        if (!best || score < best.score) best = { ...w, index, score, probe, kind: 'hang', line };
        return;
      }
      // Anywhere from well above her hips down to just below her feet.
      if (top < seat - H * 0.45 || top > feet + H * 0.12) return;
      // Her body must overlap the edge, and the overlapping part be visible.
      const left = Math.max(centre - half, r.x + 20);
      const right = Math.min(centre + half, r.x + r.width - 20);
      if (right - left < 10) return;
      const probe = Math.min(Math.max(centre, left), right);
      if (CompanionManager.covered(windows, index, probe, top + 3)) return;
      const score = Math.abs(top - seat);
      if (!best || score < best.score) best = { ...w, index, score, probe, kind: 'sit' };
    });
    return best;
  }

  startFall(vx, vy, { fromUser = false } = {}) {
    if (!this.win) return;
    this.interrupt();
    this.droppedByUser = fromUser;
    clearInterval(this.physicsTimer);
    this.mode = 'falling';
    this.motion = { vx, vy, last: Date.now() };
    this.send('companion:state', { state: 'falling' });
    let found = this.surfaces();
    let refresh = 0;
    this.physicsTimer = this.every(() => {
      if (!this.win || !this.motion) return;
      const now = Date.now();
      const dt = Math.min(0.05, (now - this.motion.last) / 1000);
      this.motion.last = now;
      if ((refresh += dt) > 0.5) {
        found = this.surfaces();
        refresh = 0;
      }
      const m = this.motion;
      const area = this.area();
      const p = this.pos();
      const b = { ...this.win.getBounds(), x: p.x, y: p.y };
      const margin = this.sideMargin();
      const feetRow = this.contact();
      m.vy += GRAVITY * dt;
      m.vx *= Math.pow(0.35, dt); // air drag
      let x = b.x + m.vx * dt;
      let y = b.y + m.vy * dt;
      // Bounce off the sides of the work area (her body, not the window).
      if (x < area.x - margin) { x = area.x - margin; m.vx = -m.vx * 0.35; }
      if (x + b.width > area.x + area.width + margin) { x = area.x + area.width + margin - b.width; m.vx = -m.vx * 0.35; }
      if (y < area.y - b.height * 0.5) { y = area.y - b.height * 0.5; m.vy = Math.max(0, m.vy); }
      // Landing: her feet are `feetRow` px below the window top.
      const feetBefore = b.y + feetRow;
      const feetAfter = y + feetRow;
      let ground = area.y + area.height;
      let landedOn = null;
      if (m.vy > 0) {
        const centre = x + b.width / 2;
        for (const s of found.list) {
          const top = s.rect.y;
          if (centre > s.rect.x + 24 && centre < s.rect.x + s.rect.width - 24 && top >= feetBefore - 2 && top <= feetAfter && top < ground
            && !CompanionManager.covered(found.windows, s.index, centre, top + 3)) {
            ground = top;
            landedOn = s;
          }
        }
      }
      if (feetAfter >= ground && m.vy >= 0) {
        y = ground - feetRow;
        const impact = m.vy;
        this.motion = null;
        clearInterval(this.physicsTimer);
        this.physicsTimer = null;
        this.anchor = landedOn ? { kind: 'window', hwnd: landedOn.hwnd, rect: { ...landedOn.rect } } : { kind: 'ground', hwnd: 0, rect: null };
        this.place(Math.round(x), Math.round(y));
        this.mode = 'standing';
        this.send('companion:moved', { dx: x - b.x, dy: y - b.y, kind: 'land', impact });
        this.send('companion:state', { state: 'standing', anchor: this.anchor.kind, title: landedOn?.title ?? null });
        this.options.saveSettings({ companion: { position: { x: Math.round(x), y: Math.round(y) } } });
        this.nextThought = Date.now() + rand(3000, 7000);
        // Put her on a window (or the taskbar) and she makes herself at
        // home: dropped on a ledge she sits down on it, legs over the edge.
        const cramped = landedOn && landedOn.rect.y - area.y < (this.metrics.heightPx || 500) * 0.9;
        if ((this.droppedByUser && (landedOn || Math.random() < 0.5) && impact < 2200) || cramped) {
          const style = pick([['perch', 3], ['handsOnKnees', 3], ['ankles', 2], ['crossed', 1.5], ['leanBack', 1]]);
          this.nextThought = Date.now() + rand(15000, 25000);
          this.later(350, () => {
            if (this.mode === 'standing') void this.sitDown(style);
          });
        }
        this.droppedByUser = false;
        return;
      }
      this.place(x, y);
      this.send('companion:moved', { dx: x - b.x, dy: y - b.y, kind: 'fall' });
    }, TICK_MS);
  }

  /**
   * Ride along with the window she stands on. She hops down when it closes,
   * minimises, moves off screen, or another window covers the spot she is on.
   */
  followAnchor() {
    if (!this.win || this.drag || this.motion || this.anchor.kind !== 'window') return;
    if (this.mode === 'hidden' || this.mode === 'peeking') return;
    const { x, y } = this.pos();
    const { width } = this.size();
    const centre = x + width / 2;
    const now = Date.now();
    let rect;
    // Every frame: just that window's rectangle, so she rides a dragged
    // window smoothly. Every 250 ms: the full check (closed, covered,
    // maximised, slid out from under her).
    if (now - (this.anchorCheckedAt || 0) >= 250) {
      this.anchorCheckedAt = now;
      const found = this.surfaces();
      const current = found.windows.find((s) => s.hwnd === this.anchor.hwnd);
      const index = found.windows.indexOf(current);
      const area = this.area();
      const lost = !current
        || (!this.hanging && current.rect.y < area.y + (this.metrics.heightPx || 500) * (this.lying ? 0.02 : this.mode === 'sitting' ? 0.15 : 0.4))
        || CompanionManager.covered(found.windows, index, centre, current.rect.y + 3)
        || centre < current.rect.x + 10 || centre > current.rect.x + current.rect.width - 10;
      if (lost) {
        this.anchor = { kind: 'none', hwnd: 0, rect: null };
        this.startFall(0, 0);
        return;
      }
      rect = current.rect;
    } else {
      const raw = win32.windowRect(this.anchor.hwnd);
      if (!raw) return; // gone: the full check lets her drop
      rect = screen.screenToDipRect(null, { x: raw.left, y: raw.top, width: raw.right - raw.left, height: raw.bottom - raw.top });
    }
    const prev = this.anchor.rect;
    const dx = rect.x - prev.x;
    const dy = rect.y - prev.y;
    if (dx === 0 && dy === 0) return;
    this.anchor.rect = { ...rect };
    const nx = this.clampX(x + dx);
    if (Math.abs(dx) > 400 || Math.abs(dy) > 400) {
      // Window jumped (snapped/maximised): teleport without a whip.
      this.place(nx, y + dy);
      this.send('companion:moved', { dx: 0, dy: 0, kind: 'teleport' });
      return;
    }
    this.place(nx, y + dy);
    this.send('companion:moved', { dx, dy, kind: 'carried' });
  }

  // ---- walking ---------------------------------------------------------------------

  /** Walk along her surface to window-x `targetX` (clamped unless `offscreen`). */
  async walkTo(targetX, { offscreen = false, sneak = false } = {}) {
    if (!this.win) return false;
    const token = this.busyToken;
    if (this.mode === 'sitting') await this.standUp();
    const [x0] = this.win.getPosition();
    let goal = offscreen ? targetX : this.clampX(targetX);
    if (this.anchor.kind === 'window' && this.anchor.rect && !offscreen) {
      const { width } = this.size();
      const r = this.anchor.rect;
      goal = Math.max(r.x + 30 - width / 2, Math.min(r.x + r.width - 30 - width / 2, goal));
    }
    if (!Number.isFinite(goal)) return false;
    const dir = goal >= x0 ? 1 : -1;
    if (Math.abs(goal - x0) < 8) return true;
    this.mode = 'walking';
    this.command({ act: 'walk', dir, ...(sneak ? { sneak: true } : {}) });
    await this.waitFor('metrics', 600);
    if (token !== this.busyToken) return false;
    return new Promise((resolve) => {
      let last = Date.now();
      let speed = 0;
      clearInterval(this.moveTimer);
      this.moveTimer = this.every(() => {
        if (!this.win || token !== this.busyToken) {
          clearInterval(this.moveTimer);
          return resolve(false);
        }
        const now = Date.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        // Ease into her walking speed as the gait ramps up.
        speed += ((this.metrics.walkSpeed || 160) - speed) * (1 - Math.exp(-6 * dt));
        const { x, y } = this.pos();
        const remaining = (goal - x) * dir;
        const step = Math.min(remaining, speed * dt);
        const nx = x + dir * Math.max(0, step);
        if (remaining <= 1 || Math.abs(nx - x) < 0.01 && speed > 20) {
          clearInterval(this.moveTimer);
          this.moveTimer = null;
          this.command({ act: 'stop' });
          this.mode = 'standing';
          return resolve(true);
        }
        this.place(nx, y);
        this.send('companion:moved', { dx: nx - x, dy: 0, kind: 'walk' });
        // The ledge ended under her (window moved): stop.
        if (this.anchor.kind === 'window' && this.anchor.rect && !offscreen) {
          const { width } = this.size();
          const c = nx + width / 2;
          if (c < this.anchor.rect.x + 20 || c > this.anchor.rect.x + this.anchor.rect.width - 20) goal = nx;
        }
      }, TICK_MS);
    });
  }

  // ---- sitting ----------------------------------------------------------------------

  async sitDown(style) {
    if (!this.win || this.mode === 'sitting' || this.lying) return;
    // On a ledge near the top of the screen there is no room to sit up:
    // she lies down along it instead, fully visible.
    if (this.anchor.kind === 'window' && this.anchor.rect && this.ledgeFit(this.anchor.rect) === 'lie') {
      await this.lieDown();
      return;
    }
    this.mode = 'sitting';
    this.command({ act: 'sit', ...(style ? { style } : {}) });
    await this.waitFor('sit', 2500);
  }

  async standUp() {
    if (this.lying) {
      if (this.anchor.kind === 'window' && this.anchor.rect && this.ledgeFit(this.anchor.rect) !== 'stand') return;
      await this.getUp();
      return;
    }
    if (this.mode !== 'sitting') return;
    this.command({ act: 'stand' });
    this.mode = 'standing';
    await this.waitFor('stand', 2000);
  }

  // ---- hide and peek ------------------------------------------------------------------

  /** A screen edge with no neighbouring display (so off-screen is truly hidden). */
  freeSide() {
    const area = this.area();
    const displays = screen.getAllDisplays();
    const blocked = (side) => displays.some((d) => {
      const b = d.bounds;
      if (b.y >= area.y + area.height || b.y + b.height <= area.y) return false;
      return side === 'left' ? Math.abs(b.x + b.width - area.x) < 4 : Math.abs(b.x - (area.x + area.width)) < 4;
    });
    const [x] = this.win.getPosition();
    const nearLeft = x + this.size().width / 2 < area.x + area.width / 2;
    const order = nearLeft ? ['left', 'right'] : ['right', 'left'];
    return order.find((side) => !blocked(side)) || null;
  }

  async hide() {
    if (!this.win || this.mode === 'hidden') return;
    if (this.anchor.kind !== 'ground') return;
    const side = this.freeSide();
    if (!side) return;
    const area = this.area();
    const { width } = this.size();
    const target = side === 'left' ? area.x - width - 10 : area.x + area.width + 10;
    // Tiptoe off, glancing back over her shoulder.
    const ok = await this.walkTo(target, { offscreen: true, sneak: true });
    if (!ok || !this.win) return;
    this.mode = 'hidden';
    this.hiddenSide = side;
    // Peek back in by herself after a while.
    const token = this.busyToken;
    this.later(rand(15000, 45000), () => {
      if (this.mode === 'hidden' && token === this.busyToken) void this.peekIn();
    });
  }

  /** Hands first, then her head, then the rest of her: peeking in from the edge. */
  async peekIn() {
    if (!this.win || this.mode !== 'hidden') return;
    const side = this.hiddenSide || 'right';
    const token = this.busyToken;
    this.mode = 'peeking';
    const area = this.area();
    const { width } = this.size();
    const edge = side === 'left' ? area.x : area.x + area.width;
    const s = side === 'left' ? 1 : -1;
    const ground = area.y + area.height;
    const hiddenX = side === 'left' ? area.x - width - 10 : area.x + area.width + 10;
    this.anchor = { kind: 'ground', hwnd: 0, rect: null };
    this.place(Math.round(hiddenX), Math.round(ground - this.contact()));

    this.command({ act: 'peek', side, phase: 'hands' });
    await this.waitFor('metrics', 1500);
    await this.waitFor('peek', 1500);
    if (token !== this.busyToken || !this.win) return;
    const handX = this.metrics.handX ?? width / 2 + s * 70;
    // Her fingers over the edge.
    await this.slideTo(edge - handX, 520);
    await this.sleep(rand(700, 1100));
    if (token !== this.busyToken) return;

    this.command({ act: 'peek', side, phase: 'head' });
    await this.waitFor('metrics', 1500);
    if (token !== this.busyToken) return;
    // Hands stay on the edge; her head leans out past them by itself. Only
    // nudge the window if the solved hands moved.
    const holdX = this.metrics.handX ?? handX;
    await this.slideTo(edge - holdX, 400);
    await this.sleep(rand(1400, 2200));
    if (token !== this.busyToken) return;

    this.command({ act: 'peek', side, phase: 'out' });
    await this.waitFor('stand', 1500);
    this.mode = 'standing';
    this.hiddenSide = null;
    const into = side === 'left' ? area.x + rand(120, 260) : area.x + area.width - width - rand(120, 260);
    await this.walkTo(into);
    if (token !== this.busyToken) return;
    this.command({ act: 'perform', name: 'wave' });
    this.nextThought = Date.now() + rand(6000, 10000);
  }

  /** Horizontal slide (peeking), eased; no clamping. */
  slideTo(x, durationMs) {
    return new Promise((resolve) => {
      if (!this.win || !Number.isFinite(x)) return resolve(false);
      const { x: x0, y } = this.pos();
      const started = Date.now();
      const token = this.busyToken;
      clearInterval(this.moveTimer);
      this.moveTimer = this.every(() => {
        if (!this.win || token !== this.busyToken) {
          clearInterval(this.moveTimer);
          return resolve(false);
        }
        const t = Math.min(1, (Date.now() - started) / durationMs);
        const e = t * t * (3 - 2 * t);
        const px = this.pos().x;
        const nx = x0 + (x - x0) * e;
        this.place(nx, y);
        this.send('companion:moved', { dx: nx - px, dy: 0, kind: 'walk' });
        if (t >= 1) {
          clearInterval(this.moveTimer);
          this.moveTimer = null;
          resolve(true);
        }
      }, TICK_MS);
    });
  }

  /** She was called (spoken to, "come here"): come out and say hi. */
  summon() {
    if (!this.win) return;
    if (this.mode === 'hidden') {
      this.interrupt();
      this.mode = 'hidden';
      void this.peekIn();
      return;
    }
    if (this.mode === 'standing' || this.mode === 'sitting') {
      this.nextThought = Date.now() + 12000;
      void (async () => {
        if (this.mode === 'sitting') await this.standUp();
        this.command({ act: 'perform', name: 'wave' });
      })();
    }
  }

  // ---- desktop icons ----------------------------------------------------------------------

  readMovedIcons() {
    try {
      const data = JSON.parse(fs.readFileSync(this.iconFile, 'utf-8'));
      return data && typeof data === 'object' && data.icons && typeof data.icons === 'object' ? data.icons : {};
    } catch {
      return {};
    }
  }

  writeMovedIcons(icons) {
    try {
      fs.mkdirSync(path.dirname(this.iconFile), { recursive: true });
      if (!Object.keys(icons).length) {
        fs.rmSync(this.iconFile, { force: true });
        return;
      }
      fs.writeFileSync(this.iconFile, JSON.stringify({ version: 1, icons }, null, 2));
    } catch (error) {
      console.warn('[companion] could not save icon positions:', error && error.message);
    }
  }

  /** Icons in DIPs, with the list-view origin at the virtual screen's top-left. */
  async icons() {
    const data = await this.options.backend('GET', '/api/companion/icons');
    if (!data || !Array.isArray(data.items) || data.auto_arrange) return null;
    // The desktop list view's client origin is the virtual screen's top-left.
    const displays = screen.getAllDisplays();
    const originDip = { x: Math.min(...displays.map((d) => d.bounds.x)), y: Math.min(...displays.map((d) => d.bounds.y)) };
    const origin = process.platform === 'win32' ? screen.dipToScreenPoint(originDip) : originDip;
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    return data.items.map((item) => {
      const dip = process.platform === 'win32' ? screen.screenToDipPoint({ x: item.x + origin.x, y: item.y + origin.y }) : { x: item.x, y: item.y };
      // An icon cell is ~76 physical px wide; its image sits in the top ~64 px.
      return { name: String(item.name), x: item.x, y: item.y, dx: dip.x, dy: dip.y, w: 76 / scale, h: 76 / scale };
    });
  }

  async moveIcon(name, physicalX, physicalY) {
    return this.options.backend('POST', '/api/companion/icons/move', { name, x: Math.round(physicalX), y: Math.round(physicalY) });
  }

  /** Walk to a bottom-row desktop icon, grab it and tug it out of place. */
  async playWithIcon() {
    if (!this.win || this.anchor.kind !== 'ground' || this.mode !== 'standing') return false;
    if (!this.settings?.companion?.iconPlay) return false;
    const token = this.busyToken;
    const icons = await this.icons();
    if (!icons || token !== this.busyToken) return false;
    const area = this.area();
    const ground = area.y + area.height;
    const H = this.metrics.heightPx || 500;
    const windows = this.windowsInZOrder();
    const reachable = icons.filter((icon) => {
      const cy = icon.dy + icon.h / 2;
      const cx = icon.dx + icon.w / 2;
      const above = ground - cy;
      // Waist-high icons: she grabs them with a light bend.
      if (above < H * 0.3 || above > H * 0.56) return false;
      if (cx < area.x || cx > area.x + area.width - 200) return false;
      // Hidden behind a window: she can't see it either.
      return !windows.some((w) => cx >= w.rect.x && cx <= w.rect.x + w.rect.width && cy >= w.rect.y && cy <= w.rect.y + w.rect.height);
    });
    if (!reachable.length) return false;
    const icon = reachable[Math.floor(Math.random() * reachable.length)];
    const { width } = this.size();
    const iconCx = icon.dx + icon.w / 2;
    const iconCy = icon.dy + icon.h * 0.4;
    // Stand just to the right of it, reaching left, then pull it rightward.
    const standX = iconCx + H * 0.2 - width / 2;
    const arrived = await this.walkTo(standX);
    if (!arrived || token !== this.busyToken || !this.win) return false;
    this.mode = 'busy';
    const [wx, wy] = this.win.getPosition();
    this.command({ act: 'reach', x: iconCx - wx, y: iconCy - wy });
    await this.waitFor('reach', 2000);
    if (token !== this.busyToken) return false;

    const moved = this.readMovedIcons();
    if (!moved[icon.name]) {
      moved[icon.name] = { x: icon.x, y: icon.y, at: new Date().toISOString() };
      this.writeMovedIcons(moved);
    }
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    const tugs = Math.round(rand(4, 7));
    let total = 0;
    for (let i = 0; i < tugs; i++) {
      if (token !== this.busyToken || !this.win) break;
      this.command({ act: 'tug' });
      const step = rand(26, 44);
      await this.slideTo(this.win.getPosition()[0] + step, 420);
      total += step;
      void this.moveIcon(icon.name, icon.x + total * scale, icon.y);
      await this.waitFor('tug', 1000);
    }
    this.command({ act: 'release' });
    await this.waitFor('stand', 1500);
    this.mode = 'standing';
    this.updateMenus();
    return true;
  }

  /** Put every icon she moved back where it was. */
  async restoreIcons() {
    const moved = this.readMovedIcons();
    const names = Object.keys(moved);
    if (!names.length) {
      if (this.win) this.command({ act: 'perform', name: 'giggle' });
      return 0;
    }
    if (this.win) {
      if (this.mode === 'hidden') await this.peekIn();
      if (this.mode === 'sitting') await this.standUp();
      this.command({ act: 'perform', name: 'fixHair' });
    }
    const current = (await this.options.backend('GET', '/api/companion/icons'))?.items || [];
    let restored = 0;
    for (const name of names) {
      const target = moved[name];
      const now = current.find((item) => item.name === name);
      // Glide back in a few steps.
      const from = now ? { x: now.x, y: now.y } : target;
      for (let i = 1; i <= 5; i++) {
        const t = i / 5;
        await this.moveIcon(name, from.x + (target.x - from.x) * t, from.y + (target.y - from.y) * t);
        await this.sleep(70);
      }
      restored += 1;
      delete moved[name];
    }
    this.writeMovedIcons(moved);
    this.updateMenus();
    if (this.win) this.later(900, () => this.command({ act: 'perform', name: 'happyFace' }));
    return restored;
  }

  // ---- the brain ------------------------------------------------------------------------------

  /** Called every second; decides what she does next when she's left alone. */
  think() {
    if (!this.win || this.hiddenForFullscreen || this.drag || this.motion) return;
    if (this.hanging) {
      if (Date.now() >= this.nextThought) {
        this.nextThought = Date.now() + rand(6000, 12000);
        this.command({ act: 'perform', name: pick([['lookAround', 2], ['happyFace', 1], ['effortFace', 1]]) });
      }
      return;
    }
    if (this.lying) {
      // Lying on a high ledge: she just lounges; she gets up only if moved.
      if (Date.now() >= this.nextThought) {
        this.nextThought = Date.now() + rand(12000, 25000);
        this.command({ act: 'perform', name: pick([['lookAround', 2], ['yawnFace', 1], ['happyFace', 1]]) });
      }
      return;
    }
    if (!['standing', 'sitting'].includes(this.mode)) return;
    const now = Date.now();
    if (now < this.nextThought) return;
    // Someone is hovering or just played with her: let them.
    if (this.interactive || now - this.lastUserTouch < 6000) {
      this.nextThought = now + 3000;
      return;
    }
    const level = this.level;
    const pace = level === 'minimal' ? 2.4 : level === 'playful' ? 0.65 : 1;
    const companion = this.settings?.companion || {};
    const lively = level !== 'minimal';
    const run = (work) => {
      void Promise.resolve()
        .then(work)
        .catch((error) => console.warn('[companion] behaviour failed:', error && error.message))
        .finally(() => {
          if (this.mode === 'busy') this.mode = 'standing';
        });
    };

    if (this.mode === 'sitting') {
      const choice = pick([
        ['switch', 3],
        ['stretchUp', 2],
        ['yawn', 2],
        ['lookAround', 2],
        ['think', 2],
        // On a ledge too high to stand on she stays seated.
        ['stand', this.anchor.kind === 'window' && this.anchor.rect && this.anchor.rect.y - this.area().y < (this.metrics.heightPx || 500) * 0.9 ? 0 : lively ? 2.5 : 1],
      ]);
      this.nextThought = now + rand(9000, 22000) * pace;
      if (choice === 'stand') run(() => this.standUp());
      else this.command({ act: 'perform', name: choice });
      return;
    }

    const choice = pick([
      ['stretchUp', 2.5],
      ['yawn', 2],
      ['handsBehind', 2],
      ['fixHair', 2],
      ['lookAround', 2],
      ['giggle', 0.8],
      ['sit', 3.5],
      ['walk', companion.walkAround !== false && lively ? 4 : 0],
      ['icon', companion.iconPlay && lively && this.anchor.kind === 'ground' ? (level === 'playful' ? 2.5 : 1.2) : 0],
      ['hide', companion.hideAndPeek !== false && lively && this.anchor.kind === 'ground' ? (level === 'playful' ? 3 : 1.6) : 0],
    ]);
    this.nextThought = now + rand(7000, 16000) * pace;
    switch (choice) {
      case 'sit':
        run(() => this.sitDown());
        break;
      case 'walk': {
        const [x] = this.win.getPosition();
        const distance = rand(140, 520) * (Math.random() < 0.5 ? -1 : 1);
        run(async () => {
          await this.walkTo(x + distance);
          if (Math.random() < 0.35) await this.sitDown();
        });
        break;
      }
      case 'icon':
        run(async () => {
          const played = await this.playWithIcon();
          if (!played) this.command({ act: 'perform', name: 'lookAround' });
        });
        break;
      case 'hide':
        run(() => this.hide());
        break;
      default:
        this.command({ act: 'perform', name: choice });
    }
  }

  /** Commands from the backend (voice / chat: "come here", "put the icons back"). */
  handleCommand(command) {
    switch (command) {
      case 'come_here':
        this.summon();
        break;
      case 'restore_icons':
        void this.restoreIcons();
        break;
      case 'sit':
        if (this.mode === 'standing') void this.sitDown();
        break;
      case 'stand':
        void this.standUp();
        break;
      case 'stretch':
        this.command({ act: 'perform', name: 'stretchUp' });
        break;
      case 'wave':
        this.command({ act: 'perform', name: 'wave' });
        break;
      case 'hide':
        if (this.mode === 'sitting') void this.standUp().then(() => this.hide());
        else void this.hide();
        break;
      case 'play_with_icons':
        if (this.mode === 'standing') void this.playWithIcon();
        break;
      default:
        break;
    }
  }

  // ---- menus ----------------------------------------------------------------------------------

  updateMenus() {
    this.options.onMenusChanged?.();
  }

  get hasMovedIcons() {
    return Object.keys(this.readMovedIcons()).length > 0;
  }

  showMenu() {
    if (!this.win) return;
    const sitting = this.mode === 'sitting';
    const styles = [
      ['perch', 'Knees together'],
      ['handsOnKnees', 'Hands on her knees'],
      ['ankles', 'Ankles crossed'],
      ['leanBack', 'Leaning back'],
      ['crossed', 'Legs crossed'],
    ];
    const companion = this.settings?.companion || {};
    const menu = Menu.buildFromTemplate([
      sitting
        ? { label: 'Stand up', click: () => void this.standUp() }
        : { label: 'Sit here', submenu: styles.map(([style, label]) => ({ label, click: () => { this.interrupt(); this.mode = 'standing'; void this.sitDown(style); } })) },
      {
        label: 'Do something',
        submenu: (sitting
          ? [['think', 'Think (chin on her hand)'], ['stretchUp', 'Stretch'], ['yawn', 'Yawn'], ['lookAround', 'Look around'], ['switch', 'Sit another way']]
          : [['stretchUp', 'Stretch'], ['yawn', 'Yawn'], ['handsBehind', 'Hands behind her back'], ['fixHair', 'Fix her hair'], ['giggle', 'Giggle']]
        ).map(([name, label]) => ({ label, click: () => { this.nextThought = Date.now() + 15000; this.command({ act: 'perform', name }); } })),
      },
      { label: 'Wave', click: () => this.command({ act: 'perform', name: 'wave' }) },
      { label: 'Hide and peek', enabled: this.anchor.kind === 'ground' && !sitting, click: () => void this.hide() },
      { type: 'separator' },
      { label: 'Put the desktop icons back', enabled: this.hasMovedIcons, click: () => void this.restoreIcons() },
      { label: 'Play with a desktop icon', type: 'checkbox', checked: Boolean(companion.iconPlay), click: (item) => this.options.saveSettings({ companion: { iconPlay: item.checked } }) },
      { label: 'Walk around', type: 'checkbox', checked: companion.walkAround !== false, click: (item) => this.options.saveSettings({ companion: { walkAround: item.checked } }) },
      { type: 'separator' },
      { label: 'Open ABxAG', click: () => this.options.openMain() },
      { label: 'Character Studio…', click: () => this.options.openStudio() },
      { label: 'Stop all ABxAG tasks', click: () => this.options.emergencyStop() },
      { type: 'separator' },
      { label: 'Hide companion', click: () => this.options.saveSettings({ companion: { enabled: false } }) },
    ]);
    menu.popup({ window: this.win });
  }
}

module.exports = { CompanionManager };

