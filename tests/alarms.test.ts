/**
 * Alarms, reminders and timers (companion/utilities.ts).
 *
 * This is the layer that was silently broken for the user: the model had no
 * tool to schedule anything, so it only *said* an alarm was set. These tests
 * pin the scheduler contract that the setAlarm / listAlarms / cancelAlarm
 * tools and the /api/utilities routes both depend on:
 *
 * - a relative request ("in 5 minutes") becomes a real due time
 * - a wall-clock request ("7:30 pm") resolves to the next occurrence
 * - the ring actually fires and reports itself
 * - snooze / dismiss / cancel change the schedule the way the UI claims
 * - a ring that came due while the app was closed is reported as missed
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UtilityScheduler, parseClock, nextOccurrence, type UtilityFired } from "../companion/utilities";

const MIN = 60_000;

/** Fresh scheduler over a throwaway data dir with a controllable clock. */
async function makeScheduler(startAt = Date.parse("2026-03-10T09:00:00"), existingDir?: string) {
  const dir = existingDir ?? (await mkdtemp(join(tmpdir(), "abxag-utilities-")));
  const fired: UtilityFired[] = [];
  let now = startAt;
  const scheduler = new UtilityScheduler(dir, (event) => fired.push(event), () => now);
  /** Read an item back through the public surface (add() hands out a copy). */
  const get = (id: string) => scheduler.list().find((u) => u.id === id);
  return {
    fired,
    dir,
    scheduler,
    get,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    cleanup: async () => {
      scheduler.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('"in 5 minutes" schedules a real future ring', async () => {
  const h = await makeScheduler();
  const created = await h.scheduler.add({ kind: "timer", label: "stretch", inSeconds: 5 * 60 });
  assert.equal(created.kind, "timer");
  assert.equal(created.label, "stretch");
  assert.equal(created.repeat, "none", "timers are always one-shot");
  assert.equal(created.dueAt, h.now() + 5 * MIN);
  assert.equal(created.status, "scheduled");
  assert.equal(h.fired.length, 0);
  await h.cleanup();
});

test("a past or unparseable time is refused instead of silently dropped", async () => {
  const h = await makeScheduler();
  // These used to be coerced into "one second from now", which rang at once and
  // read to the user as "set, five minutes from now".
  await assert.rejects(() => h.scheduler.add({ kind: "alarm", inSeconds: -10 }), /future time/i);
  await assert.rejects(() => h.scheduler.add({ kind: "alarm", inSeconds: 0 }), /future time/i);
  await assert.rejects(() => h.scheduler.add({ kind: "alarm", inSeconds: Number.NaN }), /future time/i);
  await assert.rejects(() => h.scheduler.add({ kind: "alarm", time: "not-a-time" }), /future time/i);
  assert.equal(h.scheduler.list().length, 0, "nothing half-created is left behind");
  await h.cleanup();
});

test("the ring fires, is reported, and does not fire twice", async () => {
  const h = await makeScheduler();
  // The clock is frozen, so a 60 ms offset is a real 60 ms setTimeout.
  const created = await h.scheduler.add({ kind: "reminder", label: "call mom", inSeconds: 0.06 });
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0].utility.id, created.id);
  assert.equal(h.fired[0].utility.status, "ringing");
  assert.equal(h.fired[0].missed, false);
  assert.equal(h.scheduler.list()[0]?.id, created.id, "still ringing until the user acts");
  await h.cleanup();
});

test("snooze pushes the ring out, dismiss retires a one-shot", async () => {
  const h = await makeScheduler();
  const a = await h.scheduler.add({ kind: "alarm", label: "milk", inSeconds: 60 });
  await h.scheduler.snooze(a.id, 5);
  assert.equal(h.get(a.id)?.dueAt, h.now() + 5 * MIN, "snoozed five minutes out");
  assert.equal(h.get(a.id)?.status, "scheduled");

  const b = await h.scheduler.add({ kind: "timer", inSeconds: 60 });
  await h.scheduler.dismiss(b.id);
  assert.equal(h.get(b.id), undefined, "a dismissed one-shot leaves the upcoming list");

  // A repeating alarm survives a dismiss by jumping to its next occurrence.
  const c = await h.scheduler.add({ kind: "alarm", label: "gym", time: "07:00", repeat: "daily" });
  const firstDue = h.get(c.id)?.dueAt;
  await h.scheduler.dismiss(c.id);
  const after = h.get(c.id);
  assert.equal(after?.status, "scheduled", "daily alarm is still scheduled");
  assert.ok((after?.dueAt ?? 0) > h.now(), "daily alarm re-arms in the future");
  assert.notEqual(after?.dueAt, firstDue, "and moves to the next occurrence");
  await h.cleanup();
});

test("cancel removes it from the upcoming list", async () => {
  const h = await makeScheduler();
  const a = await h.scheduler.add({ kind: "reminder", label: "stand up", inSeconds: 120 });
  assert.equal(h.scheduler.list().length, 1);
  assert.equal(await h.scheduler.cancel(a.id), true);
  assert.equal(h.scheduler.list().length, 0);
  assert.equal(await h.scheduler.cancel("nope"), false);
  await h.cleanup();
});

test("a ring missed while ABxAG was closed is reported as missed, not lost", async () => {
  const first = await makeScheduler();
  await first.scheduler.add({ kind: "reminder", label: "water the plant", inSeconds: 60 });
  first.advance(30 * MIN); // app was closed well past the due time
  first.scheduler.dispose(); // timers die with the process

  const revived = await makeScheduler(first.now(), first.dir);
  const missed = await revived.scheduler.initialize();
  assert.equal(missed.length, 1);
  assert.equal(missed[0].missed, true);
  assert.equal(missed[0].utility.label, "water the plant");
  assert.equal(missed[0].utility.status, "missed");
  // It stays listed until acknowledged: the startup `utility.fired` publish
  // usually beats the renderer's socket, so the list is the safety net.
  assert.deepEqual(revived.scheduler.list().map((u) => u.label), ["water the plant"]);
  await revived.scheduler.dismiss(missed[0].utility.id);
  assert.equal(revived.scheduler.list().length, 0, "acknowledging it clears it");
  await first.cleanup();
  await revived.cleanup();
});

test("alarms persist across a restart and stay armed", async () => {
  const first = await makeScheduler();
  const created = await first.scheduler.add({ kind: "alarm", label: "birthday", inSeconds: 3600 });
  first.scheduler.dispose();

  const revived = await makeScheduler(first.now(), first.dir);
  assert.deepEqual(await revived.scheduler.initialize(), [], "not yet due, so nothing is missed");
  assert.deepEqual(revived.scheduler.list().map((u) => u.id), [created.id], "still scheduled after restart");
  assert.equal(revived.scheduler.list()[0].dueAt, created.dueAt, "the due time survived the restart");
  await first.cleanup();
  await revived.cleanup();
});

test("parseClock understands 24h and 12h clocks and never returns the past", () => {
  const now = Date.parse("2026-03-10T09:00:00");
  assert.equal(parseClock("14:30", now), Date.parse("2026-03-10T14:30:00"));
  assert.equal(parseClock("7:30 pm", now), Date.parse("2026-03-10T19:30:00"));
  assert.equal(parseClock("12:05 am", now), Date.parse("2026-03-11T00:05:00"), "midnight rolls to tomorrow");
  assert.equal(parseClock("07:00", now), Date.parse("2026-03-11T07:00:00"), "already past today means tomorrow");
  assert.ok(Number.isNaN(parseClock("25:00", now)));
  assert.ok(Number.isNaN(parseClock("banana", now)));
});

test("nextOccurrence advances by a day, skipping weekends for weekdays", () => {
  const friday6pm = Date.parse("2026-03-13T18:00:00");
  assert.equal(nextOccurrence(friday6pm, "daily", friday6pm), Date.parse("2026-03-14T18:00:00"));
  const saturday6pm = Date.parse("2026-03-14T18:00:00");
  assert.equal(
    nextOccurrence(saturday6pm, "weekdays", saturday6pm),
    Date.parse("2026-03-16T18:00:00"),
    "the weekend jumps to Monday",
  );
});