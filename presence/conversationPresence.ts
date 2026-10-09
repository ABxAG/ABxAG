/**
 * ConversationPresenceEngine — decides whether ABxAG may speak on her own.
 *
 * Silence is not a reason to talk. A proactive utterance needs a concrete
 * reason, passes the user's proactivity level (QUIET / BALANCED / LIVELY),
 * Do-Not-Disturb, global and per-reason cooldowns, an hourly cap and a
 * no-repeat rule. The "where did you go?" check-in happens at most once per
 * absence, only if a conversation was actually going on, and afterwards she
 * goes quiet and settles into sleep until the user comes back.
 */
import type { PresenceChange, PresenceSnapshot } from "./userPresence";

export type ProactivityLevel = "quiet" | "balanced" | "lively";

export type ConversationState =
  | "USER_SPEAKING"
  | "ABxAG_SPEAKING"
  | "TASK_RUNNING"
  | "USER_ACTIVE_PC"
  | "WATCHING_SCREEN"
  | "USER_IDLE"
  | "USER_TEMPORARILY_AWAY"
  | "DO_NOT_DISTURB"
  | "SLEEPING";

export type ProactiveReason =
  | "task_needs_user"
  | "task_completed"
  | "task_failed"
  | "alarm"
  | "reminder"
  | "critical_warning"
  | "away_checkin"
  | "user_returned"
  | "download_finished"
  | "visual_event"
  | "user_seems_stuck"
  | "conversation_continuation"
  | "casual";

export type Priority = "low" | "normal" | "high" | "critical";
export type Channel = "voice" | "visual" | "none";

export interface SpeechRequest {
  reason: ProactiveReason;
  priority: Priority;
  /** Dedup key: identical keys share a cooldown (e.g. "download:blender.msi"). */
  key?: string;
  text?: string;
}

export interface SpeechVerdict {
  allowed: boolean;
  channel: Channel;
  why: string;
}

const LEVEL_REASONS: Record<ProactivityLevel, Set<ProactiveReason>> = {
  quiet: new Set(["task_needs_user", "task_failed", "task_completed", "alarm", "reminder", "critical_warning"]),
  // Continuations are LIVELY-only: in BALANCED a pause after ABxAG's reply never prompts more talk.
  balanced: new Set(["task_needs_user", "task_failed", "task_completed", "alarm", "reminder", "critical_warning", "away_checkin", "user_returned", "download_finished", "user_seems_stuck"]),
  lively: new Set(["task_needs_user", "task_failed", "task_completed", "alarm", "reminder", "critical_warning", "away_checkin", "user_returned", "download_finished", "user_seems_stuck", "conversation_continuation", "visual_event", "casual"]),
};

/** Minimum gap between any two discretionary utterances. */
const GLOBAL_GAP_MS: Record<ProactivityLevel, number> = { quiet: 30 * 60_000, balanced: 4 * 60_000, lively: 75_000 };
const HOURLY_CAP: Record<ProactivityLevel, number> = { quiet: 2, balanced: 6, lively: 14 };
const KEY_COOLDOWN_MS = 30 * 60_000;
const SAME_TEXT_COOLDOWN_MS = 2 * 60 * 60_000;

/** Reasons that are direct consequences of something the user asked for. */
const USER_INITIATED: Set<ProactiveReason> = new Set(["task_needs_user", "task_completed", "task_failed", "alarm", "reminder", "critical_warning"]);

export interface PresenceSettings {
  level: ProactivityLevel;
  awayCheckinEnabled: boolean;
  returnGreetingEnabled: boolean;
  /** Minutes away before a return greeting is considered. */
  returnGreetingAfterMin: number;
}

export const DEFAULT_PRESENCE_SETTINGS: PresenceSettings = {
  level: "balanced",
  awayCheckinEnabled: true,
  returnGreetingEnabled: true,
  returnGreetingAfterMin: 15,
};

export class ConversationPresenceEngine {
  private userSpeaking = false;
  private abxagSpeaking = false;
  private taskRunning = false;
  private watchingScreen = false;
  private dndManual = false;
  private dndAuto: string | null = null;
  private sleeping = false;
  private presence: PresenceSnapshot | null = null;
  private lastExchangeAt = 0;
  private lastProactiveAt = 0;
  private readonly proactiveHistory: number[] = [];
  private readonly keyHistory = new Map<string, number>();
  private readonly textHistory = new Map<string, number>();
  private awayEpisode = 0;
  private checkinDoneForEpisode = -1;
  private greetedForEpisode = -1;
  private checkinAt = 0;
  private readonly listeners = new Set<(state: ConversationState) => void>();
  private lastState: ConversationState = "USER_IDLE";

  constructor(private settings: PresenceSettings = DEFAULT_PRESENCE_SETTINGS, private readonly now: () => number = Date.now) {}

  configure(settings: Partial<PresenceSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  get level(): ProactivityLevel {
    return this.settings.level;
  }

  onStateChange(listener: (state: ConversationState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- signals ----------------------------------------------------------------------

  userStartedSpeaking(): void {
    this.userSpeaking = true;
    this.lastExchangeAt = this.now();
    this.wake();
    this.emit();
  }

  userStoppedSpeaking(): void {
    this.userSpeaking = false;
    this.lastExchangeAt = this.now();
    this.emit();
  }

  /** A user turn arrived (voice transcript or typed). */
  userTurn(): void {
    this.lastExchangeAt = this.now();
    this.wake();
    this.emit();
  }

  abxagSpeakingChanged(speaking: boolean): void {
    this.abxagSpeaking = speaking;
    if (!speaking) this.lastExchangeAt = this.now();
    this.emit();
  }

  setTaskRunning(running: boolean): void {
    this.taskRunning = running;
    if (running) this.wake();
    this.emit();
  }

  setWatchingScreen(watching: boolean): void {
    this.watchingScreen = watching;
    this.emit();
  }

  setDnd(manual: boolean): void {
    this.dndManual = manual;
    this.emit();
  }

  setAutoDnd(reason: string | null): void {
    this.dndAuto = reason;
    this.emit();
  }

  get dnd(): { active: boolean; manual: boolean; auto: string | null } {
    return { active: this.dndManual || Boolean(this.dndAuto), manual: this.dndManual, auto: this.dndAuto };
  }

  updatePresence(snapshot: PresenceSnapshot, change?: PresenceChange): void {
    this.presence = snapshot;
    if (change && (change.to === "LIKELY_AWAY" || change.to === "AWAY") && change.from !== "LIKELY_AWAY" && change.from !== "AWAY") {
      this.awayEpisode += 1;
    }
    if (change?.returned) this.wake();
    // After an unanswered check-in, go quiet and sleep.
    if (this.checkinDoneForEpisode === this.awayEpisode && this.checkinAt && this.now() - this.checkinAt > 90_000 && this.isAway()) {
      this.sleeping = true;
    }
    if (snapshot.state === "AWAY" && !this.taskRunning) this.sleeping = true;
    this.emit();
  }

  private wake(): void {
    this.sleeping = false;
  }

  private isAway(): boolean {
    return this.presence?.state === "LIKELY_AWAY" || this.presence?.state === "AWAY";
  }

  // ---- derived state -----------------------------------------------------------------

  state(): ConversationState {
    if (this.userSpeaking) return "USER_SPEAKING";
    if (this.abxagSpeaking) return "ABxAG_SPEAKING";
    if (this.dnd.active) return "DO_NOT_DISTURB";
    if (this.taskRunning) return "TASK_RUNNING";
    if (this.sleeping) return "SLEEPING";
    if (this.isAway()) return "USER_TEMPORARILY_AWAY";
    if (this.watchingScreen || this.presence?.watchingMedia) return "WATCHING_SCREEN";
    if (this.presence?.state === "ACTIVE") return "USER_ACTIVE_PC";
    return "USER_IDLE";
  }

  private emit(): void {
    const state = this.state();
    if (state === this.lastState) return;
    this.lastState = state;
    for (const listener of this.listeners) listener(state);
  }

  // ---- the gate ----------------------------------------------------------------------

  /** Ask before any self-initiated utterance. Records the utterance when allowed. */
  request(request: SpeechRequest): SpeechVerdict {
    const verdict = this.evaluate(request);
    if (verdict.allowed && verdict.channel === "voice") this.recordSpoken(request);
    return verdict;
  }

  /** Same decision without recording (for previews/tests). */
  evaluate(request: SpeechRequest): SpeechVerdict {
    const now = this.now();
    const level = this.settings.level;
    const userInitiated = USER_INITIATED.has(request.reason);

    if (this.userSpeaking) return { allowed: false, channel: "none", why: "The user is speaking." };
    if (this.abxagSpeaking && request.priority !== "critical") return { allowed: false, channel: "none", why: "Already speaking." };

    if (this.dnd.active) {
      if (request.priority === "critical") return { allowed: true, channel: "voice", why: "Critical despite DND." };
      if (userInitiated) return { allowed: true, channel: "visual", why: "DND: shown silently." };
      return { allowed: false, channel: "none", why: "Do not disturb." };
    }

    if (!LEVEL_REASONS[level].has(request.reason)) return { allowed: false, channel: "none", why: `Not allowed at ${level} proactivity.` };

    if (userInitiated) {
      // Results of the user's own requests are always delivered; repetition still suppressed.
      if (request.text && this.recentlySaid(request.text, 5 * 60_000)) return { allowed: false, channel: "none", why: "Same line said moments ago." };
      return { allowed: true, channel: this.sleeping && request.priority === "low" ? "visual" : "voice", why: "Result of the user's request." };
    }

    // ---- discretionary speech ----
    if (this.sleeping && request.reason !== "user_returned") return { allowed: false, channel: "none", why: "Sleeping." };
    if (this.taskRunning && request.reason !== "user_seems_stuck") return { allowed: false, channel: "none", why: "Focused on a task." };

    if (request.reason === "away_checkin") {
      if (!this.settings.awayCheckinEnabled) return { allowed: false, channel: "none", why: "Check-ins disabled." };
      if (!this.isAway()) return { allowed: false, channel: "none", why: "User is not away." };
      if (this.checkinDoneForEpisode === this.awayEpisode) return { allowed: false, channel: "none", why: "Already checked in during this absence." };
      if (now - this.lastExchangeAt > 12 * 60_000) return { allowed: false, channel: "none", why: "No recent conversation to check in about." };
    }
    if (request.reason === "user_returned") {
      if (!this.settings.returnGreetingEnabled) return { allowed: false, channel: "none", why: "Return greetings disabled." };
      if (this.greetedForEpisode === this.awayEpisode) return { allowed: false, channel: "none", why: "Already greeted." };
    }
    if (request.reason === "conversation_continuation" && now - this.lastExchangeAt > 45_000) {
      return { allowed: false, channel: "none", why: "The conversation has moved on." };
    }
    if (request.reason === "visual_event" && this.presence?.state === "ACTIVE" && !this.watchingScreen) {
      return { allowed: false, channel: "none", why: "The user is busy working." };
    }

    const gap = request.priority === "high" ? GLOBAL_GAP_MS[level] / 3 : GLOBAL_GAP_MS[level];
    if (this.lastProactiveAt && now - this.lastProactiveAt < gap) return { allowed: false, channel: "none", why: "Spoke recently." };
    const lastHour = this.proactiveHistory.filter((at) => now - at < 3_600_000).length;
    if (lastHour >= HOURLY_CAP[level]) return { allowed: false, channel: "none", why: "Hourly limit reached." };
    const key = request.key || request.reason;
    const lastForKey = this.keyHistory.get(key);
    if (lastForKey && now - lastForKey < KEY_COOLDOWN_MS) return { allowed: false, channel: "none", why: "Already said this recently." };
    if (request.text && this.recentlySaid(request.text, SAME_TEXT_COOLDOWN_MS)) return { allowed: false, channel: "none", why: "Never repeat the same line." };
    return { allowed: true, channel: "voice", why: "Relevant and within limits." };
  }

  private recentlySaid(text: string, window: number): boolean {
    const at = this.textHistory.get(normalize(text));
    return Boolean(at && this.now() - at < window);
  }

  private recordSpoken(request: SpeechRequest): void {
    const now = this.now();
    if (!USER_INITIATED.has(request.reason)) {
      this.lastProactiveAt = now;
      this.proactiveHistory.push(now);
      while (this.proactiveHistory.length && now - this.proactiveHistory[0] > 3_600_000) this.proactiveHistory.shift();
      this.keyHistory.set(request.key || request.reason, now);
    }
    if (request.text) this.textHistory.set(normalize(request.text), now);
    if (request.reason === "away_checkin") {
      this.checkinDoneForEpisode = this.awayEpisode;
      this.checkinAt = now;
    }
    if (request.reason === "user_returned") this.greetedForEpisode = this.awayEpisode;
  }

  /** Away duration of the current/most recent episode, for the return greeting decision. */
  shouldGreetReturn(change: PresenceChange): boolean {
    return change.returned && change.awayForMs >= this.settings.returnGreetingAfterMin * 60_000;
  }

  snapshot() {
    return {
      state: this.state(),
      level: this.settings.level,
      dnd: this.dnd,
      sleeping: this.sleeping,
      userSpeaking: this.userSpeaking,
      abxagSpeaking: this.abxagSpeaking,
      taskRunning: this.taskRunning,
      presence: this.presence?.state ?? null,
      lastExchangeAt: this.lastExchangeAt,
      lastProactiveAt: this.lastProactiveAt,
      proactiveLastHour: this.proactiveHistory.filter((at) => this.now() - at < 3_600_000).length,
      awayCheckinDone: this.checkinDoneForEpisode === this.awayEpisode && this.awayEpisode > 0,
    };
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
}



