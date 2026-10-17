/**
 * Settings › System › "Alarms & reminders".
 *
 * Backed by the existing scheduler APIs (GET/POST/DELETE /api/utilities).
 * Shows every upcoming alarm / reminder / timer with its due time, plus a
 * compact add row so the feature is discoverable without typing a command.
 */
import React, { useCallback, useEffect, useState } from "react";
import { AlarmClock, Bell, Timer, Plus, Trash2, Loader2 } from "lucide-react";
import { api, type UtilityView } from "../lib/appApi";

const KIND_LABEL: Record<UtilityView["kind"], string> = {
  alarm: "Alarm",
  reminder: "Reminder",
  timer: "Timer",
};

function repeatTag(repeat: UtilityView["repeat"]): string | null {
  return repeat === "daily" ? "daily" : repeat === "weekdays" ? "weekdays" : null;
}

function dueLabel(item: UtilityView): string {
  const due = new Date(item.dueAt);
  const today = new Date();
  const sameDay = due.toDateString() === today.toDateString();
  const time = due.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (due.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${due.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function AlarmsSection(): React.ReactElement {
  const [items, setItems] = useState<UtilityView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"alarm" | "reminder">("alarm");
  const [time, setTime] = useState("07:00");
  const [label, setLabel] = useState("");

  const reload = useCallback(async () => {
    try {
      setItems(await api.utilities());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Cheap periodic refresh: the list order changes as things ring/snooze.
    const timer = window.setInterval(() => { void reload(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const add = async () => {
    setBusy(true);
    try {
      await api.addUtility({ kind, time, label: label.trim() || undefined });
      setLabel("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    setBusy(true);
    try {
      await api.cancelUtility(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {/* Add row: the discovery path for users who never type a command. */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-200">
          {kind === "alarm" ? <AlarmClock className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
        </span>
        <select
          aria-label="Alarm kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as "alarm" | "reminder")}
          className="shrink-0 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-slate-200 cursor-pointer"
        >
          <option value="alarm">Alarm</option>
          <option value="reminder">Reminder</option>
        </select>
        <input
          type="time"
          aria-label="Time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="shrink-0 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200 cursor-pointer"
        />
        <input
          type="text"
          aria-label="Label"
          placeholder={kind === "alarm" ? "What it wakes you for" : "What to remember"}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={120}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void add()}
          title="Add"
          className="flex shrink-0 items-center gap-1 rounded-lg bg-cyan-500/20 px-2.5 py-1.5 text-[11px] font-medium text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-50 cursor-pointer"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add
        </button>
      </div>

      {error && <div className="px-4 py-2 text-[11px] text-rose-300">{error}</div>}
      {loading ? (
        <div className="px-4 py-3 text-[11px] text-slate-500">Loading upcoming…</div>
      ) : items.length === 0 ? (
        <div className="px-4 py-3 text-[11px] leading-relaxed text-slate-400">
          Nothing scheduled. Ask ABxAG in chat ("remind me at 6 in the morning to stretch") or add one above. When one rings, she grows big on your desktop, waves, and a card appears here too.
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="shrink-0 text-slate-400">
                  {item.kind === "alarm" ? <AlarmClock className="h-3.5 w-3.5" /> : item.kind === "timer" ? <Timer className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-xs text-slate-100">{item.label || KIND_LABEL[item.kind]}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <span>{dueLabel(item)}</span>
                    {repeatTag(item.repeat) && <span className="rounded bg-white/5 px-1 py-px text-[10px]">{repeatTag(item.repeat)}</span>}
                  </div>
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void cancel(item.id)}
                title="Cancel"
                className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-50 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
