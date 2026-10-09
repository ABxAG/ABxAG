/**
 * Confirmation broker.
 *
 * A request is published to every UI window (and may be answered by voice
 * through the Live session). Exactly one answer is accepted. Requests expire,
 * and cancelling the owning scope rejects them, so a Stop never leaves an
 * approval dangling that could later execute an action.
 */
import { randomUUID } from "node:crypto";
import { appEvents } from "../shared/appEvents";
import type { Capability } from "./types";

export interface ConfirmationRequest {
  id: string;
  taskId: string | null;
  capability: Capability;
  title: string;
  description: string;
  details: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  allowRemember: boolean;
}

export interface ConfirmationAnswer {
  approved: boolean;
  remember?: "once" | "session";
  via: "ui" | "voice" | "api" | "timeout" | "cancel";
}

interface Pending {
  request: ConfirmationRequest;
  resolve: (answer: ConfirmationAnswer) => void;
  timer: NodeJS.Timeout;
}

export class ConfirmationBroker {
  private readonly pending = new Map<string, Pending>();

  request(
    input: Omit<ConfirmationRequest, "id" | "createdAt" | "expiresAt">,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): { request: ConfirmationRequest; answer: Promise<ConfirmationAnswer> } {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const created = Date.now();
    const request: ConfirmationRequest = {
      ...input,
      id: randomUUID(),
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + timeoutMs).toISOString(),
    };
    const answer = new Promise<ConfirmationAnswer>((resolve) => {
      const timer = setTimeout(() => this.resolve(request.id, { approved: false, via: "timeout" }), timeoutMs);
      timer.unref?.();
      this.pending.set(request.id, { request, resolve, timer });
      options.signal?.addEventListener("abort", () => this.resolve(request.id, { approved: false, via: "cancel" }), { once: true });
    });
    appEvents.publish("confirmation.requested", request);
    return { request, answer };
  }

  resolve(id: string, answer: ConfirmationAnswer): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(answer);
    appEvents.publish("confirmation.resolved", { id, approved: answer.approved, via: answer.via, taskId: pending.request.taskId });
    return true;
  }

  /** Answer the most recent pending request (used for spoken "haan"/"nahi"). */
  resolveLatest(answer: ConfirmationAnswer, taskId?: string): ConfirmationRequest | null {
    const candidates = [...this.pending.values()]
      .filter((item) => !taskId || item.request.taskId === taskId)
      .sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt));
    const latest = candidates[0];
    if (!latest) return null;
    this.resolve(latest.request.id, answer);
    return latest.request;
  }

  cancelAll(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.resolve(id, { approved: false, via: "cancel" });
    return ids.length;
  }

  list(): ConfirmationRequest[] {
    return [...this.pending.values()].map((item) => item.request);
  }
}
