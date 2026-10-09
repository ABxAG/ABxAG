/**
 * Hierarchical cancellation.
 *
 * Every autonomous operation runs inside a CancellationScope. Scopes form a
 * tree rooted at the process-wide `rootScope`; cancelling a scope aborts every
 * descendant (planner calls, model requests, desktop actions, downloads, TTS),
 * which is what makes the emergency Stop a single, guaranteed operation.
 *
 * A scope wraps a standard AbortController so it composes with fetch(), the
 * Gemini SDK (`abortSignal`) and every other AbortSignal-aware API.
 */

export class CancelledError extends Error {
  constructor(readonly reason: string = "cancelled") {
    super(`Operation cancelled: ${reason}`);
    this.name = "CancelledError";
  }
}

export function isCancelledError(error: unknown): boolean {
  return error instanceof CancelledError
    || (error instanceof Error && (error.name === "AbortError" || error.name === "CancelledError"));
}

export class CancellationScope {
  private readonly controller = new AbortController();
  private readonly children = new Set<CancellationScope>();
  private readonly listeners = new Set<(reason: string) => void>();
  private cancelReason: string | null = null;

  constructor(readonly label: string, private readonly parent: CancellationScope | null = null) {
    if (parent) {
      if (parent.cancelled) {
        this.cancel(parent.cancelReason || "parent_cancelled");
      } else {
        parent.children.add(this);
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.cancelReason !== null;
  }

  get reason(): string | null {
    return this.cancelReason;
  }

  /** Create a child scope that is cancelled whenever this scope is. */
  child(label: string): CancellationScope {
    return new CancellationScope(label, this);
  }

  /** Cancel this scope and every descendant. Idempotent. Returns the number of scopes cancelled. */
  cancel(reason = "cancelled"): number {
    if (this.cancelReason !== null) return 0;
    this.cancelReason = reason;
    let count = 1;
    for (const child of [...this.children]) count += child.cancel(reason);
    this.children.clear();
    try {
      this.controller.abort(new CancelledError(reason));
    } catch {
      /* abort never throws in practice */
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(reason);
      } catch {
        /* listeners must not break cancellation */
      }
    }
    this.listeners.clear();
    this.parent?.children.delete(this);
    return count;
  }

  /** Cancel all children but keep this scope alive (used by the root on Stop). */
  cancelChildren(reason = "cancelled"): number {
    let count = 0;
    for (const child of [...this.children]) count += child.cancel(reason);
    return count;
  }

  /** Detach from the parent once finished so completed scopes do not accumulate. */
  dispose(): void {
    this.parent?.children.delete(this);
    this.listeners.clear();
  }

  onCancel(listener: (reason: string) => void): () => void {
    if (this.cancelReason !== null) {
      listener(this.cancelReason);
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  throwIfCancelled(): void {
    if (this.cancelReason !== null) throw new CancelledError(this.cancelReason);
  }

  get activeChildCount(): number {
    return this.children.size;
  }

  /** Await a promise, rejecting immediately if this scope is cancelled first. */
  async race<T>(promise: Promise<T>): Promise<T> {
    this.throwIfCancelled();
    let unsubscribe: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      unsubscribe = this.onCancel((reason) => reject(new CancelledError(reason)));
    });
    try {
      return await Promise.race([promise, cancelled]);
    } finally {
      unsubscribe();
    }
  }

  /** Cancellable sleep. */
  sleep(ms: number): Promise<void> {
    return this.race(new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      timer.unref?.();
    }));
  }
}

/** Process-wide root. The emergency stop cancels its children. */
export const rootScope = new CancellationScope("root");
