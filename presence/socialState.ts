/**
 * Lightweight social state for behavioral consistency.
 *
 * A handful of slow-moving scalars that the body/animation brain reads:
 * energy low + user away → sit, then sleep; task focus high → few idle
 * animations; user returned → look up and toward the screen. It exists only
 * so behavior is coherent over time; it is not presented as feelings.
 */
import type { ConversationState } from "./conversationPresence";
import type { PresenceState } from "./userPresence";

export type AttentionTarget = "user" | "screen" | "cursor" | "task" | "notification" | "none";

export interface SocialStateSnapshot {
  mood: number;          // -1..1 (baseline 0.2)
  energy: number;        // 0..1
  curiosity: number;     // 0..1
  taskFocus: number;     // 0..1
  engagement: number;    // 0..1
  attention: AttentionTarget;
  emotion: "neutral" | "happy" | "thinking" | "confused" | "sleepy" | "surprised" | "focused";
  presence: PresenceState;
  conversation: ConversationState;
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export class SocialState {
  private state: SocialStateSnapshot = {
    mood: 0.25, energy: 0.85, curiosity: 0.3, taskFocus: 0, engagement: 0.2,
    attention: "none", emotion: "neutral", presence: "ACTIVE", conversation: "USER_IDLE",
  };
  private lastTick: number;
  private surprisedUntil = 0;
  private readonly listeners = new Set<(state: SocialStateSnapshot) => void>();

  constructor(private readonly now: () => number = Date.now) {
    this.lastTick = now();
  }

  onChange(listener: (state: SocialStateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): SocialStateSnapshot {
    return { ...this.state };
  }

  setContext(presence: PresenceState, conversation: ConversationState): void {
    this.state.presence = presence;
    this.state.conversation = conversation;
    this.recompute();
  }

  /** Discrete events nudge the scalars. */
  event(kind: "interaction" | "task_started" | "task_succeeded" | "task_failed" | "novel_event" | "user_returned" | "poked" | "alarm"): void {
    const s = this.state;
    switch (kind) {
      case "interaction": s.engagement = clamp(s.engagement + 0.25); s.energy = clamp(s.energy + 0.08); break;
      case "task_started": s.taskFocus = 1; s.curiosity = clamp(s.curiosity + 0.1); break;
      case "task_succeeded": s.taskFocus = 0; s.mood = clamp(s.mood + 0.2, -1, 1); break;
      case "task_failed": s.taskFocus = 0; s.mood = clamp(s.mood - 0.15, -1, 1); break;
      case "novel_event": s.curiosity = clamp(s.curiosity + 0.3); break;
      case "user_returned": s.energy = clamp(s.energy + 0.35); s.engagement = clamp(s.engagement + 0.2); this.surprisedUntil = this.now() + 1_500; break;
      case "poked": s.curiosity = clamp(s.curiosity + 0.2); this.surprisedUntil = this.now() + 900; break;
      case "alarm": s.energy = 1; this.surprisedUntil = this.now() + 1_200; break;
    }
    this.recompute();
  }

  /** Time-based drift. Call every few seconds. */
  tick(): SocialStateSnapshot {
    const now = this.now();
    const minutes = Math.min(5, (now - this.lastTick) / 60_000);
    this.lastTick = now;
    const s = this.state;
    const away = s.presence === "LIKELY_AWAY" || s.presence === "AWAY";
    s.energy = clamp(s.energy + (away ? -0.06 : s.conversation === "USER_SPEAKING" ? 0.05 : -0.01) * minutes);
    s.engagement = clamp(s.engagement - 0.12 * minutes);
    s.curiosity = clamp(s.curiosity - 0.08 * minutes + (s.presence === "ACTIVE" ? 0.01 * minutes : 0));
    s.mood = clamp(s.mood + (0.25 - s.mood) * 0.1 * minutes, -1, 1);
    if (s.conversation !== "TASK_RUNNING") s.taskFocus = clamp(s.taskFocus - 0.5 * minutes);
    this.recompute();
    return this.snapshot();
  }

  private recompute(): void {
    const s = this.state;
    const before = JSON.stringify([s.attention, s.emotion, Math.round(s.energy * 10)]);
    s.attention = s.conversation === "TASK_RUNNING" ? "task"
      : s.conversation === "USER_SPEAKING" || s.conversation === "ABxAG_SPEAKING" ? "user"
        : s.conversation === "WATCHING_SCREEN" ? "screen"
          : s.presence === "ACTIVE" ? (s.curiosity > 0.55 ? "cursor" : "screen")
            : "none";
    s.emotion = this.now() < this.surprisedUntil ? "surprised"
      : s.conversation === "SLEEPING" || s.energy < 0.25 ? "sleepy"
        : s.conversation === "TASK_RUNNING" ? "focused"
          : s.mood < -0.2 ? "confused"
            : s.mood > 0.45 ? "happy"
              : s.curiosity > 0.6 ? "thinking" : "neutral";
    const after = JSON.stringify([s.attention, s.emotion, Math.round(s.energy * 10)]);
    if (before !== after) for (const listener of this.listeners) listener(this.snapshot());
  }
}



