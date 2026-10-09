/**
 * Working memory: the short-lived "what are we talking about" state.
 *
 * Holds recent user utterances, things that were mentioned or acted on
 * (files, people, apps, windows, URLs), the active task and recent failures.
 * Entries decay with time so "woh photo" means the photo from a minute ago,
 * not one from last week. Never sent wholesale to a model; the reference
 * resolver and context compiler pick from it.
 */

export type ReferentKind = "file" | "image" | "folder" | "person" | "app" | "window" | "url" | "download" | "task";

export interface Referent {
  kind: ReferentKind;
  label: string;
  /** Path, URL, contact ID, window title… */
  value: string;
  source: "user" | "task" | "screen" | "download" | "memory";
  at: number;
  salience: number;
}

export interface Utterance {
  role: "user" | "abxag";
  text: string;
  at: number;
}

const HALF_LIFE_MS = 10 * 60_000;

export class WorkingMemory {
  private readonly utterances: Utterance[] = [];
  private readonly referents: Referent[] = [];
  private readonly failures: Array<{ text: string; at: number }> = [];
  activeTaskId: string | null = null;
  activeGoal: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  noteUtterance(role: Utterance["role"], text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = this.utterances.at(-1);
    // Streaming transcription arrives in fragments; merge consecutive ones.
    if (last && last.role === role && this.now() - last.at < 4_000) {
      last.text = `${last.text} ${trimmed}`.slice(-1_000);
      last.at = this.now();
    } else {
      this.utterances.push({ role, text: trimmed.slice(0, 1_000), at: this.now() });
    }
    if (this.utterances.length > 40) this.utterances.splice(0, this.utterances.length - 40);
  }

  noteReferent(referent: Omit<Referent, "at" | "salience"> & { salience?: number }): void {
    const existing = this.referents.find((item) => item.kind === referent.kind && item.value === referent.value);
    if (existing) {
      existing.at = this.now();
      existing.salience = Math.min(1, Math.max(existing.salience, referent.salience ?? 0.7) + 0.1);
      existing.label = referent.label;
      existing.source = referent.source;
      return;
    }
    this.referents.push({ ...referent, at: this.now(), salience: referent.salience ?? 0.7 });
    if (this.referents.length > 80) this.referents.splice(0, this.referents.length - 80);
  }

  noteFailure(text: string): void {
    this.failures.push({ text: text.slice(0, 300), at: this.now() });
    if (this.failures.length > 20) this.failures.shift();
  }

  /** Referents of the given kinds ranked by decayed salience. */
  recent(kinds: ReferentKind[], maxAgeMs = 60 * 60_000): Array<Referent & { score: number }> {
    const now = this.now();
    return this.referents
      .filter((item) => kinds.includes(item.kind) && now - item.at <= maxAgeMs)
      .map((item) => ({ ...item, score: item.salience * Math.pow(0.5, (now - item.at) / HALF_LIFE_MS) }))
      .sort((a, b) => b.score - a.score);
  }

  recentUtterances(limit = 8): Utterance[] {
    return this.utterances.slice(-limit);
  }

  recentFailures(limit = 5): string[] {
    return this.failures.slice(-limit).map((item) => item.text);
  }

  snapshot() {
    return {
      activeTaskId: this.activeTaskId,
      activeGoal: this.activeGoal,
      utterances: this.recentUtterances(6),
      referents: this.recent(["file", "image", "folder", "person", "app", "window", "url", "download"]).slice(0, 12),
      failures: this.recentFailures(),
    };
  }
}

