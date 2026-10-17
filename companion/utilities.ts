/**
 * Alarms, reminders and timers.
 *
 * Persisted and re-armed on startup. Anything that came due while ABxAG was
 * not running is reported once as "missed" rather than ringing late. Firing
 * publishes an event that the presence gate voices (alarms are critical and
 * pass Do-Not-Disturb) and that the character reacts to physically.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";

export interface Utility {
  id: string;
  kind: "alarm" | "reminder" | "timer";
  label: string;
  /** Next due time (epoch ms). */
  dueAt: number;
  repeat: "none" | "daily" | "weekdays";
  createdAt: number;
  firedAt: number | null;
  status: "scheduled" | "ringing" | "done" | "missed" | "cancelled";
}

export interface UtilityFired {
  utility: Utility;
  missed: boolean;
}

/**
 * Optional side effects the host wires up, called every time an alarm is armed
 * or retired. ABxAG uses them to keep an external (app-independent) alert
 * alive — see companion/alarmWatchdog.ts.
 */
export interface ScheduleHooks {
  /** An alarm became scheduled: keep an external alert armed for it. */
  armed?(item: Utility): void;
  /** An alarm will not fire as scheduled: drop any external alert for it. */
  released?(id: string): void;
}

const MAX_TIMEOUT = 2 ** 31 - 1;

export class UtilityScheduler {
  private items: Utility[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly file: string;

  constructor(dataDir: string, private readonly onFire: (event: UtilityFired) => void, private readonly now: () => number = Date.now, private readonly hooks: ScheduleHooks = {}) {
    this.file = path.join(dataDir, "companion", "utilities.v1.json");
  }

  async initialize(): Promise<UtilityFired[]> {
    const stored = await readJsonFile<{ items: Utility[] }>(this.file, { items: [] });
    this.items = Array.isArray(stored.items) ? stored.items : [];
    const missed: UtilityFired[] = [];
    for (const item of this.items) {
      if (item.status !== "scheduled") continue;
      if (item.dueAt <= this.now()) {
        const lateBy = this.now() - item.dueAt;
        if (item.repeat !== "none") {
          item.dueAt = nextOccurrence(item.dueAt, item.repeat, this.now());
        } else {
          item.status = lateBy < 12 * 3_600_000 ? "missed" : "done";
        }
        if (lateBy < 12 * 3_600_000) missed.push({ utility: { ...item }, missed: true });
      }
      if (item.status === "scheduled") this.armWithHooks(item);
    }
    await this.save();
    return missed;
  }

  /**
   * Upcoming (scheduled), currently ringing, and still-unacknowledged missed
   * entries. Missed ones are kept visible on purpose: they were created while
   * ABxAG was closed, and the `utility.fired` publish for them happens at
   * startup — usually before the renderer's socket has connected — so this
   * list is the only reliable way the user still learns about them. They
   * disappear on dismiss (one-shot) or roll to the next occurrence (repeat).
   */
  list(): Utility[] {
    return this.items
      .filter((item) => item.status === "scheduled" || item.status === "ringing" || item.status === "missed")
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  async add(input: { kind: Utility["kind"]; label?: string; dueAt?: number; inSeconds?: number; time?: string; repeat?: Utility["repeat"] }): Promise<Utility> {
    // Guard the offsets: a model-supplied negative, zero, NaN or absurd value
    // must fail loudly instead of quietly becoming "in one second" (which used
    // to look like the alarm was set, then rang at once).
    if (input.inSeconds !== undefined) {
      const seconds = Number(input.inSeconds);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("A future time is required.");
    }
    if (input.dueAt !== undefined && !Number.isFinite(Number(input.dueAt))) throw new Error("A future time is required.");
    const dueAt = input.dueAt ?? (input.inSeconds !== undefined ? this.now() + Number(input.inSeconds) * 1000 : input.time ? parseClock(input.time, this.now()) : NaN);
    if (!Number.isFinite(dueAt) || dueAt <= this.now()) throw new Error("A future time is required.");
    if (dueAt - this.now() > 366 * 86_400_000) throw new Error("That is too far in the future.");
    const item: Utility = {
      id: randomUUID(),
      kind: input.kind,
      label: (input.label || (input.kind === "timer" ? "Timer" : input.kind === "alarm" ? "Alarm" : "Reminder")).slice(0, 200),
      dueAt,
      repeat: input.kind === "timer" ? "none" : input.repeat || "none",
      createdAt: this.now(),
      firedAt: null,
      status: "scheduled",
    };
    this.items.push(item);
    this.armWithHooks(item);
    await this.save();
    return { ...item };
  }

  async cancel(id: string): Promise<boolean> {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return false;
    item.status = "cancelled";
    this.disarm(id);
    this.hooks.released?.(id);
    await this.save();
    return true;
  }

  async dismiss(id: string): Promise<void> {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    if (item.repeat !== "none") {
      item.status = "scheduled";
      item.dueAt = nextOccurrence(item.dueAt, item.repeat, this.now());
      this.armWithHooks(item);
    } else {
      item.status = "done";
      this.hooks.released?.(item.id);
    }
    await this.save();
  }

  async snooze(id: string, minutes = 5): Promise<void> {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    item.status = "scheduled";
    item.dueAt = this.now() + Math.max(1, Math.min(120, minutes)) * 60_000;
    // Release the old schedule explicitly before arming the new one: a host
    // that keys its external alerts on released() must not be left holding a
    // sleeper that would sound at the time we just moved away from.
    this.hooks.released?.(id);
    this.armWithHooks(item);
    await this.save();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(item: Utility): void {
    this.disarm(item.id);
    const delay = Math.max(0, item.dueAt - this.now());
    const timer = setTimeout(() => {
      if (item.dueAt - this.now() > 1_000) {
        this.arm(item); // long timers are chained in 24.8-day hops
        return;
      }
      this.fire(item);
    }, Math.min(delay, MAX_TIMEOUT));
    timer.unref?.();
    this.timers.set(item.id, timer);
  }

  /**
   * Arm the in-process timer and tell the host, so it can keep an external
   * alert alive for the case where ABxAG is closed when the alarm comes due.
   */
  private armWithHooks(item: Utility): void {
    this.arm(item);
    this.hooks.armed?.({ ...item });
  }

  private disarm(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private fire(item: Utility): void {
    item.firedAt = this.now();
    item.status = "ringing";
    this.timers.delete(item.id);
    // The alert has served its purpose; the external sleeper is done with too.
    this.hooks.released?.(item.id);
    void this.save();
    this.onFire({ utility: { ...item }, missed: false });
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.file, { items: this.items.filter((item) => item.status !== "cancelled" || this.now() - item.createdAt < 86_400_000).slice(-200) });
  }
}

/** "07:30", "7:30 pm", "19:05" → next occurrence (local time). */
export function parseClock(value: string, now: number): number {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return NaN;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  if (match[3] === "pm" && hours < 12) hours += 12;
  if (match[3] === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return NaN;
  const date = new Date(now);
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function nextOccurrence(from: number, repeat: Utility["repeat"], now: number): number {
  const date = new Date(from);
  do {
    date.setDate(date.getDate() + 1);
  } while (date.getTime() <= now || (repeat === "weekdays" && (date.getDay() === 0 || date.getDay() === 6)));
  return date.getTime();
}

