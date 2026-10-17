/**
 * Keeps a Windows alert alive for every scheduled alarm, independently of
 * the ABxAG process.
 *
 * Why this exists: the alarm scheduler lives inside the ABxAG backend, so when
 * the app is closed nothing is left to fire a reminder. For each alarm we
 * register a one-shot Windows Task Scheduler entry that runs
 * `scripts/fire-alarm.ps1` at the due time. The Windows service owns that
 * entry, so it is unaffected by ABxAG being closed, crashed or updated — which
 * a child process would not be.
 *
 * Task Scheduler can only express HH:MM, so the task is created for the minute
 * the alarm falls in and the script waits out the remaining seconds itself.
 *
 * `exec` and `kill` are injectable so this can be tested without touching the
 * real scheduler.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Name of the PowerShell alert script, both in dev and inside the installer. */
const SCRIPT_NAME = "fire-alarm.ps1";

/** How far ahead a task may be registered. */
const MAX_AHEAD_MS = 34 * 24 * 60 * 60 * 1000;

/**
 * Locate fire-alarm.ps1.
 *
 * In development it sits next to the source; the packaged app receives it as an
 * extraResource next to the Python agent. Returns null when it cannot be found,
 * which only costs the "alarm while closed" behaviour — the in-app alarm keeps
 * working either way.
 */
export function resolveAlarmScriptPath(): string | null {
  const candidates = [
    process.env.ABxAG_ALARM_SCRIPT,
    process.resourcesPath ? path.join(process.resourcesPath, SCRIPT_NAME) : undefined,
    path.join(process.cwd(), "scripts", SCRIPT_NAME),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export interface WatchdogTarget {
  id: string;
  label: string;
  dueAt: number;
}

export interface AlarmWatchdogOptions {
  /** Absolute path to fire-alarm.ps1. */
  scriptPath: string;
  now?: () => number;
  log?: (message: string) => void;
  /**
   * Append-only record of what was armed. Doubles as the diagnosis for "my
   * alarm did not ring": a missing arm line means the external alert was never
   * registered at all.
   */
  ledgerPath?: string;
  /** Injectable schtasks runner (tests). */
  exec?: (args: string[]) => string;
}

/** Task name for one alarm. Short and greppable so a user can find/remove it. */
export function taskNameFor(id: string): string {
  return `ABxAG_Alarm_${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}`;
}

/** The schtasks arguments that register one alarm. */
export function createTaskArgs(target: WatchdogTarget, scriptPath: string, now: number): string[] {
  const task = taskNameFor(target.id);
  // The task must start at or before the alarm, never after it. Land on the
  // minute the alarm falls in; the script sleeps the rest.
  const minute = Math.floor(target.dueAt / 60_000) * 60_000;
  const start = new Date(Math.max(minute, now - 60_000));
  const hhmm = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
  const action = [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    `"${scriptPath}"`,
    "-DueMs",
    String(target.dueAt),
    "-Label",
    `"${target.label.replace(/"/g, "'").slice(0, 120)}"`,
    "-Task",
    task,
  ].join(" ");
  return ["/create", "/tn", task, "/tr", action, "/sc", "once", "/st", hhmm, "/it", "/f"];
}

export class AlarmWatchdog {
  private readonly armedIds = new Set<string>();
  private readonly exec: (args: string[]) => string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private healthy = true;

  constructor(private readonly options: AlarmWatchdogOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.exec = options.exec ?? ((args) => execFileSync("schtasks.exe", args, { encoding: "utf8", timeout: 30_000 }));
  }

  /** False once registration has failed, e.g. Task Scheduler unavailable. */
  get available(): boolean {
    return this.healthy;
  }

  /** Number of alarms currently registered with Windows (diagnostic aid). */
  get armedCount(): number {
    return this.armedIds.size;
  }

  /**
   * Register (or re-register) the external alert for one alarm. Safe to call for
   * an alarm that is already registered: the previous entry is removed first,
   * so a snooze never leaves a stale alert behind.
   */
  arm(target: WatchdogTarget): boolean {
    if (process.platform !== "win32") return false;
    const ahead = target.dueAt - this.now();
    // Windows-only, and beyond a month there is nothing worth pre-registering:
    // the in-app scheduler and the missed-on-restart path cover that.
    if (ahead <= 0 || ahead > MAX_AHEAD_MS) return false;

    // No delete first: /f already replaces any entry left over from a previous
    // session, so arming stays a single schtasks call.
    const args = createTaskArgs(target, this.options.scriptPath, this.now());
    try {
      this.exec(args);
      this.armedIds.add(target.id);
      this.record(`arm ${target.id} task=${taskNameFor(target.id)} due=${target.dueAt} label=${JSON.stringify(target.label)}`);
      return true;
    } catch (err) {
      this.healthy = false;
      const message = (err as Error).message;
      this.log(`could not register the external alarm for ${target.id}: ${message}`);
      this.record(`arm-failed ${target.id} error=${JSON.stringify(message)}`);
      return false;
    }
  }

  /** Remove the external alert for one alarm (snoozed / dismissed / cancelled). */
  disarm(id: string): boolean {
    const task = taskNameFor(id);
    try {
      this.exec(["/delete", "/tn", task, "/f"]);
      this.record(`disarm ${id} task=${task}`);
      return true;
    } catch {
      // Not registered is the normal case (e.g. it already fired and removed
      // itself), so this is not a failure worth surfacing.
      return false;
    } finally {
      this.armedIds.delete(id);
    }
  }

  /** Remove every registered alert (used by tests and by "clear all"). */
  dispose(): void {
    for (const id of [...this.armedIds]) this.disarm(id);
  }

  /** Append one line to the ledger. Best-effort; never throws. */
  private record(line: string): void {
    const file = this.options.ledgerPath;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${new Date(this.now()).toISOString()} ${line}\n`, "utf8");
    } catch {
      /* diagnostics only */
    }
  }
}