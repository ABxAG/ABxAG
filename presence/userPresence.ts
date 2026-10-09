/**
 * User presence model.
 *
 * Fuses cheap, non-invasive signals — physical mouse/keyboard input, voice
 * activity, OS idle time, session lock and whether the screen is showing
 * moving media — into ACTIVE / PASSIVE / LIKELY_AWAY / AWAY, plus a one-shot
 * RETURNED event. No camera, no screen content, no keystroke contents.
 */

export type PresenceState = "ACTIVE" | "PASSIVE" | "LIKELY_AWAY" | "AWAY";

export interface PresenceThresholds {
  /** No input for this long → PASSIVE (reading, watching). */
  passiveAfterMs: number;
  /** No input and no voice for this long → LIKELY_AWAY. */
  likelyAwayAfterMs: number;
  /** → AWAY (or immediately when the session is locked). */
  awayAfterMs: number;
}

export const DEFAULT_THRESHOLDS: PresenceThresholds = {
  passiveAfterMs: 45_000,
  likelyAwayAfterMs: 5 * 60_000,
  awayAfterMs: 12 * 60_000,
};

export interface PresenceSnapshot {
  state: PresenceState;
  since: number;
  lastInputAt: number;
  lastVoiceAt: number;
  sessionLocked: boolean;
  watchingMedia: boolean;
  idleMs: number;
  confidence: number;
}

export interface PresenceChange {
  from: PresenceState;
  to: PresenceState;
  at: number;
  returned: boolean;
  awayForMs: number;
}

export class UserPresenceEngine {
  private state: PresenceState = "ACTIVE";
  private since: number;
  private lastInputAt: number;
  private lastVoiceAt = 0;
  private sessionLocked = false;
  private watchingMediaUntil = 0;
  private awayStartedAt = 0;
  private readonly listeners = new Set<(change: PresenceChange) => void>();

  constructor(private thresholds: PresenceThresholds = DEFAULT_THRESHOLDS, private readonly now: () => number = Date.now) {
    this.since = now();
    this.lastInputAt = now();
  }

  setThresholds(thresholds: Partial<PresenceThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  onChange(listener: (change: PresenceChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Physical mouse/keyboard input (never ABxAG's own synthetic input). */
  recordInput(at = this.now()): void {
    this.lastInputAt = Math.max(this.lastInputAt, at);
    this.evaluate();
  }

  recordVoice(at = this.now()): void {
    this.lastVoiceAt = Math.max(this.lastVoiceAt, at);
    this.evaluate();
  }

  /** OS idle timer fallback when raw input events are unavailable. */
  recordOsIdle(idleMs: number): void {
    const inferred = this.now() - Math.max(0, idleMs);
    if (inferred > this.lastInputAt + 500) this.lastInputAt = inferred;
    this.evaluate();
  }

  setSessionLocked(locked: boolean): void {
    this.sessionLocked = locked;
    if (!locked) this.lastInputAt = this.now();
    this.evaluate();
  }

  /** The foreground shows moving media (video/stream): no input ≠ away. */
  noteMediaActivity(durationMs = 20_000): void {
    this.watchingMediaUntil = Math.max(this.watchingMediaUntil, this.now() + durationMs);
    this.evaluate();
  }

  tick(): PresenceSnapshot {
    this.evaluate();
    return this.snapshot();
  }

  snapshot(): PresenceSnapshot {
    const now = this.now();
    const idleMs = now - Math.max(this.lastInputAt, this.lastVoiceAt);
    return {
      state: this.state,
      since: this.since,
      lastInputAt: this.lastInputAt,
      lastVoiceAt: this.lastVoiceAt,
      sessionLocked: this.sessionLocked,
      watchingMedia: now < this.watchingMediaUntil,
      idleMs,
      confidence: this.state === "ACTIVE" ? 0.95 : this.state === "PASSIVE" ? 0.75 : this.state === "LIKELY_AWAY" ? Math.min(0.9, 0.55 + (idleMs - this.thresholds.likelyAwayAfterMs) / (this.thresholds.awayAfterMs * 2)) : 0.95,
    };
  }

  private evaluate(): void {
    const now = this.now();
    const lastActivity = Math.max(this.lastInputAt, this.lastVoiceAt);
    const idle = now - lastActivity;
    const watching = now < this.watchingMediaUntil;
    let next: PresenceState;
    if (this.sessionLocked) next = "AWAY";
    else if (idle < this.thresholds.passiveAfterMs) next = "ACTIVE";
    else if (watching) next = "PASSIVE";
    else if (idle < this.thresholds.likelyAwayAfterMs) next = "PASSIVE";
    else if (idle < this.thresholds.awayAfterMs) next = "LIKELY_AWAY";
    else next = "AWAY";
    if (next === this.state) return;
    const from = this.state;
    const wasAway = from === "LIKELY_AWAY" || from === "AWAY";
    if (!wasAway && (next === "LIKELY_AWAY" || next === "AWAY")) this.awayStartedAt = lastActivity;
    const returned = wasAway && (next === "ACTIVE" || next === "PASSIVE");
    const change: PresenceChange = { from, to: next, at: now, returned, awayForMs: returned ? now - this.awayStartedAt : 0 };
    this.state = next;
    this.since = now;
    for (const listener of this.listeners) listener(change);
  }
}

