'use strict';
/* ABxAG Dual-Cursor — Virtual (AI) cursor overlay.
 * Physical mouse = user. This window = software-rendered neon cursor only.
 * Transparent, click-through, always-on-top, never takes focus.
 */

const { BrowserWindow, ipcMain, screen } = require('electron');

let overlay = null;
let state = { x: 500, y: 400, visible: true, status: 'idle', task: '' };

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100vw;height:100vh;background:transparent;overflow:hidden;pointer-events:none;font-family:system-ui}
#cur{position:fixed;left:0;top:0;will-change:transform;filter:drop-shadow(0 0 6px rgba(255,45,85,.9))}
#pill{position:fixed;right:18px;bottom:16px;background:rgba(10,10,15,.82);border:1px solid rgba(255,45,85,.55);
color:#ffdce3;font-size:12px;padding:7px 12px;border-radius:999px;letter-spacing:.2px}
#dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:#35d07f}
#task{opacity:.75;margin-left:8px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}
</style></head><body>
<div id="cur"><svg width="30" height="30" viewBox="0 0 30 30"><path d="M6 3 L22 15 L14.5 16.5 L12 25 Z" fill="#ff2d55" stroke="#fff" stroke-width="1.6"/><text x="20" y="9" font-size="9" fill="#ff2d55" font-weight="bold">AI</text></svg></div>
<div id="pill"><span id="dot"></span><span id="st">IDLE</span><span id="task"></span></div>
<script>
const { ipcRenderer } = require('electron');
const cur=document.getElementById('cur'),st=document.getElementById('st'),dot=document.getElementById('dot'),task=document.getElementById('task');
ipcRenderer.on('virtual-cursor:update',(_e,s)=>{
  cur.style.transform='translate('+s.x+'px,'+s.y+'px)';
  cur.style.display=s.visible?'block':'none';
  st.textContent=(s.status||'idle').toUpperCase();
  task.textContent=s.task?(' • '+s.task):'';
  dot.style.background=s.status==='active'?'#ff2d55':s.status==='paused'?'#ffb020':'#35d07f';
});
</script></body></html>`;

function createOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.bounds;
  overlay = new BrowserWindow({
    x: 0, y: 0, width, height,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false,
    hasShadow: false, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  overlay.once('ready-to-show', () => { overlay.showInactive(); push(); });
  return overlay;
}

function push() {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('virtual-cursor:update', state);
}

function update(patch) {
  state = { ...state, ...(patch || {}) };
  push();
  return state;
}

function get() { return { ...state }; }

function destroy() { try { overlay?.close(); } catch {} overlay = null; stopPolling(); }

// Live poll: pull authoritative virtual-cursor state from the backend so the
// neon cursor glides whenever ANY virtual tool runs (AI task engine, voice,
// API). Poll is cheap (local JSON, 1/s) and never moves the OS cursor.
let pollTimer = null;
function startPolling(origin) {
  stopPolling();
  if (!origin || typeof origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return;
  const url = origin + '/api/virtual-cursor';
  const tick = () => {
    try {
      const http = require('http');
      const req = http.get(url, (res) => {
        let body = '';
        res.on('data', (c) => { if (body.length < 8192) body += c; });
        res.on('end', () => {
          try {
            const s = JSON.parse(body);
            // Kill switch (Settings → PC control & safety): hide the whole
            // overlay while OFF, show it again the moment it is re-enabled.
            if (s && s.enabled === false) {
              if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.hide();
              return;
            }
            if (overlay && !overlay.isDestroyed() && !overlay.isVisible()) overlay.showInactive();
            if (s && typeof s.x === 'number' && typeof s.y === 'number') {
              state = {
                x: s.x, y: s.y,
                visible: s.visible !== false,
                status: ['active', 'paused', 'idle'].includes(s.status) ? s.status : state.status,
                task: typeof s.task === 'string' ? s.task.slice(0, 160) : state.task,
              };
              push();
            }
          } catch {}
        });
      });
      req.on('error', () => {});
      req.setTimeout(3000, () => req.destroy());
    } catch {}
  };
  pollTimer = setInterval(tick, 1000);
  if (pollTimer.unref) pollTimer.unref();
  tick();
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

try {
  ipcMain.removeHandler('virtual-cursor:get');
  ipcMain.handle('virtual-cursor:get', () => get());
  ipcMain.removeHandler('virtual-cursor:update');
  ipcMain.handle('virtual-cursor:update', (_e, patch) => update(patch));
} catch {}

module.exports = { createOverlay, updateVirtualCursor: update, getVirtualCursor: get, destroyOverlay: destroy, startPolling, stopPolling };
