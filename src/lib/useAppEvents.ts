/**
 * Live view of the runtime's `/events` WebSocket for the main window.
 *
 * Keeps the latest state of every task, pending confirmations, open questions,
 * the model selection and transient model notices. Reconnects with bounded
 * exponential backoff (1 s → 30 s) and re-syncs over REST after each reconnect,
 * so a dropped socket never leaves stale HUD state behind.
 */
import { useEffect, useRef, useState } from "react";
import { api, type ConfirmationRequest, type ModelSelection, type TaskView, type Utility } from "./appApi";
import { reportPendingAlarms } from "./alarmSound";

export interface ModelNotice {
  id: number;
  kind: string;
  text: string;
  at: number;
}

export interface QuestionEvent {
  taskId: string;
  id: string;
  question: string;
  options: string[];
}

/** Shared companion-sync channel (also used by ABxAGCoreVisualizer). */
let companionChannel: BroadcastChannel | null = null;
function postToCompanion(message: unknown): void {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    if (!companionChannel) companionChannel = new BroadcastChannel("abxag-character-state");
    companionChannel.postMessage(message);
  } catch {
    /* broadcast unavailable */
  }
}

export interface AppEventsState {
  connected: boolean;
  tasks: Record<string, TaskView>;
  confirmations: ConfirmationRequest[];
  questions: Record<string, QuestionEvent>;
  selection: ModelSelection | null;
  notices: ModelNotice[];
  stopped: { reason: string; tasks: number; at: number } | null;
  /**
   * Alarms / reminders / timers that are ringing right now. Filled from
   * `utility.fired` on /events and re-seeded from GET /api/utilities on every
   * (re)connect, so a ring that started while the socket was down still shows.
   */
  alarms: Utility[];
}

const INITIAL: AppEventsState = { connected: false, tasks: {}, confirmations: [], questions: {}, selection: null, notices: [], stopped: null, alarms: [] };

/** Human wording for model.status events (models/router.ts). */
function describeModelStatus(payload: Record<string, unknown>): string | null {
  switch (payload.kind) {
    case "fallback": return `Switched to ${payload.using} because ${payload.from} failed.`;
    case "quota_exhausted": {
      const wait = Number(payload.retryAfterMs);
      const models = Array.isArray(payload.models) ? payload.models.join(", ") : "the selected model";
      return `Free-tier quota used up for ${models}.${Number.isFinite(wait) && wait > 0 ? ` Try again in about ${Math.ceil(wait / 60000)} min.` : ""}`;
    }
    case "capability_substitution": return `Using ${payload.using} instead of ${payload.selected} (${payload.reason}).`;
    case "offline_local": return `Offline — using the local model ${payload.using}.`;
    case "network": return payload.state === "offline" ? "Network offline. Cloud models are unavailable." : null;
    default: return null;
  }
}

function isTaskView(value: unknown): value is TaskView {
  return Boolean(value && typeof value === "object" && "id" in value && "goal" in value && "state" in value);
}

export function useAppEvents(enabled = true): AppEventsState {
  const [state, setState] = useState<AppEventsState>(INITIAL);
  const noticeId = useRef(0);
  // Alarm ids we have already sounded, so a reconnect that replays the current
  // ring does not make the user listen to it twice.
  const rungOnce = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const resync = async () => {
      try {
        const [tasks, confirmations, utilities] = await Promise.all([
          api.tasks(10),
          api.confirmations(),
          api.utilities().catch(() => [] as Utility[]),
        ]);
        if (disposed) return;
        setState((s) => ({
          ...s,
          tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
          confirmations,
          // Anything still ringing — or missed while ABxAG was closed, whose
          // startup publish we likely missed — must light up the card.
          alarms: [
            ...s.alarms,
            ...utilities
              .filter((u) => (u.status === "ringing" || u.status === "missed") && !s.alarms.some((a) => a.id === u.id))
              .map((u) => ({ ...u, status: "ringing" as const, missed: u.status === "missed" || u.missed === true })),
          ],
        }));
        // Same attention as a fresh ring: these came due while we were not
        // listening, so nothing has been heard about them yet.
        const pending = utilities.filter(
          (u) => (u.status === "ringing" || u.status === "missed") && !rungOnce.current.has(u.id),
        );
        for (const alarm of pending) rungOnce.current.add(alarm.id);
        reportPendingAlarms(pending);
      } catch {
        /* backend still starting; the socket replay covers active tasks */
      }
    };

    const handle = (type: string, payload: unknown) => {
      setState((s) => {
        switch (type) {
          case "task.updated":
          case "task.finished": {
            if (!isTaskView(payload)) return s; // loop.ts also emits a {taskId, success} summary
            const questions = { ...s.questions };
            if (!payload.pendingQuestion) delete questions[payload.id];
            return { ...s, tasks: { ...s.tasks, [payload.id]: payload }, questions };
          }
          case "question.asked": {
            const q = payload as QuestionEvent;
            return { ...s, questions: { ...s.questions, [q.taskId]: q } };
          }
          case "confirmation.requested": {
            const request = payload as ConfirmationRequest;
            return { ...s, confirmations: [...s.confirmations.filter((c) => c.id !== request.id), request] };
          }
          case "confirmation.resolved": {
            const id = (payload as { id: string }).id;
            return { ...s, confirmations: s.confirmations.filter((c) => c.id !== id) };
          }
          case "model.changed":
            return { ...s, selection: payload as ModelSelection };
          case "model.status": {
            const text = describeModelStatus(payload as Record<string, unknown>);
            if (!text) return s;
            const notice = { id: ++noticeId.current, kind: String((payload as { kind: string }).kind), text, at: Date.now() };
            return { ...s, notices: [...s.notices.slice(-3), notice] };
          }
          case "autonomy.stopped": {
            const p = payload as { reason: string; tasks: number };
            return { ...s, stopped: { reason: p.reason, tasks: p.tasks, at: Date.now() } };
          }
          case "utility.fired": {
            // An alarm / reminder / timer came due. The ring is a real
            // attention moment: sound it, show the alarm card with
            // snooze / dismiss, the dolls wave and the companion shell grows
            // her window (shell gets it over its own ipc, not this socket).
            const utility = payload as Utility;
            if (utility && typeof utility === "object" && typeof utility.id === "string") {
              const ringing: Utility = { ...utility, status: "ringing" };
              setState((s) => ({ ...s, alarms: [...s.alarms.filter((a) => a.id !== ringing.id), ringing] }));
              // Only sound it once per alarm, even if a reconnect replays it.
              if (!rungOnce.current.has(ringing.id)) {
                rungOnce.current.add(ringing.id);
                reportPendingAlarms([ringing]);
              }
            }
            try {
              window.dispatchEvent(new CustomEvent("abxag:alarm-fired", { detail: payload }));
            } catch {
              /* headless test env */
            }
            return s;
          }
          case "character.command": {
            // Stage direction for the live 3D character (and App, for
            // switches). Re-emitted as a window event so ABxAGCharacter and
            // App can each take their part without prop drilling, and echoed
            // over BroadcastChannel so the desktop-companion doll (separate
            // window, own CharacterSystem) performs/retints in sync.
            try {
              window.dispatchEvent(new CustomEvent("abxag:character-command", { detail: payload }));
            } catch {
              /* headless test env */
            }
            postToCompanion({ command: payload });
            return s;
          }
          default:
            return s;
        }
      });
    };

    const connect = () => {
      if (disposed) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/events`);
      socket.onopen = () => {
        retry = 0;
        setState((s) => ({ ...s, connected: true }));
        void resync();
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as { type: string; payload: unknown };
          handle(event.type, event.payload);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (disposed) return;
        const delay = Math.min(30_000, 1000 * 2 ** retry++);
        timer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [enabled]);

  // Model notices fade on their own after 12 s.
  useEffect(() => {
    if (!state.notices.length) return;
    const timer = setTimeout(() => setState((s) => ({ ...s, notices: s.notices.filter((n) => Date.now() - n.at < 12_000) })), 12_500);
    return () => clearTimeout(timer);
  }, [state.notices]);

  return state;
}
