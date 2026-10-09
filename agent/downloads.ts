/**
 * Download manager.
 *
 * Downloads are tasks with a recorded source, progress, destination and a
 * verified result (file exists, size matches, SHA-256). Downloading and
 * executing are separate: executables/installers/scripts are flagged and
 * never opened here. Browser-initiated downloads are tracked by watching the
 * Downloads folder for a new, size-stable, non-partial file.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";
import { safeFetch } from "../shared/netSafety";

export interface DownloadRecord {
  id: string;
  url: string;
  finalUrl: string | null;
  source: "direct" | "browser";
  filename: string;
  path: string;
  bytes: number;
  total: number | null;
  status: "downloading" | "completed" | "failed" | "cancelled" | "duplicate";
  executable: boolean;
  mime: string | null;
  sha256: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  taskId: string | null;
}

const EXECUTABLE = /\.(exe|msi|msix|appx|bat|cmd|ps1|vbs|js|jse|wsf|scr|com|jar|reg|hta|cpl|dmg|pkg|sh)$/i;
const PARTIAL = /\.(crdownload|part|partial|tmp|download)$/i;

export class DownloadManager {
  private records: DownloadRecord[] = [];
  private readonly file: string;

  constructor(dataDir: string, private readonly downloadsDir: () => Promise<string>) {
    this.file = path.join(dataDir, "downloads", "history.v1.json");
  }

  async initialize(): Promise<void> {
    const stored = await readJsonFile<{ records: DownloadRecord[] }>(this.file, { records: [] });
    this.records = (stored.records || []).map((record) => record.status === "downloading" ? { ...record, status: "failed" as const, error: "Interrupted by restart." } : record);
  }

  list(limit = 50): DownloadRecord[] {
    return this.records.slice(-limit).reverse();
  }

  get(id: string): DownloadRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  async start(url: string, options: { filename?: string; taskId?: string | null; signal?: AbortSignal; onProgress?: (record: DownloadRecord) => void; force?: boolean } = {}): Promise<DownloadRecord> {
    const directory = await this.downloadsDir();
    const response = await safeFetch(url, { signal: options.signal, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ABxAG/2.0" } });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}.`);
    const finalUrl = (response as Response & { finalUrl?: string }).finalUrl || url;
    const mime = response.headers.get("content-type");
    if (mime && /text\/html/i.test(mime)) {
      await response.body.cancel().catch(() => {});
      throw new Error("That URL is a web page, not a file. Find the direct download link first.");
    }
    const total = Number(response.headers.get("content-length")) || null;
    const filename = sanitizeFilename(options.filename || filenameFromHeaders(response.headers.get("content-disposition")) || path.basename(new URL(finalUrl).pathname) || "download.bin");

    // Duplicate detection: same source and size already completed and present.
    const duplicate = this.records.find((record) => record.status === "completed" && (record.url === url || record.finalUrl === finalUrl)
      && (!total || record.total === total) && fs.existsSync(record.path));
    if (duplicate && !options.force) {
      await response.body.cancel().catch(() => {});
      const record: DownloadRecord = { ...duplicate, id: randomUUID(), status: "duplicate", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), taskId: options.taskId ?? null };
      this.push(record);
      return record;
    }

    const target = uniquePath(path.join(directory, filename));
    const partial = `${target}.part`;
    const record: DownloadRecord = {
      id: randomUUID(), url, finalUrl, source: "direct", filename: path.basename(target), path: target,
      bytes: 0, total, status: "downloading", executable: EXECUTABLE.test(target), mime, sha256: null, error: null,
      startedAt: new Date().toISOString(), completedAt: null, taskId: options.taskId ?? null,
    };
    this.push(record);
    const hash = createHash("sha256");
    const out = fs.createWriteStream(partial);
    let lastEmit = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        if (options.signal?.aborted) throw Object.assign(new Error("Download cancelled."), { cancelled: true });
        const { value, done } = await reader.read();
        if (done) break;
        hash.update(value);
        record.bytes += value.byteLength;
        if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
        if (Date.now() - lastEmit > 400) {
          lastEmit = Date.now();
          options.onProgress?.({ ...record });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
      if (total && record.bytes !== total) throw new Error(`Incomplete download (${record.bytes} of ${total} bytes).`);
      await fsp.rename(partial, target);
      const stat = await fsp.stat(target);
      record.status = "completed";
      record.bytes = stat.size;
      record.sha256 = hash.digest("hex");
      record.completedAt = new Date().toISOString();
      this.persist();
      options.onProgress?.({ ...record });
      return { ...record };
    } catch (error) {
      out.destroy();
      await fsp.rm(partial, { force: true }).catch(() => {});
      record.status = (error as { cancelled?: boolean }).cancelled ? "cancelled" : "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = new Date().toISOString();
      this.persist();
      throw error;
    }
  }

  /** Wait for a browser download to land in Downloads and become stable. */
  async waitForBrowserDownload(options: { nameContains?: string; timeoutMs?: number; signal?: AbortSignal; since?: number; taskId?: string | null; onProgress?: (info: { name: string; bytes: number; partial: boolean }) => void } = {}): Promise<DownloadRecord> {
    const directory = await this.downloadsDir();
    const since = options.since ?? Date.now() - 5_000;
    const deadline = Date.now() + (options.timeoutMs ?? 300_000);
    const wanted = (options.nameContains || "").toLowerCase();
    const sizes = new Map<string, number>();
    let sawPartial = false;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error("Cancelled.");
      const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
      const fresh: Array<{ name: string; full: string; size: number; mtime: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (wanted && !entry.name.toLowerCase().includes(wanted)) continue;
        const full = path.join(directory, entry.name);
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat || Math.max(stat.mtimeMs, stat.birthtimeMs) < since) continue;
        fresh.push({ name: entry.name, full, size: stat.size, mtime: stat.mtimeMs });
      }
      const partial = fresh.find((item) => PARTIAL.test(item.name));
      if (partial) {
        sawPartial = true;
        options.onProgress?.({ name: partial.name.replace(PARTIAL, ""), bytes: partial.size, partial: true });
      }
      const complete = fresh.filter((item) => !PARTIAL.test(item.name)).sort((a, b) => b.mtime - a.mtime)[0];
      if (complete && !partial) {
        const previous = sizes.get(complete.full);
        if (previous === complete.size && complete.size > 0) {
          const record: DownloadRecord = {
            id: randomUUID(), url: "", finalUrl: null, source: "browser", filename: complete.name, path: complete.full,
            bytes: complete.size, total: null, status: "completed", executable: EXECUTABLE.test(complete.name),
            mime: null, sha256: await sha256File(complete.full), error: null,
            startedAt: new Date(since).toISOString(), completedAt: new Date().toISOString(), taskId: options.taskId ?? null,
          };
          this.push(record);
          return record;
        }
        sizes.set(complete.full, complete.size);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(sawPartial ? "LOADING_TIMEOUT: the download is still in progress." : "DOWNLOAD_FAILED: no new file appeared in Downloads.");
  }

  private push(record: DownloadRecord): void {
    this.records.push(record);
    if (this.records.length > 200) this.records.splice(0, this.records.length - 200);
    this.persist();
  }

  private persist(): void {
    void writeJsonFile(this.file, { records: this.records }).catch(() => {});
  }
}

export function sanitizeFilename(value: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  const cleaned = decoded.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 180);
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
  return !cleaned || reserved.test(cleaned) ? `download_${Date.now()}` : cleaned;
}

function filenameFromHeaders(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = disposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (star) return star[1].trim().replace(/^"|"$/g, "");
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

function uniquePath(target: string): string {
  if (!fs.existsSync(target) && !fs.existsSync(`${target}.part`)) return target;
  const extension = path.extname(target);
  const base = target.slice(0, target.length - extension.length);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base} (${index})${extension}`;
    if (!fs.existsSync(candidate) && !fs.existsSync(`${candidate}.part`)) return candidate;
  }
  return `${base}-${Date.now()}${extension}`;
}

async function sha256File(file: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve()).on("error", reject);
    });
    return hash.digest("hex");
  } catch {
    return null;
  }
}

