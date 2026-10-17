/**
 * External (app-independent) alarm alerts — companion/alarmWatchdog.ts and the
 * schedule hooks in companion/utilities.ts.
 *
 * The user's second complaint was that alarms do nothing once ABxAG is closed.
 * These tests pin the mechanism that fixes it: every scheduled alarm is
 * registered with the Windows Task Scheduler, which the Windows service owns —
 * so it is unaffected by ABxAG exiting. And anything that stops the alarm from
 * firing (snooze, dismiss, cancel, or the alarm itself firing) removes that
 * registration, so a stale entry can never sound an alarm the user handled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlarmWatchdog, createTaskArgs, resolveAlarmScriptPath, taskNameFor } from "../companion/alarmWatchdog";
import { UtilityScheduler, type Utility, type UtilityFired } from "../companion/utilities";

const MIN = 60_000;
const START = Date.parse("2026-03-10T09:00:00"); // a Tuesday, 09:00 local

function fakeExec() {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    return "SUCCESS";
  };
  return { calls, exec };
}

test("arming registers a one-shot task that lands in the alarm's own minute", () => {
  const { calls, exec } = fakeExec();
  const watchdog = new AlarmWatchdog({ scriptPath: "C:\\app\\fire-alarm.ps1", now: () => START, exec });

  const due = new Date(START + 5 * MIN + 40_000); // 09:05:40
  assert.equal(watchdog.arm({ id: "abc", label: "stretch", dueAt: due.getTime() }), true);

  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args[0], "/create");
  assert.ok(args.includes("/it"), "runs in this user's interactive session, so it can make sound");
  assert.ok(args.includes("/f"), "overwrites any earlier entry for the same alarm");

  const at = args[args.indexOf("/st") + 1];
  assert.equal(at, "09:05", "scheduled for the minute it falls in, never after it");
  assert.ok(new Date(due).getTime() - START >= 5 * MIN);

  // The task carries the exact due time and the label, so the script waits out
  // the remaining seconds itself.
  const action = args[args.indexOf("/tr") + 1];
  assert.ok(action.includes("-DueMs"), "carries the exact due time");
  assert.ok(action.includes(String(due.getTime())), "exact epoch, not just the minute");
  assert.ok(action.includes("stretch"), "carries the label");
  assert.ok(action.includes("C:\\app\\fire-alarm.ps1"), "runs the shipped script");
  assert.equal(watchdog.armedCount, 1);
});

test("an alarm in the past, or more than a month out, registers nothing", () => {
  const { calls, exec } = fakeExec();
  const watchdog = new AlarmWatchdog({ scriptPath: "C:\\app\\fire-alarm.ps1", now: () => START, exec });
  assert.equal(watchdog.arm({ id: "past", label: "x", dueAt: START - 1 }), false);
  assert.equal(watchdog.arm({ id: "far", label: "x", dueAt: START + 40 * 24 * 60 * MIN }), false);
  assert.equal(calls.length, 0);
  assert.equal(watchdog.armedCount, 0);
});

test("re-arming replaces the previous task instead of stacking a second one", () => {
  const { calls, exec } = fakeExec();
  const watchdog = new AlarmWatchdog({ scriptPath: "C:\\app\\fire-alarm.ps1", now: () => START, exec });
  watchdog.arm({ id: "abc", label: "stretch", dueAt: START + 5 * MIN });
  watchdog.arm({ id: "abc", label: "stretch", dueAt: START + 9 * MIN });

  const deletes = calls.filter((c) => c[0] === "/delete");
  const creates = calls.filter((c) => c[0] === "/create");
  assert.equal(deletes.length, 0, "re-arming replaces in place, so no separate delete is needed");
  assert.equal(creates.length, 2, "and /f guarantees only one task can exist for the alarm");
  assert.equal(watchdog.armedCount, 1);
});

test("a failure to register is reported instead of pretending to be armed", () => {
  const watchdog = new AlarmWatchdog({
    scriptPath: "C:\\app\\fire-alarm.ps1",
    now: () => START,
    exec: () => { throw new Error("ERROR: Access is denied."); },
  });
  assert.equal(watchdog.arm({ id: "abc", label: "x", dueAt: START + 5 * MIN }), false);
  assert.equal(watchdog.available, false, "callers can tell the safety net is missing");
  assert.equal(watchdog.armedCount, 0);
});

test("task names are safe for schtasks and unique per alarm", () => {
  assert.equal(taskNameFor("2c3aa1fc-8dd3-41f9-a502-31cb6a20d92a"), "ABxAG_Alarm_2c3aa1fc-8dd3-41f9-a502-31cb6a20d92a");
  assert.match(taskNameFor("weird/id:name*?"), /^ABxAG_Alarm_[A-Za-z0-9_-]+$/);
  assert.notEqual(taskNameFor("a"), taskNameFor("b"));
});

test("a label with quotes cannot break out of the task action", () => {
  const args = createTaskArgs({ id: "x", label: 'say "hi" & calc', dueAt: START + 5 * MIN }, "C:\\a b\\fire-alarm.ps1", START);
  const action = args[args.indexOf("/tr") + 1];
  assert.ok(action.includes('"C:\\a b\\fire-alarm.ps1"'), "a path with spaces stays quoted");
  assert.ok(!action.includes('"hi"'), "quotes in the label are neutralised");
});

test("the ledger records what was armed, for diagnosing a silent alarm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abxag-ledger-"));
  const ledger = join(dir, "companion", "alarm-watchdog.log");
  const { exec } = fakeExec();
  const watchdog = new AlarmWatchdog({ scriptPath: "C:\\app\\fire-alarm.ps1", now: () => START, exec, ledgerPath: ledger });

  watchdog.arm({ id: "abc", label: "stretch", dueAt: START + 5 * MIN });
  watchdog.disarm("abc");

  const { readFile } = await import("node:fs/promises");
  const text = await readFile(ledger, "utf8");
  assert.match(text, /arm abc task=ABxAG_Alarm_abc due=/);
  assert.match(text, /disarm abc task=ABxAG_Alarm_abc/);
  await rm(dir, { recursive: true, force: true });
});

test("the scheduler registers an external alert on add and removes it on every exit path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abxag-watchdog-"));
  const fired: UtilityFired[] = [];
  const armed: Utility[] = [];
  const released: string[] = [];
  const scheduler = new UtilityScheduler(
    dir,
    (event) => fired.push(event),
    () => START,
    { armed: (item) => armed.push(item), released: (id) => released.push(id) },
  );

  // Created -> registered externally.
  const a = await scheduler.add({ kind: "timer", label: "stretch", inSeconds: 300 });
  assert.deepEqual(armed.map((i) => i.id), [a.id]);
  assert.deepEqual(released, []);

  // Snoozed -> the old registration must go, a new one takes its place.
  await scheduler.snooze(a.id, 5);
  assert.deepEqual(released, [a.id], "stale task dropped");
  assert.deepEqual(armed.map((i) => i.dueAt), [START + 300_000, START + 5 * MIN]);

  // A fresh alarm, cancelled -> removed.
  const b = await scheduler.add({ kind: "reminder", label: "water plants", inSeconds: 600 });
  await scheduler.cancel(b.id);
  assert.equal(released.at(-1), b.id);

  // A repeating alarm re-registers on dismiss instead of being removed.
  released.length = 0;
  const c = await scheduler.add({ kind: "alarm", label: "gym", time: "07:00", repeat: "daily" });
  await scheduler.dismiss(c.id);
  assert.deepEqual(released, [], "a repeating alarm keeps its external alert");
  assert.equal(armed.at(-1)?.id, c.id);

  // An alarm that actually fires retires its own registration, so a used task
  // cannot linger and sound again.
  released.length = 0;
  const d = await scheduler.add({ kind: "timer", label: "tea", inSeconds: 0.06 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fired.length, 1);
  assert.deepEqual(released, [d.id]);

  scheduler.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("restarting re-registers every still-scheduled alarm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abxag-watchdog-"));
  const armed: Utility[] = [];
  const first = new UtilityScheduler(dir, () => {}, () => START, { armed: (i) => armed.push(i) });
  const created = await first.add({ kind: "alarm", label: "birthday", inSeconds: 3600 });
  first.dispose();

  armed.length = 0;
  const second = new UtilityScheduler(dir, () => {}, () => START, { armed: (i) => armed.push(i) });
  await second.initialize();
  assert.deepEqual(armed.map((i) => i.id), [created.id], "an alarm survives a restart with its alert intact");
  second.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("the alarm script is discoverable in this checkout", () => {
  // Guards the packaging contract: without this file the packaged app cannot
  // alert while closed, and the failure is silent.
  const resolved = resolveAlarmScriptPath();
  assert.ok(resolved, "fire-alarm.ps1 was not found");
  assert.ok(resolved!.endsWith("fire-alarm.ps1"));
});