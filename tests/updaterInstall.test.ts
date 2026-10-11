/**
 * Updater install paths (electron/updates.cjs).
 *
 * Regression: auto-update launched the NSIS wizard WITHOUT /S, so users had
 * to click "who to install for" + install location by hand. Silent installs
 * must pass ['/S']; manual installs and portable/dev builds keep the GUI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseReleasesForTest } = require("../electron/updates.cjs") as {
  parseReleasesForTest: (json: unknown) => Array<{
    version: string; name: string; notes: string; publishedAt: string | null;
    prerelease: boolean;
    setupAsset: { name: string; url: string; size: number } | null;
    portableAsset: { name: string; url: string; size: number } | null;
  }>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createUpdater } = require("../electron/updates.cjs") as {
  createUpdater: (deps: Record<string, unknown>) => {
    getState: () => { status: string; canSilentInstall: boolean; downloadedVersion: string | null; differentialStaged: boolean; progress: number };
    installDownloaded: (silent?: boolean) => { status: string; error?: string | null };
    downloadVersion: (version: string) => Promise<{ status: string }>;
    _setTestState: (partial: Record<string, unknown>) => void;
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeTmpInstaller(): string {
  const file = path.join(os.tmpdir(), `abxag-test-installer-${Date.now()}-${Math.random().toString(16).slice(2)}.exe`);
  fs.writeFileSync(file, "fake-installer");
  return file;
}

function makeFakeAu(behavior: "ok" | "error", calls: { quitAndInstall: Array<[boolean, boolean]> }) {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  return {
    autoDownload: true,
    on: (ev: string, fn: (...a: unknown[]) => void) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    once: (ev: string, fn: (...a: unknown[]) => void) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeListener: (ev: string, fn: (...a: unknown[]) => void) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    downloadUpdate: () => {
      setTimeout(() => {
        (listeners["download-progress"] || []).forEach((f) => f({ percent: 50 }));
        if (behavior === "ok") (listeners["update-downloaded"] || []).forEach((f) => f({ version: "9.9.9" }));
        else (listeners["error"] || []).forEach((f) => f(new Error("feed unreachable")));
      }, 10);
      return Promise.resolve();
    },
    quitAndInstall: (silent: boolean, force: boolean) => { calls.quitAndInstall.push([silent, force]); },
  };
}

function makeUpdater(opts: { packaged: boolean; exePath: string; spawnCalls: Array<{ file: string; args: string[] }>; quit: { called: boolean }; autoUpdater?: unknown }) {
  return createUpdater({
    autoUpdater: opts.autoUpdater ?? null,
    app: {
      getVersion: () => "1.1.5",
      isPackaged: opts.packaged,
      getPath: () => opts.exePath,
      quit: () => { opts.quit.called = true; },
    },
    shell: {},
    BrowserWindow: { getAllWindows: () => [] },
    log: () => {},
    spawnFn: (file: string, args: string[]) => {
      opts.spawnCalls.push({ file, args });
      return { unref: () => {} };
    },
  });
}

test("silent auto-install passes /S and quits", async () => {
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const quit = { called: false };
  const u = makeUpdater({ packaged: true, exePath: "C:\\APPs\\ABxAG\\ABxAG.exe", spawnCalls, quit });
  assert.equal(u.getState().canSilentInstall, true);
  const installer = makeTmpInstaller();
  try {
    u._setTestState({ status: "downloaded", downloadedVersion: "9.9.9", downloadedFile: installer });
    u.installDownloaded(true);
    await sleep(3000);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args, ["/S"]);
    assert.equal(spawnCalls[0].file, installer);
    assert.equal(quit.called, true);
  } finally {
    fs.rmSync(installer, { force: true });
  }
});

test("manual install shows the wizard (no /S)", async () => {
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const quit = { called: false };
  const u = makeUpdater({ packaged: true, exePath: "C:\\APPs\\ABxAG\\ABxAG.exe", spawnCalls, quit });
  const installer = makeTmpInstaller();
  try {
    u._setTestState({ status: "downloaded", downloadedVersion: "9.9.9", downloadedFile: installer });
    u.installDownloaded(false);
    await sleep(1200);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args, []);
    assert.equal(quit.called, true);
  } finally {
    fs.rmSync(installer, { force: true });
  }
});

test("dev runs refuse to install", () => {
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const quit = { called: false };
  const u = makeUpdater({ packaged: false, exePath: "electron.exe", spawnCalls, quit });
  const installer = makeTmpInstaller();
  try {
    u._setTestState({ status: "downloaded", downloadedVersion: "9.9.9", downloadedFile: installer });
    const snap = u.installDownloaded(true);
    assert.equal(snap.status, "error");
    assert.equal(spawnCalls.length, 0);
    assert.equal(quit.called, false);
  } finally {
    fs.rmSync(installer, { force: true });
  }
});

test("parseReleases understands the mirror feed shape (website/releases.json)", () => {
  // Regression: on networks where api.github.com 404s anonymously, the
  // updater falls back to the mirror — which used to parse as blank
  // versions with no installers, silently reporting "up-to-date".
  const mirror = [
    {
      tag: "v1.1.13", title: null, date: "2026-10-11T15:34:28Z", notes: "Fixes!",
      assets: [
        { name: "ABxAG-Portable-1.1.13.exe", url: "https://github.com/dl/portable.exe", size: 153218523 },
        { name: "ABxAG-Setup-1.1.13.exe", url: "https://github.com/dl/setup.exe", size: 155978142 },
      ],
    },
    {
      tag: "v1.1.12", title: null, date: "2026-10-11T08:35:08Z", notes: "",
      assets: [{ name: "ABxAG-Setup-1.1.12.exe", url: "https://github.com/dl/old-setup.exe", size: 1 }],
    },
  ];
  const out = parseReleasesForTest(mirror);
  assert.equal(out.length, 2);
  assert.equal(out[0].version, "1.1.13");
  assert.equal(out[0].setupAsset?.url, "https://github.com/dl/setup.exe");
  assert.equal(out[0].portableAsset?.url, "https://github.com/dl/portable.exe");
  assert.equal(out[1].version, "1.1.12");
});

test("parseReleases still understands the GitHub API shape", () => {
  const api = [
    {
      tag_name: "v1.1.13", name: "ABxAG v1.1.13", body: "Notes", published_at: "2026-10-11T15:34:28Z",
      prerelease: false,
      assets: [{ name: "ABxAG-Setup-1.1.13.exe", browser_download_url: "https://github.com/dl/api-setup.exe", size: 5 }],
    },
  ];
  const out = parseReleasesForTest(api);
  assert.equal(out.length, 1);
  assert.equal(out[0].version, "1.1.13");
  assert.equal(out[0].setupAsset?.url, "https://github.com/dl/api-setup.exe");
});

test("parseReleases drops version-less entries instead of faking up-to-date", () => {
  assert.deepEqual(parseReleasesForTest([{ nope: true }]), []);
  assert.deepEqual(parseReleasesForTest(null), []);
});

test("differential fast path stages without any full download", async () => {
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const quit = { called: false };
  const qi: Array<[boolean, boolean]> = [];
  const u = makeUpdater({ packaged: true, exePath: "C:\\APPs\\ABxAG\\ABxAG.exe", spawnCalls, quit, autoUpdater: makeFakeAu("ok", { quitAndInstall: qi }) });
  u._setTestState({
    status: "update-available",
    latestNewer: "9.9.9",
    releases: [{ version: "9.9.9", name: "v9.9.9", notes: "", publishedAt: null, prerelease: false, setupAsset: { name: "s.exe", url: "http://127.0.0.1:9/x.exe", size: 1 }, portableAsset: null }],
  });
  const snap = await u.downloadVersion("9.9.9");
  assert.equal(snap.status, "downloaded");
  const st = u.getState();
  assert.equal(st.differentialStaged, true);
  assert.equal(st.downloadedVersion, "9.9.9");
  assert.equal(spawnCalls.length, 0); // no NSIS file touched
  u.installDownloaded(true);
  assert.deepEqual(qi, [[true, true]]); // silent quitAndInstall on installed build
});

test("differential error falls back instead of failing", async () => {
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const quit = { called: false };
  const qi: Array<[boolean, boolean]> = [];
  const u = makeUpdater({ packaged: true, exePath: "C:\\APPs\\ABxAG\\ABxAG.exe", spawnCalls, quit, autoUpdater: makeFakeAu("error", { quitAndInstall: qi }) });
  u._setTestState({
    status: "update-available",
    latestNewer: "9.9.9",
    releases: [{ version: "9.9.9", name: "v9.9.9", notes: "", publishedAt: null, prerelease: false, setupAsset: { name: "s.exe", url: "http://127.0.0.1:9/x.exe", size: 1 }, portableAsset: null }],
  });
  const snap = await u.downloadVersion("9.9.9");
  // Custom full download to a dead port refuses fast → clean error state.
  assert.equal(snap.status, "error");
  assert.equal(u.getState().differentialStaged, false);
  assert.equal(qi.length, 0);
});

test("portable build falls back to the wizard even when silent asked", async () => {
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const quit = { called: false };
  const u = makeUpdater({ packaged: true, exePath: "D:\\dl\\ABxAG-Portable-1.1.5.exe", spawnCalls, quit });
  assert.equal(u.getState().canSilentInstall, false);
  const installer = makeTmpInstaller();
  try {
    u._setTestState({ status: "downloaded", downloadedVersion: "9.9.9", downloadedFile: installer });
    u.installDownloaded(true);
    await sleep(1200);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args, []);
  } finally {
    fs.rmSync(installer, { force: true });
  }
});
