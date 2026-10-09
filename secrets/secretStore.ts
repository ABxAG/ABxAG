/**
 * OS-protected secret storage.
 *
 * Windows: values are encrypted with DPAPI (ProtectedData, CurrentUser scope)
 * so the stored file is useless to other accounts and other machines. The
 * secret travels to PowerShell over stdin, never on a command line.
 * Other platforms: owner-only (0600) file, documented as weaker.
 *
 * Decrypted values are cached in this backend process only. They are never
 * sent to a renderer; the UI only learns whether a secret exists.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface StoredSecret {
  protection: "dpapi" | "plain-0600";
  data: string;
  updatedAt: string;
}

interface SecretFile {
  version: 2;
  entries: Record<string, StoredSecret>;
}

const PS_ENCRYPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$plain=[Console]::In.ReadToEnd()",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($plain)",
  "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($protected))",
].join(";");

const PS_DECRYPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$b64=[Console]::In.ReadToEnd().Trim()",
  "$bytes=[Convert]::FromBase64String($b64)",
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($plain))",
].join(";");

function runPowerShell(script: string, input: string): string {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { input, encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  if (result.status !== 0) {
    throw new Error(`DPAPI operation failed: ${(result.stderr || "").trim().split("\n")[0] || `exit ${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

export class SecretStore {
  private readonly file: string;
  private readonly cache = new Map<string, string>();
  private loaded = false;
  private store: SecretFile = { version: 2, entries: {} };

  constructor(private readonly dataDir: string, private readonly platform = process.platform) {
    this.file = path.join(dataDir, "secrets.v2.json");
  }

  get protection(): StoredSecret["protection"] {
    return this.platform === "win32" ? "dpapi" : "plain-0600";
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as SecretFile;
        if (parsed?.version === 2 && parsed.entries) this.store = parsed;
      }
    } catch {
      this.store = { version: 2, entries: {} };
    }
  }

  has(name: string): boolean {
    this.load();
    return Boolean(this.store.entries[name]);
  }

  get(name: string): string | undefined {
    this.load();
    if (this.cache.has(name)) return this.cache.get(name);
    const entry = this.store.entries[name];
    if (!entry) return undefined;
    try {
      const value = entry.protection === "dpapi"
        ? Buffer.from(runPowerShell(PS_DECRYPT, entry.data), "base64").toString("utf8")
        : Buffer.from(entry.data, "base64").toString("utf8");
      this.cache.set(name, value);
      return value;
    } catch {
      // Unreadable (e.g. copied from another Windows account): treat as absent.
      return undefined;
    }
  }

  set(name: string, value: string): void {
    this.load();
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Secret must not be empty.");
    const data = this.protection === "dpapi"
      ? runPowerShell(PS_ENCRYPT, trimmed)
      : Buffer.from(trimmed, "utf8").toString("base64");
    this.store.entries[name] = { protection: this.protection, data, updatedAt: new Date().toISOString() };
    this.cache.set(name, trimmed);
    this.save();
  }

  delete(name: string): void {
    this.load();
    delete this.store.entries[name];
    this.cache.delete(name);
    this.save();
  }

  names(): string[] {
    this.load();
    return Object.keys(this.store.entries);
  }

  private save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.store, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows relies on DPAPI rather than mode bits */
    }
  }

  /**
   * Move a plaintext key from the legacy secrets.json into protected storage
   * and scrub it from the legacy file. Returns true when a migration happened.
   */
  migrateLegacyPlaintext(legacyFile: string, legacyField: string, name: string): boolean {
    try {
      if (!fs.existsSync(legacyFile)) return false;
      const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf-8")) as Record<string, unknown>;
      const value = typeof legacy[legacyField] === "string" ? String(legacy[legacyField]).trim() : "";
      if (!value) return false;
      if (!this.has(name)) this.set(name, value);
      // Only scrub once the protected copy is verifiably readable.
      if (this.get(name) !== value) return false;
      delete legacy[legacyField];
      fs.writeFileSync(legacyFile, JSON.stringify(legacy, null, 2), "utf-8");
      return true;
    } catch {
      return false;
    }
  }
}
