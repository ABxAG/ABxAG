/** Dual-cursor shared contract: physical = user, virtual = software. */

export type VirtualStatus = "idle" | "active" | "paused";

export interface VirtualCursorState {
  x: number;
  y: number;
  visible: boolean;
  status: VirtualStatus;
  task: string;
  paused: boolean;
}

export const VIRTUAL_TOOLS = [
  "virtualMove",
  "virtualClick",
  "virtualRightClick",
  "virtualDoubleClick",
  "virtualType",
  "virtualScroll",
  "virtualInspect",
  "virtualFind",
  "virtualUiAction",
  "virtualStatus",
  "pauseVirtual",
  "resumeVirtual",
] as const;

export type VirtualUiAction =
  | "invoke" | "focus" | "set_value" | "toggle"
  | "expand" | "collapse" | "select" | "scroll_into_view";

/** FIFO single-flight queue so virtual clicks never fight the user. */
export class VirtualEventQueue {
  private queue: Array<() => Promise<unknown>> = [];
  private running = false;
  paused = false;

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
      void this.pump();
    });
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    void this.pump();
  }
  clear() {
    this.queue = [];
  }

  private async pump() {
    if (this.running || this.paused) return;
    this.running = true;
    while (this.queue.length && !this.paused) {
      const job = this.queue.shift()!;
      try {
        await job();
      } catch {
        /* per-job error already propagated */
      }
    }
    this.running = false;
  }
}
