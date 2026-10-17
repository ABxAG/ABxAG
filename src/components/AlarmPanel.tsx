/**
 * Alarms & reminders.
 *
 * Two exports, deliberately split by mount point:
 *
 * - `AlarmRing` — the always-on-top ring card. Lives at the app root and is
 *   driven by the `utility.fired` event relayed through `useAppEvents`, so it
 *   appears even when the settings panel was never opened. Snooze / OK act
 *   immediately; ignored rings fade out on their own after 90 s.
 * - `AlarmPanel` — the Settings > System section: add, list, snooze, dismiss
 *   and cancel upcoming alarms / reminders / timers.
 *
 * Both talk to the same local endpoints (GET/POST/DELETE /api/utilities and
 * its /dismiss + /snooze children), so a change made in one is persisted by
 * the runtime scheduler and survives an app restart.
 */
import React, { useCallback, useEffect, useState } from "react";
import { AlarmClock, Bell, Timer } from "lucide-react";
import { api, type Utility, type UtilityInput, type UtilityKind } from "../lib/appApi";

const KIND_LABEL: Record<UtilityKind, string> = {
  alarm: "Alarm",
  timer: "Timer done",
  reminder: "Reminder",
};

const KIND_COLOR: Record<UtilityKind, string> = {
  alarm: "text-rose-400",
  timer: "text-cyan-400",
  reminder: "text-emerald-400",
};

/** How long an ignored ring stays on screen. */
const RING_TTL_MS = 90_000;

function KindIcon({ kind, className }: { kind: UtilityKind; className?: string }) {
  const cls = className ?? "h-4 w-4 shrink-0";
  if (kind === "alarm") return <AlarmClock className={cls} />;
  if (kind === "timer") return <Timer className={cls} />;
  return <Bell className={cls} />;
}

function formatDue(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Ring card (app root)
// ---------------------------------------------------------------------------

export function AlarmRing({ alarms }: { alarms: Utility[] }) {
  const [handled, setHandled] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const markHandled = useCallback((ids: string[]) => {
    setHandled((prev) => Array.from(new Set([...prev, ...ids])));
  }, []);

  // Forget rings the user already acted on, so a later ring of the same
  // repeating alarm can show up again.
  useEffect(() => {
    const live = new Set(alarms.map((a) => a.id));
    setHandled((prev) => (prev.some((id) => !live.has(id)) ? prev.filter((id) => live.has(id)) : prev));
  }, [alarms]);

  const visible = alarms.filter((a) => !handled.includes(a.id));

  // Auto-fade: nobody should still be looking at a 3-hour-old alarm.
  const visibleKey = visible.map((a) => a.id).join(",");
  useEffect(() => {
    if (!visible.length) return;
    const timers = visible.map((a) => window.setTimeout(() => markHandled([a.id]), RING_TTL_MS));
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  if (!visible.length) return null;

  const act = async (kind: "snooze" | "ok") => {
    if (busy) return;
    setBusy(true);
    const ids = visible.map((a) => a.id);
    try {
      await Promise.all(
        ids.map((id) => (kind === "snooze" ? api.snoozeUtility(id, 5) : api.dismissUtility(id))),
      );
    } catch {
      /* the runtime may have retired it already; hide either way */
    } finally {
      markHandled(ids);
      setBusy(false);
    }
  };

  const heading =
    visible.length === 1
      ? `${KIND_LABEL[visible[0].kind]}: ${visible[0].label}`
      : `${visible.length} alarms ringing`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none"
      role="dialog"
      aria-modal="true"
      aria-label="Alarm ringing"
    >
      <div className="pointer-events-auto fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(28rem,92vw)] bg-[#050508]/98 backdrop-blur-2xl border border-rose-500/30 rounded-2xl p-5 shadow-[0_0_80px_rgba(153,27,47,0.6)] animate-in fade-in zoom-in duration-300">
        <div className="flex items-start gap-3 mb-2">
          <KindIcon kind={visible[0].kind} className="h-7 w-7 shrink-0 text-rose-400 animate-pulse" />
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-white leading-tight">{heading}</h4>
            <ul className="mt-1 space-y-0.5">
              {visible.map((a) => (
                <li key={a.id} className="text-[11px] text-slate-300 leading-relaxed">
                  {KIND_LABEL[a.kind]} — {a.label}
                  {a.missed && <span className="ml-1.5 text-amber-300/90">(you missed it — ABxAG was closed)</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex gap-2 pt-3">
          <button
            type="button"
            onClick={() => act("snooze")}
            disabled={busy}
            className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-white hover:bg-white/10 transition disabled:opacity-40 cursor-pointer"
          >
            Snooze 5 min
          </button>
          <button
            type="button"
            onClick={() => act("ok")}
            disabled={busy}
            className="flex-1 rounded-xl border border-cyan-500/50 bg-cyan-500/15 px-3 py-2 text-[11px] text-cyan-200 hover:bg-cyan-500/30 transition disabled:opacity-40 cursor-pointer"
          >
            OK, got it
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings panel (Settings > System)
// ---------------------------------------------------------------------------

export function AlarmPanel() {
  const [utilities, setUtilities] = useState<Utility[]>([]);
  const [input, setInput] = useState<UtilityInput>({ kind: "reminder", label: "", time: "", repeat: "none" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUtilities(await api.utilities());
    } catch {
      setUtilities([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.addUtility(input);
      setInput({ kind: input.kind, label: "", time: "", repeat: "none" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set that alarm.");
    } finally {
      setSaving(false);
    }
  };

  /** act: snooze | dismiss | cancel — each one retires or reschedules it. */
  const act = async (u: Utility, action: "snooze" | "dismiss" | "cancel") => {
    try {
      if (action === "cancel") await api.cancelUtility(u.id);
      else if (action === "dismiss") await api.dismissUtility(u.id);
      else await api.snoozeUtility(u.id, 5);
    } catch {
      /* fall through to refresh: the list is the source of truth */
    }
    await refresh();
  };

  return (
    <div className="space-y-4 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Bell size={14} className="text-cyan-400" />
        <h3 className="font-mono uppercase tracking-widest text-slate-400">Alarms &amp; reminders</h3>
      </div>
      <p className="text-[10px] text-slate-500 leading-relaxed">
        Works with no voice session connected — the runtime keeps the schedule and rings the desktop.
        You can also just ask in chat: &ldquo;remind me in 5 minutes to stretch&rdquo;.
      </p>

      {/* Add form */}
      <form onSubmit={add} className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <select
            value={input.kind}
            onChange={(e) => setInput({ ...input, kind: e.target.value as UtilityKind })}
            aria-label="Kind"
            className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[10px] text-white outline-none cursor-pointer"
          >
            <option value="alarm">Alarm</option>
            <option value="reminder">Reminder</option>
            <option value="timer">Timer</option>
          </select>
          <input
            type="text"
            placeholder="Label"
            value={input.label ?? ""}
            onChange={(e) => setInput({ ...input, label: e.target.value })}
            className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[10px] text-white outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="time"
            aria-label="Time"
            value={input.time ?? ""}
            onChange={(e) => setInput({ ...input, time: e.target.value })}
            className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[10px] text-white outline-none"
          />
          <select
            value={input.repeat ?? "none"}
            onChange={(e) => setInput({ ...input, repeat: e.target.value as UtilityInput["repeat"] })}
            aria-label="Repeat"
            className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[10px] text-white outline-none cursor-pointer"
          >
            <option value="none">No repeat</option>
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-lg border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-[10px] font-medium text-cyan-200 uppercase tracking-wider hover:bg-cyan-500/30 disabled:opacity-40 cursor-pointer"
        >
          {saving ? "…" : "Set"}
        </button>
        {error && <p className="text-[10px] text-rose-300">{error}</p>}
      </form>

      {/* List */}
      <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
        {utilities.length === 0 ? (
          <p className="text-[10px] text-slate-500 text-center py-4">No alarms set yet.</p>
        ) : (
          utilities.map((u) => (
            <div
              key={u.id}
              className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border bg-black/20 ${
                u.status === "ringing" ? "border-rose-500/40" : "border-white/5"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[9px]">
                  <KindIcon kind={u.kind} className={`h-3 w-3 ${KIND_COLOR[u.kind]}`} />
                  <span className="font-mono text-[9px] text-slate-500">{KIND_LABEL[u.kind]}</span>
                  {u.repeat && u.repeat !== "none" && <span className="text-slate-500">{u.repeat}</span>}
                  {u.status === "ringing" && <span className="text-rose-300">ringing</span>}
                </div>
                <div className="text-sm font-medium text-white truncate">{u.label || KIND_LABEL[u.kind]}</div>
                <div className="text-[10px] text-slate-500">{formatDue(u.dueAt)}</div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => act(u, "snooze")}
                  title="Snooze 5 min"
                  aria-label="Snooze 5 min"
                  className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-white cursor-pointer"
                >
                  <AlarmClock size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => act(u, "dismiss")}
                  title="Dismiss"
                  aria-label="Dismiss"
                  className="p-1 rounded hover:bg-white/10 text-emerald-400 hover:text-emerald-300 cursor-pointer"
                >
                  ✓
                </button>
                <button
                  type="button"
                  onClick={() => act(u, "cancel")}
                  title="Cancel"
                  aria-label="Cancel"
                  className="p-1 rounded hover:bg-white/10 text-rose-400 hover:text-rose-300 cursor-pointer"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default AlarmPanel;