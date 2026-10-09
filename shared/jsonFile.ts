/**
 * Small, dependency-free persistence helpers shared by every backend store.
 *
 * Writes go to a temporary file followed by an atomic rename so a crash can
 * never leave a half-written JSON document behind. Writes to the same path are
 * serialised so concurrent saves cannot interleave.
 */
import fs from "node:fs/promises";
import path from "node:path";

const writeChains = new Map<string, Promise<void>>();

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw.replace(/^﻿/, "")) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      // Preserve the corrupt document for inspection instead of discarding it.
      await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      return fallback;
    }
    throw error;
  }
}

export function writeJsonFile(file: string, value: unknown): Promise<void> {
  const previous = writeChains.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf-8");
    await fs.rename(temp, file);
  });
  writeChains.set(file, next);
  void next.finally(() => {
    if (writeChains.get(file) === next) writeChains.delete(file);
  }).catch(() => {});
  return next;
}

/** Debounced writer for stores that change frequently. */
export class DebouncedJsonWriter {
  private timer: NodeJS.Timeout | null = null;
  private pending: (() => unknown) | null = null;

  constructor(private readonly file: string, private readonly delayMs = 400) {}

  schedule(snapshot: () => unknown): void {
    this.pending = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = this.pending;
    this.pending = null;
    if (snapshot) await writeJsonFile(this.file, snapshot());
  }
}
