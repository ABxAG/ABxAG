/**
 * Does ABxAG actually come back after a silent update?
 *
 * A silent (/S) install of the assisted NSIS installer never shows its finish
 * page, so nothing launches the freshly installed app. This registers the same
 * relaunch task the updater does, points it at a stand-in "installer" process,
 * and checks the app process is started once that process exits.
 *
 * Uses a stand-in rather than the real installer on purpose: installing over a
 * real ABxAG would replace the user's app mid-test.
 *
 *   node scripts/relaunch-probe.cjs
 */
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TASK = "ABxAG_Relaunch_Probe";
const SCRIPT = path.join(process.cwd(), "scripts", "relaunch-after-update.ps1");
// Stands in for the app the helper should start; it writes a marker and exits,
// so the probe observes the launch without opening a real window.
const STUB = path.join(os.tmpdir(), "abxag-relaunch-stub.bat");
const MARKER = path.join(os.tmpdir(), "abxag-relaunch-marker.txt");

const schtasks = (args) => execFileSync("schtasks.exe", args, { encoding: "utf8", timeout: 60_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { fs.unlinkSync(MARKER); } catch {}
fs.writeFileSync(STUB, `@echo off\r\necho relaunched > "${MARKER}"\r\n`, "ascii");
try { schtasks(["/delete", "/tn", TASK, "/f"]); } catch { /* not there */ }

// A stand-in "installer": stays alive until we let it go.
const installer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });

const at = new Date(Date.now() + 60_000);
const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
const action = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${SCRIPT}" -InstallerPid ${installer.pid} -Exe "${STUB}" -Task ${TASK}`;

(async () => {
  schtasks(["/create", "/tn", TASK, "/tr", action, "/sc", "once", "/st", hhmm, "/it", "/f"]);
  console.log("relaunch task registered for", hhmm, "| watching the stand-in installer pid", installer.pid);

  // Let the helper find the installer still running, then release it.
  await sleep(20_000);
  console.log("stand-in installer still alive:", installer.exitCode === null);
  installer.kill("SIGKILL");
  console.log("installer finished; the helper should now start the app");

  for (let i = 0; i < 30; i++) {
    await sleep(5_000);
    if (fs.existsSync(MARKER)) {
      console.log(`\nrelaunched after ~${20 + (i + 1) * 5}s ->`, fs.readFileSync(MARKER, "utf8").trim());
      console.log("PASS - the app is started again after the installer finishes.");
      return;
    }
  }
  console.log("\nFAIL - the app was never started");
  try {
    const q = schtasks(["/query", "/tn", TASK, "/fo", "LIST", "/v"]);
    console.log(q.split(/\r?\n/).filter((l) => /Last Run Time|Last Result|Next Run Time|Status|Task To Run/.test(l)).join("\n"));
  } catch (err) {
    console.log("task query failed:", err.message);
  }
  process.exitCode = 1;
})()
  .catch((err) => {
    console.error("\nFAIL -", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { schtasks(["/delete", "/tn", TASK, "/f"]); } catch { /* gone */ }
    try { fs.rmSync(MARKER, { force: true }); } catch { /* gone */ }
    try { fs.rmSync(STUB, { force: true }); } catch { /* gone */ }
    if (installer.exitCode === null) installer.kill("SIGKILL");
  });