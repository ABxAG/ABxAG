/**
 * TaskSession: the unit of autonomous work.
 *
 * A session records what the user asked, the current plan hypothesis, every
 * action and its verification, permission decisions, touched files and the
 * outcome. Sessions are persisted so that a crash leaves an auditable trail
 * and so unfinished, non-sensitive work can be offered for re-verification
 * and continuation after a restart. A session is never resumed blindly.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DebouncedJsonWriter, readJsonFile } from "../shared/jsonFile";

export type TaskState =
  | "queued"
  | "planning"
  | "running"
  | "paused"
  | "waiting_user"
  | "waiting_confirmation"
  | "user_takeover"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Allowed transitions. Anything else is a programming error and is rejected. */
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ["planning", "running", "cancelled", "failed"],
  planning: ["running", "waiting_user", "waiting_confirmation", "paused", "completed", "failed", "cancelled", "recovering", "user_takeover"],
  running: ["planning", "paused", "waiting_user", "waiting_confirmation", "user_takeover", "recovering", "completed", "failed", "cancelled"],
  recovering: ["planning", "running", "paused", "waiting_user", "failed", "cancelled", "completed"],
  paused: ["planning", "running", "cancelled", "failed"],
  waiting_user: ["planning", "running", "paused", "cancelled", "failed", "completed"],
  waiting_confirmation: ["planning", "running", "paused", "cancelled", "failed"],
  user_takeover: ["planning", "running", "paused", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: ["planning", "cancelled"],
};

export type FailureCategory =
  | "ELEMENT_NOT_FOUND"
  | "WINDOW_NOT_OPEN"
  | "PAGE_CHANGED"
  | "LOADING_TIMEOUT"
  | "DOWNLOAD_FAILED"
  | "PERMISSION_DIALOG"
  | "PERMISSION_DENIED"
  | "NETWORK_FAILURE"
  | "AMBIGUOUS_TARGET"
  | "APPLICATION_CRASHED"
  | "USER_INTERRUPTED"
  | "UNEXPECTED_UI"
  | "INVALID_ACTION"
  | "MODEL_FAILURE"
  | "TOOL_ERROR"
  | "VERIFICATION_FAILED";

export interface TaskAction {
  id: string;
  step: number;
  at: string;
  tool: string;
  argsSummary: string;
  /** Concise, user-readable description, e.g. "Opened Chrome". */
  summary: string;
  status: "ok" | "failed" | "denied" | "cancelled" | "skipped";
  durationMs: number;
  error?: string;
  failureCategory?: FailureCategory;
  verification?: { passed: boolean; evidence: string; method: "deterministic" | "model" | "none" };
}

export interface TaskFileRecord {
  path: string;
  change: "created" | "modified" | "moved" | "renamed" | "copied" | "deleted" | "downloaded" | "opened";
  at: string;
  detail?: string;
}

export interface TaskPermissionRecord {
  capability: string;
  decision: "allow" | "ask" | "deny";
  outcome?: "approved" | "rejected" | "expired" | "auto";
  scope?: string;
  at: string;
}

export interface TaskSession {
  id: string;
  goal: string;
  interpretedGoal: string | null;
  origin: "voice" | "text" | "api" | "internal" | "recovery";
  state: TaskState;
  modelId: string | null;
  plan: { summary: string; steps: Array<{ text: string; status: "pending" | "active" | "done" | "skipped" }> } | null;
  currentStatus: string;
  statusHistory: Array<{ at: string; text: string }>;
  observations: Array<{ at: string; summary: string; changed: boolean }>;
  actions: TaskAction[];
  retries: Partial<Record<FailureCategory, number>>;
  consecutiveFailures: number;
  permissions: TaskPermissionRecord[];
  files: TaskFileRecord[];
  references: Array<{ phrase: string; resolvedTo: string; confidence: number }>;
  pendingQuestion: { id: string; text: string; options?: string[]; askedAt: string } | null;
  pendingConfirmation: { id: string; capability: string; description: string; details: Record<string, unknown>; askedAt: string } | null;
  /** Sensitive tasks (messages, purchases, installs) are never offered for automatic continuation. */
  sensitive: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  result: { success: boolean; summary: string; data?: Record<string, unknown> } | null;
  error: string | null;
  usage: { modelCalls: number; visionCalls: number; inputTokens: number; outputTokens: number };
  timings: { perceptionMs: number; planningMs: number; actionMs: number };
  /** Step counter (one per planner decision). */
  steps: number;
}

export interface TaskStoreOptions {
  dataDir: string;
  maxSessions?: number;
}

export type TaskListener = (session: TaskSession, change: "created" | "updated" | "finished") => void;

export class TaskStore {
  private readonly sessions = new Map<string, TaskSession>();
  private readonly writer: DebouncedJsonWriter;
  private readonly file: string;
  private readonly listeners = new Set<TaskListener>();
  private recoverable: TaskSession[] = [];

  constructor(private readonly options: TaskStoreOptions) {
    this.file = path.join(options.dataDir, "tasks", "sessions.v1.json");
    this.writer = new DebouncedJsonWriter(this.file, 300);
  }

  async initialize(): Promise<void> {
    const stored = await readJsonFile<{ version: number; sessions: TaskSession[] }>(this.file, { version: 1, sessions: [] });
    const now = new Date().toISOString();
    for (const session of stored.sessions || []) {
      if (!session?.id) continue;
      if (!TERMINAL_STATES.has(session.state)) {
        // The process ended while this task was live. Nothing is resumed
        // automatically: the state of the desktop must be re-verified first.
        session.state = "interrupted";
        session.updatedAt = now;
        session.pendingConfirmation = null;
        session.pendingQuestion = null;
        session.currentStatus = "Interrupted by an application restart.";
        session.statusHistory.push({ at: now, text: session.currentStatus });
        if (!session.sensitive) this.recoverable.push(session);
      }
      this.sessions.set(session.id, session);
    }
    this.persist();
  }

  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(input: { goal: string; origin: TaskSession["origin"]; modelId?: string | null; sensitive?: boolean }): TaskSession {
    const now = new Date().toISOString();
    const session: TaskSession = {
      id: randomUUID(),
      goal: input.goal.trim().slice(0, 2_000),
      interpretedGoal: null,
      origin: input.origin,
      state: "queued",
      modelId: input.modelId ?? null,
      plan: null,
      currentStatus: "Starting…",
      statusHistory: [{ at: now, text: "Starting…" }],
      observations: [],
      actions: [],
      retries: {},
      consecutiveFailures: 0,
      permissions: [],
      files: [],
      references: [],
      pendingQuestion: null,
      pendingConfirmation: null,
      sensitive: Boolean(input.sensitive),
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      result: null,
      error: null,
      usage: { modelCalls: 0, visionCalls: 0, inputTokens: 0, outputTokens: 0 },
      timings: { perceptionMs: 0, planningMs: 0, actionMs: 0 },
      steps: 0,
    };
    this.sessions.set(session.id, session);
    this.emit(session, "created");
    this.persist();
    return session;
  }

  get(id: string): TaskSession | undefined {
    return this.sessions.get(id);
  }

  list(limit = 50): TaskSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  active(): TaskSession[] {
    return [...this.sessions.values()].filter((session) => !TERMINAL_STATES.has(session.state));
  }

  /** Interrupted, non-sensitive sessions from a previous run. Consumed once. */
  takeRecoverable(): TaskSession[] {
    const list = this.recoverable;
    this.recoverable = [];
    return list;
  }

  peekRecoverable(): TaskSession[] {
    return [...this.recoverable];
  }

  canTransition(from: TaskState, to: TaskState): boolean {
    return from === to || TRANSITIONS[from].includes(to);
  }

  transition(id: string, to: TaskState, status?: string): TaskSession {
    const session = this.require(id);
    if (session.state === to) {
      if (status) this.setStatus(id, status);
      return session;
    }
    if (!this.canTransition(session.state, to)) {
      throw new Error(`Invalid task transition ${session.state} -> ${to}`);
    }
    session.state = to;
    session.updatedAt = new Date().toISOString();
    if (TERMINAL_STATES.has(to)) {
      session.completedAt = session.updatedAt;
      session.pendingConfirmation = null;
      session.pendingQuestion = null;
    }
    if (status) this.pushStatus(session, status);
    this.emit(session, TERMINAL_STATES.has(to) ? "finished" : "updated");
    this.persist();
    return session;
  }

  setStatus(id: string, text: string): void {
    const session = this.require(id);
    this.pushStatus(session, text);
    this.emit(session, "updated");
    this.persist();
  }

  update(id: string, mutate: (session: TaskSession) => void): TaskSession {
    const session = this.require(id);
    mutate(session);
    session.updatedAt = new Date().toISOString();
    if (session.actions.length > 120) session.actions.splice(0, session.actions.length - 120);
    if (session.observations.length > 30) session.observations.splice(0, session.observations.length - 30);
    if (session.statusHistory.length > 80) session.statusHistory.splice(0, session.statusHistory.length - 80);
    this.emit(session, "updated");
    this.persist();
    return session;
  }

  recordAction(id: string, action: Omit<TaskAction, "id" | "at">): TaskAction {
    const record: TaskAction = { ...action, id: randomUUID(), at: new Date().toISOString() };
    this.update(id, (session) => {
      session.actions.push(record);
    });
    return record;
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  private pushStatus(session: TaskSession, text: string): void {
    const trimmed = text.trim().slice(0, 240);
    if (!trimmed || session.currentStatus === trimmed) return;
    session.currentStatus = trimmed;
    session.statusHistory.push({ at: new Date().toISOString(), text: trimmed });
    session.updatedAt = new Date().toISOString();
  }

  private require(id: string): TaskSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown task session ${id}`);
    return session;
  }

  private emit(session: TaskSession, change: "created" | "updated" | "finished"): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(session, change);
      } catch {
        /* listeners never break the store */
      }
    }
  }

  private persist(): void {
    const max = this.options.maxSessions ?? 100;
    this.writer.schedule(() => {
      const sessions = [...this.sessions.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, max);
      return { version: 1, sessions };
    });
  }
}

/** Renderer-safe projection: concise status, no raw arguments beyond summaries. */
export function publicTaskView(session: TaskSession) {
  return {
    id: session.id,
    goal: session.goal,
    state: session.state,
    origin: session.origin,
    modelId: session.modelId,
    currentStatus: session.currentStatus,
    statusHistory: session.statusHistory.slice(-12),
    plan: session.plan,
    actions: session.actions.slice(-40).map((action) => ({
      id: action.id,
      step: action.step,
      at: action.at,
      tool: action.tool,
      summary: action.summary,
      status: action.status,
      durationMs: action.durationMs,
      error: action.error,
      failureCategory: action.failureCategory,
      verified: action.verification?.passed ?? null,
    })),
    files: session.files.slice(-30),
    permissions: session.permissions.slice(-20),
    pendingQuestion: session.pendingQuestion,
    pendingConfirmation: session.pendingConfirmation,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    result: session.result,
    error: session.error,
    usage: session.usage,
    timings: session.timings,
    steps: session.steps,
    sensitive: session.sensitive,
  };
}
