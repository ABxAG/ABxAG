/**
 * In-process publish/subscribe hub for state that the UI windows observe.
 *
 * The backend publishes here; the `/events` WebSocket fans everything out to
 * the main window and the desktop-companion window. Payloads must already be
 * safe for the renderer (no secrets, no raw screenshots).
 */

export type AppEventType =
  | "task.updated"
  | "task.step"
  | "task.finished"
  | "confirmation.requested"
  | "confirmation.resolved"
  | "question.asked"
  | "presence.changed"
  | "conversation.changed"
  | "social.changed"
  | "model.changed"
  | "model.status"
  | "notification"
  | "utility.fired"
  | "character.cue"
  | "autonomy.stopped"
  | "dnd.changed"
  | "speech.say"
  | "debug.log";

export interface AppEvent<T = unknown> {
  type: AppEventType;
  at: string;
  payload: T;
}

type Listener = (event: AppEvent) => void;

class AppEventHub {
  private readonly listeners = new Set<Listener>();
  private readonly lastByType = new Map<AppEventType, AppEvent>();

  publish<T>(type: AppEventType, payload: T): AppEvent<T> {
    const event: AppEvent<T> = { type, at: new Date().toISOString(), payload };
    this.lastByType.set(type, event as AppEvent);
    for (const listener of [...this.listeners]) {
      try {
        listener(event as AppEvent);
      } catch {
        /* a broken subscriber must not affect the publisher */
      }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Latest event of each state-like type, replayed to newly connected windows. */
  snapshot(types: AppEventType[]): AppEvent[] {
    return types.map((type) => this.lastByType.get(type)).filter((event): event is AppEvent => Boolean(event));
  }
}

export const appEvents = new AppEventHub();
