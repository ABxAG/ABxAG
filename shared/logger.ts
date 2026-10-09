/**
 * Structured JSON-lines logger with redaction and an in-memory ring buffer
 * that powers the developer view. Logging never throws.
 */
import fs from "node:fs";
import path from "node:path";
import { redact, redactText } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

class LogHub {
  private dir: string | null = null;
  private readonly ring: LogEntry[] = [];
  private minLevel: LogLevel = (process.env.ABxAG_LOG_LEVEL as LogLevel) || "info";
  private readonly listeners = new Set<(entry: LogEntry) => void>();

  configure(dir: string, minLevel?: LogLevel): void {
    this.dir = dir;
    if (minLevel) this.minLevel = minLevel;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }

  write(level: LogLevel, component: string, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component,
      message: redactText(message, 600),
      ...(data === undefined ? {} : { data: redact(data) }),
    };
    this.ring.push(entry);
    if (this.ring.length > 500) this.ring.splice(0, this.ring.length - 500);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* ignore */
      }
    }
    if (!this.dir) return;
    try {
      fs.appendFile(path.join(this.dir, "abxag.jsonl"), `${JSON.stringify(entry)}\n`, () => {});
    } catch {
      /* best-effort */
    }
  }

  recent(limit = 200, minLevel: LogLevel = "debug"): LogEntry[] {
    return this.ring.filter((entry) => LEVEL_ORDER[entry.level] >= LEVEL_ORDER[minLevel]).slice(-limit);
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const logHub = new LogHub();

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export function createLogger(component: string): Logger {
  return {
    debug: (message, data) => logHub.write("debug", component, message, data),
    info: (message, data) => logHub.write("info", component, message, data),
    warn: (message, data) => logHub.write("warn", component, message, data),
    error: (message, data) => logHub.write("error", component, message, data),
  };
}



