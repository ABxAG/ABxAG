/**
 * Does the installer actually bring ABxAG back?
 *
 * The bug being pinned down is the one users see: the update applies and then
 * nothing is running. The flag that decides it is on the installer command
 * line, so this runs the real NSIS installer into a throwaway directory and
 * checks what happens.
 *
 * ABxAG is installed to a temp folder with /D=, never over the real one, and
 * the run is observable in two independent ways: whether a process appears, and
 * whether the NSIS task's own result records it.
 *
 *   node scripts/relaunch-probe.cjs
 */
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INSTALLER = process.argv[2] || path.join("release-public", "ABxAG-Setup-1.1.25.exe");
const TARGET = path.join(os.tmpdir(), "abxag-relaunch-probe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is any ABxAG process running that was NOT already running before we started? */
function abxagProcesses(exclude) {
  const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq ABxAG.exe", "/NH"], { encoding: "utf8", timeout: 30_000 });
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ABxAG.exe"))
    .map((line) => Number(line.split(/\s+/)[1]))
    .filter((pid) => Number.isFinite(pid) && pid !== exclude);
}

(async () => {
  if (!fs.existsSync(INSTALLER)) throw new Error(`installer not found: ${INSTALLER}`);
  fs.rmSync(TARGET, { recursive: true, force: true });

  const before = abxagProcesses();
  console.log("ABxAG processes before:", before.length ? before.join(", ") : "none");

  // /S for a silent install, --force-run for the relaunch, /D= to keep the
  // real installation untouched.
  console.log(`running: ${INSTALLER} /S --force-run /D=${TARGET}`);
  const installer = spawn(INSTALLER, ["/S", "--force-run", `/D=${TARGET}`], {
    stdio: "ignore",
    detached: false,
  });
  installer.on("error", (e) => console.log("could not launch installer:", e.message));

  let started = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(3_000);
    const after = abxagProcesses();
    const fresh = after.filter((pid) => !before.includes(pid));
    if (fresh.length) {
      started = fresh;
      break;
    }
    if (installer.exitCode !== null) console.log("installer exited with", installer.exitCode);
  }

  const installed = fs.existsSync(path.join(TARGET, "ABxAG.exe"));
  console.log("files installed:", installed);
  console.log("ABxAG started by the installer:", started ? `yes (pid ${started.join(", ")})` : "no");

  if (started) {
    // Leave nothing running: this is a probe, not a session.
    for (const pid of started) {
      try { execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { timeout: 30_000 }); } catch { /* gone */ }
    }
    // Windows keeps the freshly installed files locked for a moment after the
    // process dies; deleting before that throws EPERM and hides the real result.
    for (let i = 0; i < 20; i++) {
      if (!abxagProcesses().some((pid) => started.includes(pid))) break;
      await sleep(1_000);
    }
    await sleep(2_000);
  }

  try {
    fs.rmSync(TARGET, { recursive: true, force: true });
  } catch (err) {
    // Not a failure of the thing being probed; say so rather than throwing.
    console.log(`note: could not remove ${TARGET} (${err.code || err.message}) - it is a temp folder`);
  }
  if (!installed) throw new Error("the installer did not install anything");
  if (!started) throw new Error("the installer finished but ABxAG was never started");
  console.log("\nPASS - a silent install starts the app by itself.");
})().catch((err) => {
  console.error("\nFAIL -", err.message);
  process.exit(1);
});