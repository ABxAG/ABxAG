import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Mic,
  MicOff,
  ListTodo,
  Cpu,
  OctagonAlert,
  MessagesSquare,
  Zap,
  X,
  Loader2,
} from "lucide-react";
import { api, TERMINAL_TASK_STATES, type AppSettings, type TaskView } from "../lib/appApi";
import type { LiveState } from "../lib/audio";
import { HologramAvatar } from "./HologramAvatar";

/** Shell bridge (preload `abxag.hud`). Null outside Electron. */
interface HudBridge {
  onSync?: (cb: (payload: HudRelay) => () => void) => () => void;
  sendBackend?: (message: Record<string, unknown>) => void;
  close?: () => void;
  showMain?: () => void;
}

export interface HudRelay {
  connection?: LiveState;
  at?: number;
  notices?: Array<{ text: string; kind: string }>;
}

function hudBridge(): HudBridge | null {
  try {
    const w = window as unknown as { abxag?: { hud?: HudBridge } };
    return w.abxag?.hud ?? null;
  } catch {
    return null;
  }
}

const CONNECTION_LABEL: Record<LiveState, string> = {
  disconnected: "OFFLINE",
  connecting: "LINKING",
  listening: "LISTENING",
  speaking: "SPEAKING",
};

const QUICK_ACTIONS: Array<[string, string]> = [
  ["Open Downloads", "Open the Downloads folder in File Explorer"],
  ["RAM check", "Tell me what is using my RAM right now"],
  ["Open Chrome", "Open Google Chrome"],
  ["Screenshot", "Take a screenshot and describe what is on my screen"],
];

function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
      <header className="mb-1.5 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-slate-400">
        {icon}
        <span>{title}</span>
      </header>
      {children}
    </section>
  );
}

const iconSize = 12;

/**
 * HudOverlay — ZORION-style interactive HUD, standalone root rendered when
 * the shell opens `?hud=1`. All actions reuse existing HTTP endpoints, so no
 * new backend surface is needed.
 */
export function HudOverlay() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [relay, setRelay] = useState<HudRelay>({});
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [tools, setTools] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Relayed main-window state (mic, avatar, conversation).
  useEffect(() => {
    const off = hudBridge()?.onSync?.((payload) => setRelay(payload));
    return () => off?.();
  }, []);

  // Widget flags + compact mode.
  useEffect(() => {
    let dead = false;
    const load = () => {
      api.appSettings().then((s) => { if (!dead) setSettings(s); }).catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { dead = true; window.clearInterval(timer); };
  }, []);

  // Shared 3s poll for status / task / system widgets.
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      const t0 = performance.now();
      try {
        const [config, health, list, logs] = await Promise.all([
          fetch("/api/config", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch("/api/agent-health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          api.tasks(5).catch(() => [] as TaskView[]),
          fetch("/api/logs/commands", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        if (dead) return;
        setBackendOk(config ? true : false);
        const count = Number(health?.tools ?? health?.toolCount ?? health?.count);
        setTools(Number.isFinite(count) ? count : null);
        setLatencyMs(Math.round(performance.now() - t0));
        setTasks(Array.isArray(list) ? list : []);
        const lines = Array.isArray(logs?.lines) ? logs.lines as unknown[] : [];
        setLogLines(lines.map((l) => String(l).slice(0, 160)).filter(Boolean).slice(-4).reverse());
      } catch {
        if (!dead) setBackendOk(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => { dead = true; window.clearInterval(timer); };
  }, []);

  // Local clock.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const runQuick = useCallback(async (goal: string) => {
    setBusy(goal);
    try {
      await api.startTask(goal);
    } catch {
      /* backend unreachable — status widget already shows it */
    } finally {
      setBusy(null);
    }
  }, []);

  const emergency = useCallback(async () => {
    setBusy("__emergency");
    try {
      await api.emergencyStop();
    } catch {
      hudBridge()?.sendBackend?.({ type: "shortcut.emergency-stop" });
    } finally {
      setBusy(null);
    }
  }, []);

  const taskAction = useCallback(async (id: string, action: "pause" | "resume" | "stop") => {
    setBusy(id + action);
    try {
      await api.taskAction(id, action);
      const fresh = await api.tasks(5).catch(() => null);
      if (fresh) setTasks(fresh);
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  }, []);

  const w = settings?.overlay.widgets;
  const show = (key: keyof NonNullable<AppSettings["overlay"]["widgets"]>) => w?.[key] ?? true;
  const compact = settings?.overlay.compact ?? false;
  const relayFresh = typeof relay.at === "number" && Date.now() - relay.at < 15_000;
  const connection: LiveState = relayFresh ? (relay.connection ?? "disconnected") : "disconnected";
  const liveTasks = tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state));
  const conversationLines = relayFresh && relay.notices && relay.notices.length > 0
    ? relay.notices.slice(-4).reverse().map((n) => `[${n.kind}] ${n.text}`)
    : logLines;

  return (
    <div className="flex h-screen w-screen flex-col gap-2 overflow-y-auto bg-slate-950/95 p-3 text-slate-100">
      <header className="flex items-center justify-between" style={{ WebkitAppRegion: "drag" }}>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${connection === "listening" || connection === "speaking" ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`} />
          <span className="font-mono text-[11px] tracking-[0.3em] text-white/70">ABxAG HUD</span>
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" }}>
          <button type="button" onClick={() => hudBridge()?.showMain?.()} title="Open ABxAG"
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-300 hover:bg-white/10 cursor-pointer">APP</button>
          <button type="button" onClick={() => hudBridge()?.close?.()} title="Hide overlay (Ctrl+Alt+O to bring back)" aria-label="Hide overlay"
            className="rounded-lg border border-white/10 bg-white/5 p-1 text-slate-300 hover:bg-white/10 cursor-pointer"><X size={12} /></button>
        </div>
      </header>

      {show("status") && (
        <Card title="Status" icon={<Activity size={iconSize} />}>
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className={backendOk ? "text-emerald-300" : backendOk === false ? "text-rose-300" : "text-slate-400"}>
              {backendOk === null ? "…" : backendOk ? "BACKEND UP" : "BACKEND DOWN"}
            </span>
            {tools !== null && <span className="text-slate-400">{tools} tools</span>}
            {latencyMs !== null && <span className="ml-auto text-slate-500">{latencyMs}ms</span>}
          </div>
        </Card>
      )}

      {show("avatar") && (
        <Card title="Hologram" icon={<span className="inline-block h-3 w-3 rounded-full bg-cyan-400/70" />}>
          <div className="flex items-center gap-2.5">
            <HologramAvatar connection={connection} />
            <div className="font-mono text-[10px] leading-relaxed text-slate-400">
              <div className="text-slate-200">{CONNECTION_LABEL[connection]}</div>
              <div>eyes follow your pointer, mouth moves as she speaks</div>
            </div>
          </div>
        </Card>
      )}

      {!compact && show("mic") && (
        <Card title="Mic" icon={connection === "disconnected" ? <MicOff size={iconSize} /> : <Mic size={iconSize} />}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-slate-200">{relayFresh ? CONNECTION_LABEL[connection] : "LINK IDLE"}</span>
            <button type="button" onClick={() => hudBridge()?.showMain?.()}
              className="ml-auto rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-300 hover:bg-white/10 cursor-pointer">OPEN APP TO TALK</button>
          </div>
          {!relayFresh && <div className="mt-1 font-mono text-[9px] text-slate-500">voice state appears once the main window links up</div>}
        </Card>
      )}

      {show("task") && (
        <Card title="Task" icon={<ListTodo size={iconSize} />}>
          {liveTasks.length === 0 ? (
            <div className="font-mono text-[10px] text-slate-500">no active task</div>
          ) : (
            <ul className="space-y-1.5">
              {liveTasks.slice(0, 3).map((t) => (
                <li key={t.id} className="rounded-lg bg-black/30 p-1.5">
                  <div className="truncate text-[11px] text-slate-200">{t.goal}</div>
                  <div className="mt-1 flex items-center gap-1">
                    <span className="font-mono text-[9px] uppercase text-slate-500">{t.state}</span>
                    <span className="ml-auto flex gap-1">
                      {t.state === "running" || t.state === "paused" ? (
                        <button type="button" disabled={busy !== null} onClick={() => void taskAction(t.id, t.state === "paused" ? "resume" : "pause")}
                          className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] hover:bg-white/10 cursor-pointer disabled:opacity-40">
                          {t.state === "paused" ? "RESUME" : "PAUSE"}
                        </button>
                      ) : null}
                      <button type="button" disabled={busy !== null} onClick={() => void taskAction(t.id, "stop")}
                        className="rounded border border-rose-400/30 px-1.5 py-0.5 font-mono text-[9px] text-rose-200 hover:bg-rose-500/20 cursor-pointer disabled:opacity-40">STOP</button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {!compact && show("system") && (
        <Card title="System" icon={<Cpu size={iconSize} />}>
          <div className="font-mono text-[11px] text-slate-300">
            {latencyMs !== null ? `loop ${latencyMs}ms` : "probing…"}
            {tools !== null && <span className="text-slate-500"> • agent {tools} tools</span>}
          </div>
        </Card>
      )}

      {!compact && show("clock") && (
        <div className="text-center font-mono text-sm tracking-widest text-white/80">
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </div>
      )}

      {show("emergency") && (
        <button type="button" onClick={() => void emergency()} disabled={busy === "__emergency"}
          className="flex items-center justify-center gap-2 rounded-xl border border-rose-500/50 bg-rose-600/25 px-3 py-2.5 font-mono text-xs tracking-widest text-rose-100 hover:bg-rose-600/40 cursor-pointer disabled:opacity-50">
          {busy === "__emergency" ? <Loader2 size={14} className="animate-spin" /> : <OctagonAlert size={14} />}
          STOP ALL TASKS
        </button>
      )}

      {!compact && show("conversation") && (
        <Card title="Conversation" icon={<MessagesSquare size={iconSize} />}>
          {conversationLines.length > 0 ? (
            <ul className="space-y-1">
              {conversationLines.map((line, i) => (
                <li key={i} className="truncate font-mono text-[10px] text-slate-400">{line}</li>
              ))}
            </ul>
          ) : (
            <div className="font-mono text-[10px] text-slate-500">quiet for now</div>
          )}
        </Card>
      )}

      {!compact && show("quick") && (
        <Card title="Quick actions" icon={<Zap size={iconSize} />}>
          <div className="grid grid-cols-2 gap-1.5">
            {QUICK_ACTIONS.map(([label, goal]) => (
              <button key={label} type="button" disabled={busy !== null} onClick={() => void runQuick(goal)}
                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] text-slate-200 hover:bg-white/10 cursor-pointer disabled:opacity-40">
                {busy === goal ? "…" : label}
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
