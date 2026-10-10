/**
 * Task HUD — what ABxAG is doing on the PC right now.
 *
 * Shows the active task (goal, live status, plan, recent actions), lets the
 * user pause / resume / take over / stop it, answers ABxAG's questions, and
 * offers interrupted tasks for continuation. Confirmation requests for risky
 * actions are always shown (even with the HUD hidden in settings) because the
 * agent is blocked until the user decides.
 */
import React, { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity, Check, ChevronDown, ChevronUp, CircleAlert, Hand, Loader2, OctagonX, Pause, Play,
  RotateCcw, ShieldAlert, Square, X, Circle, CircleDot, MessageCircleQuestion,
} from "lucide-react";
import { api, TERMINAL_TASK_STATES, type ConfirmationRequest, type TaskView } from "../lib/appApi";
import type { AppEventsState } from "../lib/useAppEvents";

/** Tool results sometimes carry objects ({success, summary}); never render an object as a React child. */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const v = value as { summary?: unknown; text?: unknown; message?: unknown };
  if (typeof v.summary === "string") return v.summary;
  if (typeof v.text === "string") return v.text;
  if (typeof v.message === "string") return v.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}


const STATE_LABEL: Record<TaskView["state"], string> = {
  queued: "Queued",
  planning: "Planning",
  running: "Working",
  paused: "Paused",
  waiting_user: "Needs your answer",
  waiting_confirmation: "Needs your approval",
  user_takeover: "You have control",
  recovering: "Recovering",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

const STATE_TONE: Record<TaskView["state"], string> = {
  queued: "bg-slate-400",
  planning: "bg-cyan-400 animate-pulse",
  running: "bg-cyan-400 animate-pulse",
  paused: "bg-amber-400",
  waiting_user: "bg-amber-400 animate-pulse",
  waiting_confirmation: "bg-amber-400 animate-pulse",
  user_takeover: "bg-violet-400",
  recovering: "bg-amber-400 animate-pulse",
  completed: "bg-emerald-400",
  failed: "bg-rose-400",
  cancelled: "bg-slate-400",
  interrupted: "bg-slate-400",
};

const FINISHED_VISIBLE_MS = 9000;

function elapsed(from: string, to?: string | null): string {
  const ms = Math.max(0, (to ? Date.parse(to) : Date.now()) - Date.parse(from));
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function HudButton({ onClick, title, children, tone = "default", disabled }: { onClick: () => void; title: string; children: ReactNode; tone?: "default" | "danger"; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
        tone === "danger"
          ? "border-rose-400/25 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
          : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

// ---- confirmation dialog ----------------------------------------------------------------

const ConfirmationDialog: React.FC<{ request: ConfirmationRequest; queued: number }> = ({ request, queued }) => {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setRemember(false);
    setError(null);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.id]);

  const secondsLeft = Math.max(0, Math.round((Date.parse(request.expiresAt) - now) / 1000));
  const details = Object.entries(request.details || {}).filter(([, value]) => value !== undefined && value !== null && value !== "").slice(0, 8);

  const answer = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.resolveConfirmation(request.id, approved, approved && remember ? "session" : "once");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your answer.");
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <motion.div
        initial={{ scale: 0.96, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 10 }}
        className="w-full max-w-md rounded-2xl border border-amber-400/25 bg-[#0b0c12]/95 p-5 text-left shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-2 text-amber-300">
            <ShieldAlert size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-amber-300/80">ABxAG needs your approval</div>
            <h3 id="confirm-title" className="mt-0.5 text-base font-medium text-white">{request.title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-300">{request.description}</p>
          </div>
        </div>

        {details.length > 0 && (
          <dl className="mt-4 space-y-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px]">
            {details.map(([key, value]) => (
              <div key={key} className="flex gap-3">
                <dt className="w-24 shrink-0 font-mono uppercase tracking-wider text-slate-500">{key}</dt>
                <dd className="min-w-0 flex-1 break-words text-slate-200">{typeof value === "string" ? value : JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        )}

        {request.allowRemember && (
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[11px] text-slate-300">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-cyan-500" />
            Allow this again without asking until ABxAG restarts
          </label>
        )}

        {error && <p className="mt-3 text-[11px] text-rose-300">{error}</p>}

        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-slate-500">
            {secondsLeft > 0 ? `Auto-denies in ${secondsLeft}s` : "Expired"}
            {queued > 0 ? ` · ${queued} more waiting` : ""}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void answer(false)}
              disabled={busy}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-40 cursor-pointer"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={() => void answer(true)}
              disabled={busy}
              className="rounded-xl border border-amber-300/40 bg-amber-400/20 px-4 py-2 text-xs font-semibold text-amber-100 transition hover:bg-amber-400/30 disabled:opacity-40 cursor-pointer"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : "Approve"}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

// ---- task card --------------------------------------------------------------------------

function QuestionBox({ task, question, options }: { task: TaskView; question: string; options: string[] }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await api.taskAction(task.id, "answer", value.trim());
      setText("");
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(text);
  };
  return (
    <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3">
      <div className="flex items-start gap-2 text-xs text-amber-100">
        <MessageCircleQuestion size={14} className="mt-0.5 shrink-0 text-amber-300" />
        <span>{question}</span>
      </div>
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button key={option} type="button" disabled={busy} onClick={() => void send(option)}
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10 cursor-pointer disabled:opacity-40">
              {option}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="mt-2 flex gap-1.5">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your answer…" aria-label="Answer ABxAG"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none focus:border-amber-300/40" />
        <button type="submit" disabled={busy || !text.trim()}
          className="rounded-lg border border-amber-300/30 bg-amber-400/15 px-2.5 text-[10px] font-mono uppercase text-amber-100 disabled:opacity-40 cursor-pointer">
          Send
        </button>
      </form>
    </div>
  );
}

const TaskCard: React.FC<{ task: TaskView; question?: { question: string; options: string[] }; onDismiss: () => void }> = ({ task, question, onDismiss }) => {
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const terminal = TERMINAL_TASK_STATES.has(task.state);

  useEffect(() => {
    if (terminal) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [terminal]);

  const act = async (action: "stop" | "pause" | "resume" | "takeover" | "return") => {
    setError(null);
    try {
      await api.taskAction(task.id, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    }
  };

  const steps = task.plan?.steps ?? [];
  const activeIndex = steps.findIndex((s) => s.status === "active");
  const firstStep = Math.max(0, Math.min(activeIndex - 2, steps.length - 6)); // keep the active step in a 6-step window
  const visibleSteps = steps.slice(firstStep, firstStep + 6);
  const recentActions = task.actions.slice(-4).reverse();
  const pendingQuestion = question ?? (task.pendingQuestion ? { question: task.pendingQuestion.text, options: task.pendingQuestion.options ?? [] } : undefined);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 30 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 30 }}
      className="w-80 rounded-2xl border border-white/10 bg-slate-950/80 p-4 text-left shadow-2xl backdrop-blur-2xl"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_TONE[task.state]}`} />
          <span className="truncate text-[10px] font-bold font-mono uppercase tracking-widest text-slate-200">{STATE_LABEL[task.state]}</span>
          <span className="shrink-0 text-[10px] font-mono text-slate-500">{elapsed(task.startedAt, task.completedAt)}</span>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Collapse task" : "Expand task"}
            className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-white cursor-pointer">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {terminal && (
            <button type="button" onClick={onDismiss} aria-label="Dismiss task" className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-white cursor-pointer">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <p className="mt-2 text-sm leading-snug text-white">{task.goal}</p>
      {!terminal && task.currentStatus && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-cyan-200/80">
          <Activity size={11} className="shrink-0" /> <span className="line-clamp-2">{task.currentStatus}</span>
        </p>
      )}
      {terminal && (task.result || task.error) && (
        <p className={`mt-1.5 text-[11px] leading-relaxed ${task.state === "completed" ? "text-emerald-200/90" : "text-rose-200/90"}`}>
          {/* result is {success, summary} from the agent — asText, never raw (raw objects crash React: error #31). */}
          {task.state === "completed" ? asText(task.result) : asText(task.error) || asText(task.result)}
        </p>
      )}

      {expanded && visibleSteps.length > 0 && (
        <ol className="mt-3 space-y-1">
          {visibleSteps.map((step, i) => (
            <li key={`${i}-${step.text}`} className={`flex items-start gap-2 text-[11px] ${step.status === "active" ? "text-white" : step.status === "done" ? "text-slate-400" : "text-slate-500"}`}>
              {step.status === "done" ? <Check size={11} className="mt-0.5 shrink-0 text-emerald-400" />
                : step.status === "active" ? <CircleDot size={11} className="mt-0.5 shrink-0 text-cyan-300" />
                : <Circle size={11} className="mt-0.5 shrink-0" />}
              <span className={step.status === "skipped" ? "line-through" : ""}>{asText(step.text)}</span>
            </li>
          ))}
        </ol>
      )}

      {expanded && recentActions.length > 0 && (
        <div className="mt-3 border-t border-white/5 pt-2">
          <div className="mb-1 text-[9px] font-mono uppercase tracking-widest text-slate-500">Recent actions</div>
          <ul className="space-y-1">
            {recentActions.map((action) => (
              <li key={action.id} className="flex items-start gap-2 text-[11px] text-slate-300">
                {action.status === "ok" ? <Check size={11} className="mt-0.5 shrink-0 text-emerald-400" /> : <CircleAlert size={11} className="mt-0.5 shrink-0 text-rose-400" />}
                <span className="min-w-0 flex-1 truncate" title={asText(action.error || action.summary)}>{asText(action.summary) || action.tool}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pendingQuestion && !terminal && <QuestionBox task={task} question={pendingQuestion.question} options={pendingQuestion.options} />}

      {error && <p className="mt-2 text-[11px] text-rose-300">{error}</p>}

      {!terminal && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-3">
          {task.state === "paused"
            ? <HudButton onClick={() => void act("resume")} title="Resume task"><Play size={10} /> Resume</HudButton>
            : <HudButton onClick={() => void act("pause")} title="Pause task" disabled={task.state === "user_takeover"}><Pause size={10} /> Pause</HudButton>}
          {task.state === "user_takeover"
            ? <HudButton onClick={() => void act("return")} title="Give control back to ABxAG"><RotateCcw size={10} /> Hand back</HudButton>
            : <HudButton onClick={() => void act("takeover")} title="Take over the mouse and keyboard"><Hand size={10} /> Take over</HudButton>}
          <HudButton onClick={() => void act("stop")} title="Stop this task" tone="danger"><Square size={9} /> Stop</HudButton>
        </div>
      )}
    </motion.div>
  );
};

// ---- HUD --------------------------------------------------------------------------------

export function TaskHud({ events, showHud, emergencyShortcut }: { events: AppEventsState; showHud: boolean; emergencyShortcut?: string }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [recoverable, setRecoverable] = useState<TaskView[]>([]);
  const [, tick] = useState(0);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    void api.recoverableTasks().then(setRecoverable).catch(() => setRecoverable([]));
  }, []);

  // Re-render so finished tasks leave the HUD after FINISHED_VISIBLE_MS.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(timer);
  }, []);

  const visible = useMemo(() => Object.values(events.tasks)
    .filter((task) => !dismissed.has(task.id))
    .filter((task) => !TERMINAL_TASK_STATES.has(task.state) || (task.state !== "interrupted" && Date.now() - Date.parse(task.completedAt || task.updatedAt) < FINISHED_VISIBLE_MS))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 2), [events.tasks, dismissed, events]);

  const anyActive = Object.values(events.tasks).some((task) => !TERMINAL_TASK_STATES.has(task.state));
  const offers = recoverable.filter((task) => !dismissed.has(task.id) && !events.tasks[task.id]?.state?.match(/running|planning/));
  const confirmation = events.confirmations[0];

  const emergencyStop = async () => {
    setStopping(true);
    try {
      await api.emergencyStop();
    } finally {
      setStopping(false);
    }
  };

  const continueTask = async (task: TaskView) => {
    setDismissed((d) => new Set(d).add(task.id));
    await api.taskAction(task.id, "continue").catch(() => undefined);
  };

  return (
    <>
      {showHud && (
        <div className="absolute right-6 top-20 z-40 flex max-h-[calc(100vh-7rem)] flex-col items-end gap-3 overflow-y-auto pb-2 sm:right-10" aria-live="polite">
          <AnimatePresence>
            {anyActive && (
              <motion.button
                key="estop"
                type="button"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                onClick={() => void emergencyStop()}
                disabled={stopping}
                title={`Stop everything ABxAG is doing${emergencyShortcut ? ` (${emergencyShortcut.replace(/\+/g, " + ")})` : ""}`}
                className="flex items-center gap-1.5 rounded-xl border border-rose-400/40 bg-rose-600/80 px-3 py-1.5 text-[10px] font-bold font-mono uppercase tracking-widest text-white shadow-lg hover:bg-rose-600 cursor-pointer disabled:opacity-60"
              >
                <OctagonX size={13} /> Emergency stop
              </motion.button>
            )}

            {visible.map((task) => (
              <TaskCard key={task.id} task={task} question={events.questions[task.id]} onDismiss={() => setDismissed((d) => new Set(d).add(task.id))} />
            ))}

            {!anyActive && offers.slice(0, 1).map((task) => (
              <motion.div key={`offer-${task.id}`} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }}
                className="w-80 rounded-2xl border border-white/10 bg-slate-950/80 p-4 text-left shadow-2xl backdrop-blur-2xl">
                <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">Unfinished task</div>
                <p className="mt-1 text-sm text-white">{task.goal}</p>
                <p className="mt-1 text-[11px] text-slate-400">It was interrupted when ABxAG closed. Continue from where it stopped?</p>
                <div className="mt-3 flex gap-1.5">
                  <HudButton onClick={() => void continueTask(task)} title="Continue the interrupted task"><Play size={10} /> Continue</HudButton>
                  <HudButton onClick={() => setDismissed((d) => new Set(d).add(task.id))} title="Forget this task"><X size={10} /> Dismiss</HudButton>
                </div>
              </motion.div>
            ))}

            {events.notices.map((notice) => (
              <motion.div key={notice.id} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }}
                className="w-80 rounded-xl border border-amber-400/20 bg-amber-950/50 px-3 py-2 text-left text-[11px] text-amber-100 backdrop-blur-xl">
                {asText(notice.text)}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {confirmation && <ConfirmationDialog key={confirmation.id} request={confirmation} queued={events.confirmations.length - 1} />}
      </AnimatePresence>
    </>
  );
}

