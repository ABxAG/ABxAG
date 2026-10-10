/**
 * ABxAG runtime: constructs and wires every subsystem added in this release
 * and exposes them to the HTTP server, the `/events` WebSocket, the Gemini
 * Live voice session and the Electron main process.
 *
 * server.ts stays responsible for the voice session itself; this module owns
 * models, the autonomous agent, permissions, presence/conversation policy,
 * social state, utilities and their APIs.
 */
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import type { WebSocket } from "ws";
import { ActionExecutor } from "../agent/actions/executor";
import { AuditLog } from "../agent/audit";
import { rootScope } from "../agent/cancellation";
import { DownloadManager } from "../agent/downloads";
import { TaskManager } from "../agent/loop";
import { PerceptionEngine, type AgentCall } from "../agent/perception/engine";
import { voicePrompt, type TaskEventKind } from "../agent/personality";
import { InputArbiter, ResourceScheduler } from "../agent/scheduler";
import { publicTaskView, TaskStore, TERMINAL_STATES } from "../agent/taskSession";
import { UtilityScheduler, type UtilityFired } from "../companion/utilities";
import { ContactBook } from "../memory/contacts";
import { WorkingMemory } from "../memory/workingMemory";
import { ModelRegistry } from "../models/registry";
import { ModelRouter } from "../models/router";
import { ModelError } from "../models/types";
import * as native from "../native/win32";
import { ConfirmationBroker } from "../permissions/confirmations";
import { PermissionEngine } from "../permissions/engine";
import { CAPABILITY_INFO, type Capability, type Decision, type MessageConfirmationMode } from "../permissions/types";
import { ConversationPresenceEngine, type ProactiveReason, type Priority } from "../presence/conversationPresence";
import { SocialState } from "../presence/socialState";
import { UserPresenceEngine } from "../presence/userPresence";
import { AppSettingsStore, type AppSettings } from "../settings/appSettings";
import { appEvents, type AppEvent } from "../shared/appEvents";
import { createLogger, logHub } from "../shared/logger";
import { CharacterLibrary } from "./characterLibrary";
import { PoseStore } from "./poseStore";

const log = createLogger("runtime");

export interface LiveVoiceHook {
  id: string;
  /** Send a private context turn that the Live model voices in persona. */
  say: (prompt: string) => void;
  /** Stop current speech output immediately. */
  interrupt: () => void;
}

export interface RuntimeOptions {
  dataDir: string;
  callAgent: AgentCall;
  getSecret: (name: string) => string | undefined;
  setSecret: (name: string, value: string) => void;
  /** Persist a durable memory (cognition structured memory). */
  remember: (content: string, kind: "preference" | "semantic" | "episodic", importance: number) => Promise<void>;
  recall: (query: string, limit: number) => Promise<string[]>;
  /** Extra emergency-stop hooks (legacy tool executor, etc.). */
  onEmergencyStop?: (reason: string) => void;
  /** Ask the Electron main process to do something (notification, companion). */
  sendToShell?: (message: Record<string, unknown>) => void;
  legacySettings?: Record<string, unknown>;
}

const MEETING_PROCESS = /^(zoom|teams|ms-teams|webex|skype|slack)\b/i;
const MEETING_TITLE = /(zoom meeting|google meet|meet - |microsoft teams meeting|webex meeting)/i;
const RECORDING_PROCESS = /^(obs64|obs32|obs|streamlabs|xsplit)/i;
const MEDIA_TITLE = /(youtube|netflix|prime video|hotstar|twitch|vlc|media player|movies & tv|\.mp4|\.mkv)/i;

export class ABxAGRuntime {
  readonly settings: AppSettingsStore;
  readonly registry: ModelRegistry;
  readonly router: ModelRouter;
  readonly permissions: PermissionEngine;
  readonly confirmations = new ConfirmationBroker();
  readonly tasks: TaskStore;
  readonly scheduler = new ResourceScheduler();
  readonly arbiter = new InputArbiter();
  readonly perception: PerceptionEngine;
  readonly downloads: DownloadManager;
  readonly contacts: ContactBook;
  readonly working = new WorkingMemory();
  readonly audit: AuditLog;
  readonly executor: ActionExecutor;
  readonly manager: TaskManager;
  readonly presence = new UserPresenceEngine();
  readonly conversation = new ConversationPresenceEngine();
  readonly social = new SocialState();
  readonly utilities: UtilityScheduler;
  readonly poses: PoseStore;
  readonly characters: CharacterLibrary;
  private readonly live = new Map<string, LiveVoiceHook>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly eventSockets = new Set<WebSocket>();
  private currentSettings: AppSettings;
  private shellPids: number[] = [];
  private lastForegroundTitle = "";
  private missedUtilities: UtilityFired[] = [];

  constructor(private readonly options: RuntimeOptions) {
    const dataDir = options.dataDir;
    this.settings = new AppSettingsStore(dataDir);
    this.currentSettings = this.settings.get();
    this.registry = new ModelRegistry(dataDir, options.getSecret);
    this.router = new ModelRouter(this.registry);
    this.permissions = new PermissionEngine(dataDir);
    this.tasks = new TaskStore({ dataDir });
    this.perception = new PerceptionEngine(options.callAgent, this.router);
    this.downloads = new DownloadManager(dataDir, async () => {
      const response = await options.callAgent("knownFolder", { name: "downloads" });
      const result = response.result as { path?: string } | undefined;
      if (response.ok && result?.path) return result.path;
      return path.join(process.env.USERPROFILE || process.env.HOME || dataDir, "Downloads");
    });
    this.contacts = new ContactBook(dataDir);
    this.audit = new AuditLog(dataDir);
    this.executor = new ActionExecutor({
      call: options.callAgent,
      perception: this.perception,
      permissions: this.permissions,
      confirmations: this.confirmations,
      scheduler: this.scheduler,
      arbiter: this.arbiter,
      downloads: this.downloads,
      contacts: this.contacts,
      audit: this.audit,
      remember: (fact, kind) => options.remember(fact, kind === "preference" ? "preference" : "semantic", 0.7),
      notify: (title, body) => this.notify(title, body),
      conflictWaitMs: this.currentSettings.autonomy.conflictWaitSec * 1000,
    });
    this.manager = new TaskManager({
      store: this.tasks,
      executor: this.executor,
      perception: this.perception,
      router: this.router,
      call: options.callAgent,
      scheduler: this.scheduler,
      arbiter: this.arbiter,
      confirmations: this.confirmations,
      permissions: this.permissions,
      contacts: this.contacts,
      working: this.working,
      audit: this.audit,
      recall: (query) => options.recall(query, 6),
      rememberEpisode: (text, importance) => options.remember(text, "episodic", importance),
      speak: (kind, line, facts, priority) => this.speakTaskEvent(kind, line, facts, priority),
      onEmergencyStop: (reason) => {
        for (const hook of this.live.values()) hook.interrupt();
        options.onEmergencyStop?.(reason);
      },
      maxSteps: this.currentSettings.autonomy.maxSteps,
    });
    this.utilities = new UtilityScheduler(dataDir, (event) => this.onUtilityFired(event));
    this.poses = new PoseStore(dataDir);
    this.characters = new CharacterLibrary();
  }

  async initialize(): Promise<void> {
    logHub.configure(path.join(this.options.dataDir, "logs"), this.currentSettings.developer.verboseLogs ? "debug" : "info");
    this.currentSettings = await this.settings.initialize(this.options.legacySettings);
    await Promise.all([
      this.registry.initialize(),
      this.permissions.initialize(),
      this.tasks.initialize(),
      this.downloads.initialize(),
      this.contacts.initialize(),
      this.poses.initialize(),
    ]);
    this.missedUtilities = await this.utilities.initialize();
    this.applySettings(this.currentSettings);
    this.settings.onChange((settings, previous) => {
      this.currentSettings = settings;
      this.applySettings(settings, previous);
      appEvents.publish("model.status", { kind: "settings_changed" });
    });

    // ---- state fan-out ---------------------------------------------------------
    this.tasks.subscribe((session, change) => {
      appEvents.publish(change === "finished" ? "task.finished" : "task.updated", publicTaskView(session));
      const running = this.tasks.active().some((item) => !TERMINAL_STATES.has(item.state));
      this.conversation.setTaskRunning(running);
      if (change === "created") this.social.event("task_started");
      if (change === "finished") this.social.event(session.state === "completed" ? "task_succeeded" : "task_failed");
    });
    this.presence.onChange((change) => {
      this.conversation.updatePresence(this.presence.snapshot(), change);
      appEvents.publish("presence.changed", { ...this.presence.snapshot(), change });
      if (change.returned) {
        this.social.event("user_returned");
        if (this.conversation.shouldGreetReturn(change)) {
          this.speakDiscretionary("user_returned", "normal", "The user just came back after being away. Give at most a short, warm one-line welcome back — no questions about where they were.", "Aa gaye?");
        }
      }
    });
    this.conversation.onStateChange((state) => {
      this.social.setContext(this.presence.snapshot().state, state);
      appEvents.publish("conversation.changed", this.conversation.snapshot());
    });
    this.social.onChange((state) => appEvents.publish("social.changed", state));
    // The agent is blocked on these; if ABxAG's window is hidden the shell raises a notification.
    appEvents.subscribe((event) => {
      if (event.type === "confirmation.requested") {
        const request = event.payload as { title?: string };
        this.options.sendToShell?.({ type: "attention", title: "ABxAG needs your approval", body: String(request.title || "A task is waiting for you.").slice(0, 200) });
      } else if (event.type === "question.asked") {
        const asked = event.payload as { question?: string };
        this.options.sendToShell?.({ type: "attention", title: "ABxAG has a question", body: String(asked.question || "A task is waiting for your answer.").slice(0, 200) });
      }
    });
    this.registry.onSelectionChange((selection) => appEvents.publish("model.changed", selection));
    this.router.network.onChange((state) => {
      appEvents.publish("model.status", { kind: "network", state });
      if (state === "offline") this.notify("Offline", "ABxAG can't reach cloud models right now.");
    });
    this.arbiter.onPhysicalInput((sample) => this.presence.recordInput(sample.at));
    this.arbiter.setOsIdleProbe(async () => native.idleMs());

    // ---- periodic, cheap ticks --------------------------------------------------
    this.every(2_000, () => this.presenceTick());
    this.every(3_000, () => this.contextTick());
    this.every(15_000, () => this.social.tick());
    this.every(5 * 60_000, () => void this.registry.refreshAvailability().catch(() => {}));
    void this.registry.refreshAvailability().catch(() => {});

    for (const missed of this.missedUtilities) {
      appEvents.publish("utility.fired", { ...missed.utility, missed: true });
    }
    const recoverable = this.tasks.peekRecoverable();
    if (recoverable.length) {
      appEvents.publish("notification", {
        id: "recoverable-tasks",
        title: "Unfinished task",
        body: `"${recoverable[0].goal}" was interrupted. You can continue it from the task panel — I'll re-check the screen first.`,
        taskId: recoverable[0].id,
      });
    }
    log.info("runtime initialized", { models: this.registry.allModels().length, recoverable: recoverable.length });
  }

  private every(ms: number, fn: () => void): void {
    const timer = setInterval(() => {
      try {
        fn();
      } catch (error) {
        log.warn("tick failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  private applySettings(settings: AppSettings, previous?: AppSettings): void {
    this.manager.setMaxSteps(settings.autonomy.maxSteps);
    this.executor.setConflictWaitMs(settings.autonomy.conflictWaitSec * 1000);
    this.conversation.configure({
      level: settings.behavior.proactivity,
      awayCheckinEnabled: settings.behavior.awayCheckin,
      returnGreetingEnabled: settings.behavior.returnGreeting,
    });
    this.conversation.setDnd(settings.behavior.dndManual);
    this.presence.setThresholds({ likelyAwayAfterMs: settings.behavior.awayAfterMin * 60_000, awayAfterMs: settings.behavior.awayAfterMin * 2.4 * 60_000 });
    if (!previous || previous.behavior.dndManual !== settings.behavior.dndManual) {
      appEvents.publish("dnd.changed", this.conversation.dnd);
    }
    this.options.sendToShell?.({ type: "settings", settings });
  }

  // ---- presence & context ------------------------------------------------------------

  private presenceTick(): void {
    if (!this.arbiter.hasRawInput) {
      const idle = native.idleMs();
      if (idle !== null) this.presence.recordOsIdle(idle);
    }
    const snapshot = this.presence.tick();
    this.conversation.updatePresence(snapshot);
    if (snapshot.state === "LIKELY_AWAY" && this.live.size) {
      this.speakDiscretionary("away_checkin", "low", "The user went quiet in the middle of a conversation and has not touched the PC for several minutes. Say ONE short, light Hinglish check-in (for example asking where they went). Do not repeat it later, do not ask anything else.", "Kaha gaye yaar?");
    }
  }

  private contextTick(): void {
    if (!native.nativeAvailable()) return;
    const { fullscreen, window } = native.foregroundFullscreen(this.shellPids);
    const title = window?.title || "";
    const processName = (window?.process || "").replace(/\.exe$/i, "");
    const settings = this.currentSettings.behavior;
    let auto: string | null = null;
    if (settings.autoDndFullscreen && fullscreen) auto = `fullscreen: ${processName || "app"}`;
    else if (settings.autoDndMeetings && (MEETING_PROCESS.test(processName) && /meeting|call/i.test(title) || MEETING_TITLE.test(title))) auto = "meeting";
    else if (settings.autoDndRecording && native.listWindows(80).some((w) => RECORDING_PROCESS.test((w.process || "").replace(/\.exe$/i, "")))) auto = "recording software open";
    const before = this.conversation.dnd.auto;
    this.conversation.setAutoDnd(auto);
    if (before !== auto) appEvents.publish("dnd.changed", this.conversation.dnd);
    this.options.sendToShell?.({ type: "foreground", fullscreen, process: processName, title: title.slice(0, 200), hwnd: window?.hwnd || 0 });
    if (MEDIA_TITLE.test(title)) this.presence.noteMediaActivity(15_000);
    if (title && title !== this.lastForegroundTitle) {
      this.lastForegroundTitle = title;
      this.working.noteReferent({ kind: "window", label: title.slice(0, 200), value: title.slice(0, 200), source: "screen", salience: 0.35 });
    }
  }

  // ---- speech policy -------------------------------------------------------------------

  private speakTaskEvent(kind: TaskEventKind, line: string, facts: string, priority: "low" | "normal" | "high"): void {
    const reason: ProactiveReason = kind === "need_confirmation" || kind === "question" || kind === "login_required" ? "task_needs_user"
      : kind === "done" ? "task_completed" : kind === "failed" ? "task_failed" : "task_completed";
    const mode = this.currentSettings.voice.speakTaskUpdates;
    const important = ["need_confirmation", "question", "done", "failed", "login_required", "stopped"].includes(kind);
    const wantsVoice = mode === "all" || (mode === "important" && important);
    const verdict = this.conversation.request({ reason, priority: priority === "high" ? "high" : "normal", text: line, key: `task:${kind}` });
    appEvents.publish("speech.say", { text: line, kind, channel: verdict.allowed && wantsVoice ? verdict.channel : "visual" });
    if (!verdict.allowed || verdict.channel !== "voice" || !wantsVoice) return;
    const hook = [...this.live.values()].at(-1);
    hook?.say(voicePrompt(kind, line, facts));
  }

  /** Discretionary (self-initiated) speech; everything goes through the presence gate. */
  speakDiscretionary(reason: ProactiveReason, priority: Priority, instruction: string, fallbackText: string, key?: string): boolean {
    const verdict = this.conversation.request({ reason, priority, key, text: fallbackText });
    if (!verdict.allowed) return false;
    const hook = [...this.live.values()].at(-1);
    if (verdict.channel === "voice" && hook) {
      hook.say(["PRIVATE CONTEXT — not something the user said.", instruction, "Speak only the final line; never mention this context."].join("\n"));
    } else {
      appEvents.publish("speech.say", { text: fallbackText, kind: reason, channel: "visual" });
    }
    return true;
  }

  /** Gate used by the legacy cognition initiative path in server.ts. */
  allowCognitiveSpeech(eventType: string, decision: string): boolean {
    const reason: ProactiveReason = decision === "WARN" ? "critical_warning"
      : eventType === "internal.unfinished_topic" || eventType.startsWith("internal.conversation") ? "conversation_continuation"
        : eventType === "internal.visual_context_changed" ? "visual_event"
          : /download_completed/.test(eventType) ? "download_finished"
            : "casual";
    return this.conversation.request({ reason, priority: decision === "WARN" ? "high" : "low", key: eventType }).allowed;
  }

  // ---- live voice hooks --------------------------------------------------------------

  attachLive(hook: LiveVoiceHook): () => void {
    this.live.set(hook.id, hook);
    return () => this.live.delete(hook.id);
  }

  onUserSpeech(event: "start" | "stop"): void {
    if (event === "start") {
      this.conversation.userStartedSpeaking();
      this.presence.recordVoice();
      this.social.event("interaction");
    } else {
      this.conversation.userStoppedSpeaking();
    }
  }

  onUserTurn(text: string): void {
    this.conversation.userTurn();
    this.presence.recordVoice();
    this.working.noteUtterance("user", text);
    this.social.event("interaction");
  }

  onABxAGSpeech(speaking: boolean, text?: string): void {
    this.conversation.abxagSpeakingChanged(speaking);
    if (text) this.working.noteUtterance("abxag", text);
  }

  /** "ABxAG stop" / Stop button / shortcut: halt every autonomous activity. */
  emergencyStop(reason: string): number {
    const count = this.manager.stopAll(reason);
    rootScope.cancelChildren(reason);
    this.audit.record(null, "system", `Emergency stop (${reason})`);
    return count;
  }

  // ---- Electron main-process messages ------------------------------------------------

  handleShellMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "input.physical":
        this.arbiter.recordPhysicalInput({
          kind: message.kind === "keyboard" ? "keyboard" : "mouse",
          at: Number(message.at) || Date.now(),
          distance: Number(message.distance) || 0,
        });
        break;
      case "power":
        if (message.event === "lock-screen" || message.event === "suspend") this.presence.setSessionLocked(true);
        if (message.event === "unlock-screen" || message.event === "resume") this.presence.setSessionLocked(false);
        break;
      case "shortcut.emergency-stop":
        this.emergencyStop("keyboard_shortcut");
        break;
      case "shell.pids":
        this.shellPids = Array.isArray(message.pids) ? message.pids.map(Number).filter(Number.isFinite) : [];
        break;
      case "companion.interaction":
        if (message.kind === "poke" || message.kind === "head_pat") this.social.event("poked");
        else this.social.event("interaction");
        break;
      default:
        break;
    }
  }

  /** Ask the desktop companion to do something (voice: "put the icons back", "come here"…). */
  companionCommand(command: string): boolean {
    if (!this.options.sendToShell) return false;
    this.options.sendToShell({ type: "companion", command });
    return true;
  }

  /**
   * Direct the main-stage 3D character (voice: "jump", "change character",
   * "make your dress red"). Fanned out to every window over /events; the
   * main window performs it on the live CharacterSystem.
   */
  characterCommand(command: { kind: "action"; action: string; target?: "stage" | "companion" | "both" } | { kind: "switch"; id: string } | { kind: "outfit"; cloth?: string | null; hair?: string | null; target?: "stage" | "companion" | "both" }): boolean {
    appEvents.publish("character.command", command);
    return true;
  }

  private notify(title: string, body: string): void {
    appEvents.publish("notification", { id: `${Date.now()}`, title, body });
    this.options.sendToShell?.({ type: "notify", title, body });
  }

  private onUtilityFired(event: UtilityFired): void {
    const utility = event.utility;
    this.social.event("alarm");
    appEvents.publish("utility.fired", { ...utility, missed: event.missed });
    appEvents.publish("character.cue", { cue: "alarm", label: utility.label });
    this.notify(utility.kind === "timer" ? "Timer done" : utility.kind === "alarm" ? "Alarm" : "Reminder", utility.label);
    const verdict = this.conversation.request({ reason: utility.kind === "reminder" ? "reminder" : "alarm", priority: utility.kind === "alarm" ? "critical" : "high", key: `utility:${utility.id}:${utility.dueAt}` });
    const hook = [...this.live.values()].at(-1);
    if (verdict.allowed && verdict.channel === "voice" && hook) {
      hook.say(voicePrompt("done", utility.kind === "reminder" ? `Yaad dilana tha: ${utility.label}` : `${utility.label} — time ho gaya!`, `${utility.kind} "${utility.label}" is due now.`));
    }
  }

  // ---- /events WebSocket ----------------------------------------------------------------

  handleEventsSocket(socket: WebSocket): void {
    this.eventSockets.add(socket);
    const send = (event: AppEvent) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    };
    send({ type: "presence.changed", at: new Date().toISOString(), payload: this.presence.snapshot() });
    send({ type: "conversation.changed", at: new Date().toISOString(), payload: this.conversation.snapshot() });
    send({ type: "social.changed", at: new Date().toISOString(), payload: this.social.snapshot() });
    send({ type: "model.changed", at: new Date().toISOString(), payload: this.registry.getSelection() });
    send({ type: "dnd.changed", at: new Date().toISOString(), payload: this.conversation.dnd });
    for (const session of this.tasks.active()) send({ type: "task.updated", at: session.updatedAt, payload: publicTaskView(session) });
    for (const request of this.confirmations.list()) send({ type: "confirmation.requested", at: request.createdAt, payload: request });
    const unsubscribe = appEvents.subscribe((event) => {
      if (event.type === "debug.log" && !this.currentSettings.developer.debugView) return;
      send(event);
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        if (message.type === "companion.interaction") this.handleShellMessage(message);
        if (message.type === "ui.activity") this.presence.recordInput();
      } catch {
        /* ignore malformed client messages */
      }
    });
    socket.on("close", () => {
      unsubscribe();
      this.eventSockets.delete(socket);
    });
  }

  // ---- REST API ---------------------------------------------------------------------------

  registerRoutes(app: Express): void {
    const wrap = (handler: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
      try {
        const result = await handler(req, res);
        if (!res.headersSent) res.json(result ?? { ok: true });
      } catch (error) {
        const declared = (error as { status?: number })?.status;
        const status = error instanceof ModelError ? 502 : typeof declared === "number" ? declared : 400;
        if (!res.headersSent) res.status(status).json({ error: error instanceof ModelError ? error.userMessage : error instanceof Error ? error.message : String(error) });
      }
    };

    app.use("/user-characters", express.static(this.characters.root, { fallthrough: true, index: false, dotfiles: "deny" }));

    // models
    app.get("/api/models", wrap(() => ({
      ...this.registry.publicCatalogue(),
      network: this.router.network.current,
      usage: this.router.usage.snapshot(),
      limits: this.router.limiter.snapshot(),
      health: this.router.healthSnapshot(),
    })));
    app.post("/api/models/select", wrap(async (req) => {
      const selection = await this.registry.setSelection(req.body || {});
      appEvents.publish("character.cue", { cue: "brain_switch" });
      return selection;
    }));
    app.post("/api/models/test", wrap((req) => this.router.test(String(req.body?.modelId || ""))));
    app.post("/api/models/refresh", wrap(async () => {
      await this.registry.refreshAvailability();
      return this.registry.publicCatalogue();
    }));
    app.post("/api/models/custom", wrap(async (req) => {
      const definition = req.body?.definition;
      if (!definition?.id || !definition?.provider || !definition?.modelName) throw new Error("id, provider and modelName are required.");
      await this.registry.saveUserModel(definition);
      return this.registry.publicCatalogue();
    }));
    app.post("/api/providers/:id/key", wrap((req) => {
      const provider = this.registry.getProviderConfig(String(req.params.id));
      if (!provider?.secretName) throw new Error("Unknown provider or provider does not use a key.");
      const key = String(req.body?.apiKey || "").trim();
      if (!key) throw new Error("API key is required.");
      this.options.setSecret(provider.secretName, key);
      return { ok: true, configured: true };
    }));

    // tasks
    app.get("/api/tasks", wrap((req) => this.tasks.list(Number(req.query.limit) || 30).map(publicTaskView)));
    app.get("/api/tasks/recoverable", wrap(() => this.tasks.peekRecoverable().map(publicTaskView)));
    app.get("/api/tasks/:id", wrap((req) => {
      const session = this.tasks.get(String(req.params.id));
      if (!session) throw new Error("Task not found.");
      return publicTaskView(session);
    }));
    app.post("/api/tasks", wrap((req) => {
      const goal = String(req.body?.goal || "").trim();
      if (!goal) throw new Error("goal is required.");
      return publicTaskView(this.manager.start(goal, req.body?.origin === "voice" ? "voice" : "text"));
    }));
    app.post("/api/tasks/:id/:action", wrap((req) => {
      const id = String(req.params.id);
      switch (req.params.action) {
        case "stop": return { ok: this.manager.stop(id) };
        case "pause": return { ok: this.manager.pause(id) };
        case "resume": return { ok: this.manager.resume(id) };
        case "takeover": return { ok: this.manager.takeOver(id) };
        case "return": return { ok: this.manager.returnControl(id) };
        case "answer": return { ok: this.manager.answer(id, String(req.body?.text || "")) };
        case "continue": return publicTaskView(this.manager.continueInterrupted(id));
        default: throw new Error("Unknown task action.");
      }
    }));
    app.post("/api/autonomy/stop", wrap((req) => ({ stopped: this.emergencyStop(String(req.body?.reason || "stop_button")) })));

    // confirmations & permissions
    app.get("/api/confirmations", wrap(() => this.confirmations.list()));
    app.post("/api/confirmations/:id", wrap((req) => ({
      ok: this.confirmations.resolve(String(req.params.id), { approved: req.body?.approved === true, remember: req.body?.remember === "session" ? "session" : "once", via: "ui" }),
    })));
    app.get("/api/permissions", wrap(() => ({ policy: this.permissions.getPolicy(), info: CAPABILITY_INFO })));
    app.post("/api/permissions/messaging", wrap(async (req) => {
      await this.permissions.setMessageConfirmation(String(req.body?.mode) as MessageConfirmationMode);
      return this.permissions.getPolicy();
    }));
    app.post("/api/permissions/trusted", wrap(async (req) => {
      await this.permissions.setTrustedContact(String(req.body?.contactId || ""), req.body?.trusted === true);
      return this.permissions.getPolicy();
    }));
    app.post("/api/permissions/:capability", wrap((req) => this.permissions.setDecision(String(req.params.capability) as Capability, String(req.body?.decision) as Decision)));

    // contacts
    app.get("/api/contacts", wrap(() => this.contacts.list()));
    app.post("/api/contacts", wrap((req) => this.contacts.upsert(req.body || {})));
    app.delete("/api/contacts/:id", wrap(async (req) => ({ ok: await this.contacts.remove(String(req.params.id)) })));

    // desktop companion: icon positions for her icon game (local Shell API,
    // no file or Explorer changes beyond an icon's position)
    app.get("/api/companion/icons", wrap(async () => {
      const response = await this.options.callAgent("desktopIcons", {});
      if (!response.ok) throw new Error(response.error || "Desktop icons are unavailable.");
      return response.result;
    }));
    app.post("/api/companion/command", wrap((req) => {
      const command = String(req.body?.command || "");
      if (!["come_here", "restore_icons", "sit", "stand", "stretch", "wave", "hide", "play_with_icons"].includes(command)) throw new Error("Unknown companion command.");
      return { ok: this.companionCommand(command) };
    }));
    app.post("/api/companion/icons/move", wrap(async (req) => {
      const name = String(req.body?.name || "");
      const x = Math.round(Number(req.body?.x));
      const y = Math.round(Number(req.body?.y));
      if (!name || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("name, x and y are required.");
      const response = await this.options.callAgent("moveDesktopIcon", { name, x, y });
      if (!response.ok) throw new Error(response.error || "Could not move the icon.");
      return response.result;
    }));

    // settings & presence
    app.get("/api/app-settings", wrap(() => this.settings.get()));
    app.post("/api/app-settings", wrap((req) => this.settings.update(req.body || {})));
    app.get("/api/presence", wrap(() => ({ presence: this.presence.snapshot(), conversation: this.conversation.snapshot(), social: this.social.snapshot() })));
    app.post("/api/dnd", wrap(async (req) => {
      await this.settings.update({ behavior: { dndManual: req.body?.active === true } });
      return this.conversation.dnd;
    }));

    // utilities
    app.get("/api/utilities", wrap(() => this.utilities.list()));
    app.post("/api/utilities", wrap((req) => this.utilities.add(req.body || {})));
    app.delete("/api/utilities/:id", wrap(async (req) => ({ ok: await this.utilities.cancel(String(req.params.id)) })));
    app.post("/api/utilities/:id/dismiss", wrap(async (req) => { await this.utilities.dismiss(String(req.params.id)); return { ok: true }; }));
    app.post("/api/utilities/:id/snooze", wrap(async (req) => { await this.utilities.snooze(String(req.params.id), Number(req.body?.minutes) || 5); return { ok: true }; }));

    // history
    app.get("/api/audit", wrap((req) => this.audit.recent(Number(req.query.limit) || 200, typeof req.query.taskId === "string" ? req.query.taskId : undefined)));
    app.get("/api/downloads", wrap(() => this.downloads.list()));

    // character
    app.get("/api/characters", wrap(() => this.characters.list()));
    app.get("/api/characters/:id", wrap((req) => this.characters.get(String(req.params.id))));
    app.patch("/api/characters/:id", wrap((req) => this.characters.update(String(req.params.id), req.body || {})));
    app.delete("/api/characters/:id", wrap(async (req) => ({ ok: await this.characters.remove(String(req.params.id)) })));
    app.post("/api/characters/import", wrap(async (req) => {
      const body = req.body || {};
      const result = await this.characters.import(String(body.source || ""), {
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        modelFile: typeof body.modelFile === "string" ? body.modelFile : undefined,
        id: typeof body.id === "string" ? body.id : undefined,
      });
      this.audit.record(null, "system", `Imported character ${result.profile.displayName}`, { id: result.profile.id, replaced: result.replaced });
      return { profile: result.profile, warnings: result.warnings, replaced: result.replaced };
    }));
    app.post("/api/characters/:id/tests", wrap((req) => this.characters.recordTests(String(req.params.id), (req.body || {}).results || {})));
    app.get("/api/poses", wrap((req) => this.poses.list(typeof req.query.characterId === "string" ? req.query.characterId : undefined)));
    app.post("/api/poses", wrap((req) => this.poses.save(req.body || {})));
    app.delete("/api/poses/:id", wrap(async (req) => ({ ok: await this.poses.remove(String(req.params.id)) })));

    // developer view
    app.get("/api/debug/state", wrap(() => {
      const latest = this.perception.latest;
      return {
        task: this.manager.status(),
        activeTasks: this.tasks.active().map(publicTaskView),
        perception: latest ? {
          capturedAt: latest.capturedAt,
          activeWindow: latest.activeWindow,
          browser: latest.browser,
          change: latest.change,
          notes: latest.notes,
          timings: latest.timings,
          elementCount: latest.elements.length,
          formatted: PerceptionEngineFormat(latest),
        } : null,
        perceptionStats: this.perception.stats,
        models: { selection: this.registry.getSelection(), usage: this.router.usage.snapshot(), limits: this.router.limiter.snapshot(), health: this.router.healthSnapshot(), network: this.router.network.current },
        scheduler: { leases: this.scheduler.status(), queue: this.scheduler.queueLength },
        input: this.arbiter.status(),
        presence: this.presence.snapshot(),
        conversation: this.conversation.snapshot(),
        social: this.social.snapshot(),
        confirmations: this.confirmations.list(),
        working: this.working.snapshot(),
        logs: logHub.recent(120),
      };
    }));
  }

  shutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.utilities.dispose();
    void this.tasks.flush();
  }
}

function PerceptionEngineFormat(state: NonNullable<PerceptionEngine["latest"]>): string {
  return PerceptionEngine.format(state, { maxElements: 80 });
}


