/**
 * Cash on-ring card for alarms, reminders and timers (`utility.fired` over
 * `/events`, relayed by useAppEvents as `abxag:alarm-fired`).
 *
 * The ring must be visible even when no voice session is connected: this
 * card states kind, the exact reminder text and gives immediate control
 * (Snooze 5 min / Dismiss) through the existing utility endpoints.
 * If the alarm came due while ABxAG was off, the card says so.
 */
import React, { useEffect, useState } from "react";
import { AlarmClock, Bell, Timer, X, Clock3 } from "lucide-react";
import { api, type UtilityView } from "../lib/appApi";

const KIND_LABEL: Record<UtilityView["kind"], string> = {
  alarm: "Alarm",
  reminder: "Reminder",
  timer: "Timer done",
};

function KindIcon({ kind }: { kind: UtilityView["kind"] }) {
  const cls = "h-4 w-4 shrink-0";
  return kind === "alarm" ? <AlarmClock className={cls} /> : kind === "timer" ? <Timer className={cls} /> : <Bell className={cls} />;
}

export const AlarmCard: React.FC = () => {
  const [item, setItem] = useState<UtilityView | null>(null);
  const [missed, setMissed] = useState(false);
  const [busy, setBusy] = useState(false);

  // The runtime publishes utility.fired exactly once per ring; the card then
  // stays until the user acts on it (or 90 s pass, see below).
  useEffect(() => {
    const onFired = (event: Event) => {
      const payload = (event as CustomEvent<UtilityView & { missed?: boolean }>).detail;
      if (!payload || typeof payload !== "object") return;
      setItem({
        id: String(payload.id),
        kind: payload.kind,
        label: payload.label || "",
        dueAt: Number(payload.dueAt) || Date.now(),
        repeat: payload.repeat || "none",
        status: "ringing",
      });
      setMissed(payload.missed === true);
      setBusy(false);
    };
    window.addEventListener("abxag:alarm-fired", onFired);
    return () => window.removeEventListener("abxag:alarm-fired", onFired);
  }, []);

  // If the user ignored it, slide the card away on its own.
  useEffect(() => {
    if (!item || busy) return;
    const timer = window.setTimeout(() => setItem(null), 90_000);
    return () => window.clearTimeout(timer);
  }, [item, busy]);

  if (!item) return null;

  const dismiss = async () => {
    setBusy(true);
    try { void api.dismissUtility(item.id); } catch { /* ring already happened; the card just closes */ }
    setItem(null);
  };

  const snooze = async () => {
    setBusy(true);
    try { void api.snoozeUtility(item.id, 5); } catch { /* still closes; the scheduler keeps its own state */ }
    setItem(null);
  };

  return (
    <div
      role="alertdialog"
      aria-label={`${KIND_LABEL[item.kind]}: ${item.label}`}
      className="pointer-events-auto fixed bottom-24 right-4 z-50 w-[min(21rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-amber-400/40 bg-[#161320]/95 shadow-[0_10px_40px_rgba(0,0,0,0.55)] backdrop-blur motion-safe:animate-[alarm-pop_320ms_ease-out]"
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-400/15 text-amber-200">
          <KindIcon kind={item.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-amber-200/90">{KIND_LABEL[item.kind]}</span>
            {missed && <span className="rounded bg-rose-500/15 px-1.5 py-px text-[10px] text-rose-200">missed while ABxAG was off</span>}
          </div>
          {/* label is free text the user typed (or the tool received): plain text node */}
          <p className="mt-1 break-words text-sm leading-snug text-slate-100">{asAlarmText(item.label)}</p>
          <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
            <Clock3 className="h-3 w-3" />
            {new Date(item.dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void dismiss()}
          aria-label="Dismiss"
          className="rounded-lg p-1 text-slate-500 transition hover:bg-white/5 hover:text-white cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/10 px-4 py-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void snooze()}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50 cursor-pointer"
        >
          Snooze 5 min
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void dismiss()}
          className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-[11px] font-medium text-amber-100 transition hover:bg-amber-500/30 disabled:opacity-50 cursor-pointer"
        >
          OK, got it
        </button>
      </div>
    </div>
  );
};

/** Utility labels come from the user's own words + tool text — keep it a plain string. */
function asAlarmText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).text ?? "");
  }
  return value == null ? "" : String(value);
}
