/**
 * Self-recovery.
 *
 * Failures are categorized; each category has an escalating list of
 * strategies (fed to the planner as guidance) and a retry budget. Identical
 * failing actions on an unchanged screen are detected as a loop. When a
 * budget or the global failure ceiling is exhausted, the task escalates to the
 * user instead of retrying forever.
 */
import type { FailureCategory } from "./taskSession";

export const RETRY_BUDGET: Record<FailureCategory, number> = {
  ELEMENT_NOT_FOUND: 4,
  WINDOW_NOT_OPEN: 3,
  PAGE_CHANGED: 4,
  LOADING_TIMEOUT: 3,
  DOWNLOAD_FAILED: 2,
  PERMISSION_DIALOG: 1,
  PERMISSION_DENIED: 2,
  NETWORK_FAILURE: 2,
  AMBIGUOUS_TARGET: 2,
  APPLICATION_CRASHED: 2,
  USER_INTERRUPTED: 4,
  UNEXPECTED_UI: 4,
  INVALID_ACTION: 3,
  MODEL_FAILURE: 3,
  TOOL_ERROR: 3,
  VERIFICATION_FAILED: 3,
};

const STRATEGIES: Record<FailureCategory, string[]> = {
  ELEMENT_NOT_FOUND: [
    "The UI changed or the target isn't in the list: look for it again in the NEW observation (IDs changed).",
    "Search with ui.find using a shorter or different visible label, or scroll the container.",
    "Use screen.locate to find it visually.",
    "Use a keyboard route instead (ctrl+l address bar, ctrl+f find, tab navigation, the app's search box).",
  ],
  WINDOW_NOT_OPEN: [
    "Check window.list — the app may use a different title — then window.focus it.",
    "Launch it with app.launch and wait until its window appears (wait until=title_contains).",
    "Try an alternative app that achieves the same goal (e.g. the web version).",
  ],
  PAGE_CHANGED: [
    "The screen changed after the target was found. Re-locate it on the current screen.",
    "Wait for the screen to settle (wait until=screen_stable) and observe again.",
  ],
  LOADING_TIMEOUT: [
    "Give it more time: wait until=loading_done or screen_stable (up to 15s).",
    "Reload once (browser.navigate reload) or reopen the page.",
    "Check the connection; if the site is down, tell the user.",
  ],
  DOWNLOAD_FAILED: [
    "Verify the link is a direct file URL (web.fetch the page and pick a link from download_links).",
    "Start the download through the browser instead and use download.wait.",
  ],
  PERMISSION_DIALOG: [
    "A Windows/security dialog needs the user. Ask them (task.ask_user) — never click through security prompts for them.",
  ],
  PERMISSION_DENIED: [
    "Do not retry the denied action. Find another permitted way, or finish with success=false and explain.",
  ],
  NETWORK_FAILURE: [
    "Wait a few seconds and retry once.",
    "The internet seems down: finish with success=false and tell the user.",
  ],
  AMBIGUOUS_TARGET: [
    "Several things match. Ask the user which one (task.ask_user) and list the options.",
  ],
  APPLICATION_CRASHED: [
    "The app or ABxAG's desktop helper stopped responding. Relaunch the app once and continue from the current state.",
  ],
  USER_INTERRUPTED: [
    "The user is using the PC. Prefer actions that don't move the mouse (ui.click uses accessibility patterns) or wait.",
  ],
  UNEXPECTED_UI: [
    "Something unexpected is on screen. Use screen.look to understand it (popup? login? error? cookie banner?).",
    "Dismiss an irrelevant popup with escape (or its close button), then observe again.",
    "Take a different route to the same goal.",
  ],
  INVALID_ACTION: [
    "Use only listed actions, valid JSON args_json, and element IDs from the latest observation.",
  ],
  MODEL_FAILURE: [
    "The planning model failed; retrying with a smaller context.",
  ],
  TOOL_ERROR: [
    "The action reported an error. Read the error and try a different method.",
    "Use screen.look to check what actually happened.",
  ],
  VERIFICATION_FAILED: [
    "The previous step did not have the expected effect. Try a different method instead of repeating it.",
    "Use screen.look to see the real state.",
  ],
};

export interface RecoveryAdvice {
  category: FailureCategory;
  attempt: number;
  guidance: string;
  escalate: boolean;
  reason?: string;
}

export class RecoveryEngine {
  private readonly attempts = new Map<FailureCategory, number>();
  private consecutive = 0;
  private readonly recentActions: string[] = [];

  constructor(private readonly maxConsecutiveFailures = 5) {}

  /** Record the outcome of an action. Returns advice when it failed. */
  record(tool: string, args: Record<string, unknown>, ok: boolean, category: FailureCategory | undefined, screenChanged: boolean): RecoveryAdvice | null {
    const signature = `${tool}:${JSON.stringify(args)}`;
    if (ok) {
      this.consecutive = 0;
      this.recentActions.push(signature);
      if (this.recentActions.length > 12) this.recentActions.shift();
      return null;
    }
    const kind: FailureCategory = category || "TOOL_ERROR";
    const attempt = (this.attempts.get(kind) || 0) + 1;
    this.attempts.set(kind, attempt);
    this.consecutive += 1;
    const repeats = this.recentActions.filter((item) => item === signature).length;
    this.recentActions.push(signature);
    if (this.recentActions.length > 12) this.recentActions.shift();

    const strategies = STRATEGIES[kind];
    const guidance = strategies[Math.min(strategies.length - 1, attempt - 1)];
    if (kind === "AMBIGUOUS_TARGET" || kind === "PERMISSION_DIALOG") {
      return { category: kind, attempt, guidance, escalate: attempt > RETRY_BUDGET[kind], reason: "Needs the user's input." };
    }
    if (attempt > RETRY_BUDGET[kind]) {
      return { category: kind, attempt, guidance, escalate: true, reason: `Tried ${attempt - 1} times (${kind.toLowerCase().replace(/_/g, " ")}).` };
    }
    if (this.consecutive >= this.maxConsecutiveFailures) {
      return { category: kind, attempt, guidance, escalate: true, reason: `${this.consecutive} failures in a row.` };
    }
    if (repeats >= 2 && !screenChanged) {
      return { category: kind, attempt, guidance: `You repeated the same failing action ${repeats + 1} times on an unchanged screen. ${guidance}`, escalate: repeats >= 3, reason: "Stuck repeating the same action." };
    }
    return { category: kind, attempt, guidance, escalate: false };
  }

  /** The planner claimed success but the next observation contradicted it. */
  verificationFailed(): RecoveryAdvice {
    return this.record("__verification__", { at: this.consecutive }, false, "VERIFICATION_FAILED", true)!;
  }

  snapshot() {
    return { attempts: Object.fromEntries(this.attempts), consecutive: this.consecutive };
  }
}

