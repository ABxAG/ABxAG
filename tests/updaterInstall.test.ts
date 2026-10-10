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
const { createUpdater } = require("../electron/updates.cjs") as {
  createUpdater: (deps: Record<string, unknown>) => {
    getState: () => { status: string; canSilentInstall: boolean };
    installDownloaded: (silent?: boolean) => { status: string; error?: string | null };
    _setTestState: (partial: Record<string, unknown>) => void;
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeTmpInstaller(): string {
  const file = path.join(os.tmpdir(), `abxag-test-installer-${Date.now()}-${Math.random().toString(16).slice(2)}.exe`);
  fs.writeFileSync(file, "fake-installer");
  return file;
}

function makeUpdater(opts: { packaged: boolean; exePath: string; spawnCalls: Array<{ file: string; args: string[] }>; quit: { called: boolean } }) {
  return createUpdater({
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
