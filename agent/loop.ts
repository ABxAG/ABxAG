/**
 * The autonomous task loop.
 *
 *   PERCEIVE → UNDERSTAND → PLAN → ACT → OBSERVE → VERIFY → continue/recover/finish
 *
 * Every step starts from a fresh observation; plans are hypotheses revised
 * each step; every action's effect is checked in the next observation (and
 * deterministically where possible); failures go through the recovery
 * engine with bounded budgets. Each task runs in its own cancellation scope
 * under the process root, so Stop aborts planning, model calls, actions,
 * waits, downloads and confirmations at once.
 */
import type { ContactBook } from "../memory/contacts";
import type { WorkingMemory } from "../memory/workingMemory";
import type { ModelRouter } from "../models/router";
import { ModelError } from "../models/types";
import type { ConfirmationBroker } from "../permissions/confirmations";
import type { PermissionEngine } from "../permissions/engine";
import { appEvents } from "../shared/appEvents";
import { createLogger } from "../shared/logger";
import { summarizeArgs } from "../shared/redact";
import type { ActionExecutor, ActionResult } from "./actions/executor";
import type { AuditLog } from "./audit";
import { CancellationScope, isCancelledError, rootScope } from "./cancellation";
import { PerceptionEngine, type AgentCall, type DesktopState } from "./perception/engine";
import { PersonalityVoice, type TaskEventKind } from "./personality";
import { StepPlanner } from "./planner/stepPlanner";
import { RecoveryEngine, type RecoveryAdvice } from "./recovery";
import { resolveReferences, type ResolvedReference } from "./references";
import type { InputArbiter, ResourceScheduler } from "./scheduler";
import { TERMINAL_STATES, type TaskSession, type TaskStore } from "./taskSession";

const log = createLogger("agent.loop");

export interface TaskManagerDeps {
  store: TaskStore;
  executor: ActionExecutor;
  perception: PerceptionEngine;
  router: ModelRouter;
  call: AgentCall;
  scheduler: ResourceScheduler;
  arbiter: InputArbiter;
  confirmations: ConfirmationBroker;
  permissions: PermissionEngine;
  contacts: ContactBook;
  working: WorkingMemory;
  audit: AuditLog;
  /** Retrieve a few relevant long-term memories for a query. */
  recall: (query: string) => Promise<string[]>;
  /** Persist an episodic memory about a finished task. */
  rememberEpisode: (text: string, importance: number) => Promise<void>;
  /** Voice/bubble a task event in ABxAG's persona (gated by presence/DND upstream). */
  speak: (kind: TaskEventKind, line: string, facts: string, priority: "low" | "normal" | "high") => void;
  /** Extra stop hooks (legacy tool executor, TTS, browser ops). */
  onEmergencyStop?: (reason: string) => void;
  maxSteps?: number;
  maxDurationMs?: number;
}

interface Control {
  scope: CancellationScope;
  /** Notes injected into the first planning step (e.g. crash recovery). */
  preface: string[];
  paused: boolean;
  takeover: boolean;
  resumeWaiters: Array<() => void>;
  answer: ((text: string) => void) | null;
}

export class TaskManager {
  private readonly controls = new Map<string, Control>();
  private readonly queue: string[] = [];
  private running: string | null = null;
  private readonly planner: StepPlanner;
  private readonly voice = new PersonalityVoice();

  constructor(private readonly deps: TaskManagerDeps) {
    this.planner = new StepPlanner(deps.router);
  }

  /** Applied to tasks started after the user changes the setting. */
  setMaxSteps(steps: number): void {
    this.deps.maxSteps = steps;
  }

  get activeTaskId(): string | null {
    return this.running;
  }

  /** Create a task and start it (or queue it behind the running one). */
  start(goal: string, origin: TaskSession["origin"], options: { sensitive?: boolean; preface?: string[] } = {}): TaskSession {
    const trimmed = goal.trim();
    if (!trimmed) throw new Error("A task goal is required.");
    const sensitive = options.sensitive ?? /(send|bhej|whatsapp|message|mail|delete|hata|install|buy|order|pay|password|account)/i.test(trimmed);
    const session = this.deps.store.create({ goal: trimmed, origin, modelId: this.deps.router.registry.getSelection().brain, sensitive });
    this.controls.set(session.id, { scope: rootScope.child(`task:${session.id}`), preface: options.preface || [], paused: false, takeover: false, resumeWaiters: [], answer: null });
    this.deps.audit.record(session.id, "task.started", `Request: ${trimmed}`);
    this.deps.working.noteUtterance("user", trimmed);
    this.queue.push(session.id);
    void this.pump();
    return session;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = next;
    try {
      await this.run(next);
    } catch (error) {
      log.error("task crashed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.controls.get(next)?.scope.dispose();
      this.controls.delete(next);
      this.running = null;
      this.deps.working.activeTaskId = null;
      void this.pump();
    }
  }

  /**
   * Run ONE well-defined action as a task, without the planner: "message
   * Papa hi on WhatsApp" is a single deterministic step (open the person's
   * chat, type, send, verify). It still goes through permissions, the audit
   * log, the duplicate-send guard and the task panel, and takes seconds
   * instead of a model round-trip per step.
   */
  runDirect(goal: string, action: { tool: string; args: Record<string, unknown> }, origin: TaskSession["origin"], recipient?: { name: string; contactId: string | null }): TaskSession {
    const session = this.deps.store.create({ goal, origin, modelId: "direct", sensitive: true });
    const control: Control = { scope: rootScope.child(`task:${session.id}`), preface: [], paused: false, takeover: false, resumeWaiters: [], answer: null };
    this.controls.set(session.id, control);
    const scope = control.scope;
    this.deps.audit.record(session.id, "task.started", `Request: ${goal}`);
    void (async () => {
      try {
        let current = action;
        for (let attempt = 1; attempt <= 3; attempt++) {
          this.deps.store.transition(session.id, "running", this.deps.executor.definition(current.tool)?.progress(current.args) || "Working…");
          const result = await this.deps.executor.execute(current, {
            taskId: session.id, goal, state: null, scope, recipient: recipient ?? null,
            onStatus: (text) => this.deps.store.setStatus(session.id, text),
            onPermission: (record) => this.deps.store.update(session.id, (s) => { s.permissions.push({ ...record, at: new Date().toISOString() }); }),
          });
          this.recordResult(session, attempt, current, result);
          const candidates = ((result.data as { candidates?: string[] } | undefined)?.candidates || []).filter(Boolean);
          // Not sure which chat: ask, send to the chosen one, and remember
          // the nickname (next time "Priya Dii" goes straight through).
          if (!result.ok && candidates.length && attempt < 3 && typeof current.args.name === "string") {
            const said = String(action.args.name);
            const answer = await this.ask(session, control, `"${said}" — kaunsi chat? Which one do you mean?`, [...candidates.slice(0, 4), "Cancel"]);
            if (/^(cancel|stop|no|nahi)/i.test(answer.trim())) throw new Error("Okay, not sending it.");
            const chosen = candidates.find((c) => c.toLowerCase() === answer.trim().toLowerCase()) || answer.trim();
            if (chosen.toLowerCase() !== said.toLowerCase()) {
              const app = String(current.args.app || "whatsapp").toLowerCase();
              await this.deps.contacts.upsert({ displayName: chosen, aliases: [said], appNames: { [app]: chosen } }).catch(() => undefined);
              this.deps.audit.record(session.id, "action", `Remembered: "${said}" is ${chosen}`);
            }
            current = { ...current, args: { ...current.args, name: chosen } };
            continue;
          }
          await this.finish(session, result.ok, result.ok ? result.summary : (result.error || result.summary).replace(/^[A-Z_]+: /, ""));
          return;
        }
        await this.finish(session, false, "I couldn't find that chat.");
      } catch (error) {
        if (isCancelledError(error) || scope.cancelled) {
          const current = this.deps.store.get(session.id);
          if (current && !TERMINAL_STATES.has(current.state)) this.deps.store.transition(session.id, "cancelled", "Stopped.");
          return;
        }
        await this.finish(session, false, error instanceof Error ? error.message : String(error));
      } finally {
        scope.dispose();
        this.controls.delete(session.id);
      }
    })();
    return session;
  }

  // ---- user controls -------------------------------------------------------------

  /**
   * Continue an interrupted (crashed) task as a NEW task. Completed actions are
   * listed so the planner re-verifies the desktop instead of repeating them.
   */
  continueInterrupted(sessionId: string): TaskSession {
    const previous = this.deps.store.get(sessionId);
    if (!previous || previous.state !== "interrupted") throw new Error("That task is not an interrupted task.");
    if (previous.sensitive) throw new Error("Sensitive tasks are never resumed automatically; please ask again.");
    const done = previous.actions.filter((action) => action.status === "ok").slice(-12).map((action) => `- ${action.summary}`);
    this.deps.store.transition(sessionId, "cancelled", "Continued in a new task.");
    return this.start(previous.goal, "recovery", {
      preface: [
        "This task was interrupted by an application restart. Some steps may already be done — verify the current screen and files before repeating anything.",
        done.length ? `Steps that had succeeded before the restart:\n${done.join("\n")}` : "No steps had completed.",
      ],
    });
  }

  stop(taskId: string, reason = "user_stop"): boolean {
    const control = this.controls.get(taskId);
    const queued = this.queue.indexOf(taskId);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (!control) return false;
    control.scope.cancel(reason);
    this.deps.scheduler.revokeOwner(`task:${taskId}`);
    this.release(control);
    const session = this.deps.store.get(taskId);
    if (session && !TERMINAL_STATES.has(session.state)) {
      this.deps.store.transition(taskId, "cancelled", "Stopped.");
      this.deps.audit.record(taskId, "task.finished", "Stopped by the user");
    }
    return true;
  }

  /** Guaranteed full stop: every task, lease, confirmation and wait. */
  stopAll(reason = "emergency_stop"): number {
    const ids = [...new Set([...this.controls.keys(), ...this.queue])];
    this.queue.length = 0;
    for (const id of ids) this.stop(id, reason);
    rootScope.cancelChildren(reason);
    this.deps.scheduler.revokeOwner("task:");
    this.deps.confirmations.cancelAll();
    this.deps.onEmergencyStop?.(reason);
    appEvents.publish("autonomy.stopped", { reason, tasks: ids.length });
    return ids.length;
  }

  pause(taskId: string): boolean {
    const control = this.controls.get(taskId);
    if (!control) return false;
    control.paused = true;
    return true;
  }

  resume(taskId: string): boolean {
    const control = this.controls.get(taskId);
    if (!control) return false;
    control.paused = false;
    control.takeover = false;
    this.release(control);
    return true;
  }

  takeOver(taskId: string): boolean {
    const control = this.controls.get(taskId);
    if (!control) return false;
    control.takeover = true;
    return true;
  }

  returnControl(taskId: string): boolean {
    return this.resume(taskId);
  }

  answer(taskId: string, text: string): boolean {
    const control = this.controls.get(taskId);
    if (!control?.answer) return false;
    const resolve = control.answer;
    control.answer = null;
    resolve(text);
    return true;
  }

  private release(control: Control): void {
    for (const resolve of control.resumeWaiters.splice(0)) resolve();
  }

  /** Waits while paused or while the user has taken over. */
  private async checkpoint(session: TaskSession, control: Control): Promise<boolean> {
    control.scope.throwIfCancelled();
    if (!control.paused && !control.takeover) return false;
    const state = control.takeover ? "user_takeover" : "paused";
    this.deps.store.transition(session.id, state, control.takeover ? "You have control — I'm watching." : "Paused.");
    while ((control.paused || control.takeover) && !control.scope.cancelled) {
      await control.scope.race(new Promise<void>((resolve) => control.resumeWaiters.push(resolve)));
    }
    control.scope.throwIfCancelled();
    this.deps.store.transition(session.id, "planning", "Back to it — checking the screen…");
    return true;
  }

  // ---- the loop -----------------------------------------------------------------

  private async run(taskId: string): Promise<void> {
    const control = this.controls.get(taskId);
    const session = this.deps.store.get(taskId);
    if (!control || !session) return;
    const store = this.deps.store;
    const scope = control.scope;
    const maxSteps = this.deps.maxSteps ?? 30;
    const deadline = Date.now() + (this.deps.maxDurationMs ?? 15 * 60_000);
    const recovery = new RecoveryEngine();
    const userAnswers: Array<{ question: string; answer: string }> = [];
    const notes: string[] = [...control.preface];
    let plan: string[] | null = null;
    let recoveryAdvice: RecoveryAdvice | null = null;
    let forceObserve = true;
    let wantScreenshot = false;
    let references: ResolvedReference[] = [];
    let memories: string[] = [];
    /** Compact outputs of recent actions, shown to the planner as untrusted data. */
    const actionOutputs: Array<{ step: number; tool: string; data: string }> = [];
    /** Everything the agent has actually observed, for grounding the final answer. */
    const evidence: string[] = [];
    let ungroundedFinishes = 0;
    let recipient: { name: string; contactId: string | null } | null = null;

    this.deps.working.activeTaskId = taskId;
    this.deps.working.activeGoal = session.goal;
    const status = (text: string) => store.setStatus(taskId, text);

    try {
      store.transition(taskId, "planning", "Looking at the screen…");
      this.say("started", "", `Started: ${session.goal}`, "low");

      // ---- understand: references + memory, before the first plan --------------
      const initial = await this.timed(session, "perceptionMs", () => this.deps.perception.observe({ force: true, signal: scope.signal }));
      references = await resolveReferences(session.goal, initial, {
        call: this.deps.call,
        contacts: this.deps.contacts,
        working: this.deps.working,
        recallLocations: async (name) => (await this.deps.recall(`${name} folder location path`)).filter((m) => m.toLowerCase().includes(name.toLowerCase())),
      }, scope.signal).catch(() => []);
      store.update(taskId, (s) => {
        s.references = references.filter((r) => r.best).map((r) => ({ phrase: r.phrase, resolvedTo: r.best!.label, confidence: r.best!.confidence }));
      });
      const person = references.find((ref) => ref.kind === "person");
      if (person) recipient = { name: person.best?.label || person.phrase, contactId: person.status === "resolved" ? person.best!.value : null };
      memories = (await this.deps.recall(session.goal).catch(() => [])).slice(0, 6);

      let state: DesktopState = initial;
      for (let step = 1; step <= maxSteps; step += 1) {
        await this.checkpoint(session, control).then((resumed) => {
          if (resumed) {
            forceObserve = true;
            notes.push("The user paused or took control; the screen may have changed. Re-check before acting.");
          }
        });
        if (Date.now() > deadline) throw new Error("Time limit reached for this task.");

        // ---- perceive -----------------------------------------------------------
        if (step > 1) {
          state = await this.timed(session, "perceptionMs", () => this.deps.perception.observe({ force: forceObserve, signal: scope.signal }));
        }
        forceObserve = false;
        evidence.push(PerceptionEngine.format(state, { maxElements: 150 }));
        if (evidence.length > 12) evidence.splice(0, evidence.length - 12);
        store.update(taskId, (s) => {
          s.steps = step;
          s.observations.push({ at: new Date().toISOString(), summary: `${state.activeWindow?.title || "no window"} · ${state.elements.length} controls`, changed: state.change.changed });
        });
        this.noteScreenReferents(state);

        // ---- plan ---------------------------------------------------------------
        let screenshot: { mime: string; data: string } | null = null;
        const sparse = state.notes.some((note) => /few accessible controls/i.test(note));
        if ((sparse || wantScreenshot) && state.activeWindow && !state.activeWindow.minimized) {
          const capture = await this.deps.call("captureForVision", { target: "window", hwnd: state.activeWindow.hwnd, max_dim: 1024, quality: 58 }, scope.signal);
          if (capture.ok) {
            const result = capture.result as Record<string, unknown>;
            screenshot = { mime: String(result.image_mime || "image/jpeg"), data: String(result.image_base64) };
            store.update(taskId, (s) => { s.usage.visionCalls += 1; });
          }
        }
        wantScreenshot = false;
        store.transition(taskId, "planning");
        let planned;
        try {
          planned = await this.timed(session, "planningMs", () => this.planner.decide({
            goal: session.goal,
            step,
            maxSteps,
            references,
            memories,
            plan,
            recentActions: this.deps.store.get(taskId)!.actions,
            actionOutputs: actionOutputs.slice(-6),
            recovery: recoveryAdvice,
            userAnswers,
            state,
            screenshot,
            notes: notes.splice(0),
            permissionNote: this.permissionNote(),
            complexity: session.sensitive ? 0.6 : 0.5,
          }, { signal: scope.signal, onQuotaWait: (ms) => status(`Model is busy — continuing in ${Math.ceil(ms / 1000)}s…`) }));
        } catch (error) {
          if (isCancelledError(error) || scope.cancelled) throw error;
          const modelError = error instanceof ModelError ? error : null;
          const advice = recovery.record("planner", { step }, false, "MODEL_FAILURE", false)!;
          store.update(taskId, (s) => { s.error = modelError?.userMessage || String(error); });
          if (advice.escalate || (modelError && !modelError.retryable)) {
            throw new Error(modelError?.userMessage || "The planning model is unavailable.");
          }
          status("Model hiccup — retrying…");
          await scope.sleep(2_000);
          continue;
        }
        store.update(taskId, (s) => {
          s.usage.modelCalls += 1;
          s.usage.inputTokens += planned.usage.inputTokens;
          s.usage.outputTokens += planned.usage.outputTokens;
          s.modelId = planned.modelId;
          s.plan = { summary: planned.decision.situation, steps: planned.decision.plan.map((text, index) => ({ text, status: index === 0 ? "active" : "pending" })) };
        });
        plan = planned.decision.plan;
        recoveryAdvice = null;
        if (planned.decision.status_for_user) status(planned.decision.status_for_user);

        // ---- verify the previous step ---------------------------------------------
        if (step > 1 && planned.decision.verification_of_previous.matched === false) {
          const advice = recovery.verificationFailed();
          recoveryAdvice = advice;
          this.deps.working.noteFailure(planned.decision.verification_of_previous.evidence);
          this.deps.audit.record(taskId, "recovery", `Previous step didn't work: ${planned.decision.verification_of_previous.evidence}`);
          if (advice.escalate) {
            await this.escalate(session, control, advice, userAnswers);
            continue;
          }
          wantScreenshot = advice.attempt >= 2;
        }
        if (planned.invalid.length) notes.push(`Your last output had problems: ${planned.invalid.join("; ")}`);

        // ---- terminal decisions ---------------------------------------------------
        if (planned.decision.goal_status === "done" && planned.actions.every((a) => a.tool === "task.finish")) {
          const finish = planned.actions.find((a) => a.tool === "task.finish");
          const summary = String(finish?.args.summary || planned.decision.situation || "Done.");
          const ungrounded = ungroundedClaims(summary, evidence, actionOutputs, session.goal);
          if (ungrounded.length && ungroundedFinishes < 2) {
            ungroundedFinishes += 1;
            notes.push(`Your final answer mentions ${ungrounded.map((u) => `"${u}"`).join(", ")}, which never appeared in any observation or action output. Verify it (look at the actual data) before finishing.`);
            continue;
          }
          await this.finish(session, true, summary);
          return;
        }
        if (planned.decision.goal_status === "blocked" && !planned.actions.some((a) => a.tool !== "task.finish")) {
          const finish = planned.actions.find((a) => a.tool === "task.finish");
          await this.finish(session, false, String(finish?.args.summary || planned.decision.situation || "Blocked."));
          return;
        }

        // ---- act ------------------------------------------------------------------
        store.transition(taskId, "running");
        let uiChanged = false;
        for (const [index, action] of planned.actions.entries()) {
          scope.throwIfCancelled();
          if (control.paused || control.takeover) break;
          if (action.tool === "task.finish") {
            if (uiChanged) {
              notes.push("You tried to finish right after changing the screen; verify the result in this observation first.");
              break;
            }
            const summary = String(action.args.summary || planned.decision.situation);
            const ungrounded = action.args.success === true ? ungroundedClaims(summary, evidence, actionOutputs, session.goal) : [];
            if (ungrounded.length && ungroundedFinishes < 2) {
              ungroundedFinishes += 1;
              notes.push(`Your final answer mentions ${ungrounded.map((u) => `"${u}"`).join(", ")}, which never appeared in any observation or action output. Verify it before finishing.`);
              break;
            }
            await this.finish(session, action.args.success === true, summary);
            return;
          }
          if (action.tool === "task.ask_user") {
            const answer = await this.ask(session, control, String(action.args.question || "Kya karun?"), Array.isArray(action.args.options) ? action.args.options.map(String) : undefined);
            userAnswers.push({ question: String(action.args.question), answer });
            forceObserve = true;
            break;
          }
          const referencesElement = ["element", "from", "to"].some((key) => typeof action.args[key] === "string");
          if (index > 0 && uiChanged && referencesElement) {
            notes.push(`Stopped the batch before ${action.tool}: the screen changed, so element IDs must come from a new observation.`);
            break;
          }
          const result = await this.timed(session, "actionMs", () => this.deps.executor.execute(action, {
            taskId,
            goal: session.goal,
            state,
            scope,
            recipient,
            onStatus: status,
            onPermission: (record) => store.update(taskId, (s) => { s.permissions.push({ ...record, at: new Date().toISOString() }); }),
            onUserConflict: (strength) => {
              if (strength === "strong") this.say("waiting_for_user_input", "", "User is actively using the mouse/keyboard", "low");
            },
          }));
          this.recordResult(session, step, action, result);
          if (result.data !== undefined) {
            const data = compactData(result.data);
            actionOutputs.push({ step, tool: action.tool, data });
            if (actionOutputs.length > 12) actionOutputs.shift();
            evidence.push(data);
          }
          if (result.changesUi) uiChanged = true;
          const advice = recovery.record(action.tool, action.args, result.ok, result.category, state.change.changed);
          if (!result.ok) {
            recoveryAdvice = advice;
            if (result.category === "USER_INTERRUPTED") {
              await this.waitForUserIdle(session, control);
              forceObserve = true;
              break;
            }
            if (result.category === "PERMISSION_DENIED" && /did not approve|declined/i.test(result.error || "")) {
              notes.push("The user declined that action. Do not attempt it again; finish or choose a different approach the user would accept.");
            }
            if (advice?.escalate) {
              await this.escalate(session, control, advice, userAnswers);
            } else if (advice) {
              store.transition(taskId, "recovering", "Trying another way…");
              if (advice.attempt === 2) this.say("recovered", "", advice.guidance, "low");
            }
            forceObserve = true;
            wantScreenshot = result.category === "UNEXPECTED_UI" || result.category === "VERIFICATION_FAILED";
            break;
          }
        }
        if (uiChanged) forceObserve = true;
      }
      await this.finish(session, false, `I couldn't finish within ${maxSteps} steps.`);
    } catch (error) {
      if (isCancelledError(error) || scope.cancelled) {
        const current = store.get(taskId);
        if (current && !TERMINAL_STATES.has(current.state)) store.transition(taskId, "cancelled", "Stopped.");
        this.say("stopped", "", "Task stopped", "normal");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.warn("task failed", { taskId, message });
      await this.finish(session, false, message);
    }
  }

  private permissionNote(): string {
    const policy = this.deps.permissions.getPolicy();
    const asks = Object.entries(policy.capabilities).filter(([, value]) => value.decision === "ask").map(([key]) => key);
    const denies = Object.entries(policy.capabilities).filter(([, value]) => value.decision === "deny").map(([key]) => key);
    return `User confirmation is requested automatically for: ${asks.join(", ") || "nothing"}. Not permitted: ${denies.join(", ") || "nothing"}. Never try to work around these.`;
  }

  private recordResult(session: TaskSession, step: number, action: { tool: string; args: Record<string, unknown> }, result: ActionResult): void {
    this.deps.store.recordAction(session.id, {
      step,
      tool: action.tool,
      argsSummary: summarizeArgs(action.args),
      summary: result.summary,
      status: result.ok ? "ok" : result.category === "PERMISSION_DENIED" ? "denied" : result.category === "USER_INTERRUPTED" && /cancel/i.test(result.error || "") ? "cancelled" : "failed",
      durationMs: result.durationMs,
      error: result.error,
      failureCategory: result.category,
      verification: result.verification,
    });
    if (result.files?.length) {
      this.deps.store.update(session.id, (s) => {
        for (const file of result.files!) s.files.push({ ...file, at: new Date().toISOString() });
      });
      for (const file of result.files) {
        this.deps.working.noteReferent({ kind: /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(file.path) ? "image" : "file", label: file.path.split(/[\\/]/).pop() || file.path, value: file.path, source: file.change === "downloaded" ? "download" : "task" });
        this.deps.audit.record(session.id, "file", `${file.change}: ${file.path}`);
      }
    }
    if (result.ok) {
      this.deps.audit.record(session.id, "action", result.summary, { tool: action.tool, verified: result.verification?.passed ?? null });
      if (action.tool === "app.launch") this.deps.working.noteReferent({ kind: "app", label: String(action.args.name), value: String(action.args.name), source: "task" });
      if (action.tool === "browser.open") this.deps.working.noteReferent({ kind: "url", label: String(action.args.url), value: String(action.args.url), source: "task" });
    } else {
      this.deps.audit.record(session.id, "error", `${action.tool}: ${(result.error || "failed").slice(0, 200)}`, { category: result.category ?? null });
      this.deps.working.noteFailure(`${action.tool}: ${result.error}`);
    }
  }

  private noteScreenReferents(state: DesktopState): void {
    const title = state.activeWindow?.title || "";
    const file = title.match(/^(.+?\.(png|jpe?g|gif|webp|bmp|heic|mp4|mkv|mov|pdf|docx?))\b/i)?.[1];
    if (file) this.deps.working.noteReferent({ kind: /\.(mp4|mkv|mov|pdf|docx?)$/i.test(file) ? "file" : "image", label: file, value: file, source: "screen", salience: 0.6 });
    if (state.browser?.url) this.deps.working.noteReferent({ kind: "url", label: state.browser.title || state.browser.url, value: state.browser.url, source: "screen", salience: 0.5 });
    if (title) this.deps.working.noteReferent({ kind: "window", label: title, value: title, source: "screen", salience: 0.4 });
  }

  private async ask(session: TaskSession, control: Control, question: string, options?: string[]): Promise<string> {
    const id = `${session.id}:${Date.now()}`;
    this.deps.store.update(session.id, (s) => { s.pendingQuestion = { id, text: question, options, askedAt: new Date().toISOString() }; });
    this.deps.store.transition(session.id, "waiting_user", question);
    appEvents.publish("question.asked", { taskId: session.id, id, question, options: options || [] });
    this.say("question", question, `Question: ${question}${options?.length ? ` Options: ${options.join(" / ")}` : ""}`, "high");
    const answer = await control.scope.race(new Promise<string>((resolve) => {
      control.answer = resolve;
      const timer = setTimeout(() => {
        if (control.answer === resolve) {
          control.answer = null;
          resolve("(no answer from the user after 5 minutes)");
        }
      }, 5 * 60_000);
      timer.unref?.();
    }));
    this.deps.store.update(session.id, (s) => { s.pendingQuestion = null; });
    this.deps.audit.record(session.id, "action", `Asked: "${question}" → "${answer.slice(0, 120)}"`);
    if (/^\(no answer/.test(answer)) throw new Error("No answer from you, so I stopped.");
    return answer;
  }

  private async escalate(session: TaskSession, control: Control, advice: RecoveryAdvice, answers: Array<{ question: string; answer: string }>): Promise<void> {
    this.deps.audit.record(session.id, "recovery", `Escalating: ${advice.reason || advice.category}`);
    const question = advice.category === "AMBIGUOUS_TARGET"
      ? "Kaunsa wala? Mujhe ek se zyada match mile."
      : `I'm stuck (${(advice.reason || advice.category).toLowerCase()}). Should I keep trying, or do you want to help / stop?`;
    const answer = await this.ask(session, control, question, advice.category === "AMBIGUOUS_TARGET" ? undefined : ["Keep trying", "Stop"]);
    if (/^(stop|no|nahi|ruk|band|cancel)/i.test(answer.trim())) throw new Error("Stopped after getting stuck.");
    answers.push({ question, answer });
  }

  private async waitForUserIdle(session: TaskSession, control: Control): Promise<void> {
    this.deps.store.transition(session.id, "paused", "You're using the PC — I'll continue when you stop.");
    const deadline = Date.now() + 120_000;
    let quietSince = 0;
    while (Date.now() < deadline) {
      if (control.takeover) return;
      const verdict = await this.deps.arbiter.userActivity(1_500);
      if (!verdict.active) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince >= 3_000) {
          this.deps.store.transition(session.id, "planning", "Continuing…");
          return;
        }
      } else {
        quietSince = 0;
      }
      await control.scope.sleep(500);
    }
    const answer = await this.ask(session, control, "Tum PC use kar rahe ho — main continue karun?", ["Continue", "Stop"]);
    if (/^(stop|no|nahi|ruk|band)/i.test(answer.trim())) throw new Error("Stopped so you can keep working.");
  }

  private async finish(session: TaskSession, success: boolean, summary: string): Promise<void> {
    const current = this.deps.store.get(session.id);
    if (!current || TERMINAL_STATES.has(current.state)) return;
    this.deps.store.update(session.id, (s) => {
      s.result = { success, summary: summary.slice(0, 400) };
      if (!success) s.error = summary.slice(0, 400);
      if (s.plan) s.plan.steps = s.plan.steps.map((step) => ({ ...step, status: success ? "done" : step.status }));
    });
    this.deps.store.transition(session.id, success ? "completed" : "failed", success ? "Done." : summary.slice(0, 200));
    this.deps.audit.record(session.id, "task.finished", `${success ? "Completed" : "Failed"}: ${summary}`);
    const login = /log ?in|sign ?in|logged out|login nahi/i.test(summary) && !success;
    if (success) this.say("done", shortSummary(summary), summary, "normal");
    else if (login) this.say("login_required", appFrom(summary), summary, "high");
    else this.say("failed", shortSummary(summary), summary, "high");
    await this.deps.rememberEpisode(`${success ? "Completed" : "Could not complete"} a task for the user: "${session.goal}" — ${summary}`, success ? 0.55 : 0.6).catch(() => {});
    appEvents.publish("task.finished", { taskId: session.id, success, summary });
  }

  private say(kind: TaskEventKind, detail: string, facts: string, priority: "low" | "normal" | "high"): void {
    try {
      this.deps.speak(kind, this.voice.line(kind, detail), facts, priority);
    } catch {
      /* speech is optional */
    }
  }

  private async timed<T>(session: TaskSession, key: keyof TaskSession["timings"], work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      const elapsed = Date.now() - started;
      const current = this.deps.store.get(session.id);
      if (current) current.timings[key] += elapsed;
    }
  }

  status() {
    return {
      running: this.running,
      queued: [...this.queue],
      controls: [...this.controls.entries()].map(([id, control]) => ({ id, paused: control.paused, takeover: control.takeover, waitingForAnswer: Boolean(control.answer) })),
    };
  }
}

function shortSummary(summary: string): string {
  const first = summary.split(/(?<=[.!?])\s/)[0] || summary;
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

function appFrom(summary: string): string {
  return summary.match(/\b(whatsapp|gmail|google|instagram|facebook|telegram|discord|youtube|github|outlook)\b/i)?.[1] || "app";
}

/** Compact JSON for prompts: long arrays/strings trimmed, total capped. */
function compactData(data: unknown, max = 2_400): string {
  const text = JSON.stringify(data, (_key, value) => {
    if (typeof value === "string" && value.length > 600) return `${value.slice(0, 600)}…`;
    if (Array.isArray(value) && value.length > 40) return [...value.slice(0, 40), `…(+${value.length - 40} more)`];
    return value;
  });
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * File names, paths and URLs claimed in a final answer must have been seen.
 * Returns the claims that appear nowhere in observations, action outputs or
 * the user's own goal.
 */
export function ungroundedClaims(summary: string, evidence: string[], outputs: Array<{ data: string }>, goal: string): string[] {
  // JSON-encoded outputs double their backslashes; normalise before matching.
  const corpus = [...evidence, ...outputs.map((o) => o.data), goal].join("\n").toLowerCase().replace(/\\\\/g, "\\");
  const missing: string[] = [];
  // File names may contain spaces ("Screenshot 2026-10-02 131204.png"): a claim
  // is grounded if any 1..5-word suffix ending at the extension was seen.
  const fileClaim = /((?:\S+ ){0,4}\S*\.(?:png|jpe?g|gif|webp|bmp|heic|mp4|mkv|mov|pdf|docx?|xlsx?|pptx?|txt|zip|rar|7z|exe|msi|psd|blend|mp3|wav))(?![\w])/gi;
  for (const match of summary.matchAll(fileClaim)) {
    const words = match[1].split(" ");
    let grounded = false;
    for (let take = 1; take <= words.length && !grounded; take += 1) {
      const candidate = words.slice(words.length - take).join(" ").replace(/^[("'[]+/, "").toLowerCase();
      const base = candidate.split("\\").pop() || candidate;
      if (base.length > 4 && corpus.includes(base)) grounded = true;
    }
    if (!grounded) missing.push(words.slice(-2).join(" ").replace(/^[("'[]+/, ""));
  }
  for (const match of summary.matchAll(/https?:\/\/[^\s)"']+/gi)) {
    const url = match[0].replace(/[.,]+$/, "");
    if (!corpus.includes(url.toLowerCase())) missing.push(url);
  }
  return [...new Set(missing)];
}

