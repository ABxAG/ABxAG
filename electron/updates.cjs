/* ===========================================================================
 * ABxAG — self updater (main process)
 * ---------------------------------------------------------------------------
 * Checks GitHub Releases (ABxAG/ABxAG), downloads the NSIS Setup asset and
 * launches it. The SAME flow installs upgrades and downgrades: the NSIS
 * installer removes the current copy first, so "switch to any version" is
 * just "download that version, run its installer".
 *
 * No new npm dependencies. State is pushed to every window as
 * `updates:event` snapshots; the renderer drives everything through the
 * `updates:*` IPC handlers registered by electron/main.cjs.
 * ========================================================================= */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const RELEASES_URL = 'https://api.github.com/ABxAG/ABxAG/releases?per_page=20';
// Same feed, mirrored on our own site: api.github.com is unreachable from
// some networks (it 404s anonymously there), while abxag.absup.dev and
// github.com downloads work fine. releases.json is refreshed every release.
const FALLBACK_FEED_URL = 'https://abxag.absup.dev/releases.json';
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'abxag.absup.dev',
  'abxag.pages.dev',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;

/** Compare "1.1.1" style versions (leading "v" tolerated). -1|0|1. */
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^[vV]/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^[vV]/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function httpsGetJson(url, userAgent, redirects = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error(`Bad update URL: ${url}`));
      return;
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
      reject(new Error(`Blocked update host: ${parsed.hostname}`));
      return;
    }
    const req = https.get(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/vnd.github+json' },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        httpsGetJson(res.headers.location, userAgent, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Update server answered ${res.statusCode}`));
        return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('Update server returned an invalid response.'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Update check timed out.')));
    req.on('error', (err) => reject(err));
  });
}

/** Download a file with progress; resolves with the temp path. */
function downloadFile(url, dest, userAgent, onProgress) {
  return new Promise((resolve, reject) => {
    const attempt = (target, redirects) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        reject(new Error('Bad download URL.'));
        return;
      }
      if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
        reject(new Error(`Blocked download host: ${parsed.hostname}`));
        return;
      }
      const req = https.get(target, {
        headers: { 'User-Agent': userAgent, Accept: 'application/octet-stream' },
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          attempt(res.headers.location, redirects - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed (${res.statusCode}).`));
          return;
        }
        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) onProgress(Math.min(1, received / total));
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve({ received, total })));
        out.on('error', (err) => {
          fs.unlink(dest, () => reject(err));
        });
      });
      req.on('timeout', () => req.destroy(new Error('Download timed out.')));
      req.on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
    };
    attempt(url, 5);
  });
}

function parseReleases(json) {
  const out = [];
  for (const rel of Array.isArray(json) ? json : []) {
    if (rel.draft) continue;
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const setup = assets.find((a) => /-Setup-.*\.exe$/i.test(a.name || ''));
    const portable = assets.find((a) => /-Portable-.*\.exe$/i.test(a.name || ''));
    out.push({
      version: String(rel.tag_name || '').replace(/^[vV]/, ''),
      name: String(rel.name || rel.tag_name || ''),
      notes: String(rel.body || '').slice(0, 4000),
      publishedAt: rel.published_at || null,
      prerelease: Boolean(rel.prerelease),
      setupAsset: setup ? { name: setup.name, url: setup.browser_download_url, size: setup.size || 0 } : null,
      portableAsset: portable ? { name: portable.name, url: portable.browser_download_url, size: portable.size || 0 } : null,
    });
  }
  out.sort((a, b) => -compareVersions(a.version, b.version));
  return out;
}

function createUpdater({ app, shell, BrowserWindow, log = () => {}, spawnFn = null }) {
  const currentVersion = app.getVersion();
  const userAgent = `ABxAG-Updater/${currentVersion}`;
  const spawnInstaller = spawnFn || spawn;
  // Silent (/S) installs only make sense for the installed (NSIS) build.
  // Dev runs and the portable exe always use the interactive installer.
  let canSilentInstall = false;
  try {
    const exePath = typeof app.getPath === 'function' ? String(app.getPath('exe') || '') : '';
    canSilentInstall = Boolean(app.isPackaged) && !/portable/i.test(exePath);
  } catch {
    canSilentInstall = Boolean(app.isPackaged);
  }

  const state = {
    status: 'idle', // idle|checking|up-to-date|update-available|downloading|downloaded|installing|error
    currentVersion,
    releases: [], // [{version,name,notes,publishedAt,prerelease,setupAsset:{name,url,size},portableAsset}]
    latestNewer: null,
    progress: 0,
    downloadedVersion: null,
    downloadedFile: null,
    error: null,
    lastCheckedAt: null,
    canSilentInstall,
  };

  let timer = null;
  let downloading = false;
  let installing = false;

  const snapshot = () => ({ ...state, releases: state.releases.map((r) => ({ ...r })) });

  function emit() {
    const snap = snapshot();
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send('updates:event', snap);
      } catch {
        /* window gone */
      }
    }
  }

  function set(partial) {
    Object.assign(state, partial);
    emit();
  }

  async function check(reason = 'manual') {
    if (state.status === 'checking' || state.status === 'downloading' || installing) return snapshot();
    set({ status: 'checking', error: null });
    log(`[updates] checking (${reason})…`);
    let json = null;
    let feedError = null;
    try {
      json = await httpsGetJson(RELEASES_URL, userAgent);
    } catch (err) {
      feedError = err instanceof Error ? err.message : String(err);
      log(`[updates] primary feed failed (${feedError}); trying mirror…`);
      try {
        json = await httpsGetJson(FALLBACK_FEED_URL, userAgent);
        feedError = null;
      } catch (mirrorErr) {
        feedError = mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr);
      }
    }
    try {
      if (!json) throw new Error(feedError || 'Update server answered 404');
      const releases = parseReleases(json);
      const newer = releases.find((r) => compareVersions(r.version, currentVersion) > 0 && r.setupAsset) || null;
      state.lastCheckedAt = new Date().toISOString();
      if (releases.length === 0) {
        set({ releases, latestNewer: null, status: 'error', error: 'No releases found on GitHub yet.' });
      } else if (newer) {
        set({ releases, latestNewer: newer.version, status: 'update-available' });
        log(`[updates] newer version available: ${newer.version}`);
        if (reason === 'auto') {
          // Auto mode downloads immediately; the user installs when ready.
          await downloadVersion(newer.version).catch(() => {});
        }
      } else {
        set({ releases, latestNewer: null, status: 'up-to-date' });
        log('[updates] already on the latest version.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[updates] check failed: ${message}`);
      set({ status: 'error', error: `Could not check for updates (${message}). Check your connection and retry.` });
    }
    return snapshot();
  }

  async function downloadVersion(version) {
    const rel = state.releases.find((r) => r.version === String(version).replace(/^[vV]/, ''));
    if (!rel || !rel.setupAsset) throw new Error(`Version ${version} has no installer to download.`);
    if (downloading) return snapshot();
    downloading = true;
    set({ status: 'downloading', progress: 0, error: null });
    const dest = path.join(os.tmpdir(), `ABxAG-${rel.version}-Setup.exe`);
    log(`[updates] downloading ${rel.setupAsset.name}…`);
    try {
      const { received, total } = await downloadFile(rel.setupAsset.url, dest, userAgent, (p) => {
        state.progress = p;
        emit();
      });
      if (rel.setupAsset.size > 0 && received !== rel.setupAsset.size) {
        throw new Error(`Download incomplete (got ${received} of ${rel.setupAsset.size} bytes).`);
      }
      if (total === 0 && received < 1024 * 1024) {
        throw new Error('Download looks incomplete — please retry.');
      }
      log(`[updates] downloaded ${rel.version} (${(received / 1048576).toFixed(1)} MB).`);
      set({ status: 'downloaded', progress: 1, downloadedVersion: rel.version, downloadedFile: dest });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[updates] download failed: ${message}`);
      try { fs.unlinkSync(dest); } catch { /* already gone */ }
      set({ status: 'error', error: `Download failed (${message}).`, progress: 0 });
    } finally {
      downloading = false;
    }
    return snapshot();
  }

  function installDownloaded(silent = false) {
    if (!app.isPackaged) {
      set({ status: 'error', error: 'Installing works only in the downloaded app — get the Setup installer from abxag.absup.dev/download/.' });
      return snapshot();
    }
    if (!state.downloadedFile || !fs.existsSync(state.downloadedFile)) {
      set({ status: 'error', error: 'The downloaded installer is gone — please download again.' });
      return snapshot();
    }
    // Silent installs need the installed (non-portable) build; otherwise the
    // interactive wizard runs so the user sees where it goes.
    const useSilent = Boolean(silent) && canSilentInstall;
    installing = true;
    set({ status: 'installing' });
    const installer = state.downloadedFile;
    const args = useSilent ? ['/S'] : [];
    log(`[updates] launching installer ${installer}${useSilent ? ' silently (/S)' : ''} and quitting.`);
    // Give the backend/agent time to exit so no file is locked when the
    // installer runs (silent installs start at once; the wizard's clicks
    // naturally buy the same time for interactive installs).
    const quitDelayMs = useSilent ? 2500 : 800;
    setTimeout(() => {
      try {
        const child = spawnInstaller(installer, args, { detached: true, stdio: 'ignore', windowsHide: false });
        if (child && typeof child.unref === 'function') child.unref();
      } catch (err) {
        installing = false;
        set({ status: 'error', error: `Could not launch the installer (${err instanceof Error ? err.message : err}).` });
        return;
      }
      app.quit();
    }, quitDelayMs);
    return snapshot();
  }

  function openExternal(url) {
    try {
      const parsed = new URL(String(url));
      const allowed = ['abxag.absup.dev', 'abxag.pages.dev', 'github.com', 'aistudio.google.com'];
      if (parsed.protocol === 'https:' && allowed.includes(parsed.hostname)) {
        shell.openExternal(parsed.toString());
        return true;
      }
    } catch {
      /* fall through */
    }
    return false;
  }

  function setAuto(enabled) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (enabled) {
      timer = setInterval(() => {
        check('auto').catch(() => {});
      }, CHECK_INTERVAL_MS);
      if (timer.unref) timer.unref();
    }
  }

  return {
    getState: snapshot,
    check,
    downloadVersion,
    installDownloaded,
    openExternal,
    setAuto,
    compareVersions,
    isInstalling: () => installing,
    /** Test-only: seed downloaded state without a real download. */
    _setTestState: (partial) => set({ ...(partial || {}) }),
  };
}

module.exports = { createUpdater, compareVersions, parseReleasesForTest: parseReleases };
