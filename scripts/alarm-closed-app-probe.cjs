/**
 * Does an alarm survive ABxAG being closed?
 *
 * This is the user's exact complaint, so this checks it against the real
 * Windows Task Scheduler rather than a mock: schedule an alarm through the HTTP
 * API, confirm the scheduler task exists with the right due time and label,
 * then kill the backend and confirm the task is still registered.
 *
 * The alarm is set far enough out that it never actually goes off, and the
 * probe removes the task it created when it is done.
 *
 *   node scripts/alarm-closed-app-probe.cjs
 */
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = process.env.PROBE_PORT || "47991";
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), "abxag-closed-probe");
const LEDGER = path.join(DATA_DIR, "companion", "alarm-watchdog.log");

const schtasks = (args) => execFileSync("schtasks.exe", args, { encoding: "utf8", timeout: 60_000 });

function taskExists(name) {
  try {
    schtasks(["/query", "/tn", name, "/fo", "LIST"]);
    return true;
  } catch {
    return false;
  }
}

function taskDetail(name) {
  try {
    return schtasks(["/query", "/tn", name, "/fo", "LIST", "/v"]).split(/\r?\n/);
  } catch {
    return [];
  }
}

const ledger = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean) : []);

let createdTask = "";

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const server = spawn(process.execPath, ["dist/server.cjs"], {
    env: { ...process.env, ABxAG_PORT: PORT, ABXAG_DATA_DIR: DATA_DIR, ABXAG_COGNITION_DATA_DIR: DATA_DIR },
    stdio: "ignore",
  });

  let created = null;
  for (let attempt = 0; attempt < 45 && !created; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      created = await fetch(`${BASE}/api/utilities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 45 minutes: long enough that it cannot fire during this probe.
        body: JSON.stringify({ kind: "reminder", label: "closed app probe", inSeconds: 2700 }),
      }).then((r) => r.json());
    } catch { /* not up yet */ }
  }
  if (!created?.id) throw new Error("backend never became ready");

  const armLine = ledger().find((l) => l.includes(`arm ${created.id} `));
  if (!armLine) throw new Error("no external alert was registered; the alarm would die with the app");
  createdTask = /task=(\S+)/.exec(armLine)?.[1] || "";
  console.log("alarm:", created.id, "due", new Date(created.dueAt).toLocaleTimeString());
  console.log("ledger:", armLine.replace(/^.*?\sarm/, "arm"));

  if (!createdTask || !taskExists(createdTask)) throw new Error("the scheduler task does not exist");
  const details = taskDetail(createdTask);
  const action = details.find((l) => l.includes("Task To Run")) || "";
  console.log("task exists:", createdTask);
  console.log("  action carries the due time:", action.includes(String(created.dueAt)));
  console.log("  action carries the label:", action.includes("closed app probe"));

  // The reported bug: close the app.
  server.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 3000));

  if (!taskExists(createdTask)) throw new Error("the alarm died with ABxAG - this is the reported bug");
  console.log("\ntask still registered after ABxAG was killed: yes");
  console.log("PASS - the alarm is owned by Windows, not by the app, so closing ABxAG cannot silence it.");
}

main()
  .catch((err) => {
    console.error("\nFAIL -", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (createdTask) {
      try { schtasks(["/delete", "/tn", createdTask, "/f"]); console.log("\nprobe task deleted"); } catch { /* gone */ }
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });