/**
 * Live view of the runtime's `/events` WebSocket for the main window.
 *
 * Keeps the latest state of every task, pending confirmations, open questions,
 * the model selection and transient model notices. Reconnects with bounded
 * exponential backoff (1 s → 30 s) and re-syncs over REST after each reconnect,
 * so a dropped socket never leaves stale HUD state behind.
 */
import { useEffect, useRef, useState } from "react";
import { api, type ConfirmationRequest, type ModelSelection, type TaskView } from "./appApi";

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

export interface AppEventsState {
  connected: boolean;
  tasks: Record<string, TaskView>;
  confirmations: ConfirmationRequest[];
  questions: Record<string, QuestionEvent>;
  selection: ModelSelection | null;
  notices: ModelNotice[];
  stopped: { reason: string; tasks: number; at: number } | null;
}

const INITIAL: AppEventsState = { connected: false, tasks: {}, confirmations: [], questions: {}, selection: null, notices: [], stopped: null };

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

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const resync = async () => {
      try {
        const [tasks, confirmations] = await Promise.all([api.tasks(10), api.confirmations()]);
        if (disposed) return;
        setState((s) => ({
          ...s,
          tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
          confirmations,
        }));
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
