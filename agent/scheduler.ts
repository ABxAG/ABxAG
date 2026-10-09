/**
 * Resource leasing and user-input arbitration.
 *
 * ResourceScheduler
 *   No two components may drive the same physical resource at once. Anything
 *   that moves the pointer, types, drives the browser, speaks or animates the
 *   character acquires a lease first. Leases are exclusive per resource, are
 *   granted in priority order and are always released (or cancelled).
 *
 * InputArbiter
 *   Tracks the user's *physical* input so ABxAG never fights them for the
 *   mouse or keyboard. Physical input arrives from the Electron main process
 *   (Raw Input: synthetic SendInput events carry no device handle). When that
 *   channel is unavailable, the OS idle timer is used and ABxAG's own
 *   synthetic-input windows are subtracted from it.
 */
import { CancelledError } from "./cancellation";

export type ResourceName = "mouse" | "keyboard" | "browser" | "voice" | "character" | "clipboard" | "focus";

export interface Lease {
  id: number;
  owner: string;
  resources: ResourceName[];
  priority: number;
  acquiredAt: number;
  release(): void;
}

interface Waiter {
  id: number;
  owner: string;
  resources: ResourceName[];
  priority: number;
  enqueuedAt: number;
  resolve: (lease: Lease) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class ResourceScheduler {
  private readonly holders = new Map<ResourceName, Lease>();
  private readonly waiters: Waiter[] = [];
  private nextId = 1;

  acquire(
    owner: string,
    resources: ResourceName[],
    options: { priority?: number; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Lease> {
    const unique = [...new Set(resources)];
    const priority = options.priority ?? 5;
    if (options.signal?.aborted) return Promise.reject(new CancelledError("lease_cancelled"));
    if (this.isFree(unique) && !this.hasHigherPriorityWaiter(unique, priority)) {
      return Promise.resolve(this.grant(owner, unique, priority));
    }
    return new Promise<Lease>((resolve, reject) => {
      const id = this.nextId++;
      let timer: NodeJS.Timeout | null = null;
      const onAbort = () => {
        this.removeWaiter(id);
        reject(new CancelledError("lease_cancelled"));
      };
      const waiter: Waiter = {
        id,
        owner,
        resources: unique,
        priority,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      };
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.removeWaiter(id);
          reject(new Error(`Timed out waiting for ${unique.join(", ")} (held by ${this.describeHolders(unique)}).`));
        }, options.timeoutMs);
        timer.unref?.();
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.waiters.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    });
  }

  /** Run `work` while holding the given resources. */
  async withLease<T>(
    owner: string,
    resources: ResourceName[],
    work: (lease: Lease) => Promise<T>,
    options: { priority?: number; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (resources.length === 0) return work(this.grant(owner, [], options.priority ?? 5));
    const lease = await this.acquire(owner, resources, options);
    try {
      return await work(lease);
    } finally {
      lease.release();
    }
  }

  /** Forcibly release everything held by an owner prefix (used by Stop). */
  revokeOwner(prefix: string): number {
    let count = 0;
    // Drop the owner's queued waiters first; releasing a lease pumps the
    // queue and would otherwise hand the resource straight back to them.
    for (const waiter of [...this.waiters]) {
      if (waiter.owner.startsWith(prefix)) {
        this.removeWaiter(waiter.id);
        waiter.reject(new CancelledError("lease_revoked"));
        count += 1;
      }
    }
    for (const lease of new Set(this.holders.values())) {
      if (lease.owner.startsWith(prefix)) {
        lease.release();
        count += 1;
      }
    }
    return count;
  }

  status(): Array<{ resource: ResourceName; owner: string; heldMs: number }> {
    const now = Date.now();
    return [...this.holders.entries()].map(([resource, lease]) => ({
      resource,
      owner: lease.owner,
      heldMs: now - lease.acquiredAt,
    }));
  }

  get queueLength(): number {
    return this.waiters.length;
  }

  private grant(owner: string, resources: ResourceName[], priority: number): Lease {
    let released = false;
    const lease: Lease = {
      id: this.nextId++,
      owner,
      resources,
      priority,
      acquiredAt: Date.now(),
      release: () => {
        if (released) return;
        released = true;
        for (const resource of resources) {
          if (this.holders.get(resource) === lease) this.holders.delete(resource);
        }
        this.pump();
      },
    };
    for (const resource of resources) this.holders.set(resource, lease);
    return lease;
  }

  private pump(): void {
    for (const waiter of [...this.waiters]) {
      if (!this.isFree(waiter.resources)) continue;
      this.removeWaiter(waiter.id);
      waiter.resolve(this.grant(waiter.owner, waiter.resources, waiter.priority));
    }
  }

  private isFree(resources: ResourceName[]): boolean {
    return resources.every((resource) => !this.holders.has(resource));
  }

  private hasHigherPriorityWaiter(resources: ResourceName[], priority: number): boolean {
    return this.waiters.some((waiter) => waiter.priority > priority && waiter.resources.some((r) => resources.includes(r)));
  }

  private removeWaiter(id: number): void {
    const index = this.waiters.findIndex((waiter) => waiter.id === id);
    if (index >= 0) {
      this.waiters[index].cleanup();
      this.waiters.splice(index, 1);
    }
  }

  private describeHolders(resources: ResourceName[]): string {
    return resources.map((resource) => this.holders.get(resource)?.owner).filter(Boolean).join(", ") || "queue";
  }
}

export interface InputSample {
  kind: "mouse" | "keyboard";
  at: number;
  /** Pointer travel in physical pixels since the previous sample (mouse only). */
  distance?: number;
}

export interface UserActivityVerdict {
  active: boolean;
  /** "strong" = sustained, deliberate use (several events / large pointer travel). */
  strength: "none" | "light" | "strong";
  lastPhysicalInputAt: number;
  source: "raw-input" | "os-idle" | "none";
  /** The user typed on the keyboard in the window (not just moved the mouse). */
  keyboard?: boolean;
}

export class InputArbiter {
  private lastPhysicalAt = 0;
  private lastKind: "mouse" | "keyboard" | null = null;
  private readonly recent: InputSample[] = [];
  private rawInputAvailable = false;
  private osIdleProbe: (() => Promise<number | null>) | null = null;
  private readonly syntheticWindows: Array<{ start: number; end: number }> = [];
  private readonly listeners = new Set<(sample: InputSample) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Raw Input samples from Electron main; synthetic input is already excluded. */
  recordPhysicalInput(sample: InputSample): void {
    this.rawInputAvailable = true;
    this.lastPhysicalAt = Math.max(this.lastPhysicalAt, sample.at);
    this.lastKind = sample.kind;
    this.recent.push(sample);
    const cutoff = this.now() - 10_000;
    while (this.recent.length && this.recent[0].at < cutoff) this.recent.shift();
    for (const listener of this.listeners) listener(sample);
  }

  onPhysicalInput(listener: (sample: InputSample) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setOsIdleProbe(probe: () => Promise<number | null>): void {
    this.osIdleProbe = probe;
  }

  /** Wrap ABxAG's own synthetic input so the idle-timer fallback can ignore it. */
  markSynthetic(start: number, end: number): void {
    this.syntheticWindows.push({ start, end: end + 250 });
    const cutoff = this.now() - 30_000;
    while (this.syntheticWindows.length && this.syntheticWindows[0].end < cutoff) this.syntheticWindows.shift();
  }

  get hasRawInput(): boolean {
    return this.rawInputAvailable;
  }

  get lastPhysicalInputAt(): number {
    return this.lastPhysicalAt;
  }

  async userActivity(windowMs = 1_500): Promise<UserActivityVerdict> {
    const now = this.now();
    if (this.rawInputAvailable) {
      const recent = this.recent.filter((sample) => now - sample.at <= windowMs);
      const travel = recent.reduce((sum, sample) => sum + (sample.distance || 0), 0);
      const keys = recent.filter((sample) => sample.kind === "keyboard").length;
      const strength = recent.length === 0
        ? "none"
        : travel > 400 || keys >= 3 || recent.length >= 12 ? "strong" : "light";
      return { active: recent.length > 0, strength, lastPhysicalInputAt: this.lastPhysicalAt, source: "raw-input", keyboard: keys > 0 };
    }
    if (!this.osIdleProbe) return { active: false, strength: "none", lastPhysicalInputAt: 0, source: "none" };
    const idleMs = await this.osIdleProbe().catch(() => null);
    if (idleMs === null) return { active: false, strength: "none", lastPhysicalInputAt: 0, source: "none" };
    const lastInputAt = now - idleMs;
    const explainedBySynthetic = this.syntheticWindows.some((w) => lastInputAt >= w.start && lastInputAt <= w.end);
    const active = idleMs <= windowMs && !explainedBySynthetic;
    if (active) this.lastPhysicalAt = Math.max(this.lastPhysicalAt, lastInputAt);
    return { active, strength: active ? "light" : "none", lastPhysicalInputAt: this.lastPhysicalAt, source: "os-idle", keyboard: active };
  }

  status() {
    return {
      rawInputAvailable: this.rawInputAvailable,
      lastPhysicalInputAt: this.lastPhysicalAt,
      lastKind: this.lastKind,
      recentSamples: this.recent.length,
    };
  }
}

