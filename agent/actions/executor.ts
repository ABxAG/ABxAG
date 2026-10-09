/**
 * ActionExecutor: the only path from a planned action to the desktop.
 *
 *   validate args → resolve element against the CURRENT observation →
 *   classify risk from what the action really does → permission engine
 *   (ALLOW / ASK → user confirmation / DENY) → wait out user input conflicts →
 *   lease resources → execute (cancellable) → categorize failures →
 *   deterministic verification where the outcome is checkable.
 *
 * The planner can propose anything; nothing bypasses this sequence.
 */
import { openChat, sendInOpenChat } from "./chatOpen";
import path from "node:path";
import type { ContactBook } from "../../memory/contacts";
import type { ConfirmationBroker } from "../../permissions/confirmations";
import type { PermissionEngine } from "../../permissions/engine";
import { CAPABILITY_INFO, type Capability, type PermissionContext } from "../../permissions/types";
import { validateJson } from "../../shared/jsonSchema";
import { summarizeArgs } from "../../shared/redact";
import type { AuditLog } from "../audit";
import { CancelledError, type CancellationScope } from "../cancellation";
import type { DownloadManager } from "../downloads";
import type { AgentCall, DesktopState, PerceptionEngine, UiElement } from "../perception/engine";
import type { InputArbiter, ResourceScheduler } from "../scheduler";
import { classifyCommand, runCommand } from "../shell";
import type { FailureCategory, TaskFileRecord } from "../taskSession";
import { fetchPage } from "../webFetch";
import { ACTION_MAP, type ActionDefinition } from "./catalog";
import { assessRisk } from "./risk";

export interface PlannedAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface ActionContext {
  taskId: string;
  goal: string;
  state: DesktopState | null;
  scope: CancellationScope;
  recipient?: { name: string; contactId: string | null } | null;
  onStatus?: (text: string) => void;
  onPermission?: (record: { capability: Capability; decision: "allow" | "ask" | "deny"; outcome?: "approved" | "rejected" | "expired" | "auto"; scope?: string }) => void;
  /** Called when the user keeps using the mouse/keyboard while ABxAG needs it. */
  onUserConflict?: (strength: "light" | "strong") => void;
}

export interface ActionResult {
  ok: boolean;
  tool: string;
  summary: string;
  data?: unknown;
  error?: string;
  category?: FailureCategory;
  verification?: { passed: boolean; evidence: string; method: "deterministic" | "model" | "none" };
  usedPointer?: boolean;
  files?: Omit<TaskFileRecord, "at">[];
  durationMs: number;
  /** The UI probably changed; the loop should re-observe before deciding. */
  changesUi: boolean;
  /** Visual elements discovered by screen.look / screen.locate. */
  visualElements?: UiElement[];
}

export interface ExecutorDeps {
  call: AgentCall;
  perception: PerceptionEngine;
  permissions: PermissionEngine;
  confirmations: ConfirmationBroker;
  scheduler: ResourceScheduler;
  arbiter: InputArbiter;
  downloads: DownloadManager;
  contacts: ContactBook;
  audit: AuditLog;
  remember: (fact: string, kind: string) => Promise<void>;
  notify: (title: string, body: string) => void;
  /** Seconds to wait for the user to stop using the mouse before yielding. */
  conflictWaitMs?: number;
}

const POINTER_TOOLS = new Set(["ui.double_click", "ui.right_click", "ui.scroll", "mouse.click_point", "mouse.drag"]);

/** Text compared for duplicate sends: case, spacing and trailing punctuation ignored. */
function sendKey(text: unknown): string {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[\s.!?…]+$/u, "").trim();
}

export class ActionExecutor {
  /**
   * Per task: texts already submitted with Enter, and the text typed but not
   * yet submitted. Sending a message is not idempotent — if the chat simply
   * hasn't shown it yet, typing it again sends it twice.
   */
  private readonly sends = new Map<string, { submitted: Map<string, string>; pending: string | null }>();

  constructor(private readonly deps: ExecutorDeps) {}

  private sendState(taskId: string) {
    let state = this.sends.get(taskId);
    if (!state) {
      state = { submitted: new Map(), pending: null };
      this.sends.set(taskId, state);
      if (this.sends.size > 40) this.sends.delete(this.sends.keys().next().value!);
    }
    return state;
  }

  /** The text an action would submit with Enter, or null. */
  private submission(action: PlannedAction, taskId: string): string | null {
    const args = action.args || {};
    if (action.tool === "ui.type" && args.submit === true) return sendKey(args.text);
    if (action.tool === "chat.send") return `${sendKey(args.name)}→${sendKey(args.text)}`;
    if (action.tool === "keyboard.press" && /^(enter|return)$/i.test(String(args.key || ""))) return this.sends.get(taskId)?.pending ?? null;
    return null;
  }

  /** Applied live when the user changes the setting. */
  setConflictWaitMs(ms: number): void {
    this.deps.conflictWaitMs = ms;
  }

  definition(tool: string): ActionDefinition | undefined {
    return ACTION_MAP.get(tool);
  }

  async execute(action: PlannedAction, context: ActionContext): Promise<ActionResult> {
    const started = Date.now();
    const definition = ACTION_MAP.get(action.tool);
    const fail = (category: FailureCategory, error: string, summary = "Action failed"): ActionResult => ({
      ok: false, tool: action.tool, summary, error, category, durationMs: Date.now() - started, changesUi: false,
    });
    if (!definition) return fail("INVALID_ACTION", `Unknown action '${action.tool}'. Use only listed actions.`);
    if (action.tool === "task.ask_user" || action.tool === "task.finish") {
      return fail("INVALID_ACTION", "task.* actions are handled by the task loop.");
    }
    const args = { ...(action.args || {}) };
    const validation = validateJson(args, definition.args);
    if (!validation.valid) return fail("INVALID_ACTION", `Invalid arguments for ${action.tool}: ${validation.errors.join("; ")}`);

    const submitting = this.submission(action, context.taskId);
    if (submitting) {
      const earlier = this.sendState(context.taskId).submitted.get(submitting);
      if (earlier) {
        this.deps.audit.record(context.taskId, "recovery", "Blocked a duplicate send of the same text");
        return fail("INVALID_ACTION", `DUPLICATE_SEND: this exact text was already typed and sent with Enter earlier in this task (${earlier}). Sending it again would deliver it twice. Chat apps can take a few seconds to show a sent message: wait, then look for it in the conversation. If it is there, finish; if it really did not go out, ask the user before sending again.`, "Already sent");
      }
    }

    try {
      context.scope.throwIfCancelled();

      // ---- resolve element references against the current observation -------
      const targets: Record<string, UiElement> = {};
      for (const key of ["element", "from", "to"]) {
        const reference = args[key];
        if (typeof reference !== "string" || !reference) continue;
        const resolved = await this.resolveElement(reference, context);
        if ("error" in resolved) return fail(resolved.category, resolved.error);
        targets[key] = resolved.element;
      }
      if (action.tool === "mouse.click_point") {
        const window = context.state?.activeWindow?.rect;
        const x = Number(args.x), y = Number(args.y);
        if (!window || x < window.left || x >= window.right || y < window.top || y >= window.bottom) {
          return fail("INVALID_ACTION", "Raw coordinates must lie inside the current active window from the latest observation. Use an element ID instead.");
        }
      }

      // ---- semantic preconditions that change the risk -------------------------
      if (action.tool === "app.launch" && /[\\/:]|\.exe\s|\s-{1,2}\w|\s\/\w/i.test(String(args.name))) {
        return fail("INVALID_ACTION", "app.launch takes only an application name (e.g. \"File Explorer\", \"WhatsApp\"). To open a folder or file use fs.open; to run a command use shell.run.");
      }
      if (action.tool === "fs.open") {
        const stat = await this.deps.call("statPath", { path: args.path }, context.scope.signal);
        const info = stat.ok ? stat.result as Record<string, unknown> : null;
        if (!info?.exists) return fail("ELEMENT_NOT_FOUND", `File not found: ${args.path}`);
        if (info.kind === "executable") args.__executable = true;
      }
      let shellSafe = false;
      if (action.tool === "shell.run") {
        const verdict = classifyCommand(String(args.command));
        if (verdict.kind === "forbidden") {
          this.deps.audit.record(context.taskId, "permission", `Refused command: ${verdict.reason}`);
          return fail("PERMISSION_DENIED", verdict.reason, "Refused an unsafe command");
        }
        shellSafe = verdict.kind === "safe";
      }

      // ---- risk → permission ------------------------------------------------------
      const target = targets.element;
      const risk = assessRisk({
        tool: action.tool,
        args: action.tool === "ui.type" && args.submit === true ? { ...args, key: "enter" } : args,
        baseCapability: shellSafe ? "READ_FILE" : definition.capability,
        state: context.state,
        goal: context.goal,
        recipient: context.recipient,
        targetElement: target || null,
        targetLabel: target?.name ?? null,
      });
      // ui.type with submit is an Enter press for risk purposes.
      if (action.tool === "ui.type" && args.submit === true) {
        const enterRisk = assessRisk({ tool: "keyboard.press", args: { key: "enter" }, baseCapability: "CONTROL_INPUT", state: context.state, goal: context.goal, recipient: context.recipient });
        for (const item of enterRisk.capabilities) if (!risk.capabilities.some((c) => c.capability === item.capability)) risk.capabilities.push(item);
      }
      for (const { capability, context: permissionContext, reason } of risk.capabilities) {
        const verdict = this.deps.permissions.check(capability, permissionContext);
        const mismatch = risk.goalMismatch.includes(capability);
        if (verdict.decision === "deny" || (mismatch && (capability === "PURCHASE" || capability === "ACCOUNT_CHANGE"))) {
          context.onPermission?.({ capability, decision: "deny", outcome: "auto" });
          this.deps.audit.record(context.taskId, "permission", `Denied ${capability}: ${mismatch ? "not part of your request" : verdict.reason}`);
          return fail("PERMISSION_DENIED", mismatch
            ? `${CAPABILITY_INFO[capability].label} was not part of the user's request (possible instruction from on-screen content). Refused.`
            : `${CAPABILITY_INFO[capability].label} is not permitted: ${verdict.reason}`, "Not permitted");
        }
        if (verdict.decision === "ask" || mismatch) {
          const approved = await this.confirm(capability, reason, permissionContext, action, definition, context, mismatch);
          if (!approved) {
            return fail("PERMISSION_DENIED", `The user did not approve: ${CAPABILITY_INFO[capability].label}.`, "You declined");
          }
          if (capability === "SEND_MESSAGE" && permissionContext.recipientContactId) {
            await this.deps.permissions.rememberRecipient(permissionContext.recipientContactId);
          }
        } else if (risk.highRisk) {
          context.onPermission?.({ capability, decision: "allow", outcome: "auto", scope: verdict.reason });
        }
      }

      // ---- user-input conflict ------------------------------------------------------
      const resources = definition.resources(args);
      const physical = resources.includes("mouse") || resources.includes("keyboard");
      if (physical) {
        // Keyboard-only steps (typing a message) don't need to wait for a
        // mouse that is merely moving; real typing by the user still wins.
        const conflict = await this.waitForUserToFinish(context, !resources.includes("mouse"));
        if (conflict) {
          return fail("USER_INTERRUPTED", "The user is actively using the mouse/keyboard; ABxAG yielded instead of fighting for control.", "Waiting for you");
        }
        // Keystrokes go to the foreground window. If the observed target is
        // behind ABxAG or an overlay, bring it forward first and verify.
        const target = context.state?.activeWindow;
        if (target?.hwnd && target.foreground === false && !target.minimized) {
          const focus = await this.deps.call("windowControl", { hwnd: target.hwnd, action: "focus" }, context.scope.signal);
          const focused = focus.ok && (focus.result as Record<string, unknown>)?.foreground === true;
          if (!focused) {
            return fail("WINDOW_NOT_OPEN", `Could not bring "${target.title}" to the front before typing/clicking${focus.error ? `: ${focus.error}` : ""}.`, "Couldn't switch windows");
          }
          target.foreground = true;
        }
      }

      // ---- execute under a resource lease -------------------------------------------
      context.onStatus?.(definition.progress(args));
      const result = await this.deps.scheduler.withLease(`task:${context.taskId}`, resources, async () => {
        const syntheticStart = Date.now();
        try {
          return await this.run(definition, args, targets, context);
        } finally {
          if (physical || POINTER_TOOLS.has(action.tool)) this.deps.arbiter.markSynthetic(syntheticStart, Date.now());
        }
      }, { signal: context.scope.signal, priority: 5, timeoutMs: 30_000 });
      result.durationMs = Date.now() - started;
      this.noteSend(action, context, result);
      return result;
    } catch (error) {
      if (error instanceof CancelledError || context.scope.cancelled) {
        return { ...fail("USER_INTERRUPTED", "Cancelled."), summary: "Stopped" };
      }
      const message = error instanceof Error ? error.message : String(error);
      return fail(categorize(message), message);
    }
  }

  private noteSend(action: PlannedAction, context: ActionContext, result: ActionResult): void {
    if (!result.ok) return;
    const state = this.sendState(context.taskId);
    const where = context.state?.activeWindow?.title ? `in "${short(context.state.activeWindow.title, 40)}"` : "in the active window";
    const submitted = this.submission(action, context.taskId);
    if (submitted) {
      state.submitted.set(submitted, `${where} at ${new Date().toLocaleTimeString()}`);
      state.pending = null;
      result.data = { ...(result.data && typeof result.data === "object" ? result.data as object : {}), sent: true, note: "Enter was pressed, so the text was sent. Chat apps may take a few seconds to show it — do not type it again; wait and look for it." };
    } else if (action.tool === "ui.type") {
      state.pending = sendKey(action.args.text) || null;
    }
  }

  private async resolveElement(reference: string, context: ActionContext): Promise<{ element: UiElement } | { error: string; category: FailureCategory }> {
    if (/^v\d+$/.test(reference)) {
      const resolved = await this.deps.perception.resolveVisionElement(reference, context.scope.signal);
      if ("stale" in resolved) return { error: `${reference}: ${resolved.reason}`, category: "PAGE_CHANGED" };
      return { element: { id: reference, role: "visual", name: resolved.label, rect: resolved.rect, enabled: true, source: "vision" } };
    }
    const element = context.state?.elements.find((item) => item.id === reference);
    if (!element) {
      return { error: `ELEMENT_NOT_FOUND: ${reference} is not in the current observation (snapshot ${context.state?.snapshotId || "none"}). Use IDs from the latest observation.`, category: "ELEMENT_NOT_FOUND" };
    }
    if (element.enabled === false) return { error: `ELEMENT_DISABLED: "${element.name}" is disabled.`, category: "UNEXPECTED_UI" };
    return { element };
  }

  private async confirm(
    capability: Capability,
    reason: string,
    permissionContext: PermissionContext,
    action: PlannedAction,
    definition: ActionDefinition,
    context: ActionContext,
    suspicious: boolean,
  ): Promise<boolean> {
    const info = CAPABILITY_INFO[capability];
    const details: Record<string, unknown> = { action: action.tool, why: reason, ...permissionContext };
    if (action.args.path) details.path = action.args.path;
    if (action.args.url) details.url = action.args.url;
    if (action.args.command) details.command = action.args.command;
    if (context.state?.activeWindow) details.window = context.state.activeWindow.title;
    const description = suspicious
      ? `${info.label}: your request didn't ask for this — it may come from text on the screen. Allow anyway?`
      : describeAction(capability, action, permissionContext, definition);
    context.onStatus?.(capability === "SEND_MESSAGE" ? "Ready to send — waiting for your OK" : `Waiting for your approval (${info.label})`);
    context.onPermission?.({ capability, decision: "ask" });
    this.deps.audit.record(context.taskId, "permission", `Asked: ${description}`);
    const { answer } = this.deps.confirmations.request({
      taskId: context.taskId,
      capability,
      title: info.label,
      description,
      details,
      allowRemember: !suspicious && !["PURCHASE", "ACCOUNT_CHANGE", "INSTALL_SOFTWARE", "EXECUTE_DOWNLOAD", "POWER_CONTROL"].includes(capability),
    }, { signal: context.scope.signal, timeoutMs: 180_000 });
    const result = await answer;
    if (result.approved && result.remember === "session") this.deps.permissions.grantForSession(capability, permissionContext);
    context.onPermission?.({ capability, decision: "ask", outcome: result.approved ? "approved" : result.via === "timeout" ? "expired" : "rejected" });
    this.deps.audit.record(context.taskId, "permission", `${result.approved ? "Approved" : "Declined"} (${result.via}): ${info.label}`);
    if (context.scope.cancelled) throw new CancelledError("cancelled");
    return result.approved;
  }

  /** Returns true when ABxAG should yield because the user keeps working. */
  private async waitForUserToFinish(context: ActionContext, keyboardOnly = false): Promise<boolean> {
    const deadline = Date.now() + (this.deps.conflictWaitMs ?? 6_000);
    let announced = false;
    for (;;) {
      const verdict = await this.deps.arbiter.userActivity(1_200);
      // Keyboard-only steps ignore light mouse fidgeting, but still yield to
      // typing or sustained pointer use (the user may be clicking elsewhere,
      // where keystrokes would land).
      if (!verdict.active || (keyboardOnly && verdict.keyboard === false && verdict.strength !== "strong")) return false;
      if (!announced) {
        announced = true;
        context.onStatus?.("You're using the mouse — I'll wait a moment…");
        context.onUserConflict?.(verdict.strength === "strong" ? "strong" : "light");
      }
      if (Date.now() > deadline) return true;
      await context.scope.sleep(400);
    }
  }

  private async run(definition: ActionDefinition, args: Record<string, unknown>, targets: Record<string, UiElement>, context: ActionContext): Promise<ActionResult> {
    const started = Date.now();
    const signal = context.scope.signal;
    const call = (tool: string, toolArgs: Record<string, unknown>) => this.deps.call(tool, toolArgs, signal);
    const ok = (summary: string, data?: unknown, extra: Partial<ActionResult> = {}): ActionResult => ({
      ok: true, tool: definition.name, summary, data, durationMs: Date.now() - started, changesUi: definition.changesUi, ...extra,
    });
    const failed = (error: string | undefined, summary = "Action failed"): ActionResult => ({
      ok: false, tool: definition.name, summary, error: error || "Unknown error", category: categorize(error || ""), durationMs: Date.now() - started, changesUi: definition.changesUi,
    });
    const snapshot = context.state?.snapshotId || undefined;
    const target = targets.element;
    const label = target ? `"${short(target.name || target.role)}"` : "";

    const uiAction = async (action: string, value?: unknown, method?: string) => {
      if (target?.source === "vision") {
        const x = Math.round((target.rect.left + target.rect.right) / 2);
        const y = Math.round((target.rect.top + target.rect.bottom) / 2);
        const tool = action === "double_click" ? "doubleClick" : action === "right_click" ? "rightClick" : "click";
        const response = await call(tool, { x, y });
        return { ...response, result: { ...(response.result as object || {}), used_pointer: true, method: `pointer.${tool}` } };
      }
      return call("uiAction", { element_id: target!.id, snapshot_id: snapshot, action, ...(value !== undefined ? { value: String(value) } : {}), ...(method ? { method } : {}) });
    };

    switch (definition.name) {
      case "ui.click": {
        const response = await uiAction("click", undefined, args.method === "mouse" ? "mouse" : "auto");
        if (!response.ok) return failed(response.error);
        const result = response.result as Record<string, unknown>;
        return ok(`Clicked ${label}`, compact(result, ["method", "moved_since_snapshot"]), { usedPointer: Boolean(result.used_pointer) });
      }
      case "ui.double_click":
      case "ui.right_click": {
        const response = await uiAction(definition.name === "ui.double_click" ? "double_click" : "right_click");
        if (!response.ok) return failed(response.error);
        return ok(`${definition.name === "ui.double_click" ? "Opened" : "Opened the menu of"} ${label}`, compact(response.result, ["method"]), { usedPointer: true });
      }
      case "ui.select":
      case "ui.toggle": {
        const response = await uiAction(definition.name === "ui.select" ? "select" : "toggle");
        if (!response.ok) return failed(response.error);
        return ok(`${definition.name === "ui.select" ? "Selected" : "Toggled"} ${label}`, compact(response.result, ["method"]));
      }
      case "ui.expand": {
        const response = await uiAction(args.collapse ? "collapse" : "expand");
        if (!response.ok) return failed(response.error);
        return ok(`${args.collapse ? "Collapsed" : "Expanded"} ${label}`);
      }
      case "ui.scroll": {
        const notches = Math.round(Number(args.amount) || 5) * (args.direction === "up" ? 1 : -1);
        const response = target
          ? await uiAction("scroll", notches)
          : await call("scroll", { amount: notches * 120, ...(context.state?.activeWindow ? centerOf(context.state.activeWindow.rect) : {}) });
        if (!response.ok) return failed(response.error);
        return ok(`Scrolled ${args.direction}`, undefined, { usedPointer: true });
      }
      case "ui.type": {
        if (target) {
          if (args.replace) {
            const set = await uiAction("set_value", args.text);
            if (!set.ok) return failed(set.error);
            const verified = (set.result as Record<string, unknown>)?.verified_value;
            if (args.submit) {
              const enter = await call("pressKey", { key: "enter" });
              if (!enter.ok) return failed(enter.error);
            }
            return ok(`Typed into ${label}`, { verified_value: verified }, {
              verification: verified === true ? { passed: true, evidence: "Field value matches the typed text.", method: "deterministic" } : undefined,
            });
          }
          const focus = await uiAction("focus");
          if (!focus.ok) return failed(focus.error);
        }
        const typed = await call("typeUnicode", { text: args.text });
        if (!typed.ok) return failed(typed.error);
        if (args.submit) {
          const enter = await call("pressKey", { key: "enter" });
          if (!enter.ok) return failed(enter.error);
        }
        return ok(`Typed "${short(args.text, 30)}"${args.submit ? " and pressed Enter" : ""}`);
      }
      case "ui.find": {
        const state = await this.deps.perception.observe({ windowTitle: args.window ? String(args.window) : undefined, query: String(args.query), signal, force: true });
        return ok(`Searched for "${short(args.query, 30)}"`, { matches: state.elements.slice(0, 25).map((e) => `${e.id} ${e.role} "${short(e.name, 60)}"`), snapshot: state.snapshotId }, { changesUi: false });
      }
      case "ui.inspect": {
        const state = await this.deps.perception.observe({ windowTitle: String(args.window), signal, force: true });
        return ok(`Looked at "${short(state.activeWindow?.title, 40)}"`, { window: state.activeWindow?.title, elements: state.elements.length });
      }
      case "keyboard.press": {
        const response = await call("pressKey", { key: String(args.key).toLowerCase(), presses: Number(args.times) || 1 });
        return response.ok ? ok(`Pressed ${args.key}`) : failed(response.error);
      }
      case "keyboard.hotkey": {
        const keys = (args.keys as string[]).map((key) => key.toLowerCase());
        const response = keys.length === 1 ? await call("pressKey", { key: keys[0] }) : await call("hotkey", { keys });
        return response.ok ? ok(`Pressed ${keys.join("+")}`) : failed(response.error);
      }
      case "wait":
        return this.waitFor(args, context, started);
      case "screen.look": {
        const understanding = await this.deps.perception.look({
          target: args.scope === "screen" ? "screen" : "window",
          question: args.question ? String(args.question) : undefined,
          signal,
          onQuotaWait: (ms) => context.onStatus?.(`Waiting ${Math.ceil(ms / 1000)}s for the vision model quota…`),
        });
        return ok("Looked at the screen", {
          summary: understanding.summary,
          answer: understanding.answer,
          loading: understanding.loading,
          login_required: understanding.loginRequired,
          errors: understanding.errors,
          elements: understanding.elements.map((e) => `${e.id} ${e.kind} "${short(e.label, 60)}"`),
          cached: understanding.cached,
        }, { changesUi: false });
      }
      case "screen.locate": {
        const located = await this.deps.perception.locate({
          description: String(args.description),
          target: args.scope === "screen" ? "screen" : "window",
          signal,
          onQuotaWait: (ms) => context.onStatus?.(`Waiting ${Math.ceil(ms / 1000)}s for the vision model quota…`),
        });
        if (located.found === false) {
          return {
            ok: false, tool: definition.name, summary: "Couldn't pinpoint it",
            error: `${located.alternatives.length > 1 ? "AMBIGUOUS_TARGET" : "ELEMENT_NOT_FOUND"}: ${located.reason}`,
            category: located.alternatives.length > 1 ? "AMBIGUOUS_TARGET" : "ELEMENT_NOT_FOUND",
            data: { alternatives: located.alternatives.map((a) => `${a.id} "${short(a.label, 60)}"`) },
            durationMs: Date.now() - started, changesUi: false,
          };
        }
        return ok(`Found ${short(located.element.label, 40)}`, { id: located.element.id, label: located.element.label, confidence: located.element.confidence }, { changesUi: false });
      }
      case "mouse.click_point": {
        const response = await call(args.button === "right" ? "rightClick" : "click", { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) });
        return response.ok ? ok("Clicked a point on the canvas", undefined, { usedPointer: true }) : failed(response.error);
      }
      case "mouse.drag": {
        const from = centerOf(targets.from.rect);
        const to = centerOf(targets.to.rect);
        const response = await call("drag", { start_x: from.x, start_y: from.y, x: to.x, y: to.y, duration: 0.6 });
        return response.ok ? ok(`Dragged "${short(targets.from.name)}" to "${short(targets.to.name)}"`, undefined, { usedPointer: true }) : failed(response.error);
      }
      case "window.focus": {
        const response = await call("windowControl", { title: args.title, action: "focus" });
        if (!response.ok) return failed(response.error);
        const result = response.result as Record<string, unknown>;
        return ok(`Switched to ${short(result.title, 40)}`, compact(result, ["title", "foreground", "minimized"]), {
          verification: { passed: result.foreground === true, evidence: result.foreground ? "Window is in the foreground." : "Window did not come to the foreground.", method: "deterministic" },
        });
      }
      case "window.set": {
        const response = await call("windowControl", { title: args.title, action: args.action, x: args.x, y: args.y, width: args.width, height: args.height });
        if (!response.ok) return failed(response.error);
        const result = response.result as Record<string, unknown>;
        return ok(`${capitalize(String(args.action))} ${short(result.title || args.title, 30)}`, compact(result, ["rect", "minimized", "maximized", "exists"]));
      }
      case "window.list": {
        const response = await call("listVisibleWindows", { limit: 40 });
        if (!response.ok) return failed(response.error);
        const windows = ((response.result as Record<string, unknown>).windows as Array<Record<string, unknown>>) || [];
        return ok(`Checked ${windows.length} windows`, { windows: windows.map((w) => short(w.title, 70)) }, { changesUi: false });
      }
      case "app.launch": {
        const before = new Set((context.state?.windows || []).map((w) => w.title));
        const response = await call("openApplication", { name: args.name });
        if (!response.ok) return failed(response.error);
        await context.scope.sleep(900);
        const after = await call("listVisibleWindows", { limit: 60 });
        const titles = after.ok ? (((after.result as Record<string, unknown>).windows as Array<Record<string, unknown>>) || []).map((w) => String(w.title)) : [];
        const appeared = titles.filter((title) => !before.has(title));
        const matched = titles.some((title) => title.toLowerCase().includes(String(args.name).toLowerCase().split(" ")[0]));
        return ok(`Opened ${short(args.name, 30)}`, { launcher: (response.result as Record<string, unknown>)?.result, new_windows: appeared.slice(0, 5) }, {
          verification: { passed: appeared.length > 0 || matched, evidence: appeared.length ? `New window: ${short(appeared[0], 60)}` : matched ? "A matching window is open." : "No new window appeared yet (it may still be starting).", method: "deterministic" },
        });
      }
      case "app.close": {
        const response = await call("closeApplication", { name: args.name });
        return response.ok ? ok(`Closed ${short(args.name, 30)}`) : failed(response.error);
      }
      case "fs.known_folder": {
        const response = await call("knownFolder", { name: args.name });
        return response.ok ? ok(`Found the ${args.name} folder`, compact(response.result, ["path", "exists"]), { changesUi: false }) : failed(response.error);
      }
      case "fs.list": {
        const response = await call("listFiles", { path: args.path, name: args.path, pattern: args.pattern || "*" });
        if (!response.ok) return failed(response.error);
        return ok(`Checked ${short(args.path, 40)}`, trimList(response.result, 60), { changesUi: false });
      }
      case "fs.recent": {
        const response = await call("recentFiles", { kinds: args.kinds, folders: args.folders, name_contains: args.name_contains, since_hours: args.since_hours, limit: args.limit ?? 15 });
        if (!response.ok) return failed(response.error);
        const files = ((response.result as Record<string, unknown>).files as Array<Record<string, unknown>>) || [];
        return ok(`Found ${files.length} recent file${files.length === 1 ? "" : "s"}`, { files: files.map((f) => ({ path: f.path, kind: f.kind, modified: f.modified, size: f.size })) }, { changesUi: false });
      }
      case "fs.search": {
        const response = await call("searchFiles", { name: args.name, extension: args.extension, folder: args.folder, limit: args.limit ?? 50 });
        return response.ok ? ok("Searched files", trimList(response.result, 50), { changesUi: false }) : failed(response.error);
      }
      case "fs.stat": {
        const response = await call("statPath", { path: args.path });
        return response.ok ? ok(`Checked ${fileName(args.path)}`, response.result, { changesUi: false }) : failed(response.error);
      }
      case "fs.read_text": {
        const response = await call("readFile", { path: args.path, max_chars: args.max_chars ?? 6000 });
        if (!response.ok) return failed(response.error);
        const result = response.result as Record<string, unknown>;
        return ok(`Read ${fileName(args.path)}`, { untrusted_content: String(result.content ?? result.result ?? "").slice(0, Number(args.max_chars) || 6000) }, { changesUi: false });
      }
      case "fs.copy":
      case "fs.move":
      case "fs.rename":
      case "fs.create_text": {
        const tool = { "fs.copy": "copyFile", "fs.move": "moveFile", "fs.rename": "renameFile", "fs.create_text": "createFile" }[definition.name]!;
        const response = await call(tool, { ...args });
        if (!response.ok) return failed(response.error);
        const result = response.result as Record<string, unknown>;
        const destination = String(result.path || result.new_path || result.destination || (definition.name === "fs.rename" ? path.join(path.dirname(String(args.path)), String(args.new_name)) : args.destination || args.path));
        const check = await call("statPath", { path: destination });
        const exists = check.ok && (check.result as Record<string, unknown>).exists === true;
        const change = ({ "fs.copy": "copied", "fs.move": "moved", "fs.rename": "renamed", "fs.create_text": "created" } as const)[definition.name as "fs.copy"];
        return ok(`${capitalize(change)} ${fileName(args.path)}`, { path: destination }, {
          files: [{ path: destination, change, detail: definition.name === "fs.create_text" ? undefined : String(args.path) }],
          verification: { passed: exists, evidence: exists ? `${fileName(destination)} exists.` : `${destination} was not found after the operation.`, method: "deterministic" },
          changesUi: false,
        });
      }
      case "fs.delete": {
        const response = await call("deleteFile", { path: args.path });
        if (!response.ok) return failed(response.error);
        const check = await call("statPath", { path: args.path });
        const gone = check.ok && (check.result as Record<string, unknown>).exists === false;
        return ok(`Moved ${fileName(args.path)} to the Recycle Bin`, undefined, {
          files: [{ path: String(args.path), change: "deleted" }],
          verification: { passed: gone, evidence: gone ? "File no longer exists at the original path." : "File still exists.", method: "deterministic" },
          changesUi: false,
        });
      }
      case "fs.open":
      case "fs.select": {
        const response = await call("selectFiles", { folder: args.folder, extension: args.extension, pattern: args.pattern, names: args.names });
        if (!response.ok) return failed(response.error);
        const result = response.result as Record<string, unknown>;
        const count = Number(result.selected) || 0;
        return ok(String(result.result || `Selected ${count} files`), { selected: count, files: result.files, folder: result.folder }, {
          verification: { passed: count > 0, evidence: count ? `${count} file(s) selected in File Explorer.` : "No file matched.", method: "deterministic" },
        });
      }
      case "fs.reveal": {
        const response = await call("openPath", { path: args.path, ...(definition.name === "fs.reveal" ? { select: true } : {}), ...(args.__executable ? { allow_executable: true } : {}) });
        if (!response.ok) return failed(response.error);
        return ok(`${definition.name === "fs.reveal" ? "Showed" : "Opened"} ${fileName(args.path)}`, undefined, { files: [{ path: String(args.path), change: "opened" }] });
      }
      case "clipboard.copy_files": {
        const response = await call("copyFilesToClipboard", { paths: args.paths });
        return response.ok ? ok(`Copied ${(args.paths as string[]).map(fileName).join(", ")} to the clipboard`) : failed(response.error);
      }
      case "clipboard.write_text": {
        const response = await call("setClipboardText", { text: args.text });
        return response.ok ? ok("Copied text to the clipboard") : failed(response.error);
      }
      case "clipboard.read": {
        const response = await call("getClipboard", { max_chars: 2000 });
        if (!response.ok) return failed(response.error);
        return ok("Read the clipboard", { untrusted_content: String((response.result as Record<string, unknown>)?.text ?? (response.result as Record<string, unknown>)?.result ?? "").slice(0, 2000) }, { changesUi: false });
      }
      case "browser.open": {
        const response = args.new_tab
          ? await this.openInNewTab(String(args.url), call)
          : await call("openWebsite", { url: args.url });
        return response.ok ? ok(`Opened ${hostOf(args.url)}`) : failed(response.error);
      }
      case "browser.search": {
        const response = await call("searchWeb", { query: args.query, engine: args.engine || "google" });
        return response.ok ? ok(`Searched for "${short(args.query, 40)}"`) : failed(response.error);
      }
      case "browser.navigate": {
        const keys: Record<string, string[]> = { back: ["alt", "left"], forward: ["alt", "right"], reload: ["f5"], new_tab: ["ctrl", "t"], close_tab: ["ctrl", "w"] };
        const combo = keys[String(args.action)];
        const response = combo.length === 1 ? await call("pressKey", { key: combo[0] }) : await call("hotkey", { keys: combo });
        return response.ok ? ok(`Browser ${String(args.action).replace("_", " ")}`) : failed(response.error);
      }
      case "web.fetch": {
        const page = await fetchPage(String(args.url), signal);
        return ok(`Read ${hostOf(page.finalUrl)}`, {
          final_url: page.finalUrl,
          title: page.title,
          headings: page.headings.slice(0, 15),
          download_links: page.downloadLinks.slice(0, 15),
          links: page.links.slice(0, 30),
          untrusted_text: page.text.slice(0, 5000),
        }, { changesUi: false });
      }
      case "download.start": {
        const record = await this.deps.downloads.start(String(args.url), {
          filename: args.filename ? String(args.filename) : undefined,
          taskId: context.taskId,
          signal,
          onProgress: (progress) => context.onStatus?.(progress.total
            ? `Downloading ${progress.filename} — ${Math.round((progress.bytes / progress.total) * 100)}%`
            : `Downloading ${progress.filename} — ${(progress.bytes / 1048576).toFixed(1)} MB`),
        });
        this.deps.audit.record(context.taskId, "download", `${record.status === "duplicate" ? "Already downloaded" : "Downloaded"} ${record.filename} from ${hostOf(record.finalUrl || record.url)}`, { sha256: record.sha256, bytes: record.bytes });
        return ok(record.status === "duplicate" ? `${record.filename} was already downloaded` : `Downloaded ${record.filename}`, {
          path: record.path, bytes: record.bytes, sha256: record.sha256, executable: record.executable, source: record.finalUrl || record.url, duplicate: record.status === "duplicate",
        }, {
          files: [{ path: record.path, change: "downloaded", detail: record.finalUrl || record.url }],
          verification: { passed: true, evidence: `File exists (${record.bytes} bytes, size verified${record.total ? " against Content-Length" : ""}).`, method: "deterministic" },
          changesUi: false,
        });
      }
      case "download.wait": {
        const record = await this.deps.downloads.waitForBrowserDownload({
          nameContains: args.name_contains ? String(args.name_contains) : undefined,
          timeoutMs: (Number(args.timeout_seconds) || 300) * 1000,
          signal,
          taskId: context.taskId,
          onProgress: (info) => context.onStatus?.(`Downloading ${info.name} — ${(info.bytes / 1048576).toFixed(1)} MB`),
        });
        this.deps.audit.record(context.taskId, "download", `Browser download finished: ${record.filename}`, { bytes: record.bytes });
        return ok(`Download finished: ${record.filename}`, { path: record.path, bytes: record.bytes, executable: record.executable, sha256: record.sha256 }, {
          files: [{ path: record.path, change: "downloaded", detail: "browser" }],
          verification: { passed: true, evidence: "New complete file present in Downloads and size stable.", method: "deterministic" },
          changesUi: false,
        });
      }
      case "shell.run": {
        const output = await runCommand(String(args.command), { signal, timeoutMs: 60_000 });
        this.deps.audit.record(context.taskId, "action", `Ran command: ${short(args.command, 80)} (exit ${output.exitCode})`);
        return {
          ok: output.exitCode === 0 && !output.timedOut, tool: definition.name, summary: `Ran ${short(String(args.command).split(" ")[0], 20)}`,
          data: { exit_code: output.exitCode, untrusted_stdout: output.stdout.slice(0, 4000), stderr: output.stderr.slice(0, 1000), timed_out: output.timedOut },
          error: output.exitCode === 0 ? undefined : `Command exited with ${output.exitCode}${output.timedOut ? " (timed out)" : ""}`,
          category: output.exitCode === 0 ? undefined : "TOOL_ERROR", durationMs: Date.now() - started, changesUi: false,
        };
      }
      case "system.notify":
        this.deps.notify(String(args.title), String(args.body || ""));
        return ok("Showed a notification", undefined, { changesUi: false });
      case "chat.send": {
        const app = String(args.app || "WhatsApp");
        const opened = await openChat(this.deps.call, app, String(args.name), signal);
        if (!opened.ok) {
          return {
            ok: false, tool: definition.name, summary: "Couldn't open that chat",
            error: opened.error?.startsWith("AMBIGUOUS_TARGET")
              ? `${opened.error} Candidates: ${(opened.candidates || []).join(" · ")}. Ask the user which one, then send again with the exact name.`
              : `ELEMENT_NOT_FOUND: ${opened.error}${opened.candidates?.length ? ` Seen: ${opened.candidates.join(" · ")}.` : ""} Ask the user what name this person is saved under in ${app}.`,
            category: opened.error?.startsWith("AMBIGUOUS_TARGET") ? "AMBIGUOUS_TARGET" : "ELEMENT_NOT_FOUND",
            durationMs: Date.now() - started, changesUi: true,
            data: { candidates: opened.error?.startsWith("AMBIGUOUS_TARGET") ? opened.candidates : [] },
          };
        }
        const sent = await sendInOpenChat(this.deps.call, String(args.text), signal);
        if (!sent.ok) return failed(sent.error, "Couldn't send the message");
        return ok(`Sent "${short(args.text, 30)}" to ${opened.chat} on ${app}`, { chat: opened.chat, app, sent: true }, {
          verification: { passed: sent.verified, evidence: sent.verified ? "The message box emptied after Enter (the message went out)." : "Enter was pressed; the box could not be re-read.", method: "deterministic" },
        });
      }
      case "chat.open": {
        const app = String(args.app || "WhatsApp");
        const opened = await openChat(this.deps.call, app, String(args.name), signal);
        if (!opened.ok) {
          return {
            ok: false, tool: definition.name, summary: "Couldn't open that chat",
            error: opened.error?.startsWith("AMBIGUOUS_TARGET")
              ? `${opened.error} Candidates: ${(opened.candidates || []).join(" · ")}. Ask the user which one (task.ask_user with these as options), then call chat.open with the exact name.`
              : `ELEMENT_NOT_FOUND: ${opened.error}${opened.candidates?.length ? ` Chats/results seen: ${opened.candidates.join(" · ")}. If one of these is the person, call chat.open with that exact name.` : ""} Otherwise ask the user what name this person is saved under in the app, then remember it with memory.remember (kind contact) and call chat.open with that name.`,
            category: opened.error?.startsWith("AMBIGUOUS_TARGET") ? "AMBIGUOUS_TARGET" : "ELEMENT_NOT_FOUND", durationMs: Date.now() - started, changesUi: true,
          };
        }
        return ok(`Opened ${opened.chat}'s chat in ${app}`, { chat: opened.chat, app }, {
          verification: { passed: true, evidence: `Chat header shows ${opened.chat} (a personal chat, not a group).`, method: "deterministic" },
        });
      }
      case "contacts.resolve": {
        const resolution = this.deps.contacts.resolve(String(args.name));
        if (resolution.status === "resolved") {
          const app = String(args.app || "");
          return ok(`"${short(args.name, 20)}" is ${resolution.contact.displayName}`, {
            contact_id: resolution.contact.id,
            display_name: resolution.contact.displayName,
            search_name: app ? this.deps.contacts.nameForApp(resolution.contact, app) : resolution.contact.displayName,
          }, { changesUi: false });
        }
        if (resolution.status === "ambiguous") {
          return {
            ok: false, tool: definition.name, summary: "Not sure who that is",
            error: `AMBIGUOUS_TARGET: "${args.name}" matches ${resolution.candidates.map((c) => c.displayName).join(", ")}. Ask the user which one.`,
            category: "AMBIGUOUS_TARGET", durationMs: Date.now() - started, changesUi: false,
          };
        }
        // Not in ABxAG's own list is normal: the app has the user's real contacts.
        return ok(`"${short(args.name, 20)}" is not in ABxAG's saved contacts — searching the app instead`, {
          saved: false,
          search_name: String(args.name),
          next: "Not a failure. Call chat.open with this name to search the messaging app itself. Never tell the user the contact doesn't exist before chat.open has searched the app.",
        }, { changesUi: false });
      }
      case "memory.remember":
        await this.deps.remember(String(args.fact), String(args.kind));
        return ok("Noted that for next time", undefined, { changesUi: false });
      default:
        return failed(`No executor for ${definition.name}.`);
    }
  }

  private async openInNewTab(url: string, call: (tool: string, args: Record<string, unknown>) => ReturnType<AgentCall>) {
    const tab = await call("hotkey", { keys: ["ctrl", "t"] });
    if (!tab.ok) return tab;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const typed = await call("typeUnicode", { text: url });
    if (!typed.ok) return typed;
    return call("pressKey", { key: "enter" });
  }

  private async waitFor(args: Record<string, unknown>, context: ActionContext, started: number): Promise<ActionResult> {
    const until = String(args.until || "time");
    const deadline = Date.now() + Math.min(20, Math.max(0.2, Number(args.seconds) || 2)) * 1000;
    const value = String(args.value || "").toLowerCase();
    const done = (summary: string, passed: boolean, evidence: string): ActionResult => ({
      ok: passed || until === "time", tool: "wait", summary, durationMs: Date.now() - started, changesUi: false,
      error: passed || until === "time" ? undefined : `LOADING_TIMEOUT: ${evidence}`,
      category: passed || until === "time" ? undefined : "LOADING_TIMEOUT",
      verification: until === "time" ? undefined : { passed, evidence, method: "deterministic" },
    });
    if (until === "time") {
      await context.scope.sleep(deadline - Date.now());
      return done("Waited", true, "");
    }
    let previousCells: string | null = null;
    while (Date.now() < deadline) {
      const signal = context.scope.signal;
      if (until === "loading_done") {
        const hwnd = context.state?.activeWindow?.hwnd;
        const response = await this.deps.call("browserState", hwnd ? { hwnd } : {}, signal);
        if (response.ok && (response.result as Record<string, unknown>).loading !== true) return done("Page loaded", true, "Browser reports loading finished.");
      } else if (until === "title_contains") {
        const response = await this.deps.call("getActiveWindow", {}, signal);
        const title = String((response.result as Record<string, unknown> | undefined)?.title || "").toLowerCase();
        if (title.includes(value)) return done("Window is ready", true, `Active window title contains "${value}".`);
      } else if (until === "element_appears") {
        const response = await this.deps.call("findUi", { query: value, limit: 3 }, signal);
        const elements = response.ok ? ((response.result as Record<string, unknown>).elements as unknown[]) || [] : [];
        if (elements.length) return done(`"${short(value, 30)}" appeared`, true, `Found ${elements.length} control(s) matching "${value}".`);
      } else if (until === "screen_stable") {
        const response = await this.deps.call("screenFingerprint", { target: "screen", columns: 16, rows: 9 }, signal);
        const cells = response.ok ? JSON.stringify((response.result as Record<string, unknown>).cells) : null;
        if (cells && cells === previousCells) return done("Screen settled", true, "Two identical consecutive frames.");
        previousCells = cells;
      }
      await context.scope.sleep(500);
    }
    return done("Still waiting", false, `Condition ${until}${value ? ` "${value}"` : ""} not met in time.`);
  }
}

export function categorize(message: string): FailureCategory {
  const text = message || "";
  if (/ELEMENT_NOT_FOUND|not found|no longer exists|not in the current observation/i.test(text)) return "ELEMENT_NOT_FOUND";
  if (/AMBIGUOUS|appears \d+ times|matches .* and/i.test(text)) return "AMBIGUOUS_TARGET";
  if (/WINDOW_NOT_OPEN|no visible window|no active window|window not found/i.test(text)) return "WINDOW_NOT_OPEN";
  if (/LOADING_TIMEOUT|timed out|UI_TIMEOUT/i.test(text)) return "LOADING_TIMEOUT";
  if (/DOWNLOAD_FAILED|incomplete download|download failed/i.test(text)) return "DOWNLOAD_FAILED";
  if (/permission|access is denied|elevat|not permitted|CONFIRMATION_REQUIRED/i.test(text)) return "PERMISSION_DENIED";
  if (/network|fetch failed|ENOTFOUND|ECONN|offline/i.test(text)) return "NETWORK_FAILURE";
  if (/screen changed|PAGE_CHANGED|stale/i.test(text)) return "PAGE_CHANGED";
  if (/disabled|ACTION_UNSUPPORTED|unexpected/i.test(text)) return "UNEXPECTED_UI";
  if (/Desktop agent is not running|crash|not responding/i.test(text)) return "APPLICATION_CRASHED";
  return "TOOL_ERROR";
}

function describeAction(capability: Capability, action: PlannedAction, context: PermissionContext, definition: ActionDefinition): string {
  switch (capability) {
    case "SEND_MESSAGE": return `Send this message${context.recipient ? ` to ${context.recipient}` : ""}?`;
    case "DELETE_FILE": return `Move ${action.args.path ? fileName(action.args.path) : "this item"} to the Recycle Bin?`;
    case "EXECUTE_DOWNLOAD": return `Run ${fileName(action.args.path)}? It's an installer or script.`;
    case "RUN_COMMAND": return `Run the command: ${short(action.args.command, 80)}?`;
    case "INSTALL_SOFTWARE": return "Continue with this installation?";
    case "PURCHASE": return "This would make a purchase. Continue?";
    case "ACCOUNT_CHANGE": return "This changes your account. Continue?";
    case "MODIFY_SYSTEM_SETTINGS": return "Change this Windows setting?";
    default: return `${CAPABILITY_INFO[capability].label}: ${definition.progress(action.args)}`;
  }
}

function compact(value: unknown, keys: string[]): Record<string, unknown> {
  const record = (value || {}) as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

function trimList(value: unknown, max: number): unknown {
  const record = (value || {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    out[key] = Array.isArray(item) ? item.slice(0, max) : item;
  }
  return out;
}

function centerOf(rect: { left: number; top: number; right: number; bottom: number }) {
  return { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
}

function short(value: unknown, max = 40): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fileName(value: unknown): string {
  return short(String(value ?? "").split(/[\\/]/).pop() || value, 40);
}

function hostOf(value: unknown): string {
  try {
    return new URL(String(value)).hostname.replace(/^www\./, "");
  } catch {
    return short(value, 40);
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

export { summarizeArgs };

