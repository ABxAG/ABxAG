/**
 * Append-only activity audit.
 *
 * Concise, human-readable records of what autonomous tasks did: requests,
 * important actions, errors, recoveries, permission decisions, file changes
 * and results. Never raw model reasoning, never secrets (all text is redacted).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactText } from "../shared/redact";

export type AuditKind =
  | "task.started"
  | "task.finished"
  | "action"
  | "error"
  | "recovery"
  | "permission"
  | "file"
  | "download"
  | "system";

export interface AuditEntry {
  at: string;
  taskId: string | null;
  kind: AuditKind;
  summary: string;
  detail?: Record<string, string | number | boolean | null>;
}

const MAX_BYTES = 5 * 1024 * 1024;

export class AuditLog {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "audit", "activity.jsonl");
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      /* best-effort */
    }
  }

  record(taskId: string | null, kind: AuditKind, summary: string, detail?: AuditEntry["detail"]): void {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      taskId,
      kind,
      summary: redactText(summary, 300),
      ...(detail ? { detail: Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === "string" ? redactText(v, 200) : v])) } : {}),
    };
    try {
      const stat = fs.existsSync(this.file) ? fs.statSync(this.file) : null;
      if (stat && stat.size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch {
      /* auditing must never break execution */
    }
  }

  async recent(limit = 200, taskId?: string): Promise<AuditEntry[]> {
    try {
      const raw = await fsp.readFile(this.file, "utf-8");
      const entries = raw.split("\n").filter(Boolean).map((line) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return null;
        }
      }).filter((entry): entry is AuditEntry => Boolean(entry));
      return (taskId ? entries.filter((entry) => entry.taskId === taskId) : entries).slice(-limit);
    } catch {
      return [];
    }
  }
}
