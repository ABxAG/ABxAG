/**
 * Typed client for the runtime REST API (runtime/abxagRuntime.ts) and the
 * `/events` WebSocket. Everything here is renderer-safe: the backend never
 * returns secrets, and nothing in this file sends or stores one except
 * `saveProviderKey`, which posts the key once and keeps no copy.
 */

// ---- tasks ------------------------------------------------------------------------------

export type TaskState =
  | "queued" | "planning" | "running" | "paused" | "waiting_user" | "waiting_confirmation"
  | "user_takeover" | "recovering" | "completed" | "failed" | "cancelled" | "interrupted";

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled", "interrupted"]);

export interface TaskActionView {
  id: string;
  step: number;
  at: string;
  tool: string;
  summary: string;
  status: "ok" | "failed" | "denied" | "cancelled" | "skipped";
  durationMs: number;
  error?: string;
  verified: boolean | null;
}

export interface TaskView {
  id: string;
  goal: string;
  state: TaskState;
  origin: string;
  modelId: string | null;
  currentStatus: string;
  plan: { summary: string; steps: Array<{ text: string; status: "pending" | "active" | "done" | "skipped" }> } | null;
  actions: TaskActionView[];
  files: Array<{ path: string; change: string; at: string }>;
  pendingQuestion: { id: string; text: string; options?: string[]; askedAt: string } | null;
  pendingConfirmation: { id: string; capability: string; description: string; askedAt: string } | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  result?: string | null;
  error?: string | null;
  steps?: number;
  sensitive?: boolean;
}

export type TaskAction = "stop" | "pause" | "resume" | "takeover" | "return" | "answer" | "continue";

// ---- confirmations & permissions --------------------------------------------------------

export interface ConfirmationRequest {
  id: string;
  taskId: string | null;
  capability: string;
  title: string;
  description: string;
  details: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  allowRemember: boolean;
}

export type Decision = "allow" | "ask" | "deny";
export type MessageConfirmationMode = "always_confirm" | "confirm_new_recipients" | "trusted_without_confirmation" | "never_without_preview";

export interface PermissionsView {
  policy: {
    capabilities: Record<string, { decision: Decision }>;
    messageConfirmation: MessageConfirmationMode;
  };
  info: Record<string, { label: string; description: string; risk: "low" | "medium" | "high" }>;
}

/** Mirrors permissions/types.ts LOCKED_TO_ASK: these never go below "ask". */
export const LOCKED_CAPABILITIES: ReadonlySet<string> = new Set(["EXECUTE_DOWNLOAD", "INSTALL_SOFTWARE", "PURCHASE", "ACCOUNT_CHANGE", "POWER_CONTROL"]);

// ---- models -----------------------------------------------------------------------------

export type ModelAvailability = "available" | "unverified" | "unavailable" | "not_configured" | "disabled";

export interface ModelView {
  id: string;
  displayName: string;
  provider: string;
  providerName: string;
  locality: "local" | "cloud";
  tier: "fast" | "balanced" | "deep";
  capabilities: { vision: boolean; tools: boolean; reasoning: boolean; liveAudio: boolean; structuredOutput: boolean; streaming: boolean; embedding: boolean };
  contextLength: number;
  description: string;
  availability: ModelAvailability;
}

export interface ModelSelection {
  brain: string;
  live: string;
  background: string;
  fallbackAllowed: boolean;
  offlineLocalFallback: boolean;
}

export interface ModelCatalogue {
  selection: ModelSelection;
  providers: Array<{ id: string; displayName: string; locality: string; enabled: boolean; configured: boolean; verificationError: string | null }>;
  models: ModelView[];
  usage?: { models: Record<string, { calls: number; failures: number; avgLatencyMs: number | null }> };
  health?: Record<string, { recentFailures: number; coolingDown: boolean }>;
  network?: string;
}

// ---- server-side settings (settings/appSettings.ts) -------------------------------------

export interface AppSettings {
  version: 3;
  onboardingComplete: boolean;
  behavior: {
    proactivity: "quiet" | "balanced" | "lively";
    awayCheckin: boolean;
    returnGreeting: boolean;
    awayAfterMin: number;
    dndManual: boolean;
    autoDndFullscreen: boolean;
    autoDndMeetings: boolean;
    autoDndRecording: boolean;
  };
  autonomy: { maxSteps: number; conflictWaitSec: number; emergencyShortcut: string; showTaskHud: boolean };
  voice: { voiceName: string; style: "natural" | "anime"; pitch: number; bargeIn: boolean; speakTaskUpdates: "all" | "important" | "none" };
  companion: {
    enabled: boolean;
    setupComplete: boolean;
    scale: number;
    fullscreenBehavior: "hide" | "notifications_only" | "always" | "game_aware";
    clickThrough: boolean;
    interactionLevel: "minimal" | "normal" | "playful";
    walkAround: boolean;
    iconPlay: boolean;
    standOut: number;
    hideAndPeek: boolean;
    [key: string]: unknown;
  };
  character: { activeCharacterId: string; eyeFollowCursor: boolean; headFollowCursor: boolean; idleVariety: number };
  graphics: { realism: number; quality: "auto" | "potato" | "low" | "balanced" | "high"; autoStep: number };
  physics: {
    enabled: boolean;
    quality: "low" | "balanced" | "high";
    secondaryMotion: number;
    gravityMultiplier: number;
    stiffness: number;
    damping: number;
    drag: number;
    collisionQuality: "off" | "low" | "high";
    wind: number;
    clothEnabled: boolean;
    clothLooseness: number;
  };
  privacy: { screenAwareness: boolean; cameraPresence: boolean; clipboardInContext: boolean };
  performance: { activeFps: number; idleFps: number; sleepFps: number; perceptionPollSec: number };
  developer: { debugView: boolean; physicsDebug: boolean; verboseLogs: boolean };
  updates: { mode: "auto" | "manual" };
}

/** Deep-partial patch accepted by POST /api/app-settings. */
export type AppSettingsPatch = { [K in keyof AppSettings]?: AppSettings[K] extends object ? Partial<AppSettings[K]> : AppSettings[K] };

// ---- characters -------------------------------------------------------------------------

export interface CharacterSummary {
  id: string;
  displayName: string;
  builtIn?: boolean;
  [key: string]: unknown;
}

// ---- fetch helpers ----------------------------------------------------------------------

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("ABxAG backend returned an invalid response.");
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error || `Request failed (${res.status}).`);
  return data as T;
}

export const api = {
  tasks: (limit = 20) => request<TaskView[]>("GET", `/api/tasks?limit=${limit}`),
  recoverableTasks: () => request<TaskView[]>("GET", "/api/tasks/recoverable"),
  startTask: (goal: string) => request<TaskView>("POST", "/api/tasks", { goal, origin: "text" }),
  taskAction: (id: string, action: TaskAction, text?: string) => request<unknown>("POST", `/api/tasks/${encodeURIComponent(id)}/${action}`, text === undefined ? {} : { text }),
  emergencyStop: () => request<{ stopped: number }>("POST", "/api/autonomy/stop", { reason: "stop_button" }),

  confirmations: () => request<ConfirmationRequest[]>("GET", "/api/confirmations"),
  resolveConfirmation: (id: string, approved: boolean, remember: "once" | "session" = "once") =>
    request<{ ok: boolean }>("POST", `/api/confirmations/${encodeURIComponent(id)}`, { approved, remember }),

  permissions: () => request<PermissionsView>("GET", "/api/permissions"),
  setPermission: (capability: string, decision: Decision) => request<unknown>("POST", `/api/permissions/${encodeURIComponent(capability)}`, { decision }),
  setMessageConfirmation: (mode: MessageConfirmationMode) => request<unknown>("POST", "/api/permissions/messaging", { mode }),

  models: () => request<ModelCatalogue>("GET", "/api/models"),
  selectModels: (patch: Partial<ModelSelection>) => request<ModelSelection>("POST", "/api/models/select", patch),
  testModel: (modelId: string) => request<{ ok?: boolean; latencyMs?: number; error?: string; [key: string]: unknown }>("POST", "/api/models/test", { modelId }),
  refreshModels: () => request<ModelCatalogue>("POST", "/api/models/refresh"),
  saveProviderKey: (providerId: string, apiKey: string) => request<{ ok: boolean }>("POST", `/api/providers/${encodeURIComponent(providerId)}/key`, { apiKey }),

  appSettings: () => request<AppSettings>("GET", "/api/app-settings"),
  updateAppSettings: (patch: AppSettingsPatch) => request<AppSettings>("POST", "/api/app-settings", patch),
  setDnd: (active: boolean) => request<unknown>("POST", "/api/dnd", { active }),

  characters: () => request<CharacterSummary[]>("GET", "/api/characters"),
};

export const AVAILABILITY_LABEL: Record<ModelAvailability, string> = {
  available: "Available",
  unverified: "Not yet checked",
  unavailable: "Not available on this key",
  not_configured: "Needs an API key",
  disabled: "Disabled",
};

