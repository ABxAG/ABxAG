/**
 * Connectivity awareness. Cloud failures flagged as NETWORK flip the monitor
 * to "suspect"; a cheap DNS probe confirms. While offline, cloud models are
 * skipped instead of retried, and the probe backs off.
 */
import dns from "node:dns/promises";

export type NetworkState = "online" | "offline" | "unknown";

export class NetworkMonitor {
  private state: NetworkState = "unknown";
  private lastProbeAt = 0;
  private probing: Promise<NetworkState> | null = null;
  private readonly listeners = new Set<(state: NetworkState) => void>();

  constructor(
    private readonly probeHost = "generativelanguage.googleapis.com",
    private readonly lookup: (host: string) => Promise<unknown> = (host) => dns.lookup(host),
  ) {}

  get current(): NetworkState {
    return this.state;
  }

  onChange(listener: (state: NetworkState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  markSuccess(): void {
    this.set("online");
  }

  /** Called on a NETWORK-class failure; returns the confirmed state. */
  async markNetworkFailure(): Promise<NetworkState> {
    return this.probe(true);
  }

  async probe(force = false): Promise<NetworkState> {
    const minInterval = this.state === "offline" ? 15_000 : 5_000;
    if (!force && Date.now() - this.lastProbeAt < minInterval) return this.state;
    if (this.probing) return this.probing;
    this.lastProbeAt = Date.now();
    this.probing = (async () => {
      try {
        await Promise.race([
          this.lookup(this.probeHost),
          new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 3_000).unref?.()),
        ]);
        this.set("online");
      } catch {
        this.set("offline");
      } finally {
        this.probing = null;
      }
      return this.state;
    })();
    return this.probing;
  }

  private set(state: NetworkState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
